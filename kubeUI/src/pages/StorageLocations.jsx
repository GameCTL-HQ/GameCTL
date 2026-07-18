import { useEffect, useState } from 'react'
import { api } from '../api/client'

// Copy-paste Ubuntu recipe for standing up an NFS share GameCTL can use.
// Installs BOTH the server (nfs-kernel-server) and client (nfs-common)
// packages, creates the default /mnt/nfs-share, and exports it to all clients
// (*) so there's no mount restriction. Shown in the "How to make an NFS
// Share? (Ubuntu)" reminder at the top of the page.
const NFS_UBUNTU_SETUP = `# 1. Install the NFS server + client packages
sudo apt update
sudo apt install -y nfs-kernel-server nfs-common

# 2. Create the share directory (this example uses /mnt/nfs-share)
sudo mkdir -p /mnt/nfs-share
sudo chown nobody:nogroup /mnt/nfs-share
sudo chmod 777 /mnt/nfs-share

# 3. Export it to all clients (* = no restriction). You can tighten this
#    later to your node subnet / pod network if you want.
echo '/mnt/nfs-share *(rw,sync,no_subtree_check)' | sudo tee -a /etc/exports

# 4. Apply the export and (re)start the NFS server
sudo exportfs -ra
sudo systemctl enable --now nfs-kernel-server

# 5. Verify it is exported
sudo exportfs -v
showmount -e localhost`

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

  // Per-row probe state: { [rowIdx]: { running, result } }. result mirrors
  // the StorageProbeResult shape from the backend: { ok, stage, message,
  // hint, durationMs, details }.
  const [probes, setProbes] = useState({})
  const clearProbe = (i) => setProbes(p => { const n = { ...p }; delete n[i]; return n })

  const update = (i, k, v) => { setSavedOk(false); clearProbe(i); setRows(r => r.map((row, idx) => idx === i ? { ...row, [k]: v } : row)) }
  const addRow = () => { setSavedOk(false); setRows(r => [...r, { name: '', type: 'nfs', server: '', exportPath: '', folderSuffix: '' }]) }
  const removeRow = (i) => { setSavedOk(false); clearProbe(i); setRows(r => r.filter((_, idx) => idx !== i)) }

  const testRow = async (i) => {
    const row = rows[i]
    setProbes(p => ({ ...p, [i]: { running: true } }))
    try {
      const { data } = await api.post('/storage/locations/test', row)
      setProbes(p => ({ ...p, [i]: { running: false, result: data } }))
    } catch (e) {
      setProbes(p => ({ ...p, [i]: { running: false, result: {
        ok: false, stage: 'setup',
        message: e.message || 'Test request failed',
        hint: 'Could not reach the GameCTL API — check the server logs.',
      } } }))
    }
  }

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

      <details className="mb-5 rounded-lg border border-slate-800 bg-slate-900/40">
        <summary className="cursor-pointer select-none px-4 py-2 text-sm font-medium text-sky-300 hover:text-sky-200">
          How to make an NFS Share? (Ubuntu)
        </summary>
        <div className="border-t border-slate-800 px-4 py-3 space-y-3 text-sm text-slate-300">
          <p>
            Run these on the machine that will host the share (its IP is the
            <span className="mx-1 font-medium">NFS server</span> you enter below).
            Example uses <code className="text-slate-100">/mnt/nfs-share</code>.
          </p>
          <div className="overflow-x-auto rounded-md border border-slate-800 bg-slate-950/70">
            <pre className="p-3 text-xs leading-relaxed text-slate-200 whitespace-pre">{NFS_UBUNTU_SETUP}</pre>
          </div>
          <p className="text-xs text-slate-400">
            <code className="text-slate-200">*</code> exports to all clients — no mount
            restriction. Tighten it later to your node subnet / pod network if you want.
            If pods still can't write, the share dir may need looser permissions or
            <code className="mx-1 text-slate-200">no_root_squash</code> on the export.
            Then use the <span className="font-medium">Test</span> button on a location
            below to confirm the mount.
          </p>
        </div>
      </details>

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
            const probe = probes[i]
            // Test is only meaningful once the row has the fields the probe
            // needs — name + path (and server, for NFS). Disable until then
            // so we don't fire a guaranteed-fail request.
            const canTest = !!(row.name && row.exportPath && (local || row.server))
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
                <div className="flex items-start gap-2 pt-1">
                  <button
                    onClick={() => testRow(i)}
                    disabled={!canTest || probe?.running}
                    className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs font-medium disabled:opacity-50 shrink-0"
                    title={canTest ? 'Spawn a probe pod that mounts the share and reads/writes a test file' : 'Fill in name + path (and server) first'}
                  >
                    {probe?.running ? 'Testing…' : 'Test reachability + read/write'}
                  </button>
                  {probe?.running && (
                    <div className="flex-1 min-w-0 rounded-md border border-slate-700 bg-slate-900/40 px-2.5 py-1.5">
                      <div className="text-xs text-slate-300 flex items-center gap-2">
                        <span className="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse" />
                        Running probe pod against {row.type === 'local' ? row.exportPath : `${row.server}:${row.exportPath}`}…
                      </div>
                      <StepList phase="running" />
                    </div>
                  )}
                  {!probe?.running && probe?.result && <ProbeResult result={probe.result} />}
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

