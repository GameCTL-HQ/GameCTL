package games

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"
)

// Quake 3 / ioquake3 has no Steam A2S — it speaks the idTech3 connectionless
// UDP "getstatus" protocol (also used by the dpmaster server browser). We
// register this per-game so deployable Quake 3 instances show map / players
// instead of just an Online pill (which is all the generic TCP fallback
// could give — and Q3 is UDP-only anyway, so TCP wasn't even an option).
//
// Wire format:
//
//	→  FF FF FF FF "getstatus\n"
//	←  FF FF FF FF "statusResponse\n\key\val\key\val...\n<frags> <ping> "name"\n..."
//
// First line after the header is the backslash-delimited server cvars
// (sv_hostname, mapname, sv_maxclients, …); each subsequent non-empty line
// is one connected player. Player count = number of those lines.
func init() {
	RegisterWithHint("quake3", probeQuake3, PortHint{Protocol: "UDP", PortName: "game-udp"})
	// IW4X (Call of Duty: MW2) runs on IW4, an idTech3 descendant that keeps
	// the same connectionless getstatus/statusResponse exchange and the same
	// sv_hostname / mapname / sv_maxclients cvar names — so the Quake 3
	// prober works unmodified. Health reports Type "quake3" for both; if a
	// future IW4X build stops answering getstatus the status pill still
	// works (it is synthesized from Deployment/pod state), we just lose the
	// player count.
	RegisterWithHint("iw4x", probeQuake3, PortHint{Protocol: "UDP", PortName: "game-udp"})
}

func probeQuake3(ctx context.Context, addr string, timeout time.Duration) (*Health, error) {
	d := net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "udp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(timeout))

	start := time.Now()
	if _, err := conn.Write([]byte("\xff\xff\xff\xffgetstatus\n")); err != nil {
		return nil, fmt.Errorf("send getstatus: %w", err)
	}

	buf := make([]byte, 4096)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	latency := time.Since(start).Milliseconds()

	resp := string(buf[:n])
	// Strip the 0xFFFFFFFF connectionless header + "statusResponse" tag.
	if i := strings.IndexByte(resp, '\n'); i >= 0 {
		resp = resp[i+1:]
	}
	lines := strings.Split(resp, "\n")
	if len(lines) == 0 {
		return nil, fmt.Errorf("malformed statusResponse")
	}

	// lines[0] = "\k\v\k\v..." cvar string. Parse a few useful ones.
	cvars := map[string]string{}
	parts := strings.Split(strings.Trim(lines[0], "\\"), "\\")
	for i := 0; i+1 < len(parts); i += 2 {
		cvars[parts[i]] = parts[i+1]
	}

	players := 0
	var sample []string
	for _, l := range lines[1:] {
		if strings.TrimSpace(l) == "" {
			continue
		}
		players++
		// `<frags> <ping> "playername"` — pull the quoted name.
		if a := strings.IndexByte(l, '"'); a >= 0 {
			if b := strings.IndexByte(l[a+1:], '"'); b >= 0 {
				if name := l[a+1 : a+1+b]; name != "" && len(sample) < 10 {
					sample = append(sample, name)
				}
			}
		}
	}

	maxPlayers := 0
	fmt.Sscanf(cvars["sv_maxclients"], "%d", &maxPlayers)

	return &Health{
		Type:         "quake3",
		Reachable:    true,
		LatencyMS:    latency,
		MOTD:         cvars["sv_hostname"],
		Version:      cvars["version"],
		Players:      players,
		MaxPlayers:   maxPlayers,
		PlayerSample: sample,
	}, nil
}
