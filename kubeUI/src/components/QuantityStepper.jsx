// QuantityStepper — a big, obvious −/+ numeric control for CPU and RAM.
//
// Replaces the free-text Quantity inputs on the manage screen. The value is
// a plain integer (millicores or MiB); the caller converts to/from the
// Kubernetes string with utils/quantity.js, so a malformed "#Gi" can't be
// typed in the first place. Typing is still allowed for large jumps, but
// the input is type=number and is clamped on blur.
export default function QuantityStepper({
  label,
  value,
  onChange,
  step,
  min,
  max,
  unit,       // suffix shown inside the field, e.g. "m" or "MiB"
  precision = 0, // decimals kept on blur — 1 for a 0.5-step field, 0 for whole units
  human,      // secondary line, e.g. "0.5 of a core"
  warn,       // optional warning string shown under the control
}) {
  const round = (n) => {
    const f = 10 ** precision
    return Math.round(n * f) / f
  }
  const clamp = (n) => round(Math.min(max, Math.max(min, n)))
  // Snap to the step grid so repeated clicks stay on round numbers even if
  // the deployed value started off-grid (e.g. an imported 300m request).
  const bump = (dir) => {
    const next = dir > 0
      ? Math.floor(value / step) * step + step
      : Math.ceil(value / step) * step - step
    onChange(clamp(next))
  }

  const btn = 'h-11 w-11 shrink-0 rounded-lg border border-slate-700 bg-slate-800 text-lg font-semibold ' +
    'text-slate-200 hover:bg-slate-700 active:bg-slate-600 disabled:opacity-30 disabled:hover:bg-slate-800'

  return (
    <div>
      {label && <p className="mb-1.5 text-xs font-medium text-slate-300">{label}</p>}
      <div className="flex items-stretch gap-2">
        <button type="button" onClick={() => bump(-1)} disabled={value <= min} className={btn} aria-label={`Decrease ${label}`}>−</button>
        <div className="relative flex-1">
          <input
            type="number"
            inputMode="numeric"
            value={value}
            step={step}
            min={min}
            max={max}
            onChange={e => {
              const n = Number(e.target.value)
              if (Number.isFinite(n)) onChange(n)
            }}
            onBlur={e => onChange(clamp(Number(e.target.value) || min))}
            className="h-11 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 pr-12 text-center
                       text-base font-semibold text-slate-100 focus:border-sky-600 focus:outline-none"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">
            {unit}
          </span>
        </div>
        <button type="button" onClick={() => bump(1)} disabled={value >= max} className={btn} aria-label={`Increase ${label}`}>+</button>
      </div>
      <p className="mt-1 text-center text-[11px] text-slate-500">{human}</p>
      {warn && <p className="mt-1 text-center text-[11px] text-amber-400">{warn}</p>}
    </div>
  )
}
