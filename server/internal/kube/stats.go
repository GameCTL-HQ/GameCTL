package kube

import (
	"context"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// StatsServer is one entry in the GameCTL Stats API's public response — a
// deliberately narrow view of InstanceStatus/GameHealth. Only what a public
// "is it up, how many players" page needs; no namespace, pod, IP, or node
// details ever leave this boundary.
type StatsServer struct {
	Status     string `json:"status"`               // "online" | "offline" | "unknown"
	Players    *int   `json:"players,omitempty"`
	MaxPlayers *int   `json:"max_players,omitempty"`
	Map        string `json:"map,omitempty"`
	ServerName string `json:"server_name,omitempty"`
}

// AdvertisedStats returns the public Stats API payload: one StatsServer per
// instance the operator has opted in via SetAdvertise, keyed by its
// AdvertiseSlug (falling back to the `game` label, then the Deployment name,
// so every advertised instance is guaranteed a key even if two collide only
// the last write wins — an operator problem to fix by setting distinct
// slugs, not a server error).
func (c *Cluster) AdvertisedStats(ctx context.Context) (map[string]StatsServer, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	deps, err := b.clientset.AppsV1().Deployments(nsGamectl).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}

	out := map[string]StatsServer{}
	for _, dep := range deps.Items {
		if !strings.EqualFold(dep.Annotations[advertiseAnno], "on") {
			continue
		}

		gameKey := dep.Labels["game"]
		if gameKey == "" {
			gameKey = dep.Spec.Template.Labels["game"]
		}
		slug := dep.Annotations[advertiseSlugAnno]
		if slug == "" {
			slug = gameKey
		}
		if slug == "" {
			slug = dep.Name
		}

		ctx, cancel := context.WithTimeout(ctx, 8*time.Second)
		status, err := c.InstanceStatus(ctx, dep.Namespace, dep.Name)
		cancel()
		if err != nil {
			continue // best-effort — one broken instance shouldn't blank the whole list
		}

		s := StatsServer{
			Status:     onlineLabel(status),
			ServerName: dep.Annotations[advertiseNameAnno],
		}
		if h := status.GameHealth; h != nil {
			if h.Players > 0 || h.MaxPlayers > 0 {
				p := h.Players
				s.Players = &p
			}
			if h.MaxPlayers > 0 {
				mp := h.MaxPlayers
				s.MaxPlayers = &mp
			}
			s.Map = h.Map
		}
		out[slug] = s
	}
	return out, nil
}

// onlineLabel collapses InstanceStatus's richer label set to the
// three-state "online"/"offline"/"unknown" a public status page needs —
// deliberately coarser than the operator-facing Label field (which
// distinguishes "crash loop" from "pulling image" etc.; irrelevant, and
// arguably none of a visitor's business, on a public page).
func onlineLabel(s InstanceStatus) string {
	switch s.Color {
	case "green":
		return "online"
	case "grey":
		return "unknown"
	default: // orange (starting/partial), red (crashed/errored)
		return "offline"
	}
}
