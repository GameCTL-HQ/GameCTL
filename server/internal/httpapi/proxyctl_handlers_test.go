package httpapi

import (
	"testing"

	"github.com/GameCTL-HQ/GameCTL/server/internal/proxyctl"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestTargetRoleAndEntryName(t *testing.T) {
	cases := []struct{ svc, instance, role, entry string }{
		{"minecraft-service", "minecraft", "game", "minecraft"},
		{"minecraft", "minecraft", "game", "minecraft"},
		{"minecraft-bluemap-service", "minecraft", "bluemap", "minecraft-bluemap"},
		{"cs2-records", "cs2", "records", "cs2-records"},
		{"valheim-service", "valheim", "game", "valheim"},
	}
	for _, c := range cases {
		if got := targetRole(c.svc, c.instance); got != c.role {
			t.Errorf("targetRole(%s,%s) = %q, want %q", c.svc, c.instance, got, c.role)
		}
		if got := targetEntryName(c.svc, c.instance); got != c.entry {
			t.Errorf("targetEntryName(%s,%s) = %q, want %q", c.svc, c.instance, got, c.entry)
		}
	}
}

func svcFixture(name string, ports ...corev1.ServicePort) corev1.Service {
	return corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec:       corev1.ServiceSpec{ClusterIP: "10.43.0." + name[len(name)-1:], Ports: ports},
	}
}

func TestServicePortsExcludesRcon(t *testing.T) {
	svc := svcFixture("minecraft-service",
		corev1.ServicePort{Name: "minecraft-tcp", Port: 25565, Protocol: corev1.ProtocolTCP},
		corev1.ServicePort{Name: "rcon", Port: 25575, Protocol: corev1.ProtocolTCP},
	)
	ports := servicePorts(&svc)
	if len(ports) != 1 || ports[0].Port != 25565 {
		t.Fatalf("expected only the game port, got %+v", ports)
	}
}

func TestServicePortsMergesBoth(t *testing.T) {
	svc := svcFixture("cs2",
		corev1.ServicePort{Name: "game-tcp", Port: 27015, Protocol: corev1.ProtocolTCP},
		corev1.ServicePort{Name: "game-udp", Port: 27015, Protocol: corev1.ProtocolUDP},
		corev1.ServicePort{Name: "tv-udp", Port: 27020, Protocol: corev1.ProtocolUDP},
	)
	ports := servicePorts(&svc)
	if len(ports) != 2 || ports[0].Proto != "both" || ports[1].Proto != "udp" {
		t.Fatalf("expected [27015/both 27020/udp], got %+v", ports)
	}
}

func TestTargetKind(t *testing.T) {
	game := svcFixture("valheim",
		corev1.ServicePort{Name: "vh-udp-0", Port: 2456, Protocol: corev1.ProtocolUDP})
	if k := targetKind(&game); k != "game" {
		t.Errorf("UDP service classified %q, want game", k)
	}
	bluemap := svcFixture("minecraft-bluemap-service",
		corev1.ServicePort{Name: "bluemap-web", Port: 8100, Protocol: corev1.ProtocolTCP})
	if k := targetKind(&bluemap); k != "web" {
		t.Errorf("bluemap classified %q, want web", k)
	}
	records := svcFixture("cs2-records",
		corev1.ServicePort{Name: "http", Port: 80, Protocol: corev1.ProtocolTCP})
	if k := targetKind(&records); k != "web" {
		t.Errorf("records classified %q, want web", k)
	}
	// TCP-only but not named http-ish (e.g. Terraria) stays a game target.
	terraria := svcFixture("terraria",
		corev1.ServicePort{Name: "game-tcp", Port: 7777, Protocol: corev1.ProtocolTCP})
	if k := targetKind(&terraria); k != "game" {
		t.Errorf("terraria classified %q, want game", k)
	}
}

func TestBuildTargetsMatching(t *testing.T) {
	svcs := []corev1.Service{
		svcFixture("minecraft-service", corev1.ServicePort{Name: "minecraft-tcp", Port: 25565, Protocol: corev1.ProtocolTCP}),
		svcFixture("minecraft-bluemap-service", corev1.ServicePort{Name: "bluemap-web", Port: 8100, Protocol: corev1.ProtocolTCP}),
	}
	rows := []proxyctl.EntryRow{
		{Entry: proxyctl.Entry{ID: "a", Service: "minecraft-service.gamectl", Subdomain: "mc.x.cc"}},
	}
	routes := []proxyctl.WebRoute{
		{ID: "w1", Hostname: "map.x.cc", Namespace: "gamectl", Service: "minecraft-bluemap-service", Port: 8100},
		{ID: "w2", Hostname: "other.x.cc", Namespace: "gamectl", Service: "someone-else", Port: 80},
	}
	targets := buildTargets(svcs, rows, routes, "gamectl", "minecraft")
	if len(targets) != 2 {
		t.Fatalf("expected 2 targets, got %d", len(targets))
	}
	if targets[0].Kind != "game" || targets[0].Entry == nil || targets[0].Entry.ID != "a" {
		t.Errorf("game target: kind=%s entry=%+v, want game/entry a", targets[0].Kind, targets[0].Entry)
	}
	if targets[1].Kind != "web" || targets[1].WebRoute == nil || targets[1].WebRoute.ID != "w1" {
		t.Errorf("bluemap target: kind=%s route=%+v, want web/route w1", targets[1].Kind, targets[1].WebRoute)
	}
	if targets[1].Entry != nil {
		t.Errorf("web target must not match L4 entries, got %+v", targets[1].Entry)
	}
}

func TestPublishIntent(t *testing.T) {
	docs := []map[string]any{
		{"kind": "Namespace", "metadata": map[string]any{"name": "gamectl"}},
		{"kind": "Deployment", "metadata": map[string]any{
			"name": "valheim", "namespace": "gamectl",
			"annotations": map[string]any{
				"gamectl.io/publish-host":   "Vikings",
				"gamectl.io/publish-domain": "examplelabs.CC",
			},
		}},
	}
	ns, name, host, domain, ok := publishIntent(docs)
	if !ok || ns != "gamectl" || name != "valheim" || host != "vikings" || domain != "examplelabs.cc" {
		t.Fatalf("got %q %q %q %q ok=%v", ns, name, host, domain, ok)
	}
	// host defaults to the deployment name; no domain annotation = no intent.
	docs[1]["metadata"].(map[string]any)["annotations"] = map[string]any{"gamectl.io/publish-domain": "x.cc"}
	if _, name, host, _, ok := publishIntent(docs); !ok || host != name {
		t.Fatalf("host should default to deployment name, got %q ok=%v", host, ok)
	}
	docs[1]["metadata"].(map[string]any)["annotations"] = map[string]any{}
	if _, _, _, _, ok := publishIntent(docs); ok {
		t.Fatal("no domain annotation must mean no intent")
	}
}
