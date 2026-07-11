import { useEffect, useState } from 'react'
import { api } from '../api/client'

// Maps a change "type" to a small coloured tag so the operator can scan
// "what's updating and why" at a glance.
const TYPE_TAG = {
  fixed:    { label: 'Fix',      cls: 'bg-emerald-900/60 text-emerald-200 border-emerald-700' },
  added:    { label: 'New',      cls: 'bg-sky-900/60 text-sky-200 border-sky-700' },
  changed:  { label: 'Changed',  cls: 'bg-amber-900/60 text-amber-200 border-amber-700' },
  removed:  { label: 'Removed',  cls: 'bg-rose-900/60 text-rose-200 border-rose-700' },
  security: { label: 'Security', cls: 'bg-fuchsia-900/60 text-fuchsia-200 border-fuchsia-700' },
}

function ChangeRow({ change }) {
  const tag = TYPE_TAG[change.type] || { label: change.type || 'Note', cls: 'bg-slate-800 text-slate-300 border-slate-600' }
  return (
    <li className="flex flex-col gap-1 py-2 border-b border-slate-800 last:border-0">
      <div className="flex items-center gap-2">
        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${tag.cls}`}>
          {tag.label}
        </span>
        <span className="font-semibold text-slate-100 text-sm">{change.title}</span>
      </div>
      {change.detail && (
        <p className="text-xs text-slate-400 leading-relaxed">{change.detail}</p>
      )}
    </li>
  )
}

function ReleaseBlock({ rel, highlight }) {
  return (
    <section className={`rounded-lg border p-3 ${highlight ? 'border-amber-700 bg-amber-950/30' : 'border-slate-800 bg-slate-900/40'}`}>
      <div className="flex items-baseline gap-2 flex-wrap">
        <h3 className="font-semibold text-slate-100">
          {rel.name || rel.version}
        </h3>
        <span className="text-xs text-slate-500">{rel.version}</span>
        {rel.date && <span className="text-xs text-slate-500">· {rel.date}</span>}
        {highlight && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-800/60 text-amber-200 border border-amber-700">
            This build
          </span>
        )}
      </div>
      {rel.summary && <p className="text-xs text-slate-400 mt-1">{rel.summary}</p>}
      <ul className="mt-2">
        {(rel.changes || []).map((c, i) => <ChangeRow key={i} change={c} />)}
      </ul>
    </section>
  )
}

// ReleaseNotes fetches GameCTL's embedded changelog (/api/release-notes)
// and lists every release, highlighting the one matching the running
// build. Used inside the update tool so the operator sees exactly what
// each GameCTL version changes ("what's updating and why").
//
// Props:
//   - onClose:        optional; renders a close button (modal use)
//   - currentVersion: optional; overrides which entry is highlighted
//                      (e.g. the *available* version in the update banner)
export default function ReleaseNotes({ onClose, currentVersion }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.get('/release-notes')
      .then(({ data }) => setData(data))
      .catch((e) => setErr(e.message || 'Could not load release notes'))
  }, [])

  const highlightVer = (currentVersion || data?.current?.version || data?.version || '')
    .replace(/^v/, '')

  return (
    <div className="flex flex-col gap-3 max-h-[70vh]">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-100">What's new in GameCTL</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="px-2 py-1 rounded border border-slate-700 hover:bg-slate-800 text-xs text-slate-300"
          >
            Close
          </button>
        )}
      </div>

      {err && <p className="text-rose-300 text-sm">{err}</p>}
      {!data && !err && <p className="text-slate-400 text-sm">Loading release notes…</p>}

      {data && (
        <div className="flex flex-col gap-3 overflow-y-auto pr-1">
          {(data.releases || []).map((rel) => (
            <ReleaseBlock
              key={rel.version}
              rel={rel}
              highlight={rel.version.replace(/^v/, '') === highlightVer
                || (data.current && rel.version === data.current.version)}
            />
          ))}
          {(!data.releases || data.releases.length === 0) && (
            <p className="text-slate-400 text-sm">No release notes available.</p>
          )}
        </div>
      )}
    </div>
  )
}
