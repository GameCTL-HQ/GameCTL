package games

import (
	"context"
	"fmt"
	"time"

	"github.com/rumblefrog/go-a2s"
)

// Source-engine A2S probe (CS2, CS:GO, TF2, Garry's Mod, L4D2, Rust,
// 7 Days to Die, Squad, etc.). Wraps github.com/rumblefrog/go-a2s — the
// same package the /games/steam/status endpoint uses.
//
// Returns A Minecraft-ish summary: MOTD = server name, version = server
// version string, players online, max players. Unlike MC's protocol this
// is UDP and tends to be lossy on first packet — go-a2s retries internally.

func init() {
	// All Source A2S probes are UDP. Hint the port picker to find a UDP port
	// on the Service (most game manifests have multiple ports; if we don't
	// hint, the picker grabs the first port which may be TCP).
	udp := PortHint{Protocol: "UDP"}
	RegisterWithHint("cs2", probeSourceA2S, udp)
	RegisterWithHint("l4d2", probeSourceA2S, udp)
	// 7 Days to Die (didstopia/7dtd-server): the A2S query responder binds
	// to the *game* port (ServerPort, UDP), NOT ServerPort+1/+2 — verified
	// live: A2S answers on game-udp:26900 and times out on steam-udp-1/-2.
	// The sevendaysGenerator emits Service ports named game-udp /
	// steam-udp-1 / steam-udp-2 (there is NO "query-udp" port), so the old
	// PortName:"query-udp" hint never matched and only worked by accident
	// via the UDP-only fallback landing on the first UDP port. Pin the real
	// name so the pick is deterministic and survives port reordering.
	sevenDaysHint := PortHint{Protocol: "UDP", PortName: "game-udp"}
	RegisterWithHint("7d2d", probeSourceA2S, sevenDaysHint)
	RegisterWithHint("sevendays", probeSourceA2S, sevenDaysHint)
	RegisterWithHint("rust-server", probeSourceA2S, udp)
	// Project Zomboid answers Steam A2S on its game port (16261/UDP),
	// exposed as service port "pz-udp-0" by the generator. Pin the name
	// so the picker doesn't grab pz-udp-1 (the +1 Steam port).
	RegisterWithHint("projectzomboid", probeSourceA2S, PortHint{Protocol: "UDP", PortName: "pz-udp-0"})
}

func probeSourceA2S(ctx context.Context, addr string, timeout time.Duration) (*Health, error) {
	client, err := a2s.NewClient(addr, a2s.TimeoutOption(timeout))
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	defer client.Close()

	start := time.Now()
	info, err := client.QueryInfo()
	if err != nil {
		return nil, fmt.Errorf("query info: %w", err)
	}
	latency := time.Since(start).Milliseconds()

	h := &Health{
		Type:       "source-a2s",
		Reachable:  true,
		LatencyMS:  latency,
		MOTD:       info.Name,
		Version:    info.Version,
		Map:        info.Map,
		Players:    int(info.Players),
		MaxPlayers: int(info.MaxPlayers),
	}
	// Best-effort player sample — not always supported, never block on it.
	if pl, err := client.QueryPlayer(); err == nil && pl != nil {
		for _, p := range pl.Players {
			if p != nil && p.Name != "" {
				h.PlayerSample = append(h.PlayerSample, p.Name)
			}
			if len(h.PlayerSample) >= 10 {
				break
			}
		}
	}
	return h, nil
}
