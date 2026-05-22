package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/GameCTL-HQ/GameCTL/server/internal/auth"
	"github.com/GameCTL-HQ/GameCTL/server/internal/kube"
	"github.com/GameCTL-HQ/GameCTL/server/internal/tasks"
)

type applyReq struct {
	Yaml      string           `json:"yaml,omitempty"`
	Manifests []map[string]any `json:"manifests,omitempty"`
}

// applyManifests handles POST /kube/apply.
//
// Accepts either:
//   - {"manifests": [<k8s-objects>]}  — list of pre-parsed manifests
//   - {"yaml":      "<multi-doc>"}    — raw YAML, possibly multiple ---separated docs
//
// Optional ?dry_run=true sends the requests with DryRun=All so nothing actually
// changes server-side. Dry-run keeps the synchronous response shape so the
// wizard can preview without polling.
//
// Default (non-dry-run) is now asynchronous: the request returns
// 202 Accepted with {taskId} immediately; the actual apply runs in a
// goroutine and reports phase progress to the tasks store, which the UI
// polls via /api/tasks.
func applyManifests(c *kube.Cluster, store *tasks.Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !kubeRequired(w, c) {
			return
		}

		body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
		if err != nil {
			writeError(w, http.StatusBadRequest, "read body: "+err.Error())
			return
		}
		var req applyReq
		if err := json.Unmarshal(body, &req); err != nil {
			writeError(w, http.StatusBadRequest, "invalid json")
			return
		}

		var docs []map[string]any
		switch {
		case len(req.Manifests) > 0:
			docs = req.Manifests
		case req.Yaml != "":
			parsed, err := kube.ParseYAMLDocs(req.Yaml)
			if err != nil {
				writeError(w, http.StatusBadRequest, "invalid yaml: "+err.Error())
				return
			}
			docs = parsed
		default:
			writeError(w, http.StatusBadRequest, "provide either 'manifests' or 'yaml'")
			return
		}

		if len(docs) == 0 {
			writeError(w, http.StatusBadRequest, "no manifests found in request")
			return
		}

		dryRun := r.URL.Query().Get("dry_run") == "true"

		// Dry-run stays synchronous — it's the wizard's preview path and the
		// user is actively waiting on it. No NFS-ensure helper pod, no
		// expensive waits → finishes in well under a second.
		if dryRun {
			result, err := c.Apply(r.Context(), docs, true, nil)
			if err != nil {
				code, msg := kube.AsAPIError(err)
				writeError(w, code, msg)
				return
			}
			writeJSON(w, http.StatusOK, result)
			return
		}

		// Build a friendly title from the first non-Namespace doc — usually
		// the Deployment, which carries the serverName + game label.
		title, subject, gameID := describeApply(docs)
		handle := store.Create("apply", title, subject, gameID, auth.User(r.Context()))

		// Kick off the actual apply in a goroutine with its own context so the
		// HTTP request returning doesn't cancel mid-flight.
		go runApplyTask(c, store, handle, docs)

		writeJSON(w, http.StatusAccepted, map[string]any{
			"taskId": handle.ID(),
		})
	}
}

// runApplyTask executes the apply against a fresh background context so the
// HTTP request returning early doesn't kill it. Times out at 10 minutes,
// generous enough for any apply we generate today. Registers its cancel
// func so the task can be stopped from the UI.
func runApplyTask(c *kube.Cluster, _ *tasks.Store, handle interface {
	ID() string
	Start()
	RegisterCancel(context.CancelFunc)
	BeginPhase(name, detail string) int
	EndPhase(idx int, err error)
	Finish(err error)
}, docs []map[string]any) {
	handle.Start()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	handle.RegisterCancel(cancel)
	_, err := c.Apply(ctx, docs, false, handle)
	handle.Finish(err)
}

// describeApply produces a Title/Subject/GameID for the task card based on
// what's in the manifest batch. Prefers the Deployment if present.
func describeApply(docs []map[string]any) (title, subject, gameID string) {
	var firstNS, firstName string
	for _, d := range docs {
		kind, _ := d["kind"].(string)
		meta, _ := d["metadata"].(map[string]any)
		if meta == nil {
			continue
		}
		name, _ := meta["name"].(string)
		ns, _ := meta["namespace"].(string)
		labels, _ := meta["labels"].(map[string]any)
		if firstName == "" && name != "" {
			firstName, firstNS = name, ns
		}
		if g, _ := labels["game"].(string); g != "" && gameID == "" {
			gameID = g
		}
		if kind == "Deployment" {
			// Deployment usually carries the right name and game label —
			// override whatever earlier doc we picked.
			firstName, firstNS = name, ns
			if g, _ := labels["game"].(string); g != "" {
				gameID = g
			}
			break
		}
	}
	subject = firstNS + "/" + firstName
	if firstNS == "" {
		subject = firstName
	}
	title = "Apply"
	if gameID != "" {
		title = "Apply " + gameID
	} else if firstName != "" {
		title = "Apply " + firstName
	}
	return title, subject, gameID
}
