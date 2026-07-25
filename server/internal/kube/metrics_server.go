package kube

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
)

//go:embed metrics_server.yaml
var metricsServerManifest string

type MetricsServerStatus struct {
	Installed           bool   `json:"installed"`
	Available           bool   `json:"available"`
	DeploymentReady     bool   `json:"deploymentReady"`
	APIServiceAvailable bool   `json:"apiServiceAvailable"`
	OfferInstall        bool   `json:"offerInstall"`
	Detail              string `json:"detail,omitempty"`
	Image               string `json:"image,omitempty"`
}

type apiServiceStatus struct {
	Status struct {
		Conditions []struct {
			Type    string `json:"type"`
			Status  string `json:"status"`
			Reason  string `json:"reason"`
			Message string `json:"message"`
		} `json:"conditions"`
	} `json:"status"`
}

func (c *Cluster) MetricsServerStatus(ctx context.Context) (MetricsServerStatus, error) {
	b := c.snap()
	if b == nil {
		return MetricsServerStatus{}, ErrNotConfigured
	}
	out := MetricsServerStatus{OfferInstall: true}

	dep, err := b.clientset.AppsV1().Deployments("kube-system").Get(ctx, "metrics-server", metav1.GetOptions{})
	switch {
	case err == nil:
		out.Installed = true
		out.DeploymentReady = deploymentReady(dep)
		if len(dep.Spec.Template.Spec.Containers) > 0 {
			out.Image = dep.Spec.Template.Spec.Containers[0].Image
		}
	case apierrors.IsNotFound(err):
		out.Detail = "metrics-server Deployment not found in kube-system"
	default:
		return out, fmt.Errorf("get metrics-server deployment: %w", err)
	}

	raw, err := b.clientset.CoreV1().RESTClient().Get().
		AbsPath("/apis/apiregistration.k8s.io/v1/apiservices/v1beta1.metrics.k8s.io").
		DoRaw(ctx)
	switch {
	case err == nil:
		var st apiServiceStatus
		if uerr := json.Unmarshal(raw, &st); uerr == nil {
			for _, c := range st.Status.Conditions {
				if c.Type == "Available" {
					out.APIServiceAvailable = strings.EqualFold(c.Status, "True")
					if !out.APIServiceAvailable && out.Detail == "" {
						if c.Message != "" {
							out.Detail = c.Message
						} else if c.Reason != "" {
							out.Detail = c.Reason
						}
					}
					break
				}
			}
		}
	case strings.Contains(err.Error(), "not found"):
		if out.Detail == "" {
			out.Detail = "metrics.k8s.io APIService not registered"
		}
	default:
		return out, fmt.Errorf("get metrics APIService: %w", err)
	}

	out.Available = out.DeploymentReady && out.APIServiceAvailable
	out.OfferInstall = !out.Available
	if out.Available {
		out.Detail = ""
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

func (c *Cluster) InstallMetricsServer(ctx context.Context) (ApplyResult, error) {
	b := c.snap()
	if b == nil {
		return ApplyResult{}, ErrNotConfigured
	}
	docs, err := ParseYAMLDocs(metricsServerManifest)
	if err != nil {
		return ApplyResult{}, fmt.Errorf("parse embedded metrics-server manifest: %w", err)
	}
	return c.applyDirect(ctx, b, docs)
}

func (c *Cluster) applyDirect(ctx context.Context, b *clientBundle, docs []map[string]any) (ApplyResult, error) {
	out := ApplyResult{Applied: []ApplyItem{}, Skipped: []SkippedItem{}}
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
		var ns string
		var opts metav1.PatchOptions
		opts.FieldManager = fieldManager
		var errPatch error
		body, err := json.Marshal(u.Object)
		if err != nil {
			return out, fmt.Errorf("manifest [%d] (%s/%s): marshal: %w", i, gvk.Kind, name, err)
		}
		if mapping.Scope.Name() == meta.RESTScopeNameNamespace {
			ns = u.GetNamespace()
			if ns == "" {
				return out, fmt.Errorf("%w: manifest [%d] (%s/%s): namespace required for namespace-scoped resource", ErrInvalidManifest, i, gvk.Kind, name)
			}
			_, errPatch = b.dynamic.Resource(mapping.Resource).Namespace(ns).Patch(ctx, name, types.ApplyPatchType, body, opts)
		} else {
			_, errPatch = b.dynamic.Resource(mapping.Resource).Patch(ctx, name, types.ApplyPatchType, body, opts)
		}
		if errPatch != nil {
			if apierrors.IsConflict(errPatch) {
				out.Skipped = append(out.Skipped, SkippedItem{
					Kind:      gvk.Kind,
					Name:      name,
					Namespace: ns,
					Reason:    "Field manager conflict — another controller owns one or more fields",
				})
				continue
			}
			return out, fmt.Errorf("apply %s/%s: %w", gvk.Kind, name, errPatch)
		}
		out.Applied = append(out.Applied, ApplyItem{Kind: gvk.Kind, Name: name, Namespace: ns})
	}
	return out, nil
}
