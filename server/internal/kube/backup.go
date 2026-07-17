package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
)

// Per-game save backups. A backup is a timestamped .tar.gz of the game's save
// paths (see backup_specs.go), written to an operator-chosen Storage Location
// and rotated to keep only the newest N. Backups run as short Jobs/CronJobs
// that mount the game's data NFS export read-only and the destination export
// read-write — the same inline-NFS pattern game pods use (no PVC, no privilege).
const (
	backupConfigAnno = "gamectl.io/backup-config"
	backupComponent  = "backup"
	backupImage      = "busybox:1.36"
	// backupsFolder is the top-level folder for backups on whichever export
	// the operator chooses (a sibling of the GameCTL[-suffix] data folder, so
	// archives never land inside a live game's data dir). Per-server subdir
	// beneath it, e.g. <export>/GameCTL-Backups/<server>/<server>-<ts>.tar.gz.
	backupsFolder = "GameCTL-Backups"
)

// archiveNameRe guards restore: an archive must be a bare <server>-<stamp>.tar.gz
// filename (no path separators, no traversal).
var archiveNameRe = regexp.MustCompile(`^[a-zA-Z0-9._-]+\.tar\.gz$`)

// BackupConfig is the per-instance backup policy, persisted as JSON in the
// Deployment annotation gamectl.io/backup-config (mirrors the auto-update
// annotation pattern — setting it never rolls the pod).
type BackupConfig struct {
	Enabled     bool   `json:"enabled"`
	Schedule    string `json:"schedule"`    // cron (5 fields), e.g. "0 4 * * *"
	Retention   int    `json:"retention"`   // keep newest N archives
	Destination string `json:"destination"` // Storage Location name
	Scope       string `json:"scope"`       // "saves" (default) | "whole"
}

// BackupSettings is the wire shape returned to the manage UI.
type BackupSettings struct {
	Supported      bool         `json:"supported"`
	Note           string       `json:"note,omitempty"`
	EffectivePaths []string     `json:"effectivePaths"` // what "saves" scope archives
	Config         BackupConfig `json:"config"`
	Active         bool         `json:"active"` // a CronJob exists
}

// BackupArchive is one stored archive surfaced in the UI.
type BackupArchive struct {
	Name    string `json:"name"`
	Size    int64  `json:"size"`
	ModTime int64  `json:"modTime"` // unix seconds
}

func backupLabels(server string) map[string]string {
	return map[string]string{
		"app.kubernetes.io/managed-by": "gamectl",
		"app.kubernetes.io/component":  backupComponent,
		"gamectl.io/instance":          server,
		"game":                         "", // filled by caller if known
	}
}

func ptrInt32(v int32) *int32 { return &v }

// gameLabel reads the game key off a Deployment (label, then pod-template label).
func gameLabel(dep *appsv1.Deployment) string {
	if g := dep.Labels["game"]; g != "" {
		return g
	}
	return dep.Spec.Template.Labels["game"]
}

// dataSourceFor finds the inline-NFS volume holding the game's data: the one
// mounted at the spec's DataMount, else the sole NFS-backed mount. Returns the
// NFS server + path of the data dir root.
func dataSourceFor(dep *appsv1.Deployment, spec BackupSpec) (server, p string, err error) {
	pod := dep.Spec.Template.Spec
	if len(pod.Containers) == 0 {
		return "", "", fmt.Errorf("deployment %s has no containers", dep.Name)
	}
	// volume name -> nfs source
	nfsByVol := map[string]*corev1.NFSVolumeSource{}
	for i := range pod.Volumes {
		if pod.Volumes[i].NFS != nil {
			nfsByVol[pod.Volumes[i].Name] = pod.Volumes[i].NFS
		}
	}
	if len(nfsByVol) == 0 {
		return "", "", fmt.Errorf("%s: no inline NFS data volume found (local-storage games are not yet supported for backup)", dep.Name)
	}
	// Preferred: the volume mounted at the game's data mount path.
	if spec.DataMount != "" {
		for _, m := range pod.Containers[0].VolumeMounts {
			if m.MountPath == spec.DataMount {
				if nfs, ok := nfsByVol[m.Name]; ok {
					return nfs.Server, nfs.Path, nil
				}
			}
		}
	}
	// Fallback: exactly one NFS volume → it's the data dir.
	if len(nfsByVol) == 1 {
		for _, nfs := range nfsByVol {
			return nfs.Server, nfs.Path, nil
		}
	}
	return "", "", fmt.Errorf("%s: could not identify the data volume (multiple NFS mounts, none at %q)", dep.Name, spec.DataMount)
}

