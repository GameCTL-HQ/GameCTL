import { useCallback, useEffect, useMemo, useState } from 'react'
// Named jsyaml: the component's `yaml` state (the built manifest string)
// would otherwise shadow this import inside applyExposure.
import jsyaml from 'js-yaml'
import { api } from '../api/client'
import { deployableGames } from '../wizard/gameSchemas'
import ImageWithFallback from '../components/ImageWithFallback'
import { CS2_RTV_CATALOG, catalogMode } from '../utils/cs2RtvCatalog'
import { joinPath } from '../utils/paths'
import QuantityStepper from '../components/QuantityStepper'
import {
  parseJvmGB, formatJvmGB,
  parseCPUMillis, formatCPUMillis, humanCPU,
  parseMemGi, formatMemGi, humanMemGi,
} from '../utils/quantity'

// -----------------------------------------------------------------------------
// Cluster port inventory — what every other Service (game pods included)
// already claims. Fetched once per wizard session and shared by every port
// field, so a 6-port game doesn't issue 6 identical requests.
//
// The wizard used to generate manifests blind: nothing told the operator that
// the 27015 they typed is CS2's RCON port. It still may be harmless — two
// ClusterIP Services each own their own ClusterIP — so the warning is graded,
// not a blanket "taken".
// -----------------------------------------------------------------------------
let portsCache = null // { at: epochMs, promise: Promise<PortUse[]> }
const PORTS_TTL_MS = 30_000

function fetchClusterPorts() {
  const now = Date.now()
  if (portsCache && now - portsCache.at < PORTS_TTL_MS) return portsCache.promise
  const promise = api.get('/cluster/ports')
    .then((r) => (Array.isArray(r.data?.ports) ? r.data.ports : []))
    .catch(() => []) // a wizard must still work against an unreadable cluster
  portsCache = { at: now, promise }
  return promise
}

function useClusterPorts() {
  const [ports, setPorts] = useState(null)
  useEffect(() => {
    let cancelled = false
    fetchClusterPorts().then((p) => { if (!cancelled) setPorts(p) })
    return () => { cancelled = true }
  }, [])
  return ports
}

// portConflict grades a (port, protocol) pick against the cluster inventory.
// Returns null when nothing else uses it, else { level, message }.
//   'error' — a genuine collision: same port+protocol on the same LoadBalancer
//             IP this deploy is asking for, or the same cluster-global nodePort.
//   'warn'  — the number is in use elsewhere, on a different IP. Legal, but
//             worth naming so "27015" doesn't get picked by accident twice.
// `self` (the instance name being edited) is excluded so re-running the wizard
// over an existing server doesn't flag the server against itself.
function portConflict(ports, port, protocol, lbIP, self) {
  if (!ports || !port) return null
  // protocol may be 'TCP', 'UDP', or ['TCP','UDP'] for a port a game opens on
  // both (L4D2, BeamMP) — either side colliding is worth saying.
  const protos = (Array.isArray(protocol) ? protocol : [protocol || 'TCP']).map((x) => String(x).toUpperCase())
  const owners = ports.filter((p) =>
    p.port === Number(port) &&
    protos.includes(String(p.protocol || 'TCP').toUpperCase()) &&
    !(self && (p.instance === self || p.service === self)))
  if (!owners.length) return null

  const proto = protos.join('+')
  const describe = (p) => `${p.game || p.service} (${p.namespace}${p.portName ? `/${p.portName}` : ''})`
  const hard = lbIP ? owners.filter((p) => p.lbIP && p.lbIP === lbIP) : []
  if (hard.length) {
    return {
      level: 'error',
      message: `${port}/${proto} is already bound to ${lbIP} by ${hard.map(describe).join(', ')} — pick another port or another LoadBalancer IP.`,
    }
  }
  return {
    level: 'warn',
    message: `${port}/${proto} is also used by ${owners.map(describe).join(', ')}. Different address, so it still works — but keep them straight.`,
  }
}

// suggestFreePorts returns the nearest port numbers nothing in the cluster
// claims — the answer to "fine, so which one SHOULD I use?".
//
// Deliberately conservative about what counts as taken: any Service port OR
// nodePort on ANY protocol blocks a suggestion, even though a TCP pick can
// legally sit on a UDP neighbour's number. Recommending a number that merely
// *probably* works reintroduces the confusion this whole feature exists to
// remove, and there is no shortage of free ports.
//
// `siblings` are the other port values on the form being edited, so a
// multi-port game (Satisfactory's four, Wreckfest's three) is never told to
// move one port onto another port it is about to claim itself.
function suggestFreePorts(ports, port, siblings = [], count = 3) {
  if (!ports || !port) return []
  const taken = new Set()
  for (const p of ports) {
    if (p.port) taken.add(p.port)
    if (p.nodePort) taken.add(p.nodePort)
  }
  for (const s of siblings) if (s) taken.add(Number(s))

  const start = Number(port)
  const out = []
  // Walk upward from the port the operator wanted: adjacency matters to a
  // human reading a firewall rule later, so 27016 beats an arbitrary 41337.
  for (let n = start + 1; n <= 65535 && out.length < count; n++) {
    if (n < 1024) continue // privileged range — never suggest it
    if (!taken.has(n)) out.push(n)
  }
  return out
}

// siblingPortValues collects every OTHER port value on the form, so
// suggestions never collide with a port this same deploy is claiming.
function siblingPortValues(game, form, exceptName) {
  const out = []
  for (const s of game?.steps || []) {
    for (const f of s.fields || []) {
      if (f.type !== 'port' || f.name === exceptName) continue
      const v = form?.[f.name]
      if (v) out.push(Number(v))
    }
  }
  return out
}

