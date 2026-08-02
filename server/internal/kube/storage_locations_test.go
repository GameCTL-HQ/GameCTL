package kube

import "testing"

func TestStorageLocationValidate(t *testing.T) {
	ok := []StorageLocation{
		{Name: "nfs-ssd", Server: "10.0.0.100", ExportPath: "/mnt/1TBSSD"},
		{Name: "nfs_hdd", Server: "nas.lan", ExportPath: "/export/games"},
	}
	for _, l := range ok {
		if err := l.Validate(); err != nil {
			t.Errorf("expected %+v valid, got: %v", l, err)
		}
	}

	bad := map[string]StorageLocation{
		"empty name":      {Name: "", Server: "s", ExportPath: "/x"},
		"name with slash": {Name: "a/b", Server: "s", ExportPath: "/x"},
		"name with space": {Name: "a b", Server: "s", ExportPath: "/x"},
		"no server":       {Name: "n", Server: "", ExportPath: "/x"},
		"relative export": {Name: "n", Server: "s", ExportPath: "rel/path"},
		"unclean export":  {Name: "n", Server: "s", ExportPath: "/a/../b"},
	}
	for why, l := range bad {
		if err := l.Validate(); err == nil {
			t.Errorf("expected %s to be rejected: %+v", why, l)
		}
	}
}

func TestStorageLocationGameCTLDir(t *testing.T) {
	if got := (StorageLocation{ExportPath: "/mnt/1TBSSD"}).GameCTLDir(); got != "/mnt/1TBSSD/GameCTL" {
		t.Errorf("default folder: got %q", got)
	}
	if got := (StorageLocation{ExportPath: "/data/", FolderSuffix: "media"}).GameCTLDir(); got != "/data/GameCTL-media" {
		t.Errorf("suffixed folder: got %q", got)
	}
}

func TestStorageLocationLocalValidate(t *testing.T) {
	// Local needs no server.
	if err := (StorageLocation{Name: "ssd", Type: "local", ExportPath: "/mnt/ssd"}).Validate(); err != nil {
		t.Errorf("local without server should be valid: %v", err)
	}
	// Bad type / unsafe suffix rejected.
	if err := (StorageLocation{Name: "x", Type: "weird", ExportPath: "/p"}).Validate(); err == nil {
		t.Error("bad type must error")
	}
	if err := (StorageLocation{Name: "x", Type: "local", ExportPath: "/p", FolderSuffix: "a/b"}).Validate(); err == nil {
		t.Error("suffix with slash must error")
	}
}

// TestStorageLocationNormalized covers the slash cleanup: a path typed with
// a trailing or doubled slash is the same location and must save, while
// traversal stays rejected rather than silently rewritten.
func TestStorageLocationNormalized(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/mnt/1TBSSD", "/mnt/1TBSSD"},
		{"/mnt/1TBSSD/", "/mnt/1TBSSD"},
		{"/mnt/1TBSSD///", "/mnt/1TBSSD"},
		{"/mnt//1TBSSD", "/mnt/1TBSSD"},
		{"  /mnt/1TBSSD/  ", "/mnt/1TBSSD"},
		{"/", "/"},
		{"//", "/"},
		{"", ""},
	}
	for _, tc := range cases {
		if got := normalizeExportPath(tc.in); got != tc.want {
			t.Errorf("normalizeExportPath(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}

	// Normalizing must make a merely-untidy path valid...
	l := StorageLocation{Name: "ssd", Server: "10.0.0.5", ExportPath: "/mnt/1TBSSD//"}
	if err := l.Validate(); err == nil {
		t.Fatal("expected the un-normalized path to fail Validate (guard for the test below)")
	}
	if err := l.Normalized().Validate(); err != nil {
		t.Errorf("normalized location should validate, got %v", err)
	}

	// ...without laundering traversal into an accepted path.
	trav := StorageLocation{Name: "bad", Server: "10.0.0.5", ExportPath: "/mnt/../etc"}
	if err := trav.Normalized().Validate(); err == nil {
		t.Error("traversal path must still be rejected after normalization")
	}
	if got := trav.Normalized().ExportPath; got != "/mnt/../etc" {
		t.Errorf("normalization must not resolve traversal, got %q", got)
	}

	// Trailing space on the suffix shouldn't change the folder name.
	sfx := StorageLocation{Name: "m", Server: "s", ExportPath: "/mnt/x", FolderSuffix: " media "}
	if got := sfx.Normalized().FolderName(); got != "GameCTL-media" {
		t.Errorf("FolderName() = %q, want GameCTL-media", got)
	}
}
