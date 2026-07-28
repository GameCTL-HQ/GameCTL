package kube

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/tools/remotecommand"

	"github.com/GameCTL-HQ/GameCTL/server/internal/games"
)

// CS2 player roster + admin management for the manage screen. The CS2
// server runs the kus/cs2-modded-server image (CounterStrikeSharp).
//
//   - Connected players come from the RCON `status` table.
//   - Admins live in CounterStrikeSharp's core admins.json
//     (addons/counterstrikesharp/configs/admins.json) — that file gates
//     every plugin's commands via the #css/admin / #css/moderator groups
//     the kus image defines in admin_groups.json.
//
// GameCTL owns the admin list: the canonical copy is a per-server
// ConfigMap (cs2-<server>-admins). A live add/remove updates the
// ConfigMap AND writes admins.json into the running pod + reloads it over
// RCON — so it takes effect with no restart and survives a pod recreate
// (the gen-config init container re-seeds admins.json from the ConfigMap).

const (
	// steamID64 base — added to a SteamID3 account id to get a SteamID64.
	steamID64Base  = 76561197960265728
	cs2AdminsCMKey = "admins.json"
	// admins.json inside the running install dir — the live effect target.
	// Persistence is the cs2-<server>-admins ConfigMap, NOT a file write:
	// the gen-config init container re-seeds admins.json from the ConfigMap
	// on every (re)boot, so there is no overlay file to write here.
	cs2AdminsLive = "/home/steam/cs2/game/csgo/addons/counterstrikesharp/configs/admins.json"
	// admin_groups.json — defines what the #css/admin / #css/moderator groups
	// grant. admins.json only assigns membership; without this the groups are
	// empty and admins can run nothing. Written live alongside admins.json so
	// existing servers self-heal on the next admin change even before a
	// redeploy picks up the generator's seed.
	cs2AdminGroupsLive = "/home/steam/cs2/game/csgo/addons/counterstrikesharp/configs/admin_groups.json"
)

// cs2AdminGroupsJSON is the static group-permission definition GameCTL
// guarantees exists. #css/admin gets @css/root (everything); #css/moderator
// a broad-but-capped set. Kept in sync with cs2Generator.js's adminGroupsSeed.
const cs2AdminGroupsJSON = `{
  "#css/admin": {
    "flags": ["@css/reservation","@css/generic","@css/kick","@css/ban","@css/unban","@css/vip","@css/slay","@css/changemap","@css/cvar","@css/config","@css/chat","@css/vote","@css/password","@css/rcon","@css/cheats","@css/root"],
    "immunity": 100
  },
  "#css/moderator": {
    "flags": ["@css/reservation","@css/generic","@css/kick","@css/ban","@css/unban","@css/slay","@css/changemap","@css/cvar","@css/config","@css/chat","@css/vote","@css/rcon"],
    "immunity": 99
  }
}`

func cs2AdminsCM(server string) string { return "cs2-" + server + "-admins" }

// CS2Player is one entry from the RCON `status` table.
type CS2Player struct {
	UserID    int    `json:"userId"`
	Name      string `json:"name"`
	SteamID64 string `json:"steamId64,omitempty"`
	Ping      int    `json:"ping"`
	State     string `json:"state,omitempty"`
	IsBot     bool   `json:"isBot"`
	IsAdmin   bool   `json:"isAdmin"`
	Role      string `json:"role,omitempty"` // "admin" | "moderator" | ""
}

// CS2Admin is one admin in the GameCTL-owned list.
type CS2Admin struct {
	Name      string `json:"name"`
	SteamID64 string `json:"steamId64"`
	Role      string `json:"role"` // "admin" | "moderator"
}

// cssAdminEntry is the on-disk admins.json value shape:
//
//	{ "<display name>": { "identity": "<steamid64>", "groups": ["#css/admin"] } }
type cssAdminEntry struct {
	Identity string   `json:"identity"`
	Groups   []string `json:"groups,omitempty"`
}

func roleGroup(role string) string {
	if role == "moderator" {
		return "#css/moderator"
	}
	return "#css/admin"
}

func groupsRole(groups []string) string {
	for _, g := range groups {
		if strings.EqualFold(g, "#css/moderator") {
			return "moderator"
		}
	}
	return "admin"
}

// --- player roster -------------------------------------------------------

var (
	// RCON `users` row: <slot>:<userid>:"<name>"
	reUsersLine = regexp.MustCompile(`(?m)^\d+:(\d+):"(.*)"\s*$`)
	// Modern CS2 `status`/`users` no longer print SteamIDs. The gameplay
	// log lines still do, in the classic Source form:
	//   "<name><N><[U:1:<accountid>]><team>"
	reLogSteam = regexp.MustCompile(`"([^"<]+)<\d+><\[U:1:(\d+)\]>`)
)

