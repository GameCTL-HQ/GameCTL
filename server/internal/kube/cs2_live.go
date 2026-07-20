package kube

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameCTL-HQ/GameCTL/server/internal/games"
)

// CS2 live mode control for the manage screen. CS2 servers run the
// kus/cs2-modded-server image (see kubeUI/src/utils/cs2Generator.js) —
// switching mode means exec'ing the mode's cfg then changing to a map for
// that mode over RCON, no pod restart. This table MIRRORS CS2_MODES in
// cs2Generator.js — keep the two in sync.

type cs2Mode struct {
	Cfg   string // mode cfg the server execs (game/csgo/cfg/<Cfg>)
	Map   string // default map: numeric Workshop ID or stock name; "" = let the mode decide
	WS    bool   // true ⇒ host_workshop_map, false ⇒ changelevel
	Label string
}

var cs2Modes = map[string]cs2Mode{
	"competitive": {"comp.cfg", "de_dust2", false, "Competitive (MatchZy)"},
	"casual":      {"casual.cfg", "de_dust2", false, "Casual"},
	"surf":        {"surf.cfg", "3076153623", true, "Surf"},
	"bhop":        {"bhop.cfg", "", true, "Bunny Hop"},
	"kz":          {"kz.cfg", "", true, "KZ"},
	"arena1v1":    {"1v1.cfg", "3139172262", true, "1v1 Arenas"},
	"deathmatch":  {"deathmatch.cfg", "de_dust2", false, "Deathmatch"},
	"armsrace":    {"gg.cfg", "de_dust2", false, "Arms Race"},
	"retake":      {"retake.cfg", "de_dust2", false, "Retakes"},
	"wingman":     {"wingman.cfg", "de_overpass", false, "Wingman"},
	"awp":         {"awp.cfg", "3146105097", true, "AWP Only"},
	"aim":         {"aim.cfg", "3070549948", true, "Aim"},
	"uspninjas":   {"casual.cfg", "3452854397", true, "USP Ninjas"},
}

// Stable display order for the UI dropdown / mode buttons.
var cs2ModeOrder = []string{
	"competitive", "casual", "surf", "bhop", "kz", "arena1v1",
	"deathmatch", "armsrace", "retake", "wingman", "awp", "aim", "uspninjas",
}

// CS2Live is the wire shape for the manage-screen CS2 panel.
type CS2Live struct {
	Mode        string   `json:"mode"`        // current mode, from the GAMECTL_CS2_MODE env
	MaxPlayers  int      `json:"maxPlayers"`  // from the MAXPLAYERS env
	ModeOptions []string `json:"modeOptions"` // selectable modes (cs2ModeOrder)
	// Live state — sourced from RCON when the server is up. Lets the
	// manage screen reflect what's actually running after an in-game !rtv
	// (rather than just the wizard-stamped deploy-time mode). Empty when
	// the RCON query fails (server still booting, password mismatch, …).
	LiveMap   string `json:"liveMap,omitempty"`
	LiveMode  string `json:"liveMode,omitempty"`
}

func envMap(env []corev1.EnvVar) map[string]string {
	m := make(map[string]string, len(env))
	for _, e := range env {
		m[e.Name] = e.Value
	}
	return m
}

func cs2LiveFromEnv(env []corev1.EnvVar) *CS2Live {
	m := envMap(env)
	// GameCTL stamps the deployed mode into GAMECTL_CS2_MODE (cs2Generator.js).
	mode := strings.TrimSpace(m["GAMECTL_CS2_MODE"])
	if _, ok := cs2Modes[mode]; !ok {
		mode = "surf"
	}
	mp, _ := strconv.Atoi(strings.TrimSpace(m["MAXPLAYERS"]))
	if mp == 0 {
		mp = 24
	}
	return &CS2Live{Mode: mode, MaxPlayers: mp, ModeOptions: cs2ModeOrder}
}

