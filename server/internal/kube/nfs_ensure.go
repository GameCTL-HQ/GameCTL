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

// nfsFieldSafe reports whether s is safe to interpolate into the `sh -c`
// script the (privileged) NFS helper pod runs. Restricting operator-
// supplied storage values — the NFS server and each path segment — to
// letters/digits/`. _ - :` keeps shell metacharacters, whitespace, and
// control chars out of that script. Storage locations are operator-
// configured (already a trusted role), so this is defense-in-depth, not
// a trust boundary — but the helper pod is Privileged, so it's worth it.
func nfsFieldSafe(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '_' || r == '-' || r == ':':
		default:
			return false
		}
	}
	return true
}

// validateNFSEnsureInput rejects an NFS server / path before it reaches
// the helper pod's `sh -c` script: absolute + normalized path, no
// traversal, every segment within the safe charset.
func validateNFSEnsureInput(server, p string) error {
	if !nfsFieldSafe(server) {
		return fmt.Errorf("invalid NFS server %q (allowed: letters, digits, . _ - :)", server)
	}
	if p == "" || !strings.HasPrefix(p, "/") {
		return fmt.Errorf("invalid NFS path %q: not absolute", p)
	}
	if p != path.Clean(p) {
		return fmt.Errorf("invalid NFS path %q: not normalized (cleans to %q)", p, path.Clean(p))
	}
	for _, seg := range strings.Split(strings.Trim(p, "/"), "/") {
		if seg == ".." {
			return fmt.Errorf("invalid NFS path %q: traversal segment", p)
		}
		if !nfsFieldSafe(seg) {
			return fmt.Errorf("invalid NFS path segment %q in %q (allowed: letters, digits, . _ -)", seg, p)
		}
	}
	return nil
}

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
// creating the leaf. Idempotent. Returns nil on success.
func (c *Cluster) ensureNFSPath(ctx context.Context, server, p string) error {
	parent := path.Dir(p)
	leaf := path.Base(p)
	if parent == "" || parent == "." || parent == "/" || leaf == "" || leaf == "/" {
		return fmt.Errorf("invalid NFS path %q (need at least one path segment)", p)
	}
	return c.ensureNFSPathUnder(ctx, server, parent, leaf)
}

