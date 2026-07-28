import { useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../api/client'
import ImageWithFallback from '../components/ImageWithFallback'
import Sparkline from '../components/Sparkline'
import HeartbeatStrip from '../components/HeartbeatStrip'
import MetricsServerNotice from '../components/MetricsServerNotice'
import RestartStrategyNotice from '../components/RestartStrategyNotice'
import QuantityStepper from '../components/QuantityStepper'
import { copyText } from '../utils/clipboard'
import { parseCPUMillis, formatCPUMillis, humanCPU, parseMemMiB, formatMemMiB, humanMem } from '../utils/quantity'
import { joinPath } from '../utils/paths'
import { CS2_RTV_CATALOG } from '../utils/cs2RtvCatalog'
import { IW4X_MAPS, IW4X_GAMETYPES } from '../utils/iw4xGenerator'

// Map the backend's color hint → tailwind color stack.
const COLOR_STYLES = {
  grey:   { pill: 'bg-slate-800 text-slate-300 border-slate-700',  dot: 'bg-slate-500' },
  blue:   { pill: 'bg-sky-950 text-sky-300 border-sky-900',         dot: 'bg-sky-400 animate-pulse' },
  orange: { pill: 'bg-orange-950 text-orange-300 border-orange-900',dot: 'bg-orange-400 animate-pulse' },
  green:  { pill: 'bg-emerald-950 text-emerald-300 border-emerald-900', dot: 'bg-emerald-400' },
  red:    { pill: 'bg-rose-950 text-rose-300 border-rose-900',     dot: 'bg-rose-400' },
}

function StatusPill({ status }) {
  if (!status) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border bg-slate-800 text-slate-400 border-slate-700">
        <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
        Loading…
      </span>
    )
  }
  const c = COLOR_STYLES[status.color] || COLOR_STYLES.grey
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border ${c.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {status.label}
      {status.labelDetail && (
        <span className="text-[10px] opacity-75 font-normal ml-1">· {status.labelDetail}</span>
      )}
    </span>
  )
}

// GameHealthLine renders a per-game deep-status summary under the main pill.
// Backend supplies a generic Health object; what fields exist depend on the
// game's probe (Minecraft has version/MOTD/players, Source has MOTD/map, etc.)
function GameHealthLine({ health }) {
  if (!health) return null
  if (!health.reachable) {
    return (
      <span className="text-xs text-orange-400/90 italic" title={health.error || ''}>
        game protocol: not responding
      </span>
    )
  }
  const bits = []
  if (health.motd) bits.push(health.motd)
  if (health.version) bits.push(health.version)
  if (health.maxPlayers != null) bits.push(`${health.players ?? 0}/${health.maxPlayers} players`)
  if (health.latencyMs != null) bits.push(`${health.latencyMs}ms`)
  if (bits.length === 0) return null
  return (
    <span className="text-xs text-slate-400 truncate" title={bits.join(' · ')}>
      {bits.join(' · ')}
    </span>
  )
}

function CopyableAddress({ address }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const copy = async () => {
    if (!address) return
    setFailed(false)
    const ok = await copyText(address)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      setFailed(true)
      setTimeout(() => setFailed(false), 2500)
    }
  }
  if (!address) return null
  // Color-swap the whole button on copy so the feedback is obvious even
  // at a glance. The label flips to "✓ Copied!" inside the chip — readers
  // looking at the IP at the same time still see the address.
  const stateClass = copied
    ? 'bg-emerald-900/60 border-emerald-700 text-emerald-200'
    : failed
      ? 'bg-rose-950/60 border-rose-800 text-rose-200'
      : 'bg-slate-800/60 hover:bg-slate-800 border-slate-700 text-slate-300'
  return (
    <button
      onClick={copy}
      title={failed ? 'Copy failed — try selecting the text manually' : 'Copy address'}
      className={`inline-flex items-center gap-1.5 text-xs font-mono border rounded px-2 py-1 transition-colors ${stateClass}`}
    >
      <span>{address}</span>
      <span className="text-[10px] font-sans">
        {copied ? '✓ Copied!' : failed ? '✗ copy failed' : '⧉'}
      </span>
    </button>
  )
}

function PodRow({ pod }) {
  return (
    <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 text-xs py-1.5 border-t border-slate-800">
      <span className="text-slate-300 font-mono truncate" title={pod.name}>{pod.name}</span>
      <span className={`rounded px-1.5 py-0.5 ${pod.ready ? 'bg-emerald-900/50 text-emerald-300' : 'bg-orange-900/50 text-orange-300'}`}>
        {pod.ready ? 'Ready' : (pod.waitReason || pod.phase || 'Not ready')}
      </span>
      {pod.restartCount > 0 && (
        <span className="rounded px-1.5 py-0.5 bg-yellow-900/40 text-yellow-300" title={pod.lastTerminationReason || ''}>
          {pod.restartCount} restart{pod.restartCount === 1 ? '' : 's'}
        </span>
      )}
      <span className="text-slate-500 truncate">{pod.node}</span>
    </div>
  )
}

// CredentialRow — one masked secret with reveal + copy. The value is already
// plain text in the Deployment spec (no Secret), so this just surfaces what
// the operator set at deploy time without digging through kubectl.
function CredentialRow({ name, value }) {
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  const copy = async () => {
    setFailed(false)
    const ok = await copyText(value)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } else {
      setFailed(true)
      setTimeout(() => setFailed(false), 2500)
    }
  }
  return (
    <div className="grid grid-cols-[minmax(0,11rem)_1fr_auto_auto] items-center gap-2 text-xs py-1.5 border-t border-slate-800 first:border-t-0">
      <span className="text-slate-400 font-mono truncate" title={name}>{name}</span>
      <span className="font-mono text-slate-200 truncate">
        {shown ? value : '•'.repeat(Math.min(value.length, 16))}
      </span>
      <button onClick={() => setShown(s => !s)} title={shown ? 'Hide' : 'Reveal'} className="text-slate-400 hover:text-slate-100 px-1.5">
        {shown ? (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path d="M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
            <path fillRule="evenodd" d="M.664 10.59a1.651 1.651 0 0 1 0-1.186A10.004 10.004 0 0 1 10 3c4.257 0 7.893 2.66 9.336 6.41.147.381.146.804 0 1.186A10.004 10.004 0 0 1 10 17c-4.257 0-7.893-2.66-9.336-6.41ZM14 10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z" clipRule="evenodd" />
          </svg>
        ) : (
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="w-3.5 h-3.5">
            <path fillRule="evenodd" d="M3.28 2.22a.75.75 0 0 0-1.06 1.06l14.5 14.5a.75.75 0 1 0 1.06-1.06l-1.745-1.745a10.029 10.029 0 0 0 3.3-4.38 1.651 1.651 0 0 0 0-1.185A10.004 10.004 0 0 0 9.999 3a9.956 9.956 0 0 0-4.744 1.194L3.28 2.22ZM7.752 6.69l1.092 1.092a2.5 2.5 0 0 1 3.374 3.373l1.091 1.092a4 4 0 0 0-5.557-5.557Z" clipRule="evenodd" />
            <path d="m10.748 13.93 2.523 2.523a9.987 9.987 0 0 1-3.27.547c-4.258 0-7.894-2.66-9.337-6.41a1.651 1.651 0 0 1 0-1.186A10.007 10.007 0 0 1 2.839 6.02L6.07 9.252a4 4 0 0 0 4.678 4.678Z" />
          </svg>
        )}
      </button>
      <button
        onClick={copy}
        title={failed ? 'Copy failed — try selecting manually' : 'Copy'}
        className={`px-1.5 transition-colors ${
          copied ? 'text-emerald-400'
            : failed ? 'text-rose-400'
            : 'text-slate-400 hover:text-slate-100'
        }`}
      >
        {copied ? '✓ Copied!' : failed ? '✗ failed' : '⧉'}
      </button>
    </div>
  )
}