// fillCS2LiveFromRCON layers the live, RCON-sourced current map +
// game-mode label onto a CS2Live built from env. The wizard-stamped
// GAMECTL_CS2_MODE only reflects the deploy-time choice; after an
// in-game !rtv the operator could be on any of the catalog's modes,
// and the manage screen needs to show that. Hard-capped by a short
// context so a hung RCON doesn't block the page load.
//
// css_gamemode is NOT a queryable cvar in the kus image — it's a
// CSSharp display command from GameModeManager, so RCON-querying it
// returns empty. Instead we read game_type + game_mode (real engine
// cvars) and use them — plus the map name — to derive a human-
// friendly label.
func (c *Cluster) fillCS2LiveFromRCON(ctx context.Context, ns, name string, live *CS2Live) {
	if live == nil {
		return
	}
	addr, pw, err := c.resolveCS2RCON(ctx, ns, name)
	if err != nil {
		return
	}
	rconCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	out, err := games.RCON(rconCtx, addr, pw, []string{"status", "game_type", "game_mode", "mp_freeforall"})
	if err != nil {
		return
	}
	var gt, gm, ffa = -1, -1, -1
	for _, line := range strings.Split(out, "\n") {
		s := strings.TrimSpace(line)
		// status line: "map     : surf_kitsune  at: ..."
		if live.LiveMap == "" && strings.HasPrefix(s, "map") {
			rest := strings.TrimSpace(strings.TrimPrefix(s, "map"))
			if strings.HasPrefix(rest, ":") {
				rest = strings.TrimSpace(strings.TrimPrefix(rest, ":"))
				fields := strings.Fields(rest)
				if len(fields) > 0 {
					live.LiveMap = fields[0]
				}
			}
		}
		// cvar echo: "game_type = 0" or "game_type = 0 ( def. 0 )"
		if v, ok := parseCvarInt(s, "game_type"); ok && gt < 0 {
			gt = v
		}
		if v, ok := parseCvarInt(s, "game_mode"); ok && gm < 0 {
			gm = v
		}
		if v, ok := parseCvarInt(s, "mp_freeforall"); ok && ffa < 0 {
			ffa = v
		}
	}
	live.LiveMode = labelFromGameModeCvars(gt, gm, ffa, live.LiveMap)
}

// parseCvarInt pulls the int value out of a cvar-echo line. CS2 prints
// these as: "<name> = <value>" or "<name> = <value> ( def. ... )".
// Returns ok=false when the line is for a different cvar or unparseable.
func parseCvarInt(line, cvar string) (int, bool) {
	// Tolerate the leading prefix that RCON adds on some builds.
	idx := strings.Index(line, cvar)
	if idx < 0 {
		return 0, false
	}
	rest := line[idx+len(cvar):]
	eq := strings.Index(rest, "=")
	if eq < 0 {
		return 0, false
	}
	tail := strings.TrimSpace(rest[eq+1:])
	// First token = value
	if i := strings.IndexAny(tail, " \t("); i > 0 {
		tail = tail[:i]
	}
	v, err := strconv.Atoi(tail)
	if err != nil {
		return 0, false
	}
	return v, true
}

// labelFromGameModeCvars maps the CS2 game_type / game_mode / freeforall
// triplet to a human-friendly mode label. The catalog has 33 entries
// but the underlying engine knobs are coarse — this returns the
// closest stock CS2 mode. The map name is a secondary hint: a surf_*
// map with Competitive cvars is still going to BE surf, so we let
// the prefix override.
func labelFromGameModeCvars(gt, gm, ffa int, mapName string) string {
	// Map prefixes first — these always trump the cvar reading because
	// the cfg may not have re-set game_type/mode on an in-place !rtv.
	low := strings.ToLower(mapName)
	switch {
	case strings.HasPrefix(low, "surf_"):
		return "Surf"
	case strings.HasPrefix(low, "bhop_"):
		return "Bhop"
	case strings.HasPrefix(low, "kz_"), strings.HasPrefix(low, "kzpro_"), strings.HasPrefix(low, "xc_"):
		return "Kreedz Climbing"
	case strings.HasPrefix(low, "aim_"):
		return "Aim"
	case strings.HasPrefix(low, "ar_"):
		return "Arms Race"
	case strings.HasPrefix(low, "fy_"):
		return "Deathmatch"
	case strings.HasPrefix(low, "mg_"):
		return "Minigames"
	case strings.HasPrefix(low, "ctf_"):
		return "Capture The Flag"
	}
	// Cvar fallback for stock de_ / cs_ maps where mode is really
	// determined by the cfg-chain.
	switch {
	case gt == 0 && gm == 0:
		return "Casual"
	case gt == 0 && gm == 1:
		return "Competitive"
	case gt == 1 && gm == 0:
		return "Arms Race"
	case gt == 1 && gm == 2:
		if ffa == 1 {
			return "Deathmatch"
		}
		return "Team Deathmatch"
	case gt == 2:
		return "Wingman"
	case gt == 4:
		return "Retakes"
	}
	return ""
}

