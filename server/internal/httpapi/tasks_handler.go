package httpapi

import (
	"context"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/GameCTL-HQ/GameCTL/server/internal/tasks"
)

// listTasks: GET /api/tasks?game=<id>&limit=<n>
// Returns the most recent tasks newest-first. UI polls this for the
// header dropdown.
func listTasks(store *tasks.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		game := r.URL.Query().Get("game")
		limit := 50
		if s := r.URL.Query().Get("limit"); s != "" {
			if n, err := strconv.Atoi(s); err == nil && n > 0 && n <= 500 {
				limit = n
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"tasks": store.List(game, limit),
		})
	}
}

// getTask: GET /api/tasks/{id}
// Returns a single task with all its phases. UI polls this for the
// detail modal.
func getTask(store *tasks.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		t, ok := store.Get(id)
		if !ok {
			writeError(w, http.StatusNotFound, "task not found")
			return
		}
		writeJSON(w, http.StatusOK, t)
	}
}

// cancelTask: POST /api/tasks/{id}/cancel
// Stops a still-running apply/delete. The worker's context is
// cancelled; the in-flight kube call aborts and the task settles into
// the "cancelled" state. 409 if the task is already finished (nothing
// to stop) or unknown.
func cancelTask(store *tasks.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if !store.Cancel(id) {
			writeError(w, http.StatusConflict, "task is not running (already finished or unknown)")
			return
		}
		writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "cancelling": id})
	}
}

// rerunTask: POST /api/tasks/{id}/rerun
// Creates a brand-new task with the same payload (manifests / etc.) as
// the source task and kicks it off in the background. Returns the new
// {taskId}. Used by the UI's "Re-run" button on failed/cancelled tasks
// so an operator doesn't have to redo the deploy wizard after a
// transient NFS or kube hiccup.
//
// Only "apply"-kind tasks are rerunnable right now (delete / backup /
// restore would need their own payload typing). Returns 409 if the
// task is unknown, isn't rerunnable, or is currently running (let it
// finish first — the operator's intent is probably "stop, fix, retry"
// not "queue another concurrent run").
func rerunTask(c rerunDeps, store *tasks.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		payload, src, ok := store.RerunPayload(id)
		if !ok {
			writeError(w, http.StatusConflict, "task is not re-runnable (no payload stored or unknown id)")
			return
		}
		if src.Status == tasks.StatusRunning || src.Status == tasks.StatusPending {
			writeError(w, http.StatusConflict, "task is still running — stop or wait for it before re-running")
			return
		}
		switch src.Kind {
		case "apply":
			docs, _ := payload.([]map[string]any)
			if len(docs) == 0 {
				writeError(w, http.StatusInternalServerError, "stored payload is empty or wrong type")
				return
			}
			title := src.Title
			if title != "" && !hasReRunPrefix(title) {
				title = "Re-run: " + title
			}
			handle := store.Create("apply", title, src.Subject, src.GameID, src.StartedBy)
			store.SetRerunPayload(handle.ID(), docs)
			go c.RunApply(handle, docs)
			writeJSON(w, http.StatusAccepted, map[string]any{"taskId": handle.ID(), "source": id})
		default:
			writeError(w, http.StatusBadRequest, "only apply-kind tasks are currently re-runnable")
		}
	}
}

// rerunDeps is the slice of the apply handler's worker-starting capability
// that rerun needs — declared here so the routes wiring can pass a thin
// adapter without rerun reaching into apply_handler internals.
type rerunDeps interface {
	RunApply(handle ApplyHandle, docs []map[string]any)
}

// ApplyHandle is the subset of *tasks.Handle the apply worker needs. Mirror
// of the interface declared inline in runApplyTask so rerunDeps can stay
// typed.
type ApplyHandle interface {
	ID() string
	Start()
	RegisterCancel(cancel context.CancelFunc)
	BeginPhase(name, detail string) int
	EndPhase(idx int, err error)
	EndPhaseDetail(idx int, err error, detail string)
	Finish(err error)
}

// hasReRunPrefix reports whether a task title already starts with the
// "Re-run:" tag (idempotent — re-running a re-run shouldn't keep stacking
// the prefix).
func hasReRunPrefix(s string) bool {
	const p = "Re-run:"
	if len(s) < len(p) {
		return false
	}
	return s[:len(p)] == p
}
