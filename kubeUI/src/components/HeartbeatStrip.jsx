// Uptime-Kuma-style heartbeat strip (GameCTL port of ProxyCTL's
// HeartbeatBar): a row of evenly time-bucketed bars, green when every
// sample in the bucket was up, red when any weren't. Presentational only —
// the caller fetches history once and feeds each strip `samples` as
// [{t, up}], so one probehistory fetch can drive both the in-cluster and
// the LB strip without duplicate polling.
export default function HeartbeatStrip({ samples, hours, maxBars = 50 }) {
  const now = Date.now() / 1000
  const windowStart = now - hours * 3600
  const all = samples || []

  if (all.length === 0) {
    return <p className="text-[11px] text-slate-600">collecting samples…</p>
  }

  // Anchor to the oldest sample on hand (never earlier than the window) so
  // bars fill from the left as history accumulates, and floor the bucket
  // size at the 30s sample cadence so sparse history renders as a compact
  // strip instead of scattered slivers — same logic as ProxyCTL's bar.
  const earliest = all[0].t
  const start = Math.max(windowStart, Math.min(earliest, now - 30))
  const span = Math.max(30, now - start)
  const bucketSize = Math.max(30, span / maxBars)
  const barCount = Math.max(1, Math.min(maxBars, Math.ceil(span / bucketSize)))

  const buckets = Array.from({ length: barCount }, (_, i) => {
    const bStart = start + i * bucketSize
    const bEnd = bStart + bucketSize
    const s = all.filter(x => x.t >= bStart && x.t < bEnd)
    if (s.length === 0) return { state: 'empty', start: bStart, end: bEnd, down: 0, total: 0 }
    const down = s.filter(x => !x.up).length
    return { state: down > 0 ? 'down' : 'up', start: bStart, end: bEnd, down, total: s.length }
  })

  const known = all.filter(s => s.t >= start)
  const pct = known.length ? Math.round(100 * known.filter(s => s.up).length / known.length) : null
  const pctCls = pct === null ? 'text-slate-500' : pct === 100 ? 'text-emerald-400' : pct >= 95 ? 'text-amber-400' : 'text-rose-400'
  const bg = (state) => state === 'up' ? 'bg-emerald-500' : state === 'down' ? 'bg-rose-500' : 'bg-slate-800'

  const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const fmtAxis = hours > 72
    ? (t) => new Date(t * 1000).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : hours > 6
      ? (t) => new Date(t * 1000).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })
      : fmtTime

  const axisCount = barCount < 12 ? 2 : 4
  const axisTimes = Array.from({ length: axisCount }, (_, i) => start + (now - start) * (i / (axisCount - 1)))
  const stripWidth = `min(100%, ${barCount * 14}px)`

  return (
    <div>
      <p className="text-[11px] text-slate-500 mb-1">
        <span className={pctCls}>{pct ?? '—'}%</span> reachable
      </p>
      <div style={{ width: stripWidth }}>
        <div className="flex gap-0.5 items-stretch h-7">
          {buckets.map((b, i) => (
            <div
              key={i}
              title={`${fmtTime(b.start)}–${fmtTime(b.end)}: ${b.state === 'empty' ? 'no samples' : b.state === 'up' ? 'all checks reachable' : `${b.down}/${b.total} checks unreachable`}`}
              className={`flex-1 rounded-sm ${bg(b.state)} ${b.state === 'empty' ? 'opacity-50' : ''}`}
            />
          ))}
        </div>
        <div className="flex justify-between gap-2.5 mt-0.5">
          {axisTimes.map((t, i) => (
            <span key={i} className="text-[9px] text-slate-600 whitespace-nowrap">{fmtAxis(t)}</span>
          ))}
        </div>
      </div>
    </div>
  )
}
