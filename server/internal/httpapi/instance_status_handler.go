package httpapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
)

// instanceStatus handles GET /api/games/instances/{namespace}/{name}/status.
// Returns a synthesized status object with everything the UI needs to render
// a status pill, restart badge, address line, and a per-pod details view.
func instanceStatus(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		out, err := c.InstanceStatus(r.Context(), ns, name)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

// instanceEvents handles GET /api/games/instances/{namespace}/{name}/events.
// Deployment conditions + recent related Events so an operator can see why
// a deploy didn't come up (scheduling/volume/image/OOM) in-app.
func instanceEvents(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		out, err := c.InstanceDiagnostics(r.Context(), ns, name)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}
