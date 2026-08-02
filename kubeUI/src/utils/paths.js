// Storage path normalization.
//
// Mirrors the server's normalizeExportPath (internal/kube/storage_locations.go)
// so what the Storage Locations screen shows, saves, and previews matches what
// the backend will store. Several screens compose <export>/<folder>/<server>
// by hand; each did its own ad-hoc trim (or none), so an export typed as
// "/mnt/1TBSSD/" produced "/mnt/1TBSSD//GameCTL/valheim" in the preview — and
// the save failed with "path is not normalized", which doesn't tell an
// operator that a trailing slash was the problem.
//
// Deliberately does NOT resolve "..": the server rejects traversal rather
// than rewriting it into a path nobody typed, and the UI should show the same
// string the server is judging.

const collapse = (p) => String(p).replace(/\/{2,}/g, '/')

// cleanExport — absolute share/host path, no trailing slash. Bare "/" is kept.
export function cleanExport(p) {
  const s = collapse(String(p ?? '').trim())
  if (!s) return ''
  if (s === '/') return s
  return s.replace(/\/+$/, '')
}

// cleanSegment — one path component (folder, server name): no leading or
// trailing slashes.
export function cleanSegment(p) {
  return collapse(String(p ?? '').trim()).replace(/^\/+/, '').replace(/\/+$/, '')
}

// joinPath — join a base with any number of segments using exactly one
// separator between each, whatever slashes the parts carry.
export function joinPath(base, ...segments) {
  const b = cleanExport(base)
  const rest = segments.map(cleanSegment).filter(Boolean).join('/')
  if (!rest) return b
  if (!b) return rest
  return b === '/' ? `/${rest}` : `${b}/${rest}`
}
