package kube

import (
	"context"
	"errors"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Pod is the wire shape for /kube/pods (matches the Python originals byte-for-byte).
type Pod struct {
	Ns     string            `json:"ns"`
	Name   string            `json:"name"`
	Phase  string            `json:"phase"`
	IP     string            `json:"ip"`
	Node   string            `json:"node"`
	Labels map[string]string `json:"labels"`
}

// Deployment is the wire shape for /games/instances deployments[].
type Deployment struct {
	Ns            string            `json:"ns"`
	Name          string            `json:"name"`
	Labels        map[string]string `json:"labels"`
	Replicas      int32             `json:"replicas"`
	ReadyReplicas int32             `json:"readyReplicas"`
}

// Service is the wire shape for /games/instances services[].
type Service struct {
	Ns     string            `json:"ns"`
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels"`
}

// Instances is the wire shape for /games/instances.
type Instances struct {
	Deployments []Deployment `json:"deployments"`
	Services    []Service    `json:"services"`
}

// InstancePod is the wire shape for /games/instances/{ns}/{name}/pods.
type InstancePod struct {
	Name      string  `json:"name"`
	Phase     string  `json:"phase"`
	Ready     bool    `json:"ready"`
	Restarts  int32   `json:"restarts"`
	IP        string  `json:"ip"`
	Node      string  `json:"node"`
	StartedAt *string `json:"startedAt"`
}

// ErrNotConfigured is returned by methods when the cluster has no live client bundle.
var ErrNotConfigured = errors.New("kubernetes client not configured")

// Namespaces returns the single namespace GameCTL operates in. Post-hardening
// GameCTL has a namespaced Role (no cluster-wide namespace list/get), and
// every game lives in `gamectl`, so this is constant by design.
func (c *Cluster) Namespaces(ctx context.Context) ([]string, error) {
	return []string{nsGamectl}, nil
}

// Pods lists pods in the given namespace, or all namespaces when ns == "".
func (c *Cluster) Pods(ctx context.Context, ns string) ([]Pod, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	// Namespaced Role: list within gamectl, never cluster-wide.
	if ns == "" {
		ns = nsGamectl
	}
	list, err := b.clientset.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	items := list.Items
	out := make([]Pod, 0, len(items))
	for _, p := range items {
		out = append(out, Pod{
			Ns:     p.Namespace,
			Name:   p.Name,
			Phase:  string(p.Status.Phase),
			IP:     p.Status.PodIP,
			Node:   p.Spec.NodeName,
			Labels: nonNilLabels(p.Labels),
		})
	}
	return out, nil
}

// Instances returns Deployments and Services across all namespaces matching the label selector.
// labelSelector defaults to "app.kubernetes.io/part-of=games" if empty.
func (c *Cluster) Instances(ctx context.Context, labelSelector string) (Instances, error) {
	b := c.snap()
	if b == nil {
		return Instances{}, ErrNotConfigured
	}
	if labelSelector == "" {
		labelSelector = "app.kubernetes.io/part-of=games"
	}
	opts := metav1.ListOptions{LabelSelector: labelSelector}

	// Namespaced Role: everything GameCTL manages lives in `gamectl`.
	deps, err := b.clientset.AppsV1().Deployments(nsGamectl).List(ctx, opts)
	if err != nil {
		return Instances{}, err
	}
	svcs, err := b.clientset.CoreV1().Services(nsGamectl).List(ctx, opts)
	if err != nil {
		return Instances{}, err
	}

	out := Instances{
		Deployments: make([]Deployment, 0, len(deps.Items)),
		Services:    make([]Service, 0, len(svcs.Items)),
	}
	for _, d := range deps.Items {
		var replicas int32 = 1
		if d.Spec.Replicas != nil {
			replicas = *d.Spec.Replicas
		}
		out.Deployments = append(out.Deployments, Deployment{
			Ns:            d.Namespace,
			Name:          d.Name,
			Labels:        nonNilLabels(d.Labels),
			Replicas:      replicas,
			ReadyReplicas: d.Status.ReadyReplicas,
		})
	}
	for _, s := range svcs.Items {
		out.Services = append(out.Services, Service{
			Ns:     s.Namespace,
			Name:   s.Name,
			Labels: nonNilLabels(s.Labels),
		})
	}
	return out, nil
}

// InstancePods lists pods belonging to the deployment named `name` in `ns`,
// matched via label selector `app=<name>` (matches the Python implementation).
func (c *Cluster) InstancePods(ctx context.Context, ns, name string) ([]InstancePod, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	list, err := b.clientset.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("app=%s", name),
	})
	if err != nil {
		return nil, err
	}
	out := make([]InstancePod, 0, len(list.Items))
	for _, p := range list.Items {
		out = append(out, InstancePod{
			Name:      p.Name,
			Phase:     string(p.Status.Phase),
			Ready:     allContainersReady(p.Status.ContainerStatuses),
			Restarts:  sumRestarts(p.Status.ContainerStatuses),
			IP:        p.Status.PodIP,
			Node:      p.Spec.NodeName,
			StartedAt: startedAt(p.Status.StartTime),
		})
	}
	return out, nil
}

