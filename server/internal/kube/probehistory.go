package kube

import (
	"context"
	"fmt"
	"net"
	"sort"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameCTL-HQ/GameCTL/server/internal/games"
)

// Reachability / protocol-health history for game instances — the sibling to
// metrics.go's CPU/RAM sampler, same shape (30s tick, ~1h ring buffer, no
// extra infra). Two independently-tracked lines per sample:
//
//   - in-cluster: pod readiness for every game, plus (when a probe is
//     registered for the game) the same deep protocol probe the live status
//     endpoint already runs, against the Service ClusterIP — now sampled
//     continuously instead of only on page view.
//   - external (LB): only present when the Service has a MetalLB/LoadBalancer
//     IP. Reuses the same protocol probe against that IP when one's
//     registered for the game; otherwise a bare TCP dial for TCP ports.
//     Catches MetalLB/L2Advertisement failures the in-cluster check can't
//     see (e.g. speaker not announcing, ARP issue) — nil (not false) when
//     there's no LB IP or no way to meaningfully check it (UDP + no probe).
const (
	probeSampleEvery = 30 * time.Second
	// Full 30s resolution is kept for this long; older samples are
	// compacted to compactResolution (any "down" in the window survives
	// compaction, so outages never disappear from long views). With that,
	// even 30d of retention is ~10k samples per instance.
	probeRawWindow    = 24 * time.Hour
	compactResolution = 5 * time.Minute
)

// probeMaxLen converts the configured retention into a hard cap on ring
// length: one raw-window of 30s samples + the rest at compacted resolution,
// with slack for compaction landing between ticks.
func probeMaxLen(retentionDays int) int {
	raw := int(probeRawWindow / probeSampleEvery)
	rest := (retentionDays*24*3600 - int(probeRawWindow/time.Second)) / int(compactResolution/time.Second)
	if rest < 0 {
		rest = 0
	}
	return raw + rest + 100
}

type ProbeSample struct {
	T          int64  `json:"t"`
	Reachable  bool   `json:"reachable"`
	LatencyMS  int64  `json:"latencyMs,omitempty"`
	Players    int    `json:"players,omitempty"`
	MaxPlayers int    `json:"maxPlayers,omitempty"`
	Map        string `json:"map,omitempty"`

	// LB* is nil unless the Service has a LoadBalancer IP AND we had a way
	// to meaningfully check it (a registered probe, or a TCP port).
	LBReachable *bool `json:"lbReachable,omitempty"`
	LBLatencyMS int64 `json:"lbLatencyMs,omitempty"`
}

// InstanceProbeHistory is the wire shape for one instance's reachability
// history.
type InstanceProbeHistory struct {
	Namespace string        `json:"namespace"`
	Name      string        `json:"name"`
	History   []ProbeSample `json:"history,omitempty"`
}

type probeHistState struct {
	mu    sync.Mutex
	byKey map[string]*InstanceProbeHistory
}

var probeHist probeHistState

// StartProbeHistorySampler launches the background poller. Call once at
// startup alongside StartMetricsSampler; it survives cluster reconfiguration
// (each tick re-reads the live bundle). History is restored from the last
// on-disk snapshot (when GAMECTL_HISTORY_DIR is set) so graphs survive a
// restart, and re-snapshotted every historySnapshotEveryTicks + on shutdown.
func (c *Cluster) StartProbeHistorySampler(ctx context.Context) {
	if path, ok := historyPath("probe-history.json"); ok {
		var restored map[string]*InstanceProbeHistory
		if err := loadJSONSnapshot(path, &restored); err == nil && len(restored) > 0 {
			probeHist.mu.Lock()
			probeHist.byKey = restored
			probeHist.mu.Unlock()
		}
	}
	go func() {
		t := time.NewTicker(probeSampleEvery)
		defer t.Stop()
		c.sampleProbeHistory(ctx)
		ticks := 0
		for {
			select {
			case <-ctx.Done():
				snapshotProbeHistory()
				return
			case <-t.C:
				c.sampleProbeHistory(ctx)
				if ticks++; ticks%historySnapshotEveryTicks == 0 {
					snapshotProbeHistory()
				}
			}
		}
	}()
}

func snapshotProbeHistory() {
	path, ok := historyPath("probe-history.json")
	if !ok {
		return
	}
	probeHist.mu.Lock()
	b := probeHist.byKey
	cp := make(map[string]*InstanceProbeHistory, len(b))
	for k, v := range b {
		c := *v
		c.History = append([]ProbeSample(nil), v.History...)
		cp[k] = &c
	}
	probeHist.mu.Unlock()
	_ = saveJSONSnapshot(path, cp)
}

