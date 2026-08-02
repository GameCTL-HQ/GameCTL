// Uptime-Kuma-style heartbeat strip (GameCTL port of ProxyCTL's
// HeartbeatBar): a row of evenly time-bucketed bars, green when every
// sample in the bucket was up, red when any weren't. Presentational only —
// the caller fetches history once and feeds each strip `samples` as
// [{t, up}], so one probehistory fetch can drive both the in-cluster and
// the LB strip without duplicate polling.
//
// compact mode (for hub cards): a bare bar row, no "% reachable" caption
// and no time axis — the label + the color already say "up/down at a
// glance" in the tiny space a card allows.
export default function HeartbeatStrip({ samples, hours, maxBars = 50, compact = false }) {
  const now = Date.now() / 1000
  const windowStart = now - hours * 3600
  const all = samples || []

  if (all.length === 0) {
    return <p className="text-[11px] text-slate-600">collecting samples…</p>
  }

  // Always span the FULL requested window, filling buckets that have no
  // samples with grey. Anchoring to the oldest sample instead (so bars grew
  // in from the left) meant the graph rescaled itself for the first ~20
  // minutes of history — bars multiplying and narrowing on every refresh —
  // and every card showed a different-length strip. A fixed window is
  // stable, lines up across cards and panels, and says "1h, partly filled"
  // honestly rather than silently redefining its own scale.
  const start = windowStart
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

  // 2 labels (span start → now) when compact or when there are too few bars
  // for more to line up under; 4 spread across a full-width strip.
  const axisCount = compact || barCount < 12 ? 2 : 4
  const axisTimes = Array.from({ length: axisCount }, (_, i) => start + (now - start) * (i / (axisCount - 1)))
  // Always fill the container. This used to cap the width so a
  // short history rendered as a neat left-aligned strip rather than a few
  // huge slabs — but in practice it just looked broken: on a hub card the
  // strip sat above full-width CPU/RAM lines at about a third their width,
  // and on the manage screen it was a stub floating in an empty panel.
  // Bars are flex-1, so fewer buckets simply means wider bars, and the
  // graph lines up with everything around it.
  const stripWidth = '100%'

  // Hover raises + brightens the bucket and opens a styled tooltip. The
  // native `title` this replaces was correct but unreadable in practice —
  // ~1s delay, OS chrome, and no colour to tell an up bucket from a down
  // one at the moment you're hovering to find exactly that. origin-bottom
  // grows the bar upward off its baseline instead of expanding both ways.
  const tipText = (b) =>
    b.state === 'empty' ? 'no samples'
      : b.state === 'up' ? `up · ${b.total} check${b.total === 1 ? '' : 's'}`
        : `down · ${b.down}/${b.total} failed`
  const tipDot = (state) =>
    state === 'up' ? 'bg-emerald-400' : state === 'down' ? 'bg-rose-400' : 'bg-slate-600'
  const tipCls = (state) =>
    state === 'up' ? 'text-emerald-300' : state === 'down' ? 'text-rose-300' : 'text-slate-400'

  const bars = (
    <div className={`flex gap-0.5 items-stretch ${compact ? 'h-4' : 'h-7'}`}>
      {buckets.map((b, i) => (
        <div key={i} className="group/hb relative flex flex-1 items-stretch">
          <div
            className={`flex-1 rounded-sm origin-bottom transition-transform duration-150
              group-hover/hb:-translate-y-[3px] group-hover/hb:scale-y-[1.15] group-hover/hb:brightness-125
              ${bg(b.state)} ${b.state === 'empty' ? 'opacity-50' : ''}`}
          />
          <span
            className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden
              -translate-x-1/2 whitespace-nowrap rounded-lg border border-slate-700 bg-slate-900
              px-2.5 py-1.5 shadow-lg shadow-black/50 group-hover/hb:block"
          >
            <span className="block text-[10px] tabular-nums text-slate-400">
              {fmtTime(b.start)}–{fmtTime(b.end)}
            </span>
            <span className={`mt-0.5 flex items-center gap-1.5 text-[11px] font-semibold ${tipCls(b.state)}`}>
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${tipDot(b.state)}`} />
              {tipText(b)}
            </span>
          </span>
        </div>
      ))}
    </div>
  )

  // Always-visible time axis (not only on hover), inside the same
  // width-capped wrapper as the bars so labels line up with the strip
  // rather than the page.
  const axis = (
    <div className={`flex justify-between mt-0.5 ${compact ? 'gap-1.5' : 'gap-2.5'}`}>
      {axisTimes.map((t, i) => (
        <span key={i} className={`${compact ? 'text-[9px]' : 'text-[10px]'} text-slate-400 whitespace-nowrap`}>
          {fmtAxis(t)}
        </span>
      ))}
    </div>
  )

  if (compact) {
    return <div style={{ width: stripWidth }}>{bars}{axis}</div>
  }

  return (
    <div>
      <p className="text-[11px] text-slate-500 mb-1">
        <span className={pctCls}>{pct ?? '—'}%</span> reachable
      </p>
      <div style={{ width: stripWidth }}>
        {bars}
        {axis}
      </div>
    </div>
  )
}