// CS2Players returns the connected players. The live roster comes from
// RCON `users` (userid + name); SteamIDs are harvested from the server
// log (CS2's `users`/`status` no longer expose them) and joined by name.
func (c *Cluster) CS2Players(ctx context.Context, ns, name string) ([]CS2Player, error) {
	addr, pw, err := c.resolveCS2RCON(ctx, ns, name)
	if err != nil {
		return nil, err
	}
	out, err := games.RCON(ctx, addr, pw, []string{"users"})
	if err != nil {
		return nil, err
	}
	steam := c.cs2SteamIDsFromLog(ctx, ns, name) // name -> SteamID64

	admins, _ := c.CS2Admins(ctx, ns, name)
	adminByID := map[string]string{}
	for _, a := range admins {
		adminByID[a.SteamID64] = a.Role
	}

	var players []CS2Player
	for _, m := range reUsersLine.FindAllStringSubmatch(out, -1) {
		uid, _ := strconv.Atoi(m[1])
		p := CS2Player{UserID: uid, Name: m[2]}
		if sid, ok := steam[m[2]]; ok {
			p.SteamID64 = sid
			if r, ok := adminByID[sid]; ok {
				p.IsAdmin = true
				p.Role = r
			}
		}
		players = append(players, p)
	}
	return players, nil
}

// cs2SteamIDsFromLog scans the tail of the CS2 server log for the classic
// Source action lines that carry "<name>…<[U:1:N]>…" and returns a
// name → SteamID64 map (last occurrence wins).
func (c *Cluster) cs2SteamIDsFromLog(ctx context.Context, ns, server string) map[string]string {
	res := map[string]string{}
	b := c.snap()
	if b == nil {
		return res
	}
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return res
	}
	tail := int64(6000)
	stream, err := b.clientset.CoreV1().Pods(ns).
		GetLogs(pod, &corev1.PodLogOptions{Container: container, TailLines: &tail}).
		Stream(ctx)
	if err != nil {
		return res
	}
	defer stream.Close()
	data, err := io.ReadAll(stream)
	if err != nil {
		return res
	}
	for _, m := range reLogSteam.FindAllStringSubmatch(string(data), -1) {
		if acct, err := strconv.ParseInt(m[2], 10, 64); err == nil {
			res[m[1]] = strconv.FormatInt(acct+steamID64Base, 10)
		}
	}
	return res
}

// --- admin list ----------------------------------------------------------

// adminsConfigMap returns the cs2-<server>-admins ConfigMap, creating an
// empty one if it doesn't exist yet.
func (c *Cluster) adminsConfigMap(ctx context.Context, ns, server string) (*corev1.ConfigMap, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	cms := b.clientset.CoreV1().ConfigMaps(ns)
	cm, err := cms.Get(ctx, cs2AdminsCM(server), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      cs2AdminsCM(server),
				Namespace: ns,
				Labels:    map[string]string{"app": server, "game": "cs2", "app.kubernetes.io/managed-by": "gamectl"},
			},
			Data: map[string]string{cs2AdminsCMKey: "{}"},
		}, nil
	}
	return cm, err
}

