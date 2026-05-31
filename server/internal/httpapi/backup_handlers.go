package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/GameCTL-HQ/GameCTL/server/internal/auth"
	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
	"github.com/GameCTL-HQ/GameCTL/server/internal/tasks"
)

// instanceBackup handles GET /games/instances/{ns}/{name}/backup — the
// per-instance backup policy + spec (supported?, save paths, schedule, …).
func instanceBackup(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		out, err := c.BackupSettingsFor(r.Context(), ns, name)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// setInstanceBackup handles PATCH /games/instances/{ns}/{name}/backup — saves
// the policy annotation and reconciles the CronJob (no pod roll).
func setInstanceBackup(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		var cfg kube.BackupConfig
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := c.SetBackupConfig(r.Context(), ns, name, cfg); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// listInstanceBackups handles GET /games/instances/{ns}/{name}/backups — the
// stored archives at the configured destination, newest first.
func listInstanceBackups(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		out, err := c.ListBackups(r.Context(), ns, name)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		if out == nil {
			out = []kube.BackupArchive{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"backups": out})
	}
}

// backupNow handles POST /games/instances/{ns}/{name}/backup/now — an
// immediate one-off backup, tracked as a task (202 + taskId).
func backupNow(c *kube.Cluster, store *tasks.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		handle := store.Create("backup", "Backup "+name, ns+"/"+name, name, auth.User(r.Context()))
		go func() {
			handle.Start()
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
			defer cancel()
			handle.RegisterCancel(cancel)
			handle.Finish(c.BackupNow(ctx, ns, name, handle))
		}()
		writeJSON(w, http.StatusAccepted, map[string]any{"taskId": handle.ID()})
	}
}

type restoreReq struct {
	Archive string `json:"archive"`
}

// restoreBackup handles POST /games/instances/{ns}/{name}/restore — stops the
// server, extracts the chosen archive over the data volume, starts it again.
// Tracked as a task (202 + taskId).
func restoreBackup(c *kube.Cluster, store *tasks.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		var req restoreReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Archive == "" {
			writeError(w, http.StatusBadRequest, "'archive' is required")
			return
		}
		handle := store.Create("restore", "Restore "+name, ns+"/"+name, name, auth.User(r.Context()))
		go func() {
			handle.Start()
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
			defer cancel()
			handle.RegisterCancel(cancel)
			handle.Finish(c.RestoreBackup(ctx, ns, name, req.Archive, handle))
		}()
		writeJSON(w, http.StatusAccepted, map[string]any{"taskId": handle.ID()})
	}
}
