package httpapi

import (
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
)

// kubeRequired returns nil if the cluster is configured, otherwise writes a 503 response
// matching the Python service ("Kubernetes client not configured ...") and returns false.
func kubeRequired(w http.ResponseWriter, c *kube.Cluster) bool {
	if c == nil {
		writeError(w, http.StatusServiceUnavailable,
			"Kubernetes client not configured. Provide GAMECTL_KUBECONFIG, run in-cluster, or upload a kubeconfig.")
		return false
	}
	return true
}

func listNamespaces(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		out, err := c.Namespaces(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func listPods(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := r.URL.Query().Get("namespace")
		out, err := c.Pods(r.Context(), ns)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func listInstances(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		sel := r.URL.Query().Get("label_selector")
		out, err := c.Instances(r.Context(), sel)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func listInstancePods(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		out, err := c.InstancePods(r.Context(), ns, name)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}

func instanceLogs(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")

		tail := int64(100)
		if v := r.URL.Query().Get("tail"); v != "" {
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil || n < 1 {
				writeError(w, http.StatusBadRequest, "tail must be a positive integer")
				return
			}
			if n > 500 {
				n = 500
			}
			tail = n
		}

		logs, pod, err := c.InstanceLogs(r.Context(), ns, name, tail)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		// Match Python shape: {"logs": "...", "pod": "<name>" | null}
		body := map[string]any{"logs": logs}
		if pod == "" {
			body["pod"] = nil
		} else {
			body["pod"] = pod
		}
		writeJSON(w, http.StatusOK, body)
	}
}
