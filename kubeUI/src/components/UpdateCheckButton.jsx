import { useEffect, useState } from 'react'
import { api } from '../api/client'
import ReleaseNotes from './ReleaseNotes'

// Header control: shows the running version (tooltip) and a manual
// "check for updates" action. It also auto-checks on load and, when an
// update is available, highlights itself (amber) so the operator is
// prompted even if the top banner was dismissed. A forced check bypasses
// the backend's 30-min cache.
export default function UpdateCheckButton() {
  const [version, setVersion] = useState('')
  const [available, setAvailable] = useState(false)
  const [latest, setLatest] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [showNotes, setShowNotes] = useState(false)

  const apply = (data) => {
    setAvailable(!!data?.updateAvailable)
    setLatest(data?.latest || '')
  }

  useEffect(() => {
    api.get('/version').then(({ data }) => setVersion(data?.version || '')).catch(() => {})
    api.get('/update/check').then(({ data }) => apply(data)).catch(() => {})
  }, [])

  const check = async () => {
    setBusy(true); setMsg('')
    try {
      const { data } = await api.get('/update/check?force=1')
      apply(data)
      if (data?.updateAvailable) {
        setMsg(`Update available: ${data.latest}`)
        window.dispatchEvent(new CustomEvent('gamectl:recheck-updates'))
      } else if (data?.note) {
        setMsg(data.note)
      } else {
        setMsg('Up to date ✓')
      }
      setTimeout(() => setMsg(''), 6000)
    } catch {
      setMsg('Check failed')
      setTimeout(() => setMsg(''), 6000)
    } finally {
      setBusy(false)
    }
  }

  // When an update is available the button's job is just to surface the
  // banner (which carries the full details + the one-click update) — no
  // redundant re-check, no busy/msg churn that resizes the header. When
  // up to date it performs a real forced check.
  const showBanner = () => {
    window.dispatchEvent(new CustomEvent('gamectl:recheck-updates'))
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  const cls = available
    ? 'px-3 py-1.5 rounded-lg text-sm border border-amber-600 bg-amber-600/20 text-amber-200 hover:bg-amber-600/30 whitespace-nowrap'
    : 'px-3 py-1.5 rounded-lg text-sm border border-transparent hover:bg-slate-800 text-slate-300 whitespace-nowrap'

  return (
    <div className="flex items-center gap-2">
      {msg && <span className="text-xs text-slate-400 whitespace-nowrap">{msg}</span>}
      <button
        onClick={() => setShowNotes(true)}
        title={version ? `Running ${version} — see what's new` : "See what's new"}
        className="px-3 py-1.5 rounded-lg text-sm border border-transparent hover:bg-slate-800 text-slate-300 whitespace-nowrap"
      >
        What's new
      </button>
      <button
        onClick={available ? showBanner : check}
        disabled={busy}
        title={available
          ? 'Show the update details below'
          : (version ? `Running ${version} — check for updates` : 'Check for updates')}
        className={`${cls} disabled:opacity-50`}
      >
        {busy
          ? 'Checking…'
          : available
            ? `● Update available${latest ? ` (${latest})` : ''}`
            : 'Check for updates'}
      </button>

      {showNotes && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center p-4 overflow-y-auto"
          onClick={() => setShowNotes(false)}
        >
          <div
            className="bg-slate-950 border border-slate-800 rounded-xl p-4 max-w-2xl w-full mt-12"
            onClick={(e) => e.stopPropagation()}
          >
            <ReleaseNotes onClose={() => setShowNotes(false)} />
          </div>
        </div>
      )}
    </div>
  )
}
