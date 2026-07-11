package config

import "testing"

func clearEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"GAMECTL_LISTEN", "GAMECTL_KUBECONFIG", "GAMECTL_USERS_FILE",
		"GAMECTL_UI_DIR", "GAMECTL_ALLOWED_ORIGINS", "GAMECTL_JWT_SECRET",
	} {
		t.Setenv(k, "")
	}
}

func TestLoad_NoSecretNoUsersEntersSetupMode(t *testing.T) {
	clearEnv(t)
	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected error: no secret + no users file should enter setup mode, got: %v", err)
	}
	if !cfg.SetupMode {
		t.Fatal("expected SetupMode=true when nothing is provisioned")
	}
	if len(cfg.JWTSecret) < 32 {
		t.Fatalf("setup mode must generate an ephemeral secret >= 32 bytes, got %d", len(cfg.JWTSecret))
	}
}

func TestLoad_SecretWithoutUsersFileStillErrors(t *testing.T) {
	clearEnv(t)
	// One half provided (secret) but users file absent: not setup mode,
	// must fail fast rather than silently degrade.
	t.Setenv("GAMECTL_JWT_SECRET", "this-is-a-sufficiently-long-secret-value-xx")
	if _, err := Load(); err == nil {
		t.Fatal("expected error: JWT secret set but users file unset")
	}
}

func TestLoad_ProdRejectsShortSecret(t *testing.T) {
	clearEnv(t)
	t.Setenv("GAMECTL_JWT_SECRET", "tooshort")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for short JWT secret")
	}
}

func TestLoad_ProdRequiresUsersFile(t *testing.T) {
	clearEnv(t)
	t.Setenv("GAMECTL_JWT_SECRET", "this-is-a-sufficiently-long-secret-value-xx")
	if _, err := Load(); err == nil {
		t.Fatal("expected error when GAMECTL_USERS_FILE unset in prod mode")
	}
}

func TestLoad_ProdHappy(t *testing.T) {
	clearEnv(t)
	t.Setenv("GAMECTL_JWT_SECRET", "this-is-a-sufficiently-long-secret-value-xx")
	t.Setenv("GAMECTL_USERS_FILE", "/etc/gamectl/users.json")
	if _, err := Load(); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
