package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
)

// listStorageLocations returns the operator-declared NFS locations.
func listStorageLocations(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		locs, err := c.StorageLocations(r.Context())
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"locations": locs})
	}
}

// setStorageLocations replaces the full location list (validated, persisted
// to the gamectl-storage ConfigMap).
func setStorageLocations(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		var req struct {
			Locations []kube.StorageLocation `json:"locations"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := c.SetStorageLocations(r.Context(), req.Locations); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "locations": req.Locations})
	}
}
