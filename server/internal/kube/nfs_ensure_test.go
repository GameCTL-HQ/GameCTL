package kube

import "testing"

func TestValidateWipeTarget(t *testing.T) {
	// Neutralize env-driven knobs for the table cases.
	t.Setenv("GAMECTL_NFS_WIPE_MIN_DEPTH", "")
	t.Setenv("GAMECTL_NFS_WIPE_REQUIRE_PREFIX", "")

	ok := []string{
		"/mnt/1TBSSD/minecraft",
		"/srv/nfs/games/valheim-world",
		"/a/b/c",
	}
	for _, p := range ok {
		if err := validateWipeTarget(p); err != nil {
			t.Errorf("expected %q to be allowed, got: %v", p, err)
		}
	}

	bad := map[string]string{
		"":                       "empty",
		"relative/path/here":     "not absolute",
		"/mnt":                   "too shallow (share root)",
		"/mnt/1TBSSD":            "too shallow (share root)",
		"/":                      "root",
		"/a/../b/c":              "traversal (also not clean)",
		"/a/b/../../etc":         "traversal",
		"/a//b/c":                "empty segment / not clean",
		"/a/b/c/":                "trailing slash / not clean",
		"/foo/bar/..":            "traversal",
	}
	for p, why := range bad {
		if err := validateWipeTarget(p); err == nil {
			t.Errorf("expected %q to be REJECTED (%s), but it passed", p, why)
		}
	}
}

func TestValidateWipeTarget_RequirePrefix(t *testing.T) {
	t.Setenv("GAMECTL_NFS_WIPE_MIN_DEPTH", "")
	t.Setenv("GAMECTL_NFS_WIPE_REQUIRE_PREFIX", "/mnt/1TBSSD/gamectl")

	if err := validateWipeTarget("/mnt/1TBSSD/gamectl/minecraft"); err != nil {
		t.Errorf("path under required prefix should pass, got: %v", err)
	}
	if err := validateWipeTarget("/mnt/1TBSSD/other/minecraft"); err == nil {
		t.Error("path outside required prefix must be rejected")
	}
	// A prefix-matching string that isn't a real path boundary must NOT pass.
	if err := validateWipeTarget("/mnt/1TBSSD/gamectl-evil/x"); err == nil {
		t.Error("prefix must match on a path boundary, not a substring")
	}
}

func TestValidateWipeTarget_MinDepthOverride(t *testing.T) {
	t.Setenv("GAMECTL_NFS_WIPE_REQUIRE_PREFIX", "")
	t.Setenv("GAMECTL_NFS_WIPE_MIN_DEPTH", "4")

	if err := validateWipeTarget("/mnt/1TBSSD/minecraft"); err == nil {
		t.Error("3-segment path must be rejected when min depth is 4")
	}
	if err := validateWipeTarget("/mnt/1TBSSD/gamectl/minecraft"); err != nil {
		t.Errorf("4-segment path should pass at min depth 4, got: %v", err)
	}
}
