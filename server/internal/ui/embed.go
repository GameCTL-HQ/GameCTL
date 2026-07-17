// Package ui serves the React frontend.
//
// In production the UI is compiled into the Go binary via //go:embed. In
// development, set GAMECTL_UI_DIR=/path/to/kubeUI/dist to serve from disk
// instead — useful when iterating on the frontend without rebuilding the
// Go binary.
package ui

import (
	"embed"
	"errors"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// distFS embeds the built React bundle from internal/ui/dist/.
// The dist/ directory is populated by the Makefile / Dockerfile from the
// kubeUI build output; a placeholder .gitkeep ensures this compiles even
// before the UI has been built (in which case "/" serves a 404).
//
//go:embed all:dist
var distFS embed.FS

// Handler returns an http.Handler serving the SPA. If diskDir is non-empty,
// files are served from that directory instead of the embedded FS — useful
// for frontend dev loops.
func Handler(diskDir string) http.Handler {
	if diskDir != "" {
		return spaHandler(http.Dir(diskDir))
	}
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "UI not embedded in this build", http.StatusNotImplemented)
		})
	}
	return spaHandler(http.FS(sub))
}

// spaHandler serves files from fsys, falling back to /index.html for any path
// that doesn't resolve to a file. Required so React Router URLs (e.g. /manage,
// /deploy/cs2) don't 404 on a hard-refresh.
func spaHandler(fsys http.FileSystem) http.Handler {
	fileServer := http.FileServer(fsys)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			p = "index.html"
		}
		f, err := fsys.Open(p)
		if err == nil {
			f.Close()
			// Conservative cache: hashed assets get long-lived cache,
			// HTML/non-asset paths don't.
			if strings.HasPrefix(path.Clean(r.URL.Path), "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			} else {
				w.Header().Set("Cache-Control", "no-cache")
			}
			fileServer.ServeHTTP(w, r)
			return
		}
		if !errors.Is(err, fs.ErrNotExist) {
			http.Error(w, "UI read error: "+err.Error(), http.StatusInternalServerError)
			return
		}
		// SPA fallback to index.html
		r.URL.Path = "/"
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	})
}
