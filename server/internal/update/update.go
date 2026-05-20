// Package update checks GitHub Releases for a newer GameCTL than the
// running build. It is read-only and best-effort: network failures never
// error out the caller, they just yield "no update info". Results are
// cached so the GitHub API isn't hit on every page load.
package update

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Status is the wire shape returned to the UI.
type Status struct {
	Current         string    `json:"current"`
	Latest          string    `json:"latest"`
	UpdateAvailable bool       `json:"updateAvailable"`
	ReleaseURL      string    `json:"releaseUrl,omitempty"`
	CheckedAt       time.Time `json:"checkedAt"`
	Note            string    `json:"note,omitempty"`
}

// Checker polls a GitHub repo's latest release, with a TTL cache.
type Checker struct {
	repo    string // "owner/name"
	current string
	httpc   *http.Client
	ttl     time.Duration

	mu     sync.Mutex
	cache  Status
	cached time.Time
	ok     bool
}

func NewChecker(repo, current string) *Checker {
	return &Checker{
		repo:    repo,
		current: current,
		httpc:   &http.Client{Timeout: 6 * time.Second},
		ttl:     30 * time.Minute,
	}
}

// norm strips a leading "v" so "v0.0.1-beta" == "0.0.1-beta".
func norm(s string) string { return strings.TrimPrefix(strings.TrimSpace(s), "v") }

// Check returns the cached status if still fresh, otherwise queries GitHub.
// It never returns an error — transient problems are reported via Status.Note
// with UpdateAvailable=false so the UI simply shows nothing.
func (c *Checker) Check(ctx context.Context, force bool) Status {
	c.mu.Lock()
	if !force && c.ok && time.Since(c.cached) < c.ttl {
		s := c.cache
		c.mu.Unlock()
		return s
	}
	c.mu.Unlock()

	s := Status{Current: c.current, CheckedAt: time.Now().UTC()}
	latest, url, err := c.fetchLatest(ctx)
	if err != nil {
		s.Note = "could not check for updates"
		// Cache the soft-failure briefly so we don't hammer GitHub on every
		// request when offline, but retry sooner than a successful result.
		c.mu.Lock()
		c.cache, c.cached, c.ok = s, time.Now().Add(-c.ttl+5*time.Minute), true
		c.mu.Unlock()
		return s
	}
	s.Latest = latest
	s.ReleaseURL = url
	// "dev"/un-stamped builds can't be meaningfully compared — surface the
	// latest as info only, never claim an update is available.
	if c.current != "" && c.current != "dev" && latest != "" && norm(latest) != norm(c.current) {
		s.UpdateAvailable = true
	}
	c.mu.Lock()
	c.cache, c.cached, c.ok = s, time.Now(), true
	c.mu.Unlock()
	return s
}

func (c *Checker) fetchLatest(ctx context.Context) (tag, htmlURL string, err error) {
	if c.repo == "" {
		return "", "", errors.New("no update repo configured")
	}

	// Prefer a published GitHub Release (has notes). Fall back to the most
	// recent git tag when no Release exists yet — the release workflow may
	// have only pushed a tag.
	var rel struct {
		TagName string `json:"tag_name"`
		HTMLURL string `json:"html_url"`
	}
	code, err := c.getJSON(ctx, fmt.Sprintf("https://api.github.com/repos/%s/releases/latest", c.repo), &rel)
	if err == nil && code == http.StatusOK && rel.TagName != "" {
		return rel.TagName, rel.HTMLURL, nil
	}

	var tags []struct {
		Name string `json:"name"`
	}
	code, err = c.getJSON(ctx, fmt.Sprintf("https://api.github.com/repos/%s/tags?per_page=1", c.repo), &tags)
	if err != nil {
		return "", "", err
	}
	if code != http.StatusOK {
		return "", "", fmt.Errorf("github api: HTTP %d", code)
	}
	if len(tags) == 0 || tags[0].Name == "" {
		return "", "", errors.New("no releases or tags found")
	}
	return tags[0].Name, fmt.Sprintf("https://github.com/%s/releases/tag/%s", c.repo, tags[0].Name), nil
}

func (c *Checker) getJSON(ctx context.Context, url string, out any) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "gamectl-update-check")
	resp, err := c.httpc.Do(req)
	if err != nil {
		return 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		return resp.StatusCode, err
	}
	return resp.StatusCode, nil
}
