package games

import "testing"

// These tests pin the registered PortHints to the exact Service port
// names/protocols emitted by the UI generators (valheimGenerator.js,
// factorioGenerator.js). They mirror pickProbePort's matching rules from
// internal/kube/instance_status.go without importing corev1.

type svcPort struct {
	Name     string
	Protocol string
	Port     int32
}

// pickPort reimplements internal/kube.pickProbePort's algorithm so a
// generator port-name/protocol change that would break real probes also
// breaks this test.
func pickPort(ports []svcPort, h PortHint) (int32, bool) {
	if len(ports) == 0 {
		return 0, false
	}
	if h.PortName != "" && h.Protocol != "" {
		for _, p := range ports {
			if p.Name == h.PortName && p.Protocol == h.Protocol {
				return p.Port, true
			}
		}
	}
	if h.PortName != "" {
		for _, p := range ports {
			if p.Name == h.PortName {
				return p.Port, true
			}
		}
	}
	if h.Protocol != "" {
		for _, p := range ports {
			if p.Protocol == h.Protocol {
				return p.Port, true
			}
		}
		return 0, false
	}
	return ports[0].Port, true
}

func TestValheimProbePicksQueryPort(t *testing.T) {
	if _, ok := registry["valheim"]; !ok {
		t.Fatal("valheim probe not registered")
	}
	// valheimGenerator.js default serverPort 2456 -> vh-udp-0/1/2.
	ports := []svcPort{
		{"vh-udp-0", "UDP", 2456},
		{"vh-udp-1", "UDP", 2457},
		{"vh-udp-2", "UDP", 2458},
	}
	got, ok := pickPort(ports, Hint("valheim"))
	if !ok {
		t.Fatal("valheim: no port matched")
	}
	if got != 2457 {
		t.Fatalf("valheim: want A2S query port 2457 (game+1), got %d", got)
	}
}

func TestFactorioProbePicksNativeGamePort(t *testing.T) {
	if _, ok := registry["factorio"]; !ok {
		t.Fatal("factorio probe not registered")
	}
	// factorioGenerator.js: game-udp 34197, query-udp 27015. Verified live:
	// the Steam query port (27015) never answers for a private homelab
	// server (no public Steam registration) and does not answer the native
	// protocol either; the native connection-request handshake only gets a
	// reply on game-udp:34197. So the probe must target game-udp.
	ports := []svcPort{
		{"game-udp", "UDP", 34197},
		{"query-udp", "UDP", 27015},
	}
	got, ok := pickPort(ports, Hint("factorio"))
	if !ok {
		t.Fatal("factorio: no port matched")
	}
	if got != 34197 {
		t.Fatalf("factorio: want native game port 34197, got %d", got)
	}
}

// Even if a future generator reorders ports or only emits the game port,
// the explicit name+protocol hint must still resolve to game-udp.
func TestFactorioGamePortResolvesByName(t *testing.T) {
	ports := []svcPort{{"game-udp", "UDP", 34197}}
	got, ok := pickPort(ports, Hint("factorio"))
	if !ok || got != 34197 {
		t.Fatalf("factorio: expected game-udp 34197, got %d ok=%v", got, ok)
	}
}

func TestFactorioNotRegisteredAsTCP(t *testing.T) {
	// Regression: tcp.go must not re-register factorio with a TCP hint
	// (no TCP port exists on its Service).
	if h := Hint("factorio"); h.Protocol != "UDP" {
		t.Fatalf("factorio hint protocol must be UDP, got %q", h.Protocol)
	}
}
