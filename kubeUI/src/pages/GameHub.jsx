import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { games } from '../wizard/gameSchemas'
import ImageWithFallback from '../components/ImageWithFallback'

export default function GameHub({ onSelectGame }) {
  const [instances, setInstances] = useState({ deployments: [], services: [] })
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.get('/games/instances')
      .then(r => setInstances(r.data))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  function runningCount(gameId) {
    return instances.deployments.filter(d => d.labels?.game === gameId).length
  }

  // Deployable card (clickable → wizard/manage).
  function GameCard(game) {
    const count = runningCount(game.id)
    return (
      <button
        key={game.id}
        onClick={() => onSelectGame(game)}
        className="group relative overflow-hidden rounded-xl border border-slate-700 bg-slate-900 hover:border-slate-500 hover:bg-slate-800 transition-all text-left"
      >
        <div className="h-36 bg-slate-800 overflow-hidden">
          <ImageWithFallback
            src={game.cover}
            fallbackSrc="/brand/tiles/cover-fallback.png"
            alt={game.name}
            className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
          />
        </div>
        {!loading && count > 0 && (
          <span className="absolute top-2 right-2 inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border bg-emerald-950 text-emerald-300 border-emerald-900">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400"></span>
            {count} running
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
  const available = games.filter(g => !g.comingSoon)
  const comingSoon = games.filter(g => g.comingSoon)
  const running = available.filter(g => runningCount(g.id) > 0)

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

      {/* Available to deploy */}
      <section>
        <h2 className="text-2xl font-semibold mb-1 text-slate-100">Available</h2>
        <p className="text-sm text-slate-400 mb-4">
          Game servers you can deploy now.
        </p>
        <div className={grid}>{available.map(GameCard)}</div>
      </section>

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
