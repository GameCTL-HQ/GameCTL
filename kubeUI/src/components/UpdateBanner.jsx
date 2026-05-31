import { useEffect, useState } from 'react'
import { api } from '../api/client'
import ReleaseNotes from './ReleaseNotes'

const DISMISS_KEY = 'gamectlUpdateDismissed' // stores the version the user ignored

// Shows a banner when a newer GameCTL release exists, with a one-click
// in-place update (rolling restart — keeps auth + game servers).
// "Later" hides it for that version; a forced re-check (header button,
// dispatching `gamectl:recheck-updates`) brings it back.
export default function UpdateBanner() {
  const [info, setInfo] = useState(null)
  const [phase, setPhase] = useState('idle')   // idle | updating | error
  const [err, setErr] = useState('')
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) || '')
  const [showNotes, setShowNotes] = useState(false)

  const load = (force = false) =>
    api.get(`/update/check${force ? '?force=1' : ''}`)
      .then(({ data }) => setInfo(data))
      .catch(() => { /* soft-fail: no banner */ })

  useEffect(() => {
    load()
    const onRecheck = () => {
      // Manual check: clear any prior dismissal so the banner can reappear.
      localStorage.removeItem(DISMISS_KEY)
      setDismissed('')
      load(true)
    }
    window.addEventListener('gamectl:recheck-updates', onRecheck)
    return () => window.removeEventListener('gamectl:recheck-updates', onRecheck)
  }, [])

  if (phase === 'updating') {
    return (
      <div className="bg-emerald-950/70 border-b border-emerald-800 text-emerald-200 text-sm">
        <div className="max-w-6xl mx-auto px-4 py-2">
          Updating GameCTL… the new version is rolling out. This page will
          reconnect automatically in a few seconds.
        </div>
      </div>
    )
  }

  if (!info?.updateAvailable) return null
  if (dismissed && dismissed === info.latest) return null

  const startUpdate = async () => {
    setPhase('updating'); setErr('')
    try {
      await api.post('/update/apply')
      setTimeout(() => window.location.reload(), 20000)
    } catch (e) {
      setPhase('error')
      setErr(e.response?.data?.detail || e.message || 'update failed')
    }
  }

  const later = () => {
    localStorage.setItem(DISMISS_KEY, info.latest)
    setDismissed(info.latest)
  }

  return (
    <div className="bg-amber-950/60 border-b border-amber-700 text-amber-100 text-sm">
      <div className="max-w-6xl mx-auto px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>
          <span className="font-semibold">GameCTL {info.latest}</span> is available
          {info.current && info.current !== 'dev' && (
            <span className="text-amber-300/80"> — you're on {info.current}</span>
          )}.
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowNotes(true)}
            className="px-2 py-1 rounded border border-amber-700 hover:bg-amber-900/50 text-xs"
          >
            What's changing
          </button>
          {info.releaseUrl && (
            <a
              href={info.releaseUrl} target="_blank" rel="noreferrer"
              className="px-2 py-1 rounded border border-amber-700 hover:bg-amber-900/50 text-xs"
            >
              On GitHub ↗
            </a>
          )}
          <button
            onClick={later}
            className="px-2 py-1 rounded border border-amber-700 hover:bg-amber-900/50 text-xs"
          >
            Later
          </button>
          <button
            onClick={startUpdate}
            className="px-3 py-1 rounded bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold text-xs"
          >
            Update now
          </button>
        </span>
        {phase === 'error' && (
          <span className="w-full text-rose-300 text-xs">Update failed: {err}</span>
        )}
      </div>

      {showNotes && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setShowNotes(false)}
        >
          <div
            className="bg-slate-950 border border-slate-800 rounded-xl p-4 max-w-2xl w-full mt-12"
            onClick={(e) => e.stopPropagation()}
          >
            <ReleaseNotes
              currentVersion={info.latest}
              onClose={() => setShowNotes(false)}
            />
          </div>
        </div>
      )}
    </div>
  )
}
