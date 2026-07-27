package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// autoUpdateVar describes one container image's "update on start" env var and
// how its value maps to the user-facing "auto-update enabled" toggle. Images
// disagree on both the var name and the polarity:
//
//	wolveix/satisfactory : SKIPUPDATE      ("true" = skip steamcmd)
//	joedwards32/cs2      : STEAMAPPVALIDATE ("1" = validate/update on start)
//	various ich777 imgs  : VALIDATE / UPDATE_ON_START ("true" = do update)
//
// We normalize all of that to a single boolean: Enabled == "the next start
// will run a SteamCMD validate/update".
type autoUpdateVar struct {
	Name   string
	OnVal  string // value to write when auto-update is ENABLED
	OffVal string // value to write when auto-update is DISABLED
}

// Ordered: the first of these present on the container wins.
var autoUpdateVars = []autoUpdateVar{
	{Name: "GAMECTL_VALIDATE", OnVal: "1", OffVal: "0"},           // cs2 (kus) — GameCTL-injected validate/update gate (command honors it)
	{Name: "SKIPUPDATE", OnVal: "false", OffVal: "true"},          // satisfactory (wolveix)
	{Name: "STEAMAPPVALIDATE", OnVal: "1", OffVal: "0"},           // cs2 (joedwards32) — "1" = validate/update
	{Name: "SKIP_UPDATE", OnVal: "0", OffVal: "1"},                // legacy cs2 deploys (pre-CS2_* fix)
	{Name: "RUN_UPDATE_ON_START", OnVal: "true", OffVal: "false"}, // satisfactory secondary
	{Name: "UPDATE_ON_START", OnVal: "true", OffVal: "false"},
	{Name: "VALIDATE", OnVal: "true", OffVal: "false"}, // ich777 steamcmd family
}

// autoUpdateAnno records the operator's DESIRED auto-update choice on the
// Deployment's own metadata (not the pod template). Patching metadata
// annotations does not roll pods, so toggling the setting never disturbs a
// running server — the choice is applied to the container env only when the
// operator explicitly restarts (RestartInstance reconciles it in the same
// rollout). Value: "on" | "off".
const autoUpdateAnno = "gamectl.io/auto-update"

// cs2UpdateRequestAnno is a one-shot pod-template annotation used by GameCTL's
// generated CS2 init container. When the value changes, the init container runs
// `steamcmd +app_update 730 validate` against the persistent install, records
// the request value on the PVC, and subsequent restarts stay fast until the
// annotation changes again.
const cs2UpdateRequestAnno = "gamectl.io/cs2-update-request-at"

// advertiseAnno records whether this instance is opted into the GameCTL
// Stats API's public GET /api/stats/servers response. Same
// metadata-annotation-only mechanism as autoUpdateAnno — flipping it never
// rolls the Deployment. Value: "on" | "off" (absent == "off").
const advertiseAnno = "gamectl.io/advertise"

// advertiseNameAnno / advertiseSlugAnno are optional companions to
// advertiseAnno: a human-facing display name and the key this instance is
// listed under in the Stats API response (defaults to the `game` label
// when unset, so a single-instance-per-game operator like the common case
// needs to set neither).
const (
	advertiseNameAnno = "gamectl.io/advertise-name"
	advertiseSlugAnno = "gamectl.io/advertise-slug"
)

// AutoUpdateState is the wire shape for the update toggle.
type AutoUpdateState struct {
	Supported bool   `json:"supported"`        // false = no recognized update env var on this game
	Enabled   bool   `json:"enabled"`          // desired: will the next start validate/update?
	Pending   bool   `json:"pending"`          // desired differs from the live pod's env → needs a restart
	EnvVar    string `json:"envVar,omitempty"` // which env var drives it (for transparency)
}

