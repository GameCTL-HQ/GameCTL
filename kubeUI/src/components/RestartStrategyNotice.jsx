import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'

// RestartStrategyNotice — finds game servers deployed before the Recreate
// fix and repairs them in one click.
//
// Those instances still carry strategy: RollingUpdate in the cluster, which
// makes Restart schedule the replacement pod while the old one still holds
// its CPU/RAM and its volume — on a homelab without that headroom the new
// pod sits Pending and Restart looks hung. Nothing repairs them implicitly:
// Restart only patches the pod template, so it keeps the existing strategy,
// and the apply-time fix only runs on a redeploy.
//
// Self-gating: renders nothing when there's nothing to fix.
export default function RestartStrategyNotice({ namespace, name } = {}) {
  const [affected, setAffected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(() => (
    api.get('/games/rollout-strategy')
      .then(r => setAffected(r.data?.affected || []))
      .catch(() => setAffected([]))
  ), [])
  useEffect(() => { load() }, [load])

  // Scoped to one instance on the manage screen; the whole fleet on the hub.
  const mine = (affected || []).filter(a => !name || (a.name === name && (!namespace || a.namespace === namespace)))
  if (!affected || mine.length === 0) return null

  const fixOne = !!name
  const fix = async () => {
    setBusy(true); setMsg(''); setErr('')
    try {
      const body = fixOne ? { namespace: mine[0].namespace, name: mine[0].name } : {}
      const { data } = await api.post('/games/rollout-strategy/fix', body)
      const n = (data?.fixed || []).length
      setMsg(`Fixed ${n} server${n === 1 ? '' : 's'}. Restart works normally now — nothing was restarted.`)
      if (data?.detail) setErr(data.detail)
      load()
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-xl border border-amber-900 bg-amber-950/30 p-4">
      <p className="text-sm font-semibold text-amber-300">
        {fixOne
          ? 'Restart would hang on this server'
          : `Restart would hang on ${mine.length} server${mine.length === 1 ? '' : 's'}`}
      </p>
      <p className="mt-1 text-xs text-slate-300">
        {fixOne ? 'It was' : 'They were'} deployed before GameCTL pinned game servers to the{' '}
        <span className="font-mono text-slate-200">Recreate</span> rollout strategy, so Kubernetes
        starts the replacement pod <em>before</em> stopping the old one — it has to find a second
        copy of the CPU and RAM the running server still holds, and waits forever if the cluster
        doesn't have it.
      </p>
      {!fixOne && (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {mine.map(a => (
            <li key={`${a.namespace}/${a.name}`}
              className="rounded bg-slate-900 px-2 py-0.5 font-mono text-[11px] text-slate-300">
              {a.name}
              {!a.running && <span className="ml-1 text-slate-500">(stopped)</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          onClick={fix}
          disabled={busy}
          className="rounded-lg bg-amber-600 px-3 py-2 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
        >
          {busy ? 'Fixing…' : fixOne ? 'Fix this server' : `Fix all ${mine.length}`}
        </button>
        <span className="text-[11px] text-slate-500">
          Safe to run while servers are up — this changes the rollout strategy only, which restarts
          nothing. It takes effect the next time you hit Restart.
        </span>
      </div>
      {msg && <p className="mt-2 text-xs text-emerald-400">{msg}</p>}
      {err && <p className="mt-2 text-xs text-rose-400">{err}</p>}
    </section>
  )
}