func (c *Cluster) sampleProbeHistory(ctx context.Context) {
	b := c.snap()
	if b == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 25*time.Second)
	defer cancel()

	// Same discovery as metrics.go's sampleMetrics: every Deployment
	// labeled part-of=games, cluster-wide with a namespaced fallback for
	// installs whose Role isn't cluster-scoped.
	deps, err := b.clientset.AppsV1().Deployments("").List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/part-of=games",
	})
	if err != nil {
		deps, err = b.clientset.AppsV1().Deployments("gamectl").List(ctx, metav1.ListOptions{
			LabelSelector: "app.kubernetes.io/part-of=games",
		})
		if err != nil {
			return
		}
	}

	now := time.Now().Unix()
	fresh := map[string]*InstanceProbeHistory{}

	for i := range deps.Items {
		d := &deps.Items[i]
		key := d.Namespace + "/" + d.Name

		desired := int32(1)
		if d.Spec.Replicas != nil {
			desired = *d.Spec.Replicas
		}
		if desired == 0 {
			continue // stopped on purpose — don't record "down" for it
		}
		ready := d.Status.ReadyReplicas >= desired && d.Status.ReadyReplicas > 0

		sample := ProbeSample{T: now, Reachable: ready}

		if ready {
			gameKey := d.Labels["game"]
			if gameKey == "" {
				gameKey = d.Spec.Template.Labels["game"]
			}
			if svc := resolveInstanceService(ctx, b, d.Namespace, d.Name, d.Spec.Template.Labels); svc != nil && gameKey != "" && len(svc.Spec.Ports) > 0 {
				sampleProbeAndLB(ctx, gameKey, svc, &sample)
			}
		}

		ih := fresh[key]
		if ih == nil {
			ih = &InstanceProbeHistory{Namespace: d.Namespace, Name: d.Name}
			fresh[key] = ih
		}
		ih.History = append(ih.History, sample)
	}

	cfg, cfgErr := c.AlertConfig(ctx)
	retentionDays := AlertConfig{}.EffectiveRetentionDays()
	if cfgErr == nil {
		retentionDays = cfg.EffectiveRetentionDays()
	}

	// Alert on state transitions (down↔up), in-cluster and external (LB)
	// independently — never on an instance's first-ever sample (nothing to
	// compare a transition against yet). Fire-and-forget: a webhook hiccup
	// must never affect the sampler loop.
	if cfgErr == nil && cfg.Enabled && cfg.DiscordWebhookURL != "" {
		probeHist.mu.Lock()
		for key, ih := range fresh {
			prevIH := probeHist.byKey[key]
			if prevIH == nil || len(prevIH.History) == 0 || len(ih.History) == 0 {
				continue
			}
			prevSample := prevIH.History[len(prevIH.History)-1]
			newSample := ih.History[len(ih.History)-1]
			if newSample.Reachable != prevSample.Reachable {
				go fireReachabilityAlert(cfg.DiscordWebhookURL, ih.Name, "in-cluster", newSample.Reachable)
			}
			if newSample.LBReachable != nil && prevSample.LBReachable != nil && *newSample.LBReachable != *prevSample.LBReachable {
				go fireReachabilityAlert(cfg.DiscordWebhookURL, ih.Name, "external (LB IP)", *newSample.LBReachable)
			}
		}
		probeHist.mu.Unlock()
	}

	probeHist.mu.Lock()
	defer probeHist.mu.Unlock()
	if probeHist.byKey == nil {
		probeHist.byKey = map[string]*InstanceProbeHistory{}
	}
	maxLen := probeMaxLen(retentionDays)
	for key, ih := range fresh {
		if prev := probeHist.byKey[key]; prev != nil {
			ih.History = append(prev.History, ih.History...)
		}
		ih.History = compactProbeSamples(ih.History, now, retentionDays)
		if len(ih.History) > maxLen {
			ih.History = ih.History[len(ih.History)-maxLen:]
		}
		probeHist.byKey[key] = ih
	}
	// Drop instances that no longer exist so deleted games don't linger.
	for key := range probeHist.byKey {
		if _, ok := fresh[key]; !ok {
			delete(probeHist.byKey, key)
		}
	}
}

// compactProbeSamples enforces retention: drops samples past the retention
// horizon, keeps full 30s resolution inside probeRawWindow, and compacts
// older samples to one representative per compactResolution bucket — a
// down sample (either the in-cluster or the LB line) always wins the
// bucket over an up one, so brief outages survive compaction instead of
// being averaged away. Input is chronological; output stays chronological.
func compactProbeSamples(h []ProbeSample, now int64, retentionDays int) []ProbeSample {
	rawCutoff := now - int64(probeRawWindow/time.Second)
	dropCutoff := now - int64(retentionDays)*24*3600
	res := int64(compactResolution / time.Second)
	out := make([]ProbeSample, 0, len(h))
	var lastBucket int64 = -1
	for _, s := range h {
		if s.T < dropCutoff {
			continue
		}
		if s.T >= rawCutoff {
			out = append(out, s)
			continue
		}
		b := s.T / res
		if b != lastBucket {
			out = append(out, s)
			lastBucket = b
			continue
		}
		last := &out[len(out)-1]
		if !s.Reachable && last.Reachable {
			*last = s
		} else if s.LBReachable != nil && !*s.LBReachable && (last.LBReachable == nil || *last.LBReachable) {
			last.LBReachable = s.LBReachable
			last.LBLatencyMS = s.LBLatencyMS
		}
	}
	return out
}