// parseAdminsJSON turns an admins.json document into a sorted CS2Admin list.
func parseAdminsJSON(raw string) []CS2Admin {
	m := map[string]cssAdminEntry{}
	if strings.TrimSpace(raw) != "" {
		_ = json.Unmarshal([]byte(raw), &m)
	}
	var out []CS2Admin
	for name, e := range m {
		if e.Identity == "" {
			continue
		}
		out = append(out, CS2Admin{Name: name, SteamID64: e.Identity, Role: groupsRole(e.Groups)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// buildAdminsJSON renders a CS2Admin list back to an admins.json document.
func buildAdminsJSON(admins []CS2Admin) (string, error) {
	m := map[string]cssAdminEntry{}
	for _, a := range admins {
		key := a.Name
		if key == "" {
			key = "Admin " + a.SteamID64
		}
		m[key] = cssAdminEntry{Identity: a.SteamID64, Groups: []string{roleGroup(a.Role)}}
	}
	data, err := json.MarshalIndent(m, "", "  ")
	return string(data), err
}

// CS2Admins returns the GameCTL-owned admin list for a CS2 server.
func (c *Cluster) CS2Admins(ctx context.Context, ns, server string) ([]CS2Admin, error) {
	cm, err := c.adminsConfigMap(ctx, ns, server)
	if err != nil {
		return nil, err
	}
	return parseAdminsJSON(cm.Data[cs2AdminsCMKey]), nil
}

// CS2SetAdmin adds or removes a CS2 admin. It updates the canonical
// ConfigMap, writes admins.json into the running pod (live install dir +
// the custom_files overlay so it survives a recreate), and reloads it.
func (c *Cluster) CS2SetAdmin(ctx context.Context, ns, server, steamID64, playerName, role string, add bool) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	steamID64 = strings.TrimSpace(steamID64)
	if !regexp.MustCompile(`^\d{17}$`).MatchString(steamID64) {
		return fmt.Errorf("invalid SteamID64 %q (expected a 17-digit number)", steamID64)
	}
	if role != "moderator" {
		role = "admin"
	}

	// Mutate the list off the canonical ConfigMap.
	cm, err := c.adminsConfigMap(ctx, ns, server)
	if err != nil {
		return err
	}
	admins := parseAdminsJSON(cm.Data[cs2AdminsCMKey])
	next := admins[:0:0]
	for _, a := range admins {
		if a.SteamID64 != steamID64 {
			next = append(next, a)
		}
	}
	if add {
		nm := strings.TrimSpace(playerName)
		if nm == "" {
			nm = "Admin " + steamID64
		}
		next = append(next, CS2Admin{Name: nm, SteamID64: steamID64, Role: role})
	}
	doc, err := buildAdminsJSON(next)
	if err != nil {
		return err
	}

	// Persist to the ConfigMap (create-or-update).
	cms := b.clientset.CoreV1().ConfigMaps(ns)
	if cm.ResourceVersion == "" {
		cm.Data = map[string]string{cs2AdminsCMKey: doc}
		if _, err := cms.Create(ctx, cm, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create admins ConfigMap: %w", err)
		}
	} else {
		if cm.Data == nil {
			cm.Data = map[string]string{}
		}
		cm.Data[cs2AdminsCMKey] = doc
		if _, err := cms.Update(ctx, cm, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update admins ConfigMap: %w", err)
		}
	}

	// Apply live: write admins.json into the running pod, then reload.
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		// ConfigMap is saved — it'll apply on the next (re)start.
		return fmt.Errorf("admin list saved, but live apply failed: %w", err)
	}
	if _, stderr, e := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "cat > " + cs2AdminsLive}, doc); e != nil {
		return fmt.Errorf("admin list saved to ConfigMap, but the live write failed: %w (%s)",
			e, strings.TrimSpace(stderr))
	}
	// Ensure the group definitions exist too — otherwise the admin we just
	// wrote has group membership but zero permissions. Best-effort: the
	// admins.json write already succeeded, so don't fail the whole call if
	// this one hiccups (the generator also seeds it on the next restart).
	if _, _, e := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "cat > " + cs2AdminGroupsLive}, cs2AdminGroupsJSON); e != nil {
		// non-fatal; log-and-continue to the reload below
		_ = e
	}
	// Reload the CounterStrikeSharp admin framework over RCON so the new
	// admins.json takes effect with no restart. css_admins_reload is the
	// CSSharp *core* command (verified on the running server — it logs
	// "AdminManager Loaded admin data with N admins"); SimpleAdmin's
	// css_reladmin does not exist on this image.
	if addr, pw, e := c.resolveCS2RCON(ctx, ns, server); e == nil {
		_, _ = games.RCON(ctx, addr, pw, []string{"css_admins_reload"})
	}
	return nil
}

// --- pod exec ------------------------------------------------------------

// cs2Pod returns the name + container of a Running pod for a CS2 server.
func (c *Cluster) cs2Pod(ctx context.Context, ns, server string) (pod, container string, err error) {
	b := c.snap()
	if b == nil {
		return "", "", ErrNotConfigured
	}
	list, err := b.clientset.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
		LabelSelector: "app=" + server,
	})
	if err != nil {
		return "", "", err
	}
	for i := range list.Items {
		p := &list.Items[i]
		if p.Status.Phase == corev1.PodRunning && len(p.Spec.Containers) > 0 {
			return p.Name, p.Spec.Containers[0].Name, nil
		}
	}
	return "", "", fmt.Errorf("no running pod for cs2 server %q", server)
}

// podExec runs a command in a pod container, optionally feeding stdin, and
// returns its stdout and stderr.
func (c *Cluster) podExec(ctx context.Context, ns, pod, container string, cmd []string, stdin string) (string, string, error) {
	b := c.snap()
	if b == nil {
		return "", "", ErrNotConfigured
	}
	req := b.clientset.CoreV1().RESTClient().Post().
		Resource("pods").Name(pod).Namespace(ns).SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: container,
			Command:   cmd,
			Stdin:     stdin != "",
			Stdout:    true,
			Stderr:    true,
		}, scheme.ParameterCodec)
	exec, err := remotecommand.NewSPDYExecutor(b.restCfg, "POST", req.URL())
	if err != nil {
		return "", "", err
	}
	var stdout, stderr bytes.Buffer
	opts := remotecommand.StreamOptions{Stdout: &stdout, Stderr: &stderr}
	if stdin != "" {
		opts.Stdin = strings.NewReader(stdin)
	}
	err = exec.StreamWithContext(ctx, opts)
	return stdout.String(), stderr.String(), err
}
