package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
)

// monitoringSummary handles GET /monitoring/summary — every instance's
// latest reachability sample, for the Monitoring settings page's "what's
// being watched right now" list.
func monitoringSummary(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"instances": kube.AllInstanceProbeSummaries()})
	}
}

// alertConfigGet handles GET /alerts/config.
func alertConfigGet(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		cfg, err := c.AlertConfig(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, cfg)
	}
}

// alertConfigSet handles PUT /alerts/config.
func alertConfigSet(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		var cfg kube.AlertConfig
		if err := json.NewDecoder(r.Body).Decode(&cfg); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		if err := c.SetAlertConfig(r.Context(), cfg); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// alertConfigTest handles POST /alerts/test — sends a real Discord message
// against the CURRENTLY SAVED config (not a URL from the request body) so
// "Test" always proves what "Save" actually persisted.
func alertConfigTest(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		cfg, err := c.AlertConfig(r.Context())
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		if cfg.DiscordWebhookURL == "" {
			writeError(w, http.StatusBadRequest, "no webhook URL saved yet — save one first")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		err = kube.SendDiscordAlert(ctx, cfg.DiscordWebhookURL,
			"🔔 GameCTL test alert", "If you can see this, your webhook is set up correctly.", 0x3498DB)
		if err != nil {
			writeError(w, http.StatusBadGateway, "test send failed: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}
