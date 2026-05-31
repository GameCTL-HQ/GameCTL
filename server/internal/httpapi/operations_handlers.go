package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/GameCTL-HQ/GameCTL/server/internal/auth"
	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
	"github.com/GameCTL-HQ/GameCTL/server/internal/tasks"
)

type scaleReq struct {
	Replicas *int32 `json:"replicas"`
}

// instanceSettings handles GET /games/instances/{ns}/{name}/settings —
// auto-update state + credential env vars surfaced for the manage screen.
func instanceSettings(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		out, err := c.InstanceSettings(r.Context(), ns, name)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

type autoUpdateReq struct {
	Enabled *bool `json:"enabled"`
}

// setAutoUpdate handles PATCH /games/instances/{ns}/{name}/autoupdate.
// Flips the SteamCMD update-on-start env var; the deployment rolls so the
// change applies on the next (immediate) pod start.
func setAutoUpdate(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")

		var req autoUpdateReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if req.Enabled == nil {
			writeError(w, http.StatusBadRequest, "'enabled' boolean is required")
			return
		}
		if err := c.SetAutoUpdate(r.Context(), ns, name, *req.Enabled); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"enabled": *req.Enabled,
		})
	}
}

type cs2ConfigReq struct {
	// Legacy: a mode key looked up in the server's cs2Modes table.
	Mode string `json:"mode,omitempty"`
	// Direct: the catalog-driven UI sends the cfg, map id and workshop flag
	// straight from cs2RtvCatalog.js — no server-side mode table needed.
	Cfg      string `json:"cfg,omitempty"`
	Map      string `json:"map,omitempty"`
	Workshop bool   `json:"workshop,omitempty"`
}

// applyCS2Config handles POST /games/instances/{ns}/{name}/cs2config —
// live (RCON, no restart) game-mode switch for a cs2 (kus modded) server.
func applyCS2Config(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		var req cs2ConfigReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		var (
			out string
			err error
		)
		if req.Cfg != "" {
			out, err = c.ApplyCS2LiveDirect(r.Context(), ns, name, req.Cfg, req.Map, req.Workshop)
		} else {
			out, err = c.ApplyCS2Live(r.Context(), ns, name, req.Mode)
		}
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
	}
}

type cs2WelcomeReq struct {
	Message string `json:"message"`
}

// cs2GetWelcome handles GET /games/instances/{ns}/{name}/cs2/welcome —
// returns the current welcome message so the manage screen can show it.
func cs2GetWelcome(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		msg, err := c.CS2GetWelcome(r.Context(), ns, name)
		if err != nil {
			code, m := kube.AsAPIError(err)
			writeError(w, code, m)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"message": msg})
	}
}

// cs2SetWelcome handles POST /games/instances/{ns}/{name}/cs2/welcome —
// updates the GameCtlRtv plugin's welcome_message in the live config and
// reloads the plugin so the change takes effect without a server restart.
func cs2SetWelcome(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		var req cs2WelcomeReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := c.CS2SetWelcome(r.Context(), ns, name, req.Message); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

type cs2HostnameReq struct {
	Hostname string `json:"hostname"`
}

// cs2GetHostname handles GET /games/instances/{ns}/{name}/cs2/hostname —
// returns the live `hostname` cvar so the manage screen can pre-fill it.
func cs2GetHostname(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		hn, err := c.CS2GetHostname(r.Context(), ns, name)
		if err != nil {
			code, m := kube.AsAPIError(err)
			writeError(w, code, m)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"hostname": hn})
	}
}

// cs2SetHostname handles POST /games/instances/{ns}/{name}/cs2/hostname —
// updates the in-game server name via RCON (`hostname "..."`) and persists
// it to the cs2-<server>-config ConfigMap so it survives a pod recreate.
func cs2SetHostname(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		var req cs2HostnameReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := c.CS2SetHostname(r.Context(), ns, name, req.Hostname); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

type cs2APIKeyReq struct {
	ApiKey string `json:"apiKey"`
}

// cs2GetSteamAPIKey handles GET /games/instances/{ns}/{name}/cs2/steam-api-key.
func cs2GetSteamAPIKey(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		k, err := c.CS2GetSteamAPIKey(r.Context(), ns, name)
		if err != nil {
			code, m := kube.AsAPIError(err)
			writeError(w, code, m)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"apiKey": k, "set": k != ""})
	}
}