// effectiveSavePaths resolves the save paths for a scope. "whole" → the whole
// volume. For minecraft the world dir name is read from the LEVEL env.
func effectiveSavePaths(dep *appsv1.Deployment, game, scope string) []string {
	if scope == "whole" {
		return []string{"."}
	}
	spec := backupSpecFor(game)
	if game == "minecraft" {
		if lvl := containerEnv(dep, "LEVEL"); lvl != "" {
			return []string{lvl, lvl + "_nether", lvl + "_the_end"}
		}
	}
	return spec.SavePaths
}

func containerEnv(dep *appsv1.Deployment, name string) string {
	if len(dep.Spec.Template.Spec.Containers) == 0 {
		return ""
	}
	for _, e := range dep.Spec.Template.Spec.Containers[0].Env {
		if e.Name == name {
			return e.Value
		}
	}
	return ""
}

// backupDest resolves a BackupConfig's destination Storage Location to an NFS
// server + export path + the per-server relative dir beneath it.
func (c *Cluster) backupDest(ctx context.Context, cfg BackupConfig, server string) (nfsServer, export, relDir string, err error) {
	if strings.TrimSpace(cfg.Destination) == "" {
		return "", "", "", fmt.Errorf("no backup destination set")
	}
	locs, err := c.StorageLocations(ctx)
	if err != nil {
		return "", "", "", err
	}
	for _, l := range locs {
		if l.Name != cfg.Destination {
			continue
		}
		if l.IsLocal() {
			return "", "", "", fmt.Errorf("backup destination %q is a local path; only NFS storage locations are supported for backups", l.Name)
		}
		rel := path.Join(backupsFolder, server)
		return l.Server, "/" + strings.Trim(l.ExportPath, "/"), rel, nil
	}
	return "", "", "", fmt.Errorf("backup destination %q is not a known storage location", cfg.Destination)
}

// BackupSettingsFor reads the per-instance backup config + spec for the UI.
func (c *Cluster) BackupSettingsFor(ctx context.Context, ns, name string) (BackupSettings, error) {
	b := c.snap()
	if b == nil {
		return BackupSettings{}, ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return BackupSettings{}, err
	}
	game := gameLabel(dep)
	spec := backupSpecFor(game)

	out := BackupSettings{
		Supported:      spec.Supported,
		Note:           spec.Note,
		EffectivePaths: effectiveSavePaths(dep, game, "saves"),
		Config:         BackupConfig{Scope: "saves", Retention: 7},
	}
	if raw := dep.Annotations[backupConfigAnno]; raw != "" {
		var cfg BackupConfig
		if err := json.Unmarshal([]byte(raw), &cfg); err == nil {
			if cfg.Scope == "" {
				cfg.Scope = "saves"
			}
			if cfg.Retention <= 0 {
				cfg.Retention = 7
			}
			out.Config = cfg
		}
	}
	if _, err := b.clientset.BatchV1().CronJobs(nsGamectl).Get(ctx, name+"-backup", metav1.GetOptions{}); err == nil {
		out.Active = true
	}
	return out, nil
}

