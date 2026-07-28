import { useEffect, useState } from 'react'
import { api } from '../api/client'
import Sparkline from '../components/Sparkline'
import HeartbeatStrip from '../components/HeartbeatStrip'
import MetricsServerNotice from '../components/MetricsServerNotice'

const DURATIONS = [
  { label: '1h', hours: 1 },
  { label: '6h', hours: 6 },
  { label: '12h', hours: 12 },
  { label: '1d', hours: 24 },
  { label: '3d', hours: 72 },
  { label: '7d', hours: 168 },
]
const fmtMS = (v) => `${Math.round(v)}ms`
const fmtCPU = (v) => v >= 1000 ? (v / 1000).toFixed(2) + ' cores' : Math.round(v) + 'm'
const fmtMem = (v) => v >= 1 << 30 ? (v / (1 << 30)).toFixed(2) + ' GiB' : Math.round(v / (1 << 20)) + ' MiB'
const fmtPlayers = (v) => `${Math.round(v)} player${Math.round(v) === 1 ? '' : 's'}`

// InstanceDetailPanel — the expanded view for a row in "Currently
// monitored": the game-side metrics ProxyCTL can't see. Heartbeat strips
// for in-cluster and (when the game has a MetalLB IP) external
// reachability, then latency / players / CPU / RAM trends, all over the
// page's shared duration toggle. This is the fleet-wide deep view; the hub
// cards keep their tiny 1h glance and the manage screen keeps its
// per-instance panels.
function InstanceDetailPanel({ namespace, name, hours }) {
  const [probe, setProbe] = useState(null)
  const [metrics, setMetrics] = useState(null)

  useEffect(() => {
    let stop = false
    const load = () => {
      api.get(`/games/instances/${namespace}/${name}/probehistory`).then(r => { if (!stop) setProbe(r.data) }).catch(() => {})
      api.get(`/games/instances/${namespace}/${name}/metrics`).then(r => { if (!stop) setMetrics(r.data) }).catch(() => {})
    }
    load()
    const t = setInterval(load, 30000)
    return () => { stop = true; clearInterval(t) }
  }, [namespace, name])

  const cutoff = Date.now() / 1000 - hours * 3600
  const probeHist = (probe?.history || []).filter(s => s.t >= cutoff)
  const lbHist = probeHist.filter(s => s.lbReachable !== null && s.lbReachable !== undefined)
  const latencyHist = probeHist.filter(s => s.reachable && s.latencyMs > 0)
  const playersHist = probeHist.filter(s => s.reachable && s.maxPlayers > 0)
  const m = metrics?.available ? metrics.metrics : null
  const resHist = (m?.history || []).filter(s => s.t >= cutoff)

  if (!probe?.available && !m) {
    return <p className="text-[11px] text-slate-600">collecting samples… (30s interval)</p>
  }

  const graphGrid = 'grid sm:grid-cols-2 gap-x-6 gap-y-4'
  const label = (text) => <p className="text-[11px] text-slate-500 mb-1">{text}</p>

  return (
    <div className="space-y-4">
      <div className={graphGrid}>
        <div>
          {label('In-cluster')}
          <HeartbeatStrip samples={probeHist.map(s => ({ t: s.t, up: s.reachable }))} hours={hours} />
        </div>
        {lbHist.length > 0 && (
          <div>
            {label('LAN (MetalLB IP)')}
            <HeartbeatStrip samples={lbHist.map(s => ({ t: s.t, up: !!s.lbReachable }))} hours={hours} />
          </div>
        )}
      </div>

      <div className={graphGrid}>
        {latencyHist.length >= 2 && (
          <div>
            {label('Latency')}
            <Sparkline history={latencyHist.map(s => ({ t: s.t, latencyMs: s.latencyMs }))} field="latencyMs" format={fmtMS} color="#38bdf8" height={56} />
          </div>
        )}
        {playersHist.length >= 2 && (
          <div>
            {label(`Players (of ${playersHist[playersHist.length - 1].maxPlayers} max)`)}
            <Sparkline history={playersHist.map(s => ({ t: s.t, players: s.players || 0 }))} field="players"
              limit={playersHist[playersHist.length - 1].maxPlayers} format={fmtPlayers} color="#fbbf24" height={56} />
          </div>
        )}
        {resHist.length >= 2 && (
          <>
            <div>
              {label(m.cpuLimitMilli > 0 ? `CPU (limit ${fmtCPU(m.cpuLimitMilli)})` : 'CPU')}
              <Sparkline history={resHist} field="cpuMilli" limit={m.cpuLimitMilli} format={fmtCPU} color="#a78bfa" height={56} />
            </div>
            <div>
              {label(m.memLimitBytes > 0 ? `RAM (limit ${fmtMem(m.memLimitBytes)})` : 'RAM')}
              <Sparkline history={resHist} field="memBytes" limit={m.memLimitBytes} format={fmtMem} color="#f472b6" height={56} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// Monitoring settings: what's currently being watched (the background
// probe sampler's latest sample per instance — same data the manage
// screen's ReachabilityPanel charts, just the whole fleet at a glance), the
// Discord webhook that fires when something changes reachability, and the
// toggle for whether hub cards show their own mini graphs. Each row here
// expands into a larger graph than the manage screen's compact panel, with
// a single duration toggle that applies to every expanded row.
export default function MonitoringSettings() {
  const [summary, setSummary] = useState(null)
  const [summaryErr, setSummaryErr] = useState('')
  const [expanded, setExpanded] = useState(() => new Set())
  const [hours, setHours] = useState(1)

  useEffect(() => {
    let stop = false
    const load = () => api.get('/monitoring/summary')
      .then(({ data }) => { if (!stop) setSummary(data.instances || []) })
      .catch(e => { if (!stop) setSummaryErr(e.response?.data?.detail || e.message) })
    load()
    const t = setInterval(load, 15000)
    return () => { stop = true; clearInterval(t) }
  }, [])

  const [cfg, setCfg] = useState(null)
  const [url, setUrl] = useState('')
  const [enabled, setEnabled] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [showCardGraphs, setShowCardGraphs] = useState(false)
  const [cardGraphsSaving, setCardGraphsSaving] = useState(false)
  const [retentionDays, setRetentionDays] = useState(30)

  useEffect(() => {
    api.get('/alerts/config').then(({ data }) => {
      setCfg(data)
      setUrl(data.discordWebhookUrl || '')
      setEnabled(!!data.enabled)
      setShowCardGraphs(!!data.showCardGraphs)
      setRetentionDays(data.retentionDays > 0 ? data.retentionDays : 30)
    }).catch(() => {})
  }, [])

  const save = async () => {
    setSaving(true); setMsg(''); setErr('')
    const body = { discordWebhookUrl: url.trim(), enabled, showCardGraphs, retentionDays: Math.max(1, Number(retentionDays) || 30) }
    try {
      await api.put('/alerts/config', body)
      setMsg('Saved.')
      setCfg(body)
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setSaving(false)
    }
  }

  // Saves immediately (not bundled with the webhook form's Save button) —
  // it's a display preference, not something you're drafting.
  const toggleCardGraphs = async (next) => {
    setShowCardGraphs(next)
    setCardGraphsSaving(true)
    try {
      await api.put('/alerts/config', {
        discordWebhookUrl: (cfg?.discordWebhookUrl || ''), enabled: !!cfg?.enabled,
        showCardGraphs: next, retentionDays: cfg?.retentionDays > 0 ? cfg.retentionDays : 30,
      })
      setCfg(c => ({ ...c, showCardGraphs: next }))
    } catch {
      setShowCardGraphs(!next) // revert on failure
    } finally {
      setCardGraphsSaving(false)
    }
  }

  const test = async () => {
    setTesting(true); setMsg(''); setErr('')
    try {
      await api.post('/alerts/test')
      setMsg('Test message sent — check your Discord channel.')
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setTesting(false)
    }
  }

  const cfgRetention = cfg?.retentionDays > 0 ? cfg.retentionDays : 30
  const dirty = cfg && (url.trim() !== (cfg.discordWebhookUrl || '') || enabled !== !!cfg.enabled || Number(retentionDays) !== cfgRetention)

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div>
        <h2 className="text-xl font-semibold mb-1">Monitoring</h2>
        <p className="text-sm text-slate-400">
          What GameCTL's background sampler is currently watching, and where it sends alerts
          when a game's reachability changes.
        </p>
      </div>

      {/* Only renders when the cluster genuinely can't serve metrics. */}
      <MetricsServerNotice />

      {/* What's being monitored */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center gap-3 mb-1">
          <h3 className="text-sm font-semibold text-slate-200">Currently monitored</h3>
          <div className="ml-auto flex gap-1">
            {DURATIONS.map(d => (
              <button key={d.hours} onClick={() => setHours(d.hours)}
                className={`px-2 py-1 rounded text-xs ${hours === d.hours ? 'bg-sky-700 text-white' : 'bg-slate-800 text-slate-400 hover:bg-slate-700'}`}>
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <p className="text-xs text-slate-500 mb-3">Click a row to expand its graph.</p>
        {summaryErr && <p className="text-sm text-rose-400">{summaryErr}</p>}
        {!summary && !summaryErr && <p className="text-sm text-slate-500">Loading…</p>}
        {summary && summary.length === 0 && (
          <p className="text-sm text-slate-500">
            No samples yet — the background sampler runs every 30s once a game is deployed and ready.
          </p>
        )}
        {summary && summary.length > 0 && (
          <ul className="divide-y divide-slate-800">
            {summary.map(s => {
              const key = `${s.namespace}/${s.name}`
              const isOpen = expanded.has(key)
              const toggle = () => setExpanded(prev => {
                const next = new Set(prev)
                next.has(key) ? next.delete(key) : next.add(key)
                return next
              })
              return (
                <li key={key}>
                  <div onClick={toggle} className="py-2 flex items-center gap-3 text-sm cursor-pointer">
                    <span className="text-slate-600 text-[10px] w-2.5">{isOpen ? '▼' : '▶'}</span>
                    <span className={`h-2 w-2 rounded-full shrink-0 ${s.reachable ? 'bg-emerald-400' : 'bg-rose-400'}`} />
                    <span className="font-medium text-slate-200 flex-1 min-w-0 truncate">{s.name}</span>
                    <span className="text-slate-500 text-xs">
                      {s.reachable ? `online${s.latencyMs ? ` · ${s.latencyMs}ms` : ''}` : 'unreachable'}
                      {s.map ? ` · ${s.map}` : ''}
                    </span>
                    {s.lbReachable !== undefined && s.lbReachable !== null && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${s.lbReachable ? 'bg-emerald-900/60 text-emerald-300' : 'bg-rose-900/60 text-rose-300'}`}>
                        LB {s.lbReachable ? 'up' : 'down'}
                      </span>
                    )}
                  </div>
                  {isOpen && (
                    <div className="pb-4 pl-5">
                      <InstanceDetailPanel namespace={s.namespace} name={s.name} hours={hours} />
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Display & data settings */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input type="checkbox" checked={showCardGraphs} disabled={cardGraphsSaving}
            onChange={e => toggleCardGraphs(e.target.checked)}
            className="form-checkbox rounded border-slate-700 bg-slate-800 text-emerald-500" />
          <span>
            <span className="text-sm font-semibold text-slate-200">Show mini graphs on dashboard cards</span>
            <p className="text-xs text-slate-500 mt-0.5">
              Adds a small uptime + resource-usage strip to every game card on the main dashboard —
              a per-server overview at a glance, not just in each game's Details panel. Off by
              default since it's a bigger visual footprint.
            </p>
          </span>
        </label>
        <div className="flex items-center gap-3">
          <input
            type="number" min="1" max="365"
            value={retentionDays}
            onChange={e => setRetentionDays(e.target.value)}
            className="w-20 form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100 text-sm"
          />
          <span>
            <span className="text-sm font-semibold text-slate-200">Data retention (days)</span>
            <p className="text-xs text-slate-500 mt-0.5">
              How long monitoring history is kept. Recent 24h stays at full 30s resolution;
              older samples compact to 5-minute resolution (outages are never averaged away).
              History is snapshotted every ~5 minutes so it survives restarts. Saved with the
              Save button below.
            </p>
          </span>
        </div>
      </div>

      {/* Discord webhook */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-200">Discord alerts</h3>
        <p className="text-xs text-slate-500">
          Fires a message whenever a monitored game's reachability changes — in-cluster (is the
          process alive) and, for games on a dedicated LoadBalancer IP, external too. Only
          transitions notify, not every sample, so this won't spam you.
        </p>

        <div className="space-y-2">
          <label className="block text-xs text-slate-400">Webhook URL</label>
          <input
            className="w-full form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100 text-sm font-mono"
            placeholder="https://discord.com/api/webhooks/…"
            value={url}
            onChange={e => setUrl(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
            className="form-checkbox rounded border-slate-700 bg-slate-800 text-emerald-500" />
          Enabled
        </label>

        <div className="flex items-center gap-2">
          <button
            onClick={save}
            disabled={saving || !dirty}
            className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={test}
            disabled={testing || !cfg?.discordWebhookUrl}
            title={!cfg?.discordWebhookUrl ? 'Save a webhook URL first' : 'Send a test message'}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm disabled:opacity-50"
          >
            {testing ? 'Sending…' : 'Send test message'}
          </button>
        </div>
        {msg && <p className="text-sm text-emerald-400">{msg}</p>}
        {err && <p className="text-sm text-rose-400">{err}</p>}

        <details className="text-xs text-slate-500">
          <summary className="cursor-pointer text-slate-400 hover:text-slate-300">
            How do I get a Discord webhook URL?
          </summary>
          <ol className="mt-2 space-y-1 list-decimal list-inside">
            <li>In Discord, open the server you want alerts in.</li>
            <li>Server Settings → Integrations → Webhooks.</li>
            <li>New Webhook — name it and pick the channel.</li>
            <li>Copy Webhook URL, paste it above, then Save.</li>
          </ol>
        </details>
      </div>

      {/* Always present, working or not — so the install command is
          findable when someone goes looking, not only when GameCTL has
          already decided something is wrong. */}
      <MetricsServerNotice variant="reference" />
    </div>
  )
}
