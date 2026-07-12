package kube

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// StorageProbeResult is the structured outcome of a Test against a
// StorageLocation. Stages run in order; the first failure short-circuits and
// the failing stage is reported back so the UI can give a targeted hint.
//
// Stage values:
//
//	"mount"   — Pod stuck in ContainerCreating; the volume couldn't be
//	            mounted at all (server unreachable, export not granted to
//	            this node, NFS client missing on the node, etc.).
//	"mkdir"   — Mount succeeded but creating the probe subdir failed
//	            (typical read-only export or root_squash + wrong uid).
//	"write"   — Subdir exists but writing the test file failed.
//	"read"    — Wrote ok but read-back returned different bytes
//	            (filesystem-level weirdness; rare).
//	"delete"  — Read-back ok but cleanup unlink failed.
//	"timeout" — The probe Pod didn't complete inside the deadline.
//	"setup"   — GameCTL itself couldn't create or list the probe Pod
//	            (RBAC, namespace missing, kube client gone).
//	""        — Success.
type StorageProbeResult struct {
	OK         bool   `json:"ok"`
	Stage      string `json:"stage,omitempty"`
	Message    string `json:"message,omitempty"`
	Hint       string `json:"hint,omitempty"`
	DurationMS int64  `json:"durationMs"`
	// Details carries the raw pod log / event message — useful when the
	// classifier can't pin down the cause, so the operator can see exactly
	// what the kernel/NFS layer reported.
	Details string `json:"details,omitempty"`
	// Steps is the deterministic ordered list of probe checks, each with
	// its own pass/fail. Lets the UI show "Mount ✓ · mkdir ✓ · write ✗"
	// so the operator sees exactly which step the run got to, not just
	// the final failing stage.
	Steps []StorageProbeStep `json:"steps,omitempty"`
}

// StorageProbeStep is one row in the result's step list. Description is a
// short human label suitable for direct UI display.
type StorageProbeStep struct {
	Name        string `json:"name"`           // matches StorageProbeResult.Stage values
	Description string `json:"description"`    // "Mount volume", "Create test dir", …
	OK          bool   `json:"ok"`             // true if this step ran and succeeded
	Skipped     bool   `json:"skipped,omitempty"` // true if probe failed earlier so we never ran this step
}

// probeStepCatalog defines the five steps the probe script performs, in
// order. Used to seed result.Steps so the UI can render the full plan even
// when an early failure means later stages never executed.
var probeStepCatalog = []StorageProbeStep{
	{Name: "mount", Description: "Mount the share as an inline volume"},
	{Name: "mkdir", Description: "Create the .gamectl-probe test directory"},
	{Name: "write", Description: "Write a small test file"},
	{Name: "read", Description: "Read the file back and verify bytes"},
	{Name: "delete", Description: "Delete the test file"},
}

// buildSteps produces the step list for the result based on what the probe
// log reached. `reached` is the last STAGE marker seen (empty if the pod
// never started). `failedAt` is the stage we attribute the failure to;
// "" means no failure (success path).
func buildSteps(reached, failedAt string) []StorageProbeStep {
	// Translate log "STAGE:ok" → all five steps green. Otherwise the
	// reached stage and everything before it ran successfully (the script
	// only emits the next STAGE marker after the previous one completed).
	steps := make([]StorageProbeStep, len(probeStepCatalog))
	copy(steps, probeStepCatalog)
	// Mount is implicit success once the pod ran any STAGE — the volume
	// is mounted before /bin/sh even starts.
	mountOK := reached != "" || failedAt == ""
	if failedAt == "mount" || failedAt == "timeout" || failedAt == "setup" {
		mountOK = false
	}
	// Walk through and assign pass/fail.
	postMount := []string{"mkdir", "write", "read", "delete"}
	reachedIdx := -1
	for i, n := range postMount {
		if n == reached {
			reachedIdx = i
		}
	}
	okSet := map[string]bool{}
	if mountOK {
		okSet["mount"] = true
	}
	if reached == "ok" {
		for _, n := range postMount {
			okSet[n] = true
		}
	} else if reachedIdx >= 0 {
		// reached stage was announced but may or may not have completed.
		// If failedAt == reached, that step failed; everything before it
		// is OK. Otherwise (reached == failedAt is the typical script
		// failure), still treat preceding steps as OK.
		for i := 0; i < reachedIdx; i++ {
			okSet[postMount[i]] = true
		}
	}
	for i := range steps {
		switch {
		case okSet[steps[i].Name]:
			steps[i].OK = true
		case steps[i].Name == failedAt:
			// leave OK=false, this is the failing step
		default:
			steps[i].Skipped = true
		}
	}
	return steps
}

