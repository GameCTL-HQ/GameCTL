import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { copyText } from '../utils/clipboard'

// Admin panel for the GameCTL Stats API itself — issue/rotate/revoke the
// read-only token that gates GET /api/stats/servers. This is deliberately
// separate from the per-instance Stats-API export toggle in
// GameManage.jsx's SettingsPanel: enabling here doesn't advertise anything
// by itself, and advertising an instance doesn't require this to be on
// first — the two are independent switches, matching how the operator
// asked for it ("both toggleable for use cases").
//
// Token is deterministic per secret (see auth.Authenticator.StatsToken) —
// GET always re-derives and shows the CURRENT token, no separate storage.
export default function StatsAPI() {
  const [status, setStatus] = useState(null) // { enabled, token }
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  const load = () => {
    setLoading(true)
    api.get('/stats/token')
      .then(({ data }) => setStatus(data))
      .catch(e => setErr(e.response?.data?.detail || e.message))
      .finally(() => setLoading(false))
  }
  useEffect(load, [])

  const [promo, setPromo] = useState(null) // { deployed, image, ready }
  const [promoBusy, setPromoBusy] = useState(false)
  const [promoErr, setPromoErr] = useState('')
  const [promoTitle, setPromoTitle] = useState('Game Servers')
  const [promoAccent, setPromoAccent] = useState('#7c3aed')

  const loadPromo = () => api.get('/promosite/status').then(({ data }) => setPromo(data)).catch(() => {})
  useEffect(loadPromo, [])

  const deployPromo = async () => {
    setPromoBusy(true); setPromoErr('')
    try {
      await api.post('/promosite/deploy', { title: promoTitle, accent: promoAccent })
      await loadPromo()
    } catch (e) {
      setPromoErr(e.response?.data?.detail || e.message)
    } finally {
      setPromoBusy(false)
    }
  }

  const removePromo = async () => {
    setPromoBusy(true); setPromoErr('')
    try {
      await api.delete('/promosite/deploy')
      await loadPromo()
    } catch (e) {
      setPromoErr(e.response?.data?.detail || e.message)
    } finally {
      setPromoBusy(false)
    }
  }

  const run = async (fn) => {
    setBusy(true); setErr(''); setConfirmRevoke(false)
    try { await fn() } catch (e) { setErr(e.response?.data?.detail || e.message) } finally { setBusy(false) }
  }

  const enableOrRotate = () => run(async () => {
    const { data } = await api.post('/stats/token')
    setStatus(data)
  })

  const revoke = () => run(async () => {
    await api.delete('/stats/token')
    setStatus({ enabled: false })
  })

  const copy = async () => {
    if (!status?.token) return
    const ok = await copyText(status.token)
    setCopied(ok)
    setTimeout(() => setCopied(false), 1500)
  }

  const apiURL = `${window.location.origin.replace(/:\d+$/, '')}/api/stats/servers`

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <h2 className="text-xl font-semibold mb-1">GameCTL Stats API</h2>
      <p className="text-sm text-slate-400 mb-5">
        A separate, read-only, token-gated endpoint — <code className="text-slate-300">GET /api/stats/servers</code> —
        that lists only the instances you've flagged <span className="text-slate-300">Export this server's stats via the GameCTL API</span> on
        their manage screen, with live status and player counts. It's signed with its own key, so this token can
        never be used to log in or manage anything — build your own promotion site against it, or point a bundled
        one at it once that's available.
      </p>

      {loading ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${status?.enabled ? 'bg-emerald-500' : 'bg-slate-600'}`} />
            <span className="text-sm font-medium">{status?.enabled ? 'Enabled' : 'Disabled'}</span>
          </div>

          {status?.enabled && status?.token && (
            <div className="space-y-2">
              <div>
                <p className="text-[11px] text-slate-500 mb-1">Endpoint</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 truncate rounded bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-slate-300">{apiURL}</code>
                </div>
              </div>
              <div>
                <p className="text-[11px] text-slate-500 mb-1">Bearer token — treat like a password; anyone with it can read the servers you exported</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 truncate rounded bg-slate-950 border border-slate-800 px-2 py-1.5 text-xs text-slate-300">{status.token}</code>
                  <button onClick={copy} className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs shrink-0">
                    {copied ? '✓ Copied' : 'Copy'}
                  </button>
                </div>
              </div>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <button
              onClick={enableOrRotate}
              disabled={busy}
              className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
            >
              {busy ? 'Working…' : status?.enabled ? 'Rotate token' : 'Enable'}
            </button>
            {status?.enabled && !confirmRevoke && (
              <button
                onClick={() => setConfirmRevoke(true)}
                disabled={busy}
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/60 border border-slate-700 text-rose-300 text-sm disabled:opacity-50"
              >
                Revoke
              </button>
            )}
            {confirmRevoke && (
              <>
                <span className="text-xs text-rose-300">Immediately invalidates the token above — any site using it stops working. Sure?</span>
                <button onClick={revoke} disabled={busy} className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-sm font-medium disabled:opacity-50">
                  Revoke
                </button>
                <button onClick={() => setConfirmRevoke(false)} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm">
                  Cancel
                </button>
              </>
            )}
          </div>
          {status?.enabled && (
            <p className="text-[11px] text-slate-500">
              Rotating replaces the token immediately — the old one stops working. Losing the token isn't fatal:
              come back to this page any time to see it again.
            </p>
          )}
          {err && <p className="text-sm text-rose-300">{err}</p>}
        </div>
      )}

      <h3 className="text-lg font-semibold mt-8 mb-1">Bundled promotion site</h3>
      <p className="text-sm text-slate-400 mb-4">
        Don't want to build your own frontend? Deploy a small ready-made page (<code className="text-slate-300">promosite/</code>) that
        reads this Stats API and lists the servers you exported. Independent of the Stats API toggle above — deploying it needs a token
        to exist, but disabling this doesn't touch the Stats API itself.
      </p>
      {status?.enabled ? (
        <div className="rounded-lg border border-slate-800 bg-slate-900/40 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${promo?.deployed ? (promo.ready ? 'bg-emerald-500' : 'bg-amber-500') : 'bg-slate-600'}`} />
            <span className="text-sm font-medium">
              {promo?.deployed ? (promo.ready ? 'Deployed' : 'Deploying…') : 'Not deployed'}
            </span>
            {promo?.image && <span className="text-xs text-slate-500 font-mono">{promo.image}</span>}
          </div>

          {!promo?.deployed && (
            <div className="flex flex-wrap gap-2">
              <input
                className="form-input rounded bg-slate-800 border-slate-700 text-slate-100 text-xs py-1.5 w-48"
                placeholder="site title" value={promoTitle} onChange={e => setPromoTitle(e.target.value)}
              />
              <input
                className="form-input rounded bg-slate-800 border-slate-700 text-slate-100 text-xs py-1.5 w-28"
                placeholder="accent color" value={promoAccent} onChange={e => setPromoAccent(e.target.value)}
              />
            </div>
          )}

          <div className="flex items-center gap-2">
            {!promo?.deployed ? (
              <button onClick={deployPromo} disabled={promoBusy}
                className="px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50">
                {promoBusy ? 'Deploying…' : 'Deploy'}
              </button>
            ) : (
              <button onClick={removePromo} disabled={promoBusy}
                className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/60 border border-slate-700 text-rose-300 text-sm disabled:opacity-50">
                {promoBusy ? 'Removing…' : 'Remove'}
              </button>
            )}
          </div>
          {promo?.deployed && (
            <p className="text-[11px] text-slate-500">
              Runs as a ClusterIP Service named <code className="text-slate-400">gamectl-promosite</code> in this namespace, port 80 —
              publish it through ProxyCTL's Web Routes exactly like any other web app to put it on the internet.
            </p>
          )}
          {promoErr && <p className="text-sm text-rose-300">{promoErr}</p>}
        </div>
      ) : (
        <p className="text-sm text-slate-500 italic">Enable the Stats API above first.</p>
      )}
    </div>
  )
}
