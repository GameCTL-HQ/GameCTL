package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/GameCTL-HQ/GameCTL/server/internal/auth"
	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
)

// GameCTL Stats API — admin-managed opt-in, public read surface.
//
// Three admin (JWT-gated) endpoints manage the feature itself:
//
//	GET    /api/stats/token   — current status + the token again (no rotation)
//	POST   /api/stats/token   — enable (first call) or rotate (subsequent calls)
//	DELETE /api/stats/token   — revoke; invalidates every outstanding token
//
// One public (stats-token-gated) endpoint serves the data:
//
//	GET /api/stats/servers
//
// See server/internal/auth/auth.go (EnableStats/StatsToken/DisableStats/
// StatsMiddleware) and server/internal/kube/stats.go (AdvertisedStats) for
// the mechanics; this file is just the HTTP plumbing.

// statsTokenStatus is the wire shape for GET/POST /api/stats/token.
type statsTokenStatus struct {
	Enabled bool   `json:"enabled"`
	Token   string `json:"token,omitempty"`
}

func statsTokenGet(authn *auth.Authenticator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok, ok := authn.StatsToken()
		writeJSON(w, http.StatusOK, statsTokenStatus{Enabled: ok, Token: tok})
	}
}

// statsTokenIssue enables the Stats API (first call) or rotates its secret
// (subsequent calls — invalidates every previously issued token). Persists
// the new secret into the auth Secret BEFORE the response is sent, same
// persist-before-adopt ordering setupHandler uses, so a write failure never
// leaves the operator holding a token that won't survive a restart.
func statsTokenIssue(authn *auth.Authenticator, cluster *kube.Cluster, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		secret, tok, err := authn.EnableStats()
		if err != nil {
			writeError(w, http.StatusInternalServerError, err.Error())
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		if err := cluster.WriteSecret(ctx, cfg.AuthSecretNamespace, cfg.AuthSecretName, map[string][]byte{
			"stats": secret,
		}); err != nil {
			// In-memory is already live (requests work this session) but
			// won't survive a restart — surface that plainly rather than
			// claim full success.
			writeError(w, http.StatusInternalServerError, "token issued but failed to persist (will not survive a restart): "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, statsTokenStatus{Enabled: true, Token: tok})
	}
}

func statsTokenRevoke(authn *auth.Authenticator, cluster *kube.Cluster, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authn.DisableStats()
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		if err := cluster.DeleteSecretKey(ctx, cfg.AuthSecretNamespace, cfg.AuthSecretName, "stats"); err != nil {
			writeError(w, http.StatusInternalServerError, "disabled, but failed to remove the persisted key: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// statsServers is the public GET /api/stats/servers handler — gated by
// auth.Authenticator.StatsMiddleware, not the admin JWT Middleware.
func statsServers(cluster *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, cluster) {
			return
		}
		servers, err := cluster.AdvertisedStats(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"servers": servers})
	}
}

// advertiseReq is the wire shape for PATCH .../advertise.
type advertiseReq struct {
	Enabled     bool   `json:"enabled"`
	DisplayName string `json:"displayName,omitempty"`
	Slug        string `json:"slug,omitempty"`
}

func setAdvertise(cluster *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, cluster) {
			return
		}
		ns, name := chi.URLParam(r, "namespace"), chi.URLParam(r, "name")
		var req advertiseReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := cluster.SetAdvertise(r.Context(), ns, name, req.Enabled, req.DisplayName, req.Slug); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}
