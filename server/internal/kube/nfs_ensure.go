package kube

import (
	"context"
	"fmt"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// ownedMarker is a sentinel file GameCTL drops into every NFS data directory
// it provisions (ensureNFSPath). wipeNFSPath refuses to delete a directory
// that does not contain this marker — so a destructive wipe can only ever
// target a directory GameCTL itself created, never an arbitrary path that
// happened to come through a (possibly user-contributed) catalog template.
const ownedMarker = ".gamectl-owned"

// defaultWipeMinDepth is the minimum number of path segments a wipe target
// must have. Blocks share roots like "/", "/mnt", "/mnt/1TBSSD" while
// allowing real per-workload dirs like "/mnt/1TBSSD/minecraft" (3 segments).
const defaultWipeMinDepth = 3

// validateWipeTarget is the pure, structural half of the NFS-wipe guard
// (the ownership marker is the runtime half, enforced inside the pod). It
// rejects anything that isn't a clean, absolute, sufficiently-deep path with
// no traversal, and — if GAMECTL_NFS_WIPE_REQUIRE_PREFIX is set — anything
// not under that prefix. Returns nil only if p is safe to consider wiping.
func validateWipeTarget(p string) error {
	if p == "" || !strings.HasPrefix(p, "/") {
		return fmt.Errorf("refusing to wipe %q: not an absolute path", p)
	}
	if p != path.Clean(p) {
		return fmt.Errorf("refusing to wipe %q: not a normalized path (cleans to %q)", p, path.Clean(p))
	}
	segs := []string{}
	for _, s := range strings.Split(strings.Trim(p, "/"), "/") {
		if s == "" || s == "." {
			return fmt.Errorf("refusing to wipe %q: empty path segment", p)
		}
		if s == ".." {
			return fmt.Errorf("refusing to wipe %q: path traversal segment", p)
		}
		segs = append(segs, s)
	}

	minDepth := defaultWipeMinDepth
	if v := os.Getenv("GAMECTL_NFS_WIPE_MIN_DEPTH"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			minDepth = n
		}
	}
	if len(segs) < minDepth {
		return fmt.Errorf("refusing to wipe %q: only %d path segment(s), need at least %d "+
			"(prevents wiping a share root)", p, len(segs), minDepth)
	}

	if prefix := os.Getenv("GAMECTL_NFS_WIPE_REQUIRE_PREFIX"); prefix != "" {
		prefix = "/" + strings.Trim(prefix, "/")
		if p != prefix && !strings.HasPrefix(p, prefix+"/") {
			return fmt.Errorf("refusing to wipe %q: not under required prefix %q", p, prefix)
		}
	}
	return nil
}

// nfsTarget is one (server, exported-path) pair we need to ensure exists on
// the NFS server before apply, so the kubelet doesn't get stuck in
// ContainerCreating with "mount.nfs: ... No such file or directory" when a
// brand-new game is deployed against a fresh directory.
type nfsTarget struct {
	Server string
	Path   string
}

// extractNFSTargets pulls every PersistentVolume.spec.nfs target out of a
// batch of manifests. Returns unique (server, path) pairs in input order.
func extractNFSTargets(docs []map[string]any) []nfsTarget {
	seen := map[string]bool{}
	var out []nfsTarget
	for _, d := range docs {
		if d == nil {
			continue
		}
		kind, _ := d["kind"].(string)
		if kind != "PersistentVolume" {
			continue
		}
		spec, _ := d["spec"].(map[string]any)
		if spec == nil {
			continue
		}
		nfs, _ := spec["nfs"].(map[string]any)
		if nfs == nil {
			continue
		}
		server, _ := nfs["server"].(string)
		p, _ := nfs["path"].(string)
		if server == "" || p == "" {
			continue
		}
		key := server + ":" + p
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, nfsTarget{Server: server, Path: p})
	}
	return out
}

// ensureNFSPath makes sure <server>:<path> exists on the NFS server by
// running a short-lived privileged pod that mounts the parent export and
// mkdir -p's the leaf. Idempotent — if the directory already exists, mkdir
// is a no-op. Returns nil on success.
//
// Helper pod runs in the gamectl namespace (GameCTL's own, always present)
// — the namespaced Role only permits pod creation there.
func (c *Cluster) ensureNFSPath(ctx context.Context, server, p string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	parent := path.Dir(p)
	leaf := path.Base(p)
	if parent == "" || parent == "." || parent == "/" || leaf == "" || leaf == "/" {
		return fmt.Errorf("invalid NFS path %q (need at least one path segment)", p)
	}

	podName := fmt.Sprintf("gamectl-nfs-ensure-%d", time.Now().UnixNano()/1e6)
	helperNS := nsGamectl // helper pods run in GameCTL's own namespace (namespaced Role)
	priv := true

	// alpine + apk add nfs-utils is ~3s on a warm node; cheap. We mount the
	// parent (not the leaf — leaf may not exist yet, which is the whole point)
	// then mkdir+chmod the leaf. 0777 matches the homelab convention for the
	// shared NFS data dirs so any UID inside a game container can write.
	script := fmt.Sprintf(
		"set -e; apk add --no-cache nfs-utils >/dev/null 2>&1; mkdir -p /p; "+
			"mount -t nfs -o nfsvers=4.2,retry=0,timeo=30 %s:%s /p; "+
			"mkdir -p /p/%s; chmod 0777 /p/%s; touch /p/%s/%s; umount /p",
		server, parent, leaf, leaf, leaf, ownedMarker,
	)

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName,
			Namespace: helperNS,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "gamectl",
				"app.kubernetes.io/component":  "nfs-ensure",
			},
		},
		Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever,
			Containers: []corev1.Container{{
				Name:    "mkdir",
				Image:   "alpine:3.20",
				Command: []string{"sh", "-c", script},
				SecurityContext: &corev1.SecurityContext{
					Privileged: &priv,
				},
			}},
		},
	}

	cs := b.clientset
	if _, err := cs.CoreV1().Pods(helperNS).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		return fmt.Errorf("create nfs-ensure pod: %w", err)
	}
	defer func() {
		grace := int64(0)
		_ = cs.CoreV1().Pods(helperNS).Delete(
			context.Background(), podName,
			metav1.DeleteOptions{GracePeriodSeconds: &grace},
		)
	}()

	return waitPodTerminal(ctx, cs, helperNS, podName, 90*time.Second)
}