// SetBackupConfig validates + persists the backup policy annotation and
// reconciles the CronJob (create/update when enabled, delete when disabled).
func (c *Cluster) SetBackupConfig(ctx context.Context, ns, name string, cfg BackupConfig) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	game := gameLabel(dep)
	if !backupSpecFor(game).Supported {
		return fmt.Errorf("this game has no save data to back up")
	}
	if cfg.Scope == "" {
		cfg.Scope = "saves"
	}
	if cfg.Enabled {
		if err := validateCron(cfg.Schedule); err != nil {
			return err
		}
		if cfg.Retention < 1 {
			return fmt.Errorf("retention must be at least 1")
		}
		ds, ex, rel, err := c.backupDest(ctx, cfg, name)
		if err != nil {
			return err
		}
		// Pre-create the GameCTL-Backups/<server> folder on the share now, the
		// same way game data dirs are ensured at apply time — so it exists as
		// soon as backups are enabled. Best-effort: the backup Job also mkdir's
		// it, so a transient NFS hiccup here doesn't block saving the config.
		_ = c.ensureNFSPath(ctx, ds, ex+"/"+rel)
	}

	raw, err := json.Marshal(cfg)
	if err != nil {
		return err
	}
	patch := map[string]any{"metadata": map[string]any{"annotations": map[string]any{backupConfigAnno: string(raw)}}}
	body, _ := json.Marshal(patch)
	if _, err := b.clientset.AppsV1().Deployments(ns).Patch(ctx, name, types.StrategicMergePatchType, body, metav1.PatchOptions{}); err != nil {
		return err
	}
	return c.reconcileBackupCronJob(ctx, dep, cfg)
}

// reconcileBackupCronJob renders+applies the backup CronJob when enabled, or
// deletes it when disabled.
func (c *Cluster) reconcileBackupCronJob(ctx context.Context, dep *appsv1.Deployment, cfg BackupConfig) error {
	b := c.snap()
	cjs := b.clientset.BatchV1().CronJobs(nsGamectl)
	name := dep.Name

	if !cfg.Enabled {
		err := cjs.Delete(ctx, name+"-backup", metav1.DeleteOptions{})
		if err != nil && !apierrors.IsNotFound(err) {
			return err
		}
		return nil
	}

	game := gameLabel(dep)
	spec := backupSpecFor(game)
	srcServer, srcPath, err := dataSourceFor(dep, spec)
	if err != nil {
		return err
	}
	dstServer, dstExport, relDir, err := c.backupDest(ctx, cfg, name)
	if err != nil {
		return err
	}
	pod := c.backupPodTemplate(name, game, srcServer, srcPath, dstServer, dstExport, relDir,
		effectiveSavePaths(dep, game, cfg.Scope), cfg.Retention, false, "")

	cj := &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:            name + "-backup",
			Namespace:       nsGamectl,
			Labels:          backupLabelsWithGame(name, game),
			OwnerReferences: []metav1.OwnerReference{depOwnerRef(dep)},
		},
		Spec: batchv1.CronJobSpec{
			Schedule:                   cfg.Schedule,
			ConcurrencyPolicy:          batchv1.ForbidConcurrent,
			SuccessfulJobsHistoryLimit: ptrInt32(1),
			FailedJobsHistoryLimit:     ptrInt32(2),
			JobTemplate: batchv1.JobTemplateSpec{
				Spec: batchv1.JobSpec{
					BackoffLimit:            ptrInt32(1),
					TTLSecondsAfterFinished: ptrInt32(3600),
					Template:                pod,
				},
			},
		},
	}

	existing, err := cjs.Get(ctx, cj.Name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		_, err = cjs.Create(ctx, cj, metav1.CreateOptions{})
		return err
	}
	if err != nil {
		return err
	}
	existing.Labels = cj.Labels
	existing.OwnerReferences = cj.OwnerReferences
	existing.Spec = cj.Spec
	_, err = cjs.Update(ctx, existing, metav1.UpdateOptions{})
	return err
}

func backupLabelsWithGame(server, game string) map[string]string {
	l := backupLabels(server)
	l["game"] = game
	return l
}

