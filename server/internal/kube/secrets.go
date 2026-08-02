package kube

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// WriteSecret creates or updates an Opaque Secret with the given data keys.
// It is create-or-update (not server-side apply): if the Secret already
// exists, only the provided keys are overwritten — other keys are preserved.
//
// Used by the first-run admin setup flow to persist the JWT signing secret
// and the bcrypt users file into the gamectl-auth Secret so they survive
// pod restarts.
func (c *Cluster) WriteSecret(ctx context.Context, ns, name string, data map[string][]byte) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	secrets := b.clientset.CoreV1().Secrets(ns)

	existing, err := secrets.Get(ctx, name, metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err):
		_, err := secrets.Create(ctx, &corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
			Type:       corev1.SecretTypeOpaque,
			Data:       data,
		}, metav1.CreateOptions{})
		if err != nil {
			return fmt.Errorf("create secret %s/%s: %w", ns, name, err)
		}
		return nil
	case err != nil:
		return fmt.Errorf("get secret %s/%s: %w", ns, name, err)
	}

	if existing.Data == nil {
		existing.Data = map[string][]byte{}
	}
	for k, v := range data {
		existing.Data[k] = v
	}
	if _, err := secrets.Update(ctx, existing, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update secret %s/%s: %w", ns, name, err)
	}
	return nil
}

// DeleteSecretKey removes a single key from an existing Secret, leaving the
// rest of its data untouched. A missing Secret or missing key is not an
// error (idempotent) — the desired end state (key absent) already holds.
//
// Used to revoke the persisted Stats API secret: unlike WriteSecret's
// merge-only semantics, this actually erases the key so a restarted pod
// doesn't pick the old secret back up via its optional secretKeyRef.
func (c *Cluster) DeleteSecretKey(ctx context.Context, ns, name, key string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	secrets := b.clientset.CoreV1().Secrets(ns)

	existing, err := secrets.Get(ctx, name, metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err):
		return nil
	case err != nil:
		return fmt.Errorf("get secret %s/%s: %w", ns, name, err)
	}

	if _, ok := existing.Data[key]; !ok {
		return nil
	}
	delete(existing.Data, key)
	if _, err := secrets.Update(ctx, existing, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update secret %s/%s: %w", ns, name, err)
	}
	return nil
}
