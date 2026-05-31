package update

import "testing"

// versionLess locks down "is b strictly newer than a" so a transient
// GitHub "latest" lag (current ahead of API) never falsely flags an
// update — that was the v0.0.16-beta bug where the banner read
// "v0.0.15-beta is available — you're on v0.0.16-beta".
func TestVersionLess(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
		why  string
	}{
		// equal
		{"v0.0.16-beta", "v0.0.16-beta", false, "identical"},
		{"0.0.16-beta", "v0.0.16-beta", false, "v-prefix is optional"},

		// the regression case: current is ahead of GitHub-reported latest
		{"v0.0.16-beta", "v0.0.15-beta", false, "current ahead → not less"},

		// the normal "an update is available" case
		{"v0.0.15-beta", "v0.0.16-beta", true, "newer patch"},
		{"v0.0.15-beta", "v0.1.0-beta", true, "newer minor"},
		{"v0.0.15-beta", "v1.0.0-beta", true, "newer major"},

		// prerelease vs release at the same numeric version
		{"v1.0.0-beta", "v1.0.0", true, "prerelease < release"},
		{"v1.0.0", "v1.0.0-beta", false, "release > prerelease"},

		// prerelease ordering — lexicographic when both have suffixes
		{"v1.0.0-alpha", "v1.0.0-beta", true, "alpha < beta"},
		{"v1.0.0-beta", "v1.0.0-alpha", false, "beta > alpha"},

		// unparseable inputs never claim "less than" — keeps SHA / "dev"
		// builds from ever flipping UpdateAvailable on
		{"dev", "v0.0.16-beta", false, "dev current → no update prompt"},
		{"v0.0.16-beta", "dev", false, "dev latest → no update prompt"},
		{"abc1234", "v0.0.16-beta", false, "sha current → no update prompt"},
		{"", "v0.0.16-beta", false, "empty current → no update prompt"},
	}
	for _, c := range cases {
		if got := versionLess(c.a, c.b); got != c.want {
			t.Errorf("versionLess(%q, %q) = %v, want %v (%s)", c.a, c.b, got, c.want, c.why)
		}
	}
}
