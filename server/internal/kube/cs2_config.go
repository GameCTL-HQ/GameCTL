package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/GameCTL-HQ/GameCTL/server/internal/games"
)

// CS2 per-server settings that need to survive a pod recreate but aren't
// part of the deployment spec: welcome message + hostname. Mirrors the
// cs2-<server>-admins pattern — the canonical copy lives in a ConfigMap
// (cs2-<server>-config) the gen-config init container reads at boot and
// uses to override the wizard's baked-in defaults.

const (
	cs2ConfigWelcomeKey  = "welcome_message"
	cs2ConfigHostnameKey = "hostname"
	cs2GameCtlRtvJSON    = "/home/steam/cs2/game/csgo/addons/counterstrikesharp/configs/plugins/GameCtlRtv/GameCtlRtv.json"
)

func cs2ConfigCM(server string) string { return "cs2-" + server + "-config" }

// CS2ConfigSettings is the wire shape for GET /cs2/settings — what's
// currently effective on the running server (ConfigMap > running pod).
type CS2ConfigSettings struct {
	WelcomeMessage string `json:"welcomeMessage"`
	Hostname       string `json:"hostname"`
}

func (c *Cluster) configConfigMap(ctx context.Context, ns, server string) (*corev1.ConfigMap, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	cms := b.clientset.CoreV1().ConfigMaps(ns)
	cm, err := cms.Get(ctx, cs2ConfigCM(server), metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:      cs2ConfigCM(server),
				Namespace: ns,
				Labels: map[string]string{
					"app":                          server,
					"game":                         "cs2",
					"app.kubernetes.io/managed-by": "gamectl",
				},
			},
			Data: map[string]string{},
		}, nil
	}
	return cm, err
}

// saveConfigMapKey upserts one key in the cs2-<server>-config ConfigMap.
func (c *Cluster) saveConfigMapKey(ctx context.Context, ns, server, key, value string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	cms := b.clientset.CoreV1().ConfigMaps(ns)
	cm, err := c.configConfigMap(ctx, ns, server)
	if err != nil {
		return err
	}
	if cm.Data == nil {
		cm.Data = map[string]string{}
	}
	cm.Data[key] = value
	if cm.ResourceVersion == "" {
		if _, err := cms.Create(ctx, cm, metav1.CreateOptions{}); err != nil {
			return fmt.Errorf("create config ConfigMap: %w", err)
		}
	} else {
		if _, err := cms.Update(ctx, cm, metav1.UpdateOptions{}); err != nil {
			return fmt.Errorf("update config ConfigMap: %w", err)
		}
	}
	return nil
}

// CS2GetWelcome reads the GameCtlRtv plugin's current welcome_message from
// the live config in the running pod (so the manage screen can pre-fill the
// editor with whatever's set).
func (c *Cluster) CS2GetWelcome(ctx context.Context, ns, server string) (string, error) {
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return "", err
	}
	raw, _, err := c.podExec(ctx, ns, pod, container, []string{"cat", cs2GameCtlRtvJSON}, "")
	if err != nil {
		return "", fmt.Errorf("read GameCtlRtv.json: %w", err)
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return "", fmt.Errorf("parse GameCtlRtv.json: %w", err)
	}
	if s, ok := cfg["welcome_message"].(string); ok {
		return s, nil
	}
	return "", nil
}

// CS2SetWelcome persists the welcome message to the cs2-<server>-config
// ConfigMap (so it survives a pod recreate), then patches the running pod's
// GameCtlRtv.json and reloads the plugin so it takes effect immediately.
func (c *Cluster) CS2SetWelcome(ctx context.Context, ns, server, message string) error {
	if err := c.saveConfigMapKey(ctx, ns, server, cs2ConfigWelcomeKey, message); err != nil {
		return err
	}
	pod, container, err := c.cs2Pod(ctx, ns, server)
	if err != nil {
		return fmt.Errorf("welcome saved to ConfigMap, but live apply failed: %w", err)
	}
	raw, _, err := c.podExec(ctx, ns, pod, container, []string{"cat", cs2GameCtlRtvJSON}, "")
	if err != nil {
		return fmt.Errorf("welcome saved, but reading GameCtlRtv.json failed: %w", err)
	}
	var cfg map[string]any
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return fmt.Errorf("welcome saved, but parsing GameCtlRtv.json failed: %w", err)
	}
	cfg["welcome_message"] = message
	out, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	if _, stderr, err := c.podExec(ctx, ns, pod, container,
		[]string{"sh", "-c", "cat > " + cs2GameCtlRtvJSON}, string(out)); err != nil {
		return fmt.Errorf("welcome saved to ConfigMap, but live write failed: %w (%s)", err, strings.TrimSpace(stderr))
	}
	if addr, pw, e := c.resolveCS2RCON(ctx, ns, server); e == nil {
		_, _ = games.RCON(ctx, addr, pw, []string{"css_plugins reload GameCtlRtv"})
	}
	return nil
}

