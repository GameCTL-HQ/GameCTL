package kube

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// Drift detection + repair for the Restart deadlock.
//
// A single-replica, volume-backed game server must use strategy: Recreate.
// On the default RollingUpdate, Kubernetes schedules the replacement pod
// BEFORE terminating the old one, so a Restart needs a second copy of the
// server's CPU/RAM while the old pod still holds it — on a homelab without
// that headroom the new pod sits Pending forever and Restart looks hung.
// Both pods also mount the same save data for the overlap, and on a
// ReadWriteOnce volume the new pod can't attach at all.
//
// The generators and the apply-time normalizer handle this for anything
// deployed from now on. Instances deployed BEFORE that fix still carry
// RollingUpdate in the cluster, and nothing repairs them implicitly:
// Restart only patches the pod template (see RestartInstance), so it keeps
// whatever strategy is already there. This lets the UI find them and fix
// them in one click.

// RolloutStrategyIssue is one instance still on a strategy that will
// deadlock its next Restart.
type RolloutStrategyIssue struct {
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	Game      string `json:"game,omitempty"`
	Strategy  string `json:"strategy"` // what it has today, e.g. "RollingUpdate"
	Running   bool   `json:"running"`  // scaled up right now
}

// deploymentNeedsRecreate reports whether a live Deployment matches the
// rule and isn't already on Recreate.
func deploymentNeedsRecreate(d *appsv1.Deployment) bool {
	if d.Spec.Strategy.Type == appsv1.RecreateDeploymentStrategyType {
		return false
	}
	singleReplica := d.Spec.Replicas == nil || *d.Spec.Replicas <= 1
	hasVolumes := len(d.Spec.Template.Spec.Volumes) > 0
	return NeedsRecreateStrategy(singleReplica, hasVolumes)
}

// InstancesNeedingRecreate lists game instances whose next Restart would
// double-book their resources. Empty slice (not nil) when everything is
// healthy, so the UI can render "nothing to do" without a null check.
func (c *Cluster) InstancesNeedingRecreate(ctx context.Context) ([]RolloutStrategyIssue, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	deps, err := b.clientset.AppsV1().Deployments(nsGamectl).List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/part-of=games",
	})
	if err != nil {
		return nil, fmt.Errorf("list game deployments: %w", err)
	}
	out := []RolloutStrategyIssue{}
	for i := range deps.Items {
		d := &deps.Items[i]
		if !deploymentNeedsRecreate(d) {
			continue
		}
		game := d.Labels["game"]
		if game == "" {
			game = d.Spec.Template.Labels["game"]
		}
		strategy := string(d.Spec.Strategy.Type)
		if strategy == "" {
			strategy = string(appsv1.RollingUpdateDeploymentStrategyType) // the API default
		}
		out = append(out, RolloutStrategyIssue{
			Namespace: d.Namespace,
			Name:      d.Name,
			Game:      game,
			Strategy:  strategy,
			Running:   d.Status.AvailableReplicas > 0,
		})
	}
	return out, nil
}

// FixRolloutStrategy switches one instance to Recreate.
//
// A JSON merge patch, NOT a server-side apply: the API server DEFAULTS
// spec.strategy.rollingUpdate (maxSurge/maxUnavailable) onto every
// RollingUpdate Deployment, and it rejects the object if that block
// survives alongside type: Recreate ("may not be specified when strategy
// `type` is 'Recreate'"). Merge patch deletes on null; apply drops nulls.
//
// Non-disruptive by design: spec.strategy lives outside the pod template,
// so changing it creates no new ReplicaSet and restarts nothing. It only
// changes how the NEXT restart behaves.
func (c *Cluster) FixRolloutStrategy(ctx context.Context, ns, name string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	const patch = `{"spec":{"strategy":{"type":"Recreate","rollingUpdate":null}}}`
	_, err := b.clientset.AppsV1().Deployments(ns).Patch(
		ctx, name, types.MergePatchType, []byte(patch), metav1.PatchOptions{FieldManager: fieldManager})
	if err != nil {
		return fmt.Errorf("patch %s/%s strategy: %w", ns, name, err)
	}
	return nil
}

// FixAllRolloutStrategies repairs every affected instance, returning the
// names it fixed. Partial failure is reported alongside what did land — one
// RBAC-denied instance shouldn't hide that the other three are now fine.
func (c *Cluster) FixAllRolloutStrategies(ctx context.Context) ([]string, error) {
	issues, err := c.InstancesNeedingRecreate(ctx)
	if err != nil {
		return nil, err
	}
	fixed := []string{}
	var firstErr error
	for _, is := range issues {
		if err := c.FixRolloutStrategy(ctx, is.Namespace, is.Name); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		fixed = append(fixed, is.Name)
	}
	return fixed, firstErr
}
