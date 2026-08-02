package kube

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// External notifications for the monitoring data probehistory.go and
// metrics.go already collect. Discord-only for now (a webhook URL is a
// one-click "New Webhook" away, no bot/app registration needed) — the
// AlertConfig shape leaves room for more channels later without a
// migration. Stored the same way as Storage Locations: a small ConfigMap,
// no PV/PVC.
type AlertConfig struct {
	DiscordWebhookURL string `json:"discordWebhookUrl,omitempty"`
	Enabled           bool   `json:"enabled"`

	// ShowCardGraphs is a display preference, not an alert setting — it
	// lives here anyway rather than a second ConfigMap, since this is
	// already "the Monitoring page's persisted settings" in practice.
	// Off by default: a mini graph on every hub card is a bigger visual
	// footprint than most operators want until they ask for it.
	ShowCardGraphs bool `json:"showCardGraphs"`

	// RetentionDays bounds how much sampler history is kept in memory.
	// 0 (unset) means the default; history older than ~24h is compacted to
	// 5-minute resolution regardless, so long retention stays cheap.
	RetentionDays int `json:"retentionDays"`
}

// DefaultRetentionDays is used when RetentionDays is unset/invalid.
const DefaultRetentionDays = 30

// EffectiveRetentionDays normalizes the configured retention.
func (c AlertConfig) EffectiveRetentionDays() int {
	if c.RetentionDays <= 0 {
		return DefaultRetentionDays
	}
	return c.RetentionDays
}

const (
	alertsNS     = "gamectl"
	alertsCMName = "gamectl-alerts"
	alertsCMKey  = "config.json"
)

func (c *Cluster) AlertConfig(ctx context.Context) (AlertConfig, error) {
	b := c.snap()
	if b == nil {
		return AlertConfig{}, ErrNotConfigured
	}
	cm, err := b.clientset.CoreV1().ConfigMaps(alertsNS).Get(ctx, alertsCMName, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return AlertConfig{}, nil
		}
		return AlertConfig{}, err
	}
	raw := cm.Data[alertsCMKey]
	if strings.TrimSpace(raw) == "" {
		return AlertConfig{}, nil
	}
	var cfg AlertConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return AlertConfig{}, fmt.Errorf("parse %s/%s: %w", alertsCMName, alertsCMKey, err)
	}
	return cfg, nil
}

func (c *Cluster) SetAlertConfig(ctx context.Context, cfg AlertConfig) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	data, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	cms := b.clientset.CoreV1().ConfigMaps(alertsNS)
	existing, err := cms.Get(ctx, alertsCMName, metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err):
		_, err = cms.Create(ctx, &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: alertsCMName, Namespace: alertsNS},
			Data:       map[string]string{alertsCMKey: string(data)},
		}, metav1.CreateOptions{})
		return err
	case err != nil:
		return err
	default:
		existing.Data = map[string]string{alertsCMKey: string(data)}
		_, err = cms.Update(ctx, existing, metav1.UpdateOptions{})
		return err
	}
}

// discordAlert is the minimal embed shape Discord's webhook API accepts.
type discordAlert struct {
	Content string         `json:"content,omitempty"`
	Embeds  []discordEmbed `json:"embeds,omitempty"`
}
type discordEmbed struct {
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Color       int    `json:"color,omitempty"` // decimal RGB, e.g. 0xE74C3C
}

const (
	colorDown = 0xE74C3C // red
	colorUp   = 0x2ECC71 // green
	colorWarn = 0xF39C12 // amber
)

// SendDiscordAlert posts one embed to a Discord webhook URL. Best-effort —
// callers log/ignore the error rather than let a notification failure
// affect the sampler loop.
func SendDiscordAlert(ctx context.Context, webhookURL, title, description string, color int) error {
	body, err := json.Marshal(discordAlert{Embeds: []discordEmbed{{Title: title, Description: description, Color: color}}})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 8 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("discord webhook: HTTP %d", resp.StatusCode)
	}
	return nil
}