// ensureNFSPathUnder makes sure <exportRoot>/<rel> exists and is writable by
// any uid, by running a short-lived privileged pod that mounts exportRoot
// (which must already exist as a mountable export path) and walks rel one
// segment at a time: missing dirs are created 0777; dirs that already exist
// get a best-effort chmod 0777 — that heals dirs a previous run created
// root-owned 0755 (e.g. via a no_root_squash client) that a root_squash'd
// client can't write into. The final writability proof is the ownership
// marker touched in the leaf: if that fails, the whole ensure fails with a
// classified hint. rel may span multiple segments ("GameCTL-Backups/foo").
//
// On failure the returned error carries the pod's stdout/stderr (including
// the literal mount.nfs error message) plus a classified hint when the
// stage and exit code match a known pattern. The phrase "exit 32: " with
// no further context used to bubble all the way to the UI here — now the
// caller sees "mount.nfs: access denied by server while mounting …" + a
// root-squash / export-allowlist hint.
//
// Helper pod runs in the gamectl namespace (GameCTL's own, always present)
// — the namespaced Role only permits pod creation there.
func (c *Cluster) ensureNFSPathUnder(ctx context.Context, server, exportRoot, rel string) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	rel = strings.Trim(rel, "/")
	if rel == "" || rel == "." {
		return fmt.Errorf("invalid NFS relative path %q (need at least one path segment)", rel)
	}
	p := path.Join(exportRoot, rel)
	// Charset-gate server + path before they reach the helper pod's
	// `sh -c` script (the pod is Privileged — keep shell syntax out).
	if err := validateNFSEnsureInput(server, p); err != nil {
		return err
	}

	podName := fmt.Sprintf("gamectl-nfs-ensure-%d", time.Now().UnixNano()/1e6)
	helperNS := nsGamectl // helper pods run in GameCTL's own namespace (namespaced Role)
	priv := true

	// alpine + apk add nfs-utils is ~3s on a warm node; cheap. We mount the
	// export root (not the leaf — leaf may not exist yet, which is the whole
	// point) then mkdir+chmod each missing segment of REL. 0777 matches the
	// homelab convention for the shared NFS data dirs so any UID inside a
	// game container can write.
	//
	// The script emits structured STEP:/FAIL: markers so we can attribute
	// the failure to the right phase (apk / mount / stat / mkdir / chmod /
	// touch) and surface the actual stderr to the UI. `stat -c` on the
	// export root catches the "parent owned by root on the NFS server with
	// root_squash on" case before we even attempt mkdir — that's the most
	// common silent failure when an operator creates the share by hand.
	//
	// Segments that already exist get a best-effort chmod 0777 (only the
	// owner may chmod, so `|| true` — the marker touch at the end is the
	// hard writability check). That heals dirs created 0755 by an earlier
	// unsquashed run that a squashed client can't write into.
	//
	// `nolock` matters on v3-only NFS servers: without it mount.nfs spawns
	// rpc.statd via start-statd, which calls GNU `flock -e` — busybox's
	// flock has no -e, so statd dies and the mount fails RC=32 with
	// "flock: unrecognized option: e" buried in stderr. We only stat/mkdir
	// here, so NLM locking is useless anyway (v4 ignores the option).
	script := fmt.Sprintf(`set +e
ROOT_PARENT=%s
REL=%s
MARKER=%s
SERVER=%s
echo "STEP:apk"
apk add --no-cache nfs-utils >/tmp/apk.err 2>&1
RC=$?
if [ $RC -ne 0 ]; then echo "FAIL:apk RC=$RC"; cat /tmp/apk.err >&2; exit $RC; fi
mkdir -p /p
echo "STEP:mount SERVER=$SERVER PARENT=$ROOT_PARENT"
mount -t nfs -o retry=0,timeo=30,nolock "$SERVER":"$ROOT_PARENT" /p 2>/tmp/mount.err
RC=$?
if [ $RC -ne 0 ]; then
  echo "FAIL:mount RC=$RC"
  cat /tmp/mount.err >&2
  exit $RC
fi
echo "STEP:stat-parent"
PARENT_STAT="$(stat -c 'owner=%%u:%%g mode=%%a' /p 2>/tmp/stat.err)"
RC=$?
if [ $RC -ne 0 ]; then echo "FAIL:stat-parent RC=$RC"; cat /tmp/stat.err >&2; umount /p; exit $RC; fi
echo "INFO:parent $PARENT_STAT"
D=/p
for seg in $(echo "$REL" | tr / ' '); do
  if [ -d "$D/$seg" ]; then
    chmod 0777 "$D/$seg" 2>/dev/null || true
  else
    echo "STEP:mkdir-leaf LEAF=$seg"
    mkdir "$D/$seg" 2>/tmp/mkdir.err
    RC=$?
    if [ $RC -ne 0 ]; then
      echo "FAIL:mkdir-leaf RC=$RC PARENT=$PARENT_STAT"
      cat /tmp/mkdir.err >&2
      umount /p
      exit $RC
    fi
    echo "STEP:chmod-leaf"
    chmod 0777 "$D/$seg" 2>/tmp/chmod.err
    RC=$?
    if [ $RC -ne 0 ]; then
      echo "FAIL:chmod-leaf RC=$RC"
      cat /tmp/chmod.err >&2
      umount /p
      exit $RC
    fi
  fi
  D="$D/$seg"
done
echo "STEP:touch-marker"
touch "$D/$MARKER" 2>/tmp/touch.err
RC=$?
if [ $RC -ne 0 ]; then
  echo "FAIL:touch-marker RC=$RC"
  cat /tmp/touch.err >&2
  umount /p
  exit $RC
fi
umount /p
echo "STEP:ok"
`, exportRoot, rel, ownedMarker, server)

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

	waitErr := waitPodTerminal(ctx, cs, helperNS, podName, 90*time.Second)
	if waitErr == nil {
		return nil
	}
	// Failed. Pull the pod log + classify exit code into a human hint, then
	// rewrap the error so the task UI sees something actionable instead of
	// just "exit 32:".
	logs, _ := readEnsurePodLogs(ctx, cs, helperNS, podName)
	classified := classifyEnsureFailure(server, p, waitErr, logs)
	if classified != "" {
		return fmt.Errorf("%w\n\n%s", waitErr, classified)
	}
	return waitErr
}