// CS2GetHostname returns the live `hostname` cvar from the running pod via
// RCON (so the editor pre-fills with what's actually set, including any
// recent live edits not yet reflected in the ConfigMap).
func (c *Cluster) CS2GetHostname(ctx context.Context, ns, server string) (string, error) {
	addr, pw, err := c.resolveCS2RCON(ctx, ns, server)
	if err != nil {
		return "", err
	}
	out, err := games.RCON(ctx, addr, pw, []string{"hostname"})
	if err != nil {
		return "", err
	}
	// CS2 prints: `"hostname" = "JT and RAGA" ( def. "Counter-Strike: ...")`
	// Parse the first quoted value after the equals sign.
	i := strings.Index(out, "= \"")
	if i < 0 {
		return strings.TrimSpace(out), nil
	}
	rest := out[i+3:]
	j := strings.Index(rest, "\"")
	if j < 0 {
		return strings.TrimSpace(rest), nil
	}
	return rest[:j], nil
}

// CS2GetSteamAPIKey returns the current API_KEY env value on the cs2
// container so the manage screen can pre-fill its editor. Returns "" if
// the var is absent or empty.
func (c *Cluster) CS2GetSteamAPIKey(ctx context.Context, ns, server string) (string, error) {
	b := c.snap()
	if b == nil {
		return "", ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, server, metav1.GetOptions{})
	if err != nil {
		return "", err
	}
	conts := dep.Spec.Template.Spec.Containers
	if len(conts) == 0 {
		return "", fmt.Errorf("deployment %s/%s has no containers", ns, server)
	}
	for _, e := range conts[0].Env {
		if e.Name == "API_KEY" {
			return strings.TrimSpace(e.Value), nil
		}
	}
	return "", nil
}

// CS2SetSteamAPIKey upserts the API_KEY env on the cs2 container and
// writes the Deployment back, which triggers a rolling restart (Recreate
// strategy → brief downtime). After restart the cs2 binary boots with the
// new key and Steam's subscription API fetches subscribed workshop maps
// in the background — see hasSteamAPIKey / cs2_reconciler.go.
//
// An empty string is treated as "unset the key": the env entry stays but
// with an empty value, matching the wizard's default. Anything that looks
// like obvious whitespace or non-hex garbage is rejected — Steam keys are
// 32 hex chars.
func (c *Cluster) CS2SetSteamAPIKey(ctx context.Context, ns, server, key string) error {
	key = strings.TrimSpace(key)
	if key != "" {
		if len(key) != 32 {
			return fmt.Errorf("Steam Web API key must be 32 hex chars (got %d)", len(key))
		}
		for _, r := range key {
			if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
				return fmt.Errorf("Steam Web API key must be 32 hex chars (invalid char %q)", r)
			}
		}
	}
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	deps := b.clientset.AppsV1().Deployments(ns)
	dep, err := deps.Get(ctx, server, metav1.GetOptions{})
	if err != nil {
		return err
	}
	if len(dep.Spec.Template.Spec.Containers) == 0 {
		return fmt.Errorf("deployment %s/%s has no containers", ns, server)
	}
	env := dep.Spec.Template.Spec.Containers[0].Env
	found := false
	for i := range env {
		if env[i].Name == "API_KEY" {
			env[i].Value = key
			env[i].ValueFrom = nil
			found = true
			break
		}
	}
	if !found {
		env = append(env, corev1.EnvVar{Name: "API_KEY", Value: key})
	}
	dep.Spec.Template.Spec.Containers[0].Env = env
	if _, err := deps.Update(ctx, dep, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update deployment env: %w", err)
	}
	return nil
}

// CS2SetHostname persists the hostname to the cs2-<server>-config ConfigMap,
// then applies it live via RCON (`hostname "..."`) so it changes without a
// restart. On the next pod (re)start, the gen-config init container reads
// the ConfigMap and re-stamps gamectl_server.cfg.
func (c *Cluster) CS2SetHostname(ctx context.Context, ns, server, hostname string) error {
	hostname = strings.TrimSpace(hostname)
	if hostname == "" {
		return fmt.Errorf("hostname cannot be empty")
	}
	if strings.ContainsAny(hostname, "\"\n\r") {
		return fmt.Errorf("hostname cannot contain quotes or newlines")
	}
	if err := c.saveConfigMapKey(ctx, ns, server, cs2ConfigHostnameKey, hostname); err != nil {
		return err
	}
	addr, pw, err := c.resolveCS2RCON(ctx, ns, server)
	if err != nil {
		return fmt.Errorf("hostname saved to ConfigMap, but live apply failed: %w", err)
	}
	if _, err := games.RCON(ctx, addr, pw, []string{fmt.Sprintf("hostname \"%s\"", hostname)}); err != nil {
		return fmt.Errorf("hostname saved to ConfigMap, but RCON apply failed: %w", err)
	}
	return nil
}