func depOwnerRef(dep *appsv1.Deployment) metav1.OwnerReference {
	no := false
	return metav1.OwnerReference{
		APIVersion:         "apps/v1",
		Kind:               "Deployment",
		Name:               dep.Name,
		UID:                dep.UID,
		Controller:         &no,
		BlockOwnerDeletion: &no,
	}
}

// backupPodTemplate builds the pod that does the tar (backup) or untar
// (restore). Backup mounts src read-only + dst read-write; restore is the
// reverse. busybox provides sh/tar/gzip/date/stat.
func (c *Cluster) backupPodTemplate(server, game, srcServer, srcPath, dstServer, dstExport, relDir string,
	savePaths []string, retention int, restore bool, archive string) corev1.PodTemplateSpec {

	srcRO, dstRO := true, false
	if restore {
		srcRO, dstRO = false, true
	}
	var script string
	if restore {
		script = restoreScript
	} else {
		script = backupScript
	}
	return corev1.PodTemplateSpec{
		ObjectMeta: metav1.ObjectMeta{Labels: backupLabelsWithGame(server, game)},
		Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever,
			Containers: []corev1.Container{{
				Name:    backupComponent,
				Image:   backupImage,
				Command: []string{"sh", "-c", script},
				Env: []corev1.EnvVar{
					{Name: "NAME", Value: server},
					{Name: "RELDIR", Value: relDir},
					{Name: "SAVEPATHS", Value: strings.Join(savePaths, " ")},
					{Name: "RETAIN", Value: fmt.Sprintf("%d", retention)},
					{Name: "ARCHIVE", Value: archive},
				},
				VolumeMounts: []corev1.VolumeMount{
					{Name: "src", MountPath: "/src", ReadOnly: srcRO},
					{Name: "dst", MountPath: "/dst", ReadOnly: dstRO},
				},
			}},
			Volumes: []corev1.Volume{
				{Name: "src", VolumeSource: corev1.VolumeSource{NFS: &corev1.NFSVolumeSource{Server: srcServer, Path: srcPath, ReadOnly: srcRO}}},
				{Name: "dst", VolumeSource: corev1.VolumeSource{NFS: &corev1.NFSVolumeSource{Server: dstServer, Path: dstExport, ReadOnly: dstRO}}},
			},
		},
	}
}

const backupScript = `set -e
DST="/dst/$RELDIR"; mkdir -p "$DST"
ts=$(date -u +%Y%m%d-%H%M%S)
arc="$DST/${NAME}-${ts}.tar.gz"
set --
for p in $SAVEPATHS; do [ -e "/src/$p" ] && set -- "$@" "$p"; done
if [ $# -eq 0 ]; then echo "backup: no save paths present under /src (looked for: $SAVEPATHS) — try whole-volume scope" >&2; exit 2; fi
echo "backup: archiving $* -> $arc"
tar czf "$arc.partial" -C /src "$@"
mv "$arc.partial" "$arc"
echo "backup: wrote $arc ($(stat -c %s "$arc" 2>/dev/null) bytes)"
n=0
for f in $(ls -1t "$DST/${NAME}"-*.tar.gz 2>/dev/null); do
  n=$((n+1)); [ "$n" -gt "$RETAIN" ] && { rm -f "$f"; echo "backup: pruned $f"; }
done
echo "backup: done"
`

const restoreScript = `set -e
arc="/dst/$RELDIR/$ARCHIVE"
[ -f "$arc" ] || { echo "restore: archive not found: $arc" >&2; exit 2; }
echo "restore: extracting $arc -> /src"
tar xzf "$arc" -C /src
echo "restore: done"
`

// backupListScript prints one TSV row (name<TAB>size<TAB>mtime) per archive in
// the per-server backup dir mounted at /dst. Missing dir → no output (the UI
// treats an empty list as "no backups yet"). Reads only; no set -e so a
// non-matching glob is a clean empty result, not an error.
const backupListScript = `D="/dst/$RELDIR"
[ -d "$D" ] || exit 0
for f in "$D/$NAME"-*.tar.gz; do
  [ -e "$f" ] || continue
  printf '%s\t%s\t%s\n' "$(basename "$f")" "$(stat -c %s "$f")" "$(stat -c %Y "$f")"
done
`

