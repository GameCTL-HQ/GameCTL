import { useState } from 'react'

// Sparkline — one small SVG time-series (single series, so no legend; the
// caller names it). Recessive dashed limit line when the usage curve gets
// near it; hover shows the value at the nearest sample. Shared by the
// manage screen's CPU/RAM + reachability panels and the Monitoring page's
// expanded per-instance graphs.
export default function Sparkline({ history, field, limit, format, color = '#38bdf8', height = 56 }) {
  const [hover, setHover] = useState(null)
  const W = 260, H = height, PAD = 2
  const pts = (history || []).map(s => ({ t: s.t, v: s[field] }))
  if (pts.length < 2) {
    return <p className="text-[11px] text-slate-600 flex items-center" style={{ height }}>collecting samples…</p>
  }
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t || t0 + 1
  const vMax = Math.max(limit || 0, ...pts.map(p => p.v)) * 1.08 || 1
  const x = (t) => PAD + (W - 2 * PAD) * (t - t0) / Math.max(1, t1 - t0)
  const y = (v) => H - PAD - (H - 2 * PAD) * (v / vMax)
  const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ')
  const area = `${path} L${x(t1).toFixed(1)},${H - PAD} L${x(t0).toFixed(1)},${H - PAD} Z`
  const showLimit = limit > 0 && limit < vMax

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const t = t0 + (t1 - t0) * Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    let best = pts[0]
    for (const p of pts) if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p
    setHover(best)
  }

  return (
    <div className="relative" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full block" style={{ height }}>
        <path d={area} fill={color} opacity="0.12" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {showLimit && (
          <line x1={PAD} x2={W - PAD} y1={y(limit)} y2={y(limit)}
            stroke="#64748b" strokeWidth="1" strokeDasharray="4 3" />
        )}
        {hover && (
          <>
            <line x1={x(hover.t)} x2={x(hover.t)} y1={PAD} y2={H - PAD} stroke="#475569" strokeWidth="1" />
            <circle cx={x(hover.t)} cy={y(hover.v)} r="3" fill={color} stroke="#0f172a" strokeWidth="1.5" />
          </>
        )}
      </svg>
      {hover && (
        <div className="absolute -top-1 right-0 px-1.5 py-0.5 rounded bg-slate-800 border border-slate-700 text-[10px] text-slate-200 pointer-events-none">
          {format(hover.v)} · {new Date(hover.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </div>
      )}
    </div>
  )
}
