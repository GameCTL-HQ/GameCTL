package kube

import (
	"context"
	"encoding/json"
	"log"
	"sort"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Resource monitoring for game instances, built on metrics-server
// (metrics.k8s.io — present by default on k3s; the panel degrades to
// "metrics unavailable" without it). A background sampler polls every 30s
// and keeps ~1h of per-instance history in memory, so the manage screen
// has a graph the moment it opens and the hub can flag limit pressure
// without any extra infrastructure (no Prometheus dependency).

const (
	metricsSampleEvery = 30 * time.Second
	metricsHistoryLen  = 120 // × 30s = 1h
	// Alert thresholds against the container's own limit: memory at the
	// limit is an OOM-kill; CPU at the limit is throttling.
	memAlertPct = 90
	cpuAlertPct = 95
)

// MetricsSample is one point of an instance's history (container usage
// summed across the pod).
type MetricsSample struct {
	T        int64 `json:"t"` // unix seconds
	CPUMilli int64 `json:"cpuMilli"`
	MemBytes int64 `json:"memBytes"`
}

// InstanceMetrics is the wire shape for one instance.
type InstanceMetrics struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`

	CPUMilli      int64 `json:"cpuMilli"`
	CPULimitMilli int64 `json:"cpuLimitMilli"` // 0 = no limit set
	MemBytes      int64 `json:"memBytes"`
	MemLimitBytes int64 `json:"memLimitBytes"` // 0 = no limit set

	// MaxCPUPct / MaxMemPct are the WORST per-container usage/limit ratio
	// (limits are enforced per container, so the pod sum can look fine
	// while one container is about to be OOM-killed).
	MaxCPUPct int `json:"maxCpuPct"`
	MaxMemPct int `json:"maxMemPct"`

	// Alerts: "mem" (near OOM), "cpu" (throttling), "oom" (a container was
	// OOM-killed within the last hour).
	Alerts []string `json:"alerts,omitempty"`

	History []MetricsSample `json:"history,omitempty"`
}

type metricsState struct {
	mu        sync.Mutex
	byKey     map[string]*InstanceMetrics // ns/name → latest (with history)
	available bool
	lastErr   string
}

var metrics metricsState

// podMetricsList mirrors the metrics.k8s.io/v1beta1 PodMetricsList wire
// shape (only the fields we read) — fetched via the core REST client so no
// extra client module is needed.
type podMetricsList struct {
	Items []struct {
		Metadata struct {
			Name   string            `json:"name"`
			Labels map[string]string `json:"labels"`
		} `json:"metadata"`
		Containers []struct {
			Name  string `json:"name"`
			Usage struct {
				CPU    string `json:"cpu"`
				Memory string `json:"memory"`
			} `json:"usage"`
		} `json:"containers"`
	} `json:"items"`
}

// StartMetricsSampler launches the background poller. Call once at startup;
// it survives cluster reconfiguration (each tick re-reads the live bundle).
func (c *Cluster) StartMetricsSampler(ctx context.Context) {
	go func() {
		t := time.NewTicker(metricsSampleEvery)
		defer t.Stop()
		c.sampleMetrics(ctx)
		for {
			select {
			case <-ctx.Done():
				return
			case <-t.C:
				c.sampleMetrics(ctx)
			}
		}
	}()
}

func (c *Cluster) sampleMetrics(ctx context.Context) {
	b := c.snap()
	if b == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	// Game instances: every Deployment labeled part-of=games, in any
	// namespace GameCTL manages (single-namespace installs: just "gamectl").
	deps, err := b.clientset.AppsV1().Deployments("").List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/part-of=games",
	})
	if err != nil {
		// Cluster-wide list can be forbidden under the namespaced Role —
		// fall back to the home namespace.
		deps, err = b.clientset.AppsV1().Deployments("gamectl").List(ctx, metav1.ListOptions{
			LabelSelector: "app.kubernetes.io/part-of=games",
		})
		if err != nil {
			metrics.mu.Lock()
			metrics.lastErr = err.Error()
			metrics.mu.Unlock()
			return
		}
	}

	type contLimit struct{ cpuMilli, memBytes int64 }
	type instInfo struct {
		ns, name string
		limits   map[string]contLimit // container name → limits
	}
	instances := map[string]*instInfo{} // "app" label value per ns
	namespaces := map[string]bool{}
	for i := range deps.Items {
		d := &deps.Items[i]
		info := &instInfo{ns: d.Namespace, name: d.Name, limits: map[string]contLimit{}}
		for _, ct := range d.Spec.Template.Spec.Containers {
			var cl contLimit
			if v, ok := ct.Resources.Limits[corev1.ResourceCPU]; ok {
				cl.cpuMilli = v.MilliValue()
			}
			if v, ok := ct.Resources.Limits[corev1.ResourceMemory]; ok {
				cl.memBytes = v.Value()
			}
			info.limits[ct.Name] = cl
		}
		app := d.Spec.Template.Labels["app"]
		if app == "" {
			app = d.Name
		}
		instances[d.Namespace+"|"+app] = info
		namespaces[d.Namespace] = true
	}

	now := time.Now().Unix()
	fresh := map[string]*InstanceMetrics{}
	anyOK := false
	for ns := range namespaces {
		raw, err := b.clientset.CoreV1().RESTClient().Get().
			AbsPath("/apis/metrics.k8s.io/v1beta1/namespaces/" + ns + "/pods").
			DoRaw(ctx)
		if err != nil {
			metrics.mu.Lock()
			metrics.lastErr = err.Error()
			metrics.mu.Unlock()
			continue
		}
		anyOK = true
		var pml podMetricsList
		if err := json.Unmarshal(raw, &pml); err != nil {
			continue
		}
		for _, pm := range pml.Items {
			info := instances[ns+"|"+pm.Metadata.Labels["app"]]
			if info == nil {
				continue
			}
			key := info.ns + "/" + info.name
			im := fresh[key]
			if im == nil {
				im = &InstanceMetrics{Namespace: info.ns, Name: info.name}
				fresh[key] = im
			}
			for _, ct := range pm.Containers {
				cpuQ := resource.MustParse(ct.Usage.CPU)
				memQ := resource.MustParse(ct.Usage.Memory)
				cpu := cpuQ.MilliValue()
				mem := memQ.Value()
				im.CPUMilli += cpu
				im.MemBytes += mem
				cl := info.limits[ct.Name]
				if cl.cpuMilli > 0 {
					im.CPULimitMilli += cl.cpuMilli
					if p := int(cpu * 100 / cl.cpuMilli); p > im.MaxCPUPct {
						im.MaxCPUPct = p
					}
				}
				if cl.memBytes > 0 {
					im.MemLimitBytes += cl.memBytes
					if p := int(mem * 100 / cl.memBytes); p > im.MaxMemPct {
						im.MaxMemPct = p
					}
				}
			}
		}
	}

	// OOM-kill flags: a container terminated OOMKilled within the last hour.
	oom := map[string]bool{}
	for ns := range namespaces {
		pods, err := b.clientset.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
			LabelSelector: "app.kubernetes.io/part-of=games",
		})
		if err != nil {
			continue
		}
		for i := range pods.Items {
			p := &pods.Items[i]
			info := instances[ns+"|"+p.Labels["app"]]
			if info == nil {
				continue
			}
			for _, cs := range p.Status.ContainerStatuses {
				lt := cs.LastTerminationState.Terminated
				if lt != nil && lt.Reason == "OOMKilled" &&
					time.Since(lt.FinishedAt.Time) < time.Hour {
					oom[info.ns+"/"+info.name] = true
				}
			}
		}
	}

	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	if metrics.byKey == nil {
		metrics.byKey = map[string]*InstanceMetrics{}
	}
	metrics.available = anyOK
	if anyOK {
		metrics.lastErr = ""
	}
	for key, im := range fresh {
		if im.MaxMemPct >= memAlertPct {
			im.Alerts = append(im.Alerts, "mem")
		}
		if im.MaxCPUPct >= cpuAlertPct {
			im.Alerts = append(im.Alerts, "cpu")
		}
		if oom[key] {
			im.Alerts = append(im.Alerts, "oom")
		}
		prev := metrics.byKey[key]
		if prev != nil {
			im.History = prev.History
		}
		im.History = append(im.History, MetricsSample{T: now, CPUMilli: im.CPUMilli, MemBytes: im.MemBytes})
		if len(im.History) > metricsHistoryLen {
			im.History = im.History[len(im.History)-metricsHistoryLen:]
		}
		metrics.byKey[key] = im
	}
	// Drop instances that no longer exist so deleted games don't linger.
	for key := range metrics.byKey {
		if _, ok := fresh[key]; !ok {
			delete(metrics.byKey, key)
		}
	}
	if !anyOK && metrics.lastErr != "" && !strings.Contains(metrics.lastErr, "the server could not find") {
		log.Printf("metrics: sample failed: %s", metrics.lastErr)
	}
}

// AllInstanceMetrics returns the latest sample for every instance (no
// history — the hub only needs current pressure).
func AllInstanceMetrics() (out []InstanceMetrics, available bool, lastErr string) {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	for _, im := range metrics.byKey {
		c := *im
		c.History = nil
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, metrics.available, metrics.lastErr
}

// InstanceMetricsFor returns the full history for one instance (nil if the
// sampler hasn't seen it).
func InstanceMetricsFor(ns, name string) *InstanceMetrics {
	metrics.mu.Lock()
	defer metrics.mu.Unlock()
	im := metrics.byKey[ns+"/"+name]
	if im == nil {
		return nil
	}
	c := *im
	c.History = append([]MetricsSample(nil), im.History...)
	return &c
}