// validateCron does a light structural check (5 space-separated fields). The
// kubelet's CronJob controller does the real parse; this just catches typos.
func validateCron(s string) error {
	if strings.TrimSpace(s) == "" {
		return fmt.Errorf("a backup schedule is required")
	}
	if n := len(strings.Fields(s)); n != 5 {
		return fmt.Errorf("schedule %q must have 5 cron fields (min hour dom mon dow), got %d", s, n)
	}
	return nil
}

// BackupNow runs an immediate one-off backup Job and tracks it as a task.
func (c *Cluster) BackupNow(ctx context.Context, ns, name string, rep PhaseReporter) error {
	if rep == nil {
		rep = nopReporter{}
	}
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	p := rep.BeginPhase("Prepare backup", "")
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		rep.EndPhase(p, err)
		return err
	}
	game := gameLabel(dep)
	spec := backupSpecFor(game)
	if !spec.Supported {
		err = fmt.Errorf("this game has no save data to back up")
		rep.EndPhase(p, err)
		return err
	}
	cfg, _ := c.readBackupConfig(dep)
	srcServer, srcPath, err := dataSourceFor(dep, spec)
	if err != nil {
		rep.EndPhase(p, err)
		return err
	}
	dstServer, dstExport, relDir, err := c.backupDest(ctx, cfg, name)
	if err != nil {
		rep.EndPhase(p, err)
		return err
	}
	retain := cfg.Retention
	if retain < 1 {
		retain = 7
	}
	pod := c.backupPodTemplate(name, game, srcServer, srcPath, dstServer, dstExport, relDir,
		effectiveSavePaths(dep, game, cfg.Scope), retain, false, "")
	rep.EndPhase(p, nil)

	p = rep.BeginPhase("Run backup", "archiving save files")
	err = c.runBackupJob(ctx, name+"-backup-now", name, game, pod, dep)
	rep.EndPhase(p, err)
	return err
}

// RestoreBackup stops the server, extracts the chosen archive over the data
// volume, and starts it again — tracked as a task.
func (c *Cluster) RestoreBackup(ctx context.Context, ns, name, archive string, rep PhaseReporter) error {
	if rep == nil {
		rep = nopReporter{}
	}
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	if !archiveNameRe.MatchString(archive) || strings.Contains(archive, "/") {
		return fmt.Errorf("invalid archive name %q", archive)
	}
	if !strings.HasPrefix(archive, name+"-") {
		return fmt.Errorf("archive %q does not belong to %q", archive, name)
	}

	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return err
	}
	game := gameLabel(dep)
	spec := backupSpecFor(game)
	cfg, _ := c.readBackupConfig(dep)
	srcServer, srcPath, err := dataSourceFor(dep, spec)
	if err != nil {
		return err
	}
	dstServer, dstExport, relDir, err := c.backupDest(ctx, cfg, name)
	if err != nil {
		return err
	}
	prior := int32(1)
	if dep.Spec.Replicas != nil && *dep.Spec.Replicas > 0 {
		prior = *dep.Spec.Replicas
	}

	p := rep.BeginPhase("Stop server", "scaling to 0 before restore")
	if err := c.Scale(ctx, ns, name, 0); err != nil {
		rep.EndPhase(p, err)
		return err
	}
	if err := c.waitDeploymentScaledDown(ctx, ns, name, 90*time.Second); err != nil {
		rep.EndPhase(p, err)
		// best-effort: bring it back up before bailing
		_ = c.Scale(ctx, ns, name, prior)
		return err
	}
	rep.EndPhase(p, nil)

	p = rep.BeginPhase("Restore archive", archive)
	pod := c.backupPodTemplate(name, game, srcServer, srcPath, dstServer, dstExport, relDir, nil, 0, true, archive)
	restoreErr := c.runBackupJob(ctx, name+"-restore", name, game, pod, dep)
	rep.EndPhase(p, restoreErr)

	p = rep.BeginPhase("Start server", fmt.Sprintf("scaling back to %d", prior))
	startErr := c.Scale(ctx, ns, name, prior)
	rep.EndPhase(p, startErr)

	if restoreErr != nil {
		return restoreErr
	}
	return startErr
}