// resolveCS2RCON finds the Service ClusterIP + TCP port for RCON on a CS2
// deployment, and the RCON password from the container env.
func (c *Cluster) resolveCS2RCON(ctx context.Context, ns, name string) (addr, pw string, err error) {
	b := c.snap()
	if b == nil {
		return "", "", ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", "", err
	}
	conts := dep.Spec.Template.Spec.Containers
	if len(conts) == 0 {
		return "", "", fmt.Errorf("deployment %s/%s has no containers", ns, name)
	}
	pw = rconPasswordFromEnv(conts[0].Env)
	if pw == "" {
		return "", "", fmt.Errorf("server has no RCON password env set — cannot apply live")
	}
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
		return "", "", fmt.Errorf("could not resolve a Service ClusterIP for %s/%s", ns, name)
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
		return "", "", fmt.Errorf("no TCP port on Service for RCON")
	}
	return fmt.Sprintf("%s:%d", svc.Spec.ClusterIP, port), pw, nil
}

// ApplyCS2Live switches the running CS2 server to a different mode over
// RCON — no pod restart. It execs the mode's cfg (which the modded image's
// GameModeManager uses to load that mode's plugins) then changes to a map
// for the mode. The exec→map gap lets the plugin load/unload settle.
//
// This is a live switch only — it does NOT persist a pod recreate. To make
// a mode the permanent default, redeploy via the wizard (which stamps
// GAMECTL_CS2_MODE + the on_boot.cfg overlay).
func (c *Cluster) ApplyCS2Live(ctx context.Context, ns, name, mode string) (string, error) {
	mc, ok := cs2Modes[mode]
	if !ok {
		return "", fmt.Errorf("unknown CS2 mode %q", mode)
	}
	return c.applyCS2Switch(ctx, ns, name, mc.Cfg, mc.Map, mc.WS)
}

// ApplyCS2LiveDirect switches mode + map without consulting the local
// cs2Modes table — the UI's full catalog (cs2RtvCatalog.js) sends the cfg,
// map and workshop flag directly. Same RCON dance as ApplyCS2Live.
func (c *Cluster) ApplyCS2LiveDirect(ctx context.Context, ns, name, cfg, mapStr string, workshop bool) (string, error) {
	if cfg == "" {
		return "", fmt.Errorf("missing mode cfg")
	}
	return c.applyCS2Switch(ctx, ns, name, cfg, mapStr, workshop)
}

func (c *Cluster) applyCS2Switch(ctx context.Context, ns, name, cfg, mapStr string, workshop bool) (string, error) {
	addr, pw, err := c.resolveCS2RCON(ctx, ns, name)
	if err != nil {
		return "", err
	}
	// 1. exec the mode cfg — GameModeManager loads/unloads the mode's plugins.
	out, err := games.RCON(ctx, addr, pw, []string{"exec " + cfg})
	if err != nil {
		return "", err
	}
	// 2. let the plugin load/unload settle before the map change.
	select {
	case <-ctx.Done():
		return out, ctx.Err()
	case <-time.After(6 * time.Second):
	}
	// 3. change to a map for the mode (skip if the mode has no fixed map).
	if mapStr != "" {
		mapCmd := "changelevel " + mapStr
		if workshop {
			mapCmd = "host_workshop_map " + mapStr
		}
		out2, err := games.RCON(ctx, addr, pw, []string{mapCmd})
		if err != nil {
			return "", err
		}
		out += "\n" + out2
		// 4. wait for the level to load, then re-exec the mode cfg + the
		// GameCTL server identity cfg. On every changelevel CS2 runs the
		// new map's gamemode_<x>.cfg, which resets cheat-class cvars like
		// sv_cheats / sv_grenade_trajectory / mp_buy_anywhere and re-enables
		// mp_endmatch_votenextmap. Re-applying our cfgs after the load makes
		// the operator's chosen mode (especially Free Practice) actually
		// stick instead of reverting to Valve defaults.
		select {
		case <-ctx.Done():
			return out, ctx.Err()
		case <-time.After(10 * time.Second):
		}
		out3, err := games.RCON(ctx, addr, pw,
			[]string{"exec " + cfg, "exec gamectl_server.cfg"})
		if err != nil {
			return out, err
		}
		out += "\n" + out3
	}
	return out, nil
}