// InstanceLogs returns the tail of logs from the first pod matching `app=<name>` in `ns`.
// Returns ("", "", nil) when no pod is found, matching the Python behavior.
//
// Multi-container pods (cs2 ships with a workshop-downloader sidecar) cause
// the k8s API to return BadRequest when no container is named — `kubectl
// logs` papers over this client-side by defaulting to the first one, but
// the Go client does not. We pick the container whose name matches the
// pod's `app` label (the workload's primary container) and fall back to
// the first non-init container if there's no match.
func (c *Cluster) InstanceLogs(ctx context.Context, ns, name string, tail int64) (string, string, error) {
	b := c.snap()
	if b == nil {
		return "", "", ErrNotConfigured
	}
	pods, err := b.clientset.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{
		LabelSelector: fmt.Sprintf("app=%s", name),
	})
	if err != nil {
		return "", "", err
	}
	if len(pods.Items) == 0 {
		return "", "", nil
	}
	p := pods.Items[0]
	container := ""
	for _, c := range p.Spec.Containers {
		if c.Name == name {
			container = c.Name
			break
		}
	}
	if container == "" && len(p.Spec.Containers) > 0 {
		container = p.Spec.Containers[0].Name
	}
	req := b.clientset.CoreV1().Pods(ns).GetLogs(p.Name, &corev1.PodLogOptions{
		TailLines: &tail,
		Container: container,
	})
	body, err := req.DoRaw(ctx)
	if err != nil {
		return "", p.Name, err
	}
	return string(body), p.Name, nil
}

// --- helpers ---

func nonNilLabels(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

func allContainersReady(cs []corev1.ContainerStatus) bool {
	for _, c := range cs {
		if !c.Ready {
			return false
		}
	}
	return true
}

func sumRestarts(cs []corev1.ContainerStatus) int32 {
	var n int32
	for _, c := range cs {
		n += c.RestartCount
	}
	return n
}

func startedAt(t *metav1.Time) *string {
	if t == nil {
		return nil
	}
	s := t.UTC().Format("2006-01-02T15:04:05+00:00")
	return &s
}

// AsAPIError extracts a Kubernetes API error if present, returning its HTTP status code
// and a wire message. Falls back to 500 + err.Error() for non-API errors.
// 503 is returned for ErrNotConfigured so handlers can pass through unchanged.
func AsAPIError(err error) (int, string) {
	if err == nil {
		return 0, ""
	}
	if errors.Is(err, ErrNotConfigured) {
		return 503, "Kubernetes client not configured. Provide GAMECTL_KUBECONFIG, run in-cluster, or upload a kubeconfig."
	}
	var se *apierrors.StatusError
	if errors.As(err, &se) {
		code := int(se.ErrStatus.Code)
		if code == 0 {
			code = 500
		}
		msg := se.ErrStatus.Message
		if msg == "" {
			msg = se.Error()
		}
		return code, msg
	}
	return 500, err.Error()
}
