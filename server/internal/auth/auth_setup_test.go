package auth

import (
	"testing"

	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
)

func setupAuth(t *testing.T) *Authenticator {
	t.Helper()
	a, err := New(&config.Config{
		SetupMode: true,
		JWTSecret: []byte("ephemeral-test-secret-at-least-32-bytes-long"),
	})
	if err != nil {
		t.Fatalf("New in setup mode: %v", err)
	}
	return a
}

func TestSetupMode_StateAndToken(t *testing.T) {
	a := setupAuth(t)
	if !a.NeedsSetup() {
		t.Fatal("expected NeedsSetup true")
	}
	if len(a.BootstrapToken()) != 32 {
		t.Fatalf("expected 32-hex-char bootstrap token, got %q", a.BootstrapToken())
	}
	if a.Verify("anyone", "anything") {
		t.Fatal("no user should verify before setup")
	}
}

func TestSetupMode_BootstrapTokenMatch(t *testing.T) {
	a := setupAuth(t)
	if a.MatchBootstrapToken("wrong") {
		t.Fatal("wrong token must not match")
	}
	if !a.MatchBootstrapToken(a.BootstrapToken()) {
		t.Fatal("correct token must match")
	}
}

func TestAdoptInitialAdmin_FlipsAndIsSingleShot(t *testing.T) {
	a := setupAuth(t)
	hash, err := HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash: %v", err)
	}
	if err := a.AdoptInitialAdmin("admin", hash); err != nil {
		t.Fatalf("AdoptInitialAdmin: %v", err)
	}
	if a.NeedsSetup() {
		t.Fatal("should leave setup mode after adopt")
	}
	if a.BootstrapToken() != "" {
		t.Fatal("bootstrap token must be cleared after adopt")
	}
	if !a.Verify("admin", "correct horse battery staple") {
		t.Fatal("adopted admin should verify")
	}
	if a.Verify("admin", "wrong") {
		t.Fatal("wrong password must not verify")
	}
	if a.MatchBootstrapToken("anything") {
		t.Fatal("bootstrap token must no longer match once setup is complete")
	}
	if err := a.AdoptInitialAdmin("again", hash); err == nil {
		t.Fatal("AdoptInitialAdmin must be single-shot")
	}
	// Token issuance works post-adopt (ephemeral secret is valid).
	if _, err := a.IssueToken("admin"); err != nil {
		t.Fatalf("IssueToken after adopt: %v", err)
	}
}