// runBackupJob creates a one-off Job from a pod template, waits for it to
// finish, surfaces its log tail on failure, then deletes it.
func (c *Cluster) runBackupJob(ctx context.Context, jobName, server, game string, pod corev1.PodTemplateSpec, dep *appsv1.Deployment) error {
	b := c.snap()
	jobs := b.clientset.BatchV1().Jobs(nsGamectl)
	// unique suffix so repeated runs don't collide
	jobName = fmt.Sprintf("%s-%d", jobName, time.Now().Unix())
	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:            jobName,
			Namespace:       nsGamectl,
			Labels:          backupLabelsWithGame(server, game),
			OwnerReferences: []metav1.OwnerReference{depOwnerRef(dep)},
		},
		Spec: batchv1.JobSpec{
			BackoffLimit:            ptrInt32(0),
			TTLSecondsAfterFinished: ptrInt32(600),
			Template:                pod,
		},
	}
	if _, err := jobs.Create(ctx, job, metav1.CreateOptions{}); err != nil {
		return fmt.Errorf("create backup job: %w", err)
	}
	defer func() {
		pol := metav1.DeletePropagationBackground
		_ = jobs.Delete(context.Background(), jobName, metav1.DeleteOptions{PropagationPolicy: &pol})
	}()
	return c.waitJob(ctx, jobName, 15*time.Minute)
}

