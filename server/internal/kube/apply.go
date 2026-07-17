package kube

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/yaml"
	"k8s.io/client-go/dynamic"
)

const fieldManager = "gamectl"

// ErrInvalidManifest wraps client-input errors from Apply (missing namespace,
// unknown kind, missing apiVersion/name, etc.) so handlers can distinguish them
// from cluster-side failures and return 400 instead of 500.
var ErrInvalidManifest = errors.New("invalid manifest")

// ApplyItem identifies a single manifest in an apply result.
type ApplyItem struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
}

// SkippedItem is an ApplyItem that was not applied, with a reason.
type SkippedItem struct {
	Kind      string `json:"kind"`
	Name      string `json:"name"`
	Namespace string `json:"namespace,omitempty"`
	Reason    string `json:"reason"`
}

// ApplyResult is the wire shape for /kube/apply.
type ApplyResult struct {
	Applied []ApplyItem   `json:"applied"`
	Skipped []SkippedItem `json:"skipped"`
}

// PhaseReporter is the subset of tasks.Reporter that Apply needs —
// declared locally so kube doesn't take a hard dep on the tasks
// package. Callers that don't care can pass nopReporter{}.
//
// EndPhaseDetail is the verbose variant: same effect as EndPhase but
// also attaches a multi-line detail blob to the phase (e.g. the helper
// pod's combined log + classified hint when an NFS-ensure step fails).
// The UI renders this in an expandable code block so operators see the
// actual `mount.nfs` stderr without leaving the task panel.
type PhaseReporter interface {
	BeginPhase(name, detail string) int
	EndPhase(idx int, err error)
	EndPhaseDetail(idx int, err error, detail string)
}

type nopReporter struct{}

func (nopReporter) BeginPhase(string, string) int       { return -1 }
func (nopReporter) EndPhase(int, error)                 {}
func (nopReporter) EndPhaseDetail(int, error, string)   {}

// splitErrHeadlineDetail splits a multi-line error string into a one-line
// headline (suitable for a phase's `Error` chip) and the remaining
// formatted body (suitable for `Detail`). Used so the UI can show a
// glanceable failure summary AND still surface the full hint/log without
// the operator opening a kubectl shell.
func splitErrHeadlineDetail(err error) (headline, detail string) {
	s := err.Error()
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i]), strings.TrimSpace(s[i+1:])
	}
	return s, ""
}

