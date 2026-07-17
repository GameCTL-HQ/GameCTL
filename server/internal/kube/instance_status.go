package kube

import (
	"context"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameCTL-HQ/GameCTL/server/internal/games"
)

// InstanceStatus is the wire shape for /api/games/instances/{ns}/{name}/status —
// a synthesized view that the UI can render directly into a status pill,
// restart count badge, and reason tooltip without having to combine fields from
// three other endpoints.
type InstanceStatus struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`

	Desired   int32 `json:"desired"`
	Ready     int32 `json:"ready"`
	Available int32 `json:"available"`

	Pods []PodSummary `json:"pods"`

	// Canonical label / color the UI should render. One of:
	//   stopped, pending, scheduling, pulling, starting, initializing,
	//   online, crashloop, errored, unknown
	Label       string `json:"label"`
	Color       string `json:"color"`       // grey | blue | orange | green | red
	LabelDetail string `json:"labelDetail"` // optional tail text (e.g. "6 restarts")

	// Connection address for end users (e.g. "10.0.0.168:25565") when a
	// LoadBalancer Service has been assigned an IP. Empty otherwise.
	Address string `json:"address,omitempty"`

	// Where this instance's data lives, read off the deployment's data volume:
	// "<nfs-server>:<path>" for an NFS location, or "<path> (local)" for a
	// host-path location. Surfaced on the Details screen for tracking. Empty if
	// no nfs/hostPath volume is found.
	Storage string `json:"storage,omitempty"`

	// Deep game-protocol health (MC ping, A2S, etc.) when a probe for this
	// game type is registered AND the service is reachable from the gamectl
	// pod. Nil if no probe is available or the deployment is scaled down.
	GameHealth *games.Health `json:"gameHealth,omitempty"`
}

// PodSummary is one row's worth of useful pod info — surface this in the
// expanded "Details" view so the operator can see crash reasons at a glance.
type PodSummary struct {
	Name                   string `json:"name"`
	Phase                  string `json:"phase"`
	Ready                  bool   `json:"ready"`
	RestartCount           int32  `json:"restartCount"`
	WaitReason             string `json:"waitReason,omitempty"`
	WaitMessage            string `json:"waitMessage,omitempty"`
	LastExitCode           int32  `json:"lastExitCode,omitempty"`
	LastTerminationReason  string `json:"lastTerminationReason,omitempty"`
	LastTerminationMessage string `json:"lastTerminationMessage,omitempty"`
	StartedAt              string `json:"startedAt,omitempty"`
	Node                   string `json:"node,omitempty"`
	IP                     string `json:"ip,omitempty"`
}

// storagePath returns a human-readable data location from a pod's volumes:
// "<server>:<path>" for an inline NFS volume or "<path> (local)" for a
// hostPath volume. Prefers the conventional "data" volume, else the first
// nfs/hostPath volume found. Returns "" if none (e.g. config-only pods).
func storagePath(vols []corev1.Volume) string {
	pick := func(v corev1.Volume) string {
		switch {
		case v.NFS != nil:
			return v.NFS.Server + ":" + v.NFS.Path
		case v.HostPath != nil:
			return v.HostPath.Path + " (local)"
		}
		return ""
	}
	for _, v := range vols {
		if v.Name == "data" {
			if s := pick(v); s != "" {
				return s
			}
		}
	}
	for _, v := range vols {
		if s := pick(v); s != "" {
			return s
		}
	}
	return ""
}

// InstanceStatus computes a rich status for one deployment instance.
func (c *Cluster) InstanceStatus(ctx context.Context, ns, name string) (InstanceStatus, error) {
	b := c.snap()
	if b == nil {
		return InstanceStatus{}, ErrNotConfigured
	}

	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return InstanceStatus{}, err
	}

	out := InstanceStatus{
		Namespace: ns,
		Name:      name,
		Available: dep.Status.AvailableReplicas,
		Ready:     dep.Status.ReadyReplicas,
	}
	if dep.Spec.Replicas != nil {
		out.Desired = *dep.Spec.Replicas
	} else {
		out.Desired = 1
	}
	out.Storage = storagePath(dep.Spec.Template.Spec.Volumes)

	pods, err := b.clientset.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("app=%s", name),
	})
	if err != nil {
		return InstanceStatus{}, err
	}
	for _, p := range pods.Items {
		ps := PodSummary{
			Name:  p.Name,
			Phase: string(p.Status.Phase),
			Ready: allContainersReady(p.Status.ContainerStatuses),
			Node:  p.Spec.NodeName,
			IP:    p.Status.PodIP,
		}
		if p.Status.StartTime != nil {
			ps.StartedAt = p.Status.StartTime.UTC().Format("2006-01-02T15:04:05Z")
		}
		// First container only (game servers run one container per pod).
		if len(p.Status.ContainerStatuses) > 0 {
			cs := p.Status.ContainerStatuses[0]
			ps.RestartCount = cs.RestartCount
			if cs.State.Waiting != nil {
				ps.WaitReason = cs.State.Waiting.Reason
				ps.WaitMessage = cs.State.Waiting.Message
			}
			if cs.LastTerminationState.Terminated != nil {
				t := cs.LastTerminationState.Terminated
				ps.LastExitCode = t.ExitCode
				ps.LastTerminationReason = t.Reason
				ps.LastTerminationMessage = t.Message
			}
		}
		out.Pods = append(out.Pods, ps)
	}

	// Resolve the Service. Try, in order:
	//   1. exact name "<deploy>-service"  (matches valheim-service, factorio-service)
	//   2. exact name "<deploy>"          (matches gamectl, minecraft)
	//   3. selector-match: list services in ns, find one whose .spec.selector
	//      matches the Deployment's pod template labels (the canonical
	//      Service→Deployment relationship — works even when the Service has
	//      no labels of its own, as is the case for valheim-service)
	var svc *corev1.Service
	for _, candidate := range []string{name + "-service", name} {
		s, err := b.clientset.CoreV1().Services(ns).Get(ctx, candidate, metav1.GetOptions{})
		if err == nil {
			svc = s
			break
		}
		if !apierrors.IsNotFound(err) {
			break
		}
	}
	if svc == nil {
		list, err := b.clientset.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
		if err == nil {
			podLabels := dep.Spec.Template.Labels
			for i := range list.Items {
				if serviceTargets(list.Items[i].Spec.Selector, podLabels) {
					svc = &list.Items[i]
					break
				}
			}
		}
	}
	if svc != nil {
		out.Address = lbAddr(svc.Status.LoadBalancer.Ingress, svc.Spec.Ports)
	}

	out.Label, out.Color, out.LabelDetail = synthesizeLabel(out)

	// Deep game-health probe (best-effort, short timeout — never blocks the
	// status response for long). Only when pods are actually ready, we have a
	// Service, and a registered probe + a port matching the probe's protocol.
	//
	// 5s, not 2s: Source/A2S (CS2 et al.) needs a challenge round-trip, and
	// over kube ClusterIP UDP a healthy CS2 measured ~3-4s end to end — 2s
	// false-negatived it as "not responding". Healthy probes still return
	// in well under this; the budget only bites when a game is actually down.
	if out.Ready > 0 && svc != nil && len(svc.Spec.Ports) > 0 {
		gameKey := dep.Labels["game"]
		if gameKey == "" {
			gameKey = dep.Spec.Template.Labels["game"]
		}
		if gameKey != "" {
			if probePort, ok := pickProbePort(svc.Spec.Ports, games.Hint(gameKey)); ok {
				probeAddr := fmt.Sprintf("%s:%d", svc.Spec.ClusterIP, probePort)
				probeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
				defer cancel()
				out.GameHealth = games.Probe(probeCtx, gameKey, probeAddr, 5*time.Second)
			}
		}
	}

	return out, nil
}

// serviceTargets reports whether a Service's selector (subset) would route
// to a pod with the given labels — i.e. whether this Service "owns" this
// Deployment. Returns false for selectors that are empty (those Services
// don't target anything in particular).
func serviceTargets(selector, podLabels map[string]string) bool {
	if len(selector) == 0 {
		return false
	}
	for k, v := range selector {
		if podLabels[k] != v {
			return false
		}
	}
	return true
}

// pickProbePort selects the right Service port for a probe based on a hint:
//  1. exact match on port name AND protocol, if both specified
//  2. exact match on port name only
//  3. first port matching the requested protocol
//  4. fall back to first port (no hint)
func pickProbePort(ports []corev1.ServicePort, h games.PortHint) (int32, bool) {
	if len(ports) == 0 {
		return 0, false
	}
	if h.PortName != "" && h.Protocol != "" {
		for _, p := range ports {
			if p.Name == h.PortName && string(p.Protocol) == h.Protocol {
				return p.Port, true
			}
		}
	}
	if h.PortName != "" {
		for _, p := range ports {
			if p.Name == h.PortName {
				return p.Port, true
			}
		}
	}
	if h.Protocol != "" {
		for _, p := range ports {
			if string(p.Protocol) == h.Protocol {
				return p.Port, true
			}
		}
		// Requested protocol not available — skip probe rather than misfire.
		return 0, false
	}
	return ports[0].Port, true
}

// synthesizeLabel maps a status snapshot to (label, color, detail) so the UI
// can render a consistent pill without doing decision logic of its own.
func synthesizeLabel(s InstanceStatus) (label, color, detail string) {
	if s.Desired == 0 {
		return "Stopped", "grey", ""
	}
	if len(s.Pods) == 0 {
		return "Pending", "grey", "no pods yet"
	}
	// Aggregate worst-case across pods. For single-replica deployments this is
	// trivially the one pod's state.
	maxRestarts := int32(0)
	for _, p := range s.Pods {
		if p.RestartCount > maxRestarts {
			maxRestarts = p.RestartCount
		}
		switch p.WaitReason {
		case "CrashLoopBackOff":
			d := fmt.Sprintf("%d restarts", p.RestartCount)
			if p.LastTerminationReason != "" {
				d = fmt.Sprintf("%d restarts · %s", p.RestartCount, p.LastTerminationReason)
			}
			return "Crash loop", "red", d
		case "ImagePullBackOff", "ErrImagePull":
			return "Image pull failed", "red", p.WaitMessage
		case "ContainerCreating":
			return "Starting", "blue", "creating container"
		case "PodInitializing":
			return "Starting", "blue", "initializing"
		case "CreateContainerConfigError", "CreateContainerError":
			return "Errored", "red", p.WaitReason
		}
		if p.Phase == "Failed" {
			return "Errored", "red", p.LastTerminationReason
		}
		if p.Phase == "Pending" {
			return "Scheduling", "grey", ""
		}
	}
	// All pods at least Running. Check readiness for "Online" vs "Initializing".
	if s.Ready >= s.Desired {
		detail := ""
		if maxRestarts > 0 {
			detail = fmt.Sprintf("%d restarts since launch", maxRestarts)
		}
		return "Online", "green", detail
	}
	if s.Ready > 0 {
		return "Partial", "orange", fmt.Sprintf("%d/%d ready", s.Ready, s.Desired)
	}
	// Running but not ready — game still loading, or no readiness probe.
	return "Initializing", "orange", "container up, game not ready"
}

func lbAddr(ingress []corev1.LoadBalancerIngress, ports []corev1.ServicePort) string {
	if len(ingress) == 0 || ingress[0].IP == "" {
		return ""
	}
	host := ingress[0].IP
	if len(ports) > 0 {
		return fmt.Sprintf("%s:%d", host, ports[0].Port)
	}
	return host
}
