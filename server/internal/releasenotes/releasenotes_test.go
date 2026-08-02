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
		// A tagged release must document something; the "unreleased" staging
		// entry may be empty between releases (content is promoted to a
		// versioned entry at release time).
		if len(r.Changes) == 0 && !r.Unreleased {
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
	// An untagged SHA build falls back to the newest RELEASED entry —
	// never to a staging "unreleased" placeholder, which told the operator
	// nothing about the build they were actually running.
	r, found, err := ForVersion("bdc8e81")
	if err != nil || !found {
		t.Fatalf("ForVersion SHA: found=%v err=%v", found, err)
	}
	if r.Unreleased || norm(r.Version) == "unreleased" {
		t.Errorf("SHA build must not resolve to an unreleased entry, got %q", r.Version)
	}
	if len(r.Changes) == 0 {
		t.Errorf("SHA build should resolve to a populated release, got %q with no changes", r.Version)
	}

	// A tagged build resolves to its own entry, which must carry real notes.
	// Pick the newest versioned entry dynamically so this survives promotions.
	all, _ := All()
	var tagged string
	for _, e := range all {
		if !e.Unreleased && norm(e.Version) != "unreleased" {
			tagged = e.Version
			break
		}
	}
	if tagged != "" {
		tr, found, _ := ForVersion(tagged)
		if !found || len(tr.Changes) == 0 {
			t.Errorf("tagged build %q should resolve to a populated entry (found=%v, changes=%d)", tagged, found, len(tr.Changes))
		}
	}

	// "dev" must never panic and should still resolve to something.
	if _, found, _ := ForVersion("dev"); !found {
		t.Error("dev build should still resolve an entry")
	}
}
