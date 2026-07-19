package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	autoscalingv1 "k8s.io/api/autoscaling/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// RolloutRestart triggers a rolling restart of the named Deployment by
// stamping a restart annotation on its pod template — exactly what
// `kubectl rollout restart` does. With imagePullPolicy: Always + a
// mutable :latest tag, the new pod re-pulls the newest image, which is
// how GameCTL self-updates from the GUI without deleting the namespace
// or the auth Secret. Uses the namespaced Role's existing deployments
// patch verb (no extra RBAC).
func (c *Cluster) RolloutRestart(ctx context.Context, ns, name string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	patch := []byte(fmt.Sprintf(
		`{"spec":{"template":{"metadata":{"annotations":{"gamectl.io/restartedAt":%q}}}}}`,
		time.Now().UTC().Format(time.RFC3339)))
	_, err := b.clientset.AppsV1().Deployments(ns).Patch(
		ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	return err
}

// splitImageRepoTag splits a container image reference into its repository and
// tag, tolerating a registry host:port (a colon before the last '/') and an
// optional @digest. Returns tag "" when the ref carries no tag.
func splitImageRepoTag(image string) (repo, tag string) {
	if at := strings.LastIndex(image, "@"); at >= 0 {
		image = image[:at] // drop any @sha256:… digest
	}
	slash := strings.LastIndex(image, "/")
	if colon := strings.LastIndex(image, ":"); colon > slash {
		return image[:colon], image[colon+1:]
	}
	return image, ""
}

// UpdateSelfImage moves the named Deployment onto an immutable release tag by
// setting its first container's image to <current-repo>:<tag>, keeping the
// registry/repo. This is what makes self-update safe from unprompted upgrades:
// because the deployed tag is fixed, an ordinary pod restart re-pulls the SAME
// version instead of chasing a moving :latest — only this explicit call moves
// the version. Returns the previous tag and whether a change was applied. Uses
// the namespaced Role's existing deployments get+patch verbs (no extra RBAC).
func (c *Cluster) UpdateSelfImage(ctx context.Context, ns, name, tag string) (fromTag string, changed bool, err error) {
	b := c.snap()
	if b == nil {
		return "", false, ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return "", false, err
	}
	if len(dep.Spec.Template.Spec.Containers) == 0 {
		return "", false, fmt.Errorf("deployment %s/%s has no containers", ns, name)
	}
	cn := dep.Spec.Template.Spec.Containers[0]
	repo, curTag := splitImageRepoTag(cn.Image)
	if curTag == tag {
		return curTag, false, nil
	}
	// Strategic-merge patch keyed on the container name touches only its image.
	patch := []byte(fmt.Sprintf(
		`{"spec":{"template":{"spec":{"containers":[{"name":%q,"image":%q}]}}}}`,
		cn.Name, repo+":"+tag))
	if _, err := b.clientset.AppsV1().Deployments(ns).Patch(
		ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{}); err != nil {
		return curTag, false, err
	}
	return curTag, true, nil
}

// RestartInstance restarts a game instance's pod and, in the SAME rollout,
// reconciles any pending auto-update choice (the gamectl.io/auto-update
// annotation set via SetAutoUpdate without disturbing the running server)
// into the container env. So toggling auto-update is non-disruptive and the
// operator-chosen Restart is the single point where it actually applies.
// With no pending change this is a plain `kubectl rollout restart`.
func (c *Cluster) RestartInstance(ctx context.Context, ns, name string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}

	tmplMeta := map[string]any{
		"annotations": map[string]any{
			"gamectl.io/restartedAt": time.Now().UTC().Format(time.RFC3339),
		},
	}
	tmplSpec := map[string]any{}

	// Fold a pending auto-update choice into this rollout's pod template.
	if choice, ok := dep.Annotations[autoUpdateAnno]; ok && len(dep.Spec.Template.Spec.Containers) > 0 {
		cont := dep.Spec.Template.Spec.Containers[0]
		if spec := autoUpdateSpecFor(cont.Env); spec != nil {
			val := spec.OffVal
			if strings.EqualFold(choice, "on") {
				val = spec.OnVal
			}
			tmplSpec["containers"] = []map[string]any{
				{"name": cont.Name, "env": []map[string]any{{"name": spec.Name, "value": val}}},
			}
		}
	}

	tmpl := map[string]any{"metadata": tmplMeta}
	if len(tmplSpec) > 0 {
		tmpl["spec"] = tmplSpec
	}
	patch, err := json.Marshal(map[string]any{"spec": map[string]any{"template": tmpl}})
	if err != nil {
		return err
	}
	_, err = b.clientset.AppsV1().Deployments(ns).Patch(
		ctx, name, types.StrategicMergePatchType, patch, metav1.PatchOptions{})
	return err
}