const (
	probeImage     = "busybox:stable-musl"
	probeNamespace = storageNS // "gamectl"
	probeTimeout   = 20 * time.Second
)

// TestStorageLocation runs a one-shot probe Pod against the given location.
// It mounts the same inline NFS / hostPath volume a real game would use,
// writes + reads + deletes a small file under "<root>/<FolderName>/.gamectl-probe",
// then exits. The pod is always deleted on the way out (best-effort).
//
// The probe is deliberately small and idempotent: no PV/PVC, no StorageClass.
// "Green here" means a real game deploy at this location will be able to
// read+write its per-server subdir.
func (c *Cluster) TestStorageLocation(ctx context.Context, loc StorageLocation) (*StorageProbeResult, error) {
	if err := loc.Validate(); err != nil {
		return &StorageProbeResult{
			OK: false, Stage: "setup", Message: err.Error(),
			Steps: buildSteps("", "setup"),
		}, nil
	}
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	start := time.Now()

	// Random suffix so concurrent tests don't collide, and we don't leak a
	// stale name into the next run if cleanup races.
	idBytes := make([]byte, 4)
	_, _ = rand.Read(idBytes)
	id := hex.EncodeToString(idBytes)
	podName := fmt.Sprintf("gamectl-storage-probe-%s", id)

	// The probe script. Each step prints "STAGE:<name>" before doing the
	// thing, so a non-zero exit + the kubelet's "started by exec failed"
	// noise can still be classified by the last STAGE marker we saw.
	// FolderName() is the top-level GameCTL[-suffix] dir; we touch a
	// .gamectl-probe subdir under it so we never write at the export root.
	folder := loc.FolderName()
	script := fmt.Sprintf(`set -e
ROOT=/probe
DIR="$ROOT/%s/.gamectl-probe"
FILE="$DIR/probe-%s.txt"
EXPECT="gamectl-probe-%s"
echo STAGE:mkdir
mkdir -p "$DIR"
echo STAGE:write
printf '%%s' "$EXPECT" > "$FILE"
echo STAGE:read
GOT="$(cat "$FILE")"
if [ "$GOT" != "$EXPECT" ]; then
  echo "readback mismatch: got=$GOT expect=$EXPECT" >&2
  exit 41
fi
echo STAGE:delete
rm -f "$FILE"
echo STAGE:ok
`, folder, id, id)

	// Inline volume — matches the shape used by every game generator.
	var vol corev1.Volume
	switch {
	case loc.IsLocal():
		vol = corev1.Volume{
			Name: "probe",
			VolumeSource: corev1.VolumeSource{
				HostPath: &corev1.HostPathVolumeSource{
					Path: loc.ExportPath,
					Type: hostPathType(corev1.HostPathDirectoryOrCreate),
				},
			},
		}
	default:
		vol = corev1.Volume{
			Name: "probe",
			VolumeSource: corev1.VolumeSource{
				NFS: &corev1.NFSVolumeSource{
					Server: loc.Server,
					Path:   loc.ExportPath,
				},
			},
		}
	}

	gracePeriod := int64(0)
	activeDeadline := int64(probeTimeout.Seconds())
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName,
			Namespace: probeNamespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "gamectl",
				"app.kubernetes.io/component":  "storage-probe",
			},
		},
		Spec: corev1.PodSpec{
			RestartPolicy:                 corev1.RestartPolicyNever,
			TerminationGracePeriodSeconds: &gracePeriod,
			ActiveDeadlineSeconds:         &activeDeadline,
			Containers: []corev1.Container{{
				Name:    "probe",
				Image:   probeImage,
				Command: []string{"/bin/sh", "-c", script},
				VolumeMounts: []corev1.VolumeMount{{
					Name:      "probe",
					MountPath: "/probe",
				}},
			}},
			Volumes: []corev1.Volume{vol},
		},
	}

	pods := b.clientset.CoreV1().Pods(probeNamespace)
	if _, err := pods.Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		return &StorageProbeResult{
			OK:      false,
			Stage:   "setup",
			Message: "couldn't create probe pod: " + err.Error(),
			Hint:    "GameCTL needs pods create permission in the gamectl namespace. Check the gamectl Role/RoleBinding.",
		}, nil
	}
	// Always delete the probe pod on the way out.
	defer func() {
		_ = pods.Delete(context.Background(), podName, metav1.DeleteOptions{GracePeriodSeconds: &gracePeriod})
	}()

	// Poll for termination. ActiveDeadlineSeconds caps run time on the
	// kubelet side; this loop is the client-side fallback if the pod is
	// stuck in ContainerCreating (mount failure) and never reaches
	// Succeeded/Failed.
	deadline := time.Now().Add(probeTimeout)
	var final *corev1.Pod
	for {
		got, err := pods.Get(ctx, podName, metav1.GetOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			return &StorageProbeResult{
				OK:         false,
				Stage:      "setup",
				Message:    "couldn't read probe pod: " + err.Error(),
				DurationMS: time.Since(start).Milliseconds(),
			}, nil
		}
		if got != nil {
			final = got
			if got.Status.Phase == corev1.PodSucceeded || got.Status.Phase == corev1.PodFailed {
				break
			}
		}
		if time.Now().After(deadline) {
			res := &StorageProbeResult{
				OK:         false,
				Stage:      "timeout",
				DurationMS: time.Since(start).Milliseconds(),
			}
			classifyMountStuck(res, final)
			res.Steps = buildSteps("", res.Stage)
			return res, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(400 * time.Millisecond):
		}
	}

	dur := time.Since(start).Milliseconds()
	logs := readProbeLogs(ctx, c, podName)

	if final.Status.Phase == corev1.PodSucceeded && strings.Contains(logs, "STAGE:ok") {
		return &StorageProbeResult{
			OK:         true,
			DurationMS: dur,
			Steps:      buildSteps("ok", ""),
		}, nil
	}

	// Failed — classify by the last STAGE marker the script emitted, then
	// the container exit reason. Mount failures are caught by the timeout
	// branch above (pod never starts), so anything reaching here ran the
	// script and got a non-zero exit somewhere along the way.
	res := &StorageProbeResult{OK: false, DurationMS: dur, Details: strings.TrimSpace(logs)}
	classifyScriptFailure(res, final, logs)
	res.Steps = buildSteps(lastStage(logs), res.Stage)
	return res, nil
}

