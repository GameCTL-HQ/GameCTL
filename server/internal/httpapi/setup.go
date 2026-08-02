package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/GameCTL-HQ/GameCTL/server/internal/auth"
	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
)

// minPasswordLen is the floor for the first admin password. Deliberately
// modest — this gates a single-operator homelab tool, not a public SaaS — but
// enough to discourage trivial passwords.
const minPasswordLen = 8

// authState reports whether first-run setup is required, so the UI can show
// the right screen. Public (pre-auth).
func authState(authn *auth.Authenticator) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"needsSetup": authn.NeedsSetup(),
		})
	}
}

type setupReq struct {
	BootstrapToken string `json:"bootstrapToken"`
	Username       string `json:"username"`
	Password       string `json:"password"`
}

// setupHandler completes first-run admin provisioning. Public (pre-auth) but
// gated by the one-time bootstrap token logged at startup. It persists the
// JWT secret + bcrypt users file into the auth Secret, then adopts the
// credentials in-memory so the operator is logged in immediately with no
// restart. Disabled (409) once an admin exists.
func setupHandler(authn *auth.Authenticator, cluster *kube.Cluster, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !authn.NeedsSetup() {
			writeError(w, http.StatusConflict, "setup already completed")
			return
		}

		var req setupReq
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		req.Username = strings.TrimSpace(req.Username)

		if !authn.MatchBootstrapToken(strings.TrimSpace(req.BootstrapToken)) {
			writeError(w, http.StatusUnauthorized, "invalid bootstrap token")
			return
		}
		if req.Username == "" {
			writeError(w, http.StatusBadRequest, "username required")
			return
		}
		if len(req.Password) < minPasswordLen {
			writeError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}

		hash, err := auth.HashPassword(req.Password)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to hash password")
			return
		}

		usersJSON, err := json.Marshal([]map[string]string{
			{"username": req.Username, "password_hash": hash},
		})
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to encode users")
			return
		}

		// Persist BEFORE adopting in-memory, so a write failure leaves the
		// server still in setup mode (retryable) rather than a state where
		// the running process accepts a login that won't survive a restart.
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		err = cluster.WriteSecret(ctx, cfg.AuthSecretNamespace, cfg.AuthSecretName, map[string][]byte{
			"jwt":        authn.JWTSecret(),
			"users.json": usersJSON,
		})
		if err != nil {
			if errors.Is(err, kube.ErrNotConfigured) {
				writeError(w, http.StatusServiceUnavailable, "kubernetes not configured")
				return
			}
			writeError(w, http.StatusInternalServerError, "failed to persist credentials: "+err.Error())
			return
		}

		if err := authn.AdoptInitialAdmin(req.Username, hash); err != nil {
			// Lost a setup race (another request completed first).
			writeError(w, http.StatusConflict, err.Error())
			return
		}

		tok, err := authn.IssueToken(req.Username)
		if err != nil {
			// Credentials are persisted and live; the operator can just log
			// in normally. Report success without an auto-login token.
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":           true,
			"access_token": tok,
			"token_type":   "bearer",
		})
	}
}
