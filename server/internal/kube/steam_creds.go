package kube

import (
	"context"
	"fmt"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Steam credential Secret keys. Deployments that need a logged-in SteamCMD
// reference these via secretKeyRef (the ich777 steamcmd images read
// USERNAME / PASSWRD env).
const (
	SteamSecretUserKey = "username"
	SteamSecretPassKey = "password"
)

// SteamCredsStatus reports whether the shared Steam Secret exists and, if
// so, the username — never the password (write-only by design).
type SteamCredsStatus struct {
	Configured bool   `json:"configured"`
	Username   string `json:"username,omitempty"`
}

// SteamCredsStatus reads the shared Steam Secret's status. A missing Secret
// is not an error — it just means "not configured yet".
func (c *Cluster) SteamCredsStatus(ctx context.Context, ns, name string) (SteamCredsStatus, error) {
	b := c.snap()
	if b == nil {
		return SteamCredsStatus{}, ErrNotConfigured
	}
	s, err := b.clientset.CoreV1().Secrets(ns).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return SteamCredsStatus{Configured: false}, nil
	}
	if err != nil {
		return SteamCredsStatus{}, fmt.Errorf("get secret %s/%s: %w", ns, name, err)
	}
	u := string(s.Data[SteamSecretUserKey])
	return SteamCredsStatus{Configured: u != "" && len(s.Data[SteamSecretPassKey]) > 0, Username: u}, nil
}

// SetSteamCreds writes the shared Steam username/password Secret (create or
// update). Reuses WriteSecret so other keys (if any) are preserved.
func (c *Cluster) SetSteamCreds(ctx context.Context, ns, name, username, password string) error {
	if username == "" || password == "" {
		return fmt.Errorf("steam username and password are both required")
	}
	return c.WriteSecret(ctx, ns, name, map[string][]byte{
		SteamSecretUserKey: []byte(username),
		SteamSecretPassKey: []byte(password),
	})
}

// ClearSteamCreds deletes the shared Steam Secret. A missing Secret is a
// no-op (idempotent).
func (c *Cluster) ClearSteamCreds(ctx context.Context, ns, name string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	err := b.clientset.CoreV1().Secrets(ns).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		return fmt.Errorf("delete secret %s/%s: %w", ns, name, err)
	}
	return nil
}
