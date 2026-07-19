package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/GameCTL-HQ/GameCTL/server/internal/auth"
	"github.com/GameCTL-HQ/GameCTL/server/internal/buildinfo"
	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
	"github.com/GameCTL-HQ/GameCTL/server/internal/tasks"
	"github.com/GameCTL-HQ/GameCTL/server/internal/ui"
	"github.com/GameCTL-HQ/GameCTL/server/internal/update"
)

// NewRouter wires up the HTTP routes.
//
// Layout:
//   - /api/*  — all backend endpoints. /api/health is also the readiness/liveness probe.
//   - /*      — SPA fallback served from the embedded UI (or GAMECTL_UI_DIR if set).
//
// The cluster argument may be nil — kube-dependent handlers will return 503 in that
// case (see kubeRequired).
func NewRouter(authn *auth.Authenticator, cluster *kube.Cluster, cfg *config.Config, taskStore *tasks.Store) http.Handler {
	updChecker := update.NewChecker(cfg.UpdateRepo, buildinfo.Version)

	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(middleware.Recoverer)
	r.Use(middleware.Timeout(60 * time.Second))
	r.Use(corsMiddleware(cfg.AllowedOrigins))

	r.Route("/api", func(r chi.Router) {
		// Public
		r.Get("/health", health)
		r.Post("/token", tokenHandler(authn))
		r.Get("/auth/state", authState(authn))
		r.Post("/auth/setup", setupHandler(authn, cluster, cfg))

		// Protected
		r.Group(func(r chi.Router) {
			r.Use(authn.Middleware)

			r.Get("/whoami", whoami(cluster))

			// Version + self-update (pins the image to the newest release tag;
			// keeps auth Secret and game servers — see UpdateSelfImage).
			r.Get("/version", versionHandler)
			r.Get("/update/check", updateCheck(updChecker))
			r.Get("/release-notes", releaseNotes)
			r.Post("/update/apply", updateApply(cluster, cfg, updChecker))

			// Kube discovery
			r.Get("/kube/namespaces", listNamespaces(cluster))
			r.Get("/kube/pods", listPods(cluster))
			r.Post("/kube/kubeconfig", uploadKubeconfig(cluster, authn, cfg))

			// ProxyCTL hub — shared by the publish endpoints below AND the
			// apply worker (deploy-time publish intent), so it's created
			// before both.
			proxyctlHub := newProxyctlHub(cluster)

			// Server-side apply for arbitrary manifests is async — returns a
			// taskId immediately and the worker runs in a goroutine with its
			// own 10min context. The route still gets a longer chi timeout
			// because dry-run mode is synchronous (cheap, but not free).
			//
			// Delete is still synchronous and waits for ns/pv teardown, so it
			// gets the same generous slot.
			r.Group(func(r chi.Router) {
				r.Use(middleware.Timeout(5 * time.Minute))
				r.Post("/kube/apply", applyManifests(cluster, taskStore, proxyctlHub))
				r.Delete("/games/instances/{namespace}/{name}", deleteInstance(cluster, taskStore, proxyctlHub))
			})

			// Background tasks visible from any page (header dropdown + detail).
			r.Get("/tasks", listTasks(taskStore))
			r.Get("/tasks/{id}", getTask(taskStore))
			r.Post("/tasks/{id}/cancel", cancelTask(taskStore))
			r.Post("/tasks/{id}/rerun", rerunTask(applyRunner{cluster: cluster, hub: proxyctlHub}, taskStore))

			// Game instance read endpoints
			r.Get("/games/instances", listInstances(cluster))
			r.Get("/games/instances/{namespace}/{name}/status", instanceStatus(cluster))
			r.Get("/games/instances/{namespace}/{name}/events", instanceEvents(cluster))
			r.Get("/games/instances/{namespace}/{name}/pods", listInstancePods(cluster))
			r.Get("/games/instances/{namespace}/{name}/logs", instanceLogs(cluster))
			r.Get("/games/instances/{namespace}/{name}/settings", instanceSettings(cluster))

			// Game instance mutations
			r.Patch("/games/instances/{namespace}/{name}/scale", scaleInstance(cluster))
			r.Post("/games/instances/{namespace}/{name}/restart", restartInstance(cluster))
			r.Patch("/games/instances/{namespace}/{name}/autoupdate", setAutoUpdate(cluster))

			// Per-game save backups (schedule + retention + restore)
			r.Get("/games/instances/{namespace}/{name}/backup", instanceBackup(cluster))
			r.Patch("/games/instances/{namespace}/{name}/backup", setInstanceBackup(cluster))
			r.Get("/games/instances/{namespace}/{name}/backups", listInstanceBackups(cluster))
			r.Post("/games/instances/{namespace}/{name}/backup/now", backupNow(cluster, taskStore))
			r.Post("/games/instances/{namespace}/{name}/restore", restoreBackup(cluster, taskStore))

			r.Post("/games/instances/{namespace}/{name}/cs2config", applyCS2Config(cluster))
			// CS2 player roster + live admin management (kus modded image).
			r.Get("/games/instances/{namespace}/{name}/cs2/players", cs2Players(cluster))
			r.Get("/games/instances/{namespace}/{name}/cs2/admins", cs2Admins(cluster))
			r.Post("/games/instances/{namespace}/{name}/cs2/admin", cs2SetAdmin(cluster))
			r.Get("/games/instances/{namespace}/{name}/cs2/welcome", cs2GetWelcome(cluster))
			r.Post("/games/instances/{namespace}/{name}/cs2/welcome", cs2SetWelcome(cluster))
			r.Get("/games/instances/{namespace}/{name}/cs2/hostname", cs2GetHostname(cluster))
			r.Post("/games/instances/{namespace}/{name}/cs2/hostname", cs2SetHostname(cluster))
			r.Get("/games/instances/{namespace}/{name}/cs2/steam-api-key", cs2GetSteamAPIKey(cluster))
			r.Post("/games/instances/{namespace}/{name}/cs2/steam-api-key", cs2SetSteamAPIKey(cluster))
			r.Get("/games/instances/{namespace}/{name}/cs2/surf-records", cs2SurfRecords(cluster))
			r.Get("/games/instances/{namespace}/{name}/cs2/workshop", cs2Workshop(cluster))
			r.Post("/games/instances/{namespace}/{name}/cs2/workshop/download", cs2WorkshopDownload(cluster))
			r.Post("/games/instances/{namespace}/{name}/cs2/workshop/cancel", cs2WorkshopCancel(cluster))
			r.Post("/games/instances/{namespace}/{name}/cs2/workshop/sidecar", cs2WorkshopSidecar(cluster))
			r.Post("/games/instances/{namespace}/{name}/rcon", runRcon(cluster))
			// Delete is in the long-timeout group above (apply+delete share the
			// pattern of "kicks off resource churn that might exceed 60s").

			// Steam A2S
			r.Get("/games/steam/status", steamStatus())

			// ProxyCTL integration — detect a sibling ProxyCTL install, store
			// the operator link, and publish instances (L4 tunnel entry + DNS)
			// without leaving GameCTL. (Hub created above, before the apply
			// group.)
			r.Get("/proxyctl/status", proxyctlStatus(proxyctlHub))
			r.Get("/proxyctl/domains", proxyctlDomains(proxyctlHub))
			r.Put("/proxyctl/link", setProxyctlLink(proxyctlHub))
			r.Delete("/proxyctl/link", deleteProxyctlLink(proxyctlHub))
			r.Get("/games/instances/{namespace}/{name}/publish", publishInfo(proxyctlHub))
			// Publish mutations get a long slot: web targets reconcile
			// ProxyCTL's Cloudflare Tunnel, whose first run (create tunnel,
			// deploy cloudflared) can take ~100s.
			r.Group(func(r chi.Router) {
				r.Use(middleware.Timeout(3 * time.Minute))
				r.Post("/games/instances/{namespace}/{name}/publish", publishSet(proxyctlHub))
				r.Delete("/games/instances/{namespace}/{name}/publish", publishDelete(proxyctlHub))
			})

			// Cluster discovery (powers wizard dropdowns: pools, free IPs, storage classes, cluster label)
			r.Get("/cluster/info", clusterInfo(cluster))
			r.Get("/cluster/metallb/pools", listMetalLBPools(cluster))
			r.Get("/cluster/metallb/free-ips", listMetalLBFreeIPs(cluster))
			r.Get("/cluster/storageclasses", listStorageClasses(cluster))

			// Operator-managed NFS storage locations (ConfigMap-backed).
			r.Get("/storage/locations", listStorageLocations(cluster))
			r.Put("/storage/locations", setStorageLocations(cluster))
			// Reachability + read/write probe. Spawns a short-lived pod
			// with the same inline volume a real game would use; can run
			// against an unsaved row, hence POST with the body, not the
			// stored list.
			r.Post("/storage/locations/test", testStorageLocation(cluster))
		})
	})

	// SPA UI catch-all (React Router-friendly).
	r.Handle("/*", ui.Handler(cfg.UIDir))

	return r
}

