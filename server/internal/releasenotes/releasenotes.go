// Package releasenotes embeds GameCTL's structured changelog and resolves
// the entry for a given build version.
//
// The source of truth is releases.json (the human companion is the repo
// root CHANGELOG.md — keep them in sync). It is compiled into the binary
// via //go:embed so the running build always carries its own notes; the
// in-app update tool surfaces them via GET /api/release-notes.
//
// Version alignment: builds are stamped with -X main.version=$(VERSION),
// which is a git tag (e.g. "v0.0.2-beta") or a short commit SHA for
// untagged builds. We match the running version against a tagged entry;
// if none matches (the common case for SHA/dev builds), we fall back to
// the "unreleased" entry so the operator still sees what changed.
package releasenotes

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

//go:embed releases.json
var raw []byte

// Change is a single documented fix/addition within a release.
type Change struct {
	Type   string `json:"type"`   // fixed | added | changed | removed | security
	Title  string `json:"title"`  // short "what's updating"
	Detail string `json:"detail"` // "and why"
}

// Release is one changelog entry, aligned to a build version.
type Release struct {
	Version    string   `json:"version"` // git tag or "unreleased"
	Name       string   `json:"name,omitempty"`
	Unreleased bool     `json:"unreleased,omitempty"`
	Date       string   `json:"date,omitempty"`
	Summary    string   `json:"summary,omitempty"`
	Changes    []Change `json:"changes"`
}

type doc struct {
	Releases []Release `json:"releases"`
}

var parsed doc

// loadErr is non-nil only if the embedded JSON is malformed (a build-time
// authoring mistake). It is surfaced so a bad changelog is caught in CI /
// at startup rather than silently serving nothing.
var loadErr error

func init() {
	loadErr = json.Unmarshal(raw, &parsed)
}

// norm strips a leading "v" and whitespace so "v0.0.2-beta" == "0.0.2-beta".
func norm(s string) string { return strings.TrimPrefix(strings.TrimSpace(s), "v") }

// All returns every release entry, newest first (file order).
func All() ([]Release, error) {
	if loadErr != nil {
		return nil, fmt.Errorf("release notes: %w", loadErr)
	}
	return parsed.Releases, nil
}

// IsTagged reports whether the running build's version exactly matches a
// tagged (non-unreleased) entry — i.e. this is a released build. Released
// builds hide the "unreleased" staging entry from the in-app notes: it
// only carries meaning on SHA/dev builds, and on a release it's either a
// duplicate of the release itself or an empty placeholder.
func IsTagged(version string) bool {
	all, err := All()
	if err != nil {
		return false
	}
	v := norm(version)
	if v == "" || v == "dev" {
		return false
	}
	for i := range all {
		r := &all[i]
		if !r.Unreleased && norm(r.Version) != "unreleased" && norm(r.Version) == v {
			return true
		}
	}
	return false
}

// ForVersion returns the release entry that best matches the running build:
//
//   - an exact version match (tag-stamped releases), else
//   - the newest RELEASED entry.
//
// A staging "unreleased" entry is never used as the fallback. Between tags
// the operator is running a SHA/dev build, and pointing those at an
// unreleased placeholder showed them a section headed "Unreleased" —
// usually empty — instead of what actually shipped most recently. The
// newest real release is the honest answer to "what's in this build".
//
// found is false only when there are no entries at all.
func ForVersion(version string) (rel Release, found bool, err error) {
	all, err := All()
	if err != nil {
		return Release{}, false, err
	}
	if len(all) == 0 {
		return Release{}, false, nil
	}

	v := norm(version)
	for i := range all {
		r := &all[i]
		if v != "" && v != "dev" && norm(r.Version) == v {
			return *r, true, nil
		}
	}
	for i := range all {
		r := &all[i]
		if !r.Unreleased && norm(r.Version) != "unreleased" {
			return *r, true, nil
		}
	}
	return all[0], true, nil
}