// Credential is one sensitive env value surfaced on the manage screen so the
// operator can copy it (RCON / server password / GSLT token, …).
type Credential struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// InstanceSettings is the wire shape for GET .../settings.
type InstanceSettings struct {
	AutoUpdate  AutoUpdateState `json:"autoUpdate"`
	Credentials []Credential    `json:"credentials"`
	// Image is the running container image. For games whose image bakes the
	// game in (no runtime update var), the tag IS the version — the UI shows
	// this so "update = retag + redeploy" is concrete.
	Image string `json:"image,omitempty"`
	// CS2 is populated only for cs2 instances: the current live game-mode /
	// bot / player config, editable from the manage screen via RCON.
	CS2 *CS2Live `json:"cs2,omitempty"`
	// WF2 is populated only for wreckfest2 instances: the env-driven server
	// config the manage screen can edit (applies on a one-pod restart).
	WF2 *WF2Live `json:"wf2,omitempty"`
	// RconAvailable: the Deployment has a RCON_PASSWORD env (Source-RCON
	// capable). The manage screen shows a generic console when true.
	RconAvailable bool `json:"rconAvailable"`
	// Game is the game-label value (cs2, minecraft, factorio, …) so the UI
	// can offer game-appropriate console quick-commands.
	Game string `json:"game,omitempty"`
	// ServerName is the name the server advertises in its in-game server
	// browser (Wreckfest 2, Valheim, …). For games whose players find the
	// server by searching a list rather than typing an address, this IS the
	// join handle — the manage screen shows it next to the address.
	ServerName string `json:"serverName,omitempty"`

	// Advertise: is this instance opted into the GameCTL Stats API's public
	// server list? AdvertiseName/AdvertiseSlug are cosmetic overrides for
	// that listing (slug defaults to Game when empty).
	Advertise     bool   `json:"advertise"`
	AdvertiseName string `json:"advertiseName,omitempty"`
	AdvertiseSlug string `json:"advertiseSlug,omitempty"`
}

// serverNameVars: env vars (in priority order) that hold the in-game
// server-browser name across the game images GameCTL deploys.
var serverNameVars = []string{"SERVER_NAME", "SERVERNAME", "BAR_NAME"}

// credentialNameHints: case-insensitive substring match against env var names.
// These are already plain text in the Deployment pod spec (the wizard doesn't
// use Secrets), so the gamectl ServiceAccount can read them back directly —
// this just surfaces what's already there to the operator who deployed it.
var credentialNameHints = []string{"PASSWORD", "TOKEN", "SECRET", "RCON", "PASS"}

// credentialNameExact: env vars that are an access credential / join code
// but whose name doesn't contain a generic hint word. Core Keeper's
// GAME_ID is the relay join code players connect with; in direct mode it
// is empty (and empty values are filtered out below), so this surfaces
// automatically only for the deployment type that uses it.
var credentialNameExact = map[string]bool{
	"GAME_ID":     true, // Core Keeper relay join code
	"SERVER_CODE": true,
	"JOIN_CODE":   true,
}

func looksLikeCredential(name string) bool {
	u := strings.ToUpper(name)
	if credentialNameExact[u] {
		return true
	}
	for _, h := range credentialNameHints {
		if strings.Contains(u, h) {
			return true
		}
	}
	return false
}

// InstanceSettings reads the first container's env and derives the auto-update
// state plus the credential list.
func (c *Cluster) InstanceSettings(ctx context.Context, ns, name string) (InstanceSettings, error) {
	b := c.snap()
	if b == nil {
		return InstanceSettings{}, ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return InstanceSettings{}, err
	}
	conts := dep.Spec.Template.Spec.Containers
	if len(conts) == 0 {
		return InstanceSettings{}, fmt.Errorf("deployment %s/%s has no containers", ns, name)
	}
	env := conts[0].Env

	out := InstanceSettings{Credentials: []Credential{}, Image: conts[0].Image}

	for _, v := range autoUpdateVars {
		for _, e := range env {
			if e.Name == v.Name {
				// effective = what the currently-running pod will actually do.
				effective := strings.EqualFold(e.Value, v.OnVal)
				st := AutoUpdateState{Supported: true, Enabled: effective, EnvVar: v.Name}
				// A desired-choice annotation (set without restarting) wins
				// for display and marks the setting pending until a restart
				// reconciles it into the pod env.
				if d, ok := dep.Annotations[autoUpdateAnno]; ok {
					desired := strings.EqualFold(d, "on")
					st.Enabled = desired
					st.Pending = desired != effective
				}
				out.AutoUpdate = st
				break
			}
		}
		if out.AutoUpdate.Supported {
			break
		}
	}

	for _, e := range env {
		if e.Value == "" || e.ValueFrom != nil || !looksLikeCredential(e.Name) {
			continue
		}
		out.Credentials = append(out.Credentials, Credential{Name: e.Name, Value: e.Value})
	}

	out.RconAvailable = rconReachable(env)

	for _, n := range serverNameVars {
		for _, e := range env {
			if e.Name == n && e.Value != "" {
				out.ServerName = e.Value
				break
			}
		}
		if out.ServerName != "" {
			break
		}
	}

	gameKey := dep.Labels["game"]
	if gameKey == "" {
		gameKey = dep.Spec.Template.Labels["game"]
	}
	out.Game = gameKey

	out.Advertise = strings.EqualFold(dep.Annotations[advertiseAnno], "on")
	out.AdvertiseName = dep.Annotations[advertiseNameAnno]
	out.AdvertiseSlug = dep.Annotations[advertiseSlugAnno]
	if gameKey == "wreckfest2" {
		out.WF2 = wf2LiveFromEnv(env)
	}
	if gameKey == "cs2" {
		out.CS2 = cs2LiveFromEnv(env)
		// Layer the live RCON state on top so the panel shows the actual
		// current mode + map (post in-game !rtv), not just the deploy-time
		// env value. Best-effort: a hung RCON drops to env-only.
		c.fillCS2LiveFromRCON(ctx, ns, name, out.CS2)
	}
	return out, nil
}