// The deterministic steps the probe performs, mirrored from the backend's
// probeStepCatalog. Listed here so the UI can render the plan as a
// checklist BEFORE the test runs (so the operator sees exactly what
// "Test" is about to do) and updates each item with check/X afterward.
const PROBE_STEPS = [
  { name: 'mount',  description: 'Mount the share as an inline volume' },
  { name: 'mkdir',  description: 'Create the .gamectl-probe test directory' },
  { name: 'write',  description: 'Write a small test file' },
  { name: 'read',   description: 'Read it back and verify the bytes' },
  { name: 'delete', description: 'Delete the test file' },
]

// StepList renders the five-stage probe plan. `phase` is 'plan' (nothing
// run yet — show muted bullets), 'running' (spinner on each), or 'done'
// (use `steps` from the backend for per-stage outcomes). On 'done', the
// failing stage is highlighted red; everything before it green;
// everything after it muted ("not reached").
function StepList({ phase, steps }) {
  // Merge backend `steps` (when present) into the deterministic order so
  // we always show all five. The backend mirrors PROBE_STEPS, but we
  // defend against any drift by falling back to the catalog order.
  const byName = Object.fromEntries((steps || []).map(s => [s.name, s]))
  const items = PROBE_STEPS.map(s => ({ ...s, ...(byName[s.name] || {}) }))
  return (
    <ol className="mt-1 space-y-0.5 text-[11px]">
      {items.map((s, i) => {
        let icon, cls
        if (phase === 'running') {
          icon = <span className="text-slate-500">…</span>
          cls = 'text-slate-400'
        } else if (phase === 'plan') {
          icon = <span className="text-slate-600">·</span>
          cls = 'text-slate-500'
        } else if (s.ok) {
          icon = <span className="text-emerald-400">✓</span>
          cls = 'text-emerald-200/90'
        } else if (s.skipped) {
          icon = <span className="text-slate-600">·</span>
          cls = 'text-slate-500'
        } else {
          // The failing step.
          icon = <span className="text-rose-400">✗</span>
          cls = 'text-rose-200'
        }
        return (
          <li key={s.name} className={`flex items-center gap-2 ${cls}`}>
            <span className="w-3 inline-flex justify-center">{icon}</span>
            <span className="font-mono text-slate-500 text-[10px] w-12">{i + 1}. {s.name}</span>
            <span>{s.description}</span>
          </li>
        )
      })}
    </ol>
  )
}

// ProbeResult renders the inline pass/fail strip for a Test click. Always
// shows the per-stage checklist (so the operator sees what the test
// checked) and, on failure, the targeted hint + collapsible raw details.
function ProbeResult({ result }) {
  const { ok, stage, message, hint, durationMs, details, steps } = result || {}
  if (ok) {
    return (
      <div className="flex-1 min-w-0 rounded-md border border-emerald-800/70 bg-emerald-950/30 px-2.5 py-1.5">
        <div className="text-xs text-emerald-200 flex items-center gap-2">
          <span className="text-emerald-400">✓</span>
          <span className="font-medium">Mount + read/write OK</span>
          {typeof durationMs === 'number' && (
            <span className="text-emerald-500/80">· {Math.round(durationMs)}ms</span>
          )}
        </div>
        <StepList phase="done" steps={steps} />
      </div>
    )
  }
  return (
    <div className="flex-1 min-w-0 rounded-md border border-rose-800 bg-rose-950/40 px-2.5 py-1.5">
      <div className="text-xs text-rose-200 flex items-center gap-2 flex-wrap">
        <span className="text-rose-400">✗</span>
        <span className="font-medium uppercase tracking-wide text-rose-300/90">
          {stage || 'failed'}
        </span>
        <span className="text-rose-100">{message || 'Test failed.'}</span>
      </div>
      {hint && (
        <div className="mt-1 text-[11px] text-rose-200/85">{hint}</div>
      )}
      <StepList phase="done" steps={steps} />
      {details && (
        <details className="mt-1 text-[11px] text-rose-300/70">
          <summary className="cursor-pointer hover:text-rose-200">raw output</summary>
          <pre className="mt-1 whitespace-pre-wrap break-words text-rose-200/80">{details}</pre>
        </details>
      )}
    </div>
  )
}
