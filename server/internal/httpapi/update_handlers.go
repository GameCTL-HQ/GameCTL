package httpapi

import (
	"net/http"
	"strings"

	"github.com/GameCTL-HQ/GameCTL/server/internal/buildinfo"
	"github.com/GameCTL-HQ/GameCTL/server/internal/config"
	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
	"github.com/GameCTL-HQ/GameCTL/server/internal/releasenotes"
	"github.com/GameCTL-HQ/GameCTL/server/internal/update"
)

// versionHandler reports the running build version (stamped at release).
func versionHandler(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"version": buildinfo.Version})
}

// releaseNotes serves GameCTL's embedded changelog so the in-app update
// tool can show "what's updating and why". It returns every entry plus the
// one that matches the running build (exact tag match, else the
// "unreleased" entry for SHA/dev builds) so the UI can highlight the
// relevant fixes without a second round-trip.
func releaseNotes(w http.ResponseWriter, _ *http.Request) {
	all, err := releasenotes.All()
	if err != nil {
		writeError(w, http.StatusInternalServerError, "release notes unavailable: "+err.Error())
		return
	}
	current, found, _ := releasenotes.ForVersion(buildinfo.Version)
	resp := map[string]any{
		"version":  buildinfo.Version,
		"releases": all,
	}
	if found {
		resp["current"] = current
	}
	writeJSON(w, http.StatusOK, resp)
}

// updateCheck returns cached "is a newer release available?" info. It never
// errors — transient GitHub problems surface as a soft note.
func updateCheck(chk *update.Checker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		force := r.URL.Query().Get("force") == "1"
		writeJSON(w, http.StatusOK, chk.Check(r.Context(), force))
	}
}

// updateApply moves GameCTL's own Deployment to the newest published release by
// pinning its container image to that immutable tag (keeping the current
// registry/repo). Only this explicit action changes the version — because the
// deployed image is a fixed tag, an ordinary pod restart re-pulls the SAME
// version instead of silently jumping to whatever a moving :latest tag now
// points at. The namespace/auth Secret and all game servers are left intact, so
// no re-setup is required.
func updateApply(c *kube.Cluster, cfg *config.Config, chk *update.Checker) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		st := chk.Check(r.Context(), true)
		latest := strings.TrimSpace(st.Latest)
		if latest == "" {
			writeError(w, http.StatusBadGateway,
				"couldn't determine the latest release to update to — check connectivity to GitHub and try again.")
			return
		}
		from, changed, err := c.UpdateSelfImage(r.Context(), cfg.SelfNamespace, cfg.SelfDeployment, latest)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		if !changed {
			writeJSON(w, http.StatusOK, map[string]any{
				"ok":         true,
				"deployment": cfg.SelfNamespace + "/" + cfg.SelfDeployment,
				"message":    "Already running " + latest + " — nothing to update.",
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":         true,
			"deployment": cfg.SelfNamespace + "/" + cfg.SelfDeployment,
			"from":       from,
			"to":         latest,
			"message": "Update started — GameCTL is rolling to " + latest + ". " +
				"This page will reconnect automatically in a few seconds.",
		})
	}
}
