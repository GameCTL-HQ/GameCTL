// Package proxyctl is a minimal REST client for a sibling ProxyCTL install
// (https://proxyctl.cc). GameCTL uses it to publish game servers on the
// public internet: it creates/updates ProxyCTL L4 entries (droplet port →
// WireGuard tunnel → game Service ClusterIP) and triggers Apply, so the
// operator associates a public DNS name with an instance without leaving
// GameCTL.
//
// Auth matches ProxyCTL's operator flow: POST /api/token with the stored
// username/password → 8h bearer JWT, cached and re-issued on 401. ProxyCTL
// has no service-account tokens, so the link is a normal operator login.
package proxyctl

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// DefaultBaseURL is where the stock ProxyCTL manifest lands: Service
// "proxyctl" in namespace "proxyctl", port 80. Operators who installed
// elsewhere override the URL when linking.
const DefaultBaseURL = "http://proxyctl.proxyctl.svc"

// PortSpec mirrors ProxyCTL's public-port shape. Proto is "tcp", "udp",
// or "both".
type PortSpec struct {
	Port  int    `json:"port"`
	Proto string `json:"proto"`
}

// Entry mirrors ProxyCTL's L4 game entry (store.go). Subdomain carries the
// full public DNS name ("valheim.example.com"); TargetIP is the game
// Service's ClusterIP; Service is the "name.namespace" label ProxyCTL uses
// for drift detection and rebinding.
type Entry struct {
	ID        string     `json:"id,omitempty"`
	Name      string     `json:"name"`
	Subdomain string     `json:"subdomain"`
	Ports     []PortSpec `json:"ports"`
	TargetIP  string     `json:"targetIP"`
	Service   string     `json:"service,omitempty"`
	Enabled   bool       `json:"enabled"`

	// Egress mode ("mode":"egress"): the WireGuard peer is a sidecar GameCTL
	// injects into the game pod, and the droplet SNATs the game's outbound
	// traffic so matchmaking backends (PlayFab, master servers) record the
	// droplet IP. TunnelIP is allocated by ProxyCTL; GatewayPubKey is the
	// PUBLIC half of the keypair GameCTL generates for the sidecar (the
	// private key stays in a GameCTL-namespace Secret — ProxyCTL never sees
	// it, same trust model as its self-keying gateways).
	Mode          string `json:"mode,omitempty"`
	TunnelIP      string `json:"tunnelIP,omitempty"`
	GatewayPubKey string `json:"gatewayPubKey,omitempty"`
}

// Drift is ProxyCTL's live-ClusterIP check for an entry with a Service
// label: Mismatch means the entry's TargetIP no longer matches the live
// Service (or the Service is gone when !Found).
type Drift struct {
	Live     string `json:"live"`
	Found    bool   `json:"found"`
	Mismatch bool   `json:"mismatch"`
}

// EntryRow is one row of GET /api/entries.
type EntryRow struct {
	Entry Entry  `json:"entry"`
	Drift *Drift `json:"drift,omitempty"`
}

// Droplet is the subset of GET /api/droplet GameCTL surfaces (the public
// IP players' DNS records point at, and whether the tunnel endpoint is
// set up at all).
type Droplet struct {
	Configured bool   `json:"configured"`
	IP         string `json:"ip"`
	// WireGuard peer info for egress-mode sidecars (public data only).
	WGPublicKey  string `json:"wgPublicKey"`
	WGEndpointIP string `json:"wgEndpointIP"`
	WGPort       int    `json:"wgPort"`
}

// Detect reports whether something answering like ProxyCTL is reachable at
// baseURL (GET /healthz, no auth). Short timeout — it runs on page loads.
func Detect(ctx context.Context, baseURL string) bool {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(baseURL, "/")+"/healthz", nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	return resp.StatusCode == http.StatusOK
}

// Client is a logged-in ProxyCTL API client. Safe for concurrent use.
type Client struct {
	baseURL  string
	username string
	password string
	hc       *http.Client

	mu       sync.Mutex
	token    string
	tokenExp time.Time
}

// New returns a client for the ProxyCTL at baseURL (empty → DefaultBaseURL).
func New(baseURL, username, password string) *Client {
	if strings.TrimSpace(baseURL) == "" {
		baseURL = DefaultBaseURL
	}
	return &Client{
		baseURL:  strings.TrimRight(baseURL, "/"),
		username: username,
		password: password,
		// 120s: most calls return in ms, but TunnelSetup's first run
		// creates the CF tunnel + deploys cloudflared (up to ~100s on
		// ProxyCTL's side).
		hc: &http.Client{Timeout: 120 * time.Second},
	}
}

