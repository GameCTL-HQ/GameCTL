// Kubernetes quantity <-> plain number helpers.
//
// The resources editor used to take raw Quantity strings ("500m", "4Gi")
// typed by hand, which is very easy to get wrong in ways the API only
// rejects later — "4G" is 4×10⁹ bytes, not 4 GiB; "4gi" and "4 Gi" are
// invalid outright; a bare "4" for memory means 4 BYTES. Editing numbers
// and letting these functions do the formatting removes that whole class
// of mistake.
//
// CPU is carried as integer millicores, memory as integer MiB.

// ---- CPU -------------------------------------------------------------

// parseCPUMillis reads a Quantity as millicores. "500m" → 500, "2" → 2000,
// "1.5" → 1500. Returns null for anything it can't read.
export function parseCPUMillis(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)(m?)$/)
  if (!m) return null
  const n = Number(m[1])
  if (!isFinite(n)) return null
  return Math.round(m[2] === 'm' ? n : n * 1000)
}

// formatCPUMillis emits the canonical Quantity: whole cores lose the
// suffix ("2"), anything else stays in millicores ("500m").
export function formatCPUMillis(milli) {
  const n = Math.max(0, Math.round(Number(milli) || 0))
  return n % 1000 === 0 ? String(n / 1000) : `${n}m`
}

export function humanCPU(milli) {
  const n = Number(milli) || 0
  if (n < 1000) return `${n / 1000} of a core`
  return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 2)} core${n === 1000 ? '' : 's'}`
}

// ---- Memory ----------------------------------------------------------

const MEM_UNITS = {
  '': 1 / (1024 * 1024),          // bare number = bytes
  Ki: 1 / 1024, Mi: 1, Gi: 1024, Ti: 1024 * 1024,
  // Decimal suffixes are a different scale (10³) — a real and easily
  // missed distinction, so convert honestly rather than treating G as Gi.
  K: 1000 / (1024 * 1024), M: (1000 ** 2) / (1024 * 1024),
  G: (1000 ** 3) / (1024 * 1024), T: (1000 ** 4) / (1024 * 1024),
}

// parseMemMiB reads a Quantity as MiB. "1Gi" → 1024, "512Mi" → 512,
// "2G" → 1907. Returns null for anything it can't read.
export function parseMemMiB(v) {
  if (v == null) return null
  const s = String(v).trim()
  if (!s) return null
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T)?$/)
  if (!m) return null
  const n = Number(m[1])
  if (!isFinite(n)) return null
  const mult = MEM_UNITS[m[2] || '']
  return Math.max(0, Math.round(n * mult))
}

// formatMemMiB emits GiB when it divides evenly (the form operators
// actually think in), MiB otherwise.
export function formatMemMiB(mib) {
  const n = Math.max(0, Math.round(Number(mib) || 0))
  return n % 1024 === 0 && n > 0 ? `${n / 1024}Gi` : `${n}Mi`
}

export function humanMem(mib) {
  const n = Number(mib) || 0
  return n % 1024 === 0 && n > 0 ? `${n / 1024} GiB` : `${n} MiB`
}

// ---- JVM-style memory ("4G") ----------------------------------------
//
// Separate from the Kubernetes helpers above on purpose: a game's own
// memory setting (Minecraft's MEMORY env → JVM heap) is written "4G", not
// "4Gi", and its generator parses it with /^(\d+)\s*([GgMm])/. Anything
// that doesn't match — "4 GB", "4gb", a bare "4" — silently falls back to
// the 4G default AND changes the container requests/limits derived from
// it, so a typo here is a resize nobody asked for rather than an error.

// parseJvmGB reads a JVM memory string as whole GB. "4G" → 4,
// "4096M" → 4. Returns null when unreadable.
export function parseJvmGB(v) {
  if (v == null) return null
  const m = String(v).trim().match(/^(\d+)\s*([GgMm])?$/)
  if (!m) return null
  const n = Number(m[1])
  if (!isFinite(n) || n <= 0) return null
  return (m[2] || 'G').toUpperCase() === 'M' ? Math.max(1, Math.round(n / 1024)) : n
}

// formatJvmGB emits exactly what the generators parse.
export function formatJvmGB(gb) {
  return `${Math.max(1, Math.round(Number(gb) || 1))}G`
}

// ---- Memory as Gi (wizard resource fields) ---------------------------
//
// The manage screen edits memory in whole MiB; the deploy wizard works in
// Gi with half-steps, which is how these values are actually reasoned
// about ("give it 1.5Gi"). Kubernetes accepts a fractional binary suffix
// ("1.5Gi" == 1610612736), so this round-trips exactly.

// parseMemGi reads a Quantity as Gi. "512Mi" → 0.5, "2Gi" → 2. Returns
// null when unreadable. Built on parseMemMiB so every suffix it knows
// (including the decimal G/M forms) is understood here too.
export function parseMemGi(v) {
  const mib = parseMemMiB(v)
  if (mib == null) return null
  return mib / 1024
}

// formatMemGi emits Gi, dropping the trailing ".0" on whole values so a
// plain 2Gi doesn't render as "2.0Gi".
//
// Deliberately does NOT snap to the stepper's 0.5 grid: imposing the grid
// here would silently DOUBLE an off-grid default (quake3 ships memReq
// 256Mi = 0.25Gi) the moment the field was touched. The stepper produces
// on-grid values by itself; the formatter's only job is to render exactly
// what it is handed. Two decimals covers every quarter-gig value, and
// Kubernetes accepts a fractional binary suffix ("0.25Gi").
export function formatMemGi(gi) {
  const n = Math.max(0, Number(gi) || 0)
  const rounded = Math.round(n * 100) / 100
  return `${rounded}Gi`
}

export function humanMemGi(gi) {
  const n = Math.round((Number(gi) || 0) * 100) / 100
  return n < 1 ? `${Math.round(n * 1024)} MiB` : `${n} GiB`
}
