package kube

import "testing"

// splitImageRepoTag must preserve the registry/repo so UpdateSelfImage swaps
// only the tag. Traps: a registry host:port colon (not the tag separator) and
// an @sha256 digest (dropped).
func TestSplitImageRepoTag(t *testing.T) {
	cases := []struct{ image, wantRepo, wantTag string }{
		{"ghcr.io/gamectl-hq/gamectl:v0.0.29-beta", "ghcr.io/gamectl-hq/gamectl", "v0.0.29-beta"},
		{"ghcr.io/gamectl-hq/gamectl:latest", "ghcr.io/gamectl-hq/gamectl", "latest"},
		{"registry.example.com:5000/gamectl:dev-123", "registry.example.com:5000/gamectl", "dev-123"},
		{"registry.example.com:5000/gamectl", "registry.example.com:5000/gamectl", ""},
		{"ghcr.io/gamectl-hq/gamectl", "ghcr.io/gamectl-hq/gamectl", ""},
		{"ghcr.io/gamectl-hq/gamectl@sha256:abc", "ghcr.io/gamectl-hq/gamectl", ""},
		{"ghcr.io/gamectl-hq/gamectl:v0.0.29-beta@sha256:abc", "ghcr.io/gamectl-hq/gamectl", "v0.0.29-beta"},
	}
	for _, c := range cases {
		repo, tag := splitImageRepoTag(c.image)
		if repo != c.wantRepo || tag != c.wantTag {
			t.Errorf("splitImageRepoTag(%q) = (%q,%q), want (%q,%q)", c.image, repo, tag, c.wantRepo, c.wantTag)
		}
	}
}