// SettingsPanel — per-instance "auto-update on next start" toggle plus the
// credential list. Reads GET /settings (env on the live Deployment).
function SettingsPanel({ namespace, name }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.get(`/games/instances/${namespace}/${name}/settings`)
      .then(r => { setData(r.data); setErr('') })
      .catch(e => setErr(e.response?.data?.detail || e.message))
  }, [namespace, name])

  useEffect(() => { load() }, [load])

  const toggleAutoUpdate = async (next) => {
    setBusy(true)
    setErr('')
    try {
      await api.patch(`/games/instances/${namespace}/${name}/autoupdate`, { enabled: next })
      // Records the choice WITHOUT restarting; it stays pending until the
      // operator hits Restart. Reload to pick up the real pending state.
      setData(d => ({ ...d, autoUpdate: { ...d.autoUpdate, enabled: next, pending: true } }))
      setTimeout(load, 800)
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }

  const [advBusy, setAdvBusy] = useState(false)
  const [advErr, setAdvErr] = useState('')
  const [advName, setAdvName] = useState('')
  const [advSlug, setAdvSlug] = useState('')
  useEffect(() => {
    setAdvName(data?.advertiseName || '')
    setAdvSlug(data?.advertiseSlug || '')
  }, [data?.advertiseName, data?.advertiseSlug])

  const setAdvertise = async (next) => {
    setAdvBusy(true)
    setAdvErr('')
    try {
      await api.patch(`/games/instances/${namespace}/${name}/advertise`, {
        enabled: next, displayName: advName, slug: advSlug,
      })
      setData(d => ({ ...d, advertise: next }))
    } catch (e) {
      setAdvErr(e.response?.data?.detail || e.message)
    } finally {
      setAdvBusy(false)
    }
  }

  if (err && !data) {
    return <p className="text-xs text-rose-400 mt-3">Settings: {err}</p>
  }
  if (!data) return null

  const au = data.autoUpdate
  const creds = data.credentials || []

  return (
    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-3">
      <p className="text-xs font-medium text-slate-400">Settings &amp; access</p>

      {/* In-game browser name — for games joined by searching the server
          list (Wreckfest 2, Valheim, …) this is the join handle, so it gets
          the same copy affordance as an address. */}
      {data.serverName && (
        <div>
          <p className="text-[11px] text-slate-500 mb-1">Server browser name — search for this in-game</p>
          <CopyableAddress address={data.serverName} />
        </div>
      )}

      {/* Updates — always present so every game answers "how do I update?".
          Live toggle where the image supports it; otherwise the honest
          image-tag story. */}
      <div>
        <p className="text-[11px] text-slate-500 mb-1">Updates</p>
        {au?.supported ? (
          <div className="flex items-start gap-3">
            <button
              role="switch"
              aria-checked={au.enabled}
              disabled={busy}
              onClick={() => toggleAutoUpdate(!au.enabled)}
              className={`mt-0.5 h-5 w-9 shrink-0 rounded-full transition relative disabled:opacity-50 ${au.enabled ? 'bg-emerald-600' : 'bg-slate-700'}`}
            >
              <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${au.enabled ? 'left-[1.125rem]' : 'left-0.5'}`} />
            </button>
            <div className="text-xs">
              <p className="text-slate-200 font-medium">
                Auto-update on next start
                {au.pending && (
                  <span className="ml-2 px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-300 text-[10px] align-middle">
                    pending — restart to apply
                  </span>
                )}
              </p>
              <p className="text-slate-500 mt-0.5">
                {au.enabled
                  ? 'SteamCMD will validate/update the game files each time the server starts.'
                  : 'Reuses the persisted install — faster starts, no re-download.'}
                {' '}Saved without interrupting the running server; it takes effect the next time you Restart.
                <span className="text-slate-600"> ({au.envVar})</span>
              </p>
            </div>
          </div>
        ) : (
          <div className="text-xs text-slate-500">
            <p>This image is versioned by its tag — there's no in-place update.
            To update or roll back, redeploy with a different image tag.</p>
            {data.image && (
              <p className="mt-1 font-mono text-slate-400 break-all">current: {data.image}</p>
            )}
          </div>
        )}
      </div>

      {/* GameCTL Stats API — opt this instance into the public
          GET /api/stats/servers listing (see docs/STATS_API.md). Off by
          default; flipping it never restarts the server (annotation-only,
          same as auto-update above). Independent of whether the Stats API
          itself has been enabled instance-wide — an operator can pre-set
          this before ever issuing a token. */}
      <div>
        <p className="text-[11px] text-slate-500 mb-1">GameCTL Stats API</p>
        <div className="flex items-start gap-3">
          <button
            role="switch"
            aria-checked={!!data.advertise}
            disabled={advBusy}
            onClick={() => setAdvertise(!data.advertise)}
            className={`mt-0.5 h-5 w-9 shrink-0 rounded-full transition relative disabled:opacity-50 ${data.advertise ? 'bg-emerald-600' : 'bg-slate-700'}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${data.advertise ? 'left-[1.125rem]' : 'left-0.5'}`} />
          </button>
          <div className="text-xs flex-1 min-w-0">
            <p className="text-slate-200 font-medium">Advertise publicly</p>
            <p className="text-slate-500 mt-0.5">
              Include this server's live status and player count in the Stats
              API's public response, for a promotion site to show.
            </p>
            {data.advertise && (
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  className="form-input rounded bg-slate-800 border-slate-700 text-slate-100 text-xs py-1.5 w-40"
                  placeholder="display name (optional)"
                  value={advName}
                  onChange={e => setAdvName(e.target.value)}
                  onBlur={() => setAdvertise(true)}
                />
                <input
                  className="form-input rounded bg-slate-800 border-slate-700 text-slate-100 text-xs py-1.5 w-32"
                  placeholder={`slug (default: ${data.game || 'game'})`}
                  value={advSlug}
                  onChange={e => setAdvSlug(e.target.value.trim().toLowerCase())}
                  onBlur={() => setAdvertise(true)}
                />
              </div>
            )}
            {advErr && <p className="text-rose-400 mt-1">{advErr}</p>}
          </div>
        </div>
      </div>

      {data.wf2 && <WF2LivePanel namespace={namespace} name={name} wf2={data.wf2} onApplied={load} />}
      {data.cs2 && <CS2LivePanel namespace={namespace} name={name} cs2={data.cs2} onApplied={load} />}
      {data.cs2 && <CS2WorkshopPanel namespace={namespace} name={name} />}
      {data.cs2 && <CS2SurfRecordsPanel namespace={namespace} name={name} />}
      {data.cs2 && <CS2PlayersPanel namespace={namespace} name={name} />}

      {data.game === 'iw4x' && data.rconAvailable && (
        <IW4XLivePanel namespace={namespace} name={name} />
      )}

      {data.game === 'minecraft' && data.rconAvailable && (
        <MinecraftLivePanel namespace={namespace} name={name} onApplied={load} />
      )}

      {data.rconAvailable && <RconConsole namespace={namespace} name={name} game={data.game || ''} />}

      {creds.length > 0 && (
        <div>
          <p className="text-[11px] text-slate-500 mb-1">Credentials (set at deploy time)</p>
          <div className="rounded border border-slate-800">
            {creds.map(c => <CredentialRow key={c.name} name={c.name} value={c.value} />)}
          </div>
        </div>
      )}
      {err && <p className="text-xs text-rose-400">{err}</p>}
    </div>
  )
}

// ExternalUptimeBadge — the one place GameCTL shows ProxyCTL's own
// external-reachability number. GameCTL never computes this itself (that
// would duplicate ProxyCTL's check against the same address); this just
// reads what ProxyCTL already collected, over the existing admin link.
// Renders nothing until ProxyCTL has at least a couple of samples.
function ExternalUptimeBadge({ kind, id }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let stop = false
    const load = () => api.get(`/proxyctl/${kind}/${id}/uptime`)
      .then(r => { if (!stop) setData(r.data) })
      .catch(() => {})
    load()
    const t = setInterval(load, 60000)
    return () => { stop = true; clearInterval(t) }
  }, [kind, id])

  const history = data?.history || []
  if (!data?.available || history.length < 2) return null
  const pct = Math.round(100 * history.filter(s => s.reachable).length / history.length)
  const cls = pct === 100 ? 'text-emerald-400' : pct >= 95 ? 'text-amber-400' : 'text-rose-400'
  return (
    <span className={`text-[10px] ${cls}`} title="External reachability over the last ~1h, checked by ProxyCTL — DNS/tunnel/edge, not this game's own process">
      external: {pct}%
    </span>
  )
}

// PublishTarget — one bindable address of an instance in the Networking
// panel. Most games have exactly one (the game Service); Minecraft+BlueMap
// and CS2+surf-records have two, so each target renders its own compact
// publish form / published row, tagged with a role chip when there's more
// than one. All calls carry `service` so the backend binds the right one.
function PublishTarget({ namespace, name, target, domains, droplet, cfReady, onChanged, multi }) {
  const [host, setHost] = useState(target.entryName || name)
  const [domain, setDomain] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmUnpub, setConfirmUnpub] = useState(false)
  const [removeDNS, setRemoveDNS] = useState(true)

  useEffect(() => {
    if (domains?.length) setDomain(d => d || domains[0])
  }, [domains])

  const errOf = (e) => e.response?.data?.error || e.response?.data?.detail || e.message
  const run = async (fn) => {
    setBusy(true); setNotice(''); setErr('')
    try { await fn() } catch (e) { setErr(errOf(e)) } finally { setBusy(false) }
  }

  const publish = (body) => run(async () => {
    const { data } = await api.post(`/games/instances/${namespace}/${name}/publish`, { service: target.service, ...body })
    if (data.applyError) setErr(`Saved in ProxyCTL, but apply failed: ${data.applyError}`)
    else setNotice(data.applyNote || 'Published — ProxyCTL is applying (tunnel + DNS)…')
    await onChanged()
  })

  const unpublish = () => run(async () => {
    const dnsQ = isWeb ? '' : `&dns=${removeDNS ? 1 : 0}`
    const { data } = await api.delete(`/games/instances/${namespace}/${name}/publish?service=${encodeURIComponent(target.service)}${dnsQ}`)
    setConfirmUnpub(false)
    if (data.applyError) setErr(`Entry removed, but apply failed: ${data.applyError}`)
    else setNotice(`Unpublished.${data.dns ? ` ${data.dns}.` : ''}`)
    await onChanged()
  })

  // Show a remap explicitly: after a public-port collision ProxyCTL publishes
  // on a free number that still delivers to the original, and "27016→27015"
  // is the only thing that explains why the address doesn't match the port
  // the server is configured with.
  const portLabel = (p) =>
    `${p.port}/${p.proto}` + (p.targetPort && p.targetPort !== p.port ? `→${p.targetPort}` : '')
  // Web targets (BlueMap, surf-records) bind a ProxyCTL WebRoute —
  // Cloudflare Tunnel, TLS at the edge — instead of an L4 droplet entry.
  const isWeb = target.kind === 'web'
  const entry = target.entry
  const bound = isWeb ? target.webRoute : target.entry
  // L4 entries show host:port, not a bare hostname. A game on a non-default
  // port (or one ProxyCTL remapped because the number it wanted was taken)
  // is unreachable at the address alone — Source clients silently assume
  // 27015 — and the operator has no way to know that from the panel. Use the
  // PUBLIC port: after a remap it differs from what the server listens on,
  // and the public side is the half players type.
  const l4Port = bound?.ports?.[0]?.port
  const publicAddr = isWeb
    ? (bound?.hostname ? `https://${bound.hostname}` : '')
    : (bound?.subdomain ? (l4Port ? `${bound.subdomain}:${l4Port}` : bound.subdomain) : '')
  // Anything beyond the first, so a multi-port game still shows them all.
  const extraPorts = isWeb ? [] : (bound?.ports || []).slice(1)
  const roleChip = multi && (
    <span className="px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] uppercase tracking-wider text-slate-400 shrink-0">
      {target.role}{isWeb ? ' · web' : ''}
    </span>
  )

  return (
    <div className="space-y-1.5">
      {!bound ? (
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            {roleChip}
            <input className="form-input rounded bg-slate-800 border-slate-700 text-slate-100 text-xs py-1.5 w-36" placeholder="subdomain"
              value={host} onChange={e => setHost(e.target.value.trim().toLowerCase())} />
            <span className="text-slate-500">.</span>
            {domains?.length ? (
              <select className="form-input rounded bg-slate-800 border-slate-700 text-slate-100 text-xs py-1.5"
                value={domain} onChange={e => setDomain(e.target.value)}>
                {domains.map(d => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : (
              <span className="text-amber-400">no domains declared in ProxyCTL yet</span>
            )}
            <button disabled={busy || !host || !domain || !target.ports?.length || (isWeb && cfReady === false)}
              onClick={() => publish({ subdomain: `${host}.${domain}` })}
              className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-medium disabled:opacity-50">
              {busy ? 'Publishing…' : 'Publish'}
            </button>
          </div>
          {isWeb ? (
            <p className="text-slate-500">
              Cloudflare Tunnel — TLS at the edge → http://{target.clusterIP || '?'}:{target.ports?.[0]?.port || '?'}
              {cfReady === false && (
                <span className="text-amber-400"> — ProxyCTL needs a Cloudflare API token first (ProxyCTL → Setup → Cloudflare)</span>
              )}
            </p>
          ) : (
            <p className="text-slate-500">
              Ports {target.ports?.length ? target.ports.map(portLabel).join(', ') : '(none publishable on this Service)'}
              {' '}→ tunnel → {target.clusterIP || '?'}
              {droplet && !droplet.configured && (
                <span className="text-amber-400"> — ProxyCTL droplet not set up yet; finish its Setup wizard first</span>
              )}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            {roleChip}
            <CopyableAddress address={publicAddr} />
            {isWeb && publicAddr && (
              <a href={publicAddr} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">open ↗</a>
            )}
            {extraPorts.length > 0 && (
              <span className="text-[10px] text-slate-500">
                also {extraPorts.map(portLabel).join(', ')}
              </span>
            )}
            <span className={`px-1.5 py-0.5 rounded text-[10px] ${bound.enabled ? 'bg-emerald-900/60 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>
              {bound.enabled ? 'enabled' : 'paused'}
            </span>
            {bound.id && <ExternalUptimeBadge kind={isWeb ? 'webroutes' : 'entries'} id={bound.id} />}
            {isWeb ? (
              <span className="text-slate-500">
                Cloudflare Tunnel → http://{target.clusterIP || bound.service}:{bound.port}
              </span>
            ) : (
              <span className="text-slate-500">
                {entry.ports?.map(portLabel).join(', ')}
                {droplet?.ip ? ` @ ${droplet.ip}` : ''} → {entry.targetIP}
              </span>
            )}
          </div>
          {!isWeb && target.drift?.mismatch && (
            <p className="text-amber-400">
              ⚠ ProxyCTL targets {entry.targetIP}, but the live Service is {target.drift.found ? target.drift.live : 'gone'} —
              {' '}<button disabled={busy} onClick={() => publish({})} className="text-sky-400 hover:underline disabled:opacity-50">update &amp; re-apply</button>
            </p>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <button disabled={busy} onClick={() => publish({ enabled: !bound.enabled })}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700">
              {bound.enabled ? 'Pause' : 'Resume'}
            </button>
            <button disabled={busy} onClick={() => publish({})}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700">Re-apply</button>
            <button disabled={busy} onClick={() => setConfirmUnpub(v => !v)}
              className="px-2 py-0.5 rounded bg-rose-950/60 hover:bg-rose-900/60 border border-rose-900 text-rose-300">Unpublish</button>
          </div>
          {confirmUnpub && (
            <div className="rounded-lg border border-rose-900 bg-rose-950/30 p-2 space-y-1.5">
              {!isWeb && (
                <label className="flex items-center gap-1.5 text-rose-200 cursor-pointer">
                  <input type="checkbox" checked={removeDNS} onChange={e => setRemoveDNS(e.target.checked)}
                    className="form-checkbox rounded border-rose-700 bg-rose-950 text-rose-500" />
                  Also remove the DNS record ({entry.subdomain})
                </label>
              )}
              <div className="flex gap-2">
                <button disabled={busy} onClick={unpublish}
                  className="px-2.5 py-1 rounded-lg bg-rose-600 hover:bg-rose-500 font-medium disabled:opacity-50">
                  {busy ? 'Removing…' : 'Remove public access'}
                </button>
                <button disabled={busy} onClick={() => setConfirmUnpub(false)}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700">Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {notice && <p className="text-emerald-400">{notice}</p>}
      {err && <p className="text-rose-400">{err}</p>}
    </div>
  )
}

// PublishPanel — the instance's Networking section. Two rows, kept small so
// it reads at a glance inside the expanded card:
//   LAN    — the MetalLB LoadBalancer address GameCTL already manages (or a
//            "ClusterIP only" note when the instance was deployed
//            Internet-only).
//   Public — the ProxyCTL path: link a sibling ProxyCTL install once
//            (URL + operator login, stored in a Secret), then associate a
//            public DNS name per bindable target — instances with more
//            than one Service (Minecraft+BlueMap, CS2+surf-records) get
//            one row per target, each with its own subdomain binding.
function PublishPanel({ namespace, name, lanAddress }) {
  const [info, setInfo] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  // One-time link form
  const [showLink, setShowLink] = useState(false)
  const [link, setLink] = useState({ url: '', username: '', password: '' })

  const errOf = (e) => e.response?.data?.error || e.response?.data?.detail || e.message

  const load = useCallback(() => (
    api.get(`/games/instances/${namespace}/${name}/publish`)
      .then(r => { setInfo(r.data); setErr('') })
      .catch(e => setErr(errOf(e)))
  ), [namespace, name])
  useEffect(() => { load() }, [load])

  // Prefill the link-form URL from what the backend reports.
  useEffect(() => {
    if (info?.url) setLink(l => (l.url ? l : { ...l, url: info.url }))
  }, [info])

  const saveLink = async () => {
    setBusy(true); setNotice(''); setErr('')
    try {
      await api.put('/proxyctl/link', link)
      setShowLink(false)
      setLink(l => ({ ...l, password: '' }))
      setNotice('ProxyCTL linked ✓')
      await load()
    } catch (e) { setErr(errOf(e)) } finally { setBusy(false) }
  }

  const targets = info?.targets || []
  const isLB = targets.some(t => t.type === 'LoadBalancer')

  return (
    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-2.5">
      <p className="text-xs font-medium text-slate-400">Networking</p>
      {info?.publishMode === 'egress' && (
        <p className="text-[11px] text-slate-500">
          This game is found via its in-game server browser, which records the
          server's <span className="text-slate-300">outbound</span> address —
          publishing routes the server's own traffic through the ProxyCTL
          droplet (WireGuard sidecar) so players are pointed at the public IP.
          The pod restarts once when first published.
        </p>
      )}

      {/* LAN row — MetalLB */}
      <div className="flex items-center gap-2 flex-wrap text-xs">
        <span className="w-14 shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-500">LAN</span>
        {lanAddress ? (
          <CopyableAddress address={lanAddress} />
        ) : isLB ? (
          <span className="text-slate-500">MetalLB LoadBalancer — waiting for an IP…</span>
        ) : (
          <span className="text-slate-500">ClusterIP only — no LAN LoadBalancer (Internet-only via ProxyCTL)</span>
        )}
      </div>

      {/* Public row — ProxyCTL */}
      <div className="flex items-start gap-2 flex-wrap text-xs">
        <span className="w-14 shrink-0 mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">Public</span>
        <div className="flex-1 min-w-0 space-y-2.5">
          {!info && !err && <span className="text-slate-500">Checking ProxyCTL…</span>}

          {info && !info.linked && !showLink && (
            <div className="flex items-center gap-2 flex-wrap">
              {info.detected ? (
                <>
                  <span className="text-slate-400">ProxyCTL detected in your cluster — connect it to publish this server on the internet.</span>
                  <button onClick={() => setShowLink(true)}
                    className="px-2.5 py-1 rounded-lg bg-sky-700 hover:bg-sky-600 font-medium">Connect ProxyCTL</button>
                </>
              ) : (
                <>
                  <span className="text-slate-500">
                    No ProxyCTL install detected — <a href="https://proxyctl.cc" target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">ProxyCTL</a>{' '}
                    publishes game servers on the internet without opening router ports.
                  </span>
                  <button onClick={() => setShowLink(true)}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400">I have one elsewhere…</button>
                </>
              )}
            </div>
          )}

          {info && showLink && (!info.linked || info.linkError) && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-2.5 space-y-2">
              <p className="text-slate-400">Connect to ProxyCTL (stored once, used for every server):</p>
              <div className="grid sm:grid-cols-3 gap-2">
                <input className="form-input rounded bg-slate-800 border-slate-700 text-slate-100 text-xs py-1.5" placeholder="URL (http://proxyctl.proxyctl.svc)"
                  value={link.url} onChange={e => setLink(l => ({ ...l, url: e.target.value }))} />
                <input className="form-input rounded bg-slate-800 border-slate-700 text-slate-100 text-xs py-1.5" placeholder="Username" autoComplete="off"
                  value={link.username} onChange={e => setLink(l => ({ ...l, username: e.target.value }))} />
                <input className="form-input rounded bg-slate-800 border-slate-700 text-slate-100 text-xs py-1.5" placeholder="Password" type="password" autoComplete="new-password"
                  value={link.password} onChange={e => setLink(l => ({ ...l, password: e.target.value }))} />
              </div>
              <div className="flex items-center gap-2">
                <button disabled={busy || !link.username || !link.password} onClick={saveLink}
                  className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-medium disabled:opacity-50">
                  {busy ? 'Testing…' : 'Save & test'}
                </button>
                <button disabled={busy} onClick={() => setShowLink(false)}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700">Cancel</button>
              </div>
            </div>
          )}

          {info?.linked && info.linkError && (
            <p className="text-rose-400">ProxyCTL link error: {info.linkError}{' '}
              <button onClick={() => setShowLink(true)} className="text-sky-400 hover:underline">re-connect</button>
            </p>
          )}

          {info?.linked && !info.linkError && targets.length === 0 && (
            <p className="text-slate-500">No Service found for this instance yet.</p>
          )}

          {info?.linked && !info.linkError && targets.map(t => (
            <PublishTarget key={t.service} namespace={namespace} name={name}
              target={t} domains={info.domains} droplet={info.droplet} cfReady={info.cfReady}
              onChanged={load} multi={targets.length > 1} />
          ))}

          {notice && <p className="text-emerald-400">{notice}</p>}
          {err && <p className="text-rose-400">{err}</p>}
        </div>
      </div>
    </div>
  )
}

// LP — shared style tokens for the per-game "live" control panels (CS2,
// Minecraft) so they read identically: clearer hierarchy (uppercase
// subsection headers), brighter borders, aligned label column, and
// consistent button + input shapes.
const LP = {
  panel:   'rounded-lg border border-slate-700/80 bg-slate-900/40 p-3 space-y-4',
  title:   'text-xs font-medium text-slate-300 mb-1.5',
  sub:     'text-[10px] font-semibold uppercase tracking-wider text-slate-500',
  row:     'flex items-center gap-3 flex-wrap',
  label:   'w-32 shrink-0 text-slate-300 text-xs',
  sel:     'form-select rounded-md bg-slate-800 border border-slate-700 text-slate-200 text-xs py-1 px-2 min-w-[10rem]',
  input:   'form-input rounded-md bg-slate-800 border border-slate-700 text-slate-200 text-xs py-1 px-2',
  qbtn:    'px-2.5 py-1 rounded-md border border-slate-700 bg-slate-800/70 hover:bg-slate-700 hover:border-slate-600 text-xs text-slate-200 disabled:opacity-40 disabled:hover:bg-slate-800/70 disabled:hover:border-slate-700',
  primary: 'px-3 py-1 rounded-md bg-emerald-600 hover:bg-emerald-500 text-xs font-medium text-white disabled:opacity-50 disabled:hover:bg-emerald-600',
  divider: 'border-t border-slate-800 pt-3 space-y-2',
  status:  'text-[11px] text-slate-400 truncate max-w-[18rem]',
  help:    'text-[11px] text-slate-500 italic',
}

// ---- Backups -------------------------------------------------------------
// Per-game save backups: pick a destination Storage Location, an interval and
// a retention count; GameCTL renders a CronJob that tars the save paths and
// keeps the newest N. "Back up now" + "Restore" run as background tasks.
const CRON_PRESETS = [
  { id: 'hourly', label: 'Every hour',          cron: '0 * * * *' },
  { id: '6h',     label: 'Every 6 hours',       cron: '0 */6 * * *' },
  { id: 'daily',  label: 'Daily (04:00)',       cron: '0 4 * * *' },
  { id: 'weekly', label: 'Weekly (Sun 04:00)',  cron: '0 4 * * 0' },
]
const cronToPreset = (cron) => CRON_PRESETS.find(p => p.cron === cron)?.id || 'custom'
const fmtBytes = (n) => {
  if (n == null) return '?'
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0, v = n
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++ }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`
}
const fmtAge = (unix) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix))
  if (s < 90) return `${s}s ago`
  const m = Math.floor(s / 60); if (m < 90) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 36) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
// Copy-paste help for inspecting a backup tarball. Generic across games — the
// example filename is illustrative; any <game>-<timestamp>.tar.gz works.
const BACKUP_TAR_HELP = `# Peek inside without extracting (list contents)
tar -tzvf valheim-20260712-143619.tar.gz

# Extract everything into a new folder
mkdir peek && tar -xzf valheim-20260712-143619.tar.gz -C peek

# Extract just one path from the archive
tar -xzf valheim-20260712-143619.tar.gz <path-inside-archive>`

function BackupsPanel({ namespace, name }) {
  const [bk, setBk] = useState(null)        // BackupSettings from the server
  const [locs, setLocs] = useState([])
  const [archives, setArchives] = useState(null)
  const [form, setForm] = useState(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const loadCfg = useCallback(() => {
    api.get(`/games/instances/${namespace}/${name}/backup`)
      .then(r => {
        setBk(r.data)
        const c = r.data.config || {}
        setForm({
          enabled: !!c.enabled,
          preset: cronToPreset(c.schedule || '0 4 * * *'),
          schedule: c.schedule || '0 4 * * *',
          retention: c.retention || 7,
          destination: c.destination || '',
          scope: c.scope || 'saves',
        })
      })
      .catch(e => setErr(e.response?.data?.detail || e.message))
  }, [namespace, name])

  const loadArchives = useCallback(() => {
    api.get(`/games/instances/${namespace}/${name}/backups`)
      .then(r => setArchives(r.data.backups || []))
      .catch(() => setArchives([]))
  }, [namespace, name])

  useEffect(() => {
    loadCfg()
    api.get('/storage/locations').then(r => setLocs(r.data.locations || [])).catch(() => {})
  }, [loadCfg])

  useEffect(() => { if (bk?.config?.destination) loadArchives() }, [bk?.config?.destination, loadArchives])

  if (err && !bk) return <p className="text-xs text-rose-400 mt-3">Backups: {err}</p>
  if (!bk || !form) return null

  if (!bk.supported) {
    return (
      <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
        <p className="text-xs font-medium text-slate-400 mb-1">Backups</p>
        <p className="text-xs text-slate-500">{bk.note || 'This game has no save data to back up.'}</p>
      </div>
    )
  }

  const nfsLocs = (Array.isArray(locs) ? locs : []).filter(l => (l.type || 'nfs') === 'nfs')

  const save = async () => {
    setBusy(true); setErr(''); setMsg('')
    try {
      const cron = form.preset === 'custom'
        ? form.schedule
        : CRON_PRESETS.find(p => p.id === form.preset).cron
      await api.patch(`/games/instances/${namespace}/${name}/backup`, {
        enabled: form.enabled,
        schedule: cron,
        retention: Number(form.retention),
        destination: form.destination,
        scope: form.scope,
      })
      setMsg(form.enabled ? 'Scheduled backup saved ✓' : 'Backups disabled ✓')
      setTimeout(loadCfg, 500)
    } catch (e) { setErr(e.response?.data?.detail || e.message) }
    finally { setBusy(false) }
  }

  const backupNow = async () => {
    setBusy(true); setErr(''); setMsg('')
    try {
      await api.post(`/games/instances/${namespace}/${name}/backup/now`)
      setMsg('Backup started — follow it in the Tasks menu. Refreshing the list shortly…')
      setTimeout(loadArchives, 8000)
    } catch (e) { setErr(e.response?.data?.detail || e.message) }
    finally { setBusy(false) }
  }

  const restore = async (archive) => {
    if (!window.confirm(`Restore "${archive}"?\n\nThis stops ${name}, overwrites the current save with the backup, then starts the server again.`)) return
    setBusy(true); setErr(''); setMsg('')
    try {
      await api.post(`/games/instances/${namespace}/${name}/restore`, { archive })
      setMsg(`Restoring ${archive} — follow it in the Tasks menu.`)
    } catch (e) { setErr(e.response?.data?.detail || e.message) }
    finally { setBusy(false) }
  }

  const removeArchive = async (archive) => {
    if (!window.confirm(`Delete "${archive}"? This can't be undone.`)) return
    setBusy(true); setErr(''); setMsg('')
    try {
      await api.delete(`/games/instances/${namespace}/${name}/backups/${encodeURIComponent(archive)}`)
      setMsg(`Deleted ${archive}.`)
      setArchives(prev => (prev || []).filter(a => a.name !== archive))
    } catch (e) { setErr(e.response?.data?.detail || e.message) }
    finally { setBusy(false) }
  }

  // Resolve the selected destination to the actual on-share backup dir
  // (<server>:<export>/GameCTL-Backups/<instance>) for the "how to open"
  // help. backupsFolder mirrors the server-side constant in backup.go.
  const destLoc = (Array.isArray(locs) ? locs : []).find(l => l.name === form.destination)
  const backupDir = destLoc
    ? `${destLoc.server ? destLoc.server + ':' : ''}${joinPath(destLoc.exportPath || '', 'GameCTL-Backups', name)}`
    : ''

  return (
    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-slate-400">Backups</p>
        {bk.active && <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-300">scheduled</span>}
      </div>

      <div className="flex items-start gap-3">
        <button
          role="switch" aria-checked={form.enabled} disabled={busy}
          onClick={() => setForm(f => ({ ...f, enabled: !f.enabled }))}
          className={`mt-0.5 h-5 w-9 shrink-0 rounded-full transition relative disabled:opacity-50 ${form.enabled ? 'bg-emerald-600' : 'bg-slate-700'}`}>
          <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${form.enabled ? 'left-[1.125rem]' : 'left-0.5'}`} />
        </button>
        <p className="text-xs text-slate-300">Scheduled backups
          <span className="block text-slate-500">Snapshots the save files on a schedule and keeps the newest N.</span>
        </p>
      </div>

      <div className={LP.row}>
        <span className={LP.label}>Backup folder</span>
        <select className={LP.sel} value={form.destination} disabled={busy}
          onChange={e => setForm(f => ({ ...f, destination: e.target.value }))}>
          <option value="">— choose a storage location —</option>
          {nfsLocs.map(l => <option key={l.name} value={l.name}>{l.name} ({l.server}:{l.exportPath})</option>)}
        </select>
      </div>
      {nfsLocs.length === 0 && <p className={LP.help}>No NFS storage locations defined — add one under Storage.</p>}

      <div className={LP.row}>
        <span className={LP.label}>Interval</span>
        <select className={LP.sel} value={form.preset} disabled={busy}
          onChange={e => setForm(f => ({ ...f, preset: e.target.value }))}>
          {CRON_PRESETS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="custom">Custom (cron)</option>
        </select>
        {form.preset === 'custom' && (
          <input className={LP.input} value={form.schedule} placeholder="0 4 * * *" disabled={busy}
            onChange={e => setForm(f => ({ ...f, schedule: e.target.value }))} />
        )}
      </div>

      <div className={LP.row}>
        <span className={LP.label}>Keep newest</span>
        <input type="number" min="1" className={`${LP.input} w-20`} value={form.retention} disabled={busy}
          onChange={e => setForm(f => ({ ...f, retention: e.target.value }))} />
        <span className="text-[11px] text-slate-500">backups (older ones are deleted)</span>
      </div>

      <div className={LP.row}>
        <span className={LP.label}>What to back up</span>
        <select className={LP.sel} value={form.scope} disabled={busy}
          onChange={e => setForm(f => ({ ...f, scope: e.target.value }))}>
          <option value="saves">Save files only</option>
          <option value="whole">Whole data volume</option>
        </select>
      </div>
      {form.scope === 'saves' && (
        <p className={LP.help}>
          {bk.note}{bk.effectivePaths?.length ? ` Paths: ${bk.effectivePaths.join(', ')}` : ''}
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button className={LP.primary} disabled={busy} onClick={save}>Save</button>
        <button className={LP.qbtn} disabled={busy || !form.destination} onClick={backupNow}
          title={!form.destination ? 'Choose a backup folder first' : ''}>Back up now</button>
      </div>

      {form.destination && (
        <div className={LP.divider}>
          <p className={LP.sub}>Stored backups</p>
          {archives === null ? <p className={LP.help}>Loading…</p>
            : archives.length === 0 ? <p className={LP.help}>No backups yet.</p>
            : (
              <ul className="space-y-1">
                {archives.map(a => (
                  <li key={a.name} className="flex items-center justify-between gap-2 text-xs rounded border border-slate-800 px-2 py-1">
                    <span className="font-mono text-slate-300 truncate">{a.name}</span>
                    <span className="text-slate-500 shrink-0">{fmtBytes(a.size)} · {fmtAge(a.modTime)}</span>
                    <button className={LP.qbtn} disabled={busy} onClick={() => restore(a.name)}>Restore</button>
                    <button
                      className="px-2.5 py-1 rounded-md border border-rose-900 bg-rose-950/60 hover:bg-rose-900/60 hover:border-rose-800 text-xs text-rose-300 disabled:opacity-40"
                      disabled={busy} onClick={() => removeArchive(a.name)}>Delete</button>
                  </li>
                ))}
              </ul>
            )}

          <details className="mt-2 rounded border border-slate-800 bg-slate-900/40">
            <summary className="cursor-pointer select-none px-2 py-1 text-[11px] font-medium text-sky-300 hover:text-sky-200">
              How to open a .tar.gz backup
            </summary>
            <div className="border-t border-slate-800 px-2 py-2 space-y-2 text-[11px] text-slate-300">
              <p>
                Each backup is a gzipped tarball of the save files. They live on your
                backup location{backupDir ? <> at <code className="text-slate-100 break-all">{backupDir}/</code></> : ''}.
                SSH into that server (or copy an archive off the share), then:
              </p>
              <div className="overflow-x-auto rounded border border-slate-800 bg-slate-950/70">
                <pre className="p-2 leading-relaxed text-slate-200 whitespace-pre">{BACKUP_TAR_HELP}</pre>
              </div>
              <p className="text-slate-500">
                Works for any game — swap in the archive you want (e.g. the newest one
                above). <code className="text-slate-300">tar</code> is built into Linux, macOS,
                and Windows 10+ (or use 7-Zip). Extracting never touches the running server;
                use <span className="font-medium">Restore</span> to put a backup back.
              </p>
            </div>
          </details>
        </div>
      )}

      {msg && <p className="text-[11px] text-emerald-400">{msg}</p>}
      {err && <p className="text-xs text-rose-400">{err}</p>}
    </div>
  )
}

// Quick label lookup from a mode key — derived from the catalog so it stays
// in sync with !rtv and the wizard.
const cs2ModeLabel = (key) => {
  const m = CS2_RTV_CATALOG.find((c) => c.key === key)
  return m?.name || key
}
const CS2_MAPS = [
  'de_dust2', 'de_mirage', 'de_inferno', 'de_nuke', 'de_overpass',
  'de_vertigo', 'de_ancient', 'de_anubis', 'de_train', 'cs_office', 'cs_italy',
]
// Bot management one-clicks.
const CS2_BOT_CMDS = [
  ['Add T bot', 'bot_add t'],
  ['Add CT bot', 'bot_add ct'],
  ['Add random bot', 'bot_add'],
  ['Kick all bots', 'bot_kick'],
]
// Game / cheat one-clicks.
const CS2_GAME_CMDS = [
  ['Restart round', 'mp_restartgame 1'],
  ['End warmup', 'mp_warmup_end'],
  ['sv_cheats on', 'sv_cheats 1'],
  ['sv_cheats off', 'sv_cheats 0'],
]
// Diagnostics — confirm the modded plugin stack is loaded and healthy.
const CS2_DIAG = [
  ['Metamod plugins', 'meta list'],
  ['CounterStrikeSharp plugins', 'css_plugins list'],
  ['Server status', 'status'],
]

// MetricsPanel — live CPU/RAM usage vs limits for the instance, from the
// backend's 30s sampler (~1h of history). Shows a labeled status chip when
// a container is pressing against its limit; degrades to a one-line note
// when metrics-server is absent.
function MetricsPanel({ namespace, name }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let stop = false
    const load = () => api.get(`/games/instances/${namespace}/${name}/metrics`)
      .then(r => { if (!stop) setData(r.data) })
      .catch(() => {})
    load()
    const t = setInterval(load, 30000)
    return () => { stop = true; clearInterval(t) }
  }, [namespace, name])

  if (!data) return null
  if (!data.available) {
    return (
      <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
        <p className="text-xs font-medium text-slate-400">Resources</p>
        <p className="mt-1 text-[11px] text-slate-500">
          No usage data yet — metrics-server may be missing from the cluster, or the first sample has not landed yet.
        </p>
        {/* Renders only when the cluster genuinely can't serve metrics. */}
        <MetricsServerNotice variant="compact" />
      </div>
    )
  }
  const m = data.metrics
  const fmtCPU = (v) => v >= 1000 ? (v / 1000).toFixed(2) + ' cores' : v + 'm'
  const fmtMem = (v) => v >= 1 << 30 ? (v / (1 << 30)).toFixed(2) + ' GiB' : Math.round(v / (1 << 20)) + ' MiB'
  const memHot = m.maxMemPct >= 90
  const cpuHot = m.maxCpuPct >= 95
  const chip = (hot, label) => hot && (
    <span className="ml-2 px-1.5 py-0.5 rounded bg-rose-900/60 text-rose-300 text-[10px] align-middle">⚠ {label}</span>
  )

  return (
    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
      <p className="text-xs font-medium text-slate-400 mb-2">Resources — last hour</p>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <p className="text-[11px] text-slate-500 mb-1">
            CPU <span className="text-slate-300">{fmtCPU(m.cpuMilli)}</span>
            {m.cpuLimitMilli > 0 && <> / {fmtCPU(m.cpuLimitMilli)} limit</>}
            {chip(cpuHot, `at ${m.maxCpuPct}% — throttling`)}
          </p>
          <Sparkline history={m.history} field="cpuMilli" limit={m.cpuLimitMilli} format={fmtCPU} />
        </div>
        <div>
          <p className="text-[11px] text-slate-500 mb-1">
            Memory <span className="text-slate-300">{fmtMem(m.memBytes)}</span>
            {m.memLimitBytes > 0 && <> / {fmtMem(m.memLimitBytes)} limit</>}
            {chip(memHot, `at ${m.maxMemPct}% — OOM-kill risk`)}
          </p>
          <Sparkline history={m.history} field="memBytes" limit={m.memLimitBytes} format={fmtMem} color="#a78bfa" />
        </div>
      </div>
      {(memHot || cpuHot) && (
        <p className="mt-2 text-[11px] text-slate-500">
          A container is pressing against its limit — raise its resources below, or reduce the
          game's load. Memory at the limit gets the pod OOM-killed; CPU at the limit only slows it down.
        </p>
      )}
      <ResourcesEditor namespace={namespace} name={name} />
    </div>
  )
}

// ReachabilityPanel — protocol-health/uptime history for the instance, from
// the backend's 30s probe sampler (~1h of history). Complements MetricsPanel
// (CPU/RAM) with "was it actually reachable" over time: an in-cluster line
// always, plus an external (MetalLB IP) line when the Service has one —
// catches L2Advertisement/speaker issues the in-cluster check can't see.
// Live map/players are already shown above via GameHealth; this panel's
// value-add is specifically the history.
// Same window the hub cards use, so "uptime" means one thing across the
// app. The Monitoring page is where you go for longer spans.
const UPTIME_WINDOW_HOURS = 1

function ReachabilityPanel({ namespace, name }) {
  const [data, setData] = useState(null)

  useEffect(() => {
    let stop = false
    const load = () => api.get(`/games/instances/${namespace}/${name}/probehistory`)
      .then(r => { if (!stop) setData(r.data) })
      .catch(() => {})
    load()
    const t = setInterval(load, 30000)
    return () => { stop = true; clearInterval(t) }
  }, [namespace, name])

  if (!data) return null
  const history = data.history || []
  if (!data.available || history.length < 2) {
    return (
      <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
        <p className="text-xs font-medium text-slate-400">Uptime</p>
        <p className="mt-1 text-[11px] text-slate-500">collecting samples… (30s interval, check back shortly)</p>
      </div>
    )
  }

  // The reachability percentage is HeartbeatStrip's job — it computes one
  // over exactly the window it draws, so there's a single number that can't
  // disagree with the bars beside it.
  const fmtMS = (v) => `${Math.round(v)}ms`
  const lbSamples = history.filter(s => s.lbReachable !== null && s.lbReachable !== undefined)
  const hasLB = lbSamples.length > 0
  // Latency lines only plot samples where the probe actually answered —
  // drawing a down sample as 0ms made an outage look like an impossibly
  // fast response instead of an absence. Up/down now lives in the
  // heartbeat bars, which is what they're for.
  const inLatency = history.filter(s => s.reachable && s.latencyMs > 0)
  const lbLatency = lbSamples.filter(s => s.lbReachable && s.lbLatencyMs > 0)

  return (
    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3">
      <p className="text-xs font-medium text-slate-400 mb-2">Uptime — last hour</p>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <p className="text-[11px] text-slate-400 mb-1">In-cluster</p>
          <HeartbeatStrip samples={history.map(s => ({ t: s.t, up: s.reachable }))} hours={UPTIME_WINDOW_HOURS} />
          {inLatency.length >= 2 && (
            <div className="mt-2">
              <p className="text-[11px] text-slate-500 mb-1">Latency</p>
              <Sparkline
                history={inLatency.map(s => ({ t: s.t, latencyMs: s.latencyMs }))}
                field="latencyMs" format={fmtMS} color="#38bdf8"
              />
            </div>
          )}
        </div>
        {hasLB && (
          <div>
            <p className="text-[11px] text-slate-400 mb-1">External (LB IP)</p>
            <HeartbeatStrip samples={lbSamples.map(s => ({ t: s.t, up: !!s.lbReachable }))} hours={UPTIME_WINDOW_HOURS} />
            {lbLatency.length >= 2 && (
              <div className="mt-2">
                <p className="text-[11px] text-slate-500 mb-1">Latency</p>
                <Sparkline
                  history={lbLatency.map(s => ({ t: s.t, lbLatencyMs: s.lbLatencyMs }))}
                  field="lbLatencyMs" format={fmtMS} color="#34d399"
                />
              </div>
            )}
          </div>
        )}
      </div>
      {!hasLB && (
        <p className="mt-2 text-[11px] text-slate-600">
          No external line — this game isn't on a dedicated LoadBalancer IP.
        </p>
      )}
    </div>
  )
}

// Stepper bounds. The floors are what a game server can realistically run
// on at all; the ceilings are a guard against a fat-fingered extra digit
// producing a Pending-forever pod no node can satisfy.
const CPU_MIN = 100, CPU_MAX = 32000, CPU_STEP = 250      // millicores
const MEM_MIN = 256, MEM_MAX = 131072, MEM_STEP = 512     // MiB

// ResourcesEditor — change the game container's CPU/RAM requests+limits.
// Applies LIVE to the running pod via in-place resize (K8s >= 1.33, no
// restart) and persists via a pending annotation folded in on the next
// restart; on clusters without live resize it honestly reports
// "applies on next restart".
function ResourcesEditor({ namespace, name }) {
  const [res, setRes] = useState(null)
  const [form, setForm] = useState(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [err, setErr] = useState('')

  const load = useCallback(() => (
    api.get(`/games/instances/${namespace}/${name}/resources`)
      .then(r => { setRes(r.data); setForm(f => f || r.data) })
      .catch(() => {})
  ), [namespace, name])
  useEffect(() => { load() }, [load])

  if (!res || !form) return null

  // The form carries numbers (millicores / MiB); the API still takes
  // Kubernetes Quantity strings, so convert only at the boundary.
  const cpuReq = parseCPUMillis(form.cpuRequest) ?? CPU_MIN
  const cpuLim = parseCPUMillis(form.cpuLimit) ?? CPU_MIN
  const memReq = parseMemMiB(form.memRequest) ?? MEM_MIN
  const memLim = parseMemMiB(form.memLimit) ?? MEM_MIN
  const setCPU = (key) => (milli) => setForm(f => ({ ...f, [key]: formatCPUMillis(milli) }))
  const setMem = (key) => (mib) => setForm(f => ({ ...f, [key]: formatMemMiB(mib) }))

  // Kubernetes rejects request > limit outright, so say so here rather than
  // letting Apply fail with an API error.
  const cpuBad = cpuReq > cpuLim
  const memBad = memReq > memLim
  const invalid = cpuBad || memBad

  const apply = async () => {
    setBusy(true); setNotice(''); setErr('')
    try {
      const { data } = await api.post(`/games/instances/${namespace}/${name}/resources`, {
        cpuRequest: form.cpuRequest, cpuLimit: form.cpuLimit,
        memRequest: form.memRequest, memLimit: form.memLimit,
      })
      setNotice(data.note + (data.liveDetail ? ` (${data.liveDetail})` : ''))
      load()
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 border-t border-slate-800 pt-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex w-full items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/60
                   px-3 py-2.5 text-sm font-medium text-slate-200 hover:bg-slate-800"
      >
        <span className="text-slate-500">{open ? '▾' : '▸'}</span>
        <span>Adjust CPU / RAM</span>
        <span className="ml-auto font-mono text-xs text-slate-400">
          {form.cpuLimit || '—'} · {form.memLimit || '—'}
        </span>
        {res.pending && (
          <span className="rounded bg-amber-900/60 px-1.5 py-0.5 text-[10px] text-amber-300">
            restart to make permanent
          </span>
        )}
      </button>
      {open && (
        <div className="mt-2 space-y-2.5">
          <p className="text-[11px] text-slate-500 leading-relaxed">
            <span className="text-slate-300 font-medium">Request</span> — the share of the node
            <em> reserved</em> for this server; Kubernetes uses it to decide where the server can run,
            so it's guaranteed even when the node is busy.{' '}
            <span className="text-slate-300 font-medium">Limit</span> — the hard cap: going over the
            CPU limit just slows the game down (throttling), but hitting the RAM limit gets the
            server killed and restarted (OOM). A request can never exceed its limit. Changes apply
            to the <span className="text-slate-300">running server live, without a restart</span>
            {' '}(on Kubernetes 1.33+), and become permanent on the next restart.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <QuantityStepper
              label="CPU request" value={cpuReq} onChange={setCPU('cpuRequest')}
              step={CPU_STEP} min={CPU_MIN} max={CPU_MAX} unit="m" human={humanCPU(cpuReq)}
              warn={cpuBad ? 'Request is above the limit' : ''}
            />
            <QuantityStepper
              label="CPU limit" value={cpuLim} onChange={setCPU('cpuLimit')}
              step={CPU_STEP} min={CPU_MIN} max={CPU_MAX} unit="m" human={humanCPU(cpuLim)}
            />
            <QuantityStepper
              label="RAM request" value={memReq} onChange={setMem('memRequest')}
              step={MEM_STEP} min={MEM_MIN} max={MEM_MAX} unit="MiB" human={humanMem(memReq)}
              warn={memBad ? 'Request is above the limit' : ''}
            />
            <QuantityStepper
              label="RAM limit" value={memLim} onChange={setMem('memLimit')}
              step={MEM_STEP} min={MEM_MIN} max={MEM_MAX} unit="MiB" human={humanMem(memLim)}
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              disabled={busy || invalid}
              onClick={apply}
              className="rounded-lg bg-sky-700 px-4 py-2.5 text-sm font-medium text-white
                         hover:bg-sky-600 disabled:opacity-40"
            >
              {busy ? 'Applying…' : 'Apply'}
            </button>
            <span className="font-mono text-[11px] text-slate-500">
              requests {form.cpuRequest} / {form.memRequest} · limits {form.cpuLimit} / {form.memLimit}
            </span>
          </div>
          {notice && <p className="text-xs text-emerald-400">{notice}</p>}
          {err && <p className="text-xs text-rose-400">{err}</p>}
        </div>
      )}
    </div>
  )
}

// WF2LivePanel — Wreckfest 2 post-deploy settings. The image regenerates
// server_config.scnf from env each boot, so every change here is an env
// patch + one automatic server restart (~1-2 min). There is no RCON on the
// WF2 dedicated server; per-session mode/track changes belong to the lobby
// leader in-game (the "leader" toggle below).
function WF2LivePanel({ namespace, name, wf2, onApplied }) {
  const [form, setForm] = useState({
    serverName: wf2.serverName || '',
    description: wf2.description || '',
    password: wf2.password || '',
    eventLoop: wf2.eventLoop || 'default_loop',
    countdownTime: wf2.countdownTime || 100000,
    votingTime: wf2.votingTime || 20000,
    leaderEnabled: !!wf2.leaderEnabled,
  })
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [err, setErr] = useState('')

  const base = {
    serverName: wf2.serverName || '',
    description: wf2.description || '',
    password: wf2.password || '',
    eventLoop: wf2.eventLoop || 'default_loop',
    countdownTime: wf2.countdownTime || 100000,
    votingTime: wf2.votingTime || 20000,
    leaderEnabled: !!wf2.leaderEnabled,
  }
  const dirty = Object.keys(base).some(k => form[k] !== base[k])

  const apply = async () => {
    setBusy(true); setNotice(''); setErr('')
    try {
      // Send only what changed so untouched fields can never be clobbered.
      const body = {}
      for (const k of Object.keys(base)) if (form[k] !== base[k]) body[k] = form[k]
      const { data } = await api.post(`/games/instances/${namespace}/${name}/wf2config`, body)
      setNotice(data.note || 'Applied — the server restarts once to load it.')
      onApplied?.()
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }

  const secs = (ms) => Math.round(ms / 1000)
  const timeBtn = (field, ms, label) => (
    <button
      key={field + ms}
      onClick={() => setForm(f => ({ ...f, [field]: ms }))}
      className={`px-2 py-1 rounded text-[11px] border ${form[field] === ms
        ? 'border-sky-500 bg-sky-900/40 text-sky-200'
        : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}
    >{label}</button>
  )
  const input = (field, placeholder, type = 'text') => (
    <input
      type={type}
      value={form[field]}
      placeholder={placeholder}
      onChange={e => setForm(f => ({ ...f, [field]: e.target.value }))}
      className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200"
    />
  )

  return (
    <div>
      <p className="text-[11px] text-slate-500 mb-1">Wreckfest 2 server settings</p>
      <div className="space-y-2.5 rounded border border-slate-800 p-2.5">
        <div className="flex items-start gap-3">
          <button
            role="switch"
            aria-checked={form.leaderEnabled}
            onClick={() => setForm(f => ({ ...f, leaderEnabled: !f.leaderEnabled }))}
            className={`mt-0.5 h-5 w-9 shrink-0 rounded-full transition relative ${form.leaderEnabled ? 'bg-emerald-600' : 'bg-slate-700'}`}
          >
            <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${form.leaderEnabled ? 'left-[1.125rem]' : 'left-0.5'}`} />
          </button>
          <div className="text-xs">
            <p className="text-slate-200 font-medium">Lobby leader controls</p>
            <p className="text-slate-500 mt-0.5">
              The first player to join becomes lobby leader and can change game
              mode, track and event settings in-game — no admin login exists in
              Wreckfest 2, this is how modes are switched between sessions.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] text-slate-500 mb-1">Lobby countdown ({secs(form.countdownTime)}s)</p>
            <div className="flex gap-1.5">
              {timeBtn('countdownTime', 30000, '30s')}
              {timeBtn('countdownTime', 60000, '60s')}
              {timeBtn('countdownTime', 100000, '100s')}
            </div>
          </div>
          <div>
            <p className="text-[11px] text-slate-500 mb-1">Vote time ({secs(form.votingTime)}s)</p>
            <div className="flex gap-1.5">
              {timeBtn('votingTime', 20000, '20s')}
              {timeBtn('votingTime', 45000, '45s')}
              {timeBtn('votingTime', 60000, '60s')}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] text-slate-500 mb-1">Server browser name</p>
            {input('serverName', 'GameCTL Wreckfest 2')}
          </div>
          <div>
            <p className="text-[11px] text-slate-500 mb-1">Join password (blank = open)</p>
            {input('password', 'none')}
          </div>
        </div>
        <div>
          <p className="text-[11px] text-slate-500 mb-1">Welcome message</p>
          {input('description', 'Welcome to my server!')}
        </div>
        <div>
          <p className="text-[11px] text-slate-500 mb-1">
            Event loop (advanced — name of a <span className="font-mono">.becl</span> rotation
            file in the server save dir; the server generates <span className="font-mono">default_loop</span>)
          </p>
          {input('eventLoop', 'default_loop')}
        </div>

        <div className="flex items-center gap-3">
          <button
            disabled={!dirty || busy}
            onClick={apply}
            className="px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-40 text-xs text-white font-medium"
          >
            {busy ? 'Applying…' : 'Apply (restarts server)'}
          </button>
          <span className="text-[11px] text-slate-500">Changes load on one automatic restart (~1–2 min).</span>
        </div>
        {notice && <p className="text-xs text-emerald-400">{notice}</p>}
        {err && <p className="text-xs text-rose-400">{err}</p>}
      </div>
    </div>
  )
}

// CS2LivePanel — for a kus/cs2-modded-server CS2 instance. Switch game
// mode live (the backend execs the mode cfg + changes map over RCON — a
// few seconds, no pod restart), run quick RCON actions, change map, and
// check the modded plugin stack. The kus image's own RTV / !gamemode
// voting lets players vote modes/maps in-game without an operator.
function CS2LivePanel({ namespace, name, cs2, onApplied }) {
  const [busy, setBusy] = useState(false)
  const [qbusy, setQbusy] = useState('')
  const [msg, setMsg] = useState('')
  const [pickMap, setPickMap] = useState('de_dust2')
  const [wsId, setWsId] = useState('')
  const [modePick, setModePick] = useState(cs2.mode || (CS2_RTV_CATALOG[0]?.key || ''))
  const [botQuota, setBotQuota] = useState('8')
  const [welcomeText, setWelcomeText] = useState('')
  const [welcomeBusy, setWelcomeBusy] = useState(false)
  const [hostnameText, setHostnameText] = useState('')
  const [hostnameBusy, setHostnameBusy] = useState(false)
  const [apiKeyText, setApiKeyText] = useState('')
  const [apiKeySet, setApiKeySet] = useState(false)
  const [apiKeyBusy, setApiKeyBusy] = useState(false)
  const [apiKeyConfirm, setApiKeyConfirm] = useState(false)
  const [apiKeyShown, setApiKeyShown] = useState(false)

  // Pre-fill the welcome + hostname + api-key editors with the live values.
  useEffect(() => {
    api.get(`/games/instances/${namespace}/${name}/cs2/welcome`)
      .then(({ data }) => setWelcomeText(data?.message ?? ''))
      .catch(() => {})
    api.get(`/games/instances/${namespace}/${name}/cs2/hostname`)
      .then(({ data }) => setHostnameText(data?.hostname ?? ''))
      .catch(() => {})
    api.get(`/games/instances/${namespace}/${name}/cs2/steam-api-key`)
      .then(({ data }) => { setApiKeyText(data?.apiKey ?? ''); setApiKeySet(!!data?.set) })
      .catch(() => {})
  }, [namespace, name])

  const switchMode = async () => {
    if (busy) return
    const mode = CS2_RTV_CATALOG.find((m) => m.key === modePick)
    if (!mode) { setMsg('Pick a mode first.'); return }
    const first = mode.maps[0]
    setBusy(true); setMsg('')
    try {
      await api.post(`/games/instances/${namespace}/${name}/cs2config`, {
        cfg: mode.cfg,
        map: first?.id || '',
        workshop: !!first?.workshop,
      })
      setMsg(`Switched to ${mode.name} ✓ — mode cfg exec'd, map reloading`)
      setTimeout(() => onApplied?.(), 2500)
    } catch (e) {
      setMsg(e.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }

  const runCmd = async (key, command) => {
    setQbusy(key); setMsg('')
    try {
      const { data } = await api.post(`/games/instances/${namespace}/${name}/rcon`, { command })
      setMsg((data.output || 'sent ✓').trim().slice(0, 600) || 'sent ✓')
      setTimeout(() => onApplied?.(), 1200)
    } catch (e) {
      setMsg(e.response?.data?.detail || e.message)
    } finally {
      setQbusy('')
    }
  }

  const saveWelcome = async () => {
    setWelcomeBusy(true); setMsg('')
    try {
      await api.post(`/games/instances/${namespace}/${name}/cs2/welcome`, { message: welcomeText })
      setMsg('Welcome message saved ✓ — GameCtlRtv reloaded, persists across restart')
    } catch (e) {
      setMsg(e.response?.data?.detail || e.message)
    } finally {
      setWelcomeBusy(false)
    }
  }

  const saveAPIKey = async () => {
    setApiKeyBusy(true); setMsg('')
    try {
      await api.post(`/games/instances/${namespace}/${name}/cs2/steam-api-key`,
        { apiKey: apiKeyText.trim() })
      setMsg('Steam API key saved ✓ — pod is rolling, ~3-4 min until cs2 is back.')
      setApiKeyConfirm(false)
      setApiKeyShown(false)
      setTimeout(() => onApplied?.(), 1200)
    } catch (e) {
      setMsg(e.response?.data?.detail || e.message)
    } finally {
      setApiKeyBusy(false)
    }
  }

  const saveHostname = async () => {
    const next = hostnameText.trim()
    if (!next) { setMsg('Hostname cannot be empty.'); return }
    setHostnameBusy(true); setMsg('')
    try {
      await api.post(`/games/instances/${namespace}/${name}/cs2/hostname`, { hostname: next })
      setMsg(`Server name set to "${next}" ✓ — live, persists across restart`)
      setTimeout(() => onApplied?.(), 1200)
    } catch (e) {
      setMsg(e.response?.data?.detail || e.message)
    } finally {
      setHostnameBusy(false)
    }
  }

  return (
    <div>
      <p className={LP.title}>CS2 live controls — no restart</p>
      <div className={LP.panel}>
        {/* Mode switcher — all 33 modes from the catalog */}
        <div>
          <p className={LP.sub}>
            Game mode
            {cs2.liveMode && (
              <span className="text-emerald-300"> · live: {cs2.liveMode}</span>
            )}
            {cs2.liveMap && (
              <span className="text-slate-300"> · map: <code>{cs2.liveMap}</code></span>
            )}
            {cs2.mode && (
              <span className="text-slate-500"> · boot: {cs2ModeLabel(cs2.mode)}</span>
            )}
          </p>
          <div className={LP.row}>
            <select className={`${LP.sel} min-w-[14rem]`} value={modePick}
              onChange={(e) => setModePick(e.target.value)}>
              {CS2_RTV_CATALOG.map((m) => (
                <option key={m.key} value={m.key}>{m.name}</option>
              ))}
            </select>
            <button className={LP.primary} disabled={busy} onClick={switchMode}>
              {busy ? 'Switching…' : 'Switch to mode'}
            </button>
          </div>
          <p className={LP.help}>
            Live switch — execs the mode cfg + loads its default map over RCON
            (a few seconds, no pod restart). Not persisted across a pod recreate;
            redeploy via the wizard to change the permanent boot mode.
          </p>
        </div>

        {/* Server name — live RCON `hostname` + persisted to ConfigMap */}
        <div className={LP.divider}>
          <p className={LP.sub}>Server name (in-game hostname)</p>
          <div className={LP.row}>
            <input className={`${LP.input} flex-1 min-w-[16rem]`} value={hostnameText}
              onChange={(e) => setHostnameText(e.target.value)}
              placeholder="e.g. JT and RAGA" />
            <button className={LP.primary} disabled={hostnameBusy} onClick={saveHostname}>
              {hostnameBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
          <p className={LP.help}>
            Applied live via RCON and persisted to the cs2 config ConfigMap
            so it survives a pod restart. Shown in the server browser.
          </p>
        </div>

        {/* Steam Web API key — patches API_KEY env on the deployment (rolls
            the pod). The cs2 binary needs this to background-fetch
            subscribed workshop maps via Steam's subscription API. */}
        <div className={LP.divider}>
          <p className={LP.sub}>
            Steam Web API key
            {apiKeySet && <span className="ml-2 rounded px-1.5 py-0.5 bg-emerald-900/50 text-emerald-300 text-[10px]">set</span>}
          </p>
          <div className={LP.row}>
            <input className={`${LP.input} flex-1 min-w-[16rem] font-mono`}
              type={apiKeyShown ? 'text' : 'password'}
              value={apiKeyText}
              onChange={(e) => setApiKeyText(e.target.value)}
              placeholder="32 hex chars from steamcommunity.com/dev/apikey" />
            <button className={LP.qbtn} onClick={() => setApiKeyShown(s => !s)}
              type="button">{apiKeyShown ? 'hide' : 'show'}</button>
            {!apiKeyConfirm ? (
              <button className={LP.primary} disabled={apiKeyBusy}
                onClick={() => setApiKeyConfirm(true)}>Save</button>
            ) : (
              <>
                <button className={LP.primary} disabled={apiKeyBusy} onClick={saveAPIKey}>
                  {apiKeyBusy ? 'Saving…' : 'Confirm — roll pod'}
                </button>
                <button className={LP.qbtn} disabled={apiKeyBusy}
                  onClick={() => setApiKeyConfirm(false)}>Cancel</button>
              </>
            )}
          </div>
          <p className={LP.help}>
            <strong>Saving rolls the cs2 pod</strong> (Recreate strategy
            → ~3-4 min of downtime). Without this key, server-side workshop
            downloads only work via the host_workshop_map cycle (which
            kicks players); with it, subscribed maps download silently in
            the background.{' '}
            <a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer"
              className="text-sky-400 hover:text-sky-300 underline">Get a free key</a>.
          </p>
        </div>

        {/* Welcome message editor — writes the live GameCtlRtv.json and reloads */}
        <div className={LP.divider}>
          <p className={LP.sub}>Welcome message (chat)</p>
          <div className={LP.row}>
            <input className={`${LP.input} flex-1 min-w-[16rem]`} value={welcomeText}
              onChange={(e) => setWelcomeText(e.target.value)}
              placeholder="e.g. Welcome to the server — type !help for commands" />
            <button className={LP.primary} disabled={welcomeBusy} onClick={saveWelcome}>
              {welcomeBusy ? 'Saving…' : 'Save'}
            </button>
          </div>
          <p className={LP.help}>
            Printed to each joining player a few seconds after they connect.
            Supports <code>{'{green}'}</code>/<code>{'{yellow}'}</code>/<code>{'{default}'}</code> color tokens.
            Saved to a ConfigMap so it persists across pod restarts. Blank = no welcome.
          </p>
        </div>

        {/* Bots & cheats */}
        <div className={LP.divider}>
          <p className={LP.sub}>Bots & cheats</p>
          <div className="flex flex-wrap gap-1.5">
            {CS2_BOT_CMDS.map(([label, cmd]) => (
              <button key={label} className={LP.qbtn} disabled={!!qbusy}
                onClick={() => runCmd(label, cmd)}>
                {qbusy === label ? '…' : label}
              </button>
            ))}
          </div>
          <div className={LP.row}>
            <span className={LP.label}>Max bots (bot_quota)</span>
            <input className={`${LP.input} w-20`} type="number" min="0" max="32"
              value={botQuota} onChange={(e) => setBotQuota(e.target.value)} />
            <button className={LP.qbtn} disabled={!!qbusy}
              onClick={() => runCmd('quota', `bot_quota_mode fill;bot_quota ${Number(botQuota) || 0}`)}>
              {qbusy === 'quota' ? '…' : 'Set bot quota'}
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CS2_GAME_CMDS.map(([label, cmd]) => (
              <button key={label} className={LP.qbtn} disabled={!!qbusy}
                onClick={() => runCmd(label, cmd)}>
                {qbusy === label ? '…' : label}
              </button>
            ))}
          </div>
        </div>

        {/* Map */}
        <div className={LP.divider}>
          <p className={LP.sub}>Map</p>
          <div className={LP.row}>
            <span className={LP.label}>Workshop map ID</span>
            <input className={`${LP.input} w-40`} value={wsId}
              onChange={(e) => setWsId(e.target.value)} placeholder="e.g. 3076153623" />
            <button className={LP.qbtn} disabled={!!qbusy || !wsId.trim()}
              onClick={() => runCmd('wsmap', `host_workshop_map ${wsId.trim()}`)}>
              {qbusy === 'wsmap' ? 'Loading…' : 'Load workshop map'}
            </button>
          </div>
          <div className={LP.row}>
            <span className={LP.label}>Standard map</span>
            <select className={LP.sel} value={pickMap} onChange={(e) => setPickMap(e.target.value)}>
              {CS2_MAPS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className={LP.qbtn} disabled={!!qbusy}
              onClick={() => runCmd('map', `changelevel ${pickMap}`)}>
              {qbusy === 'map' ? 'Loading…' : 'Load map'}
            </button>
          </div>
        </div>

        {/* Plugin diagnostics */}
        <div className={LP.divider}>
          <p className={LP.sub}>Plugin diagnostics</p>
          <div className="flex flex-wrap gap-1.5">
            {CS2_DIAG.map(([label, cmd]) => (
              <button key={label} className={LP.qbtn} disabled={!!qbusy}
                onClick={() => runCmd(label, cmd)}>
                {qbusy === label ? '…' : label}
              </button>
            ))}
          </div>
          <p className={LP.help}>
            Confirms the modded stack is up — Metamod, CounterStrikeSharp,
            GameCtlRtv and QuakeSounds should all show as loaded. SharpTimer
            is upstream-broken on the current CS2 build.
          </p>
        </div>

        {/* In-game commands */}
        <div className={LP.divider}>
          <p className={LP.sub}>In-game player commands</p>
          <p className={LP.help}>
            Players type these in chat: <code>!rtv</code> two-stage vote
            (mode + map) · <code>!unrtv</code> withdraw ·
            <code>!modes</code> vote just the mode ·
            <code>!maps</code> vote a map in the current mode ·
            <code>!timeleft</code> · <code>!help</code>.
          </p>
        </div>

        {msg && (
          <pre className="mt-2 text-[11px] text-slate-300 bg-slate-950 border border-slate-800 rounded p-2 whitespace-pre-wrap break-words max-h-48 overflow-auto">
            {msg}
          </pre>
        )}
      </div>
    </div>
  )
}

// Lookup table: workshop id → friendly map name from the catalog. Used by
// the workshop panel so the operator sees "surf_kitsune" instead of a
// 10-digit workshop id. Stock (non-workshop) maps aren't in this table.
const CS2_WS_NAME_BY_ID = (() => {
  const m = {}
  for (const mode of CS2_RTV_CATALOG) {
    for (const map of mode.maps) {
      if (map.workshop) m[map.id] = { name: map.name, mode: mode.name }
    }
  }
  return m
})()

// CS2WorkshopPanel — visibility + manual control of the workshop-map
// pre-download. Reads the subscribed_file_ids.txt off the pod, checks
// which ones the server has actually fetched, and (on demand) cycles
// `host_workshop_map <id>` for the missing ones with delays. The cycle
// disconnects players each map — surfaced clearly so the operator can
// run it during off-hours.
function CS2WorkshopPanel({ namespace, name }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const load = useCallback(() => {
    api.get(`/games/instances/${namespace}/${name}/cs2/workshop`)
      .then((r) => { setData(r.data); setErr('') })
      .catch((e) => setErr(e.response?.data?.detail || e.message))
  }, [namespace, name])

  useEffect(() => {
    load()
    // While a download is running, poll faster so the progress moves.
    const id = setInterval(() => {
      if (document.visibilityState !== 'visible') return
      load()
    }, data?.running ? 4000 : 15000)
    return () => clearInterval(id)
  }, [load, data?.running])

  const startDownload = async (missingOnly) => {
    setBusy(true); setErr('')
    try {
      const { data } = await api.post(
        `/games/instances/${namespace}/${name}/cs2/workshop/download`,
        { missingOnly },
      )
      if (data?.started === 0) {
        setErr('Nothing to download — every subscribed map is already cached.')
      } else {
        setTimeout(load, 800)
      }
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }
  const cancelDownload = async () => {
    setBusy(true); setErr('')
    try {
      await api.post(`/games/instances/${namespace}/${name}/cs2/workshop/cancel`)
      setTimeout(load, 800)
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }
  const setSidecar = async (enabled) => {
    setBusy(true); setErr('')
    try {
      await api.post(
        `/games/instances/${namespace}/${name}/cs2/workshop/sidecar`,
        { enabled },
      )
      setTimeout(load, 800)
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }

  if (!data) {
    return (
      <div>
        <p className={LP.title}>Workshop maps</p>
        <div className={LP.panel}>
          <p className={LP.help}>{err || 'Loading…'}</p>
        </div>
      </div>
    )
  }

  // Sort: currently-downloading first (so it's always visible), then missing,
  // then alphabetic by friendly name (or id if no name).
  const rows = [...(data.maps || [])].sort((a, b) => {
    const aDl = data.running && a.id === data.runningId
    const bDl = data.running && b.id === data.runningId
    if (aDl !== bDl) return aDl ? -1 : 1
    if (a.downloaded !== b.downloaded) return a.downloaded ? 1 : -1
    const an = CS2_WS_NAME_BY_ID[a.id]?.name || a.id
    const bn = CS2_WS_NAME_BY_ID[b.id]?.name || b.id
    return an.localeCompare(bn)
  })
  const visible = showAll ? rows : rows.slice(0, 12)

  return (
    <div>
      <p className={LP.title}>Workshop maps</p>
      <div className={LP.panel}>
        {/* Big opt-in card. Off by default so a fresh deploy never burns
            multi-GB of NFS on a background fetch without consent — the
            operator clicks here when they want every !rtv map preloaded. */}
        {!data.sidecarEnabled ? (
          <div className="rounded border border-amber-700/40 bg-amber-900/20 p-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs">
              <div className="font-medium text-amber-200">
                Background workshop downloads are off
              </div>
              <div className="text-amber-100/70">
                Turn this on to pre-download every subscribed workshop map
                ({data.total} maps, ~3–7 GB on NFS) in the background. The
                sidecar runs continuously and players stay connected — no
                level changes, no kicks. Recommended once after install.
              </div>
            </div>
            <button
              className={LP.primary + ' whitespace-nowrap'}
              disabled={busy}
              onClick={() => setSidecar(true)}>
              {busy ? '…' : `Pre-download all ${data.total} maps`}
            </button>
          </div>
        ) : (
          <div className="rounded border border-emerald-700/40 bg-emerald-900/20 p-2 flex items-center justify-between gap-3">
            <div className="text-xs text-emerald-200">
              <span className="font-medium">Background downloads are on.</span>
              <span className="text-emerald-100/70">
                {' '}Sidecar fetches missing maps continuously
                {data.missing > 0 ? ` · ${data.missing} still missing` : ' · all caught up'}.
              </span>
            </div>
            <button
              className={LP.qbtn + ' whitespace-nowrap'}
              disabled={busy}
              onClick={() => setSidecar(false)}>
              {busy ? '…' : 'Stop background downloads'}
            </button>
          </div>
        )}

        <div className="flex items-center gap-3 flex-wrap text-xs">
          <span className="text-slate-300">
            <span className="text-emerald-300 font-medium">{data.have}</span>
            {' '}of <span className="text-slate-200 font-medium">{data.total}</span>
            {' '}cached
          </span>
          {data.missing > 0 && (
            <span className="text-amber-300">· {data.missing} missing</span>
          )}
          <span className="text-slate-500">·</span>
          <span className="text-slate-400">{data.totalMB} MB on NFS</span>
          {data.autoPreload && !data.steamApiKeySet && (
            <span className="rounded px-1.5 py-0.5 bg-violet-900/50 text-violet-300 text-[10px]"
              title="GameCTL cycles host_workshop_map for missing maps when no players are connected.">
              auto-preload on
            </span>
          )}
          {data.steamApiKeySet && (
            <span className="rounded px-1.5 py-0.5 bg-emerald-900/50 text-emerald-300 text-[10px]"
              title="API_KEY is set on the deployment — the cs2 binary fetches subscribed maps in the background via Steam's subscription API. No level changes needed.">
              Steam API key set · bg downloads
            </span>
          )}
          {data.running && (
            <span className="ml-auto rounded px-1.5 py-0.5 bg-sky-900/50 text-sky-300 text-[10px]">
              downloading {data.runDone}/{data.runTotal}
              {data.runningId && ` · current ${CS2_WS_NAME_BY_ID[data.runningId]?.name || data.runningId}`}
            </span>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {!data.running ? (
            <>
              <button className={LP.primary} disabled={busy || data.missing === 0}
                onClick={() => startDownload(true)}>
                {busy ? '…' : `Download ${data.missing} missing`}
              </button>
              <button className={LP.qbtn} disabled={busy || data.total === 0}
                onClick={() => startDownload(false)}>
                Re-fetch all
              </button>
            </>
          ) : (
            <button className={LP.qbtn} disabled={busy} onClick={cancelDownload}>
              {busy ? '…' : 'Cancel download'}
            </button>
          )}
          <button className={LP.qbtn} disabled={busy} onClick={load}>
            Refresh
          </button>
        </div>

        <p className={LP.help}>
          {data.steamApiKeySet ? (
            <>
              <span className="text-emerald-300">Steam API key is set</span> on
              this deployment, so the cs2 binary fetches every subscribed map
              in the background via Steam's subscription API — no level
              changes, no player kicks. The buttons below still work if you
              want to force an immediate fetch.
              {data.autoPreload && (
                <> &nbsp;The <span className="text-violet-300">auto-preload</span> annotation
                is also set, but the reconciler skips it because the API-key
                path is the non-disruptive one.</>
              )}
            </>
          ) : (
            <>
              Cycles <code>host_workshop_map &lt;id&gt;</code> for each map with
              a ~45s gap. <strong>This kicks connected players</strong> on each
              changelevel — run during off-hours. ~30-100 MB per map; check NFS
              headroom before fetching the full ~125-map set.
              {data.autoPreload && (
                <> &nbsp;<span className="text-violet-300">Auto-preload is on</span> for
                this deployment — GameCTL will re-trigger this cycle on any
                restart until everything is cached, but only while the server
                has zero players connected. Set a Steam Web API key in the
                wizard for true background downloads instead.</>
              )}
            </>
          )}
        </p>

        {err && <p className="text-xs text-rose-400">{err}</p>}

        {/* The per-map list. Default-collapsed to 12 rows; expand to see all.
            A row whose id matches data.runningId gets the active-download
            treatment so the operator can see exactly what's coming down. */}
        <div className="rounded border border-slate-800">
          {visible.map((m) => {
            const meta = CS2_WS_NAME_BY_ID[m.id]
            const isActive = data.running && m.id === data.runningId
            return (
              <div key={m.id}
                className={`grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 px-2 py-1.5 text-xs border-t border-slate-800 first:border-t-0 ${isActive ? 'bg-sky-950/40' : ''}`}>
                <span className="truncate text-slate-200" title={meta?.name || m.id}>
                  {meta?.name || `(unknown ${m.id})`}
                  {meta?.mode && <span className="text-slate-500"> · {meta.mode}</span>}
                </span>
                <span className="font-mono text-[10px] text-slate-500">{m.id}</span>
                <span className={isActive ? 'text-sky-300' : 'text-slate-400'}>
                  {m.sizeMB ? `${m.sizeMB} MB${isActive ? ' so far…' : ''}` : (isActive ? 'starting…' : '—')}
                </span>
                <span className={
                  isActive
                    ? 'rounded px-1.5 py-0.5 bg-sky-900/60 text-sky-200 text-[10px] animate-pulse'
                    : m.downloaded
                      ? 'rounded px-1.5 py-0.5 bg-emerald-900/50 text-emerald-300 text-[10px]'
                      : 'rounded px-1.5 py-0.5 bg-slate-800 text-slate-500 text-[10px]'}>
                  {isActive ? '↓ downloading' : m.downloaded ? '✓ cached' : 'missing'}
                </span>
              </div>
            )
          })}
        </div>
        {rows.length > 12 && (
          <button className="text-xs text-slate-400 hover:text-slate-200 underline self-start"
            onClick={() => setShowAll((v) => !v)}>
            {showAll ? `Show first 12` : `Show all ${rows.length}`}
          </button>
        )}
      </div>
    </div>
  )
}

// CS2SurfRecordsPanel — per-map leaderboards from GameCtlSurfHUD's JSON
// records file on NFS. Read-only window into the same data the in-game
// !top / !pb / !rank / !wr commands surface, but viewable without
// joining the server.
function CS2SurfRecordsPanel({ namespace, name }) {
  const [data, setData] = useState(null)
  const [err, setErr] = useState('')
  const [openMaps, setOpenMaps] = useState({}) // map → expanded?

  const load = useCallback(() => {
    api.get(`/games/instances/${namespace}/${name}/cs2/surf-records`)
      .then((r) => { setData(r.data); setErr('') })
      .catch((e) => setErr(e.response?.data?.detail || e.message))
  }, [namespace, name])

  useEffect(() => {
    load()
    // Refresh every 30s while visible — surf finishes are sparse, no
    // need to hammer.
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, 30000)
    return () => clearInterval(id)
  }, [load])

  if (!data && !err) {
    return (
      <div>
        <p className={LP.title}>Surf records</p>
        <div className={LP.panel}><p className={LP.help}>Loading…</p></div>
      </div>
    )
  }

  const fmtTime = (ms) => {
    const m = Math.floor(ms / 60000)
    const s = Math.floor((ms % 60000) / 1000)
    const c = Math.floor((ms % 1000) / 10)
    return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}.${String(c).padStart(2,'0')}`
  }
  const fmtAge = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    const ms = Date.now() - d.getTime()
    const s = Math.floor(ms / 1000)
    if (s < 60)    return `${s}s ago`
    if (s < 3600)  return `${Math.floor(s/60)}m ago`
    if (s < 86400) return `${Math.floor(s/3600)}h ago`
    return `${Math.floor(s/86400)}d ago`
  }
  const toggleMap = (m) => setOpenMaps((p) => ({ ...p, [m]: !p[m] }))

  const maps = data?.maps || []
  return (
    <div>
      <p className={LP.title}>Surf records</p>
      <div className={LP.panel}>
        <div className="flex items-center gap-3 flex-wrap text-xs">
          <span className="text-slate-300">
            <span className="text-emerald-300 font-medium">{data?.total ?? 0}</span> records
            {' '}across <span className="text-slate-200 font-medium">{maps.length}</span> maps
          </span>
          <button className={`${LP.qbtn} ml-auto`} onClick={load}>Refresh</button>
        </div>

        {err && <p className="text-xs text-rose-400">{err}</p>}

        {maps.length === 0 && !err && (
          <p className={LP.help}>
            No records yet — finish a surf run on the server (GameCtlSurfHUD
            saves to <code>/home/steam/cs2/gamectl_surf_records.json</code>
            on every new PB).
          </p>
        )}

        <div className="space-y-1.5">
          {maps.map((board) => {
            const isOpen = openMaps[board.map]
            const wr = board.records[0]
            return (
              <div key={board.map} className="rounded border border-slate-800 bg-slate-950/50">
                <button onClick={() => toggleMap(board.map)}
                  className="w-full flex items-center gap-3 px-2 py-1.5 text-xs hover:bg-slate-900/40">
                  <span className="text-slate-300">{isOpen ? '▾' : '▸'}</span>
                  <span className="text-slate-200 font-medium truncate flex-1 text-left">{board.map}</span>
                  <span className="text-slate-500">{board.records.length} record{board.records.length === 1 ? '' : 's'}</span>
                  {wr && (
                    <span className="text-emerald-300 font-mono">
                      WR {fmtTime(wr.timeMs)}
                    </span>
                  )}
                  {wr && (
                    <span className="text-slate-400 truncate max-w-[10rem]" title={wr.name}>
                      by {wr.name}
                    </span>
                  )}
                </button>
                {isOpen && (
                  <div className="px-2 pb-2">
                    {board.records.slice(0, 10).map((r, i) => (
                      <div key={r.steamId64}
                        className="grid grid-cols-[2rem_1fr_auto_auto] items-center gap-3 py-1 text-xs border-t border-slate-800 first:border-t-0">
                        <span className={`text-right font-medium ${
                          i === 0 ? 'text-amber-300' : i === 1 ? 'text-slate-200' : i === 2 ? 'text-orange-400' : 'text-slate-500'
                        }`}>#{i + 1}</span>
                        <span className="text-slate-200 truncate" title={r.name}>{r.name}</span>
                        <span className="font-mono text-emerald-300">{fmtTime(r.timeMs)}</span>
                        <span className="text-slate-500 text-[10px]" title={r.finishedAt}>{fmtAge(r.finishedAt)}</span>
                      </div>
                    ))}
                    {board.records.length > 10 && (
                      <p className="text-[10px] text-slate-600 text-center pt-1">… {board.records.length - 10} more</p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>

        <p className={LP.help}>
          Auto-refreshes every 30s. In-game: <code>!pb</code> · <code>!top</code> · <code>!rank</code> · <code>!wr</code>.
        </p>
      </div>
    </div>
  )
}

// CS2PlayersPanel — live connected-player roster (RCON `status`) with
// one-click promote/demote to CS2 admin. Admin changes apply live (no
// restart) and persist across a pod recreate (backend writes the
// cs2-<server>-admins ConfigMap + the running server's admins.json).
function CS2PlayersPanel({ namespace, name }) {
  const [players, setPlayers] = useState(null)
  const [admins, setAdmins] = useState([])
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')   // steamId64 currently changing
  const [msg, setMsg] = useState('')

  const load = useCallback(() => {
    api.get(`/games/instances/${namespace}/${name}/cs2/players`)
      .then(r => { setPlayers(r.data.players || []); setErr('') })
      .catch(e => setErr(e.response?.data?.detail || e.message))
    api.get(`/games/instances/${namespace}/${name}/cs2/admins`)
      .then(r => setAdmins(r.data.admins || []))
      .catch(() => {})
  }, [namespace, name])

  useEffect(() => {
    load()
    const id = setInterval(() => { if (document.visibilityState === 'visible') load() }, 10000)
    return () => clearInterval(id)
  }, [load])

  const setAdmin = async (steamId64, playerName, role, action) => {
    setBusy(steamId64); setMsg('')
    try {
      const { data } = await api.post(`/games/instances/${namespace}/${name}/cs2/admin`, {
        steamId64, name: playerName, role, action,
      })
      setAdmins(data.admins || [])
      setMsg(action === 'remove'
        ? `Removed ${playerName || steamId64} from admins ✓`
        : `${playerName || steamId64} is now ${role} ✓`)
      setTimeout(load, 800)
    } catch (e) {
      setMsg(e.response?.data?.detail || e.message)
    } finally {
      setBusy('')
    }
  }
  const adminBadge = (role) => (
    <span className="rounded px-1.5 py-0.5 bg-emerald-900/50 text-emerald-300 text-[10px]">{role}</span>
  )

  return (
    <div>
      <p className={LP.title}>Players &amp; admins</p>
      <div className={LP.panel}>
        <div>
          <p className={LP.sub}>
            Connected players {players && <span className="text-slate-500">· {players.length}</span>}
          </p>
          {err && <p className="text-xs text-rose-400">{err}</p>}
          {players && players.length === 0 && !err && (
            <p className={LP.help}>Nobody connected right now.</p>
          )}
          <div>
            {(players || []).map(p => (
              <div key={p.userId}
                className="flex items-center gap-2 text-xs py-1.5 border-t border-slate-800 first:border-t-0">
                <span className="text-slate-200 truncate max-w-[9rem]" title={p.name}>{p.name}</span>
                {p.isBot
                  ? <span className="text-slate-600 text-[10px]">BOT</span>
                  : <span className="font-mono text-[10px] text-slate-500">{p.steamId64}</span>}
                {p.isAdmin && adminBadge(p.role)}
                <span className="ml-auto flex gap-1">
                  {!p.isBot && !p.isAdmin && (
                    <>
                      <button className={LP.qbtn} disabled={busy === p.steamId64}
                        onClick={() => setAdmin(p.steamId64, p.name, 'admin', 'add')}>
                        {busy === p.steamId64 ? '…' : 'Make admin'}
                      </button>
                      <button className={LP.qbtn} disabled={busy === p.steamId64}
                        onClick={() => setAdmin(p.steamId64, p.name, 'moderator', 'add')}>Mod</button>
                    </>
                  )}
                  {!p.isBot && p.isAdmin && (
                    <button className={LP.qbtn} disabled={busy === p.steamId64}
                      onClick={() => setAdmin(p.steamId64, p.name, '', 'remove')}>
                      {busy === p.steamId64 ? '…' : 'Remove admin'}
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className={LP.divider}>
          <p className={LP.sub}>
            Admins {admins.length > 0 && <span className="text-slate-500">· {admins.length}</span>}
          </p>
          {admins.length === 0 && (
            <p className={LP.help}>No admins yet — promote a connected player above.</p>
          )}
          <div>
            {admins.map(a => (
              <div key={a.steamId64}
                className="flex items-center gap-2 text-xs py-1.5 border-t border-slate-800 first:border-t-0">
                <span className="text-slate-200 truncate max-w-[9rem]">{a.name}</span>
                <span className="font-mono text-[10px] text-slate-500">{a.steamId64}</span>
                {adminBadge(a.role)}
                <button className={`${LP.qbtn} ml-auto`} disabled={busy === a.steamId64}
                  onClick={() => setAdmin(a.steamId64, a.name, '', 'remove')}>
                  {busy === a.steamId64 ? '…' : 'Remove'}
                </button>
              </div>
            ))}
          </div>
          {msg && <p className="mt-1.5 text-xs text-emerald-300">{msg}</p>}
          <p className={LP.help}>
            Admins (#css/admin) can run every command — <code>!map</code>,{' '}
            <code>!mode</code>, vote management. Moderators (#css/moderator)
            get a safe subset. Changes apply live, no restart, and survive a
            redeploy.
          </p>
        </div>
      </div>
    </div>
  )
}

const MC_DIFFICULTY = ['peaceful', 'easy', 'normal', 'hard']
const MC_GAMEMODE = ['survival', 'creative', 'adventure', 'spectator']
// World sub-rows so the Quick-actions area stays scannable instead of a
// flat wall of 20+ buttons.
const MC_TIME    = [['Day', 'time set day'], ['Night', 'time set night'], ['Noon', 'time set noon'], ['Midnight', 'time set midnight']]
// Explicit ~11-day duration so the change visibly sticks rather than the
// natural weather cycle reverting it within seconds (doWeatherCycle=true).
const MC_WEATHER = [['Clear', 'weather clear 1000000'], ['Rain', 'weather rain 1000000'], ['Thunder', 'weather thunder 1000000']]
const MC_WORLD   = [['Save', 'save-all'], ['Save off', 'save-off'], ['Save on', 'save-on'], ['Reload', 'reload'], ['List', 'list']]
const MC_WL      = [['Whitelist on', 'whitelist on'], ['Whitelist off', 'whitelist off'], ['Reload list', 'whitelist reload']]
// Vanilla boolean gamerules worth flipping live. Each gets true/false
// buttons; the rule itself is picked from a select.
const MC_GAMERULES = [
  'keepInventory', 'mobGriefing', 'doFireTick', 'doDaylightCycle', 'doWeatherCycle',
  'doMobSpawning', 'naturalRegeneration', 'fallDamage', 'drowningDamage', 'freezeDamage',
  'announceAdvancements', 'sendCommandFeedback', 'showDeathMessages', 'doInsomnia',
  'doPatrolSpawning', 'doTraderSpawning', 'doImmediateRespawn', 'doMobLoot',
  'doTileDrops', 'doEntityDrops',
  // Note: `pvp` is intentionally NOT here — it's a server.properties value,
  // not a vanilla gamerule. `gamerule pvp true` would silently no-op.
]
// Per-player actions taking a player name (filled in from the input).
const MC_PLAYER_ACTIONS = [
  ['OP',         (n) => `op ${n}`],
  ['De-op',      (n) => `deop ${n}`],
  ['Kick',       (n) => `kick ${n}`],
  ['Ban',        (n) => `ban ${n}`],
  ['Pardon',     (n) => `pardon ${n}`],
  ['Whitelist+', (n) => `whitelist add ${n}`],
  ['Whitelist−', (n) => `whitelist remove ${n}`],
]
const MC_PLAYER_GAMEMODE = [
  ['Survival',  (n) => `gamemode survival ${n}`],
  ['Creative',  (n) => `gamemode creative ${n}`],
  ['Adventure', (n) => `gamemode adventure ${n}`],
  ['Spectator', (n) => `gamemode spectator ${n}`],
]

// MinecraftLivePanel — Minecraft analogue of CS2LivePanel: structured
// difficulty/gamemode controls, one-click world/weather actions, and a
// player picker for op/kick/whitelist — all over the same /rcon endpoint
// the generic console uses. Mirrors the CS2 layout for UI consistency.
function MinecraftLivePanel({ namespace, name, onApplied }) {
  const [difficulty, setDifficulty] = useState('normal')
  const [gamemode, setGamemode] = useState('survival')
  const [player, setPlayer] = useState('')
  const [rule, setRule] = useState('keepInventory')
  const [broadcast, setBroadcast] = useState('')
  const [qbusy, setQbusy] = useState('')
  const [msg, setMsg] = useState('')

  const runCmd = async (key, command) => {
    setQbusy(key); setMsg('')
    try {
      const { data } = await api.post(`/games/instances/${namespace}/${name}/rcon`, { command })
      setMsg((data.output || 'sent ✓').trim().slice(0, 200) || 'sent ✓')
      setTimeout(() => { onApplied?.(); }, 1000)
    } catch (e) {
      setMsg(e.response?.data?.detail || e.message)
    } finally {
      setQbusy('')
    }
  }

  const needsName = !player.trim()

  return (
    <div>
      <p className={LP.title}>Minecraft server settings (live — no restart)</p>
      <div className={LP.panel}>
        <div className="space-y-2.5">
          <p className={LP.sub}>Settings</p>
          <label className={LP.row}>
            <span className={LP.label}>Difficulty</span>
            <select className={LP.sel} value={difficulty} onChange={e => setDifficulty(e.target.value)}>
              {MC_DIFFICULTY.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
            <button className={LP.qbtn} disabled={!!qbusy}
              onClick={() => runCmd('difficulty', `difficulty ${difficulty}`)}>
              {qbusy === 'difficulty' ? '…' : 'Apply'}
            </button>
          </label>
          <label className={LP.row}>
            <span className={LP.label}>Default gamemode</span>
            <select className={LP.sel} value={gamemode} onChange={e => setGamemode(e.target.value)}>
              {MC_GAMEMODE.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
            <button className={LP.qbtn} disabled={!!qbusy}
              onClick={() => runCmd('gamemode', `defaultgamemode ${gamemode}`)}>
              {qbusy === 'gamemode' ? '…' : 'Apply'}
            </button>
            {msg && <span className={`${LP.status} ml-auto`}>{msg}</span>}
          </label>
        </div>

        <div className={LP.divider}>
          <p className={LP.sub}>World</p>
          <div className={LP.row}>
            <span className={LP.label}>Time</span>
            <div className="flex flex-wrap gap-1.5">
              {MC_TIME.map(([label, cmd]) => (
                <button key={label} className={LP.qbtn} disabled={!!qbusy}
                  onClick={() => runCmd(label, cmd)}>{qbusy === label ? '…' : label}</button>
              ))}
            </div>
          </div>
          <div className={LP.row}>
            <span className={LP.label}>Weather</span>
            <div className="flex flex-wrap gap-1.5">
              {MC_WEATHER.map(([label, cmd]) => (
                <button key={label} className={LP.qbtn} disabled={!!qbusy}
                  onClick={() => runCmd(label, cmd)}>{qbusy === label ? '…' : label}</button>
              ))}
            </div>
          </div>
          <div className={LP.row}>
            <span className={LP.label}>Actions</span>
            <div className="flex flex-wrap gap-1.5">
              {MC_WORLD.map(([label, cmd]) => (
                <button key={label} className={LP.qbtn} disabled={!!qbusy}
                  onClick={() => runCmd(label, cmd)}>{qbusy === label ? '…' : label}</button>
              ))}
            </div>
          </div>
          <div className={LP.row}>
            <span className={LP.label}>Whitelist</span>
            <div className="flex flex-wrap gap-1.5">
              {MC_WL.map(([label, cmd]) => (
                <button key={label} className={LP.qbtn} disabled={!!qbusy}
                  onClick={() => runCmd(label, cmd)}>{qbusy === label ? '…' : label}</button>
              ))}
            </div>
          </div>
        </div>

        <div className={LP.divider}>
          <p className={LP.sub}>Gamerule</p>
          <div className={LP.row}>
            <span className={LP.label}>Rule</span>
            <select className={LP.sel} value={rule} onChange={e => setRule(e.target.value)}>
              {MC_GAMERULES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className={LP.qbtn} disabled={!!qbusy}
              onClick={() => runCmd(`gr-true`, `gamerule ${rule} true`)}>
              {qbusy === 'gr-true' ? '…' : 'true'}
            </button>
            <button className={LP.qbtn} disabled={!!qbusy}
              onClick={() => runCmd(`gr-false`, `gamerule ${rule} false`)}>
              {qbusy === 'gr-false' ? '…' : 'false'}
            </button>
            <button className={LP.qbtn} disabled={!!qbusy}
              onClick={() => runCmd(`gr-query`, `gamerule ${rule}`)}>
              {qbusy === 'gr-query' ? '…' : 'query'}
            </button>
          </div>
        </div>

        <div className={LP.divider}>
          <p className={LP.sub}>Players</p>
          <div className={LP.row}>
            <span className={LP.label}>Player</span>
            <input value={player} onChange={e => setPlayer(e.target.value)}
              placeholder="Steve" spellCheck={false}
              className={`${LP.input} w-40`} />
          </div>
          <div className={LP.row}>
            <span className={LP.label}>Role</span>
            <div className="flex flex-wrap gap-1.5">
              {MC_PLAYER_ACTIONS.map(([label, fn]) => (
                <button key={label} className={LP.qbtn} disabled={!!qbusy || needsName}
                  onClick={() => runCmd(label, fn(player.trim()))}>
                  {qbusy === label ? '…' : label}
                </button>
              ))}
            </div>
          </div>
          <div className={LP.row}>
            <span className={LP.label}>Gamemode</span>
            <div className="flex flex-wrap gap-1.5">
              {MC_PLAYER_GAMEMODE.map(([label, fn]) => (
                <button key={label} className={LP.qbtn} disabled={!!qbusy || needsName}
                  onClick={() => runCmd(`gm-${label}`, fn(player.trim()))}>
                  {qbusy === `gm-${label}` ? '…' : label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className={LP.divider}>
          <p className={LP.sub}>Broadcast</p>
          <div className={LP.row}>
            <span className={LP.label}>Message</span>
            <input value={broadcast} onChange={e => setBroadcast(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && broadcast.trim()) { runCmd('say', `say ${broadcast.trim()}`); setBroadcast('') } }}
              placeholder="server message to all players"
              className={`${LP.input} flex-1 min-w-[14rem]`} />
            <button className={LP.qbtn} disabled={!!qbusy || !broadcast.trim()}
              onClick={() => { runCmd('say', `say ${broadcast.trim()}`); setBroadcast('') }}>
              {qbusy === 'say' ? '…' : 'Say'}
            </button>
          </div>
        </div>

        <p className={LP.help}>
          Sent to the running server over RCON. Effects are immediate; some
          (op, whitelist, ban) persist on disk, others are runtime-only
          until restart.
        </p>
      </div>
    </div>
  )
}

// LOG_REFRESH_MS — how often the log tail auto-refreshes when "Auto" is on.
// RconConsole — a generic Source-RCON console for any RCON-capable game
// (Minecraft, CS2, Factorio, Project Zomboid…). Type any server command
// (op <player>, list, say hi, …) and see the output. Quick-buttons offer
// common commands without memorizing syntax.

// IW4X live controls. Everything here is one RCON command away, except the bot
// names — IW4x loads userraw/bots.txt at STARTUP, so that half is a file on the
// volume and the UI has to be honest that it applies on the next restart.
function IW4XLivePanel({ namespace, name }) {
  const [live, setLive] = useState(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [mapPick, setMapPick] = useState('')
  const [typePick, setTypePick] = useState('')
  const [sayText, setSayText] = useState('')
  const [botFill, setBotFill] = useState(8)
  const [names, setNames] = useState('')
  const [namesLoaded, setNamesLoaded] = useState(false)
  const [admins, setAdmins] = useState(null)      // [{guid,label}] or null while loading
  const [newGuid, setNewGuid] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [editSlot, setEditSlot] = useState(null)   // slot being renamed inline
  const [editVal, setEditVal] = useState('')
  const [pending, setPending] = useState({})       // oldName -> newName, awaiting restart

  const loadLive = useCallback(async () => {
    try {
      const { data } = await api.get(`/games/instances/${namespace}/${name}/iw4x/live`)
      setLive(data); setErr('')
      if (!mapPick && data.map) setMapPick(data.map)
      if (!typePick && data.gametype) setTypePick(data.gametype)
    } catch (e) { setErr(e.message) }
  }, [namespace, name, mapPick, typePick])

  // Poll while the panel is open: bots join, scores move, players connect.
  useEffect(() => {
    loadLive()
    const t = setInterval(loadLive, 10000)
    return () => clearInterval(t)
  }, [loadLive])

  // One command per call, sequentially. IW4x does NOT accept semicolon-chained
  // commands in an RCON packet — verified: "g_gametype war; map mp_rust" comes
  // back as Unknown command "g_gametype;". Each verb gets its own datagram.
  const run = async (commands, label) => {
    const list = Array.isArray(commands) ? commands : [commands]
    setBusy(label); setNotice(''); setErr('')
    try {
      for (const command of list) {
        await api.post(`/games/instances/${namespace}/${name}/rcon`, { command })
      }
      setNotice(`Ran: ${list.join(' → ')}`)
      setTimeout(loadLive, 1500)
    } catch (e) { setErr(e.message) } finally { setBusy('') }
  }

  const loadNames = async () => {
    setBusy('names'); setErr('')
    try {
      const { data } = await api.get(`/games/instances/${namespace}/${name}/iw4x/bot-names`)
      setNames((data.names || []).join('\n')); setNamesLoaded(true)
    } catch (e) { setErr(e.message) } finally { setBusy('') }
  }

  const saveNames = async () => {
    setBusy('names'); setNotice(''); setErr('')
    try {
      const list = names.split(/[\n,]+/).map(n => n.trim()).filter(Boolean)
      const { data } = await api.post(`/games/instances/${namespace}/${name}/iw4x/bot-names`, { names: list })
      setNotice(data.detail || 'Saved.')
    } catch (e) { setErr(e.message) } finally { setBusy('') }
  }

  // Renaming edits the persistent list, because a running bot's name cannot be
  // changed: IW4x reads userraw/bots.txt once at startup and caches it — proven
  // by editing the file and spawning a fresh bot, which still came up with a
  // name from the pre-edit list. So the row shows the new name as pending and
  // the restart below is what actually applies it.
  const renameBot = async (oldName) => {
    const next = editVal.trim().slice(0, 16)
    if (!next || next === oldName) { setEditSlot(null); return }
    setBusy('rename'); setNotice(''); setErr('')
    try {
      const { data } = await api.get(`/games/instances/${namespace}/${name}/iw4x/bot-names`)
      const list = data.names || []
      const i = list.indexOf(oldName)
      if (i >= 0) list[i] = next
      else list.push(next)
      await api.post(`/games/instances/${namespace}/${name}/iw4x/bot-names`, { names: list })
      setNames(list.join('\n')); setNamesLoaded(true)
      setPending(p => ({ ...p, [oldName]: next }))
      setNotice(`"${oldName}" → "${next}". Restart the server to apply.`)
      setEditSlot(null)
    } catch (e) { setErr(e.message) } finally { setBusy('') }
  }

  const loadAdmins = useCallback(async () => {
    try {
      const { data } = await api.get(`/games/instances/${namespace}/${name}/iw4x/admins`)
      setAdmins(data.admins || [])
    } catch (e) { setErr(e.message) }
  }, [namespace, name])

  useEffect(() => { loadAdmins() }, [loadAdmins])

  const saveAdmins = async (list) => {
    setBusy('admins'); setNotice(''); setErr('')
    try {
      const { data } = await api.post(`/games/instances/${namespace}/${name}/iw4x/admins`, { admins: list })
      setAdmins(list)
      setNotice(data.detail || 'Saved.')
    } catch (e) { setErr(e.message) } finally { setBusy('') }
  }

  const addAdmin = (guid, label) => {
    const g = (guid || '').trim()
    if (!g) return
    if ((admins || []).some(a => a.guid === g)) { setErr(`${g} is already an admin`); return }
    saveAdmins([...(admins || []), { guid: g, label: (label || '').trim() }])
    setNewGuid(''); setNewLabel('')
  }

  const restartServer = async () => {
    setBusy('restart'); setNotice(''); setErr('')
    try {
      await api.post(`/games/instances/${namespace}/${name}/restart`)
      setPending({})
      setNotice('Restarting — bots rejoin with the new names once it is back.')
    } catch (e) { setErr(e.message) } finally { setBusy('') }
  }

  const btn = 'px-2.5 py-1 rounded text-xs border border-slate-700 bg-slate-800 hover:bg-slate-700 disabled:opacity-50'
  const sel = 'rounded border border-slate-700 bg-slate-900 text-slate-100 text-xs px-2 py-1'

  return (
    <div className="rounded-lg border border-slate-800 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">IW4X controls</h3>
        <span className="text-[11px] text-slate-500">
          {live ? `${live.map || '?'} · ${live.gametype || '?'} · ${live.humans} player${live.humans === 1 ? '' : 's'} + ${live.bots} bot${live.bots === 1 ? '' : 's'}` : 'loading…'}
        </span>
      </div>

      {/* Roster */}
      <div className="rounded border border-slate-800 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-slate-500">
            <tr><th className="text-left px-2 py-1">#</th><th className="text-left px-2 py-1">Name</th>
              <th className="text-right px-2 py-1">Score</th><th className="text-right px-2 py-1">Ping</th>
              <th className="px-2 py-1"></th></tr>
          </thead>
          <tbody>
            {(live?.players || []).map(p => (
              <tr key={p.slot} className="border-t border-slate-800/70">
                <td className="px-2 py-1 text-slate-500">{p.slot}</td>
                <td className="px-2 py-1">
                  {editSlot === p.slot ? (
                    <input autoFocus value={editVal} maxLength={16}
                      onChange={e => setEditVal(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') renameBot(p.name); if (e.key === 'Escape') setEditSlot(null) }}
                      className="rounded border border-slate-600 bg-slate-900 text-slate-100 text-xs px-1.5 py-0.5 w-40" />
                  ) : (
                    <>
                      {p.name}
                      {p.isBot && <span className="ml-1.5 px-1 rounded bg-slate-800 text-slate-400 text-[10px]">BOT</span>}
                      {pending[p.name] && (
                        <span className="ml-1.5 text-[10px] text-amber-400">→ {pending[p.name]} (restart to apply)</span>
                      )}
                    </>
                  )}
                </td>
                <td className="px-2 py-1 text-right">{p.score}</td>
                <td className="px-2 py-1 text-right text-slate-400">{p.ping}</td>
                <td className="px-2 py-1 text-right whitespace-nowrap">
                  {p.isBot && (editSlot === p.slot ? (
                    <>
                      <button className={btn} disabled={busy === 'rename'}
                        onClick={() => renameBot(p.name)}>Save</button>
                      <button className={btn + ' ml-1'} onClick={() => setEditSlot(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className={btn + ' mr-1'} disabled={!!busy}
                      onClick={() => { setEditSlot(p.slot); setEditVal(p.name) }}>Edit</button>
                  ))}
                  <button className={btn} disabled={!!busy}
                    onClick={() => run(`clientkick ${p.slot}`, 'kick' + p.slot)}>Kick</button>
                </td>
              </tr>
            ))}
            {live && (live.players || []).length === 0 && (
              <tr><td colSpan={5} className="px-2 py-2 text-slate-500">Nobody connected.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Map + gametype. Changing g_gametype needs a map load to take effect,
          so the button does both rather than leaving a dvar set but inactive. */}
      <div className="flex flex-wrap items-center gap-2">
        <select className={sel} value={mapPick} onChange={e => setMapPick(e.target.value)}>
          {IW4X_MAPS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
        <select className={sel} value={typePick} onChange={e => setTypePick(e.target.value)}>
          {IW4X_GAMETYPES.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
        </select>
        <button className={btn} disabled={!!busy}
          onClick={() => run([`g_gametype ${typePick}`, `map ${mapPick}`], 'map')}>Change map</button>
        <button className={btn} disabled={!!busy} onClick={() => run('map_restart', 'restart')}>Restart map</button>
        <button className={btn} disabled={!!busy} onClick={() => run('fast_restart', 'fast')}>Fast restart</button>
      </div>

      {/* Bots + say */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-slate-400">Bots</label>
        <input type="number" min={0} max={17} value={botFill} onChange={e => setBotFill(e.target.value)}
          className={sel + ' w-16'} />
        <button className={btn} disabled={!!busy}
          onClick={() => run(`bots_manage_fill ${Number(botFill)}`, 'fill')}>Set fill</button>
        <button className={btn} disabled={!!busy}
          onClick={() => run(`spawnBot ${Number(botFill)}`, 'spawn')}>Spawn now</button>
        <span className="w-px h-4 bg-slate-800" />
        <input value={sayText} onChange={e => setSayText(e.target.value)} placeholder="say to everyone…"
          className={sel + ' flex-1 min-w-[10rem]'} />
        <button className={btn} disabled={!!busy || !sayText.trim()}
          onClick={() => { run(`say ${sayText.trim()}`, 'say'); setSayText('') }}>Say</button>
      </div>

      {/* Admins — Bot Warfare's in-game menu is gated on this list. */}
      <div className="rounded border border-slate-800 p-2 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-300">Admins (in-game bot menu)</span>
          <button className={btn} disabled={busy === 'admins'} onClick={loadAdmins}>Reload</button>
        </div>
        <p className="text-[11px] text-slate-500">
          Listed players can open Bot Warfare's menu in-game (Action Slot 2, the <code>5</code> key by default) to tune bots live.
          Nobody is &quot;host&quot; on a dedicated server, so without this the menu cannot be opened at all.
          Membership is checked when a player connects — add someone, then have them reconnect.
        </p>

        <div className="rounded border border-slate-800 divide-y divide-slate-800/70">
          {(admins || []).map(a => (
            <div key={a.guid} className="flex items-center justify-between px-2 py-1 text-xs">
              <span className="font-mono text-slate-300">{a.guid}</span>
              <span className="text-slate-400 flex-1 px-2 truncate">{a.label}</span>
              <button className={btn} disabled={busy === 'admins'}
                onClick={() => saveAdmins((admins || []).filter(x => x.guid !== a.guid))}>Remove</button>
            </div>
          ))}
          {admins && admins.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-slate-500">No admins — the in-game menu is unreachable.</div>
          )}
          {!admins && <div className="px-2 py-1.5 text-xs text-slate-500">Loading…</div>}
        </div>

        {/* Add from the roster: connected humans only, and typing a 16-char
            hex GUID by hand is exactly where a typo silently costs an hour. */}
        <div className="flex flex-wrap items-center gap-2">
          {(live?.players || []).filter(p => !p.isBot && !(admins || []).some(a => a.guid === p.guid)).map(p => (
            <button key={p.slot} className={btn} disabled={busy === 'admins'}
              onClick={() => addAdmin(p.guid, p.name)}>+ {p.name}</button>
          ))}
          <input value={newGuid} onChange={e => setNewGuid(e.target.value)} placeholder="GUID"
            className={sel + ' font-mono w-56'} />
          <input value={newLabel} onChange={e => setNewLabel(e.target.value)} placeholder="label (optional)"
            className={sel + ' w-40'} />
          <button className={btn} disabled={busy === 'admins' || !newGuid.trim()}
            onClick={() => addAdmin(newGuid, newLabel)}>Add</button>
        </div>
      </div>

      {/* Bot names — the one thing here that is NOT live. */}
      <div className="rounded border border-slate-800 p-2 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-slate-300">Bot names (the pool bots draw from)</span>
          <div className="flex items-center gap-1">
            <button className={btn} disabled={busy === 'names'} onClick={loadNames}>
              {namesLoaded ? 'Reload' : 'Load current'}
            </button>
            <button className={btn} disabled={!!busy} onClick={restartServer}>
              Restart server{Object.keys(pending).length ? ` (${Object.keys(pending).length} pending)` : ''}
            </button>
          </div>
        </div>
        {namesLoaded && (
          <>
            <textarea value={names} onChange={e => setNames(e.target.value)} rows={6}
              className="w-full rounded border border-slate-700 bg-slate-900 text-slate-100 text-xs px-2 py-1 font-mono"
              placeholder="One name per line" />
            <div className="flex items-center gap-2">
              <button className={btn} disabled={busy === 'names'} onClick={saveNames}>Save</button>
              <span className="text-[11px] text-slate-500">
                Written to userraw/bots.txt. IW4x caches these at startup, so edits — here or via a row's Edit button — only take effect after a server restart. Max 16 characters per name.
              </span>
            </div>
          </>
        )}
      </div>

      {notice && <p className="text-xs text-emerald-300">{notice}</p>}
      {err && <p className="text-xs text-rose-300">{err}</p>}
    </div>
  )
}

function RconConsole({ namespace, name, game }) {
  const [cmd, setCmd] = useState('')
  const [lines, setLines] = useState([])  // {q, a}
  const [busy, setBusy] = useState(false)
  const scrollRef = useRef(null)

  // Scroll only the INNER container to the bottom — never `scrollIntoView`,
  // which scrolls the whole page and yanks the operator away from the
  // buttons above whenever output arrives.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const run = async (c) => {
    const command = (c ?? cmd).trim()
    if (!command || busy) return
    setBusy(true)
    setLines(l => [...l, { q: command, a: '…' }])
    try {
      const { data } = await api.post(`/games/instances/${namespace}/${name}/rcon`, { command })
      setLines(l => l.map((x, i) => i === l.length - 1 ? { ...x, a: (data.output || '(no output)').trim() } : x))
    } catch (e) {
      setLines(l => l.map((x, i) => i === l.length - 1 ? { ...x, a: 'ERROR: ' + (e.response?.data?.detail || e.message) } : x))
    } finally {
      setBusy(false)
      if (c == null) setCmd('')
    }
  }

  // Game-appropriate quick commands + example. Unknown game → no buttons
  // (freeform input still runs anything), so we never show commands a
  // given server doesn't understand.
  const QUICK = {
    cs2:            ['status', 'say hello', 'bot_quota 10', 'mp_restartgame 1'],
    minecraft:      ['list', 'save-all', 'time set day', 'weather clear', 'reload', 'difficulty', 'whitelist list', 'gamerule keepInventory'],
    factorio:       ['/players', '/help'],
    projectzomboid: ['players', 'help'],
    iw4x:           ['status', 'map_restart', 'say hello', 'bots_manage_fill 8'],
    quake3:         ['status', 'map_restart', 'say hello'],
  }
  const EG = {
    cs2:            'status, say hi, bot_add, changelevel de_mirage',
    minecraft:      'op YourName, list, whitelist add YourName, say hello',
    factorio:       '/players, /promote YourName, /help',
    projectzomboid: 'players, addadmin "YourName", quit',
  }
  const quick = QUICK[game] || []
  const eg = EG[game] || 'any server console command'
  return (
    <div>
      <p className="text-[11px] text-slate-500 mb-1">Server console (RCON — live)</p>
      <div className="rounded border border-slate-800 bg-slate-950">
        <div ref={scrollRef} className="max-h-56 overflow-auto p-2 font-mono text-[11px] space-y-1">
          {lines.length === 0 && (
            <p className="text-slate-600">Run a command, e.g. <span className="text-slate-400">{eg}</span>.</p>
          )}
          {lines.map((l, i) => (
            <div key={i}>
              <div className="text-emerald-400">&gt; {l.q}</div>
              <div className="text-slate-300 whitespace-pre-wrap break-all">{l.a}</div>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 border-t border-slate-800 p-2">
          <input
            value={cmd}
            onChange={e => setCmd(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') run() }}
            placeholder="type a command + Enter"
            className="flex-1 form-input rounded bg-slate-800 border-slate-700 text-slate-200 text-xs py-1 font-mono"
          />
          <button onClick={() => run()} disabled={busy}
            className="px-3 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-xs font-medium disabled:opacity-50">
            {busy ? '…' : 'Send'}
          </button>
        </div>
        <div className="flex flex-wrap gap-1 px-2 pb-2">
          {quick.map(q => (
            <button key={q} onClick={() => run(q)} disabled={busy}
              className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-slate-300 disabled:opacity-50">
              {q}
            </button>
          ))}
        </div>
      </div>
      <p className="text-[10px] text-slate-600 mt-1">
        Runs against the live server over RCON (internal ClusterIP). Effects are immediate; some
        (e.g. op) persist, others are runtime-only until restart.
      </p>
    </div>
  )
}

const LOG_REFRESH_MS = 5000

function LogViewer({ namespace, name }) {
  const [logs, setLogs] = useState(null)
  const [pod, setPod] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [auto, setAuto] = useState(true)
  const scrollRef = useRef(null)
  // Track whether the user is at/near the bottom of the log box. If they
  // scrolled up to read older lines, auto-refresh must NOT snap them back.
  const stickRef = useRef(true)

  const fetchLogs = useCallback(() => {
    setLoading(true)
    setError('')
    api.get(`/games/instances/${namespace}/${name}/logs?tail=150`)
      .then(r => { setLogs(r.data.logs); setPod(r.data.pod) })
      .catch(e => setError(e.response?.data?.detail || e.message))
      .finally(() => setLoading(false))
  }, [namespace, name])

  useEffect(() => { fetchLogs() }, [fetchLogs])
  // Scroll only the INNER container, and only if we were already at the
  // bottom. Never `scrollIntoView` — that scrolls the whole page and yanks
  // the operator off the buttons above on every auto-refresh tick.
  useEffect(() => {
    const el = scrollRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  }, [logs])
  const onScroll = (e) => {
    const el = e.currentTarget
    stickRef.current = el.scrollHeight - (el.scrollTop + el.clientHeight) < 32
  }

  // Auto-refresh the tail at a fixed rate. Pauses when the tab is hidden
  // so it doesn't poll in the background.
  useEffect(() => {
    if (!auto) return
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') fetchLogs()
    }, LOG_REFRESH_MS)
    return () => clearInterval(id)
  }, [auto, fetchLogs])

  return (
    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950">
      <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800">
        <span className="text-xs text-slate-400">Logs {pod ? `— ${pod}` : ''}</span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer select-none">
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)}
              className="form-checkbox h-3 w-3 rounded border-slate-700 bg-slate-800" />
            Auto ({LOG_REFRESH_MS / 1000}s)
          </label>
          <button onClick={fetchLogs} disabled={loading} className="text-xs text-slate-500 hover:text-slate-300 disabled:opacity-50">
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>
      {error ? (
        <p className="p-3 text-xs text-rose-400">{error}</p>
      ) : (
        <pre ref={scrollRef} onScroll={onScroll}
          className="p-3 text-xs text-slate-300 overflow-auto max-h-64 whitespace-pre-wrap font-mono">
          {logs ?? 'Loading…'}
        </pre>
      )}
    </div>
  )
}

// Diagnostics surfaces Deployment conditions + recent Kubernetes Events
// (FailedScheduling "Insufficient memory", FailedMount, ImagePullBackOff,
// OOMKilled, …) so the operator can see why an instance didn't come up
// without dropping to kubectl. Auto-opens when the instance is unhealthy.
function Diagnostics({ namespace, name, unhealthy }) {
  const [data, setData] = useState(null)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    api.get(`/games/instances/${namespace}/${name}/events`)
      .then(r => { setData(r.data); setError('') })
      .catch(e => setError(e.response?.data?.detail || e.message || 'failed'))
  }, [namespace, name])

  useEffect(() => { load() }, [load])
  useEffect(() => { if (unhealthy) setOpen(true) }, [unhealthy])

  const warnings = (data?.events || []).filter(e => e.type === 'Warning').length
  const badConds = (data?.conditions || []).filter(
    c => (c.type === 'Available' && c.status !== 'True')).length
  const flag = warnings > 0 || badConds > 0

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-slate-200"
      >
        <span>{open ? '▾' : '▸'}</span>
        Diagnostics
        {flag && (
          <span className="rounded px-1.5 py-0.5 bg-rose-900/50 text-rose-300 text-[10px]">
            {warnings > 0 ? `${warnings} warning${warnings !== 1 ? 's' : ''}` : 'unavailable'}
          </span>
        )}
        <span className="text-slate-600">·</span>
        <span onClick={(e) => { e.stopPropagation(); load() }} className="text-slate-500 hover:text-slate-300">refresh</span>
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2 space-y-2">
          {error && <p className="text-xs text-rose-400">Couldn't load diagnostics: {error}</p>}

          {data?.conditions?.length > 0 && (
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Deployment</p>
              {data.conditions.map((c, i) => (
                <div key={i} className="text-xs flex gap-2 py-0.5">
                  <span className={`font-mono ${c.status === 'True' ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {c.type}={c.status}
                  </span>
                  <span className="text-slate-400">
                    {c.reason}{c.message ? ` — ${c.message}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          <div>
            <p className="text-[11px] uppercase tracking-wide text-slate-500 mb-1">Recent events</p>
            {data?.events?.length ? (
              <div className="space-y-0.5 max-h-56 overflow-auto">
                {data.events.map((e, i) => (
                  <div key={i} className="text-xs flex gap-2">
                    <span className={e.type === 'Warning' ? 'text-amber-400' : 'text-slate-500'}>
                      {e.type === 'Warning' ? '⚠' : '•'}
                    </span>
                    <span className="font-mono text-slate-400 shrink-0">{e.reason}</span>
                    <span className="text-slate-300 break-all">
                      {e.message}
                      {e.count > 1 && <span className="text-slate-500"> (×{e.count})</span>}
                      <span className="text-slate-600"> · {e.object}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500">No recent events.</p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// CopyPath — a labelled, monospace path with a one-click copy chip. Used by the
// mod-guide panel so operators can grab an exact on-disk location without
// hand-retyping the storage path.
function CopyPath({ path }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (await copyText(path)) { setCopied(true); setTimeout(() => setCopied(false), 1500) }
  }
  return (
    <button
      onClick={copy}
      title="Copy path"
      className={`group inline-flex items-center gap-1.5 w-full text-left text-[11px] font-mono border rounded px-2 py-1 transition-colors ${
        copied ? 'bg-emerald-900/60 border-emerald-700 text-emerald-200' : 'bg-slate-800/60 hover:bg-slate-800 border-slate-700 text-slate-300'
      }`}
    >
      <span className="flex-1 break-all">{path}</span>
      <span className="text-[10px] font-sans shrink-0">{copied ? '✓ Copied!' : '⧉'}</span>
    </button>
  )
}

// SptModGuide — SPT/Fika only. Makes it obvious on the details page where server
// vs client mods go on disk, and how player mod-sync (NARCONet) works. The paths
// are derived from the live storage location so they're copy-paste correct for
// this exact instance. Mirrors docs/SPT_FIKA_MODSYNC.md.
const NARCONET_ZIP = 'https://gitlab.com/api/v4/projects/80043430/packages/generic/narconet/1.0.16/NarcoNet-v1.0.16.zip'
const FIKA_RELEASES = 'https://github.com/project-fika/Fika-Plugin/releases'
function SptModGuide({ storage, address }) {
  // storage is "<server>:<path>" (NFS) or "<path> (local)". The SPT install
  // roots at <path>/SPT (the zhliau image), so mods live under there.
  const base = (storage || '<your storage location>').replace(/ \(local\)$/, '')
  const serverMods = `${base}/SPT/user/mods/`
  const clientMods = `${base}/SPT/BepInEx/plugins/`
  const connect = address ? `https://${address}` : 'https://<server-address>:6969'
  return (
    <div className="mt-3 rounded-lg border border-indigo-900/50 bg-indigo-950/20 p-3 space-y-3">
      <p className="text-xs font-semibold text-indigo-200">Mods &amp; player sync</p>

      {/* Where mods go on disk */}
      <div className="space-y-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Where to put mods (on this server's storage)</p>
        <div className="space-y-1">
          <p className="text-[11px] text-slate-400">
            <span className="text-slate-300 font-medium">Server mods</span> — traders, loot, backend logic (a folder with <span className="font-mono">package.json</span> + a <span className="font-mono">.dll</span>):
          </p>
          <CopyPath path={serverMods} />
        </div>
        <div className="space-y-1">
          <p className="text-[11px] text-slate-400">
            <span className="text-slate-300 font-medium">Client mods</span> — BepInEx plugins players run (the client half of any mod):
          </p>
          <CopyPath path={clientMods} />
        </div>
        <p className="text-[11px] text-slate-500 italic">
          Drop the mod folder into the matching path on your NFS/local share, then <span className="not-italic text-slate-400">Restart</span> this server. No image rebuild.
        </p>
      </div>

      {/* What each player installs */}
      <div className="space-y-2 border-t border-indigo-900/40 pt-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">What each player installs (one-time)</p>
        <p className="text-[11px] text-slate-400">
          To join this server a player needs <span className="text-slate-300">two client mods</span> on top of their own SPT install — <span className="text-slate-300">Fika</span> (co-op) and <span className="text-slate-300">NARCONet</span> (mod sync). Both are BepInEx plugins, so setup is <span className="text-slate-300">identical on Windows &amp; Linux/Proton</span> — no <span className="font-mono">.exe</span>.
        </p>
        <ol className="list-decimal ml-4 space-y-1.5 text-[11px] text-slate-400">
          <li>
            <span className="text-slate-300 font-medium">SPT</span> — a working SPT install on their own legal EFT copy, on the <span className="text-slate-300">same SPT version this server runs</span> (see the image tag in this instance's deploy config).
          </li>
          <li>
            <span className="text-slate-300 font-medium">Fika client</span> (co-op) — download the Fika release that matches that SPT/EFT version and copy its <span className="font-mono">BepInEx/</span> contents into their SPT folder:{' '}
            <a href={FIKA_RELEASES} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300 underline break-all">Fika-Plugin releases ↗</a>
          </li>
          <li>
            <span className="text-slate-300 font-medium">NARCONet client</span> (mod sync) — download{' '}
            <a href={NARCONET_ZIP} target="_blank" rel="noreferrer" className="text-sky-400 hover:text-sky-300 underline break-all">NarcoNet-v1.0.16.zip ↗</a>{' '}
            and copy its <span className="font-mono">BepInEx/plugins/MadManBeavis-NarcoNet/</span> folder into their SPT's <span className="font-mono">BepInEx/plugins/</span> (next to Fika). Don't copy the zip's <span className="font-mono">SPT/</span> half — that's the server side, already installed here.
          </li>
          <li>
            Launch SPT and point it at this server: <span className="font-mono text-slate-300">{connect}</span>.
          </li>
        </ol>
        <p className="text-[11px] text-slate-400">
          After that, <span className="text-slate-300">NARCONet handles updates automatically</span>: any client mod you drop in <span className="font-mono">BepInEx/plugins</span> (above) is pushed to every player, who gets an <span className="text-slate-300">“Update Required”</span> prompt on next launch.
        </p>
        <p className="text-[11px] text-amber-300/80">
          Keep the server and all players on matching versions — the <span className="font-medium">same NARCONet version</span>, and Fika/SPT versions that line up with this server.
        </p>
      </div>
    </div>
  )
}

// CompanionRow — a side-service nested inside its parent game card (e.g. the
// CS2 surf-records website). Read-only workload sharing the game's data volume;
// it gets its own live status + Publish control but is not a standalone game.
function CompanionRow({ companion }) {
  const [status, setStatus] = useState(null)
  const loadStatus = useCallback(() => {
    api.get(`/games/instances/${companion.ns}/${companion.name}/status`)
      .then(r => setStatus(r.data))
      .catch(() => setStatus(null))
  }, [companion.ns, companion.name])
  useEffect(() => {
    loadStatus()
    const id = setInterval(() => { if (document.visibilityState === 'visible') loadStatus() }, 5000)
    return () => clearInterval(id)
  }, [loadStatus])
  const kind = companion.labels?.['app.kubernetes.io/component'] || 'companion'
  return (
    <div className="mt-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wide text-indigo-300/80 bg-indigo-950/40 border border-indigo-900 rounded px-1.5 py-0.5">
          Companion · {kind}
        </span>
        <span className="font-medium text-slate-200 text-sm truncate">{companion.name}</span>
        <StatusPill status={status} />
      </div>
      <PublishPanel namespace={companion.ns} name={companion.name} lanAddress={status?.address} />
    </div>
  )
}

function InstanceCard({ inst, game, onScale, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [wipeData, setWipeData] = useState(false)
  // Default ON: a deleted server's ProxyCTL bindings point at a dead
  // ClusterIP — removing them (and their DNS records) is almost always
  // wanted, and re-publishing later is one click, unlike wiped saves.
  const [unpublish, setUnpublish] = useState(true)
  const [wipeConfirm, setWipeConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleted, setDeleted] = useState(false)

  const loadStatus = useCallback(() => {
    api.get(`/games/instances/${inst.ns}/${inst.name}/status`)
      .then(r => setStatus(r.data))
      .catch(() => setStatus(null))
  }, [inst.ns, inst.name])

  useEffect(() => {
    loadStatus()
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') loadStatus()
    }, 5000)
    return () => clearInterval(id)
  }, [loadStatus])

  const desired = status?.desired ?? inst.replicas ?? 1
  const ready = status?.ready ?? inst.readyReplicas ?? 0
  const stopped = desired === 0
  const crashing = status?.color === 'red'

  const handleScale = async (replicas) => {
    setBusy(true)
    await onScale(inst.ns, inst.name, replicas)
    await loadStatus()
    setBusy(false)
  }
  const handleRestart = async () => {
    setBusy(true)
    try {
      await api.post(`/games/instances/${inst.ns}/${inst.name}/restart`)
      await loadStatus()
    } finally {
      setBusy(false)
    }
  }
  const handleDelete = async () => {
    setBusy(true)
    try {
      await onDelete(inst.ns, inst.name, { wipeData, unpublish })
      // Stay disabled after the action — the instance is being torn down;
      // re-clicking would re-fire the delete. The card clears on next refresh.
      setDeleted(true)
    } finally {
      setBusy(false)
    }
  }
  // Wiping NFS data is irreversible — gate it behind a second explicit
  // confirmation. A plain delete (data preserved) proceeds in one step.
  const requestDelete = () => {
    if (wipeData && !wipeConfirm) { setWipeConfirm(true); return }
    handleDelete()
  }
  const cancelDelete = () => {
    setConfirmDelete(false); setWipeData(false); setWipeConfirm(false); setUnpublish(true)
  }

  return (
    <div className={`rounded-xl border ${crashing ? 'border-rose-900/60' : 'border-slate-700'} bg-slate-900/40 transition`}>
      <div className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-slate-100 truncate">{inst.name}</span>
              <span className="text-xs text-slate-500 bg-slate-800 rounded px-1.5 py-0.5">{inst.ns}</span>
              <StatusPill status={status} />
              {(inst.companions || []).length > 0 && (
                <span className="text-[11px] text-indigo-300/80 bg-indigo-950/40 border border-indigo-900 rounded px-1.5 py-0.5">
                  +{inst.companions.length} companion{inst.companions.length > 1 ? 's' : ''}
                </span>
              )}
            </div>
            <div className="mt-2 flex items-center gap-3 flex-wrap text-xs text-slate-500">
              <span>Replicas: <span className="text-slate-300">{ready}/{desired}</span></span>
              <CopyableAddress address={status?.address} />
            </div>
            {status?.storage && (
              <div className="mt-1 text-xs text-slate-500">
                Data: <span className="font-mono text-slate-400 break-all">{status.storage}</span>
              </div>
            )}
            {status?.gameHealth && (
              <div className="mt-1.5">
                <GameHealthLine health={status.gameHealth} />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap w-full sm:w-auto sm:flex-shrink-0 justify-end">
            <button
              onClick={() => setExpanded(v => !v)}
              className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs"
            >
              {expanded ? 'Hide' : 'Details'}
            </button>
            {stopped ? (
              <button disabled={busy || deleted} onClick={() => handleScale(1)}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-medium disabled:opacity-50">
                {busy ? 'Starting…' : 'Start'}
              </button>
            ) : (
              <>
                <button disabled={busy || deleted} onClick={handleRestart}
                  className="px-3 py-1.5 rounded-lg bg-sky-700 hover:bg-sky-600 text-xs font-medium disabled:opacity-50">
                  {busy ? 'Restarting…' : 'Restart'}
                </button>
                <button disabled={busy || deleted} onClick={() => handleScale(0)}
                  className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-medium disabled:opacity-50">
                  {busy ? 'Stopping…' : 'Stop'}
                </button>
              </>
            )}
            <button disabled={busy || deleted} onClick={() => setConfirmDelete(true)}
              className="px-3 py-1.5 rounded-lg bg-rose-900 hover:bg-rose-800 text-xs font-medium disabled:opacity-50">
              Delete
            </button>
          </div>
        </div>

        {confirmDelete && (
          <div className="mt-3 rounded-lg border border-rose-800 bg-rose-950/40 px-4 py-3 space-y-3">
            <p className="text-sm text-rose-300">
              Delete <strong>{inst.name}</strong>? This removes the Deployment, Service, PVC, PV
              {inst.ns === inst.name ? ', and Namespace' : ''}. The cluster sweep waits for resources to terminate before reporting success.
            </p>
            <label className="flex items-start gap-2 text-xs text-rose-200 cursor-pointer">
              <input
                type="checkbox"
                checked={wipeData}
                onChange={e => { setWipeData(e.target.checked); setWipeConfirm(false) }}
                className="mt-0.5 form-checkbox rounded border-rose-700 bg-rose-950 text-rose-500 focus:ring-rose-500"
              />
              <span>
                <span className="font-medium">Also delete NFS data</span>
                <span className="block text-rose-300/70 mt-0.5">
                  Wipes the game's data directory on the NFS server. Off by default — leaving this unchecked preserves saves/world data so redeploying with the same name resumes where you left off.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-rose-200 cursor-pointer">
              <input
                type="checkbox"
                checked={unpublish}
                onChange={e => setUnpublish(e.target.checked)}
                className="mt-0.5 form-checkbox rounded border-rose-700 bg-rose-950 text-rose-500 focus:ring-rose-500"
              />
              <span>
                <span className="font-medium">Also remove ProxyCTL public access</span>
                <span className="block text-rose-300/70 mt-0.5">
                  Deletes this server's ProxyCTL tunnel entries and Cloudflare-Tunnel web routes, including their DNS records, then re-applies ProxyCTL. Runs before the cluster sweep; skipped automatically if nothing is published or ProxyCTL isn't linked.
                </span>
              </span>
            </label>
            {wipeConfirm && (
              <p className="text-xs font-medium text-rose-200 bg-rose-900/40 border border-rose-700 rounded-lg px-3 py-2">
                ⚠️ This permanently erases <strong>{inst.name}</strong>'s saved
                data (worlds/saves) on the NFS server. This cannot be undone.
                Are you sure?
              </p>
            )}
            <div className="flex items-center gap-2">
              <button disabled={busy || deleted} onClick={requestDelete} className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-500 text-xs font-medium disabled:opacity-50">
                {deleted
                  ? 'Deleted ✓'
                  : busy
                    ? 'Deleting…'
                    : wipeConfirm
                      ? 'Yes, permanently delete data'
                      : (wipeData ? 'Delete + Wipe Data' : 'Delete')}
              </button>
              <button disabled={busy || deleted} onClick={cancelDelete} className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 text-xs font-medium disabled:opacity-50">Cancel</button>
            </div>
          </div>
        )}

        {/* When in crash loop, surface the reason inline so the user doesn't have to expand. */}
        {crashing && status?.pods?.[0]?.lastTerminationReason && (
          <div className="mt-3 rounded-lg border border-rose-900/50 bg-rose-950/20 px-3 py-2 text-xs text-rose-300">
            <span className="font-medium">Last crash:</span>{' '}
            {status.pods[0].lastTerminationReason}
            {status.pods[0].lastExitCode != null && status.pods[0].lastExitCode !== 0 && (
              <span className="ml-2 font-mono text-rose-400">exit {status.pods[0].lastExitCode}</span>
            )}
            <span className="ml-2 text-rose-400/80">— expand details for logs</span>
          </div>
        )}
      </div>

      {expanded && (
        <div className="px-4 pb-4 border-t border-slate-800 pt-3">
          {/* Pods */}
          <p className="text-xs font-medium text-slate-400 mb-1">Pods</p>
          {status?.pods?.length ? (
            status.pods.map(p => <PodRow key={p.name} pod={p} />)
          ) : (
            <p className="text-xs text-slate-500">No pods.</p>
          )}

          {/* Diagnostics — why a deploy didn't come up (scheduling, volumes,
              image pulls, OOM) without leaving GameCTL. */}
          <Diagnostics namespace={inst.ns} name={inst.name} unhealthy={ready < desired || crashing} />

          {/* SPT/Fika: where to put server vs client mods + how player sync works */}
          {game?.id === 'spt' && <SptModGuide storage={status?.storage} address={status?.address} />}

          {/* Only renders if THIS instance predates the Recreate fix — a
              Restart on it would deadlock waiting for a second copy of its
              CPU/RAM, so surface it right where Restart lives. */}
          <RestartStrategyNotice namespace={inst.ns} name={inst.name} />

          {/* Networking — LAN (MetalLB) address + ProxyCTL public publishing */}
          <MetricsPanel namespace={inst.ns} name={inst.name} />
          <ReachabilityPanel namespace={inst.ns} name={inst.name} />
          <PublishPanel namespace={inst.ns} name={inst.name} lanAddress={status?.address} />

          {/* Companion side-services (e.g. CS2 surf-records website) — nested
              here rather than listed as their own game cards. Each keeps its
              own status + Publish control. */}
          {(inst.companions || []).length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-slate-400 mb-1">Companion services</p>
              {inst.companions.map(c => <CompanionRow key={`${c.ns}/${c.name}`} companion={c} />)}
            </div>
          )}

          {/* Per-instance settings: auto-update toggle + credentials */}
          <SettingsPanel namespace={inst.ns} name={inst.name} />

          {/* Save backups — schedule, retention, on-demand + restore */}
          <BackupsPanel namespace={inst.ns} name={inst.name} />

          {/* Logs */}
          {!stopped && <LogViewer namespace={inst.ns} name={inst.name} />}
        </div>
      )}
    </div>
  )
}

export default function GameManage({ game, onBack, onDeploy }) {
  const [instances, setInstances] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const intervalRef = useRef(null)

  const load = useCallback(() => {
    api.get(`/games/instances?label_selector=game=${game.id}`)
      .then(r => {
        const deps = r.data.deployments || []
        const svcs = r.data.services || []
        const names = new Set(deps.map(d => d.name))
        // A companion (e.g. the CS2 surf-records website) is a side-service of
        // a game, not its own game. Group it UNDER its parent card. Detected by
        // the explicit gamectl.io/companion-of label (new deploys), or by the
        // `<parent>-records` naming convention when a matching parent exists
        // (so already-running instances group without a redeploy).
        const parentOf = (d) => {
          const co = d.labels?.['gamectl.io/companion-of']
          if (co && names.has(co)) return co
          const m = /^(.+)-records$/.exec(d.name)
          if (m && names.has(m[1])) return m[1]
          return null
        }
        const withSvc = (d) => ({ ...d, service: svcs.find(s => s.ns === d.ns && s.name === d.name) || null })
        const companions = {}
        const parents = []
        for (const d of deps) {
          const p = parentOf(d)
          if (p) (companions[p] ||= []).push(withSvc(d))
          else parents.push(withSvc(d))
        }
        setInstances(parents.map(d => ({ ...d, companions: companions[d.name] || [] })))
        setError('')
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [game.id])

  useEffect(() => {
    load()
    intervalRef.current = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, 10000)
    return () => clearInterval(intervalRef.current)
  }, [load])

  const scale = async (ns, name, replicas) => {
    try {
      await api.patch(`/games/instances/${ns}/${name}/scale`, { replicas })
      await load()
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    }
  }

  const deleteInstance = async (ns, name, { wipeData = false, unpublish = false } = {}) => {
    try {
      const params = new URLSearchParams()
      if (wipeData) params.set('wipe_data', 'true')
      if (unpublish) params.set('unpublish', 'true')
      const qs = params.toString()
      const url = `/games/instances/${ns}/${name}${qs ? `?${qs}` : ''}`
      // Delete is now async: server returns 202 + taskId immediately and
      // runs the sweep in the background. The TasksMenu in the header
      // shows live progress through the namespace-terminate wait. Refresh
      // the instance list a few seconds later so the card disappears.
      const { data } = await api.delete(url)
      const shortId = data?.taskId ? ` (task ${String(data.taskId).slice(0, 8)}…)` : ''
      setNotice(`Delete of ${name} queued${shortId} — track it in the Tasks menu.`)
      setTimeout(() => load(), 2000)
    } catch (e) {
      setError(e.response?.data?.detail || e.message)
    }
  }

  return (
    <div className="max-w-[92rem] mx-auto px-4 py-6">
      <div className="flex items-center gap-4 mb-6">
        <button onClick={onBack} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm">
          ← Back
        </button>
        <ImageWithFallback src={game.icon} alt="" className="h-8 w-8 rounded object-cover" />
        <h2 className="text-2xl font-semibold text-slate-100">{game.name}</h2>
        <button onClick={() => onDeploy(game)} className="ml-auto px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium">
          + Deploy New
        </button>
      </div>

      {notice && (
        <div className="mb-4 rounded-lg border border-sky-800 bg-sky-950/40 px-4 py-3 text-sm text-sky-200 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice('')} className="text-sky-400 hover:text-sky-200 text-xs">dismiss</button>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-rose-800 bg-rose-950/40 px-4 py-3 text-sm text-rose-300">{error}</div>
      )}

      {loading ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-10 text-center">
          <p className="text-sm text-slate-400">Loading {game.name} instances…</p>
        </div>
      ) : instances.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-10 text-center">
          <p className="text-slate-400 mb-4">No {game.name} instances deployed yet.</p>
          <button onClick={() => onDeploy(game)} className="px-5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium">
            Deploy your first server
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {instances.map(inst => (
            <InstanceCard
              key={`${inst.ns}/${inst.name}`}
              inst={inst}
              game={game}
              onScale={scale}
              onDelete={deleteInstance}
            />
          ))}
        </div>
      )}
    </div>
  )
}
