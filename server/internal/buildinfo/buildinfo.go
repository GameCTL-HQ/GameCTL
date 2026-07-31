// Package buildinfo carries the build-time version of GameCTL.
//
// Version is "dev" for un-stamped builds and is set at release time via
// the binary's `main.version` (linker -X), which main copies here at
// startup. The self-update check compares this against the latest
// published GitHub release.
package buildinfo

// Version is the running GameCTL version (e.g. "v0.0.1-beta"), or "dev".
var Version = "dev"
