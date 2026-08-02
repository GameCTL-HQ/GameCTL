package kube

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameCTL-HQ/GameCTL/server/internal/games"
)

// Generic Source-RCON console: any game whose Deployment exposes a
// RCON_PASSWORD env var + a reachable TCP port speaks the same protocol
// (CS2, Minecraft, Factorio, Project Zomboid, …). The manage screen uses
// this to run arbitrary console commands (op a player, `list`, `say`, …).
//
// RCON is reached via the Service ClusterIP, never the public
// LoadBalancer — keep the RCON port off any tunnel/ingress (same lesson
// as the cs2 incident: a public RCON port gets brute-force-scanned).

// rconPasswordEnvNames are the env vars (in priority order) that game
// images use for the Source-RCON password. Images disagree on the name:
// most SRCDS/itzg images use RCON_PASSWORD; joedwards32/cs2 uses
// CS2_RCONPW. Checking all of them keeps the RCON console + CS2 live
// panel working regardless of image convention.
var rconPasswordEnvNames = []string{"RCON_PASSWORD", "CS2_RCONPW"}

// Games that speak idTech3 connectionless RCON over UDP instead of Valve's
// Source RCON over TCP. Keyed by the `game` label. Getting this wrong is
// silent in a confusing way: the Service exposes a TCP port, so the address
// resolves fine and every command then times out against a port the game
// never listens on.
var q3RconGames = map[string]bool{
	"iw4x":   true,
	"quake3": true,
}

// rconPasswordFromEnv returns the first non-empty recognized RCON password.
func rconPasswordFromEnv(env []corev1.EnvVar) string {
	for _, want := range rconPasswordEnvNames {
		for _, e := range env {
			if e.Name == want && e.Value != "" {
				return e.Value
			}
		}
	}
	return ""
}

// rconReachable reports whether this deployment can be RCON'd: it needs a
// recognized RCON password env value and a resolvable Service TCP port.
func rconReachable(env []corev1.EnvVar) bool {
	return rconPasswordFromEnv(env) != ""
}

// resolveRCON returns "host:port" + password for the named deployment, plus
// whether this game wants the idTech3 UDP dialect.
// TCP port preference: a port named rcon / rcon-tcp, else game-tcp, else the
// first TCP port. UDP games prefer game-udp, else the first UDP port.
func (c *Cluster) resolveRCON(ctx context.Context, ns, name string) (addr, password string, q3 bool, err error) {
	b := c.snap()
	if b == nil {
		return "", "", false, ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", "", false, err
	}
	conts := dep.Spec.Template.Spec.Containers
	if len(conts) == 0 {
		return "", "", false, fmt.Errorf("deployment %s/%s has no containers", ns, name)
	}
	password = rconPasswordFromEnv(conts[0].Env)
	if password == "" {
		return "", "", false, fmt.Errorf("%s/%s has no RCON password env set — RCON not available", ns, name)
	}
	q3 = q3RconGames[dep.Spec.Template.Labels["game"]]

	var svc *corev1.Service
	for _, cand := range []string{name, name + "-service"} {
		if s, e := b.clientset.CoreV1().Services(ns).Get(ctx, cand, metav1.GetOptions{}); e == nil {
			svc = s
			break
		}
	}
	if svc == nil {
		list, e := b.clientset.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
		if e == nil {
			for i := range list.Items {
				if serviceTargets(list.Items[i].Spec.Selector, dep.Spec.Template.Labels) {
					svc = &list.Items[i]
					break
				}
			}
		}
	}
	if svc == nil || svc.Spec.ClusterIP == "" {
		return "", "", false, fmt.Errorf("no Service ClusterIP for %s/%s", ns, name)
	}

	if q3 {
		var udpPort, gameUDP int32
		for _, p := range svc.Spec.Ports {
			if p.Protocol != corev1.ProtocolUDP {
				continue
			}
			if udpPort == 0 {
				udpPort = p.Port
			}
			if p.Name == "game-udp" {
				gameUDP = p.Port
			}
		}
		if gameUDP != 0 {
			udpPort = gameUDP
		}
		if udpPort == 0 {
			return "", "", false, fmt.Errorf("no UDP port on Service for idTech3 RCON")
		}
		return fmt.Sprintf("%s:%d", svc.Spec.ClusterIP, udpPort), password, true, nil
	}

	var port, gameTCP, firstTCP int32
	for _, p := range svc.Spec.Ports {
		if p.Protocol != corev1.ProtocolTCP {
			continue
		}
		if firstTCP == 0 {
			firstTCP = p.Port
		}
		switch p.Name {
		case "rcon", "rcon-tcp":
			port = p.Port
		case "game-tcp":
			gameTCP = p.Port
		}
	}
	if port == 0 {
		port = gameTCP
	}
	if port == 0 {
		port = firstTCP
	}
	if port == 0 {
		return "", "", false, fmt.Errorf("no TCP port on Service for RCON")
	}
	return fmt.Sprintf("%s:%d", svc.Spec.ClusterIP, port), password, false, nil
}

// RunRCON executes one console command and returns the server's output.
func (c *Cluster) RunRCON(ctx context.Context, ns, name, cmd string) (string, error) {
	addr, pw, q3, err := c.resolveRCON(ctx, ns, name)
	if err != nil {
		return "", err
	}
	if q3 {
		return games.RCONQuake3(ctx, addr, pw, cmd)
	}
	return games.RCON(ctx, addr, pw, []string{cmd})
}
