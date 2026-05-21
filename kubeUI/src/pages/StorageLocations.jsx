import { useEffect, useState } from 'react'
import { api } from '../api/client'

// CRUD for the operator-declared NFS storage locations. Persisted server-side
// to the gamectl-storage ConfigMap via /api/storage/locations. Games pick one
// of these in the deploy wizard; data lands at <export>/gamectl/<server>.
export default function StorageLocations({ firstRun = false, onSkip, onContinue } = {}) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = () => {
    setLoading(true)
    api.get('/storage/locations')
      .then(({ data }) => setRows(data?.locations || []))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  // True only after a successful save with at least one location. Gates the
  // forward "Continue" button so first-run users move on with real storage.
  const [savedOk, setSavedOk] = useState(false)

  const update = (i, k, v) => { setSavedOk(false); setRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row)) }
  const addRow = () => { setSavedOk(false); setRows(r => [...r, { name: '', type: 'nfs', server: '', exportPath: '', folderSuffix: '' }]) }
  const removeRow = (i) => { setSavedOk(false); setRows(r => r.filter((_, idx) => idx !== i)) }

  const save = async () => {
    setSaving(true); setMsg(''); setErr('')
    try {
      const { data } = await api.put('/storage/locations', { locations: rows })
      const next = data?.locations || rows
      setRows(next)
      setSavedOk(next.length > 0)
      setMsg('Saved.')
    } catch (e) {
      setErr(e.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-6">
      {firstRun && (
        <div className="mb-5 rounded-xl border border-amber-700 bg-amber-950/40 px-4 py-3">
          <div className="text-sm text-amber-100 font-medium mb-1">
            Set up a Storage Location to get started
          </div>
          <p className="text-xs text-amber-200/80">
            Game servers need somewhere to save their data. Add at least one NFS
            (or local) location below — GameCTL creates a top-level
            <code className="mx-1 text-amber-100">GameCTL/</code> folder there and
            each server gets its own subfolder. You can't deploy a game until a
            location exists.
          </p>
          <div className="mt-2">
            <button
              onClick={onSkip}
              className="text-xs text-amber-200/70 hover:text-amber-100 underline underline-offset-2"
            >
              Skip for now
            </button>
          </div>
        </div>
      )}
      <h2 className="text-xl font-semibold mb-1">Storage Locations</h2>
      <p className="text-sm text-slate-400 mb-5">
        NFS shares GameCTL can deploy game data to. Each game's data lands at
        <code className="mx-1 text-slate-300">&lt;export&gt;/gamectl/&lt;server&gt;</code>
        via an inline NFS volume — no PV/PVC/StorageClass. Add as many as your
        cluster network can reach; pick one per game in the deploy wizard.
      </p>

      {err && !loading && rows.length === 0 && (
        <div className="mb-4 rounded-lg border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">{err}</div>
      )}

      {loading ? (
        <p className="text-sm text-slate-400">Loading storage locations…</p>
      ) : (
        <div className="space-y-4">
          {rows.length === 0 && (
            <p className="text-sm text-slate-500 italic">No locations yet — add one below.</p>
          )}
          {rows.map((row, i) => {
            const local = row.type === 'local'
            const folder = row.folderSuffix ? `GameCTL-${row.folderSuffix}` : 'GameCTL'
            const inp = 'form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100 text-sm'
            return (
              <div key={i} className="rounded-lg border border-slate-800 bg-slate-900/40 p-3 space-y-2">
                <div className="grid grid-cols-[1fr_140px_auto] gap-2">
                  <input className={inp} placeholder="name (e.g. nfs-ssd)" value={row.name}
                    onChange={e => update(i, 'name', e.target.value)} />
                  <select className={inp} value={row.type || 'nfs'}
                    onChange={e => update(i, 'type', e.target.value)}>
                    <option value="nfs">NFS</option>
                    <option value="local">Local (host path)</option>
                  </select>
                  <button onClick={() => removeRow(i)}
                    className="px-3 rounded-lg bg-slate-800 hover:bg-rose-900/60 border border-slate-700 text-rose-300 text-sm"
                    title="Remove">✕</button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {!local && (
                    <input className={inp} placeholder="NFS server (10.0.0.100)" value={row.server || ''}
                      onChange={e => update(i, 'server', e.target.value)} />
                  )}
                  <input className={`${inp} ${local ? 'col-span-2' : ''}`}
                    placeholder={local ? 'host path (/mnt/1TBSSD)' : 'export path (/mnt/1TBSSD)'}
                    value={row.exportPath}
                    onChange={e => update(i, 'exportPath', e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-2 items-center">
                  <input className={inp} placeholder="folder suffix (optional)"
                    value={row.folderSuffix || ''}
                    onChange={e => update(i, 'folderSuffix', e.target.value)} />
                  <span className="text-xs text-slate-500">
                    data → <code className="text-slate-300">{(row.exportPath || '<path>')}/{folder}/&lt;server&gt;</code>
                  </span>
                </div>
              </div>
            )
          })}

          <div className="flex items-center gap-2 pt-2">
            <button
              onClick={addRow}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm"
            >+ Add location</button>
            <button
              onClick={save} disabled={saving}
              className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >{saving ? 'Saving…' : 'Save'}</button>
            {msg && <span className="text-sm text-emerald-300">{msg}</span>}
            {err && rows.length > 0 && <span className="text-sm text-rose-300">{err}</span>}
            {firstRun && savedOk && (
              <button
                onClick={onContinue || onSkip}
                className="ml-auto px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 border border-emerald-500 text-sm font-medium text-white"
              >
                Continue to GameCTL →
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