// BaseURL returns the URL this client talks to.
func (c *Client) BaseURL() string { return c.baseURL }

// Login verifies the credentials by issuing a token (also priming the
// cache). Used by the "Save & test" link flow.
func (c *Client) Login(ctx context.Context) error {
	_, err := c.ensureToken(ctx, true)
	return err
}

func (c *Client) ensureToken(ctx context.Context, force bool) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !force && c.token != "" && time.Now().Before(c.tokenExp) {
		return c.token, nil
	}
	body, _ := json.Marshal(map[string]string{"username": c.username, "password": c.password})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+"/api/token", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.hc.Do(req)
	if err != nil {
		return "", fmt.Errorf("proxyctl login: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("proxyctl login: %s", apiError(resp.StatusCode, raw))
	}
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.Unmarshal(raw, &out); err != nil || out.AccessToken == "" {
		return "", fmt.Errorf("proxyctl login: unexpected response")
	}
	c.token = out.AccessToken
	// JWTs are valid 8h; refresh well before that.
	c.tokenExp = time.Now().Add(7 * time.Hour)
	return c.token, nil
}

// do performs an authenticated request, re-logging-in once on 401 (expired
// or invalidated token). body may be nil; out may be nil to discard.
func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	attempt := func(force bool) (int, []byte, error) {
		tok, err := c.ensureToken(ctx, force)
		if err != nil {
			return 0, nil, err
		}
		var rd io.Reader
		if body != nil {
			b, err := json.Marshal(body)
			if err != nil {
				return 0, nil, err
			}
			rd = bytes.NewReader(b)
		}
		req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, rd)
		if err != nil {
			return 0, nil, err
		}
		req.Header.Set("Authorization", "Bearer "+tok)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := c.hc.Do(req)
		if err != nil {
			return 0, nil, fmt.Errorf("proxyctl %s %s: %w", method, path, err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		return resp.StatusCode, raw, nil
	}

	status, raw, err := attempt(false)
	if err != nil {
		return err
	}
	if status == http.StatusUnauthorized {
		if status, raw, err = attempt(true); err != nil {
			return err
		}
	}
	if status < 200 || status > 299 {
		return fmt.Errorf("proxyctl %s %s: %s", method, path, apiError(status, raw))
	}
	if out != nil {
		if err := json.Unmarshal(raw, out); err != nil {
			return fmt.Errorf("proxyctl %s %s: parse response: %w", method, path, err)
		}
	}
	return nil
}

// apiError extracts ProxyCTL's {"error": "..."} message, falling back to
// the HTTP status.
func apiError(status int, raw []byte) string {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &e) == nil {
		if e.Error != "" {
			return e.Error
		}
		if e.Message != "" {
			return e.Message
		}
	}
	return http.StatusText(status)
}

// Entries lists all L4 entries (with per-entry drift when ProxyCTL can
// resolve the Service label).
func (c *Client) Entries(ctx context.Context) ([]EntryRow, error) {
	var out struct {
		Entries []EntryRow `json:"entries"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/entries", nil, &out); err != nil {
		return nil, err
	}
	return out.Entries, nil
}

// CreateEntry adds a new entry (saved, not applied — call Apply after).
func (c *Client) CreateEntry(ctx context.Context, e Entry) (Entry, error) {
	var out struct {
		Entry Entry `json:"entry"`
	}
	err := c.do(ctx, http.MethodPost, "/api/entries", e, &out)
	return out.Entry, err
}

// UpdateEntry replaces the entry with ID e.ID.
func (c *Client) UpdateEntry(ctx context.Context, e Entry) (Entry, error) {
	var out struct {
		Entry Entry `json:"entry"`
	}
	err := c.do(ctx, http.MethodPut, "/api/entries/"+url.PathEscape(e.ID), e, &out)
	return out.Entry, err
}

// DeleteEntry removes an entry; removeDNS=true also deletes the Cloudflare
// A record (ProxyCTL's explicit ?cf=1 opt-in). Returns ProxyCTL's DNS
// outcome message ("" when no DNS action was requested/possible).
func (c *Client) DeleteEntry(ctx context.Context, id string, removeDNS bool) (string, error) {
	path := "/api/entries/" + url.PathEscape(id)
	if removeDNS {
		path += "?cf=1"
	}
	var out struct {
		DNS string `json:"dns"`
	}
	err := c.do(ctx, http.MethodDelete, path, nil, &out)
	return out.DNS, err
}

// Apply kicks off ProxyCTL's background apply (droplet iptables + gateway
// pods + DNS upserts). alreadyRunning=true means an apply was in flight —
// the pending change rides the next one the operator triggers.
func (c *Client) Apply(ctx context.Context) (alreadyRunning bool, err error) {
	err = c.do(ctx, http.MethodPost, "/api/apply", map[string]any{}, nil)
	if err != nil && strings.Contains(err.Error(), "already in progress") {
		return true, nil
	}
	return false, err
}

// Domains returns the merged base-domain list (Cloudflare zones + manually
// declared) that public names are composed from.
func (c *Client) Domains(ctx context.Context) ([]string, error) {
	var out struct {
		Domains []string `json:"domains"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/domains", nil, &out); err != nil {
		return nil, err
	}
	return out.Domains, nil
}

