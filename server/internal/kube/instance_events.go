package kube

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// DeployCondition mirrors a Deployment status condition (Available /
// Progressing). This is what surfaces "Deployment does not have minimum
// availability" / "ReplicaSet is progressing" in the UI.
type DeployCondition struct {
	Type           string `json:"type"`
	Status         string `json:"status"`
	Reason         string `json:"reason,omitempty"`
	Message        string `json:"message,omitempty"`
	LastTransition string `json:"lastTransition,omitempty"`
}

// InstanceEvent is one Kubernetes Event tied to this instance's
// Deployment / ReplicaSet / Pods — e.g. FailedScheduling
// "Insufficient memory", FailedMount, ImagePullBackOff, OOMKilled.
type InstanceEvent struct {
	Type     string `json:"type"`   // Normal | Warning
	Reason   string `json:"reason"`
	Object   string `json:"object"` // "Pod/valheim-5cc99f8d66-abcde"
	Message  string `json:"message"`
	Count    int32  `json:"count,omitempty"`
	LastSeen string `json:"lastSeen,omitempty"`
}

// InstanceDiagnostics is the wire shape for the events endpoint: the
// Deployment's own conditions plus recent related Events, newest first.
// This is what lets an operator see *why* a deploy never came up
// (scheduling/volume/image/OOM) without dropping to kubectl.
type InstanceDiagnostics struct {
	Conditions []DeployCondition `json:"conditions"`
	Events     []InstanceEvent   `json:"events"`
}

// InstanceDiagnostics gathers Deployment conditions and the Events for the
// Deployment, its ReplicaSets, and its Pods within the namespace.
func (c *Cluster) InstanceDiagnostics(ctx context.Context, ns, name string) (InstanceDiagnostics, error) {
	b := c.snap()
	if b == nil {
		return InstanceDiagnostics{}, ErrNotConfigured
	}

	var out InstanceDiagnostics

	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return InstanceDiagnostics{}, err
	}
	for _, cond := range dep.Status.Conditions {
		dc := DeployCondition{
			Type:    string(cond.Type),
			Status:  string(cond.Status),
			Reason:  cond.Reason,
			Message: cond.Message,
		}
		if !cond.LastTransitionTime.IsZero() {
			dc.LastTransition = cond.LastTransitionTime.UTC().Format(time.RFC3339)
		}
		out.Conditions = append(out.Conditions, dc)
	}

	// Names whose Events we care about: the Deployment, its ReplicaSets,
	// and its Pods (all share the app=<name> label our generators set).
	related := map[string]bool{name: true}
	sel := metav1.ListOptions{LabelSelector: fmt.Sprintf("app=%s", name)}
	if rsList, err := b.clientset.AppsV1().ReplicaSets(ns).List(ctx, sel); err == nil {
		for _, rs := range rsList.Items {
			related[rs.Name] = true
		}
	}
	if podList, err := b.clientset.CoreV1().Pods(ns).List(ctx, sel); err == nil {
		for _, p := range podList.Items {
			related[p.Name] = true
		}
	}

	evList, err := b.clientset.CoreV1().Events(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		// Conditions alone are still useful — don't fail the whole call.
		return out, nil
	}
	for _, e := range evList.Items {
		obj := e.InvolvedObject.Name
		// Match exact related names, or pod/rs names that start with the
		// deployment name (covers events fired before our cache saw them).
		if !related[obj] && !strings.HasPrefix(obj, name+"-") {
			continue
		}
		ie := InstanceEvent{
			Type:    e.Type,
			Reason:  e.Reason,
			Object:  e.InvolvedObject.Kind + "/" + obj,
			Message: e.Message,
			Count:   e.Count,
		}
		if ts := eventTime(e.LastTimestamp.Time, e.EventTime.Time, e.FirstTimestamp.Time); !ts.IsZero() {
			ie.LastSeen = ts.UTC().Format(time.RFC3339)
		}
		out.Events = append(out.Events, ie)
	}

	// Newest first; cap so the UI panel stays readable.
	sort.Slice(out.Events, func(i, j int) bool {
		return out.Events[i].LastSeen > out.Events[j].LastSeen
	})
	if len(out.Events) > 25 {
		out.Events = out.Events[:25]
	}
	return out, nil
}

func eventTime(candidates ...time.Time) time.Time {
	for _, t := range candidates {
		if !t.IsZero() {
			return t
		}
	}
	return time.Time{}
}