// PortField is a number input that names whoever already holds the port and
// offers free alternatives as one-click chips.
// Schema knobs: protocol ('TCP' | 'UDP' | ['TCP','UDP'], default TCP).
function PortField({ field, form, value, onChange, game }) {
  const ports = useClusterPorts()
  const conflict = portConflict(ports, value, field.protocol, form?.lbIP, form?.serverName)
  const suggestions = conflict
    ? suggestFreePorts(ports, value, siblingPortValues(game, form, field.name))
    : []
  const ring = conflict?.level === 'error' ? 'border-rose-500/70'
    : conflict?.level === 'warn' ? 'border-amber-500/70'
    : 'border-slate-700'
  return (
    <div>
      <input
        className={`form-input rounded-lg bg-slate-800 text-slate-100 ${ring}`}
        type="number"
        value={value ?? ''}
        onChange={(e) => onChange(field.name, Number(e.target.value))}
      />
      {conflict && (
        <p className={`mt-1 text-[11px] ${conflict.level === 'error' ? 'text-rose-300' : 'text-amber-300'}`}>
          {conflict.message}
        </p>
      )}
      {suggestions.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-[11px] text-slate-400">Free in this cluster:</span>
          {suggestions.map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => onChange(field.name, n)}
              className="px-1.5 py-0.5 rounded text-[11px] border border-emerald-600/60 bg-emerald-900/40 text-emerald-200 hover:bg-emerald-800/60"
            >
              {n}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// PortReview restates every port conflict on the Review step, immediately
// above Deploy. The per-field line under a number input is easy to walk past
// three steps earlier — this is the last screen before a manifest is applied,
// so the collision gets named where the decision actually happens.
// usePortConflicts grades every visible port field on the form at once. Both
// the Review banner and the Build YAML gate read it, so what the operator is
// warned about and what they are blocked on can never drift apart.
function usePortConflicts(game, form) {
  const ports = useClusterPorts()
  return useMemo(() => {
    const rows = []
    for (const s of game?.steps || []) {
      for (const f of s.fields || []) {
        if (f.type !== 'port') continue
        if (f.showIf && !f.showIf(form)) continue
        const c = portConflict(ports, form?.[f.name], f.protocol, form?.lbIP, form?.serverName)
        if (!c) continue
        const free = suggestFreePorts(ports, form?.[f.name], siblingPortValues(game, form, f.name))
        rows.push({ name: f.name, label: f.label || f.name, ...c, free })
      }
    }
    return rows
  }, [ports, game, form])
}

// PortReview restates every port conflict on the Review step, immediately
// above Build YAML, and carries the acknowledgement checkbox that unblocks it.
//
// The two levels are treated differently on purpose:
//   error — the config is genuinely broken (same port+protocol on the same
//           LoadBalancer IP). No override; the port has to change.
//   warn  — the number is shared with another Service that has its own
//           ClusterIP. That WORKS — factorio and projectzomboid both run RCON
//           on 27015 today — so blocking outright would refuse a valid
//           manifest. It gets a one-click "use it anyway" instead, which stops
//           the operator without lying to them about what is wrong.
function PortReview({ rows, acked, onAck }) {
  if (!rows.length) return null
  const errors = rows.filter((r) => r.level === 'error')
  const worst = errors.length ? 'error' : 'warn'
  return (
    <div className={`mb-2 rounded-lg border px-3 py-2 text-xs ${
      worst === 'error' ? 'border-rose-600 bg-rose-950/50 text-rose-200'
                        : 'border-amber-600 bg-amber-950/50 text-amber-200'}`}>
      <span className="font-semibold">
        {worst === 'error'
          ? '⚠ Port collision — this will not work as configured. Change it on the Networking step.'
          : '⚠ Ports already used elsewhere in the cluster.'}
      </span>
      <ul className="mt-1 list-disc pl-4 space-y-0.5">
        {rows.map((r) => (
          <li key={r.label}>
            <span className="font-medium">{r.label}:</span> {r.message}
            {r.free?.length > 0 && (
              <span className="text-slate-300"> Free instead: {r.free.join(', ')}.</span>
            )}
          </li>
        ))}
      </ul>
      {!errors.length && (
        <label className="mt-2 flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={acked} onChange={(e) => onAck(e.target.checked)}
            className="rounded border-amber-500 bg-slate-900 text-amber-500" />
          <span>These ports are shared on purpose — build anyway.</span>
        </label>
      )}
    </div>
  )
}

// RemoteSelect fetches options from a /api/* endpoint and renders a select.
// Schema knobs:
//   endpoint        : static URL relative to /api (e.g. '/cluster/metallb/pools')
//   endpointFn(form): dynamic URL — return null/'' to skip the fetch (e.g. when a dependency isn't set yet)
//   dependsOn       : field name; when its value changes, the fetch re-runs
//   dataPath        : where to find the array in the response (e.g. 'free' for /metallb/free-ips); omit for direct array
//   valueKey/labelKey: property names on each item (default 'name'); ignored if items are plain strings
function RemoteSelect({ field, form, value, onChange }) {
  const base = `form-input rounded-lg bg-slate-800 text-slate-100 ${field.emphasis === 'required' ? 'border-amber-500/70' : 'border-slate-700'}`
  const [options, setOptions] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const endpoint = field.endpointFn ? field.endpointFn(form) : field.endpoint
  const depValue = field.dependsOn ? form?.[field.dependsOn] : null

  useEffect(() => {
    let cancelled = false
    if (!endpoint) {
      setOptions([])
      setError(null)
      return
    }
    setLoading(true)
    api.get(endpoint)
      .then(r => {
        if (cancelled) return
        const raw = field.dataPath ? r.data?.[field.dataPath] : r.data
        setOptions(Array.isArray(raw) ? raw : [])
        setError(null)
      })
      .catch(e => { if (!cancelled) setError(e.message || 'fetch failed') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, depValue])

  // `autoSelectFirst`: pre-pick the first fetched option when the field is
  // still empty — used by the ProxyCTL public-domain dropdown, where the
  // common case is "publish on my domain" and the empty option is the
  // opt-out, not the default. Runs once per fetch; an explicit later pick
  // of the empty option is respected (options identity doesn't change).
  useEffect(() => {
    if (!field.autoSelectFirst || loading || error) return
    if (value != null && value !== '') return
    const first = options[0]
    const v = typeof first === 'string' ? first : first?.[field.valueKey || 'name']
    if (v != null && v !== '') onChange(field.name, v)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options, loading])

  if (!endpoint) {
    return (
      <div className="text-xs text-slate-500 italic px-2 py-2">
        Select {field.dependsOnLabel || field.dependsOn} first
      </div>
    )
  }
  if (loading) {
    return <select className={base} disabled><option>Loading…</option></select>
  }
  if (error) {
    return <select className={base} disabled><option>Error: {error}</option></select>
  }

  const valueKey = field.valueKey || 'name'
  const labelKey = field.labelKey || valueKey

  // `exclude`: names of sibling fields whose chosen value must NOT be
  // selectable here — e.g. a MetalLB IP already assigned to the MC server
  // shouldn't be offered for BlueMap (and vice-versa). Generic, so any
  // dual-IP / dual-resource installer can opt in via the schema.
  const taken = new Set(
    (field.exclude || [])
      .map((n) => form?.[n])
      .filter((x) => x != null && x !== '')
      .map(String)
  )

  return (
    <select className={base} value={value ?? ''} onChange={(e)=> onChange(field.name, e.target.value)}>
      <option value="">{field.placeholder || '— select —'}</option>
      {options.map((opt, i) => {
        const v = typeof opt === 'string' ? opt : opt?.[valueKey]
        const l = typeof opt === 'string' ? opt : (opt?.[labelKey] || v)
        // Keep the current value visible even if a sibling now holds it
        // (avoids a confusing blank select); just hide it from the rest.
        if (taken.has(String(v)) && String(v) !== String(value)) return null
        return <option key={String(v ?? i)} value={v ?? ''}>{l}</option>
      })}
    </select>
  )
}

// Cs2BootMapField — the CS2 wizard's boot-map picker. Lists the curated maps
// for the chosen game mode (cs2RtvCatalog.js); "Custom workshop ID" falls back
// to a free-text box so any Steam Workshop map still works. Writes the chosen
// id into workshopMap (the generator's boot-map override).
function Cs2BootMapField({ field, form, value, onChange }) {
  const base = 'form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100'
  const mode = catalogMode(form?.gameMode)
  const maps = mode?.maps || []
  const isCatalog = maps.some((m) => m.id === value)
  const [custom, setCustom] = useState(!!value && !isCatalog)

  // Drop a stale catalog pick when the game mode changes under it.
  useEffect(() => {
    if (!custom && value && !maps.some((m) => m.id === value)) onChange(field.name, '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form?.gameMode])

  return (
    <div className="flex flex-col gap-1.5">
      <select className={base} value={custom ? '__custom__' : (isCatalog ? value : '')}
        onChange={(e) => {
          const v = e.target.value
          if (v === '__custom__') { setCustom(true); return }
          setCustom(false)
          onChange(field.name, v)
        }}>
        <option value="">{mode ? 'Mode default map' : 'Mode default (no curated maps for this mode)'}</option>
        {maps.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        <option value="__custom__">Custom workshop ID…</option>
      </select>
      {custom && (
        <input className={base} type="text" placeholder="Steam Workshop map ID, e.g. 3076153623"
          value={value ?? ''} onChange={(e) => onChange(field.name, e.target.value.trim())} />
      )}
    </div>
  )
}

// Cs2RtvPoolField — per-mode editor for which maps the in-game !rtv vote
// offers. null = the full curated catalog; toggling a map materialises an
// explicit { [modeKey]: [mapId,…] } selection the generator filters by.
function Cs2RtvPoolField({ field, value, onChange }) {
  const pool = value || null
  const isSel = (key, id) => (!pool ? true : (Array.isArray(pool[key]) ? pool[key].includes(id) : true))
  const toggle = (key, id) => {
    const p = {}
    for (const m of CS2_RTV_CATALOG) {
      p[m.key] = pool && Array.isArray(pool[m.key]) ? [...pool[m.key]] : m.maps.map((x) => x.id)
    }
    p[key] = p[key].includes(id) ? p[key].filter((x) => x !== id) : [...p[key], id]
    onChange(field.name, p)
  }
  const selCount = (m) => m.maps.filter((mp) => isSel(m.key, mp.id)).length
  const total = CS2_RTV_CATALOG.reduce((n, m) => n + m.maps.length, 0)
  const chosen = CS2_RTV_CATALOG.reduce((n, m) => n + selCount(m), 0)

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/60 p-2 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400">{chosen}/{total} maps in the !rtv pool</span>
        {pool && (
          <button type="button" className="text-xs text-sky-400 hover:underline"
            onClick={() => onChange(field.name, null)}>Reset to all</button>
        )}
      </div>
      <div className="flex flex-col gap-2 max-h-72 overflow-y-auto pr-1">
        {CS2_RTV_CATALOG.map((m) => (
          <div key={m.key}>
            <div className="text-xs font-semibold text-slate-300 mb-1">
              {m.name} <span className="text-slate-500">({selCount(m)}/{m.maps.length})</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {m.maps.map((mp) => {
                const on = isSel(m.key, mp.id)
                return (
                  <button key={mp.id} type="button" onClick={() => toggle(m.key, mp.id)}
                    className={`px-2 py-0.5 rounded text-xs border transition-colors ${
                      on ? 'bg-emerald-600/30 border-emerald-500/60 text-emerald-200'
                         : 'bg-slate-800 border-slate-700 text-slate-600 line-through'}`}>
                    {mp.name}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// Identity fields the operator no longer types. The instance name is
// derived (see nextFreeName) because a hand-typed duplicate silently
// overwrote the running instance and collided on its storage subdir, and
// the namespace is single-valued by design (the README) — the
// apply-time normalizer forces `gamectl` regardless of what was typed, so
// an editable box here only ever misled.
const LOCKED_FIELDS = {
  serverName: 'Set automatically — numbered per game so a second server never collides with the first.',
  namespace: 'GameCTL deploys every game into the single `gamectl` namespace.',
}

function Field({ field, form, value, onChange, game }) {
  const base = 'form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100'
  if (LOCKED_FIELDS[field.name]) {
    return (
      <div>
        <input
          className={`${base} cursor-not-allowed bg-slate-900 text-slate-400`}
          type="text"
          value={value ?? ''}
          readOnly
          aria-readonly="true"
          tabIndex={-1}
        />
        <p className="mt-1 text-[11px] text-slate-500">{LOCKED_FIELDS[field.name]}</p>
      </div>
    )
  }
  if (field.type === 'remote-select') {
    return <RemoteSelect field={field} form={form} value={value} onChange={onChange} />
  }
  if (field.type === 'port') {
    return <PortField field={field} form={form} value={value} onChange={onChange} game={game} />
  }
  if (field.type === 'cs2-bootmap') {
    return <Cs2BootMapField field={field} form={form} value={value} onChange={onChange} />
  }
  if (field.type === 'cs2-rtvpool') {
    return <Cs2RtvPoolField field={field} value={value} onChange={onChange} />
  }
  // A game's own memory setting (JVM heap etc.) — stepped, never typed.
  // Free text here doesn't fail loudly: the generators parse it with a
  // regex and fall back to their default on no-match, so "4 GB" quietly
  // becomes 4G AND resizes the container requests/limits derived from it.
  if (field.type === 'memory-g') {
    const gb = parseJvmGB(value) ?? parseJvmGB(field.default) ?? 4
    return (
      <QuantityStepper
        value={gb}
        onChange={(n) => onChange(field.name, formatJvmGB(n))}
        step={field.step || 1}
        min={field.min || 1}
        max={field.max || 64}
        unit="G"
        human={`${gb}G heap · container limit ≈ ${gb + 1}Gi`}
      />
    )
  }
  // Container CPU, in millicores. Writes the canonical Quantity: whole
  // cores lose the suffix ("2"), anything else stays millicores ("500m").
  if (field.type === 'cpu-milli') {
    const milli = parseCPUMillis(value) ?? parseCPUMillis(field.default) ?? 500
    return (
      <QuantityStepper
        value={milli}
        onChange={(n) => onChange(field.name, formatCPUMillis(n))}
        step={field.step || 250} min={field.min || 100} max={field.max || 32000}
        unit="m" human={humanCPU(milli)}
      />
    )
  }
  // Container memory, in Gi with half-steps. Kubernetes accepts a
  // fractional binary suffix, so "1.5Gi" is exact — no need to drop to Mi
  // to express half a gig.
  if (field.type === 'mem-gi') {
    const gi = parseMemGi(value) ?? parseMemGi(field.default) ?? 1
    return (
      <QuantityStepper
        value={gi}
        onChange={(n) => onChange(field.name, formatMemGi(n))}
        step={field.step || 0.5} min={field.min || 0.25} max={field.max || 128}
        precision={2}
        unit="Gi" human={humanMemGi(gi)}
      />
    )
  }
  if (field.type === 'select') {
    return (
      <select className={base} value={value}
        onChange={(e)=> onChange(field.name, isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value))}>
        {field.options?.map(opt => (
          <option key={String(opt.value)} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    )
  }
  // `fallbackField`: when this field is untouched, mirror another field's
  // value as the real input value (not a placeholder) — e.g. the public
  // subdomain shows the actual server name until the operator overrides it.
  const effValue = value ?? (field.fallbackField ? form?.[field.fallbackField] : undefined)
  return (
    <input
      className={base}
      type={field.type === 'number' ? 'number' : 'text'}
      placeholder={field.placeholder || ''}
      value={effValue ?? ''}
      onChange={(e)=> onChange(field.name, field.type==='number' ? Number(e.target.value) : e.target.value)}
    />
  )
}

// Seed the form from the generator defaults, then layer in any field-level
// `default:` declared in the schema (e.g. per-game resource requests/limits,
// Valheim password) that the generator defaults don't carry. Without this the
// Resources step renders blank because cpuRequest/memRequest/… live only as
// field defaults, not in the generator's default form.
function withFieldDefaults(game) {
  const base = { ...(game?.defaults || {}) }
  for (const s of game?.steps || []) {
    for (const fld of s.fields || []) {
      if (fld?.default !== undefined && base[fld.name] === undefined) {
        base[fld.name] = fld.default
      }
    }
  }
  return base
}

// nextFreeName picks the instance name for a new deploy: the game's own
// default while it's unused, then -2, -3, … Single-namespace means a
// duplicate name doesn't error — it overwrites the running server and
// shares its storage folder — so the wizard picks a free one instead of
// asking the operator to notice.
//
// The first instance deliberately keeps the bare name (`valheim`, not
// `valheim-1`): that matches every already-deployed server and the
// <path>/GameCTL/<serverName> storage layout on disk.
// baseNameOf is the game's own default instance name ("valheim"), which the
// numbering builds on.
export function baseNameOf(game) {
  return String(game?.defaults?.serverName || game?.id || 'server').trim()
}

export function nextFreeName(base, taken) {
  const used = new Set(taken)
  if (!used.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(candidate)) return candidate
  }
  return `${base}-${Date.now()}`
}

export default function GameWizard({ onYamlBuilt, onApply, initialGame }) {
  // Resolve against the allowlist, not the whole catalog — the wizard is the
  // one place that can actually deploy, so a stale link or draft naming an
  // unsupported game must not open it here.
  const [selected, setSelected] = useState(() => (initialGame ? deployableGames.find(g => g.id === initialGame) : null) ?? deployableGames[0])
  const [stepIdx, setStepIdx] = useState(0)
  const [form, setForm] = useState(() => withFieldDefaults(selected))
  const [yaml, setYaml] = useState('')
  // True when the form has changed since the YAML was last built — the
  // generated YAML (and therefore Deploy) is stale until Build YAML is hit.
  const [yamlStale, setYamlStale] = useState(true)
  const [applying, setApplying] = useState(false)
  const [applyResult, setApplyResult] = useState(null)
  const [drafts, setDrafts] = useState([])

  // Port conflicts gate Build YAML (see PortReview). The acknowledgement is
  // keyed by the exact set of conflicts it was given for, so changing a port
  // — or picking a different game — silently invalidates a stale "yes, I
  // know" instead of carrying it onto a collision the operator never saw.
  const portRows = usePortConflicts(selected, form)
  const portKey = portRows.map((r) => `${r.name}:${r.message}`).join('|')
  const [portAckKey, setPortAckKey] = useState('')
  const portAcked = portKey !== '' && portAckKey === portKey
  const portErrors = portRows.filter((r) => r.level === 'error')
  // Blocked while a real collision stands, or while a shared-port warning is
  // unacknowledged. Errors have no override — the manifest would not work.
  const portBlocked = portErrors.length > 0 || (portRows.length > 0 && !portAcked)

  // Names already in use cluster-wide, so the wizard can hand out a free
  // one instead of letting a duplicate overwrite a running server.
  const [taken, setTaken] = useState([])
  const loadTaken = useCallback(async () => {
    try {
      const { data } = await api.get('/games/instances')
      const names = (data?.deployments || []).flatMap(d =>
        [d.name, d.labels?.['gamectl.io/instance']].filter(Boolean))
      setTaken(names)
      return names
    } catch {
      return []   // offline/unauthorized: fall through to the pre-deploy guard
    }
  }, [])

  // Seed the initially-selected game's name once the cluster answers.
  useEffect(() => {
    let stop = false
    loadTaken().then(names => {
      if (stop || !names.length) return
      setForm(f => ({ ...f, serverName: nextFreeName(baseNameOf(selected), names) }))
    })
    return () => { stop = true }
    // Deliberately mount-only: later games are handled in selectGame, and
    // re-running this on every `selected` change would stomp a loaded draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Helpers
  const getServerType = (f) => String(f?.serverType ?? f?.type ?? '').trim().toLowerCase()
  const isPaper = useMemo(() => getServerType(form) === 'paper', [form])

  // ProxyCTL detection — the Networking step's "Player access" choice only
  // renders when a ProxyCTL install answers in the cluster; without one,
  // MetalLB stays the single (mandatory) exposure path.
  const [proxyctlAvail, setProxyctlAvail] = useState(false)
  useEffect(() => {
    api.get('/proxyctl/status')
      .then(r => setProxyctlAvail(!!r.data?.detected))
      .catch(() => setProxyctlAvail(false))
  }, [])

  // Networking post-process over the generated docs:
  //  - "Internet only": the game needs no LAN LoadBalancer — ProxyCTL's
  //    in-cluster WireGuard gateway reaches the Service by ClusterIP.
  //    Rewrite the Service(s) instead of teaching ~15 generators about
  //    exposure modes.
  //  - Deploy-time publish: when a public domain was picked, stamp
  //    gamectl.io/publish-* annotations on the primary Deployment; the
  //    backend's apply task fulfills them (creates the ProxyCTL entries /
  //    web routes + applies) right after a successful deploy.
  // Re-dump uses lineWidth:-1 — some generators (CS2) embed long shell/cfg
  // lines that must never be folded.
  const applyNetworking = (yamlStr, f) => {
    const wantsProxy = f?.expose === 'proxyctl' || f?.expose === 'both'
    const stripLB = f?.expose === 'proxyctl'
    const publishDomain = wantsProxy ? String(f?.publishDomain || '').trim() : ''
    if (!stripLB && !publishDomain) return yamlStr
    const docs = []
    jsyaml.loadAll(yamlStr, (d) => { if (d) docs.push(d) })
    // The intent goes on the PRIMARY Deployment only (name === serverName);
    // the backend expands it to every target (game + BlueMap/records).
    let annotated = false
    for (const d of docs) {
      if (stripLB) {
        if (d?.metadata?.annotations) {
          delete d.metadata.annotations['metallb.universe.tf/address-pool']
          if (Object.keys(d.metadata.annotations).length === 0) delete d.metadata.annotations
        }
        if (d?.kind === 'Service' && d.spec?.type === 'LoadBalancer') {
          d.spec.type = 'ClusterIP'
          delete d.spec.loadBalancerIP
          delete d.spec.externalTrafficPolicy
        }
      }
      if (publishDomain && !annotated && d?.kind === 'Deployment'
          && (!f.serverName || d.metadata?.name === f.serverName)) {
        d.metadata.annotations = {
          ...(d.metadata.annotations || {}),
          'gamectl.io/publish-host': String(f.publishHost || f.serverName || '').trim().toLowerCase(),
          'gamectl.io/publish-domain': publishDomain.toLowerCase(),
        }
        annotated = true
      }
    }
    return docs.map(d => jsyaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n')
  }

  // Force the canonical `app.kubernetes.io/part-of: games` label on every doc
  // so the Hub query (which filters by part-of=games) picks up every deployment
  // regardless of what value the generator emitted. Older code here used to
  // rewrite this to the per-game id which broke the Hub's instance counts.
  const applyPartOfLabel = (yamlStr) => {
    if (!yamlStr) return yamlStr
    return yamlStr.replace(/(^|\n)([ \t]*)app\.kubernetes\.io\/part-of:\s*[^\n]*/gm, `$1$2app.kubernetes.io/part-of: games`)
  }

  const isBluemapishStep = (s) =>
    /(blue|bli)map/i.test(String(s?.id ?? '')) || /(blue|bli)map/i.test(String(s?.title ?? ''))

  const getBluemapRaw = (f) =>
    f?.bluemap ?? f?.blipmap ?? f?.bluepaper ??
    f?.bluemapEnabled ?? f?.blipmapEnabled ?? f?.bluepaperEnabled ??
    f?.enableBluemap ?? f?.enableBlipmap ?? f?.enableBluepaper ??
    f?.bluemapEnable ?? f?.blipmapEnable ?? f?.bluepaperEnable

  const isBluemapOn = (f) => {
    const v = getBluemapRaw(f)
    return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()) || v === 1 || v === true
  }

  // Compute visible steps (hide any Bluemap/Blipmap step unless Paper is selected)
  const visibleSteps = useMemo(() => {
    const steps = selected?.steps || []
    return steps.filter((s) => {
      const schemaAllows = !s.showIf || !!s.showIf(form)
      const hideBluemap = isBluemapishStep(s) && !isPaper
      return schemaAllows && !hideBluemap
    })
  }, [selected, form, isPaper])

  const step = useMemo(() => visibleSteps?.[stepIdx], [visibleSteps, stepIdx])

  const goNext = () => setStepIdx((i)=> Math.min(i+1, (visibleSteps?.length||1)-1))
  const goPrev = () => setStepIdx((i)=> Math.max(i-1, 0))

  // Clamp stepIdx when visibleSteps change (e.g., toggling server type)
  useEffect(() => {
    if (stepIdx > (visibleSteps.length - 1)) {
      setStepIdx(Math.max(0, visibleSteps.length - 1))
    }
  }, [visibleSteps, stepIdx])

  const setField = (name, value) => {
    setForm((f)=> ({ ...f, [name]: value }))
    setYamlStale(true) // any change invalidates the built YAML
  }

  // Remove/normalize Bluemap-related fields for YAML if Paper isn't selected or Bluemap is disabled
  const sanitizeFormForYaml = (raw) => {
    const f = { ...raw }

    // Normalize type (generator expects TYPE e.g., PAPER)
    const typeRaw = f?.type ?? f?.serverType
    if (typeRaw) f.type = String(typeRaw).toUpperCase()

    const paper = String(f?.type ?? '').toUpperCase() === 'PAPER'
    const bluemapOn = isBluemapOn(f)

    // When ON, normalize blipmap/bluepaper keys -> bluemap*
    if (paper && bluemapOn) {
      Object.keys(f).forEach((k) => {
        const m = k.match(/^(blipmap|bluepaper)(.*)$/i)
        if (m) {
          const newKey = `bluemap${m[2]}`
          if (!(newKey in f)) f[newKey] = f[k]
          delete f[k]
        }
      })
      f.bluemapEnabled = 1
      delete f.bluemap; delete f.enableBluemap; delete f.bluemapEnable
      delete f.blipmap; delete f.enableBlipmap; delete f.blipmapEnable
      delete f.bluepaper; delete f.enableBluepaper; delete f.bluepaperEnable
      return f
    }

    // When OFF or not Paper: force off and strip bluemap-ish fields
    f.bluemapEnabled = 0
    Object.keys(f)
      .filter((k) => /^(bluemap)/i.test(k))
      .forEach((k) => { if (!/^bluemapEnabled$/i.test(k)) delete f[k] })
    delete f.bluemap; delete f.enableBluemap; delete f.bluemapEnable
    return f
  }

  // Operator-declared NFS locations (Storage screen). The wizard resolves
  // the picked location → nfsServer + dataPvPath (= <export>/gamectl/<server>)
  // so the unchanged generators emit the right NFS volume. Single namespace
  // + labels + inline-NFS are still enforced server-side by the normalizer.
  const [locations, setLocations] = useState([])
  useEffect(() => {
    api.get('/storage/locations')
      .then(r => setLocations(r.data?.locations || []))
      .catch(() => setLocations([]))
  }, [])

  const resolveStorage = (f) => {
    if (!f.storageLocation) return f
    const loc = locations.find(l => l.name === f.storageLocation)
    if (!loc) throw new Error(`Unknown storage location "${f.storageLocation}" — declare it under Storage first`)
    const folder = loc.folderSuffix ? `GameCTL-${loc.folderSuffix}` : 'GameCTL'
    const base = joinPath(loc.exportPath, folder, f.serverName)
    // BlueMap lives UNDER the server's data dir (<base>/bluemap), not as a
    // sibling <base>-bluemap — so deleting/wiping the server folder also
    // removes BlueMap in one recursive pass (no separate cleanup needed).
    if (loc.type === 'local') {
      return {
        ...f,
        storageMode: 'local',
        localDataPath: base,
        localBluemapPath: `${base}/bluemap`,
      }
    }
    return {
      ...f,
      storageMode: 'remote',
      nfsServer: loc.server,
      dataPvPath: base,
      bluemapPvPath: `${base}/bluemap`,
    }
  }

  // Non-throwing preview of the exact directory the server's data lands in
  // for the picked storage location — shown live under the field so the
  // operator sees "/mnt/…/GameCTL/<server>" before deploying.
  const installPathPreview = (f) => {
    if (!f.storageLocation) return ''
    const loc = locations.find(l => l.name === f.storageLocation)
    if (!loc) return ''
    const folder = loc.folderSuffix ? `GameCTL-${loc.folderSuffix}` : 'GameCTL'
    const base = joinPath(loc.exportPath, folder, f.serverName || '<server>')
    return loc.type === 'local' ? base : `${loc.server || '<nfs>'}:${base}`
  }

  // Pre-filled seed commands for a step that declares a seedBuilder (SPT/Fika).
  // Derives host + install base from the picked Storage Location so the printed
  // rsync/kubectl commands match the actual deploy.
  const seedPreview = (f) => {
    if (typeof step?.seedBuilder !== 'function') return ''
    const loc = locations.find(l => l.name === f.storageLocation)
    if (!loc) return ''
    const folder = loc.folderSuffix ? `GameCTL-${loc.folderSuffix}` : 'GameCTL'
    const installBase = joinPath(loc.exportPath, folder, f.serverName || 'fika')
    return step.seedBuilder({
      nfsHost: loc.type === 'local' ? '' : (loc.server || ''),
      installBase,
      namespace: 'gamectl',
      serverName: f.serverName || 'fika',
    })
  }

  const buildYaml = () => {
    try {
      const sanitized = resolveStorage(sanitizeFormForYaml(form))
      // A stale draft can carry expose='proxyctl' from a cluster that had
      // ProxyCTL; without it, fall back to the mandatory MetalLB path and
      // drop any deploy-time publish intent.
      if (!proxyctlAvail) {
        if (sanitized.expose === 'proxyctl') sanitized.expose = 'lan'
        delete sanitized.publishDomain
      }
      const out = applyNetworking(selected.toYaml(sanitized), sanitized)
      const outFinal = applyPartOfLabel(out)
      setYaml(outFinal)
      setYamlStale(false)
      onYamlBuilt?.(outFinal)
    } catch (e) {
      alert(e.message)
    }
  }

  const selectGame = (g) => {
    setSelected(g)
    setForm({ ...withFieldDefaults(g), serverName: nextFreeName(baseNameOf(g), taken) })
    setStepIdx(0)
    setYaml('')
    setYamlStale(true)
    setApplyResult(null)
  }

  // Drafts in localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem('gameDrafts')
      if (raw) setDrafts(JSON.parse(raw))
    } catch { /* ignore */ }
  }, [])

  const persistDrafts = (next) => {
    setDrafts(next)
    try { localStorage.setItem('gameDrafts', JSON.stringify(next)) } catch { /* ignore */ }
  }

  const loadDraft = (d) => {
    const game = deployableGames.find(g => g.id === d.gameId) || selected
    setSelected(game)
    setForm(d.form)
    setYaml(d.yaml)
    setYamlStale(false) // draft carries its already-built YAML
    setApplyResult(null)
    // Respect visibility (Paper-only Bluemap) when jumping to review
    const draftIsPaper = getServerType(d.form) === 'paper'
    const computedVisible = (game.steps || []).filter((s) => {
      const schemaAllows = !s.showIf || !!s.showIf(d.form)
      const hideBluemap = isBluemapishStep(s) && !draftIsPaper
      return schemaAllows && !hideBluemap
    })
    const reviewIdx = computedVisible.findIndex(s => s.id === 'review')
    setStepIdx(reviewIdx >= 0 ? reviewIdx : Math.max(0, computedVisible.length - 1))
  }

  const deleteDraft = (id) => {
    const next = drafts.filter(d => d.id !== id)
    persistDrafts(next)
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
      {/* Game art banner — the game is already chosen on the hub; show its
          art instead of a re-selection grid so the form stays readable. */}
      <div className="relative mb-5 h-36 w-full overflow-hidden rounded-lg bg-slate-800">
        {selected?.cover && (
          <ImageWithFallback src={selected.cover} fallbackSrc="/brand/tiles/cover-fallback.png"
            alt={`${selected.name} art`}
            className="h-full w-full object-cover opacity-60" />
        )}
        <div className="absolute inset-0 flex items-end bg-gradient-to-t from-slate-950/90 to-transparent p-4">
          <div className="flex items-center gap-3">
            {selected?.icon && (
              <ImageWithFallback src={selected.icon} fallbackSrc={`/brand/tiles/icon-${selected.id}.png`}
                alt={selected.short}
                className="h-10 w-10 object-contain drop-shadow" />
            )}
            <div>
              <div className="text-lg font-semibold leading-tight">Create a {selected?.name} Server</div>
              <div className="text-xs text-slate-400">{selected?.short}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Stepper */}
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        {visibleSteps.map((s, i) => (
          <button
            key={s.id}
            onClick={() => setStepIdx(i)}
            className={`px-2.5 py-1 rounded-lg border transition-colors ${i===stepIdx ? 'bg-emerald-600 border-emerald-500 font-medium' : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'}`}
          >
            {s.title}
          </button>
        ))}
      </div>

      {/* Step content */}
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
        <h3 className={`text-sm font-semibold ${step?.note ? 'mb-1' : 'mb-3'}`}>{step?.title}</h3>
        {step?.note && (
          <p className="text-xs text-slate-400 mb-3 whitespace-pre-line">{step.note}</p>
        )}
        {step && step.id !== 'review' ? (
          <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(() => {
              const baseFields = (step.fields || [])
                .filter((f) => !f.showIf || !!f.showIf(form))
                // The exposure choice only exists when ProxyCTL is present.
                .filter((f) => f.name !== 'expose' || proxyctlAvail)

              const bluemapStep =
                /(blue|bli)map/i.test(String(step?.id ?? '')) || /(blue|bli)map/i.test(String(step?.title ?? ''))

              if (bluemapStep) {
                const on = isBluemapOn(form)
                if (!on) {
                  const toggleNameRegex =
                    /^(bluemap|blipmap|bluepaper)(Enabled)?$|^enable(Bluemap|Blipmap|Bluepaper)$/i
                  const toggleFields = baseFields.filter((f) => toggleNameRegex.test(String(f?.name ?? '')))
                  const fieldsToRender = toggleFields.length > 0 ? toggleFields : baseFields.slice(0, 1)
                  return fieldsToRender.map((f) => (
                    <label key={f.name} className="text-sm flex flex-col gap-1">
                      <span className={f.emphasis === 'required' ? 'text-amber-400 font-medium' : 'text-slate-300'}>
                        {f.label}{f.emphasis === 'required' && ' *'}
                      </span>
                      <Field field={f} form={form} value={form[f.name]} onChange={setField} game={selected} />
                      {f.hint && <span className={`text-xs ${f.emphasis === 'required' ? 'text-amber-400/80' : 'text-slate-500'}`}>{f.hint}</span>}
                      {f.helpUrl && <a href={f.helpUrl} target="_blank" rel="noreferrer" className="text-xs text-sky-400 hover:text-sky-300 underline w-fit">{f.helpLabel || 'Get it here ↗'}</a>}
                    </label>
                  ))
                }
              }

              return baseFields.map((f) => (
                <label key={f.name} className={`text-sm flex flex-col gap-1 ${f.fullWidth ? 'sm:col-span-2' : ''}`}>
                  <span className={f.emphasis === 'required' ? 'text-amber-400 font-medium' : 'text-slate-300'}>
                    {f.label}{f.emphasis === 'required' && ' *'}
                  </span>
                  <Field field={f} form={form} value={form[f.name]} onChange={setField} game={selected} />
                  {f.hint && <span className={`text-xs ${f.emphasis === 'required' ? 'text-amber-400/80' : 'text-slate-500'}`}>{f.hint}</span>}
                  {f.helpUrl && <a href={f.helpUrl} target="_blank" rel="noreferrer" className="text-xs text-sky-400 hover:text-sky-300 underline w-fit">{f.helpLabel || 'Get it here ↗'}</a>}
                  {f.name === 'storageLocation' && installPathPreview(form) && (
                    <span className="text-xs text-emerald-300/90 font-mono break-all">
                      Installs to: {installPathPreview(form)}
                    </span>
                  )}
                </label>
              ))
            })()}
          </div>
          {seedPreview(form) && (
            <div className="mt-4 rounded-lg border border-sky-800 bg-sky-950/30 p-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-sky-300">
                  Seed the Fika mods (run after deploy, once per version)
                </span>
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(seedPreview(form))}
                  className="text-xs px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700"
                >
                  Copy
                </button>
              </div>
              <p className="text-xs text-slate-400 mb-2">
                The image ships no mods — download the matched Fika pair, then run these
                (paths are derived from the Storage Location above).
              </p>
              <pre className="text-xs bg-slate-950 p-2 rounded border border-slate-800 overflow-auto max-h-72 whitespace-pre">{seedPreview(form)}</pre>
            </div>
          )}
          </>
        ) : (
          <div className="text-sm text-slate-300">
            <div className="mb-2">Review your settings, then build and apply.</div>
            <PortReview
              rows={portRows}
              acked={portAcked}
              onAck={(on) => setPortAckKey(on ? portKey : '')}
            />
            {(yamlStale || !yaml) && !applyResult?.ok && (
              <div className="mb-2 rounded-lg border border-amber-600 bg-amber-950/50 px-3 py-2 text-amber-200 text-xs">
                <span className="font-semibold">
                  {yaml ? '⚠ Settings changed since the YAML was built.' : '⚠ No YAML built yet.'}
                </span>{' '}
                Click <span className="font-semibold">Build YAML</span> to regenerate it — the
                <span className="font-semibold"> Deploy</span> button stays disabled until you do,
                so your latest changes are what actually gets applied.
              </div>
            )}
            <pre className="text-xs bg-slate-950 p-2 rounded border border-slate-800 overflow-auto max-h-64 whitespace-pre-wrap">{yaml || 'No YAML yet. Click Build YAML.'}</pre>
            {applyResult && (
              <div className={`mt-2 rounded p-2 text-xs ${applyResult.ok ? 'bg-emerald-950 text-emerald-300 border border-emerald-800' : 'bg-rose-950 text-rose-300 border border-rose-800'}`}>
                {applyResult.ok
                  ? (applyResult.taskId
                      ? `Submitted — watch progress in the Tasks menu (task ${applyResult.taskId.slice(0,8)}…).`
                      : `Applied: ${applyResult.applied?.map(r => r.name).join(', ') || 'ok'}${applyResult.skipped?.length ? ` | Skipped: ${applyResult.skipped.map(r => r.name).join(', ')}` : ''}`)
                  : `Error: ${applyResult.error}`}
              </div>
            )}
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button onClick={goPrev} disabled={stepIdx===0} className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 disabled:opacity-50">Back</button>
          {step && step.id !== 'review' ? (
            <button onClick={goNext} className="px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700">Next</button>
          ) : (
            <>
              <button
                onClick={buildYaml}
                disabled={portBlocked}
                title={portBlocked
                  ? (portErrors.length
                      ? 'Fix the port collision on the Networking step first'
                      : 'Confirm the shared ports above, or pick a free one')
                  : undefined}
                className={`px-3 py-2 rounded-lg border ${
                  portBlocked
                    ? 'bg-slate-800 border-slate-700 text-slate-500 cursor-not-allowed'
                    : (yamlStale || !yaml) && !applyResult?.ok
                      ? 'bg-amber-600 hover:bg-amber-500 border-amber-500 text-slate-950 font-semibold'
                      : 'bg-slate-700 hover:bg-slate-600 border-slate-600'
                }`}
              >
                {(yamlStale && yaml) ? 'Build YAML (changes pending)' : 'Build YAML'}
              </button>
              {onApply && (
                <button
                  onClick={async () => {
                    setApplying(true)
                    setApplyResult(null)
                    try {
                      // Last-line guard against a name that was free when the
                      // wizard opened but got taken since (another tab, another
                      // operator). Single-namespace means a duplicate silently
                      // overwrites the running instance and shares its storage
                      // subdir <path>/GameCTL/<serverName>, so never deploy
                      // through it. The name field is read-only now, so pick
                      // the next free one instead of asking for a rename the
                      // operator can't perform.
                      const want = String(form.serverName || '').trim()
                      const fresh = await loadTaken()
                      if (fresh.includes(want)) {
                        const renamed = nextFreeName(baseNameOf(selected), fresh)
                        setForm(f => ({ ...f, serverName: renamed }))
                        setYamlStale(true)
                        setApplyResult({ ok: false, error: `A server named "${want}" was created since you started. Renamed this one to "${renamed}" — hit Build YAML, then deploy again.` })
                        setApplying(false)
                        return
                      }
                      const result = await onApply(yaml)
                      setApplyResult({ ok: true, ...result })
                      loadTaken()   // so a second deploy this session numbers up
                    } catch (e) {
                      setApplyResult({ ok: false, error: e.response?.data?.detail || e.message })
                    } finally {
                      setApplying(false)
                    }
                  }}
                  disabled={applying || applyResult?.ok || yamlStale || !yaml}
                  title={
                    (yamlStale || !yaml) && !applyResult?.ok
                      ? 'Build YAML first — generate the manifest from your current settings before deploying'
                      : undefined
                  }
                  className="px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {applying ? 'Applying…'
                    : applyResult?.ok ? 'Deployed ✓'
                    : (yamlStale || !yaml) ? 'Deploy (build YAML first)'
                    : 'Apply to Cluster'}
                </button>
              )}
            </>
          )}
        </div>
      </div>

      {/* Drafts */}
      {drafts.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold mb-2">Your drafts</h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {drafts.map((d) => (
              <div key={d.id} className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-sm">
                <div className="font-semibold mb-1 truncate" title={d.name}>{d.name}</div>
                <div className="text-slate-400 mb-2">{new Date(d.createdAt).toLocaleString()}</div>
                <div className="flex gap-2">
                  <button onClick={()=>loadDraft(d)} className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm">Load</button>
                  <button onClick={()=>deleteDraft(d.id)} className="px-3 py-1.5 rounded-lg bg-rose-900/50 hover:bg-rose-900 border border-rose-900 text-sm">Delete</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