// Droplet returns the tunnel endpoint's public state.
func (c *Client) Droplet(ctx context.Context) (Droplet, error) {
	var out Droplet
	err := c.do(ctx, http.MethodGet, "/api/droplet", nil, &out)
	return out, err
}

// WebRoute mirrors ProxyCTL's L7 route: one public hostname exposed through
// its Cloudflare Tunnel (cloudflared in-cluster → CF edge, TLS + WAF at the
// edge) forwarding to an in-cluster Service. This is the right plane for an
// instance's HTTP companions — BlueMap, the CS2 surf-records site — while
// raw game ports use L4 Entries.
type WebRoute struct {
	ID        string `json:"id,omitempty"`
	Hostname  string `json:"hostname"`
	Namespace string `json:"namespace"`
	Service   string `json:"service"`
	Port      int    `json:"port"`
	Enabled   bool   `json:"enabled"`
}

// WebRoutes lists the L7 routes; cfConfigured reports whether ProxyCTL has
// a Cloudflare API token (without one, web routes can't be applied).
func (c *Client) WebRoutes(ctx context.Context) (routes []WebRoute, cfConfigured bool, err error) {
	var out struct {
		Routes       []WebRoute `json:"routes"`
		CFConfigured bool       `json:"cfConfigured"`
	}
	err = c.do(ctx, http.MethodGet, "/api/webroutes", nil, &out)
	return out.Routes, out.CFConfigured, err
}

// CreateWebRoute adds a route (saved, not applied — call TunnelSetup).
func (c *Client) CreateWebRoute(ctx context.Context, wr WebRoute) (WebRoute, error) {
	var out struct {
		Route WebRoute `json:"route"`
	}
	err := c.do(ctx, http.MethodPost, "/api/webroutes", wr, &out)
	return out.Route, err
}

// UpdateWebRoute replaces the route with ID wr.ID.
func (c *Client) UpdateWebRoute(ctx context.Context, wr WebRoute) (WebRoute, error) {
	var out struct {
		Route WebRoute `json:"route"`
	}
	err := c.do(ctx, http.MethodPut, "/api/webroutes/"+url.PathEscape(wr.ID), wr, &out)
	return out.Route, err
}

// DeleteWebRoute removes a route (call TunnelSetup after to push the
// reduced ingress rules).
func (c *Client) DeleteWebRoute(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/api/webroutes/"+url.PathEscape(id), nil, nil)
}

// TunnelSetup reconciles the Cloudflare Tunnel to the current route list:
// ensures the tunnel + in-cluster cloudflared connector, pushes ingress
// rules, and upserts the proxied CNAME per hostname. Idempotent; the first
// run (tunnel creation) can take a while.
func (c *Client) TunnelSetup(ctx context.Context) error {
	var out struct {
		OK    bool `json:"ok"`
		Steps []struct {
			Name   string `json:"name"`
			OK     bool   `json:"ok"`
			Stderr string `json:"stderr"`
		} `json:"steps"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/tunnel/setup", map[string]any{}, &out); err != nil {
		return err
	}
	if !out.OK {
		for _, s := range out.Steps {
			if !s.OK {
				msg := s.Stderr
				if msg == "" {
					msg = "failed"
				}
				return fmt.Errorf("tunnel setup: %s: %s", s.Name, msg)
			}
		}
		return fmt.Errorf("tunnel setup failed")
	}
	return nil
}
