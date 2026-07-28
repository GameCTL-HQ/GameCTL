package kube

import (
	"context"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// StorageLocation is one operator-declared place to store game data. It is
// either an NFS export or a local host path. Game data lands at
// <ExportPath>/GameCTL[-Suffix]/<serverName> via an inline nfs: or hostPath
// pod volume — no PV/PVC/StorageClass involved (the README, Option D).
type StorageLocation struct {
	Name       string `json:"name"`             // unique, used in the wizard + labels
	Type       string `json:"type,omitempty"`   // "nfs" (default) | "local"
	Server     string `json:"server,omitempty"` // NFS server host/IP (nfs only)
	ExportPath string `json:"exportPath"`       // export (nfs) or host path (local)
	// FolderSuffix optionally distinguishes the top-level folder:
	// "" → GameCTL, "media" → GameCTL-media. Server data goes in a
	// per-server subdir beneath it.
	FolderSuffix string `json:"folderSuffix,omitempty"`
}

// IsLocal reports whether this is a host-path location (vs. NFS).
func (l StorageLocation) IsLocal() bool { return l.Type == "local" }

const (
	storageNS     = "gamectl"
	storageCMName = "gamectl-storage"
	storageCMKey  = "locations.json"
)

// FolderName is the top-level GameCTL directory: "GameCTL" or
// "GameCTL-<suffix>". All per-server subdirs live beneath it so the share
// root is never the wipe target.
func (l StorageLocation) FolderName() string {
	if s := strings.TrimSpace(l.FolderSuffix); s != "" {
		return "GameCTL-" + s
	}
	return "GameCTL"
}

// GameCTLDir is the per-location top-level directory all game subdirs live
// under (works for both NFS export paths and local host paths).
func (l StorageLocation) GameCTLDir() string {
	return path.Join("/"+strings.Trim(l.ExportPath, "/"), l.FolderName())
}

// Normalized returns the location with the cosmetic slop cleaned up:
// surrounding whitespace gone, runs of slashes collapsed, no trailing
// slash. A path typed as "/mnt/1TBSSD/" or pasted as "/mnt//1TBSSD" is the
// same location as "/mnt/1TBSSD" and should save, not be rejected — and
// callers that compose <export>/GameCTL/<server> must not end up with a
// "//" in the middle of a mount path.
//
// Deliberately does NOT run path.Clean: that resolves "..", which would
// turn "/mnt/../etc" into an accepted "/etc" the operator never typed.
// Validate still rejects those.
func (l StorageLocation) Normalized() StorageLocation {
	l.Name = strings.TrimSpace(l.Name)
	l.Type = strings.TrimSpace(l.Type)
	l.Server = strings.TrimSpace(l.Server)
	l.FolderSuffix = strings.TrimSpace(l.FolderSuffix)
	l.ExportPath = normalizeExportPath(l.ExportPath)
	return l
}

// normalizeExportPath collapses slash runs and drops the trailing slash,
// preserving bare "/" (which Validate accepts as absolute).
func normalizeExportPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return ""
	}
	for strings.Contains(p, "//") {
		p = strings.ReplaceAll(p, "//", "/")
	}
	if p == "/" {
		return p
	}
	return strings.TrimRight(p, "/")
}

// Validate checks a single location is well-formed.
func (l StorageLocation) Validate() error {
	if strings.TrimSpace(l.Name) == "" {
		return fmt.Errorf("location name is required")
	}
	if strings.ContainsAny(l.Name, "/ \t") {
		return fmt.Errorf("location name %q must not contain spaces or slashes", l.Name)
	}
	if l.Type != "" && l.Type != "nfs" && l.Type != "local" {
		return fmt.Errorf("location %q: type must be \"nfs\" or \"local\"", l.Name)
	}
	if !l.IsLocal() && strings.TrimSpace(l.Server) == "" {
		return fmt.Errorf("location %q: NFS server is required", l.Name)
	}
	if !strings.HasPrefix(l.ExportPath, "/") {
		return fmt.Errorf("location %q: path must be absolute", l.Name)
	}
	if l.ExportPath != path.Clean(l.ExportPath) {
		return fmt.Errorf("location %q: path %q is not normalized", l.Name, l.ExportPath)
	}
	if s := strings.TrimSpace(l.FolderSuffix); s != "" && strings.ContainsAny(s, "/ \t\\") {
		return fmt.Errorf("location %q: folder suffix %q must not contain spaces or slashes", l.Name, s)
	}
	return nil
}