// Scale sets the desired replicas on the named Deployment via the scale subresource.
func (c *Cluster) Scale(ctx context.Context, ns, name string, replicas int32) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	scale := &autoscalingv1.Scale{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec:       autoscalingv1.ScaleSpec{Replicas: replicas},
	}
	_, err := b.clientset.AppsV1().Deployments(ns).UpdateScale(ctx, name, scale, metav1.UpdateOptions{})
	return err
}

// DeleteOptions tunes how DeleteInstance sweeps a game instance.
type DeleteOptions struct {
	// WipeData removes the NFS-backed data directory after the Kubernetes
	// resources are gone. Off by default — operators usually want NFS data
	// preserved so a redeploy with the same serverName picks up where the
	// previous instance left off.
	WipeData bool
}

// DeleteResult is the wire shape for a successful DELETE /games/instances response.
type DeleteResult struct {
	Ok       bool     `json:"ok"`
	Deleted  []string `json:"deleted"`
	DataWipe string   `json:"dataWipe,omitempty"` // "skipped" | "removed:<path>" | "failed:<err>"
}

// DeleteInstance sweeps a game instance WITHIN the gamectl namespace
// (single-namespace hardening — the namespaced Role cannot, and must not,
// touch namespaces or PVs):
//
//   - Deployment/<name>
//   - Service/<name> AND Service/<name>-service (the wizard convention)
//   - PVCs labelled gamectl.io/instance=<name> (dynamic-StorageClass
//     games) + legacy <name>-pvc by name
//
// It never deletes a Namespace or a PersistentVolume. Waits for the
// Deployment to actually disappear so the UI's optimistic removal matches
// reality. 404s are treated as "nothing to do" (idempotent re-runs).
//
// If opts.WipeData is set and the Deployment has an inline NFS volume, that
// directory is rm -rf'd via a short-lived privileged helper pod, guarded by
// validateWipeTarget + the .gamectl-owned marker. Local/dynamic storage is
// reported as skipped. Wipe errors are reported in DataWipe but don't fail
// the overall delete — by then the cluster is already clean.
func (c *Cluster) DeleteInstance(ctx context.Context, ns, name string, opts DeleteOptions, rep PhaseReporter) (DeleteResult, error) {
	if rep == nil {
		rep = nopReporter{}
	}
	b := c.snap()
	if b == nil {
		return DeleteResult{}, ErrNotConfigured
	}

	out := DeleteResult{Deleted: []string{}}
	var errs []string

	// Everything GameCTL manages lives in `gamectl` (single-namespace
	// hardening). The namespaced Role cannot touch namespaces or PVs, and
	// must NEVER delete the gamectl namespace itself — so deletion is a
	// label-scoped sweep WITHIN gamectl, never a namespace nuke.
	ns = nsGamectl
	sel := GamectlSelector(name) // managed-by=gamectl,gamectl.io/instance=<name>

	// 1. If WipeData, read the inline NFS volume off the Deployment BEFORE
	//    deleting it (post-hardening there is no PV to read back).
	var nfsServer, nfsPath string
	if opts.WipeData {
		if dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{}); err == nil {
			for _, v := range dep.Spec.Template.Spec.Volumes {
				if v.NFS != nil {
					nfsServer, nfsPath = v.NFS.Server, v.NFS.Path
					break
				}
			}
		}
	}

	// 2. Delete the workload + its Services + any dynamic PVCs, scoped to
	//    gamectl. Deployment/Service by name (both conventions); PVCs by the
	//    instance label so dynamic-StorageClass claims are swept too.
	{
		ph := rep.BeginPhase("Delete Deployment/"+name, "in "+ns)
		err := b.clientset.AppsV1().Deployments(ns).Delete(ctx, name, metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			rep.EndPhase(ph, err)
			errs = append(errs, "Deployment: "+err.Error())
		} else {
			rep.EndPhase(ph, nil)
			if err == nil {
				out.Deleted = append(out.Deleted, "Deployment/"+name)
			}
		}
	}
	for _, svcName := range []string{name, name + "-service"} {
		ph := rep.BeginPhase("Delete Service/"+svcName, "in "+ns)
		err := b.clientset.CoreV1().Services(ns).Delete(ctx, svcName, metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			rep.EndPhase(ph, err)
			errs = append(errs, "Service/"+svcName+": "+err.Error())
			continue
		}
		rep.EndPhase(ph, nil)
		if err == nil {
			out.Deleted = append(out.Deleted, "Service/"+svcName)
		}
	}
	{
		ph := rep.BeginPhase("Delete PVCs", "label "+sel)
		pvcs := b.clientset.CoreV1().PersistentVolumeClaims(ns)
		// list + delete-by-name (the namespaced Role grants list/delete but
		// NOT deletecollection — a distinct verb we deliberately don't add).
		var perr error
		if list, lerr := pvcs.List(ctx, metav1.ListOptions{LabelSelector: sel}); lerr != nil {
			perr = lerr
		} else {
			for _, p := range list.Items {
				if derr := pvcs.Delete(ctx, p.Name, metav1.DeleteOptions{}); derr != nil && !apierrors.IsNotFound(derr) {
					perr = derr
				} else if derr == nil {
					out.Deleted = append(out.Deleted, "PVC/"+p.Name)
				}
			}
		}
		// Legacy by-name PVC (pre-label instances), best-effort.
		_ = pvcs.Delete(ctx, name+"-pvc", metav1.DeleteOptions{})
		if perr != nil && !apierrors.IsNotFound(perr) {
			rep.EndPhase(ph, perr)
			errs = append(errs, "PVCs: "+perr.Error())
		} else {
			rep.EndPhase(ph, nil)
		}
	}

	// 3. Wait for the Deployment to actually disappear so the UI's
	//    "deleted" confirmation matches reality.
	waitCtx, cancel := context.WithTimeout(ctx, 90*time.Second)
	defer cancel()
	{
		ph := rep.BeginPhase("Wait for Deployment/"+name+" to terminate", "")
		err := waitDeploymentGone(waitCtx, c, ns, name)
		rep.EndPhase(ph, err)
		if err != nil {
			errs = append(errs, "wait Deployment/"+name+": "+err.Error())
		}
	}

	// 4. NFS wipe (best-effort, after k8s is clean). Marker-guarded.
	switch {
	case !opts.WipeData:
		out.DataWipe = "skipped"
	case nfsServer == "" || nfsPath == "":
		out.DataWipe = "skipped (no NFS volume — local/dynamic storage)"
	default:
		ph := rep.BeginPhase("Wipe NFS data "+nfsServer+":"+nfsPath, "rm -rf via privileged helper pod")
		err := c.wipeNFSPath(ctx, nfsServer, nfsPath)
		rep.EndPhase(ph, err)
		if err != nil {
			out.DataWipe = "failed: " + err.Error()
		} else {
			out.DataWipe = "removed: " + nfsServer + ":" + nfsPath
		}
	}

	if len(errs) > 0 {
		return out, fmt.Errorf("%s", strings.Join(errs, "; "))
	}
	out.Ok = true
	return out, nil
}

func waitDeploymentGone(ctx context.Context, c *Cluster, ns, name string) error {
	b := c.snap()
	for {
		_, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if apierrors.IsNotFound(err) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(1 * time.Second):
		}
	}
}
