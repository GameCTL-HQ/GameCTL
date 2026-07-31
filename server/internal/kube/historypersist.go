package kube

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// Optional on-disk snapshots of the samplers' in-memory history, so
// monitoring graphs survive a pod restart/redeploy instead of starting
// over. Env-gated: GAMECTL_HISTORY_DIR names a writable directory (the
// manifest mounts one; emptyDir by default — safe everywhere, survives
// container crashes — with `make deploy` substituting a real share for
// installs that want restart-proof history). Unset/unwritable → samplers
// behave exactly as before, purely in-memory.
//
// Snapshots are best-effort and low-churn (every ~5 min of ticks plus on
// shutdown); a missed final snapshot costs at most a few minutes of
// samples. Stale content self-heals on load: deleted instances get
// dropped by the samplers' existing cleanup, and old samples age out via
// retention/compaction on the first tick.
const historySnapshotEveryTicks = 10

func historyDir() string { return os.Getenv("GAMECTL_HISTORY_DIR") }

func historyPath(file string) (string, bool) {
	dir := historyDir()
	if dir == "" {
		return "", false
	}
	return filepath.Join(dir, file), true
}

// saveJSONSnapshot writes v as JSON atomically (tmp + rename).
func saveJSONSnapshot(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func loadJSONSnapshot(path string, v any) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}
