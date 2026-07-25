// promosite is GameCTL's optional bundled "promotion site" — a tiny,
// standalone HTTP server any GameCTL operator can deploy to get a public
// page listing their advertised servers, without writing a frontend of
// their own. It is intentionally NOT part of the gamectl binary: it's a
// separate small image so it can be deployed (or not) independently of the
// Stats API that feeds it, and independently of GameCTL itself.
//
// It holds the Stats API bearer token server-side only — the browser never
// sees it. The page polls this server's own same-origin /api/servers.json,
// which proxies to the real Stats API with the token attached here.
package main

import (
	"encoding/json"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"strconv"
	"sync"
	"time"
)

type config struct {
	statsURL   string
	statsToken string
	title      string
	accent     string
	listenAddr string
	cacheTTL   time.Duration
}

func loadConfig() config {
	cfg := config{
		statsURL:   os.Getenv("STATS_API_URL"),
		statsToken: os.Getenv("STATS_API_TOKEN"),
		title:      getenv("SITE_TITLE", "Game Servers"),
		accent:     getenv("ACCENT_COLOR", "#7c3aed"),
		listenAddr: getenv("LISTEN_ADDR", ":8080"),
	}
	secs, err := strconv.Atoi(getenv("CACHE_SECONDS", "15"))
	if err != nil || secs < 1 {
		secs = 15
	}
	cfg.cacheTTL = time.Duration(secs) * time.Second
	if cfg.statsURL == "" || cfg.statsToken == "" {
		log.Fatal("STATS_API_URL and STATS_API_TOKEN are required")
	}
	return cfg
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// statsCache holds the last successful fetch so a Stats API hiccup shows
// stale-but-present data rather than a blank page.
type statsCache struct {
	mu   sync.Mutex
	at   time.Time
	body []byte
	err  error
}

func (c *statsCache) get(cfg config) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if time.Since(c.at) < cfg.cacheTTL && c.body != nil {
		return c.body, nil
	}
	body, err := fetchStats(cfg)
	if err != nil {
		if c.body != nil {
			// Serve the stale copy; record the error for logging only.
			log.Printf("stats fetch failed, serving stale data: %v", err)
			return c.body, nil
		}
		return nil, err
	}
	c.body, c.at, c.err = body, time.Now(), nil
	return body, nil
}

func fetchStats(cfg config) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, cfg.statsURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.statsToken)
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		return nil, &httpStatusError{resp.StatusCode}
	}
	return body, nil
}

type httpStatusError struct{ code int }

func (e *httpStatusError) Error() string {
	return "stats API returned HTTP " + strconv.Itoa(e.code)
}

var pageTmpl = template.Must(template.New("page").Parse(pageHTML))

type pageData struct {
	Title  string
	Accent string
}

func main() {
	cfg := loadConfig()
	cache := &statsCache{}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	// Same-origin JSON the page's JS polls — the Stats API token never
	// reaches the browser, only this server ever sends it.
	mux.HandleFunc("GET /api/servers.json", func(w http.ResponseWriter, r *http.Request) {
		body, err := cache.get(cfg)
		if err != nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusBadGateway)
			json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(body)
	})

	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		pageTmpl.Execute(w, pageData{Title: cfg.title, Accent: cfg.accent})
	})

	log.Printf("promosite listening on %s — title=%q stats=%s", cfg.listenAddr, cfg.title, cfg.statsURL)
	log.Fatal(http.ListenAndServe(cfg.listenAddr, mux))
}
