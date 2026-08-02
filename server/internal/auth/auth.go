package auth

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"

	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
)

type ctxKey int

const userCtxKey ctxKey = 0

type Authenticator struct {
	jwtSecret []byte

	mu             sync.RWMutex
	users          []userRecord
	setupMode      bool
	bootstrapToken string

	// statsSecret signs GameCTL Stats API tokens. Deliberately a distinct
	// key from jwtSecret (guarded by the same mutex, but verified via a
	// wholly separate jwt.Parse call in StatsMiddleware) — a token signed
	// with one key structurally cannot verify against the other, so a
	// leaked read-only stats token can never be replayed as an admin
	// credential. Nil/empty means the Stats API is disabled.
	statsSecret []byte
}

type userRecord struct {
	Username     string `json:"username"`
	PasswordHash string `json:"password_hash"`
}

func New(cfg *config.Config) (*Authenticator, error) {
	a := &Authenticator{
		jwtSecret:   cfg.JWTSecret,
		statsSecret: cfg.StatsSecret,
	}

	// First-run setup mode: no admin provisioned yet. Generate a one-time
	// bootstrap token (logged by the caller) that gates the setup endpoint
	// against a takeover race. No users are loaded; the only thing that can
	// happen until AdoptInitialAdmin is called is setup itself.
	if cfg.SetupMode {
		if len(a.jwtSecret) < 32 {
			return nil, errors.New("setup mode: ephemeral JWT secret missing or too short")
		}
		tok, err := genBootstrapToken()
		if err != nil {
			return nil, fmt.Errorf("generate bootstrap token: %w", err)
		}
		a.setupMode = true
		a.bootstrapToken = tok
		return a, nil
	}

	// Defense in depth: config.Load already enforces this, but never let an
	// authenticator come up with an empty or short signing secret even if
	// config wiring changes underneath us.
	if len(a.jwtSecret) < 32 {
		return nil, errors.New("refusing to start auth: JWT secret missing or shorter than 32 bytes")
	}

	data, err := os.ReadFile(cfg.UsersFile)
	if err != nil {
		return nil, fmt.Errorf("read users file %q: %w", cfg.UsersFile, err)
	}
	if err := json.Unmarshal(data, &a.users); err != nil {
		return nil, fmt.Errorf("parse users file: %w", err)
	}
	if len(a.users) == 0 {
		return nil, errors.New("users file contains no users")
	}
	for i, u := range a.users {
		if u.Username == "" || u.PasswordHash == "" {
			return nil, fmt.Errorf("users[%d]: username and password_hash required", i)
		}
	}
	return a, nil
}

// Verify returns true if the credentials are valid.
func (a *Authenticator) Verify(username, password string) bool {
	a.mu.RLock()
	users := a.users
	a.mu.RUnlock()
	for _, u := range users {
		if u.Username == username {
			return bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)) == nil
		}
	}
	return false
}

// NeedsSetup reports whether the server is in first-run setup mode (no admin
// configured yet). Safe for concurrent use.
func (a *Authenticator) NeedsSetup() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return a.setupMode
}

// BootstrapToken returns the one-time setup token. Intended only for the
// caller to log at startup; never expose it over the API.
func (a *Authenticator) BootstrapToken() string { return a.bootstrapToken }

// MatchBootstrapToken constant-time compares the supplied token against the
// generated bootstrap token. False if not in setup mode.
func (a *Authenticator) MatchBootstrapToken(tok string) bool {
	a.mu.RLock()
	want, setup := a.bootstrapToken, a.setupMode
	a.mu.RUnlock()
	if !setup || want == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(tok), []byte(want)) == 1
}

// AdoptInitialAdmin installs the first admin in memory and flips the
// authenticator out of setup mode, so the new credentials work immediately
// without a restart. It is single-shot: once setup is complete it returns an
// error. The caller is responsible for persisting the credentials (and the
// JWT secret) to durable storage first.
func (a *Authenticator) AdoptInitialAdmin(username, passwordHash string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if !a.setupMode {
		return errors.New("setup already completed")
	}
	if username == "" || passwordHash == "" {
		return errors.New("username and password hash required")
	}
	a.users = []userRecord{{Username: username, PasswordHash: passwordHash}}
	a.setupMode = false
	a.bootstrapToken = ""
	return nil
}

// HashPassword returns a bcrypt hash (cost 12) suitable for a users.json
// password_hash entry.
func HashPassword(password string) (string, error) {
	h, err := bcrypt.GenerateFromPassword([]byte(password), 12)
	if err != nil {
		return "", err
	}
	return string(h), nil
}

// JWTSecret returns the active JWT signing secret. Used by the setup flow to
// persist the ephemeral secret so issued tokens survive the restart.
func (a *Authenticator) JWTSecret() []byte { return a.jwtSecret }

