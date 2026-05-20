package httpapi

import (
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