// readEnsurePodLogs pulls combined stdout+stderr from the helper pod's only
// container. Best-effort — empty string on any client error.
func readEnsurePodLogs(ctx context.Context, cs kubernetes.Interface, ns, name string) (string, error) {
	raw, err := cs.CoreV1().Pods(ns).GetLogs(name, &corev1.PodLogOptions{}).DoRaw(ctx)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

// classifyEnsureFailure builds a human-readable, actionable explanation of an
// nfs-ensure failure given the wait error and the pod's combined log output.
//
// The first line is always a one-sentence summary the UI can show as a
// headline. Subsequent lines are a hint paragraph + the raw pod log so the
// operator can paste it into a bug report without going hunting in kubectl.
//
// Returns "" when we can't add anything useful beyond the original waitErr.
func classifyEnsureFailure(server, p string, waitErr error, logs string) string {
	if logs == "" {
		return ""
	}
	lo := strings.ToLower(logs)
	// Identify the last STEP/FAIL marker the script emitted.
	failStage, exitCode := parseEnsureMarkers(logs)
	headline := ""
	hint := ""
	switch failStage {
	case "apk":
		headline = "alpine: couldn't install nfs-utils in the helper pod."
		hint = "The cluster's outbound DNS / TLS to dl-cdn.alpinelinux.org is blocked. Add internet egress for pods in the gamectl namespace, or run a local apk mirror."
	case "mount":
		// mount.nfs exits 32 for almost everything — disambiguate by stderr.
		switch {
		case strings.Contains(lo, "access denied"):
			headline = fmt.Sprintf("NFS server %s refused the mount of %s.", server, path.Dir(p))
			hint = "Add the cluster node's IP to the export's allowed client list in /etc/exports (or your NFS server's UI), then run `sudo exportfs -ra`. From a node: `sudo showmount -e " + server + "` should list the export."
		case strings.Contains(lo, "permission denied"):
			headline = "NFS reported permission denied while mounting."
			hint = "Often a squash policy on the NFS server. Verify the export is `rw` and that root_squash isn't blocking the kubelet — `no_root_squash` is the homelab norm."
		case strings.Contains(lo, "no route to host"), strings.Contains(lo, "connection refused"), strings.Contains(lo, "connection timed out"):
			headline = fmt.Sprintf("Couldn't reach NFS server %s.", server)
			hint = "Check the server IP, that nfsd is running (`systemctl status nfs-server`), and that 2049/TCP is open from cluster nodes."
		case strings.Contains(lo, "no such file or directory"):
			headline = fmt.Sprintf("NFS export %s:%s doesn't exist on the server.", server, path.Dir(p))
			hint = "The parent path isn't an exported share. Either export it (`/etc/exports` + `exportfs -ra`), or change the Storage Location's path to one that's already exported. From a node: `sudo showmount -e " + server + "` lists what's exported."
		case strings.Contains(lo, "rpc"), strings.Contains(lo, "portmap"), strings.Contains(lo, "stale"):
			headline = "NFS RPC layer rejected the mount."
			hint = "Usually a stale NFS handle or rpcbind down. On the NFS server: `sudo systemctl restart rpcbind nfs-server`."
		default:
			headline = fmt.Sprintf("mount.nfs failed (exit %d).", exitCode)
			hint = "See the raw pod log below for mount.nfs's own message. Most common causes on a homelab NFS server: the cluster's node IP isn't in the export's allow-list, or the path you typed isn't a separate export."
		}
	case "stat-parent":
		headline = "Mounted the export but couldn't stat its root."
		hint = "Unusual — most likely the NFS server is in a degraded state. Restart nfs-server and retry."
	case "mkdir-leaf":
		// This is the "user made the parent as root on the NFS server with
		// root_squash on" case — the explicit ask in the feature request.
		headline = fmt.Sprintf("Mounted, but couldn't mkdir %q inside the export.", path.Base(p))
		hint = "The export root is probably owned by `root` on the NFS server while `root_squash` is enabled — so the kubelet's effective uid (nfsnobody) can't write here. Fix one of:\n" +
			"  • On the NFS server: `sudo chown nobody:nogroup " + path.Dir(p) + "` (or the uid the kubelet effectively uses), OR\n" +
			"  • On the NFS server: change the export to `no_root_squash` in /etc/exports + `sudo exportfs -ra`, OR\n" +
			"  • Pre-create the leaf directory on the NFS server yourself, world-writable: `sudo mkdir -p " + p + " && sudo chmod 0777 " + p + "`."
	case "chmod-leaf":
		headline = "Created the directory but chmod 0777 failed."
		hint = "The export is on a filesystem that doesn't honor unix modes, or root_squash is silently squashing the chmod. Pre-create the directory on the NFS server with the perms you want."
	case "touch-marker":
		headline = "Directory exists but couldn't write into it."
		hint = "Either the export is read-only / out of space, or the directory is owned by root on the NFS server while root_squash maps this client to nobody. Fix one of:\n" +
			"  • On the NFS server: `sudo chmod -R 0777 " + p + "`, OR\n" +
			"  • Change the export to `no_root_squash` in /etc/exports + `sudo exportfs -ra`, OR\n" +
			"  • Confirm the export line has `rw` and the filesystem isn't full (`df -h`)."
	default:
		// No FAIL: marker found — couldn't classify.
		return ""
	}

	var sb strings.Builder
	sb.WriteString(headline)
	if hint != "" {
		sb.WriteString("\n\n")
		sb.WriteString(hint)
	}
	sb.WriteString("\n\n— helper pod log —\n")
	sb.WriteString(strings.TrimSpace(logs))
	_ = waitErr
	return sb.String()
}

// parseEnsureMarkers scans the helper pod log for the last STEP: marker and
// any FAIL: marker. Returns ("", 0) if neither is present.
func parseEnsureMarkers(logs string) (failStage string, exitCode int) {
	lastStep := ""
	for _, line := range strings.Split(logs, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "STEP:"):
			rest := strings.TrimPrefix(line, "STEP:")
			lastStep = strings.SplitN(rest, " ", 2)[0]
		case strings.HasPrefix(line, "FAIL:"):
			rest := strings.TrimPrefix(line, "FAIL:")
			fields := strings.Fields(rest)
			if len(fields) > 0 {
				failStage = fields[0]
			}
			for _, f := range fields[1:] {
				if strings.HasPrefix(f, "RC=") {
					if n, err := strconv.Atoi(strings.TrimPrefix(f, "RC=")); err == nil {
						exitCode = n
					}
				}
			}
		}
	}
	if failStage == "" {
		// Pod exited without an explicit FAIL: line — attribute to the
		// last STEP we saw so the UI still gets context.
		failStage = lastStep
	}
	return
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
	//
	// The ownership marker is spared by the parallel rm and removed LAST,
	// only after the leaf is verified empty. It gates every retry, so it
	// must survive an interrupted or partial run — otherwise one killed
	// wipe leaves data behind that no later wipe will touch (exit 3).
	// A leaf that's already gone is success, not a refusal (idempotence:
	// the retry after a completed wipe must not report failure).
	marker := "/p/" + leaf + "/" + ownedMarker
	script := fmt.Sprintf(
		"set +e; apk add --no-cache nfs-utils findutils >/dev/null 2>&1; mkdir -p /p; "+
			"mount -t nfs -o retry=0,timeo=30,nolock %s:%s /p || exit $?; "+
			"if [ ! -d /p/%s ]; then echo 'nothing to wipe: %s already absent'; umount /p; exit 0; fi; "+
			// Defense in depth: refuse to delete anything that isn't a
			// GameCTL-provisioned dir, enforced AT the point of destruction
			// (not just in Go) so a bypassed/buggy caller still can't wipe
			// an arbitrary export.
			"if [ ! -f %s ]; then echo 'refusing wipe: %s missing GameCTL ownership marker (%s)'; umount /p; exit 3; fi; "+
			"find /p/%s -type f ! -path %s -print0 2>/dev/null | xargs -0 -n200 -P8 rm -f 2>/dev/null; "+
			"find /p/%s -mindepth 1 -depth -type d -empty -delete 2>/dev/null; "+
			"left=$(find /p/%s -mindepth 1 ! -path %s 2>/dev/null | head -1); "+
			"if [ -n \"$left\" ]; then echo \"wipe incomplete: could not delete $left\"; umount /p; exit 4; fi; "+
			"rm -f %s; rmdir /p/%s; umount /p",
		server, parent,
		leaf, leaf,
		marker, leaf, ownedMarker,
		leaf, marker,
		leaf,
		leaf, marker,
		marker, leaf,
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
	err := waitPodTerminal(ctx, cs, helperNS, podName, 10*time.Minute)
	if err != nil {
		// The script's refusal reasons are echo'd to the pod log, and the
		// deferred delete is about to destroy it — grab the tail now so the
		// task shows WHY instead of a bare exit code. Fresh context: ctx may
		// already be the reason we're here (cancel/timeout).
		lctx, lcancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer lcancel()
		var lines int64 = 5
		if body, lerr := cs.CoreV1().Pods(helperNS).GetLogs(podName, &corev1.PodLogOptions{
			TailLines: &lines,
		}).DoRaw(lctx); lerr == nil {
			if tail := strings.TrimSpace(string(body)); tail != "" {
				err = fmt.Errorf("%w — pod log: %s", err, tail)
			}
		}
	}
	return err
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
			msg := strings.TrimSpace(t.Message)
			if msg == "" {
				msg = strings.TrimSpace(t.Reason)
			}
			if msg == "" {
				// Kubelet didn't capture a message — describe the exit
				// code with the common mount.nfs-ish meaning so the
				// raw error reaching the UI is at least suggestive.
				msg = humanExitCode(int(t.ExitCode))
			}
			return fmt.Sprintf("exit %d: %s", t.ExitCode, msg)
		}
	}
	return "no terminated container status"
}