// wipeNFSPath removes <server>:<path> entirely (rm -rf the leaf) by mounting
// the parent export from a short-lived privileged pod. Used as the "Also
// delete data" half of DeleteInstance. Idempotent — missing leaf is fine.
func (c *Cluster) wipeNFSPath(ctx context.Context, server, p string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	// Structural guard (pure, testable). The ownership-marker check below is
	// the second, runtime layer enforced inside the pod itself.
	if err := validateWipeTarget(p); err != nil {
		return err
	}
	parent := path.Dir(p)
	leaf := path.Base(p)

	podName := fmt.Sprintf("gamectl-nfs-wipe-%d", time.Now().UnixNano()/1e6)
	helperNS := nsGamectl // helper pods run in GameCTL's own namespace (namespaced Role)
	priv := true

	// Parallel-rm: NFS unlinks are RPC round-trips, so a serial `rm -rf` on a
	// large minecraft world (10k+ files) easily takes 5-10 minutes. xargs
	// -P8 parallelizes the unlinks across 8 workers — measured ~6x speedup
	// against the homelab NFS server on a 16k-file minecraft dir.
	//
	// Two-phase: kill files first, then empty dirs bottom-up. `find -delete`
	// would do both but doesn't parallelize.
	script := fmt.Sprintf(
		"set +e; apk add --no-cache nfs-utils findutils >/dev/null 2>&1; mkdir -p /p; "+
			"mount -t nfs -o nfsvers=4.2,retry=0,timeo=30 %s:%s /p || exit $?; "+
			// Defense in depth: refuse to delete anything that isn't a
			// GameCTL-provisioned dir, enforced AT the point of destruction
			// (not just in Go) so a bypassed/buggy caller still can't wipe
			// an arbitrary export.
			"if [ ! -f /p/%s/%s ]; then echo 'refusing wipe: %s missing GameCTL ownership marker (%s)'; umount /p; exit 3; fi; "+
			"find /p/%s -type f -print0 2>/dev/null | xargs -0 -n200 -P8 rm -f 2>/dev/null; "+
			"find /p/%s -depth -type d -empty -delete 2>/dev/null; "+
			"umount /p",
		server, parent, leaf, ownedMarker, leaf, ownedMarker, leaf, leaf,
	)

	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      podName,
			Namespace: helperNS,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "gamectl",
				"app.kubernetes.io/component":  "nfs-wipe",
			},
		},
		Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever,
			Containers: []corev1.Container{{
				Name:    "wipe",
				Image:   "alpine:3.20",
				Command: []string{"sh", "-c", script},
				SecurityContext: &corev1.SecurityContext{
					Privileged: &priv,
				},
			}},
		},
	}

	cs := b.clientset
	if _, err := cs.CoreV1().Pods(helperNS).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		return fmt.Errorf("create nfs-wipe pod: %w", err)
	}
	defer func() {
		grace := int64(0)
		_ = cs.CoreV1().Pods(helperNS).Delete(
			context.Background(), podName,
			metav1.DeleteOptions{GracePeriodSeconds: &grace},
		)
	}()

	// 10min ceiling: even a 100k-file world finishes in ~3min with the
	// parallel pattern above, so this is generous head-room for "the
	// pod got rescheduled and is slow to restart" cases too.
	return waitPodTerminal(ctx, cs, helperNS, podName, 10*time.Minute)
}

// waitPodTerminal polls a pod until it succeeds, fails, the context cancels,
// or timeout elapses. Returns nil only on PodSucceeded.
func waitPodTerminal(ctx context.Context, cs kubernetes.Interface, ns, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		pod, err := cs.CoreV1().Pods(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			if apierrors.IsNotFound(err) {
				return fmt.Errorf("pod %s/%s disappeared before completing", ns, name)
			}
			return err
		}
		switch pod.Status.Phase {
		case corev1.PodSucceeded:
			return nil
		case corev1.PodFailed:
			return fmt.Errorf("nfs-ensure pod failed: %s", podTerminalMessage(pod))
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("nfs-ensure pod did not finish within %s (phase=%s)", timeout, pod.Status.Phase)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(1 * time.Second):
		}
	}
}

func podTerminalMessage(pod *corev1.Pod) string {
	for _, s := range pod.Status.ContainerStatuses {
		if s.State.Terminated != nil {
			t := s.State.Terminated
			msg := t.Message
			if msg == "" {
				msg = t.Reason
			}
			return fmt.Sprintf("exit %d: %s", t.ExitCode, msg)
		}
	}
	return "no terminated container status"
}