// sampleProbeAndLB fills in the protocol probe (ClusterIP) and, when the
// Service has a LoadBalancer IP, the external check too. Mirrors the port
// picking + timeout budget InstanceStatus already uses for the live view.
func sampleProbeAndLB(ctx context.Context, gameKey string, svc *corev1.Service, sample *ProbeSample) {
	port, ok := pickProbePort(svc.Spec.Ports, games.Hint(gameKey))
	if !ok {
		return
	}

	clusterAddr := net.JoinHostPort(svc.Spec.ClusterIP, fmt.Sprintf("%d", port))
	pctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	h := games.Probe(pctx, gameKey, clusterAddr, 5*time.Second)
	cancel()
	if h != nil {
		sample.Reachable = h.Reachable
		sample.LatencyMS = h.LatencyMS
		sample.Players = h.Players
		sample.MaxPlayers = h.MaxPlayers
		sample.Map = h.Map
	}

	if len(svc.Status.LoadBalancer.Ingress) == 0 || svc.Status.LoadBalancer.Ingress[0].IP == "" {
		return
	}
	lbAddr := net.JoinHostPort(svc.Status.LoadBalancer.Ingress[0].IP, fmt.Sprintf("%d", port))

	lctx, lcancel := context.WithTimeout(ctx, 4*time.Second)
	defer lcancel()
	if h := games.Probe(lctx, gameKey, lbAddr, 4*time.Second); h != nil {
		reachable := h.Reachable
		sample.LBReachable = &reachable
		sample.LBLatencyMS = h.LatencyMS
		return
	}

	// No registered probe for this game — fall back to a bare TCP dial when
	// the picked port is TCP. UDP has no connect-time signal without
	// protocol knowledge (the OS "connect" always succeeds), so we leave
	// LBReachable nil rather than report a meaningless result.
	for _, p := range svc.Spec.Ports {
		if p.Port == port && string(p.Protocol) == "TCP" {
			start := time.Now()
			conn, err := net.DialTimeout("tcp", lbAddr, 4*time.Second)
			reachable := err == nil
			if conn != nil {
				conn.Close()
			}
			sample.LBReachable = &reachable
			if reachable {
				sample.LBLatencyMS = time.Since(start).Milliseconds()
			}
			break
		}
	}
}

// fireReachabilityAlert posts a Discord embed for one reachability
// transition. Its own timeout/context — deliberately not tied to the
// sampler's context so a slow webhook can't get cancelled mid-flight by
// the next tick.
func fireReachabilityAlert(webhookURL, name, scope string, up bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	title := fmt.Sprintf("🔴 %s — %s unreachable", name, scope)
	color := colorDown
	if up {
		title = fmt.Sprintf("🟢 %s — %s back up", name, scope)
		color = colorUp
	}
	_ = SendDiscordAlert(ctx, webhookURL, title, "", color)
}

// ProbeSummary is the latest-sample-only view for one instance — the
// Monitoring settings page's "what's being watched right now" list. Mirrors
// AllInstanceMetrics' shape (current value, no history) for the same reason:
// a settings page listing every instance shouldn't pull a full ~1h history
// per row.
type ProbeSummary struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Reachable bool   `json:"reachable"`
	LatencyMS int64  `json:"latencyMs,omitempty"`
	Map       string `json:"map,omitempty"`

	LBReachable *bool `json:"lbReachable,omitempty"`
	LBLatencyMS int64 `json:"lbLatencyMs,omitempty"`

	SampleCount int `json:"sampleCount"` // how much history exists — 0 = not sampled yet
}

// AllInstanceProbeSummaries returns the latest sample for every instance
// the sampler has seen.
func AllInstanceProbeSummaries() []ProbeSummary {
	probeHist.mu.Lock()
	defer probeHist.mu.Unlock()
	out := make([]ProbeSummary, 0, len(probeHist.byKey))
	for _, ih := range probeHist.byKey {
		if len(ih.History) == 0 {
			continue
		}
		last := ih.History[len(ih.History)-1]
		out = append(out, ProbeSummary{
			Namespace: ih.Namespace, Name: ih.Name,
			Reachable: last.Reachable, LatencyMS: last.LatencyMS, Map: last.Map,
			LBReachable: last.LBReachable, LBLatencyMS: last.LBLatencyMS,
			SampleCount: len(ih.History),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// InstanceProbeHistoryFor returns the full reachability history for one
// instance (nil if the sampler hasn't seen it yet).
func InstanceProbeHistoryFor(ns, name string) *InstanceProbeHistory {
	probeHist.mu.Lock()
	defer probeHist.mu.Unlock()
	ih := probeHist.byKey[ns+"/"+name]
	if ih == nil {
		return nil
	}
	c := *ih
	c.History = append([]ProbeSample(nil), ih.History...)
	return &c
}
