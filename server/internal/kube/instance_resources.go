package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/types"
)

// Editable CPU/RAM requests+limits for a game instance's primary container.
//
// Semantics (mirrors the auto-update toggle): applying a change
//  1. live-resizes the RUNNING pod via the "resize" subresource (K8s >= 1.33
//     in-place vertical scaling — no restart, players stay connected), and
//  2. records the desired values in a Deployment METADATA annotation, which
//     does not roll pods; RestartInstance folds them into the pod template on
//     the next explicit restart so the change survives rescheduling.
//
// A straight template patch would always bounce the server (Deployment
// template changes trigger a rollout, Recreate = downtime); this split gets
// the change active immediately AND durable, at the cost of a visible
// "pending restart" state. Live resize can fail (older clusters, memory
// limit decreases, node out of headroom) — then the annotation alone is
// saved and the UI says "applies on next restart".
const resourcesAnno = "gamectl.io/resources"

// InstanceResources is the wire shape for GET/POST .../resources.
type InstanceResources struct {
	Container  string `json:"container"`
	CPURequest string `json:"cpuRequest"`
	CPULimit   string `json:"cpuLimit"`
	MemRequest string `json:"memRequest"`
	MemLimit   string `json:"memLimit"`
	// Pending: the desired (annotation) values differ from the pod
	// template — a restart will bake them in.
	Pending bool `json:"pending"`
}

func resourcesFromContainer(ct *corev1.Container) InstanceResources {
	get := func(rl corev1.ResourceList, k corev1.ResourceName) string {
		if v, ok := rl[k]; ok {
			return v.String()
		}
		return ""
	}
	return InstanceResources{
		Container:  ct.Name,
		CPURequest: get(ct.Resources.Requests, corev1.ResourceCPU),
		CPULimit:   get(ct.Resources.Limits, corev1.ResourceCPU),
		MemRequest: get(ct.Resources.Requests, corev1.ResourceMemory),
		MemLimit:   get(ct.Resources.Limits, corev1.ResourceMemory),
	}
}

// InstanceResources returns the primary container's resources: the desired
// (annotation) values when a change is pending, else the template's.
func (c *Cluster) InstanceResources(ctx context.Context, ns, name string) (InstanceResources, error) {
	b := c.snap()
	if b == nil {
		return InstanceResources{}, ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return InstanceResources{}, err
	}
	conts := dep.Spec.Template.Spec.Containers
	if len(conts) == 0 {
		return InstanceResources{}, fmt.Errorf("deployment %s/%s has no containers", ns, name)
	}
	cur := resourcesFromContainer(&conts[0])
	if raw, ok := dep.Annotations[resourcesAnno]; ok {
		var want InstanceResources
		if json.Unmarshal([]byte(raw), &want) == nil && want.Container == conts[0].Name {
			want.Pending = want != InstanceResources{Container: cur.Container,
				CPURequest: cur.CPURequest, CPULimit: cur.CPULimit,
				MemRequest: cur.MemRequest, MemLimit: cur.MemLimit}
			return want, nil
		}
	}
	return cur, nil
}

// validateResources parses and sanity-checks the four quantities.
func validateResources(r InstanceResources) (reqs, lims corev1.ResourceList, err error) {
	parse := func(field, s string) (resource.Quantity, error) {
		q, err := resource.ParseQuantity(strings.TrimSpace(s))
		if err != nil {
			return q, fmt.Errorf("%s %q is not a valid quantity (examples: cpu \"500m\" or \"2\", memory \"2Gi\")", field, s)
		}
		if q.Sign() <= 0 {
			return q, fmt.Errorf("%s must be positive", field)
		}
		return q, nil
	}
	cpuReq, err := parse("cpu request", r.CPURequest)
	if err != nil {
		return nil, nil, err
	}
	cpuLim, err := parse("cpu limit", r.CPULimit)
	if err != nil {
		return nil, nil, err
	}
	memReq, err := parse("memory request", r.MemRequest)
	if err != nil {
		return nil, nil, err
	}
	memLim, err := parse("memory limit", r.MemLimit)
	if err != nil {
		return nil, nil, err
	}
	if cpuReq.Cmp(cpuLim) > 0 {
		return nil, nil, fmt.Errorf("cpu request (%s) cannot exceed the cpu limit (%s)", cpuReq.String(), cpuLim.String())
	}
	if memReq.Cmp(memLim) > 0 {
		return nil, nil, fmt.Errorf("memory request (%s) cannot exceed the memory limit (%s)", memReq.String(), memLim.String())
	}
	return corev1.ResourceList{corev1.ResourceCPU: cpuReq, corev1.ResourceMemory: memReq},
		corev1.ResourceList{corev1.ResourceCPU: cpuLim, corev1.ResourceMemory: memLim}, nil
}

// SetInstanceResources saves the desired resources (annotation, no rollout)
// and attempts an in-place resize of the running pod(s). liveErr is set when
// the live resize part failed but the desired state was still recorded.
func (c *Cluster) SetInstanceResources(ctx context.Context, ns, name string, r InstanceResources) (liveApplied bool, liveErr string, err error) {
	b := c.snap()
	if b == nil {
		return false, "", ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false, "", err
	}
	conts := dep.Spec.Template.Spec.Containers
	if len(conts) == 0 {
		return false, "", fmt.Errorf("deployment %s/%s has no containers", ns, name)
	}
	reqs, lims, err := validateResources(r)
	if err != nil {
		return false, "", err
	}
	r.Container = conts[0].Name
	r.Pending = false

	// 1. Record the desired state — metadata only, never rolls the pod.
	raw, _ := json.Marshal(r)
	annoPatch, _ := json.Marshal(map[string]any{
		"metadata": map[string]any{"annotations": map[string]string{resourcesAnno: string(raw)}},
	})
	if _, err := b.clientset.AppsV1().Deployments(ns).Patch(
		ctx, name, types.StrategicMergePatchType, annoPatch, metav1.PatchOptions{}); err != nil {
		return false, "", err
	}

	// 2. Best-effort live resize of every running pod of the instance.
	app := dep.Spec.Template.Labels["app"]
	if app == "" {
		app = name
	}
	pods, err := b.clientset.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: "app=" + app})
	if err != nil || len(pods.Items) == 0 {
		return false, "no running pod found to resize live", nil
	}
	resizeBody, _ := json.Marshal(map[string]any{
		"spec": map[string]any{"containers": []map[string]any{{
			"name": r.Container,
			"resources": map[string]any{
				"requests": map[string]string{"cpu": reqs.Cpu().String(), "memory": reqs.Memory().String()},
				"limits":   map[string]string{"cpu": lims.Cpu().String(), "memory": lims.Memory().String()},
			},
		}}},
	})
	resized := 0
	for i := range pods.Items {
		p := &pods.Items[i]
		if p.Status.Phase != corev1.PodRunning {
			continue
		}
		if _, err := b.clientset.CoreV1().Pods(ns).Patch(
			ctx, p.Name, types.StrategicMergePatchType, resizeBody,
			metav1.PatchOptions{}, "resize"); err != nil {
			liveErr = err.Error()
			continue
		}
		resized++
	}
	return resized > 0, liveErr, nil
}