// SetAutoUpdate records the operator's DESIRED auto-update choice as a
// Deployment-metadata annotation. It deliberately does NOT touch the pod
// template, so a running server is never restarted just because the toggle
// was flipped — the change is "pending" until the operator explicitly hits
// Restart (RestartInstance folds it into that one rollout). Validates that
// the image actually has a recognized update env var first.
func (c *Cluster) SetAutoUpdate(ctx context.Context, ns, name string, enabled bool) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	conts := dep.Spec.Template.Spec.Containers
	if len(conts) == 0 {
		return fmt.Errorf("deployment %s/%s has no containers", ns, name)
	}
	if autoUpdateSpecFor(conts[0].Env) == nil {
		return fmt.Errorf("this game has no recognized auto-update env var (not a SteamCMD-update image)")
	}

	choice := "off"
	if enabled {
		choice = "on"
	}
	// metadata.annotations only — does not roll the Deployment.
	patch := map[string]any{
		"metadata": map[string]any{
			"annotations": map[string]any{autoUpdateAnno: choice},
		},
	}
	body, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	_, err = b.clientset.AppsV1().Deployments(ns).Patch(
		ctx, name, types.StrategicMergePatchType, body, metav1.PatchOptions{})
	return err
}

// SetAdvertise records the operator's choice to include (or exclude) this
// instance in the GameCTL Stats API's public server list, plus optional
// display overrides. Same shape as SetAutoUpdate: a metadata-annotations-only
// patch, so it never rolls the Deployment — advertising a running server
// doesn't restart it. displayName/slug of "" clear the corresponding
// annotation (falls back to the game label for slug, empty for name).
func (c *Cluster) SetAdvertise(ctx context.Context, ns, name string, enabled bool, displayName, slug string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	choice := "off"
	if enabled {
		choice = "on"
	}
	patch := map[string]any{
		"metadata": map[string]any{
			"annotations": map[string]any{
				advertiseAnno:     choice,
				advertiseNameAnno: nullIfEmpty(displayName),
				advertiseSlugAnno: nullIfEmpty(slug),
			},
		},
	}
	body, err := json.Marshal(patch)
	if err != nil {
		return err
	}
	_, err = b.clientset.AppsV1().Deployments(ns).Patch(
		ctx, name, types.StrategicMergePatchType, body, metav1.PatchOptions{})
	return err
}

// nullIfEmpty maps "" to JSON null so a strategic merge patch REMOVES the
// annotation key instead of setting it to an empty string — matches
// kubectl's own "null clears a map key" merge-patch behavior.
func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// autoUpdateSpecFor returns the recognized update-on-start env var for a
// container's env (first match wins, per autoUpdateVars order), or nil.
func autoUpdateSpecFor(env []corev1.EnvVar) *autoUpdateVar {
	for i := range autoUpdateVars {
		for _, e := range env {
			if e.Name == autoUpdateVars[i].Name {
				return &autoUpdateVars[i]
			}
		}
	}
	return nil
}