// Apply performs server-side apply on each manifest, in order, reporting
// progress to rep (nil → no reporting).
//
// Unlike the Python service (which calls CREATE and treats 409 as "already exists"),
// this uses Kubernetes server-side apply via the dynamic client + RESTMapper. That
// gives create-or-update semantics natively and surfaces real field-ownership
// conflicts as the only "skipped" case.
//
// Returns an aggregate error on any non-conflict failure; partial state may have
// been applied to the cluster.
func (c *Cluster) Apply(ctx context.Context, docs []map[string]any, dryRun bool, rep PhaseReporter) (ApplyResult, error) {
	if rep == nil {
		rep = nopReporter{}
	}
	b := c.snap()
	if b == nil {
		return ApplyResult{}, ErrNotConfigured
	}

	out := ApplyResult{
		Applied: []ApplyItem{},
		Skipped: []SkippedItem{},
	}

	// Pre-flight: for every PersistentVolume.spec.nfs in this batch, make
	// sure the directory exists on the NFS server. Otherwise the kubelet
	// gets stuck in ContainerCreating with a confusing "No such file or
	// directory" mount error and the user has to ssh in / spawn a helper
	// pod to mkdir by hand. Skipped on dry-run since dry-run shouldn't
	// touch real backing storage.
	if !dryRun {
		for _, t := range extractNFSTargets(docs) {
			phase := rep.BeginPhase(
				fmt.Sprintf("Ensure NFS path %s:%s", t.Server, t.Path),
				"creating helper pod to mkdir the directory if missing",
			)
			err := c.ensureNFSPath(ctx, t.Server, t.Path)
			if err != nil {
				// The ensureNFSPath error already contains a classified
				// hint + the helper pod's combined log when it could
				// fetch them. Split the first line off as the phase
				// headline (UI shows this in the chip) and ship the
				// rest as detail (UI expands into a code block) so the
				// operator sees a one-liner up front AND the full mount.
				// nfs output without leaving the task panel.
				headline, detail := splitErrHeadlineDetail(err)
				rep.EndPhaseDetail(phase, fmt.Errorf("%s", headline), detail)
				// Top-level task error stays the wrapped form so existing
				// log/JSON consumers see the full thing in t.Error.
				return out, fmt.Errorf("ensure NFS path %s:%s: %w", t.Server, t.Path, err)
			}
			rep.EndPhase(phase, nil)
		}
	}

	// Harden every bundle into the single-namespace, no-cluster-PV,
	// label-selectable shape (the README). Done AFTER the NFS
	// ensure loop above so it can still read PV.spec.nfs to mkdir the
	// backing dirs; the resulting inline nfs volumes point at the same
	// server/path.
	docs = normalizeForGamectl(docs)

	// Collision guard: a real apply (not dry-run) that would create a game
	// instance whose gamectl.io/instance is already running is rejected —
	// single-namespace means a same-name apply silently overwrites the
	// live instance (and collides on its storage subdir). The operator must
	// pick a unique serverName. (UI blocks this too; this covers any path.)
	if !dryRun {
		for _, d := range docs {
			if str(d, "kind") != "Deployment" {
				continue
			}
			inst := instanceOf(d)
			if inst == "" {
				continue
			}
			existing, lerr := b.clientset.AppsV1().Deployments(nsGamectl).List(ctx,
				metav1.ListOptions{LabelSelector: "gamectl.io/instance=" + inst})
			if lerr == nil && len(existing.Items) > 0 {
				return out, fmt.Errorf("%w: a server named %q already exists — choose a different serverName so it gets its own resources and storage folder",
					ErrInvalidManifest, inst)
			}
		}
	}

	for i, raw := range docs {
		if raw == nil {
			continue
		}
		u := &unstructured.Unstructured{Object: raw}
		gvk := u.GroupVersionKind()
		if gvk.Kind == "" || gvk.Version == "" {
			return out, fmt.Errorf("%w: manifest [%d]: missing apiVersion or kind", ErrInvalidManifest, i)
		}
		name := u.GetName()
		if name == "" {
			return out, fmt.Errorf("%w: manifest [%d] (%s): missing metadata.name", ErrInvalidManifest, i, gvk.Kind)
		}

		mapping, err := b.mapper.RESTMapping(gvk.GroupKind(), gvk.Version)
		if err != nil {
			return out, fmt.Errorf("%w: manifest [%d] (%s/%s): %s", ErrInvalidManifest, i, gvk.Kind, name, err.Error())
		}

		var ri dynamic.ResourceInterface
		ns := u.GetNamespace()
		if mapping.Scope.Name() == meta.RESTScopeNameNamespace {
			if ns == "" {
				return out, fmt.Errorf("%w: manifest [%d] (%s/%s): namespace required for namespace-scoped resource", ErrInvalidManifest, i, gvk.Kind, name)
			}
			ri = b.dynamic.Resource(mapping.Resource).Namespace(ns)
		} else {
			ri = b.dynamic.Resource(mapping.Resource)
		}

		body, err := json.Marshal(u.Object)
		if err != nil {
			return out, fmt.Errorf("manifest [%d] (%s/%s): marshal: %w", i, gvk.Kind, name, err)
		}

		opts := metav1.PatchOptions{FieldManager: fieldManager}
		if dryRun {
			opts.DryRun = []string{metav1.DryRunAll}
		}

		phaseName := fmt.Sprintf("Apply %s/%s", gvk.Kind, name)
		if ns != "" {
			phaseName = fmt.Sprintf("Apply %s/%s in %s", gvk.Kind, name, ns)
		}
		phase := rep.BeginPhase(phaseName, "")
		_, err = ri.Patch(ctx, name, types.ApplyPatchType, body, opts)
		if err != nil {
			if apierrors.IsConflict(err) {
				rep.EndPhase(phase, nil) // skipped, not failed
				out.Skipped = append(out.Skipped, SkippedItem{
					Kind:      gvk.Kind,
					Name:      name,
					Namespace: ns,
					Reason:    "Field manager conflict — another controller owns one or more fields",
				})
				continue
			}
			rep.EndPhase(phase, err)
			return out, fmt.Errorf("apply %s/%s: %w", gvk.Kind, name, err)
		}
		rep.EndPhase(phase, nil)

		out.Applied = append(out.Applied, ApplyItem{
			Kind:      gvk.Kind,
			Name:      name,
			Namespace: ns,
		})
	}

	return out, nil
}

// ParseYAMLDocs splits a multi-document YAML string into a slice of dicts.
// Empty documents (---\n---) are dropped.
func ParseYAMLDocs(rawYAML string) ([]map[string]any, error) {
	var out []map[string]any
	dec := yaml.NewYAMLOrJSONDecoder(strings.NewReader(rawYAML), 4096)
	for {
		var obj map[string]any
		err := dec.Decode(&obj)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(obj) == 0 {
			continue
		}
		out = append(out, obj)
	}
	return out, nil
}
