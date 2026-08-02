package kube

import (
	"context"
	"fmt"
	"regexp"
	"strings"
)

// Bot Warfare menu admins for IW4X.
//
// The mod's in-game menu (Action Slot 2) is gated by doHostCheck(): a player
// qualifies via ishost() — which nobody is on a dedicated server — or by
// appearing in the bots_main_GUIDs dvar. So "admin" here means exactly that
// list, and there is no other admin concept in IW4x to manage.
//
// The list lives in its own cfg file that the generated server.cfg execs last,
// rather than in server.cfg itself. That's deliberate: server.cfg is rewritten
// from the wizard on every boot, so a panel edit stored there would silently
// vanish on the next restart. This file is seeded once and owned by the panel
// thereafter.
const iw4xAdminsPath = "/iw4x/players/gamectl-admins.cfg"

// IW4XAdmin is one entry in the list. Label is a human note stored as a
// comment, since the dvar itself holds nothing but GUIDs.
type IW4XAdmin struct {
	GUID  string `json:"guid"`
	Label string `json:"label,omitempty"`
}

var (
	adminsDvarRe = regexp.MustCompile(`(?m)^\s*set\s+bots_main_GUIDs\s+"([^"]*)"`)
	adminLabelRe = regexp.MustCompile(`(?m)^\s*//\s*label\s+(\S+)\s+(.*)$`)
)

// IW4XAdmins reads the current list off the volume.
func (c *Cluster) IW4XAdmins(ctx context.Context, ns, server string) ([]IW4XAdmin, error) {
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return nil, err
	}
	out, _, err := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "cat " + iw4xAdminsPath + " 2>/dev/null || true"}, "")
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", iw4xAdminsPath, err)
	}

	labels := map[string]string{}
	for _, m := range adminLabelRe.FindAllStringSubmatch(out, -1) {
		labels[m[1]] = strings.TrimSpace(m[2])
	}

	var admins []IW4XAdmin
	if m := adminsDvarRe.FindStringSubmatch(out); len(m) == 2 {
		for _, g := range strings.Split(m[1], ",") {
			if g = strings.TrimSpace(g); g != "" {
				admins = append(admins, IW4XAdmin{GUID: g, Label: labels[g]})
			}
		}
	}
	return admins, nil
}

// IW4XSetAdmins replaces the list, writing the file and applying the dvar live.
//
// Applying live matters more than it looks: doHostCheck() runs when a player
// CONNECTS, so setting the dvar now means anyone who reconnects is covered
// without a server restart. Callers should still tell the operator that much.
func (c *Cluster) IW4XSetAdmins(ctx context.Context, ns, server string, admins []IW4XAdmin) error {
	seen := map[string]bool{}
	var guids []string
	var lines []string
	lines = append(lines, "// GameCTL-managed — Bot Warfare menu admins. Edit from the manage screen.")

	for _, a := range admins {
		g := strings.TrimSpace(a.GUID)
		// Quotes and commas would break out of the dvar assignment or split
		// one GUID into two; neither belongs in an identifier anyway.
		if g == "" || seen[g] || strings.ContainsAny(g, `",`) {
			continue
		}
		seen[g] = true
		guids = append(guids, g)
		if l := strings.TrimSpace(a.Label); l != "" {
			l = strings.ReplaceAll(l, "\n", " ")
			lines = append(lines, fmt.Sprintf("// label %s %s", g, l))
		}
	}
	lines = append(lines, fmt.Sprintf(`set bots_main_GUIDs "%s"`, strings.Join(guids, ",")))
	body := strings.Join(lines, "\n") + "\n"

	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return err
	}
	if _, stderr, err := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "mkdir -p $(dirname " + iw4xAdminsPath + ") && cat > " + iw4xAdminsPath}, body); err != nil {
		return fmt.Errorf("write %s: %w (%s)", iw4xAdminsPath, err, strings.TrimSpace(stderr))
	}

	// Best-effort live apply: a failure here means the file is still correct
	// and the next restart picks it up, so it must not fail the whole call.
	_, _ = c.RunRCON(ctx, ns, server, fmt.Sprintf("bots_main_GUIDs %s", strings.Join(guids, ",")))
	return nil
}

// Map rotation, stored the same way as the admin list and for the same
// reason: server.cfg is regenerated from the wizard on every boot, so a
// rotation edited in the manage screen has to live in its own file that
// server.cfg execs, or a restart would silently revert it to whatever the
// wizard field said at deploy time.
//
// This file matters more than it looks. IW4x parses sv_mapRotation exactly
// once, at the first match end (MapRotation::LoadMapRotation, guarded by a
// function-local static). If it is empty at that moment the rotation latches
// empty for the life of the process and sv_nextMap becomes "map_restart" —
// unfixable at runtime except by appending with addMap/addGametype. So the
// config must carry the rotation before the server ever finishes a match.
const iw4xRotationPath = "/iw4x/players/gamectl-rotation.cfg"

var rotationDvarRe = regexp.MustCompile(`(?m)^\s*set\s+sv_mapRotation\s+"([^"]*)"`)

// IW4XRotationEntry is one map in play order, with the mode it runs under.
type IW4XRotationEntry struct {
	Map      string `json:"map"`
	GameType string `json:"gametype"`
}

// IW4XRotation reads the persisted rotation off the volume.
func (c *Cluster) IW4XRotation(ctx context.Context, ns, server string) ([]IW4XRotationEntry, error) {
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return nil, err
	}
	out, _, err := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "cat " + iw4xRotationPath + " 2>/dev/null || true"}, "")
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", iw4xRotationPath, err)
	}
	var entries []IW4XRotationEntry
	if m := rotationDvarRe.FindStringSubmatch(out); len(m) == 2 {
		fields := strings.Fields(m[1])
		gt := ""
		for i := 0; i+1 < len(fields); i += 2 {
			switch strings.ToLower(fields[i]) {
			case "gametype":
				gt = fields[i+1]
			case "map":
				entries = append(entries, IW4XRotationEntry{Map: fields[i+1], GameType: gt})
			}
		}
	}
	return entries, nil
}

// IW4XSetRotation persists the rotation. It takes effect when the server next
// starts — the caller is expected to say so rather than implying it is live.
func (c *Cluster) IW4XSetRotation(ctx context.Context, ns, server string, entries []IW4XRotationEntry) error {
	var parts []string
	for _, e := range entries {
		m := strings.TrimSpace(e.Map)
		g := strings.TrimSpace(e.GameType)
		// A quote would break out of the dvar assignment; whitespace inside a
		// token would desync the key/value pairing the engine relies on.
		if m == "" || strings.ContainsAny(m, "\" ") || strings.ContainsAny(g, "\" ") {
			continue
		}
		if g == "" {
			g = "war"
		}
		parts = append(parts, "gametype "+g+" map "+m)
	}
	if len(parts) == 0 {
		return fmt.Errorf("a rotation needs at least one map — an empty one permanently disables rotation on this engine")
	}

	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return err
	}
	// Exactly one space between tokens: the engine splits on a single space,
	// and a doubled one yields an empty token that truncates the rotation.
	body := "// GameCTL-managed — IW4X map rotation. Edit from the manage screen.\n" +
		fmt.Sprintf("set sv_mapRotation %q\n", strings.Join(parts, " "))
	if _, stderr, err := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "mkdir -p $(dirname " + iw4xRotationPath + ") && cat > " + iw4xRotationPath}, body); err != nil {
		return fmt.Errorf("write %s: %w (%s)", iw4xRotationPath, err, strings.TrimSpace(stderr))
	}
	return nil
}
