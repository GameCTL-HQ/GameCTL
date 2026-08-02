package games

import (
	"context"
	"crypto/tls"
	"fmt"
	"net/http"
	"time"
)

// HTTP-GET probe for web-app-style game servers (Satisfactory has a REST
// API on a separate port; many web admin panels). Returns reachable=true
// when the GET returns 2xx or 3xx — anything else gets logged as a probe
// error. Doesn't try to parse content; that's the job of a more specific
// probe.
//
// For games that need probe-via-https/-via-http or a non-root path,
// register a closure per-game with the path baked in.

// (Satisfactory's API path varies by image — the HTTPS probe at /api/v1/
// returned 404 against the current dedicated-server container. Until we
// have a path that works reliably, register it as TCP-only via tcp.go.)

// probeHTTP returns a Prober that does GET <scheme>://<addr><path> with TLS
// verification optionally disabled (use for self-signed servers).
func probeHTTP(scheme, path string, insecure bool) Prober {
	return func(ctx context.Context, addr string, timeout time.Duration) (*Health, error) {
		tr := &http.Transport{
			TLSClientConfig:   &tls.Config{InsecureSkipVerify: insecure},
			DisableKeepAlives: true,
		}
		client := &http.Client{Timeout: timeout, Transport: tr}
		url := fmt.Sprintf("%s://%s%s", scheme, addr, path)
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			return nil, err
		}
		start := time.Now()
		resp, err := client.Do(req)
		latency := time.Since(start).Milliseconds()
		if err != nil {
			return nil, fmt.Errorf("get %s: %w", url, err)
		}
		defer resp.Body.Close()
		ok := resp.StatusCode < 400
		return &Health{
			Type:      "http",
			Reachable: ok,
			LatencyMS: latency,
			Error: func() string {
				if !ok {
					return fmt.Sprintf("status %d", resp.StatusCode)
				}
				return ""
			}(),
		}, nil
	}
}
