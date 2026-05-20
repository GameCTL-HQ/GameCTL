package httpapi

import (
	"net/http"

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

// updateApply triggers an in-place rolling restart of GameCTL's own
// Deployment. With imagePullPolicy: Always + :latest this pulls the newest
// published image. The namespace/auth Secret and all game servers are left
// intact, so no re-setup is required.
func updateApply(c *kube.Cluster, cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		if err := c.RolloutRestart(r.Context(), cfg.SelfNamespace, cfg.SelfDeployment); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":         true,
			"deployment": cfg.SelfNamespace + "/" + cfg.SelfDeployment,
			"message": "Update started — GameCTL is rolling to the latest image. " +
				"This page will reconnect automatically in a few seconds.",
		})
	}
}
