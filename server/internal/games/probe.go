// Package games implements per-game deep-health probes that go beyond
// "the container is Running" — e.g. for Minecraft, a Server List Ping that
// returns MOTD / player count / version / latency.
//
// Adding a new game:
//  1. Implement a func with signature `Prober`
//  2. Register it in init() against the value of the `game` label your
//     deployment manifests use (e.g. "minecraft", "cs2", "factorio")
// The status endpoint dispatches automatically based on the Deployment's
// `game` label; an unregistered game just omits the gameHealth field.
package games

import (
	"context"
	"time"
)

// Health is what every probe returns. UI renders it as a secondary line under
// the status pill. Fields are intentionally a superset — set only the ones
// that apply to your game.
type Health struct {
	Type      string `json:"type"`               // game key (e.g. "minecraft")
	Reachable bool   `json:"reachable"`          // probe completed without error
	LatencyMS int64  `json:"latencyMs,omitempty"`

	// Common informational fields
	Version    string   `json:"version,omitempty"`
	MOTD       string   `json:"motd,omitempty"`
	Map        string   `json:"map,omitempty"` // world/map/save name (Valheim world, etc.)
	Players    int      `json:"players,omitempty"`
	MaxPlayers int      `json:"maxPlayers,omitempty"`
	PlayerSample []string `json:"playerSample,omitempty"`

	// Free-form error string when the probe failed. UI shows this as the
	// reason the deep status is unavailable, so don't be terse.
	Error string `json:"error,omitempty"`
}

// Prober runs the deep check. `addr` is "host:port" — caller already picked the
// port appropriate for the game from the Service spec. `timeout` is total.
type Prober func(ctx context.Context, addr string, timeout time.Duration) (*Health, error)

// PortHint tells the status endpoint's port-picker which Service port to use
// for this probe. Zero values mean "no preference" — picker falls back to the
// first port on the Service. NetworkProtocol is the L4 protocol string
// ("TCP" or "UDP") since this package avoids importing corev1 directly.
type PortHint struct {
	Protocol string // "TCP" | "UDP" | "" (any)
	PortName string // exact port name to prefer (e.g. "query-udp")
}

var (
	registry = map[string]Prober{}
	hints    = map[string]PortHint{}
)

// Register attaches a probe to a `game` label value. Call from a package's
// init() so the registry is populated before any HTTP request lands.
func Register(gameKey string, p Prober) { registry[gameKey] = p }

// RegisterWithHint registers a probe AND a hint about which Service port the
// probe expects to talk to. Use this for probes that need a specific protocol
// (e.g. Source A2S is UDP; HTTP probes need TCP) — otherwise the status
// endpoint may pick a wrong-protocol port and the probe times out.
func RegisterWithHint(gameKey string, p Prober, h PortHint) {
	registry[gameKey] = p
	hints[gameKey] = h
}

// Hint returns the PortHint registered for a game key, or zero-value if none.
// Callers (specifically internal/kube/instance_status.go) use this to pick
// the right Service port before invoking Probe.
func Hint(gameKey string) PortHint { return hints[gameKey] }

// Probe looks up the probe for the given game label and runs it. Returns nil
// (no error) when no probe is registered — that's an intentional "I don't
// know how to deep-check this game" signal.
func Probe(ctx context.Context, gameKey, addr string, timeout time.Duration) *Health {
	if gameKey == "" || addr == "" {
		return nil
	}
	p, ok := registry[gameKey]
	if !ok {
		return nil
	}
	h, err := p(ctx, addr, timeout)
	if h == nil {
		h = &Health{Type: gameKey}
	}
	if err != nil {
		h.Reachable = false
		h.Error = err.Error()
	}
	return h
}
