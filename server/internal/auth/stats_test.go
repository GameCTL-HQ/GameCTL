package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func okHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
}

func doWithBearer(t *testing.T, h http.Handler, token string) int {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/stats/servers", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec.Code
}

func TestStats_DisabledUntilEnabled(t *testing.T) {
	a, err := New(prodConfig(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if a.StatsEnabled() {
		t.Fatal("StatsEnabled() should be false before EnableStats is ever called")
	}
	if _, ok := a.StatsToken(); ok {
		t.Fatal("StatsToken() should report ok=false before enabling")
	}
	// Even a well-formed request with no token at all hits the same 404 a
	// disabled/nonexistent route would — never a 401 that hints the route
	// exists but auth failed.
	if code := doWithBearer(t, a.StatsMiddleware(okHandler()), "whatever"); code != http.StatusNotFound {
		t.Fatalf("StatsMiddleware while disabled = %d, want 404", code)
	}
}

func TestStats_EnableThenTokenRoundTrips(t *testing.T) {
	a, err := New(prodConfig(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_, tok, err := a.EnableStats()
	if err != nil {
		t.Fatalf("EnableStats: %v", err)
	}
	if !a.StatsEnabled() {
		t.Fatal("StatsEnabled() should be true after EnableStats")
	}
	again, ok := a.StatsToken()
	if !ok {
		t.Fatal("StatsToken() ok=false after enabling")
	}
	if again != tok {
		t.Fatal("StatsToken() should deterministically re-derive the same token EnableStats issued, not mint a new one")
	}
	if code := doWithBearer(t, a.StatsMiddleware(okHandler()), tok); code != http.StatusOK {
		t.Fatalf("StatsMiddleware with a fresh stats token = %d, want 200", code)
	}
}

func TestStats_RotateInvalidatesOldToken(t *testing.T) {
	a, err := New(prodConfig(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_, tok1, err := a.EnableStats()
	if err != nil {
		t.Fatalf("EnableStats (first): %v", err)
	}
	_, tok2, err := a.EnableStats()
	if err != nil {
		t.Fatalf("EnableStats (rotate): %v", err)
	}
	if tok1 == tok2 {
		t.Fatal("rotating (calling EnableStats again) should mint a different secret/token")
	}
	if code := doWithBearer(t, a.StatsMiddleware(okHandler()), tok1); code != http.StatusUnauthorized {
		t.Fatalf("StatsMiddleware with the pre-rotate token = %d, want 401", code)
	}
	if code := doWithBearer(t, a.StatsMiddleware(okHandler()), tok2); code != http.StatusOK {
		t.Fatalf("StatsMiddleware with the post-rotate token = %d, want 200", code)
	}
}

func TestStats_DisableStatsRevokesImmediately(t *testing.T) {
	a, err := New(prodConfig(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	_, tok, err := a.EnableStats()
	if err != nil {
		t.Fatalf("EnableStats: %v", err)
	}
	a.DisableStats()
	if a.StatsEnabled() {
		t.Fatal("StatsEnabled() should be false after DisableStats")
	}
	if code := doWithBearer(t, a.StatsMiddleware(okHandler()), tok); code != http.StatusNotFound {
		t.Fatalf("StatsMiddleware after DisableStats = %d, want 404", code)
	}
}

// The core security property: the admin JWT and the Stats API token are
// signed with different keys and must never be interchangeable, in either
// direction, even though both are Bearer JWTs on the same Authenticator.
func TestStats_AdminAndStatsTokensAreNotInterchangeable(t *testing.T) {
	a, err := New(prodConfig(t))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	adminTok, err := a.IssueToken("admin")
	if err != nil {
		t.Fatalf("IssueToken: %v", err)
	}
	_, statsTok, err := a.EnableStats()
	if err != nil {
		t.Fatalf("EnableStats: %v", err)
	}

	if code := doWithBearer(t, a.StatsMiddleware(okHandler()), adminTok); code != http.StatusUnauthorized {
		t.Fatalf("StatsMiddleware with an admin JWT = %d, want 401 (must not accept admin credentials)", code)
	}
	if code := doWithBearer(t, a.Middleware(okHandler()), statsTok); code != http.StatusUnauthorized {
		t.Fatalf("admin Middleware with a stats token = %d, want 401 (must not grant admin access)", code)
	}
	// Sanity: each token still works against its OWN middleware.
	if code := doWithBearer(t, a.Middleware(okHandler()), adminTok); code != http.StatusOK {
		t.Fatalf("admin Middleware with the admin JWT = %d, want 200", code)
	}
	if code := doWithBearer(t, a.StatsMiddleware(okHandler()), statsTok); code != http.StatusOK {
		t.Fatalf("StatsMiddleware with the stats token = %d, want 200", code)
	}
}