func health(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// whoami also reports whether the Kubernetes client is already wired up
// (in-cluster ServiceAccount or a previously-loaded kubeconfig) so the UI
// can skip the "paste a kubeconfig" screen when it isn't needed — which is
// the normal case for an in-cluster deployment.
func whoami(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		connected := c != nil && c.Connected()
		source := ""
		if connected {
			source = c.Source()
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"user": auth.User(r.Context()),
			"kube": map[string]any{"connected": connected, "source": source},
		})
	}
}

type tokenReq struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

func tokenHandler(authn *auth.Authenticator) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var u, p string
		ct := r.Header.Get("Content-Type")
		switch {
		case strings.HasPrefix(ct, "application/json"):
			var req tokenReq
			if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
				writeError(w, http.StatusBadRequest, "invalid json")
				return
			}
			u, p = req.Username, req.Password
		default:
			if err := r.ParseForm(); err != nil {
				writeError(w, http.StatusBadRequest, "invalid form")
				return
			}
			u, p = r.PostFormValue("username"), r.PostFormValue("password")
		}

		if !authn.Verify(u, p) {
			writeError(w, http.StatusUnauthorized, "invalid credentials")
			return
		}

		tok, err := authn.IssueToken(u)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "token generation failed")
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"access_token": tok,
			"token_type":   "bearer",
		})
	}
}
