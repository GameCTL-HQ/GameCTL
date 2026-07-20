import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { games } from '../wizard/gameSchemas'
import ImageWithFallback from '../components/ImageWithFallback'

export default function GameHub({ onSelectGame }) {
  const [instances, setInstances] = useState({ deployments: [], services: [] })
  const [loading, setLoading] = useState(true)
  const [metrics, setMetrics] = useState({ available: false, instances: [] })

  useEffect(() => {
    api.get('/games/instances')
      .then(r => setInstances(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // Live resource pressure (30s samples from the backend's monitor).
  useEffect(() => {
    const load = () => api.get('/games/metrics').then(r => setMetrics(r.data)).catch(() => {})
    load()
    const t = setInterval(load, 30000)
    return () => clearInterval(t)
  }, [])

  // Companions (e.g. the CS2 surf-records site) are side-services of a game,
  // not their own instance — don't count them as running games.
  const isCompanion = (d) =>
    d.labels?.['app.kubernetes.io/component'] === 'records' ||
    !!d.labels?.['gamectl.io/companion-of'] ||
    /-records$/.test(d.name)

  function runningCount(gameId) {
    return instances.deployments.filter(d => d.labels?.game === gameId && !isCompanion(d)).length
  }

  const gameOfInstance = (name) =>
    instances.deployments.find(d => d.name === name)?.labels?.game

  const alerting = (metrics.instances || []).filter(i => (i.alerts || []).length > 0)

  // Worst pressure alert among a game's instances, for the card chip.
  function gameAlert(gameId) {
    let worst = null
    for (const i of alerting) {
      if (gameOfInstance(i.name) !== gameId) continue
      if (i.alerts.includes('oom') || i.alerts.includes('mem')) return i
      worst = worst || i
    }
    return worst
  }

  const alertText = (i) => {
    if (i.alerts.includes('oom')) return 'was OOM-killed in the last hour — raise its memory limit'
    if (i.alerts.includes('mem')) return `RAM at ${i.maxMemPct}% of its limit — OOM-kill risk`
    return `CPU at ${i.maxCpuPct}% of its limit — being throttled`
  }

  // ProxyCTL pairing — surfaced on the home page so operators don't discover
  // the link flow only when they first pick "Internet only" in the wizard.
  const [pctl, setPctl] = useState(null)
  const [pctlForm, setPctlForm] = useState({ url: '', username: '', password: '' })
  const [pctlOpen, setPctlOpen] = useState(false)
  const [pctlBusy, setPctlBusy] = useState(false)
  const [pctlMsg, setPctlMsg] = useState('')
  useEffect(() => {
    api.get('/proxyctl/status')
      .then(r => { setPctl(r.data); setPctlForm(f => ({ ...f, url: f.url || r.data.url || '' })) })
      .catch(() => {})
  }, [])
  const linkPctl = async () => {
    setPctlBusy(true); setPctlMsg('')
    try {
      await api.put('/proxyctl/link', pctlForm)
      setPctl(p => ({ ...p, linked: true, username: pctlForm.username }))
      setPctlForm(f => ({ ...f, password: '' }))
      setPctlMsg('Linked ✓ — every server\'s Networking panel can now publish.')
    } catch (e) {
      setPctlMsg('✗ ' + (e.response?.data?.detail || e.response?.data?.error || e.message))
    } finally {
      setPctlBusy(false)
    }
  }

  function ProxyCTLCard() {
    if (!pctl) return null
    if (pctl.linked) {
      return (
        <p className="text-xs text-slate-500">
          <span className="text-emerald-400">●</span> ProxyCTL linked
          {pctl.username ? <> as <span className="text-slate-300">{pctl.username}</span></> : null}
          {' '}— publish any server from its Networking panel.
          {pctlMsg && <span className="ml-2 text-emerald-400">{pctlMsg}</span>}
        </p>
      )
    }
    return (
      <section className="rounded-xl border border-sky-900 bg-sky-950/30 p-4">
        <p className="text-sm font-semibold text-sky-300 mb-1">
          🌐 Put your servers on the internet with ProxyCTL
        </p>
        {pctl.detected ? (
          <p className="text-xs text-slate-300 mb-2.5">
            A ProxyCTL install was detected in your cluster but isn't linked yet.
            Link it once (its operator login) and every server gains one-click
            publishing — public DNS names over a WireGuard tunnel, no router ports opened.
          </p>
        ) : (
          <p className="text-xs text-slate-300 mb-2.5">
            GameCTL pairs with <a href="https://proxyctl.cc" target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">ProxyCTL</a> to
            publish servers publicly: friends connect to a real domain, traffic rides a WireGuard
            tunnel through a small VPS, and your home IP stays hidden — no router ports opened.
            No install detected in this cluster —{' '}
            <a href="https://proxyctl.cc" target="_blank" rel="noreferrer" className="text-sky-400 hover:underline">
              deploy it from proxyctl.cc ↗
            </a>{' '}(one command), then link it below.
          </p>
        )}
        {!pctlOpen ? (
          <button onClick={() => setPctlOpen(true)}
            className="px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-xs text-white font-medium">
            {pctl.detected ? 'Link ProxyCTL' : 'Connect an existing install'}
          </button>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <p className="text-[11px] text-slate-500 mb-1">ProxyCTL URL</p>
              <input value={pctlForm.url} onChange={e => setPctlForm(f => ({ ...f, url: e.target.value }))}
                placeholder="http://proxyctl.proxyctl.svc"
                className="w-56 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" />
            </div>
            <div>
              <p className="text-[11px] text-slate-500 mb-1">Username</p>
              <input value={pctlForm.username} onChange={e => setPctlForm(f => ({ ...f, username: e.target.value }))}
                className="w-32 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" />
            </div>
            <div>
              <p className="text-[11px] text-slate-500 mb-1">Password</p>
              <input type="password" value={pctlForm.password} onChange={e => setPctlForm(f => ({ ...f, password: e.target.value }))}
                className="w-32 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-xs text-slate-200" />
            </div>
            <button disabled={pctlBusy || !pctlForm.username || !pctlForm.password} onClick={linkPctl}
              className="px-3 py-1.5 rounded bg-sky-700 hover:bg-sky-600 disabled:opacity-40 text-xs text-white font-medium">
              {pctlBusy ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        )}
        {pctlMsg && <p className={`mt-2 text-xs ${pctlMsg.startsWith('✗') ? 'text-rose-400' : 'text-emerald-400'}`}>{pctlMsg}</p>}
        <p className="mt-2 text-[11px] text-slate-500">
          The login is stored as a Secret in your cluster and verified before saving.
        </p>
      </section>
    )
  }

  // FLIP: tiles keep stable keys, so filtering never remounts a survivor.
  // After each render we diff every tile's rect against where it was last
  // frame — moved tiles slide from their old spot to the new one, tiles
  // without a previous rect (newly matching, or first page load) fade in.
  // Non-matching tiles simply unmount; the survivors gliding into the gap
  // carry the motion.
  const tileNodes = useRef(new Map()) // id -> element (live tiles this render)
  const tileRects = useRef(new Map()) // id -> DOMRect from the previous layout
  const tileRef = (id) => (el) => {
    if (el) tileNodes.current.set(id, el)
    else tileNodes.current.delete(id)
  }
  useLayoutEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const prev = tileRects.current
    const next = new Map()
    let entering = 0
    for (const [id, el] of tileNodes.current) {
      const r = el.getBoundingClientRect()
      next.set(id, r)
      if (reduce || !el.animate) continue
      const p = prev.get(id)
      if (p) {
        const dx = p.left - r.left
        const dy = p.top - r.top
        if (dx || dy) {
          el.animate(
            [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
            { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
          )
        }
      } else {
        el.animate(
          // No final opacity: it eases back to the tile's own resting value
          // (coming-soon cards sit at 0.5, not 1).
          [{ opacity: 0, transform: 'translateY(12px) scale(0.95)' }, { transform: 'none' }],
          {
            duration: 320,
            delay: Math.min(entering++ * 35, 350),
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
            fill: 'backwards',
          },
        )
      }
    }
    tileRects.current = next
  })

  // Deployable card (clickable → wizard/manage).
  function GameCard(game) {
    const count = runningCount(game.id)
    const alert = !loading ? gameAlert(game.id) : null
    return (
      <button
        key={game.id}
        ref={tileRef(game.id)}
        onClick={() => onSelectGame(game)}
        className="group relative overflow-hidden rounded-xl border border-slate-700 bg-slate-900 hover:border-slate-500 hover:bg-slate-800 hover:-translate-y-1 transition-all text-left"
      >
        <div className="h-36 bg-slate-800 overflow-hidden">
          <ImageWithFallback
            src={game.cover}
            fallbackSrc="/brand/tiles/cover-fallback.png"
            alt={game.name}
            className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
          />
        </div>
        {!loading && count > 0 && !alert && (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border bg-emerald-950 text-emerald-300 border-emerald-900">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
            {count} running
          </span>
        )}
        {alert && (
          <span
            title={`${alert.name}: ${alertText(alert)}`}
            className={`absolute top-2 right-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border ${
              alert.alerts.includes('mem') || alert.alerts.includes('oom')
                ? 'bg-rose-950 text-rose-300 border-rose-900'
                : 'bg-amber-950 text-amber-300 border-amber-900'
            }`}
          >
            ⚠ {alert.alerts.includes('oom') ? 'OOM' : alert.alerts.includes('mem') ? `RAM ${alert.maxMemPct}%` : `CPU ${alert.maxCpuPct}%`}
          </span>
        )}
        <div className="p-3">
          <div className="flex items-center gap-2">
            <ImageWithFallback
              src={game.icon}
              fallbackSrc={`/brand/tiles/icon-${game.id}.png`}
              alt=""
              className="h-6 w-6 rounded object-cover flex-shrink-0"
            />
            <span className="font-medium text-slate-100 text-sm truncate">{game.name}</span>
          </div>
          {!loading && (
            <p className="mt-1 text-xs text-slate-400">
              {count > 0 ? `${count} instance${count !== 1 ? 's' : ''} running` : 'No instances running'}
            </p>
          )}
        </div>
      </button>
    )
  }

  // Locked card (no working image yet) — greyed, non-interactive.
  function ComingSoonCard(game) {
    return (
      <div
        key={game.id}
        ref={tileRef(game.id)}
        aria-disabled="true"
        title="Coming soon — not yet available to deploy"
        className="relative overflow-hidden rounded-xl border border-slate-800 bg-slate-900 opacity-50 grayscale cursor-not-allowed select-none text-left"
      >
        <div className="h-36 bg-slate-800 overflow-hidden">
          <ImageWithFallback
            src={game.cover}
            fallbackSrc="/brand/tiles/cover-fallback.png"
            alt={game.name}
            className="w-full h-full object-cover opacity-60"
          />
        </div>
        <span className="absolute top-2 right-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border bg-slate-800 text-slate-300 border-slate-700">
          <span className="h-1.5 w-1.5 rounded-full bg-slate-500"></span>
          Coming soon
        </span>
        <div className="p-3">
          <div className="flex items-center gap-2">
            <ImageWithFallback
              src={game.icon}
              fallbackSrc={`/brand/tiles/icon-${game.id}.png`}
              alt=""
              className="h-6 w-6 rounded object-cover flex-shrink-0"
            />
            <span className="font-medium text-slate-300 text-sm truncate">{game.name}</span>
          </div>
          <p className="mt-1 text-xs text-slate-500">Not yet available to deploy</p>
        </div>
      </div>
    )
  }

  const grid = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

  // Live search across all three sections. A game matches on its display
  // name, its id, or the name of any of its running instances (so typing
  // "cs2-modded" finds Counter-Strike 2 even though the card says CS2).
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matches = (g) =>
    !q ||
    g.name.toLowerCase().includes(q) ||
    g.id.toLowerCase().includes(q) ||
    instances.deployments.some(d => d.labels?.game === g.id && d.name.toLowerCase().includes(q))

  const available = games.filter(g => !g.comingSoon)
  const comingSoon = games.filter(g => g.comingSoon && matches(g))
  const running = available.filter(g => runningCount(g.id) > 0 && matches(g))
  const deployable = available.filter(g => runningCount(g.id) === 0 && matches(g))
  const noResults = q && running.length + deployable.length + comingSoon.length === 0

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 py-8">
        <p className="text-sm text-slate-400">Loading games…</p>
        <div className={`${grid} mt-4`}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-slate-800 bg-slate-900 animate-pulse">
              <div className="h-36 bg-slate-800" />
              <div className="p-3 space-y-2">
                <div className="h-4 w-2/3 rounded bg-slate-800" />
                <div className="h-3 w-1/3 rounded bg-slate-800" />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-10">
      {/* Search — filters running / available / coming-soon as you type */}
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500">🔍</span>
        <input
          type="search"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') setQuery('') }}
          placeholder="Search games — running, available, or coming soon…"
          aria-label="Search games"
          className="w-full rounded-xl border border-slate-700 bg-slate-900 pl-10 pr-9 py-2.5 text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-slate-500"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded px-1.5 py-0.5 text-slate-500 hover:text-slate-300"
          >
            ✕
          </button>
        )}
      </div>

      {/* ProxyCTL pairing — link an install (or point at proxyctl.cc) up front */}
      <ProxyCTLCard />

      {/* Resource pressure alerts — servers running into their CPU/RAM limits */}
      {alerting.length > 0 && (
        <section className="rounded-xl border border-amber-900 bg-amber-950/30 p-4">
          <p className="text-sm font-semibold text-amber-300 mb-1.5">
            ⚠ Resource pressure on {alerting.length} server{alerting.length !== 1 ? 's' : ''}
          </p>
          <ul className="space-y-1">
            {alerting.map(i => (
              <li key={i.namespace + i.name} className="text-xs text-slate-300">
                <span className="font-medium text-slate-100">{i.name}</span>
                {' — '}{alertText(i)}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-slate-500">
            Open the server's manage screen for live usage graphs. Fix by raising the
            instance's CPU/RAM limits (redeploy with bigger resources) or trimming the game's load.
          </p>
        </section>
      )}

      {/* Your running servers — only games you currently have instances for */}
      {!loading && running.length > 0 && (
        <section>
          <h2 className="text-2xl font-semibold mb-1 text-slate-100">Your running servers</h2>
          <p className="text-sm text-slate-400 mb-4">
            Games you currently have server instances for — pick one to manage it.
          </p>
          <div className={grid}>{running.map(GameCard)}</div>
        </section>
      )}

      {/* Available to deploy — games without a running instance yet */}
      {deployable.length > 0 && (
        <section>
          <h2 className="text-2xl font-semibold mb-1 text-slate-100">Available</h2>
          <p className="text-sm text-slate-400 mb-4">
            Game servers you can deploy now.
          </p>
          <div className={grid}>{deployable.map(GameCard)}</div>
        </section>
      )}

      {/* Empty search result */}
      {noResults && (
        <section className="rounded-xl border border-slate-800 bg-slate-900 p-8 text-center">
          <p className="text-sm text-slate-400">
            No games match <span className="text-slate-200">“{query.trim()}”</span>.
          </p>
          <button onClick={() => setQuery('')}
            className="mt-3 px-3 py-1.5 rounded bg-slate-800 hover:bg-slate-700 text-xs text-slate-200">
            Clear search
          </button>
        </section>
      )}

      {/* Coming soon */}
      {comingSoon.length > 0 && (
        <section>
          <h2 className="text-2xl font-semibold mb-1 text-slate-100">Coming soon</h2>
          <p className="text-sm text-slate-400 mb-4">
            Not yet deployable — needs a verified Linux image or a Wine/Proton runtime.
          </p>
          <div className={grid}>{comingSoon.map(ComingSoonCard)}</div>
        </section>
      )}
    </div>
  )
}
