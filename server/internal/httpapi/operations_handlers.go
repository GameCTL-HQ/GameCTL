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
	Mode          string `json:"mode"`
	BotDifficulty *int   `json:"botDifficulty"`
	MaxPlayers    *int   `json:"maxPlayers"`
}

// applyCS2Config handles POST /games/instances/{ns}/{name}/cs2config —
// live (RCON, no restart) game-mode / bot / player-cap change for cs2.
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
		diff := 2
		if req.BotDifficulty != nil {
			diff = *req.BotDifficulty
		}
		maxp := 0
		if req.MaxPlayers != nil {
			maxp = *req.MaxPlayers
		}
		out, err := c.ApplyCS2Live(r.Context(), ns, name, req.Mode, diff, maxp)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "output": out})
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
