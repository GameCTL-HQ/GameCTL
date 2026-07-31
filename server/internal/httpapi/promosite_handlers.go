package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/GameCTL-HQ/GameCTL/server/internal/auth"
	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
)

// The optional bundled "promotion site" (promosite/) — a separate,
// independently-toggleable add-on from the Stats API itself (see
// docs/STATS_API.md's "independent switches" note). Deploying it requires
// the Stats API to already be enabled (it needs a token to hand the
// container), but the reverse isn't true — enabling the Stats API never
// deploys this on its own.

func promositeStatusHandler(cluster *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, cluster) {
			return
		}
		info, err := cluster.PromositeStatus(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, info)
	}
}

type promositeDeployReq struct {
	Title  string `json:"title,omitempty"`
	Accent string `json:"accent,omitempty"`
}

func promositeDeployHandler(authn *auth.Authenticator, cluster *kube.Cluster, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, cluster) {
			return
		}
		token, ok := authn.StatsToken()
		if !ok {
			writeError(w, http.StatusConflict, "enable the Stats API first (Stats API tab) — the promotion site needs a token to read it")
			return
		}
		var req promositeDeployReq
		_ = json.NewDecoder(r.Body).Decode(&req) // body is optional; zero value = defaults
		if req.Title == "" {
			req.Title = "Game Servers"
		}
		if req.Accent == "" {
			req.Accent = "#7c3aed"
		}

		statsURL := "http://gamectl." + cfg.SelfNamespace + ".svc.cluster.local:8080/api/stats/servers"
		docs := promositeManifests(cfg, statsURL, token, req.Title, req.Accent)

		result, err := cluster.Apply(r.Context(), docs, false, nil)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "applied": result.Applied})
	}
}

func promositeDeleteHandler(cluster *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, cluster) {
			return
		}
		if err := cluster.DeletePromosite(r.Context()); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// promositeManifests builds the Deployment + Service for the bundled
// promotion site. Deliberately NOT labeled app.kubernetes.io/part-of=games
// — it's a GameCTL system add-on, not a game instance, and must not show
// up in the games list/hub.
func promositeManifests(cfg *config.Config, statsURL, statsToken, title, accent string) []map[string]any {
	labels := map[string]any{
		"app":                          kube.PromositeName,
		"app.kubernetes.io/name":       kube.PromositeName,
		"app.kubernetes.io/managed-by": "gamectl",
		"gamectl.io/system":            "promosite",
	}
	deployment := map[string]any{
		"apiVersion": "apps/v1",
		"kind":       "Deployment",
		"metadata": map[string]any{
			"name":      kube.PromositeName,
			"namespace": cfg.SelfNamespace,
			"labels":    labels,
		},
		"spec": map[string]any{
			"replicas": int64(1),
			"selector": map[string]any{
				"matchLabels": map[string]any{"app": kube.PromositeName},
			},
			"template": map[string]any{
				"metadata": map[string]any{"labels": labels},
				"spec": map[string]any{
					"containers": []any{
						map[string]any{
							"name":  "promosite",
							"image": cfg.PromositeImage,
							"ports": []any{
								map[string]any{"name": "http", "containerPort": int64(8080)},
							},
							"env": []any{
								map[string]any{"name": "STATS_API_URL", "value": statsURL},
								map[string]any{"name": "STATS_API_TOKEN", "value": statsToken},
								map[string]any{"name": "SITE_TITLE", "value": title},
								map[string]any{"name": "ACCENT_COLOR", "value": accent},
							},
							"resources": map[string]any{
								"requests": map[string]any{"cpu": "10m", "memory": "16Mi"},
								"limits":   map[string]any{"cpu": "200m", "memory": "64Mi"},
							},
						},
					},
				},
			},
		},
	}
	service := map[string]any{
		"apiVersion": "v1",
		"kind":       "Service",
		"metadata": map[string]any{
			"name":      kube.PromositeName,
			"namespace": cfg.SelfNamespace,
			"labels":    labels,
		},
		"spec": map[string]any{
			"selector": map[string]any{"app": kube.PromositeName},
			"ports": []any{
				map[string]any{"name": "http", "port": int64(80), "targetPort": "http"},
			},
		},
	}
	return []map[string]any{deployment, service}
}