// humanExitCode maps common shell / mount.nfs / mount(8) exit codes to a
// one-line meaning. Used only when the kubelet didn't capture a Message of
// its own — keeps "exit 32:" from appearing in the UI without ANY context.
//
// References:
//   - mount(8) returns 1 for syntactic errors, 2 for system errors, 8 for
//     I/O error, 16 for runtime issues, 32 for mount failure (the catch-all).
//   - mount.nfs propagates the same set; 32 is what root_squash, missing
//     export, and "node not in allow-list" all look like from outside.
func humanExitCode(code int) string {
	switch code {
	case 0:
		return "ok"
	case 1:
		return "shell exit 1 (script error before any specific step)"
	case 2:
		return "system error (out of memory, missing /bin/sh, …)"
	case 3:
		return "wipe refused — the target directory has no GameCTL ownership marker, " +
			"so GameCTL won't delete it (only dirs it provisioned itself are wipeable)"
	case 4:
		return "wipe incomplete — some files could not be deleted " +
			"(often a root-squashed export leaving root-owned files); the ownership " +
			"marker was kept so the wipe can be retried"
	case 8:
		return "I/O error (often a flaky NFS network or remote nfsd hang)"
	case 13:
		return "permission denied"
	case 16:
		return "mount.nfs runtime error (rpcbind down, stale handle, …)"
	case 32:
		return "mount.nfs failed — usually one of: NFS server unreachable, " +
			"node IP not in /etc/exports allow-list, exported path doesn't exist, " +
			"or the export is squashed and the kubelet uid can't access it. " +
			"Run `Test reachability + read/write` on this Storage Location for a stage-by-stage diagnosis."
	case 124, 137:
		return "killed (timeout or OOM)"
	default:
		return fmt.Sprintf("non-zero exit (see helper pod log for details)")
	}
}