// cs2SetSteamAPIKey handles POST /games/instances/{ns}/{name}/cs2/steam-api-key.
// Updates the API_KEY env on the cs2 container — rolls the pod (Recreate
// strategy means ~3-4 min downtime while the new pod re-boots cs2).
func cs2SetSteamAPIKey(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		var req cs2APIKeyReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := c.CS2SetSteamAPIKey(r.Context(), ns, name, req.ApiKey); err != nil {
			code, m := kube.AsAPIError(err)
			writeError(w, code, m)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// cs2SurfRecords handles GET /games/instances/{ns}/{name}/cs2/surf-records —
// per-map leaderboards from the GameCtlSurfHUD plugin's JSON file on NFS.
func cs2SurfRecords(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		out, err := c.CS2GetSurfRecords(r.Context(),
			chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
		if err != nil {
			code, m := kube.AsAPIError(err)
			writeError(w, code, m)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// cs2Workshop handles GET /games/instances/{ns}/{name}/cs2/workshop —
// the per-id download status of every subscribed workshop map plus a
// summary, so the operator can see exactly which !rtv maps are ready and
// which would need a server-side fetch.
func cs2Workshop(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		st, err := c.CS2WorkshopGetStatus(r.Context(),
			chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
		if err != nil {
			code, m := kube.AsAPIError(err)
			writeError(w, code, m)
			return
		}
		writeJSON(w, http.StatusOK, st)
	}
}

type cs2WorkshopDownloadReq struct {
	// MissingOnly: only fetch ids not already on disk. Default true.
	MissingOnly *bool `json:"missingOnly,omitempty"`
}

// cs2WorkshopDownload handles POST /games/instances/{ns}/{name}/cs2/workshop/download
// — kicks off the host_workshop_map cycle in the background. Returns the
// number of ids the cycle will visit; the operator polls GET to track it.
func cs2WorkshopDownload(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		var req cs2WorkshopDownloadReq
		_ = json.NewDecoder(r.Body).Decode(&req) // empty body is OK
		missingOnly := true
		if req.MissingOnly != nil {
			missingOnly = *req.MissingOnly
		}
		n, err := c.CS2WorkshopDownload(r.Context(),
			chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), missingOnly)
		if err != nil {
			code, m := kube.AsAPIError(err)
			writeError(w, code, m)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"started": n,
		})
	}
}

// cs2WorkshopCancel handles POST /games/instances/{ns}/{name}/cs2/workshop/cancel.
func cs2WorkshopCancel(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		stopped := c.CS2WorkshopCancelDownload(
			chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "stopped": stopped})
	}
}

type cs2WorkshopSidecarReq struct {
	Enabled bool `json:"enabled"`
}

// cs2WorkshopSidecar handles POST /games/instances/{ns}/{name}/cs2/workshop/sidecar
// — flips the workshop-downloader sidecar's opt-in gate. Body: {"enabled": true|false}.
// Off by default for fresh deploys; operators click the "Pre-download all workshop
// maps" button on the manage screen to turn it on.
func cs2WorkshopSidecar(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		var req cs2WorkshopSidecarReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
			return
		}
		if err := c.CS2WorkshopSidecarSetEnabled(r.Context(),
			chi.URLParam(r, "namespace"), chi.URLParam(r, "name"), req.Enabled); err != nil {
			code, m := kube.AsAPIError(err)
			writeError(w, code, m)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "enabled": req.Enabled})
	}
}

// cs2Players handles GET /games/instances/{ns}/{name}/cs2/players —
// the live connected-player roster (RCON `status`), each tagged with
// whether they're already a GameCTL-managed admin.
func cs2Players(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		players, err := c.CS2Players(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"players": players})
	}
}

// cs2Admins handles GET /games/instances/{ns}/{name}/cs2/admins.
func cs2Admins(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		admins, err := c.CS2Admins(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"admins": admins})
	}
}

type cs2AdminReq struct {
	SteamID64 string `json:"steamId64"`
	Name      string `json:"name"`
	Role      string `json:"role"`   // "admin" | "moderator"
	Action    string `json:"action"` // "add" | "remove"
}

