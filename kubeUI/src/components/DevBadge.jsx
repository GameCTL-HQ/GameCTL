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
  const isRelease = /^v\d+\.\d+\.\d+/.test(version)
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
