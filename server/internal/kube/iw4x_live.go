package kube

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Live controls for IW4X servers: the roster, quick console actions, and the
// bot-name list.
//
// Everything live goes over idTech3 UDP RCON (games.RCONQuake3 via RunRCON).
// The bot names are different in kind — IW4x reads userraw/bots.txt once at
// STARTUP, so that's a file edit on the volume (podExec, the same mechanism
// the CS2 workshop panel uses), not something RCON can change.

const iw4xBotNamesPath = "/iw4x/userraw/bots.txt"

// IW4XPlayer is one row of the `status` table.
type IW4XPlayer struct {
	Slot int    `json:"slot"`
	Name string `json:"name"`
	// GUID identifies the account. The admin panel adds players to the bot
	// menu's allow-list by GUID, so it has to survive parsing rather than
	// only being used to detect bots.
	GUID  string `json:"guid"`
	Score int    `json:"score"`
	Ping  int    `json:"ping"`
	IsBot bool   `json:"isBot"`
}

// IW4XLive is what the manage panel renders.
type IW4XLive struct {
	Map      string       `json:"map"`
	GameType string       `json:"gametype"`
	Players  []IW4XPlayer `json:"players"`
	Bots     int          `json:"bots"`
	Humans   int          `json:"humans"`
}

// IW4x colour codes: ^ followed by one character. They appear in every name
// and cvar value the engine prints ("Ghost^7"), and rendering them raw looks
// like corruption in the UI.
var iw4xColorRe = regexp.MustCompile(`\^.`)

func stripIW4XColors(s string) string {
	return strings.TrimSpace(iw4xColorRe.ReplaceAllString(s, ""))
}

// dvarValueRe pulls the value out of the engine's dvar echo:
//
//	"mapname" is: "mp_afghan^7" default: "mp_afghan^7"
var dvarValueRe = regexp.MustCompile(`is:\s*"([^"]*)"`)

func parseDvar(out string) string {
	if m := dvarValueRe.FindStringSubmatch(out); len(m) == 2 {
		return stripIW4XColors(m[1])
	}
	return ""
}

// statusRowRe matches a `status` player row. The columns are
// num score ping guid name lastmsg address qport rate, and both guid and name
// can contain spaces-free junk, so anchor on the leading numeric triple and
// take the guid + name that follow.
var statusRowRe = regexp.MustCompile(`^\s*(\d+)\s+(-?\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s+\d+\s+\S+\s+\d+\s+\d+\s*$`)

// IW4XStatusParse turns raw `status` output into players. Exported for tests:
// the format is fiddly enough that it deserves cases rather than a live server.
func IW4XStatusParse(raw string) []IW4XPlayer {
	var out []IW4XPlayer
	for _, line := range strings.Split(raw, "\n") {
		m := statusRowRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		slot, _ := strconv.Atoi(m[1])
		score, _ := strconv.Atoi(m[2])
		ping, _ := strconv.Atoi(m[3])
		guid := m[4]
		name := stripIW4XColors(m[5])
		// Bots report a guid of "botN" and a ping of 999 — the engine has no
		// explicit bot column. Either signal alone is enough: a real client
		// can theoretically show 999 on a terrible connection, but it will
		// never carry a botN guid.
		isBot := strings.HasPrefix(strings.ToLower(guid), "bot")
		out = append(out, IW4XPlayer{Slot: slot, Name: name, GUID: guid, Score: score, Ping: ping, IsBot: isBot})
	}
	return out
}

// IW4XLiveStatus queries the server for its roster and current map/gametype.
func (c *Cluster) IW4XLiveStatus(ctx context.Context, ns, name string) (*IW4XLive, error) {
	raw, err := c.RunRCON(ctx, ns, name, "status")
	if err != nil {
		return nil, err
	}
	live := &IW4XLive{Players: IW4XStatusParse(raw)}
	for _, p := range live.Players {
		if p.IsBot {
			live.Bots++
		} else {
			live.Humans++
		}
	}
	// `status` prints "map: mp_afghan" as its first line; fall back to the
	// dvar if the header shape ever changes.
	for _, line := range strings.Split(raw, "\n") {
		if rest, ok := strings.CutPrefix(strings.TrimSpace(line), "map:"); ok {
			live.Map = stripIW4XColors(rest)
			break
		}
	}
	if live.Map == "" {
		if out, err := c.RunRCON(ctx, ns, name, "mapname"); err == nil {
			live.Map = parseDvar(out)
		}
	}
	if out, err := c.RunRCON(ctx, ns, name, "g_gametype"); err == nil {
		live.GameType = parseDvar(out)
	}
	return live, nil
}

// IW4XBotNames reads the persistent bot-name list off the game volume.
func (c *Cluster) IW4XBotNames(ctx context.Context, ns, server string) ([]string, error) {
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return nil, err
	}
	// `cat` of a missing file is not an error worth surfacing — an operator
	// who never set names simply has none yet.
	out, _, err := c.podExec(ctx, ns, pod, container, []string{"sh", "-c", "cat " + iw4xBotNamesPath + " 2>/dev/null || true"}, "")
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", iw4xBotNamesPath, err)
	}
	var names []string
	for _, l := range strings.Split(out, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			names = append(names, l)
		}
	}
	return names, nil
}

// IW4XSetBotNames replaces the bot-name list on the volume. It takes effect on
// the next server start — IW4x loads the file once, at boot — so the caller is
// expected to tell the operator that, rather than implying a live change.
func (c *Cluster) IW4XSetBotNames(ctx context.Context, ns, server string, names []string) error {
	clean := make([]string, 0, len(names))
	for _, n := range names {
		n = strings.TrimSpace(n)
		if n == "" {
			continue
		}
		// IW4x truncates at 16 characters, and a comma is its clan-tag
		// separator — silently storing something longer would mean the UI
		// shows one thing and the game another.
		if len(n) > 16 {
			n = n[:16]
		}
		n = strings.ReplaceAll(n, ",", "")
		clean = append(clean, n)
	}
	if len(clean) == 0 {
		return fmt.Errorf("at least one bot name is required")
	}

	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return err
	}
	body := strings.Join(clean, "\n") + "\n"
	_, stderr, err := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "mkdir -p $(dirname " + iw4xBotNamesPath + ") && cat > " + iw4xBotNamesPath}, body)
	if err != nil {
		return fmt.Errorf("write %s: %w (%s)", iw4xBotNamesPath, err, strings.TrimSpace(stderr))
	}
	return nil
}
