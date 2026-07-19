import { useEffect, useState } from 'react'
import { api } from '../api/client'

export default function Monitor({ defaultAddr = '10.0.0.220:27015' }) {
  const [addr, setAddr] = useState(defaultAddr)
  const [data, setData] = useState(null)
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)

  const load = async () => {
    setLoading(true); setMsg('')
    try {
      const { data } = await api.get('/games/steam/status', { params: { addr } })
      setData(data)
    } catch (err) {
      setMsg(err.message)
      setData(null)
    } finally { setLoading(false) }
  }

  useEffect(() => { /* optional auto-load */ }, [])

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      <h2 className="text-lg font-semibold mb-4">Game Server Monitor</h2>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          className="form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100"
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          placeholder="host:port"
        />
        <button
          onClick={load}
          disabled={loading}
          className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-50"
        >
          {loading ? 'Querying…' : 'Query'}
        </button>
      </div>

      {msg && <div className="text-sm text-rose-400 mb-2">{msg}</div>}

      {!data && !msg && (
        <p className="text-sm text-slate-400">
          {loading ? 'Querying server…' : 'Enter a host:port and click Query to inspect a live game server.'}
        </p>
      )}

      {data && (
        <div className="space-y-3">
          <div className="text-sm text-slate-300">Address: {data.addr}</div>
          <div className="text-sm text-slate-300">Latency: {data.latency_ms} ms</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <div className="font-semibold mb-2">Info</div>
              <dl className="text-sm text-slate-300 space-y-1">
                <div className="flex justify-between"><dt className="text-slate-400">Name</dt><dd>{data.info?.name || '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-400">Map</dt><dd>{data.info?.map || '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-400">Players</dt><dd>{data.info?.players ?? '—'} / {data.info?.max_players ?? '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-400">Game</dt><dd>{data.info?.game || '—'}</dd></div>
                <div className="flex justify-between"><dt className="text-slate-400">Version</dt><dd>{data.info?.version || '—'}</dd></div>
              </dl>
            </div>

            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <div className="font-semibold mb-2">Players ({data.players?.length || 0})</div>
              {data.players && data.players.length > 0 ? (
                <ul className="text-sm text-slate-300 space-y-1">
                  {data.players.map((p, i) => (
                    <li key={i} className="flex justify-between">
                      <span className="truncate">{p.name || 'unknown'}</span>
                      <span className="text-slate-400">score {p.score ?? '—'}, {Math.floor(p.duration ?? 0)}s</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="text-sm text-slate-400">No players.</div>
              )}
            </div>
          </div>

          {data.rules && Object.keys(data.rules).length > 0 && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
              <div className="font-semibold mb-2">Rules</div>
              <div className="text-xs text-slate-400 grid sm:grid-cols-2 gap-x-4">
                {Object.entries(data.rules).slice(0, 50).map(([k, v]) => (
                  <div key={k} className="flex justify-between"><span>{k}</span><span className="ml-2 text-slate-300">{String(v)}</span></div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
