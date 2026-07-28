package kube

import (
	"context"
	"log/slog"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// hasSteamAPIKey returns true if the cs2 container has a non-empty API_KEY
// env var. With one set, the cs2 binary downloads subscribed workshop maps
// in the background via Steam's subscription API — no level change, no
// player kick — so the host_workshop_map auto-cycle is both redundant and
// disruptive. Either source (literal value or valueFrom-backed Secret) is
// treated as set; only an empty literal counts as "no key".
func hasSteamAPIKey(dep appsv1.Deployment) bool {
	for _, c := range dep.Spec.Template.Spec.Containers {
		for _, e := range c.Env {
			if e.Name != "API_KEY" {
				continue
			}
			if e.ValueFrom != nil {
				return true
			}
			if strings.TrimSpace(e.Value) != "" {
				return true
			}
		}
	}
	return false
}

// CS2 background reconciler: watches for CS2 deployments tagged with the
// gamectl.io/preload-workshop-maps annotation and kicks off the workshop
// pre-download cycle when:
//
//   - the deployment has ≥1 ready replica
//   - no human players are currently connected (cycling host_workshop_map
//     kicks everyone on each level change — we only want to do this when
//     the server is idle)
//   - the workshop has any missing ids
//   - no download cycle is already running for this server
//
// Re-runs on every tick, so a restart with missing maps eventually drains
// to zero without operator action.

const (
	cs2PreloadAnnotation = "gamectl.io/preload-workshop-maps"
	cs2ReconcileEvery    = 2 * time.Minute
	// CS2's first-boot install (steamcmd validate + mods) easily takes a
	// few minutes — slow it slightly on the first tick so we don't burn
	// API calls while the pod is still in the boot dance.
	cs2ReconcileFirstDelay = 90 * time.Second
)

// StartCS2Reconciler kicks off the background loop. Call once at startup.
// The loop exits when ctx is cancelled.
func (c *Cluster) StartCS2Reconciler(ctx context.Context) {
	go func() {
		// Sleep before the first run so we don't race the install.
		select {
		case <-ctx.Done():
			return
		case <-time.After(cs2ReconcileFirstDelay):
		}
		t := time.NewTicker(cs2ReconcileEvery)
		defer t.Stop()
		c.reconcileCS2Once()
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.reconcileCS2Once()
			}
		}
	}()
}

// reconcileCS2Once scans for opted-in cs2 deployments and triggers a
// preload cycle for any that are ready, idle, and have missing maps.
func (c *Cluster) reconcileCS2Once() {
	b := c.snap()
	if b == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	// Single-namespace + game=cs2 label keeps this cheap — no cluster-wide
	// list, no full pod scan.
	deps, err := b.clientset.AppsV1().Deployments("gamectl").List(ctx, metav1.ListOptions{
		LabelSelector: "game=cs2",
	})
	if err != nil {
		slog.Debug("cs2 reconciler: list deployments failed", "err", err)
		return
	}
	for _, dep := range deps.Items {
		if dep.Annotations[cs2PreloadAnnotation] != "true" {
			continue
		}
		if dep.Status.ReadyReplicas < 1 {
			continue
		}
		ns, name := dep.Namespace, dep.Name

		// If the container has a non-empty Steam Web API key, the cs2 binary
		// will background-download every entry in subscribed_file_ids.txt
		// via Steam's subscription API — silently, no level changes. Our
		// host_workshop_map cycle would just fight that and yank players,
		// so skip when the API key path is doing its job.
		if hasSteamAPIKey(dep) {
			continue
		}
		st, err := c.CS2WorkshopGetStatus(ctx, ns, name)
		if err != nil || st == nil {
			// Likely the pod hasn't booted far enough for podExec to work
			// yet — try again on the next tick.
			continue
		}
		if st.Running {
			continue // already cycling
		}
		if st.Missing == 0 {
			continue // nothing to do
		}
		// Don't yank players mid-game. The cycle kicks everyone on each
		// changelevel; that's fine only when the server is idle.
		players, err := c.CS2Players(ctx, ns, name)
		if err == nil {
			humans := 0
			for _, p := range players {
				if !p.IsBot {
					humans++
				}
			}
			if humans > 0 {
				slog.Info("cs2 preload: skipping, players connected",
					"ns", ns, "name", name, "humans", humans, "missing", st.Missing)
				continue
			}
		}
		n, err := c.CS2WorkshopDownload(ctx, ns, name, true)
		if err != nil {
			slog.Warn("cs2 preload: trigger failed", "ns", ns, "name", name, "err", err)
			continue
		}
		slog.Info("cs2 preload: started", "ns", ns, "name", name, "queued", n)
	}
}
