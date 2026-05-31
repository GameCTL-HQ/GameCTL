package releasenotes

import "testing"

// TestEmbeddedJSONValid catches an authoring mistake in releases.json at
// CI time rather than letting the API silently serve nothing.
func TestEmbeddedJSONValid(t *testing.T) {
	if loadErr != nil {
		t.Fatalf("releases.json failed to parse: %v", loadErr)
	}
	all, err := All()
	if err != nil {
		t.Fatalf("All: %v", err)
	}
	if len(all) == 0 {
		t.Fatal("no release entries embedded")
	}
	for i, r := range all {
		if r.Version == "" {
			t.Errorf("release %d has empty version", i)
		}
		if len(r.Changes) == 0 {
			t.Errorf("release %q has no changes", r.Version)
		}
		for j, c := range r.Changes {
			if c.Title == "" || c.Type == "" {
				t.Errorf("release %q change %d missing type/title", r.Version, j)
			}
		}
	}
}

func TestForVersion(t *testing.T) {
	// Untagged SHA build falls back to the unreleased entry.
	r, found, err := ForVersion("bdc8e81")
	if err != nil || !found {
		t.Fatalf("ForVersion SHA: found=%v err=%v", found, err)
	}
	if !r.Unreleased && norm(r.Version) != "unreleased" {
		t.Errorf("SHA build should resolve to unreleased entry, got %q", r.Version)
	}
	if len(r.Changes) == 0 {
		t.Error("resolved entry has no changes")
	}

	// "dev" must never panic and should still resolve to something.
	if _, found, _ := ForVersion("dev"); !found {
		t.Error("dev build should still resolve an entry")
	}
}
