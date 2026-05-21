package kube

import "fmt"

// nsGamectl is the single namespace every GameCTL-managed resource lives in
// (see the README). Mirrors storageNS; named for use at apply time.
const nsGamectl = "gamectl"

// gamectlLabels are stamped on every applied object so the whole fleet — and
// each instance — is selectable by label instead of by namespace.
//
// IMPORTANT: do NOT include keys that generators put in a Deployment's
// spec.selector.matchLabels (app, game, app.kubernetes.io/part-of). The
// normalizer only mutates object/pod-template labels, not the selector, so
// changing a selector key here makes selector != template and Kubernetes
// rejects the Deployment. managed-by is already set to "gamectl" by the
// generators (same value → harmless), and gamectl.io/instance is a new key
// absent from selectors (selector ⊆ template stays valid).
func gamectlLabels(instance string) map[string]any {
	l := map[string]any{
		"app.kubernetes.io/managed-by": "gamectl",
	}
	if instance != "" {
		l["gamectl.io/instance"] = instance
	}
	return l
}

// normalizeForGamectl rewrites a wizard/catalog manifest bundle so it is
// safe under the namespaced Role (the README, Option D):
//
//   - drops Namespace and PersistentVolume documents (cluster-scoped; the
//     namespaced Role cannot create them and they are no longer needed),
//   - forces every remaining object into the `gamectl` namespace,
//   - stamps the managed-by + gamectl.io/instance labels on every object
//     (and on pod templates) so delete can sweep by label,
//   - converts each NFS/hostPath PV+PVC graph into an inline pod volume on
//     the referencing workloads, so no PV/PVC/StorageClass is needed.
//
// Dynamic-StorageClass PVCs (no volumeName, non-static storageClassName) are
// left untouched — PVCs are namespaced and allowed.
func normalizeForGamectl(docs []map[string]any) []map[string]any {
	// Pass 1: index PV name -> inline volume source; PVC name -> PV name.
	pvSource := map[string]map[string]any{} // pvName -> {"nfs":...} or {"hostPath":...}
	pvcToPV := map[string]string{}
	for _, d := range docs {
		switch str(d, "kind") {
		case "PersistentVolume":
			name := metaName(d)
			spec, _ := d["spec"].(map[string]any)
			if spec == nil {
				continue
			}
			if nfs, ok := spec["nfs"].(map[string]any); ok {
				pvSource[name] = map[string]any{"nfs": nfs}
			} else if hp, ok := spec["hostPath"].(map[string]any); ok {
				pvSource[name] = map[string]any{"hostPath": hp}
			}
		case "PersistentVolumeClaim":
			spec, _ := d["spec"].(map[string]any)
			if spec == nil {
				continue
			}
			if vn, ok := spec["volumeName"].(string); ok && vn != "" {
				pvcToPV[metaName(d)] = vn
			}
		}
	}
	// pvcName -> inline volume source (only for static PV-backed PVCs).
	pvcInline := map[string]map[string]any{}
	for pvc, pv := range pvcToPV {
		if src, ok := pvSource[pv]; ok {
			pvcInline[pvc] = src
		}
	}

	out := make([]map[string]any, 0, len(docs))
	for _, d := range docs {
		if d == nil {
			continue
		}
		kind := str(d, "kind")
		if kind == "Namespace" || kind == "PersistentVolume" {
			continue // cluster-scoped / unneeded
		}
		if kind == "PersistentVolumeClaim" {
			if _, static := pvcInline[metaName(d)]; static {
				continue // folded into an inline pod volume below
			}
			// Dynamic-StorageClass PVC: keep, just namespace + label it.
		}

		instance := instanceOf(d)
		forceNamespace(d, nsGamectl)
		stampLabels(d, instance)

		if kind == "Deployment" || kind == "StatefulSet" || kind == "DaemonSet" {
			rewritePodVolumes(d, pvcInline, instance)
		}
		out = append(out, d)
	}
	return out
}

// rewritePodVolumes replaces each volume whose persistentVolumeClaim points
// at a static PV-backed claim with the equivalent inline nfs/hostPath
// volume, and stamps the pod template labels.
func rewritePodVolumes(d map[string]any, pvcInline map[string]map[string]any, instance string) {
	spec, _ := d["spec"].(map[string]any)
	if spec == nil {
		return
	}
	tmpl, _ := spec["template"].(map[string]any)
	if tmpl == nil {
		return
	}
	// Pod template labels — additive (selector left untouched; immutable).
	if tm, ok := tmpl["metadata"].(map[string]any); ok {
		mergeLabels(tm, instance)
	} else {
		tmpl["metadata"] = map[string]any{"labels": gamectlLabels(instance)}
	}
	pspec, _ := tmpl["spec"].(map[string]any)
	if pspec == nil {
		return
	}
	vols, _ := pspec["volumes"].([]any)
	for _, v := range vols {
		vm, ok := v.(map[string]any)
		if !ok {
			continue
		}
		pvc, ok := vm["persistentVolumeClaim"].(map[string]any)
		if !ok {
			continue
		}
		claim, _ := pvc["claimName"].(string)
		src, static := pvcInline[claim]
		if !static {
			continue // dynamic PVC — leave as-is
		}
		delete(vm, "persistentVolumeClaim")
		for k, val := range src { // exactly one of nfs/hostPath
			vm[k] = val
		}
	}
}

// --- small helpers (unstructured maps) ---

func str(m map[string]any, k string) string { s, _ := m[k].(string); return s }

func metaName(d map[string]any) string {
	if md, ok := d["metadata"].(map[string]any); ok {
		return str(md, "name")
	}
	return ""
}

// instanceOf derives the per-instance label value: the generators set
// metadata.labels.app to the serverName; fall back to the object name.
func instanceOf(d map[string]any) string {
	if md, ok := d["metadata"].(map[string]any); ok {
		if lbl, ok := md["labels"].(map[string]any); ok {
			if a, ok := lbl["app"].(string); ok && a != "" {
				return a
			}
		}
	}
	return metaName(d)
}

func forceNamespace(d map[string]any, ns string) {
	md, ok := d["metadata"].(map[string]any)
	if !ok {
		md = map[string]any{}
		d["metadata"] = md
	}
	md["namespace"] = ns
}

func stampLabels(d map[string]any, instance string) {
	md, ok := d["metadata"].(map[string]any)
	if !ok {
		md = map[string]any{}
		d["metadata"] = md
	}
	mergeLabels(md, instance)
}

func mergeLabels(meta map[string]any, instance string) {
	lbl, ok := meta["labels"].(map[string]any)
	if !ok {
		lbl = map[string]any{}
		meta["labels"] = lbl
	}
	for k, v := range gamectlLabels(instance) {
		lbl[k] = v
	}
}

// GamectlSelector is the label selector the delete path / dashboard use to
// find everything for one instance within the gamectl namespace.
func GamectlSelector(instance string) string {
	return fmt.Sprintf("app.kubernetes.io/managed-by=gamectl,gamectl.io/instance=%s", instance)
}
