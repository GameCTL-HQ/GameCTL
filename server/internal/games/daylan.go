package games

import (
	"context"
	"fmt"
	"time"

	"github.com/rumblefrog/go-a2s"
)

// DayZ probe using Steam A2S.
// DayZ uses the standard Steam Query protocol on its query port.
// The generator exposes 'query-udp' (default 27016).

func init() {
	// Register with the hint provided by dayzGenerator.js: "query-udp", UDP
	RegisterWithHint("dayz", probeDayz, PortHint{
		Protocol: "UDP",
		PortName: "query-udp",
	})
}

// probeDayz performs a Steam A2S query against the DayZ query port.
func probeDayz(ctx context.Context, addr string, timeout time.Duration) (*Health, error) {
	client, err := a2s.NewClient(addr, a2s.TimeoutOption(timeout))
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	defer client.Close()

	start := time.Now()
	info, err := client.QueryInfo()
	if err != nil {
		return nil, fmt.Errorf("A2S query info (is the DayZ query port %s reachable?): %w", addr, err)
	}
	latency := time.Since(start).Milliseconds()

	h := &Health{
		Type:      "dayz",
		Reachable: true,
		LatencyMS: latency,
		MOTD:      info.Name, // DayZ often puts server name here
		Version:   info.Version,
		Players:   int(info.Players),
		MaxPlayers: int(info.MaxPlayers),
	}

	// Some DayZ servers/mods might populate the Map field (e.g., Chernarus)
	if info.Map != "" {
		h.Map = info.Map
	}

	return h, nil
}
