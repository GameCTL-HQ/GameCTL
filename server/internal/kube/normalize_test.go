package kube

import "testing"

func TestNormalizeForGamectl(t *testing.T) {
	docs := []map[string]any{
		{"kind": "Namespace", "apiVersion": "v1",
			"metadata": map[string]any{"name": "gamectl-mc"}},
		{"kind": "PersistentVolume", "apiVersion": "v1",
			"metadata": map[string]any{"name": "mc-pv"},
			"spec": map[string]any{"nfs": map[string]any{
				"server": "10.0.0.100", "path": "/mnt/1TBSSD/minecraft"}}},
		{"kind": "PersistentVolumeClaim", "apiVersion": "v1",
			"metadata": map[string]any{"name": "mc-pvc", "namespace": "gamectl-mc"},
			"spec":     map[string]any{"volumeName": "mc-pv"}},
		{"kind": "PersistentVolumeClaim", "apiVersion": "v1",
			"metadata": map[string]any{"name": "dyn-pvc", "namespace": "gamectl-mc"},
			"spec":     map[string]any{"storageClassName": "longhorn"}},
		{"kind": "Deployment", "apiVersion": "apps/v1",
			"metadata": map[string]any{"name": "minecraft", "namespace": "gamectl-mc",
				"labels": map[string]any{"app": "minecraft"}},
			"spec": map[string]any{"template": map[string]any{
				"metadata": map[string]any{"labels": map[string]any{"app": "minecraft"}},
				"spec": map[string]any{"volumes": []any{
					map[string]any{"name": "data", "persistentVolumeClaim": map[string]any{"claimName": "mc-pvc"}},
					map[string]any{"name": "dyn", "persistentVolumeClaim": map[string]any{"claimName": "dyn-pvc"}},
				}}}}},
	}

	out := normalizeForGamectl(docs)

	kinds := map[string]int{}
	for _, d := range out {
		kinds[str(d, "kind")]++
		if md, ok := d["metadata"].(map[string]any); ok {
			if ns, _ := md["namespace"].(string); ns != "" && ns != nsGamectl {
				t.Errorf("%s not moved to gamectl ns (got %q)", str(d, "kind"), ns)
			}
			lbl, _ := md["labels"].(map[string]any)
			if lbl["app.kubernetes.io/managed-by"] != "gamectl" {
				t.Errorf("%s missing managed-by label", str(d, "kind"))
			}
		}
	}
	if kinds["Namespace"] != 0 {
		t.Error("Namespace doc should be dropped")
	}
	if kinds["PersistentVolume"] != 0 {
		t.Error("PersistentVolume doc should be dropped")
	}
	if kinds["PersistentVolumeClaim"] != 1 {
		t.Errorf("static PVC should be folded, dynamic PVC kept; got %d PVCs", kinds["PersistentVolumeClaim"])
	}
	if kinds["Deployment"] != 1 {
		t.Fatal("Deployment missing")
	}

	// The static-PV volume must now be an inline nfs volume; the dynamic
	// PVC volume must be left alone.
	var dep map[string]any
	for _, d := range out {
		if str(d, "kind") == "Deployment" {
			dep = d
		}
	}
	vols := dep["spec"].(map[string]any)["template"].(map[string]any)["spec"].(map[string]any)["volumes"].([]any)
	for _, v := range vols {
		vm := v.(map[string]any)
		switch vm["name"] {
		case "data":
			if _, ok := vm["nfs"]; !ok {
				t.Error("static-PV volume not converted to inline nfs")
			}
			if _, ok := vm["persistentVolumeClaim"]; ok {
				t.Error("static-PV volume still has persistentVolumeClaim")
			}
		case "dyn":
			if _, ok := vm["persistentVolumeClaim"]; !ok {
				t.Error("dynamic PVC volume should be untouched")
			}
		}
	}
}

// TestForceRecreateStrategy covers the Restart-deadlock fix: a rolling
// update schedules the replacement pod while the old one still holds its
// CPU/RAM and its volume, so a single-replica game server must be pinned to
// Recreate. Applied here (not only in the generators) so re-applying an
// already-deployed game repairs it.
func TestForceRecreateStrategy(t *testing.T) {
	volumes := []any{map[string]any{"name": "data",
		"persistentVolumeClaim": map[string]any{"claimName": "dyn-pvc"}}}
	tmplWithVols := map[string]any{"spec": map[string]any{"volumes": volumes}}

	cases := []struct {
		name string
		spec map[string]any
		want bool // expect strategy forced to Recreate
	}{
		{"single replica with volume", map[string]any{
			"replicas": 1, "template": tmplWithVols}, true},
		{"replicas omitted defaults to one", map[string]any{
			"template": tmplWithVols}, true},
		{"float replicas from yaml decoder", map[string]any{
			"replicas": float64(1), "template": tmplWithVols}, true},
		{"already RollingUpdate is overridden", map[string]any{
			"replicas": 1, "template": tmplWithVols,
			"strategy": map[string]any{"type": "RollingUpdate"}}, true},
		// Guards.
		{"scaled out is left alone", map[string]any{
			"replicas": 3, "template": tmplWithVols}, false},
		{"stateless companion keeps zero-downtime rollout", map[string]any{
			"replicas": 1, "template": map[string]any{"spec": map[string]any{}}}, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := map[string]any{"kind": "Deployment", "apiVersion": "apps/v1",
				"metadata": map[string]any{"name": "valheim"}, "spec": tc.spec}
			out := normalizeForGamectl([]map[string]any{d})
			spec := out[0]["spec"].(map[string]any)
			st, _ := spec["strategy"].(map[string]any)
			got := st != nil && st["type"] == "Recreate"
			if got != tc.want {
				t.Errorf("Recreate forced = %v, want %v (strategy=%v)", got, tc.want, spec["strategy"])
			}
		})
	}
}