// genBootstrapToken returns a URL-safe 32-hex-char (16 byte) random token.
func genBootstrapToken() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// IssueToken returns a signed JWT for the given username, valid for 8 hours.
func (a *Authenticator) IssueToken(username string) (string, error) {
	claims := jwt.MapClaims{
		"sub": username,
		"iat": time.Now().Unix(),
		"exp": time.Now().Add(8 * time.Hour).Unix(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return tok.SignedString(a.jwtSecret)
}

func (a *Authenticator) parse(tokenStr string) (string, error) {
	tok, err := jwt.Parse(tokenStr, func(t *jwt.Token) (any, error) {
		if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
		}
		return a.jwtSecret, nil
	})
	if err != nil {
		return "", err
	}
	if !tok.Valid {
		return "", errors.New("invalid token")
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		return "", errors.New("invalid claims")
	}
	sub, _ := claims["sub"].(string)
	if sub == "" {
		return "", errors.New("token has no subject")
	}
	return sub, nil
}

// Middleware enforces a valid Bearer JWT on the request.
func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		sub, err := a.parse(strings.TrimPrefix(h, "Bearer "))
		if err != nil {
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		ctx := context.WithValue(r.Context(), userCtxKey, sub)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// User returns the authenticated username from a request context, or "" if absent.
func User(ctx context.Context) string {
	s, _ := ctx.Value(userCtxKey).(string)
	return s
}

// statsClaims are fixed (no "iat"/"exp") so signing them is deterministic —
// the same statsSecret always produces the same token string. That lets
// StatsToken re-derive and re-display the current token on demand without
// GameCTL having to separately store the token text anywhere.
var statsClaims = jwt.MapClaims{"typ": "stats"}

// StatsEnabled reports whether a Stats API secret is currently loaded —
// i.e. whether GET /api/stats/servers will serve anything.
func (a *Authenticator) StatsEnabled() bool {
	a.mu.RLock()
	defer a.mu.RUnlock()
	return len(a.statsSecret) > 0
}

// EnableStats generates a fresh random signing secret, holds it in memory
// immediately (so the Stats API starts working this request, no restart
// needed), and returns both the secret (for the caller to persist into the
// auth Secret's "stats" key) and the token it signs. Also used for
// "rotate" — calling it again on an already-enabled instance invalidates
// every previously issued token at once, same as re-running JWT secret
// rotation would.
func (a *Authenticator) EnableStats() (secret []byte, token string, err error) {
	raw := make([]byte, 48)
	if _, err := rand.Read(raw); err != nil {
		return nil, "", fmt.Errorf("generate stats secret: %w", err)
	}
	secret = []byte(hex.EncodeToString(raw))

	tok, err := signStats(secret)
	if err != nil {
		return nil, "", err
	}

	a.mu.Lock()
	a.statsSecret = secret
	a.mu.Unlock()
	return secret, tok, nil
}

// DisableStats clears the in-memory secret — GET /api/stats/servers starts
// 404ing immediately. The caller is responsible for also deleting the
// persisted "stats" key (kube.Cluster.DeleteSecretKey) so a future restart
// doesn't silently re-enable it from the old persisted value.
func (a *Authenticator) DisableStats() {
	a.mu.Lock()
	a.statsSecret = nil
	a.mu.Unlock()
}

// StatsToken re-derives and returns the current Stats API token without
// rotating anything — safe to call as often as "show me the token again".
// ok is false when the Stats API isn't enabled.
func (a *Authenticator) StatsToken() (token string, ok bool) {
	a.mu.RLock()
	secret := a.statsSecret
	a.mu.RUnlock()
	if len(secret) == 0 {
		return "", false
	}
	tok, err := signStats(secret)
	if err != nil {
		return "", false
	}
	return tok, true
}

func signStats(secret []byte) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, statsClaims).SignedString(secret)
}

// StatsMiddleware enforces a valid Bearer token signed with the CURRENT
// statsSecret — a wholly separate verification path from Middleware/parse
// above, which only ever checks jwtSecret. A rejected/expired-key stats
// token cannot fall through to admin access, and an admin JWT cannot pass
// this middleware either (different key, and no "typ":"stats" claim). When
// the Stats API hasn't been enabled yet, requests get 404 — from the
// caller's perspective indistinguishable from "no such route", which is the
// right default for an opt-in public surface.
func (a *Authenticator) StatsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.mu.RLock()
		secret := a.statsSecret
		a.mu.RUnlock()
		if len(secret) == 0 {
			http.NotFound(w, r)
			return
		}
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
			return
		}
		tok, err := jwt.Parse(strings.TrimPrefix(h, "Bearer "), func(t *jwt.Token) (any, error) {
			if _, ok := t.Method.(*jwt.SigningMethodHMAC); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return secret, nil
		})
		if err != nil || !tok.Valid {
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		claims, ok := tok.Claims.(jwt.MapClaims)
		if !ok || claims["typ"] != "stats" {
			http.Error(w, `{"error":"invalid token"}`, http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
