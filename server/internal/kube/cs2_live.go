package kube

import (
	"context"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameCTL-HQ/GameCTL/server/internal/games"
)

// CS2 live game-config — editable from the manage screen without a pod
// restart, applied via RCON to the running server. Mirrors the wizard's
// mode table (kubeUI/src/utils/cs2Generator.js MODES); keep in sync.

type cs2Mode struct {
	GT, GM, Bots, Slots int
}

var cs2Modes = map[string]cs2Mode{
	"competitive": {0, 1, 10, 12},
	"casual":      {0, 0, 10, 20},
	"wingman":     {0, 2, 4, 6},
	"demolition":  {1, 1, 10, 12},
	"deathmatch":  {1, 2, 16, 16},
	"armsrace":    {1, 0, 16, 16},
}

// Stable display order for the UI dropdown.
var cs2ModeOrder = []string{"competitive", "casual", "wingman", "demolition", "deathmatch", "armsrace"}

// CS2Live is the wire shape for the manage-screen CS2 panel.
type CS2Live struct {
	Mode          string   `json:"mode"`          // current, derived from GAMETYPE/GAMEMODE
	BotDifficulty int      `json:"botDifficulty"` // 0 easy → 3 expert
	MaxPlayers    int      `json:"maxPlayers"`
	ModeOptions   []string `json:"modeOptions"`
}

func envMap(env []corev1.EnvVar) map[string]string {
	m := make(map[string]string, len(env))
	for _, e := range env {
		m[e.Name] = e.Value
	}
	return m
}

var reBotDiff = regexp.MustCompile(`\+bot_difficulty (\d)`)

func cs2LiveFromEnv(env []corev1.EnvVar) *CS2Live {
	m := envMap(env)
	gt, _ := strconv.Atoi(m["GAMETYPE"])
	gm, _ := strconv.Atoi(m["GAMEMODE"])
	mode := "competitive"
	for _, k := range cs2ModeOrder {
		if cs2Modes[k].GT == gt && cs2Modes[k].GM == gm {
			mode = k
			break
		}
	}
	diff := 2
	if mm := reBotDiff.FindStringSubmatch(m["SRCDS_ADDITIONAL_ARGS"]); mm != nil {
		diff, _ = strconv.Atoi(mm[1])
	}
	mp, _ := strconv.Atoi(m["MAXPLAYERS"])
	if mp == 0 {
		mp = 16
	}
	return &CS2Live{Mode: mode, BotDifficulty: diff, MaxPlayers: mp, ModeOptions: cs2ModeOrder}
}

var reStatusMap = regexp.MustCompile(`(?m)^map\s*:\s*(\S+)`)

// ApplyCS2Live pushes a new mode / bot difficulty / player cap to the
// running CS2 server over RCON — no pod restart. A game-mode change needs
// an in-game map reload (changelevel), which is seconds, not a restart.
func (c *Cluster) ApplyCS2Live(ctx context.Context, ns, name, mode string, botDifficulty, maxPlayers int) (string, error) {
	b := c.snap()
	if b == nil {
		return "", ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	conts := dep.Spec.Template.Spec.Containers
	if len(conts) == 0 {
		return "", fmt.Errorf("deployment %s/%s has no containers", ns, name)
	}
	pw := rconPasswordFromEnv(conts[0].Env)
	if pw == "" {
		return "", fmt.Errorf("server has no RCON password env set — cannot apply live")
	}

	// Resolve the Service and a TCP port for RCON (prefer the named
	// game-tcp port; RCON rides the game port over TCP).
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
		return "", fmt.Errorf("could not resolve a Service ClusterIP for %s/%s", ns, name)
	}
	var port int32
	for _, p := range svc.Spec.Ports {
		if p.Protocol == corev1.ProtocolTCP && (p.Name == "game-tcp" || port == 0) {
			port = p.Port
			if p.Name == "game-tcp" {
				break
			}
		}
	}
	if port == 0 {
		return "", fmt.Errorf("no TCP port on Service for RCON")
	}
	addr := fmt.Sprintf("%s:%d", svc.Spec.ClusterIP, port)

	// Always-safe instant tweaks.
	cmds := []string{
		fmt.Sprintf("bot_difficulty %d", clampInt(botDifficulty, 0, 3)),
		"bot_quota_mode fill",
	}
	mc, modeKnown := cs2Modes[mode]
	if maxPlayers <= 0 && modeKnown {
		maxPlayers = mc.Slots
	}
	if modeKnown {
		botN := mc.Bots
		if mode == "deathmatch" || mode == "armsrace" {
			if maxPlayers > 0 && maxPlayers < botN {
				botN = maxPlayers
			}
		}
		cmds = append(cmds, fmt.Sprintf("bot_quota %d", botN))
	}

	// Mode switch needs a map reload. Fetch the current map first, then
	// set the cvars and changelevel back to it (seconds, no restart).
	statusOut, _ := games.RCON(ctx, addr, pw, []string{"status"})
	curMap := ""
	if mm := reStatusMap.FindStringSubmatch(statusOut); mm != nil {
		curMap = strings.TrimSpace(mm[1])
	}
	if modeKnown {
		cmds = append(cmds,
			fmt.Sprintf("game_type %d", mc.GT),
			fmt.Sprintf("game_mode %d", mc.GM),
		)
		if curMap != "" {
			cmds = append(cmds, fmt.Sprintf("changelevel %s", curMap))
		} else {
			cmds = append(cmds, "mp_restartgame 1")
		}
	} else {
		cmds = append(cmds, "mp_restartgame 1")
	}

	out, err := games.RCON(ctx, addr, pw, cmds)
	if err != nil {
		return "", err
	}
	return out, nil
}

func clampInt(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}
