package auth

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
)

// bcrypt hash of "s3cret" (cost 10).
const testHash = "$2a$10$i7INl2ffaIo4dHA8ZNDzZefbLVNynPBDNm5z3YkXdg20/OqKnYnuW"

// writeUsersFile creates a one-user users.json and returns a valid
// production config pointing at it.
func prodConfig(t *testing.T) *config.Config {
	t.Helper()
	p := filepath.Join(t.TempDir(), "users.json")
	if err := os.WriteFile(p, []byte(`[{"username":"admin","password_hash":"`+testHash+`"}]`), 0o600); err != nil {
		t.Fatal(err)
	}
	return &config.Config{
		JWTSecret: []byte("this-is-a-sufficiently-long-secret-value-xx"),
		UsersFile: p,
	}
}

func TestNew_ProdRejectsShortSecret(t *testing.T) {
	if _, err := New(&config.Config{JWTSecret: []byte("tooshort")}); err == nil {
		t.Fatal("expected error: auth with short JWT secret")
	}
}

func TestNew_ProdRejectsMissingUsersFile(t *testing.T) {
	cfg := &config.Config{
		JWTSecret: []byte("this-is-a-sufficiently-long-secret-value-xx"),
		UsersFile: "/definitely/does/not/exist/users.json",
	}
	if _, err := New(cfg); err == nil {
		t.Fatal("expected error: auth with unreadable users file")
	}
}

func TestNew_ProdRejectsEmptyUsersFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "users.json")
	if err := os.WriteFile(p, []byte("[]"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := &config.Config{
		JWTSecret: []byte("this-is-a-sufficiently-long-secret-value-xx"),
		UsersFile: p,
	}
	if _, err := New(cfg); err == nil {
		t.Fatal("expected error: auth with zero users")
	}
}

func TestNew_ProdHappyAndVerify(t *testing.T) {
	a, err := New(prodConfig(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !a.Verify("admin", "s3cret") {
		t.Fatal("expected valid credentials to verify")
	}
	if a.Verify("admin", "wrong") {
		t.Fatal("expected wrong password to be rejected")
	}
	if a.Verify("admin", "admin") {
		t.Fatal("must NOT accept hardcoded admin/admin")
	}
}

func TestIssueAndParseTokenRoundTrip(t *testing.T) {
	a, err := New(prodConfig(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	tok, err := a.IssueToken("admin")
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	sub, err := a.parse(tok)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if sub != "admin" {
		t.Fatalf("subject = %q, want admin", sub)
	}
}