// readProbeLogs returns stdout+stderr of the probe container, or an empty
// string if the log fetch itself fails (it's best-effort context for the UI).
func readProbeLogs(ctx context.Context, c *Cluster, podName string) string {
	b := c.snap()
	if b == nil {
		return ""
	}
	req := b.clientset.CoreV1().Pods(probeNamespace).GetLogs(podName, &corev1.PodLogOptions{})
	stream, err := req.Stream(ctx)
	if err != nil {
		return ""
	}
	defer stream.Close()
	data, err := io.ReadAll(stream)
	if err != nil {
		return ""
	}
	return string(data)
}

// classifyMountStuck fills in stage/message/hint when the pod never reached a
// terminal phase — almost always a kubelet mount problem. We look at the
// container statuses' waiting reason and the pod events the kubelet writes
// onto the Pod itself for the actionable detail.
func classifyMountStuck(res *StorageProbeResult, pod *corev1.Pod) {
	res.Stage = "mount"
	res.Message = "Probe pod didn't start — the volume couldn't be mounted."
	res.Hint = "Check that the NFS server is reachable from the cluster node and that the export path is granted to the node's IP. Try `showmount -e <server>` from the node, or look at `/etc/exports` on the NFS server."

	if pod == nil {
		return
	}
	// Pull the most specific message we can find.
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Message != "" {
			res.Details = cs.State.Waiting.Message
			break
		}
	}
	if res.Details == "" {
		for _, cs := range pod.Status.InitContainerStatuses {
			if cs.State.Waiting != nil && cs.State.Waiting.Message != "" {
				res.Details = cs.State.Waiting.Message
				break
			}
		}
	}
	if res.Details == "" && pod.Status.Message != "" {
		res.Details = pod.Status.Message
	}
	low := strings.ToLower(res.Details)
	switch {
	case strings.Contains(low, "access denied") || strings.Contains(low, "permission denied"):
		res.Hint = "The NFS server refused the mount. The node's IP probably isn't in the export's allowed list — add it to /etc/exports (or the share's client list) and run `exportfs -ra` on the NFS server."
	case strings.Contains(low, "no route to host") || strings.Contains(low, "connection refused") || strings.Contains(low, "connection timed out"):
		res.Hint = "The NFS server isn't reachable from the node — check the server IP, that nfs-server is running, and that port 2049/TCP is open."
	case strings.Contains(low, "no such file or directory") && strings.Contains(low, "mount"):
		res.Hint = "The export path doesn't exist on the NFS server (or isn't exported under that name)."
	case strings.Contains(low, "mount.nfs") && strings.Contains(low, "not found"):
		res.Hint = "The node doesn't have an NFS client installed. On Debian/Ubuntu: `sudo apt install nfs-common`. On RHEL/Rocky: `sudo dnf install nfs-utils`."
	}
}

