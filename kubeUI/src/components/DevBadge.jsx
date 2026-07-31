import { useEffect, useState } from 'react'
import { api } from '../api/client'

// Loud orange "DEV BUILD" pill shown only when the running binary is NOT a
// tagged release (version "dev", a git SHA/describe, or anything not vX.Y.Z).
// Released images (built by CI from a v* tag) render nothing.
export default function DevBadge() {
  const [version, setVersion] = useState(null)

  useEffect(() => {
    api.get('/version').then(({ data }) => setVersion(data?.version ?? '')).catch(() => {})
  }, [])

  if (version === null) return null
  // Anchored at BOTH ends on purpose. VERSION is `git describe --tags
  // --always --dirty`, so a dev build reads v0.0.39-beta-2-g6b89f15-dirty —
  // and an unanchored prefix test matched that as a release, silently hiding
  // the badge on every build after the first tag was cut. One optional
  // pre-release word (-beta, -rc.1) is still a release; a commit-count
  // segment (-2-g<sha>) or -dirty is not.
  const isRelease = /^v\d+\.\d+\.\d+(-[A-Za-z][A-Za-z0-9.]*)?$/.test(version)
  if (isRelease) return null

  return (
    <span
      title={`Development build (${version || 'unversioned'}) — not a tagged release`}
      className="px-2 py-1 rounded-md text-xs font-bold uppercase tracking-wide bg-orange-500 text-slate-950"
    >
      Dev build{version && version !== 'dev' ? ` · ${version}` : ''}
    </span>
  )
}
