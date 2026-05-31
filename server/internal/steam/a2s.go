// Package steam implements Source-engine A2S server queries (CS2/CS:GO/TF2/etc.).
//
// Wraps github.com/rumblefrog/go-a2s and shapes results to match the Python service's
// /games/steam/status response.
package steam

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/rumblefrog/go-a2s"
)

// Status is the wire shape for /games/steam/status.
type Status struct {
	Ok        bool              `json:"ok"`
	Addr      string            `json:"addr"`
	LatencyMS int64             `json:"latency_ms"`
	Info      Info              `json:"info"`
	Players   []Player          `json:"players"`
	Rules     map[string]string `json:"rules"`
}

type Info struct {
	Name       *string `json:"name"`
	Map        *string `json:"map"`
	Players    *uint8  `json:"players"`
	MaxPlayers *uint8  `json:"max_players"`
	Version    *string `json:"version"`
	Game       *string `json:"game"`
}

type Player struct {
	Name     *string `json:"name"`
	Score    *int32  `json:"score"`
	Duration *int64  `json:"duration"`
}

// Query runs A2S Info + Players + Rules against host:port and returns a Status.
// Players and Rules failures are tolerated (returned as empty), matching Python's
// best-effort behavior; only Info failure is fatal.
func Query(addr string, timeout time.Duration) (*Status, error) {
	host, port, err := splitAddr(addr)
	if err != nil {
		return nil, err
	}

	client, err := a2s.NewClient(
		fmt.Sprintf("%s:%d", host, port),
		a2s.TimeoutOption(timeout),
	)
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	defer client.Close()

	start := time.Now()
	info, err := client.QueryInfo()
	latency := time.Since(start).Milliseconds()
	if err != nil {
		return nil, fmt.Errorf("query info: %w", err)
	}

	out := &Status{
		Ok:        true,
		Addr:      addr,
		LatencyMS: latency,
		Info:      mapInfo(info),
		Players:   []Player{},
		Rules:     map[string]string{},
	}

	if pl, err := client.QueryPlayer(); err == nil && pl != nil {
		for _, p := range pl.Players {
			out.Players = append(out.Players, mapPlayer(p))
		}
	}

	if rules, err := client.QueryRules(); err == nil && rules != nil {
		for k, v := range rules.Rules {
			out.Rules[k] = v
		}
	}

	return out, nil
}

func mapInfo(info *a2s.ServerInfo) Info {
	if info == nil {
		return Info{}
	}
	name := info.Name
	mp := info.Map
	ver := info.Version
	game := info.Game
	players := info.Players
	maxP := info.MaxPlayers
	return Info{
		Name:       &name,
		Map:        &mp,
		Players:    &players,
		MaxPlayers: &maxP,
		Version:    &ver,
		Game:       &game,
	}
}

func mapPlayer(p *a2s.Player) Player {
	if p == nil {
		return Player{}
	}
	name := p.Name
	score := p.Score
	dur := int64(p.Duration)
	return Player{
		Name:     &name,
		Score:    &score,
		Duration: &dur,
	}
}

// ErrBadAddr is returned when the addr argument isn't in "host:port" form.
// Handlers should distinguish this (400 client error) from query failures (502).
var ErrBadAddr = errors.New("addr must be in 'host:port' form")

func splitAddr(addr string) (string, int, error) {
	i := strings.LastIndex(addr, ":")
	if i < 1 || i == len(addr)-1 {
		return "", 0, ErrBadAddr
	}
	host := addr[:i]
	var port int
	if _, err := fmt.Sscanf(addr[i+1:], "%d", &port); err != nil {
		return "", 0, ErrBadAddr
	}
	if port < 1 || port > 65535 {
		return "", 0, ErrBadAddr
	}
	return host, port, nil
}
