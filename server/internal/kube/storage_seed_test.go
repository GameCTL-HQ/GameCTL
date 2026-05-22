package kube

import "testing"

func TestParseStorageSeed(t *testing.T) {
	locs, err := ParseStorageSeed(
		"name=1TBSSD,server=10.0.0.100,path=/mnt/1TBSSD ; name=hdd,type=local,path=/mnt/8TB,suffix=media")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(locs) != 2 {
		t.Fatalf("want 2 locations, got %d", len(locs))
	}
	if locs[0].Name != "1TBSSD" || locs[0].Server != "10.0.0.100" || locs[0].ExportPath != "/mnt/1TBSSD" {
		t.Errorf("nfs entry parsed wrong: %+v", locs[0])
	}
	if locs[1].Type != "local" || locs[1].FolderSuffix != "media" || locs[1].Server != "" {
		t.Errorf("local entry parsed wrong: %+v", locs[1])
	}
	if locs[1].GameCTLDir() != "/mnt/8TB/GameCTL-media" {
		t.Errorf("GameCTLDir = %q", locs[1].GameCTLDir())
	}

	if locs, err := ParseStorageSeed(""); err != nil || locs != nil {
		t.Errorf("empty seed should be nil/no-op, got %v %v", locs, err)
	}
	if locs, err := ParseStorageSeed("__STORAGE_SEED__"); err != nil || locs != nil {
		t.Errorf("unsubstituted placeholder must be no-op, got %v %v", locs, err)
	}
	if _, err := ParseStorageSeed("name=x,bogus=y,path=/p"); err == nil {
		t.Error("unknown field must error")
	}
	if _, err := ParseStorageSeed("name=x,server=s"); err == nil {
		t.Error("missing absolute path must fail Validate")
	}
}