// waitJob polls a Job until it succeeds or fails (or ctx/timeout). On failure
// it appends the failed pod's log tail to the error for the task view.
func (c *Cluster) waitJob(ctx context.Context, jobName string, timeout time.Duration) error {
	b := c.snap()
	jobs := b.clientset.BatchV1().Jobs(nsGamectl)
	deadline := time.Now().Add(timeout)
	for {
		j, err := jobs.Get(ctx, jobName, metav1.GetOptions{})
		if err != nil {
			return err
		}
		if j.Status.Succeeded > 0 {
			return nil
		}
		if j.Status.Failed > 0 {
			return fmt.Errorf("backup job failed: %s", c.jobPodLogTail(ctx, jobName))
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("backup job did not finish within %s", timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// jobPodLogTail returns the last chunk of the Job's pod logs (best-effort).
func (c *Cluster) jobPodLogTail(ctx context.Context, jobName string) string {
	b := c.snap()
	pods, err := b.clientset.CoreV1().Pods(nsGamectl).List(ctx, metav1.ListOptions{LabelSelector: "job-name=" + jobName})
	if err != nil || len(pods.Items) == 0 {
		return "(no pod logs)"
	}
	tail := int64(20)
	raw, err := b.clientset.CoreV1().Pods(nsGamectl).
		GetLogs(pods.Items[0].Name, &corev1.PodLogOptions{TailLines: &tail}).DoRaw(ctx)
	if err != nil {
		return "(log read failed)"
	}
	return strings.TrimSpace(string(raw))
}

// waitDeploymentScaledDown waits until the Deployment reports zero replicas.
func (c *Cluster) waitDeploymentScaledDown(ctx context.Context, ns, name string, timeout time.Duration) error {
	b := c.snap()
	deadline := time.Now().Add(timeout)
	for {
		dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			return err
		}
		if dep.Status.Replicas == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("server did not stop within %s", timeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// ListBackups returns the archives stored for an instance, newest first. Reads
// the destination by mounting the export root in a short helper pod and listing
// the per-server backup dir (missing dir → empty list).
func (c *Cluster) ListBackups(ctx context.Context, ns, name string) ([]BackupArchive, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	dep, err := b.clientset.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	cfg, _ := c.readBackupConfig(dep)
	if strings.TrimSpace(cfg.Destination) == "" {
		return []BackupArchive{}, nil
	}
	dstServer, dstExport, relDir, err := c.backupDest(ctx, cfg, name)
	if err != nil {
		return nil, err
	}
	if err := validateNFSEnsureInput(dstServer, dstExport); err != nil {
		return nil, err
	}
	// List through an inline nfs: volume the kubelet mounts — the SAME
	// mechanism the backup Job uses to write. The old helper ran
	// `apk add nfs-utils` + a manual `mount -t nfs` inside the pod, which
	// silently fails on clusters without outbound internet (apk can't reach
	// the Alpine repos), so listing broke even though backups wrote fine.
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("gamectl-backup-ls-%d", time.Now().UnixNano()/1e6),
			Namespace: nsGamectl,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "gamectl",
				"app.kubernetes.io/component":  backupComponent,
			},
		},
		Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever,
			Containers: []corev1.Container{{
				Name:    "ls",
				Image:   backupImage,
				Command: []string{"sh", "-c", backupListScript},
				Env: []corev1.EnvVar{
					{Name: "NAME", Value: name},
					{Name: "RELDIR", Value: relDir},
				},
				VolumeMounts: []corev1.VolumeMount{{Name: "dst", MountPath: "/dst", ReadOnly: true}},
			}},
			Volumes: []corev1.Volume{
				{Name: "dst", VolumeSource: corev1.VolumeSource{NFS: &corev1.NFSVolumeSource{Server: dstServer, Path: dstExport, ReadOnly: true}}},
			},
		},
	}
	out, err := c.runCapturePod(ctx, pod)
	if err != nil {
		return nil, err
	}
	var archives []BackupArchive
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		fields := strings.Split(line, "\t")
		if len(fields) != 3 {
			continue
		}
		var size, mtime int64
		fmt.Sscan(fields[1], &size)
		fmt.Sscan(fields[2], &mtime)
		archives = append(archives, BackupArchive{Name: fields[0], Size: size, ModTime: mtime})
	}
	sort.Slice(archives, func(i, j int) bool { return archives[i].ModTime > archives[j].ModTime })
	return archives, nil
}

// runCapturePod runs a short helper pod to completion and returns its stdout.
// The caller supplies the full pod (image, script, any volumes); this handles
// create → wait-for-terminal → read logs → delete. Used for backup listing,
// which mounts the destination via an inline nfs: volume (no privileged pod /
// in-pod mount needed).
func (c *Cluster) runCapturePod(ctx context.Context, pod *corev1.Pod) (string, error) {
	b := c.snap()
	podName := pod.Name
	cs := b.clientset
	if _, err := cs.CoreV1().Pods(nsGamectl).Create(ctx, pod, metav1.CreateOptions{}); err != nil {
		return "", fmt.Errorf("create helper pod: %w", err)
	}
	defer func() {
		grace := int64(0)
		_ = cs.CoreV1().Pods(nsGamectl).Delete(context.Background(), podName, metav1.DeleteOptions{GracePeriodSeconds: &grace})
	}()
	if err := waitPodTerminal(ctx, cs, nsGamectl, podName, 90*time.Second); err != nil {
		return "", err
	}
	raw, err := cs.CoreV1().Pods(nsGamectl).GetLogs(podName, &corev1.PodLogOptions{}).DoRaw(ctx)
	if err != nil {
		return "", fmt.Errorf("read helper logs: %w", err)
	}
	return string(raw), nil
}

func (c *Cluster) readBackupConfig(dep *appsv1.Deployment) (BackupConfig, bool) {
	cfg := BackupConfig{Scope: "saves", Retention: 7}
	raw := dep.Annotations[backupConfigAnno]
	if raw == "" {
		return cfg, false
	}
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return BackupConfig{Scope: "saves", Retention: 7}, false
	}
	if cfg.Scope == "" {
		cfg.Scope = "saves"
	}
	if cfg.Retention <= 0 {
		cfg.Retention = 7
	}
	return cfg, true
}