// cs2SetAdmin handles POST /games/instances/{ns}/{name}/cs2/admin — add or
// remove a CS2 admin, applied live (no restart).
func cs2SetAdmin(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		var req cs2AdminReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		add := req.Action != "remove"
		if err := c.CS2SetAdmin(r.Context(), ns, name, req.SteamID64, req.Name, req.Role, add); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		admins, _ := c.CS2Admins(r.Context(), ns, name)
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "admins": admins})
	}
}

type rconReq struct {
	Command string `json:"command"`
}

// runRcon handles POST /games/instances/{ns}/{name}/rcon — one Source-RCON
// console command against the running server (op a player, list, say, …).
func runRcon(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		var req rconReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		cmd := strings.TrimSpace(req.Command)
		if cmd == "" {
			writeError(w, http.StatusBadRequest, "command is required")
			return
		}
		out, err := c.RunRCON(r.Context(), ns, name, cmd)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
	}
}

// restartInstance handles POST /games/instances/{ns}/{name}/restart —
// an operator-triggered rolling restart. Any pending auto-update choice
// (set non-disruptively via the toggle) is reconciled into this one
// rollout, so this is the single point where deferred settings apply.
func restartInstance(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		if err := c.RestartInstance(r.Context(), ns, name); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": true, "name": name, "namespace": ns,
		})
	}
}

func scaleInstance(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")

		var req scaleReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if req.Replicas == nil || *req.Replicas < 0 {
			writeError(w, http.StatusBadRequest, "replicas must be a non-negative integer")
			return
		}

		if err := c.Scale(r.Context(), ns, name, *req.Replicas); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"ok":        true,
			"name":      name,
			"namespace": ns,
			"replicas":  *req.Replicas,
		})
	}
}

func deleteInstance(c *kube.Cluster, store *tasks.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		opts := kube.DeleteOptions{
			WipeData: r.URL.Query().Get("wipe_data") == "true",
		}

		// Async like apply: create a task, return 202 with the taskId, run
		// the sweep in a goroutine so the UI's header indicator can show
		// progress through the namespace-finalize wait.
		title := "Delete " + name
		subject := ns + "/" + name
		// gameID is optional metadata for future per-game filtering; we don't
		// look it up here because the deployment may already be in the middle
		// of cascading delete and a Get would race. The TasksMenu shows all
		// recent tasks regardless.
		handle := store.Create("delete", title, subject, "", auth.User(r.Context()))

		go func(opts kube.DeleteOptions) {
			handle.Start()
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			defer cancel()
			handle.RegisterCancel(cancel)
			_, err := c.DeleteInstance(ctx, ns, name, opts, handle)
			handle.Finish(err)
		}(opts)

		writeJSON(w, http.StatusAccepted, map[string]any{
			"taskId": handle.ID(),
		})
	}
}

type kubeconfigReq struct {
	Kubeconfig string `json:"kubeconfig"`
}

// uploadKubeconfig validates and persists a kubeconfig, then hot-reloads the kube clients.
func uploadKubeconfig(c *kube.Cluster, authn *auth.Authenticator, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if cfg.KubeconfigPath == "" {
			writeError(w, http.StatusBadRequest,
				"kubeconfig storage path not configured (set GAMECTL_KUBECONFIG)")
			return
		}

		body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20)) // 1 MiB cap
		if err != nil {
			writeError(w, http.StatusBadRequest, "read body: "+err.Error())
			return
		}
		var req kubeconfigReq
		if err := json.Unmarshal(body, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if req.Kubeconfig == "" {
			writeError(w, http.StatusBadRequest, "kubeconfig content cannot be empty")
			return
		}

		if c == nil {
			// First-time configuration: not yet connected. Treat as Reload on a freshly
			// constructed Cluster — but our constructor signature requires a Cluster object,
			// so for the scaffold we require pre-configuration. Hot-create from nothing
			// is a Phase 6 follow-up when Secret-mounted kubeconfig is the norm.
			writeError(w, http.StatusServiceUnavailable,
				"server started without an initial kubeconfig; runtime upload requires a pre-configured GAMECTL_KUBECONFIG path that was reachable at startup")
			return
		}

		if err := c.Reload([]byte(req.Kubeconfig)); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"ok":   true,
			"path": c.CfgPath(),
		})
	}
}