// classifyScriptFailure fills in stage/message/hint when the script ran but
// exited non-zero. Last STAGE marker in stdout tells us how far we got.
func classifyScriptFailure(res *StorageProbeResult, pod *corev1.Pod, logs string) {
	last := lastStage(logs)
	switch last {
	case "mkdir":
		res.Stage = "mkdir"
		res.Message = "Mount succeeded but creating the test subdirectory failed."
		res.Hint = "The export is mounted read-only, or root_squash is on and the kubelet's uid can't create dirs under this path. Mark the export `rw` (and consider `no_root_squash`) on the NFS server."
	case "write":
		res.Stage = "write"
		res.Message = "Subdirectory exists but writing the test file failed."
		res.Hint = "Read-only export or filesystem out of space. Check `df -h` on the NFS server and confirm the export is `rw`."
	case "read":
		res.Stage = "read"
		res.Message = "Read-back returned different bytes than were written."
		res.Hint = "Unusual — the export is writable but reads back stale or wrong content. Check for an aggressive NFS cache or that nothing else is writing into the same path."
	case "delete":
		res.Stage = "delete"
		res.Message = "Cleanup unlink failed after a successful write."
		res.Hint = "The probe file is left behind under the .gamectl-probe folder; safe to delete by hand. Usually means the export is `rw` for writes but the file inherited a uid that can't be unlinked by the kubelet."
	default:
		res.Stage = "setup"
		res.Message = "Probe script failed before reaching the first stage."
		res.Hint = "Often a missing /bin/sh in the probe image, or the kubelet OOM-killed the container."
	}
	if res.Details == "" && pod != nil && pod.Status.Message != "" {
		res.Details = pod.Status.Message
	}
}

// lastStage scans for "STAGE:<name>" markers and returns the last one. The
// script emits one before each step so the failing step is whatever stage
// was last announced but didn't reach the next marker.
func lastStage(logs string) string {
	last := ""
	for _, line := range strings.Split(logs, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "STAGE:") {
			last = strings.TrimPrefix(line, "STAGE:")
		}
	}
	return last
}

// hostPathType returns a pointer to a HostPathType (helper for inline pods).
func hostPathType(t corev1.HostPathType) *corev1.HostPathType { return &t }
