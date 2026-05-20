import { useEffect, useState, useCallback, useRef } from 'react'
import { api } from '../api/client'
import ImageWithFallback from '../components/ImageWithFallback'

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
  const copy = () => {
    if (!address) return
    navigator.clipboard?.writeText(address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  if (!address) return null
  return (
    <button
      onClick={copy}
      title="Copy address"
      className="inline-flex items-center gap-1.5 text-xs font-mono text-slate-300 bg-slate-800/60 hover:bg-slate-800 border border-slate-700 rounded px-2 py-1 transition"
    >
      <span>{address}</span>
      <span className="text-slate-500 text-[10px]">
        {copied ? '✓ copied' : '⧉'}
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
  const copy = () => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <div className="grid grid-cols-[minmax(0,11rem)_1fr_auto_auto] items-center gap-2 text-xs py-1.5 border-t border-slate-800 first:border-t-0">
      <span className="text-slate-400 font-mono truncate" title={name}>{name}</span>
      <span className="font-mono text-slate-200 truncate">
        {shown ? value : '•'.repeat(Math.min(value.length, 16))}
      </span>
      <button onClick={() => setShown(s => !s)} className="text-slate-400 hover:text-slate-100 px-1.5">
        {shown ? 'hide' : 'show'}
      </button>
      <button onClick={copy} title="Copy" className="text-slate-400 hover:text-slate-100 px-1.5">
        {copied ? '✓' : '⧉'}
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


  if (err && !data) {
    return <p className="text-xs text-rose-400 mt-3">Settings: {err}</p>
  }
  if (!data) return null

  const au = data.autoUpdate
  const creds = data.credentials || []

  return (
    <div className="mt-3 rounded-lg border border-slate-800 bg-slate-950 p-3 space-y-3">
      <p className="text-xs font-medium text-slate-400">Settings &amp; access</p>

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

      {data.cs2 && <CS2LivePanel namespace={namespace} name={name} cs2={data.cs2} onApplied={load} />}

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

const CS2_MODE_LABELS = {
  competitive: 'Competitive (5v5)', casual: 'Casual', wingman: 'Wingman (2v2)',
  demolition: 'Demolition', deathmatch: 'Deathmatch', armsrace: 'Arms Race (Gun Game)',
}
const CS2_DIFF = ['Easy', 'Normal', 'Hard', 'Expert']
const CS2_MAPS = [
  'de_dust2', 'de_mirage', 'de_inferno', 'de_nuke', 'de_overpass',
  'de_vertigo', 'de_ancient', 'de_anubis', 'de_train', 'cs_office', 'cs_italy',
]
// CS2 one-click RCON actions. label → server console command.
const CS2_ACTIONS = [
  ['Restart round', 'mp_restartgame 1'],
  ['End warmup', 'mp_warmup_end'],
  ['Swap teams', 'mp_swapteams'],
  ['Pause', 'mp_pause_match'],
  ['Unpause', 'mp_unpause_match'],
  ['Add bot', 'bot_add'],
  ['Kick bots', 'bot_kick'],
]

// CS2LivePanel — change mode / bot difficulty / player cap on the running
// server via RCON (no pod restart). A mode change reloads the map in-game
// (a few seconds), not the pod.
function CS2LivePanel({ namespace, name, cs2, onApplied }) {
  const [mode, setMode] = useState(cs2.mode)
  const [diff, setDiff] = useState(cs2.botDifficulty ?? 2)
  const [maxp, setMaxp] = useState(cs2.maxPlayers || '')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const dirty = mode !== cs2.mode || diff !== cs2.botDifficulty ||
    String(maxp || '') !== String(cs2.maxPlayers || '')

  const apply = async () => {
    setBusy(true); setMsg('')
    try {
      await api.post(`/games/instances/${namespace}/${name}/cs2config`, {
        mode,
        botDifficulty: Number(diff),
        maxPlayers: maxp === '' ? 0 : Number(maxp),
      })
      setMsg('Applied live ✓' + (mode !== cs2.mode ? ' — map reloading for the mode change' : ''))
      setTimeout(() => { onApplied?.(); }, 1500)
    } catch (e) {
      setMsg(e.response?.data?.detail || e.message)
    } finally {
      setBusy(false)
    }
  }

  const [qbusy, setQbusy] = useState('')
  const [pickMap, setPickMap] = useState(cs2.map || 'de_dust2')
  const runCmd = async (key, command) => {
    setQbusy(key); setMsg('')
    try {
      const { data } = await api.post(`/games/instances/${namespace}/${name}/rcon`, { command })
      setMsg((data.output || 'sent ✓').trim().slice(0, 200) || 'sent ✓')
      setTimeout(() => { onApplied?.(); }, 1200)
    } catch (e) {
      setMsg(e.response?.data?.detail || e.message)
    } finally {
      setQbusy('')
    }
  }

  return (
    <div>
      <p className={LP.title}>CS2 game settings (live — no restart)</p>
      <div className={LP.panel}>
        <div className="space-y-2.5">
          <p className={LP.sub}>Settings</p>
          <label className={LP.row}>
            <span className={LP.label}>Game mode</span>
            <select className={LP.sel} value={mode} onChange={e => setMode(e.target.value)}>
              {(cs2.modeOptions || []).map(m => (
                <option key={m} value={m}>{CS2_MODE_LABELS[m] || m}</option>
              ))}
            </select>
          </label>
          <label className={LP.row}>
            <span className={LP.label}>Bot difficulty</span>
            <select className={LP.sel} value={diff} onChange={e => setDiff(Number(e.target.value))}>
              {CS2_DIFF.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          </label>
          <label className={LP.row}>
            <span className={LP.label}>Max players</span>
            <input type="number" min="1" max="64" value={maxp}
              onChange={e => setMaxp(e.target.value)} placeholder="auto from mode"
              className={`${LP.input} w-28`} />
          </label>
          <div className={LP.row}>
            <span className={LP.label} aria-hidden="true"></span>
            <button onClick={apply} disabled={busy || !dirty} className={LP.primary}>
              {busy ? 'Applying…' : 'Apply live'}
            </button>
            {msg && <span className={LP.status}>{msg}</span>}
          </div>
        </div>

        <div className={LP.divider}>
          <p className={LP.sub}>Quick actions (over RCON)</p>
          <div className="flex flex-wrap gap-1.5">
            {CS2_ACTIONS.map(([label, cmd]) => (
              <button key={label} className={LP.qbtn} disabled={!!qbusy}
                onClick={() => runCmd(label, cmd)}>
                {qbusy === label ? '…' : label}
              </button>
            ))}
          </div>
        </div>

        <div className={LP.divider}>
          <p className={LP.sub}>Map</p>
          <div className={LP.row}>
            <span className={LP.label}>Change map</span>
            <select className={LP.sel} value={pickMap} onChange={e => setPickMap(e.target.value)}>
              {CS2_MAPS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
            <button className={LP.qbtn} disabled={!!qbusy}
              onClick={() => runCmd('map', `changelevel ${pickMap}`)}>
              {qbusy === 'map' ? 'Loading…' : 'Load map'}
            </button>
          </div>
        </div>

        <p className={LP.help}>
          Sent to the running server over RCON. Mode/map changes reload the
          current map (seconds, not a pod restart). Live changes don't persist
          a pod recreate — redeploy via the wizard to make them permanent.
        </p>
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

function InstanceCard({ inst, onScale, onDelete }) {
  const [expanded, setExpanded] = useState(false)
  const [status, setStatus] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [wipeData, setWipeData] = useState(false)
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
      await onDelete(inst.ns, inst.name, { wipeData })
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
    setConfirmDelete(false); setWipeData(false); setWipeConfirm(false)
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
            </div>
            <div className="mt-2 flex items-center gap-3 flex-wrap text-xs text-slate-500">
              <span>Replicas: <span className="text-slate-300">{ready}/{desired}</span></span>
              <CopyableAddress address={status?.address} />
            </div>
            {status?.gameHealth && (
              <div className="mt-1.5">
                <GameHealthLine health={status.gameHealth} />
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 flex-shrink-0">
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

          {/* Per-instance settings: auto-update toggle + credentials */}
          <SettingsPanel namespace={inst.ns} name={inst.name} />

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
        setInstances(deps.map(d => ({
          ...d,
          service: svcs.find(s => s.ns === d.ns && s.name === d.name) || null,
        })))
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

  const deleteInstance = async (ns, name, { wipeData = false } = {}) => {
    try {
      const url = wipeData
        ? `/games/instances/${ns}/${name}?wipe_data=true`
        : `/games/instances/${ns}/${name}`
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
    <div className="max-w-6xl mx-auto px-4 py-6">
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
              onScale={scale}
              onDelete={deleteInstance}
            />
          ))}
        </div>
      )}
    </div>
  )
}