// StorageLocations returns the declared NFS locations. Missing ConfigMap is
// not an error — it just means none are configured yet.
func (c *Cluster) StorageLocations(ctx context.Context) ([]StorageLocation, error) {
	b := c.snap()
	if b == nil {
		return nil, ErrNotConfigured
	}
	cm, err := b.clientset.CoreV1().ConfigMaps(storageNS).Get(ctx, storageCMName, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return []StorageLocation{}, nil
		}
		return nil, err
	}
	raw := cm.Data[storageCMKey]
	if strings.TrimSpace(raw) == "" {
		return []StorageLocation{}, nil
	}
	var locs []StorageLocation
	if err := json.Unmarshal([]byte(raw), &locs); err != nil {
		return nil, fmt.Errorf("parse %s/%s: %w", storageCMName, storageCMKey, err)
	}
	return locs, nil
}

// SetStorageLocations validates and persists the full location list to the
// gamectl-storage ConfigMap (create-or-update). Names must be unique.
func (c *Cluster) SetStorageLocations(ctx context.Context, locs []StorageLocation) error {
	b := c.snap()
	if b == nil {
		return ErrNotConfigured
	}
	seen := map[string]bool{}
	for i := range locs {
		// Normalize before validating so the stored ConfigMap is always the
		// canonical form — every consumer (wizard preview, inline volume,
		// probe pod, backup path) composes from it.
		locs[i] = locs[i].Normalized()
		if err := locs[i].Validate(); err != nil {
			return err
		}
		if seen[locs[i].Name] {
			return fmt.Errorf("duplicate location name %q", locs[i].Name)
		}
		seen[locs[i].Name] = true
	}
	sort.Slice(locs, func(i, j int) bool { return locs[i].Name < locs[j].Name })

	data, err := json.Marshal(locs)
	if err != nil {
		return err
	}
	cms := b.clientset.CoreV1().ConfigMaps(storageNS)
	existing, err := cms.Get(ctx, storageCMName, metav1.GetOptions{})
	switch {
	case apierrors.IsNotFound(err):
		_, err = cms.Create(ctx, &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: storageCMName, Namespace: storageNS},
			Data:       map[string]string{storageCMKey: string(data)},
		}, metav1.CreateOptions{})
		if err != nil {
			return fmt.Errorf("create %s: %w", storageCMName, err)
		}
		return nil
	case err != nil:
		return fmt.Errorf("get %s: %w", storageCMName, err)
	}
	if existing.Data == nil {
		existing.Data = map[string]string{}
	}
	existing.Data[storageCMKey] = string(data)
	if _, err := cms.Update(ctx, existing, metav1.UpdateOptions{}); err != nil {
		return fmt.Errorf("update %s: %w", storageCMName, err)
	}
	return nil
}

// ParseStorageSeed parses a GAMECTL_STORAGE_LOCATIONS value:
//
//	name=1TBSSD,server=10.0.0.100,path=/mnt/1TBSSD[,type=nfs][,suffix=]
//
// multiple entries separated by ';'. Unknown/invalid entries error.
func ParseStorageSeed(raw string) ([]StorageLocation, error) {
	// "" or the manifest placeholder (when install.sh wasn't given a value)
	// mean "no seed".
	if strings.TrimSpace(raw) == "" || strings.TrimSpace(raw) == "__STORAGE_SEED__" {
		return nil, nil
	}
	var out []StorageLocation
	for _, entry := range strings.Split(raw, ";") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		var l StorageLocation
		for _, kv := range strings.Split(entry, ",") {
			k, v, ok := strings.Cut(strings.TrimSpace(kv), "=")
			if !ok {
				return nil, fmt.Errorf("storage seed %q: expected key=value, got %q", entry, kv)
			}
			switch strings.TrimSpace(k) {
			case "name":
				l.Name = strings.TrimSpace(v)
			case "server":
				l.Server = strings.TrimSpace(v)
			case "path", "exportPath":
				l.ExportPath = strings.TrimSpace(v)
			case "type":
				l.Type = strings.TrimSpace(v)
			case "suffix", "folderSuffix":
				l.FolderSuffix = strings.TrimSpace(v)
			default:
				return nil, fmt.Errorf("storage seed %q: unknown field %q", entry, k)
			}
		}
		if err := l.Validate(); err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, nil
}

// SeedStorageLocations merges the parsed seed into the gamectl-storage
// ConfigMap, adding only locations whose Name is not already present —
// operator/GUI edits are never overwritten. No-op if nothing new. Returns
// the names actually added.
func (c *Cluster) SeedStorageLocations(ctx context.Context, raw string) ([]string, error) {
	want, err := ParseStorageSeed(raw)
	if err != nil {
		return nil, err
	}
	if len(want) == 0 {
		return nil, nil
	}
	existing, err := c.StorageLocations(ctx)
	if err != nil {
		return nil, err
	}
	have := map[string]bool{}
	for _, l := range existing {
		have[l.Name] = true
	}
	var added []string
	for _, l := range want {
		if have[l.Name] {
			continue
		}
		existing = append(existing, l)
		have[l.Name] = true
		added = append(added, l.Name)
	}
	if len(added) == 0 {
		return nil, nil
	}
	if err := c.SetStorageLocations(ctx, existing); err != nil {
		return nil, err
	}
	return added, nil
}
