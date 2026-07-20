package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"strings"
)

type Config struct {
	ListenAddr     string
	KubeconfigPath string
	JWTSecret      []byte
	UsersFile      string
	AllowedOrigins []string
	UIDir          string

	// SetupMode is true when production auth is selected but no admin exists
	// yet (no JWT secret and no users file). The server boots into a
	// restricted first-run mode that serves only the setup endpoint; the
	// JWTSecret above is an ephemeral random value generated for this process
	// and is persisted into the auth Secret once setup completes.
	SetupMode bool

	// AuthSecretName / AuthSecretNamespace identify the Kubernetes Secret
	// that the first-run setup flow writes the persistent `jwt` and
	// `users.json` keys into.
	AuthSecretName      string
	AuthSecretNamespace string

	// StorageSeed is the raw GAMECTL_STORAGE_LOCATIONS env value. At startup
	// each declared location is merged-by-name into the gamectl-storage
	// ConfigMap if absent (never overwrites operator/GUI edits). Format:
	// entries separated by ';', fields k=v separated by ',':
	//   name=1TBSSD,server=10.0.0.100,path=/mnt/1TBSSD[,type=nfs][,suffix=]
	StorageSeed string

	// Self-update: which Deployment to roll when the operator clicks
	// "Update now", and which GitHub repo to check for newer releases.
	// SelfNamespace prefers the downward-API POD_NAMESPACE so it works under
	// a renamed install namespace; both fall back to sane defaults.
	SelfNamespace  string
	SelfDeployment string
	UpdateRepo     string
}

func Load() (*Config, error) {
	cfg := &Config{
		ListenAddr:          getenv("GAMECTL_LISTEN", ":8080"),
		KubeconfigPath:      os.Getenv("GAMECTL_KUBECONFIG"),
		UsersFile:           os.Getenv("GAMECTL_USERS_FILE"),
		UIDir:               os.Getenv("GAMECTL_UI_DIR"),
		StorageSeed:         os.Getenv("GAMECTL_STORAGE_LOCATIONS"),
		AuthSecretName:      getenv("GAMECTL_AUTH_SECRET_NAME", "gamectl-auth"),
		AuthSecretNamespace: getenv("GAMECTL_AUTH_SECRET_NAMESPACE", "gamectl"),
		SelfNamespace:       getenv("POD_NAMESPACE", getenv("GAMECTL_NAMESPACE", "gamectl")),
		SelfDeployment:      getenv("GAMECTL_DEPLOYMENT_NAME", "gamectl"),
		UpdateRepo:          getenv("GAMECTL_UPDATE_REPO", "GameCTL-HQ/GameCTL"),
	}

	if origins := os.Getenv("GAMECTL_ALLOWED_ORIGINS"); origins != "" {
		for _, o := range strings.Split(origins, ",") {
			if o = strings.TrimSpace(o); o != "" {
				cfg.AllowedOrigins = append(cfg.AllowedOrigins, o)
			}
		}
	}

	secret := os.Getenv("GAMECTL_JWT_SECRET")

	// First-run setup mode: production auth is selected but nothing has been
	// provisioned yet (no JWT secret AND no usable users file). Rather than
	// refusing to start — which would make the very first boot unreachable —
	// come up in a restricted setup mode. An ephemeral random JWT secret is
	// generated for this process so the admin can be logged in immediately
	// after setup; the same secret is persisted into the auth Secret when
	// setup completes, so issued tokens survive the subsequent restart.
	if secret == "" && usersFileEmptyOrMissing(cfg.UsersFile) {
		eph, err := genEphemeralSecret()
		if err != nil {
			return nil, fmt.Errorf("generate ephemeral setup secret: %w", err)
		}
		cfg.SetupMode = true
		cfg.JWTSecret = eph
		emitSetupBanner()
		return cfg, nil
	}

	if secret == "" {
		return nil, fmt.Errorf("GAMECTL_JWT_SECRET required " +
			"(set a strong random value of at least 32 bytes, e.g. `openssl rand -base64 64`)")
	}
	if len(secret) < 32 {
		return nil, fmt.Errorf("GAMECTL_JWT_SECRET too short: got %d bytes, need at least 32 "+
			"(generate one with `openssl rand -base64 64`)", len(secret))
	}
	cfg.JWTSecret = []byte(secret)

	if cfg.UsersFile == "" {
		return nil, fmt.Errorf("GAMECTL_USERS_FILE required in production mode " +
			"(path to a JSON file of {username, password_hash} entries; " +
			"generate hashes with `./gamectl hash-password`)")
	}

	return cfg, nil
}

// usersFileEmptyOrMissing reports whether the users file is unset, absent,
// empty, or parses to an empty list — i.e. no admin has been provisioned.
func usersFileEmptyOrMissing(path string) bool {
	if path == "" {
		return true
	}
	data, err := os.ReadFile(path)
	if err != nil {
		// Missing or unreadable: treat as not-yet-provisioned. (A genuinely
		// unreadable-but-present file will surface again in auth.New.)
		return true
	}
	if len(strings.TrimSpace(string(data))) == 0 {
		return true
	}
	var users []json.RawMessage
	if err := json.Unmarshal(data, &users); err != nil {
		// Malformed: not a usable provisioned state. Setup will overwrite it.
		return true
	}
	return len(users) == 0
}

// genEphemeralSecret returns 48 bytes of cryptographically random data,
// base64-encoded (≥32 bytes, well clear of the production minimum).
func genEphemeralSecret() ([]byte, error) {
	raw := make([]byte, 48)
	if _, err := rand.Read(raw); err != nil {
		return nil, err
	}
	return []byte(base64.StdEncoding.EncodeToString(raw)), nil
}

// emitSetupBanner logs an unmissable notice that the server is in first-run
// setup mode and serving only the setup endpoint.
func emitSetupBanner() {
	slog.Warn("################################################################")
	slog.Warn("##  GAMECTL FIRST-RUN SETUP MODE — NO ADMIN CONFIGURED YET    ##")
	slog.Warn("##  Only /api/health and the setup endpoint are served.       ##")
	slog.Warn("##  Open the UI and complete admin setup with the one-time    ##")
	slog.Warn("##  bootstrap token logged below.                             ##")
	slog.Warn("################################################################")
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
