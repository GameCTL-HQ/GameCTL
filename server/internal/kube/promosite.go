package kube

import (
	"context"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// PromositeName is the fixed Deployment/Service name for the optional
// bundled promotion site — one per GameCTL install, not per-instance, so
// unlike game deployments it isn't operator-named.
const PromositeName = "gamectl-promosite"

// PromositeInfo is the wire shape for GET /api/promosite/status.
type PromositeInfo struct {
	Deployed bool   `json:"deployed"`
	Image    string `json:"image,omitempty"`
	Ready    bool   `json:"ready"`
}

// PromositeStatus reports whether the promosite Deployment currently
// exists and is ready. Not an error for it to be absent — that's just
// "not deployed yet", the default state.
func (c *Cluster) PromositeStatus(ctx context.Context) (PromositeInfo, error) {
	b := c.snap()
	if b == nil {
		return PromositeInfo{}, ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(nsGamectl).Get(ctx, PromositeName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return PromositeInfo{}, nil
	}
	if err != nil {
		return PromositeInfo{}, err
	}
	image := ""
	if len(dep.Spec.Template.Spec.Containers) > 0 {
		image = dep.Spec.Template.Spec.Containers[0].Image
	}
	return PromositeInfo{
		Deployed: true,
		Image:    image,
		Ready:    dep.Status.ReadyReplicas > 0,
	}, nil
}

// DeletePromosite removes the promosite Deployment + Service. Idempotent —
// a missing object on either side is not an error.
func (c *Cluster) DeletePromosite(ctx context.Context) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	if err := b.clientset.AppsV1().Deployments(nsGamectl).Delete(ctx, PromositeName, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	if err := b.clientset.CoreV1().Services(nsGamectl).Delete(ctx, PromositeName, metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}
