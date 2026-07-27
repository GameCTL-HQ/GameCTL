package kube

import (
	"context"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// MetricsServerInstallCommand is what the UI tells the operator to run.
// GameCTL deliberately does NOT install metrics-server itself: doing so
// means applying cluster-scoped RBAC + an APIService from inside the pod,
// which would require GameCTL's own ServiceAccount to hold far more power
// than its shipped, namespace-confined Role (see the README). The
// operator runs this once with their own credentials instead.
const MetricsServerInstallCommand = "kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml"

// MetricsServerStatus is the wire shape behind GET /api/cluster/metrics-server.
// The UI shows an install hint only when Available is false and Unknown is
// false — i.e. when we positively determined the cluster can't serve metrics.
type MetricsServerStatus struct {
	Installed bool `json:"installed"` // metrics.k8s.io is registered on the API server
	Available bool `json:"available"` // ...and actually served a metrics read
	// Unknown means the check itself couldn't reach a verdict (RBAC or an
	// unexpected API error). The UI stays quiet rather than telling an
	// operator to install something they may already have.
	Unknown        bool   `json:"unknown"`
	Detail         string `json:"detail,omitempty"`
	Image          string `json:"image,omitempty"`
	InstallCommand string `json:"installCommand"`
}

func (c *Cluster) MetricsServerStatus(ctx context.Context) (MetricsServerStatus, error) {
	b := c.snap()
	if b == nil {
		return MetricsServerStatus{}, ErrNotConfigured
	}
	out := MetricsServerStatus{InstallCommand: MetricsServerInstallCommand}

	// Authoritative check: make the exact read the metrics sampler makes.
	// It needs only the namespaced metrics.k8s.io grant GameCTL already
	// ships with, so it works on a stock install — unlike inspecting the
	// kube-system Deployment or the APIService registry, which the shipped
	// RBAC deliberately does not allow (that check used to fail closed and
	// the UI never surfaced anything at all).
	_, err := b.clientset.CoreV1().RESTClient().Get().
		AbsPath("/apis/metrics.k8s.io/v1beta1/namespaces/" + nsGamectl + "/pods").
		DoRaw(ctx)
	switch {
	case err == nil:
		out.Installed = true
		out.Available = true
	case apierrors.IsNotFound(err), strings.Contains(err.Error(), "the server could not find"):
		out.Detail = "the metrics.k8s.io API is not registered on this cluster"
	case apierrors.IsServiceUnavailable(err), apierrors.IsTimeout(err), apierrors.IsInternalError(err):
		// Registered, but nothing is serving it — still rolling out, or
		// the metrics-server pod is unhealthy.
		out.Installed = true
		out.Detail = strings.TrimSpace(err.Error())
	case apierrors.IsForbidden(err):
		out.Unknown = true
		out.Detail = "GameCTL cannot read metrics.k8s.io in the " + nsGamectl + " namespace: " + err.Error()
	default:
		out.Unknown = true
		out.Detail = strings.TrimSpace(err.Error())
	}

	// Best-effort enrichment. Both of these are expected to fail with
	// Forbidden under the shipped RBAC, so nothing here is fatal and
	// nothing here can flip the verdict to "missing".
	if dep, derr := b.clientset.AppsV1().Deployments("kube-system").Get(ctx, "metrics-server", metav1.GetOptions{}); derr == nil {
		out.Installed = true
		out.Unknown = false
		if len(dep.Spec.Template.Spec.Containers) > 0 {
			out.Image = dep.Spec.Template.Spec.Containers[0].Image
		}
		if !out.Available && !deploymentReady(dep) && out.Detail == "" {
			out.Detail = "the metrics-server Deployment in kube-system has no available replicas yet"
		}
	}

	if out.Available {
		out.Detail = ""
		out.Unknown = false
	}
	return out, nil
}

func deploymentReady(dep *appsv1.Deployment) bool {
	if dep == nil {
		return false
	}
	if dep.Status.AvailableReplicas < 1 {
		return false
	}
	for _, c := range dep.Status.Conditions {
		if c.Type == appsv1.DeploymentAvailable && c.Status == "True" {
			return true
		}
	}
	return false
}
