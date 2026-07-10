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
