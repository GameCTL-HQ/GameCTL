package httpapi

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
)

// IW4X live controls for the manage screen: roster + bot-name list.
// Arbitrary console commands keep going through the shared /rcon endpoint —
// this file only adds what needs shaping or persistence.

func iw4xLive(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		live, err := c.IW4XLiveStatus(r.Context(), ns, name)
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		writeJSON(w, http.StatusOK, live)
	}
}

func iw4xGetBotNames(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		names, err := c.IW4XBotNames(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		if names == nil {
			names = []string{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"names": names})
	}
}

func iw4xSetBotNames(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		var req struct {
			Names []string `json:"names"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		ns := chi.URLParam(r, "namespace")
		name := chi.URLParam(r, "name")
		if err := c.IW4XSetBotNames(r.Context(), ns, name, req.Names); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		// Deliberately explicit: IW4x reads bots.txt at startup only, so the
		// UI must not imply the roster changed just now.
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"detail": "Saved. Bot names load at server start — restart the server to apply them.",
		})
	}
}

func iw4xGetAdmins(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		admins, err := c.IW4XAdmins(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		if admins == nil {
			admins = []kube.IW4XAdmin{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"admins": admins})
	}
}

func iw4xSetAdmins(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		var req struct {
			Admins []kube.IW4XAdmin `json:"admins"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		ns, name := chi.URLParam(r, "namespace"), chi.URLParam(r, "name")
		if err := c.IW4XSetAdmins(r.Context(), ns, name, req.Admins); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		// The mod checks membership on connect, so an admin added mid-session
		// gets nothing until they rejoin. Say so rather than implying instant
		// effect.
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"detail": "Saved and applied. Players must reconnect for a change to take effect.",
		})
	}
}

func iw4xGetRotation(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		rot, err := c.IW4XRotation(r.Context(), chi.URLParam(r, "namespace"), chi.URLParam(r, "name"))
		if err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		if rot == nil {
			rot = []kube.IW4XRotationEntry{}
		}
		writeJSON(w, http.StatusOK, map[string]any{"rotation": rot})
	}
}

func iw4xSetRotation(c *kube.Cluster) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}
		var req struct {
			Rotation []kube.IW4XRotationEntry `json:"rotation"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}
		ns, name := chi.URLParam(r, "namespace"), chi.URLParam(r, "name")
		if err := c.IW4XSetRotation(r.Context(), ns, name, req.Rotation); err != nil {
			code, msg := kube.AsAPIError(err)
			writeError(w, code, msg)
			return
		}
		// IW4x reads its rotation once at the first match end, so a saved
		// rotation genuinely needs the server to start again — say it plainly.
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":     true,
			"detail": "Saved. Restart the server to load it — IW4x reads its rotation once at startup.",
		})
	}
}
