package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
)

// Shared Steam account credentials, stored as a namespaced Opaque Secret.
// Write-only by design: the password is never returned to the UI — GET
// only reports whether it's configured and the username.

func steamCredsStatus(c *kube.Cluster, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		st, err := c.SteamCredsStatus(r.Context(), cfg.SelfNamespace, cfg.SteamSecretName)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, st)
	}
}

func setSteamCreds(c *kube.Cluster, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		var req struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		req.Username = strings.TrimSpace(req.Username)
		if req.Username == "" || req.Password == "" {
			writeError(w, http.StatusBadRequest, "username and password are both required")
			return
		}
		if err := c.SetSteamCreds(r.Context(), cfg.SelfNamespace, cfg.SteamSecretName, req.Username, req.Password); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "configured": true, "username": req.Username})
	}
}

func clearSteamCreds(c *kube.Cluster, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		if err := c.ClearSteamCreds(r.Context(), cfg.SelfNamespace, cfg.SteamSecretName); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "configured": false})
	}
}
