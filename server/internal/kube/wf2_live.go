package kube

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// Wreckfest 2 post-deploy settings. The image (wreckfest2-kube) regenerates
// server_config.scnf from env on every boot (GAMECTL_MANAGE_CONFIG=1), so
// "change a setting" == "patch the Deployment env" — the env change rolls
// the pod once and the new config is live in ~1-2 minutes. There is no
// RCON/live channel on the WF2 dedicated server; in-lobby changes are the
// lobby leader's job ("leader enabled" flag).
type WF2Live struct {
	ServerName    string `json:"serverName"`
	Description   string `json:"description"`
	Password      string `json:"password"`
	EventLoop     string `json:"eventLoop"`
	CountdownTime int    `json:"countdownTime"` // ms
	VotingTime    int    `json:"votingTime"`    // ms
	Flags         string `json:"flags"`         // raw flags string, e.g. "leader enabled"
	// LeaderEnabled is derived from Flags for the UI toggle.
	LeaderEnabled bool `json:"leaderEnabled"`
}

// wf2EnvNames maps the editable surface. GAME_PORT is deliberately absent:
// changing it desyncs the Service/publish and is a redeploy-level decision.
var wf2EnvNames = []string{
	"SERVER_NAME", "SERVER_DESCRIPTION", "SERVER_PASSWORD",
	"EVENT_LOOP", "COUNTDOWN_TIME", "VOTING_TIME", "SERVER_FLAGS",
}

func envValue(env []corev1.EnvVar, name string) string {
	for _, e := range env {
		if e.Name == name {
			return e.Value
		}
	}
	return ""
}

func wf2LiveFromEnv(env []corev1.EnvVar) *WF2Live {
	atoi := func(s string, def int) int {
		if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
			return n
		}
		return def
	}
	flags := envValue(env, "SERVER_FLAGS")
	return &WF2Live{
		ServerName:    envValue(env, "SERVER_NAME"),
		Description:   envValue(env, "SERVER_DESCRIPTION"),
		Password:      envValue(env, "SERVER_PASSWORD"),
		EventLoop:     envValue(env, "EVENT_LOOP"),
		CountdownTime: atoi(envValue(env, "COUNTDOWN_TIME"), 100000),
		VotingTime:    atoi(envValue(env, "VOTING_TIME"), 20000),
		Flags:         flags,
		LeaderEnabled: strings.Contains(flags, "leader enabled"),
	}
}

// WF2ConfigReq is the editable subset; nil pointers mean "leave as is".
type WF2ConfigReq struct {
	ServerName    *string `json:"serverName,omitempty"`
	Description   *string `json:"description,omitempty"`
	Password      *string `json:"password,omitempty"`
	EventLoop     *string `json:"eventLoop,omitempty"`
	CountdownTime *int    `json:"countdownTime,omitempty"`
	VotingTime    *int    `json:"votingTime,omitempty"`
	// LeaderEnabled toggles the "leader enabled" token in SERVER_FLAGS,
	// preserving any other flags.
	LeaderEnabled *bool `json:"leaderEnabled,omitempty"`
}

// ApplyWF2Config patches the Deployment env for a wreckfest2 instance. The
// env change rolls the pod (Recreate strategy), so the new config is live
// after one server restart.
func (c *Cluster) ApplyWF2Config(ctx context.Context, ns, name string, req WF2ConfigReq) (*WF2Live, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	if g := dep.Labels["game"]; g != "wreckfest2" {
		return nil, fmt.Errorf("instance %s/%s is %q, not a wreckfest2 server", ns, name, g)
	}
	conts := dep.Spec.Template.Spec.Containers
	if len(conts) == 0 {
		return nil, fmt.Errorf("deployment %s/%s has no containers", ns, name)
	}
	env := conts[0].Env

	setEnv := func(n, v string) {
		for i := range env {
			if env[i].Name == n {
				env[i].Value = v
				env[i].ValueFrom = nil
				return
			}
		}
		env = append(env, corev1.EnvVar{Name: n, Value: v})
	}

	if req.ServerName != nil {
		if strings.TrimSpace(*req.ServerName) == "" {
			return nil, fmt.Errorf("server name cannot be empty")
		}
		setEnv("SERVER_NAME", strings.TrimSpace(*req.ServerName))
	}
	if req.Description != nil {
		setEnv("SERVER_DESCRIPTION", *req.Description)
	}
	if req.Password != nil {
		setEnv("SERVER_PASSWORD", *req.Password)
	}
	if req.EventLoop != nil {
		el := strings.TrimSpace(*req.EventLoop)
		if el == "" {
			el = "default_loop"
		}
		setEnv("EVENT_LOOP", el)
	}
	if req.CountdownTime != nil {
		if *req.CountdownTime < 1000 || *req.CountdownTime > 3600000 {
			return nil, fmt.Errorf("countdown time must be 1000-3600000 ms")
		}
		setEnv("COUNTDOWN_TIME", strconv.Itoa(*req.CountdownTime))
	}
	if req.VotingTime != nil {
		if *req.VotingTime < 1000 || *req.VotingTime > 600000 {
			return nil, fmt.Errorf("voting time must be 1000-600000 ms")
		}
		setEnv("VOTING_TIME", strconv.Itoa(*req.VotingTime))
	}
	if req.LeaderEnabled != nil {
		// Token-preserving toggle: keep unrelated flags intact.
		var toks []string
		for _, t := range strings.Split(envValue(env, "SERVER_FLAGS"), ",") {
			t = strings.TrimSpace(t)
			if t == "" || t == "leader enabled" {
				continue
			}
			toks = append(toks, t)
		}
		if *req.LeaderEnabled {
			toks = append([]string{"leader enabled"}, toks...)
		}
		setEnv("SERVER_FLAGS", strings.Join(toks, ", "))
	}

	dep.Spec.Template.Spec.Containers[0].Env = env
	dep, err = b.clientset.AppsV1().Deployments(ns).Update(ctx, dep, metav1.UpdateOptions{})
	if err != nil {
		return nil, err
	}
	return wf2LiveFromEnv(dep.Spec.Template.Spec.Containers[0].Env), nil
}
