package kube

import (
	"context"
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// The ProxyCTL link (URL + operator credentials) persists in a Secret so it
// survives pod restarts, same as the auth Secret. ProxyCTL has no
// service-account tokens — the link is a normal operator login, which is
// why this lives in a Secret and the password is never echoed back by the
// API (see httpapi/proxyctl_handlers.go).
const (
	proxyctlSecretNS   = "gamectl"
	proxyctlSecretName = "gamectl-proxyctl"
)

// ProxyCTLLink is the stored connection to a sibling ProxyCTL install.
type ProxyCTLLink struct {
	URL      string `json:"url"`
	Username string `json:"username"`
	Password string `json:"password,omitempty"`
}

// ProxyCTLLink returns the stored link, or nil (no error) when none is
// configured yet.
func (c *Cluster) ProxyCTLLink(ctx context.Context) (*ProxyCTLLink, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	sec, err := b.clientset.CoreV1().Secrets(proxyctlSecretNS).Get(ctx, proxyctlSecretName, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return nil, nil
		}
		return nil, err
	}
	l := &ProxyCTLLink{
		URL:      string(sec.Data["url"]),
		Username: string(sec.Data["username"]),
		Password: string(sec.Data["password"]),
	}
	if strings.TrimSpace(l.Username) == "" {
		return nil, nil
	}
	return l, nil
}

// SetProxyCTLLink persists the link Secret (create-or-update).
func (c *Cluster) SetProxyCTLLink(ctx context.Context, l ProxyCTLLink) error {
	return c.WriteSecret(ctx, proxyctlSecretNS, proxyctlSecretName, map[string][]byte{
		"url":      []byte(strings.TrimSpace(l.URL)),
		"username": []byte(strings.TrimSpace(l.Username)),
		"password": []byte(l.Password),
	})
}

// DeleteProxyCTLLink removes the stored link. Missing is not an error.
func (c *Cluster) DeleteProxyCTLLink(ctx context.Context) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	err := b.clientset.CoreV1().Secrets(proxyctlSecretNS).Delete(ctx, proxyctlSecretName, metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// InstanceServices returns every Service that belongs to a game instance,
// primary first. An instance can expose more than one bindable address:
//
//   - Service(s) selecting the instance's pods — the game Service itself,
//     plus sidecar-port Services like Minecraft's "<name>-bluemap-service"
//     (same pod selector, different port).
//   - Companion Services named "<name>-<suffix>" that run their own
//     workload — e.g. the CS2 surf-records website "<name>-records", which
//     matches no pod of the instance. These are only claimed when they
//     carry the managed-by=gamectl label AND no other games instance has a
//     longer name match (instance "cs2" must not scoop "cs2-2"'s
//     Services).
func (c *Cluster) InstanceServices(ctx context.Context, ns, name string) ([]corev1.Service, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("deployment %s/%s: %w", ns, name, err)
	}
	podLabels := dep.Spec.Template.Labels

	svcs, err := b.clientset.CoreV1().Services(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	// Sibling instance names, for the prefix-ownership check.
	siblings := map[string]bool{}
	if deps, err := b.clientset.AppsV1().Deployments(ns).List(ctx, metav1.ListOptions{
		LabelSelector: "app.kubernetes.io/part-of=games",
	}); err == nil {
		for _, d := range deps.Items {
			siblings[d.Name] = true
		}
	}
	ownsPrefixed := func(svcName string) bool {
		if !strings.HasPrefix(svcName, name+"-") {
			return false
		}
		for other := range siblings {
			if other == name || len(other) <= len(name) {
				continue
			}
			if svcName == other || strings.HasPrefix(svcName, other+"-") {
				return false
			}
		}
		return true
	}

	var primary *corev1.Service
	var rest []corev1.Service
	for i := range svcs.Items {
		s := svcs.Items[i]
		selected := serviceTargets(s.Spec.Selector, podLabels)
		companion := s.Labels["app.kubernetes.io/managed-by"] == "gamectl" && ownsPrefixed(s.Name)
		if !selected && !companion && s.Name != name {
			continue
		}
		if s.Name == name || s.Name == name+"-service" {
			p := s
			primary = &p
			continue
		}
		rest = append(rest, s)
	}
	sort.Slice(rest, func(i, j int) bool { return rest[i].Name < rest[j].Name })
	out := make([]corev1.Service, 0, len(rest)+1)
	if primary != nil {
		out = append(out, *primary)
	} else if len(rest) > 0 && serviceTargets(rest[0].Spec.Selector, podLabels) {
		// No name-matched Service; promote the first selector-matched one.
		out, rest = append(out, rest[0]), rest[1:]
	}
	out = append(out, rest...)
	if len(out) == 0 {
		return nil, fmt.Errorf("no Service found for %s/%s", ns, name)
	}
	return out, nil
}
