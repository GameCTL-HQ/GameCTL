package httpapi

import (
	"testing"

	"github.com/GameCTL-HQ/GameCTL/server/internal/proxyctl"
)

// ProxyCTL's public ports have to reach the wizard's inventory, or it
// recommends numbers that are free in-cluster but already routed publicly —
// which is how the port you deploy and the port players use drift apart.
func TestEntryPortsInUse(t *testing.T) {
	rows := []proxyctl.EntryRow{
		{Entry: proxyctl.Entry{Name: "cs2", Subdomain: "cs2.example.com", Enabled: true,
			Ports: []proxyctl.PortSpec{{Port: 27015, Proto: "both"}, {Port: 27020, Proto: "udp"}}}},
		{Entry: proxyctl.Entry{Name: "old", Subdomain: "old.example.com", Enabled: false,
			Ports: []proxyctl.PortSpec{{Port: 9999, Proto: "udp"}}}},
	}
	got := entryPortsInUse(rows)

	// "both" has to expand: a UDP-only pick still collides with it.
	want := map[string]bool{"27015/TCP": true, "27015/UDP": true, "27020/UDP": true}
	for _, p := range got {
		key := p.Protocol
		if p.Source != "proxyctl" {
			t.Errorf("port %d: source = %q, want proxyctl", p.Port, p.Source)
		}
		delete(want, itoa(p.Port)+"/"+key)
	}
	if len(want) != 0 {
		t.Errorf("missing from inventory: %v (got %d rows)", want, len(got))
	}
	// A disabled entry isn't routing anything, so it must not hold its port.
	for _, p := range got {
		if p.Port == 9999 {
			t.Error("disabled entry still claimed 9999 — it routes nothing")
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
