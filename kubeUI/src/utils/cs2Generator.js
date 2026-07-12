import yaml from 'js-yaml'
import { buildGameModeManagerConfig } from './cs2GameModeManager'
import { CS2_RTV_CATALOG, buildRtvConfigJson, rtvWorkshopIds } from './cs2RtvCatalog'
import { GAMECTL_RTV_DLL_BASE64 } from './cs2RtvPluginDll'
import { GAMECTL_SURF_HUD_DLL_BASE64 } from './cs2SurfHudPluginDll'
import { GAMECTL_DM_ROUNDS_DLL_BASE64 } from './cs2DmRoundsPluginDll'

// CS2 servers run on kus/cs2-modded-server (ghcr.io/kus/cs2-modded-server) —
// a modded CS2 image that ships Metamod:Source + CounterStrikeSharp +
// SharpTimer + GameModeManager (RTV / map + game-mode voting) + 30+ game
// modes (surf, bhop, kz, 1v1 arenas, retake, deathmatch, gun game,
// competitive/MatchZy, …) all pre-integrated and working out of the box.
//
// GameCTL does NOT install plugins — bolting Metamod onto the vanilla
// joedwards32/cs2 image failed (Metamod loaded 0 plugins). Instead the
// generator emits a small custom_files OVERLAY (mounted at
// /home/custom_files) that tells the server which mode + map to boot into.
// On boot the image's install_docker.sh: steamcmd-updates CS2, lays down
// its bundled mod tree, copies our overlay on top, patches gameinfo.gi,
// and launches `cs2 +exec on_boot.cfg`.

// CS2_MODES — the wizard's gameMode options + the boot cfg/map for each
// mode. Derived from cs2RtvCatalog.js so the wizard, the live panel and the
// in-game !rtv/!modes all share one curated mode list (33 entries today).
// The boot map for each mode = the first map in that mode's catalog list.
//   cfg   — the mode config the server execs (game/csgo/cfg/<cfg>)
//   map   — default boot map (workshop id or stock map name)
//   ws    — true ⇒ boot via host_workshop_map, false ⇒ changelevel
//   label — wizard / UI label
export const CS2_MODES = Object.fromEntries(
  CS2_RTV_CATALOG.map((m) => [m.key, {
    cfg: m.cfg,
    map: m.maps[0]?.id ?? '',
    ws: !!m.maps[0]?.workshop,
    label: m.name,
  }]),
)

export const defaultCs2Form = {
  serverName: 'cs2',          // deployment/service name
  hostname: 'GameCTL CS2',    // in-game server name
  image: 'ghcr.io/kus/cs2-modded-server:latest',
  // Deep-validate on start. CS2 already updates to the latest build on every
  // (re)start (the command override pre-warms SteamCMD + clears stale staging,
  // then runs app_update); this only adds an extra full `validate` integrity
  // pass (slower — re-hashes ~65G). Default off = fast. Drives GAMECTL_VALIDATE;
  // flippable via the manage screen's Auto-update toggle or here at install.
  updateOnStart: false,
  gameMode: 'surf',           // key into CS2_MODES
  // Greeting printed to each player a few seconds after they join (set blank
  // to disable). Supports {green}/{yellow}/{default} color tokens.
  welcomeMessage: '',
  // Retakes: bots that fill empty slots. Default 0 = human-only — the kus
  // image's upstream bot AI gets confused in retakes (knife-idling, buy-on-
  // top-of-allocator). Raise this in the wizard if you accept some jank.
  retakeBots: 0,
  // Storage — the CS2 install is ~65G; the volume mounts at /home/steam/cs2.
  storageMode: 'remote',      // 'remote' (NFS) | 'local' (hostPath)
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/cs2-modded',
  localDataPath: '/mnt/1TBSSD/cs2-modded',
  storage: '90Gi',
  // Networking
  port: 27015,
  tvPort: 27020,
  lbIP: '10.0.0.220',
  tickrate: 128,
  maxPlayers: 24,
  // Auth / Steam
  rconPassword: 'ChangeMe12345',
  serverPassword: '',
  steamApiKey: '',            // Steam Web API key — REQUIRED for Workshop maps
  gslt: '',                   // GSLT (STEAM_ACCOUNT) — for a public server
  // Workshop map override — blank uses the mode's default map. The wizard's
  // map picker writes a catalog map id (or a custom workshop id) here.
  workshopMap: '',
  workshopCollection: '',
  // Per-server RTV map pool — { [modeKey]: [mapId,…] }. null = the full
  // curated catalog (cs2RtvCatalog.js). The wizard's RTV-pool editor sets it.
  rtvPool: null,
  // Auto-preload all subscribed workshop maps after boot. Stamps the
  // gamectl.io/preload-workshop-maps annotation; the GameCTL reconciler
  // watches for it and kicks off the host_workshop_map cycle once the pod
  // is ready and no players are connected. See cs2_reconciler.go.
  preloadWorkshopMaps: false,
  // Admin — a SteamID64 here is granted CounterStrikeSharp #css/admin
  adminSteamId: '',
  // Resources — CS2 + steamcmd validate are memory-hungry.
  cpuRequest: '1', cpuLimit: '4', memRequest: '2Gi', memLimit: '6Gi',
}

// dq strips double-quotes so a value can't break out of a "quoted" cfg token.
const dq = (s) => String(s == null ? '' : s).replace(/"/g, '')

export function buildCs2Yaml(f = defaultCs2Form) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const depName = f.serverName || 'cs2'
  const labels = { app: depName, game: 'cs2', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.port || 27015)
  const tvPort = Number(f.tvPort || 27020)
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  // PV — the ~65G CS2 install. Mounts at /home/steam/cs2 in the container.
  const pvName = `${depName}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels },
    spec: isLocal ? {
      capacity: { storage: f.storage || '90Gi' }, accessModes: ['ReadWriteOnce'],
      persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'manual',
      hostPath: { path: f.localDataPath || '/mnt/1TBSSD/cs2-modded', type: 'DirectoryOrCreate' },
    } : {
      capacity: { storage: f.storage || '90Gi' }, accessModes: ['ReadWriteMany'],
      persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'nfs-static',
      mountOptions: ['nfsvers=4.2'],
      nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/cs2-modded', readOnly: false },
    },
  })
  const pvcName = `${depName}-pvc`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels },
    spec: {
      accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'],
      storageClassName: isLocal ? 'manual' : 'nfs-static',
      resources: { requests: { storage: f.storage || '90Gi' } }, volumeName: pvName,
    },
  })

  // --- Resolve the mode + boot map -----------------------------------------
  const mode = CS2_MODES[f.gameMode] || CS2_MODES.surf
  const wsOverride = String(f.workshopMap || '').trim()
  let mapCmd = ''
  if (wsOverride) mapCmd = `host_workshop_map ${wsOverride}`
  else if (mode.ws && mode.map) mapCmd = `host_workshop_map ${mode.map}`
  else if (!mode.ws && mode.map) mapCmd = `changelevel ${mode.map}`
  // else: no forced map — GameModeManager picks the mode's own default.

  // on_boot.cfg — the EXEC target. The server launches on the hardcoded
  // +map de_dust2 and is still loading when on_boot runs, so mode/map
  // commands are staggered with exec_after_delay (from the bundled
  // CS2_ExecAfter plugin): exec the mode cfg, then change to a mode map,
  // then exec our server-identity cfg LAST so hostname/tags stick.
  const onBoot = [
    `echo "GameCTL on_boot.cfg — mode: ${f.gameMode || 'surf'}"`,
    `exec_after_delay 30 "exec ${mode.cfg}"`,
    ...(mapCmd ? [`exec_after_delay 36 "${mapCmd}"`] : []),
    `exec_after_delay 42 "exec gamectl_server.cfg"`,
    '',
  ].join('\n')

  // gamectl_server.cfg — server identity, execd after the mode cfg so it
  // wins regardless of what the mode's own custom_<mode>.cfg sets.
  const serverCfg = [
    '// GameCTL — server identity, execd last by on_boot.cfg',
    `hostname "${dq(f.hostname || 'GameCTL CS2')}"`,
    `sv_tags "${dq(`${f.tickrate || 128},${f.gameMode || 'surf'},GameCTL`)}"`,
    '// Disable the Valve "pick a stock map with pictures" end-of-match vote —',
    "// GameCtlRtv handles map voting, the stock UI just gets in the way.",
    'mp_endmatch_votenextmap 0',
    '',
  ].join('\n')

  // admins.json — CounterStrikeSharp Admin Framework. The canonical admin
  // list lives in a ConfigMap (cs2-<server>-admins) that GameCTL's CS2
  // admin panel reads/writes. The gen-config init container mounts that
  // ConfigMap (optional — absent on a first deploy) and prefers it; if
  // it's not there yet, it seeds admins.json from the wizard's admin
  // SteamID. So live-added admins survive a pod recreate.
  const adminId = String(f.adminSteamId || '').trim()
  const adminsSeed = adminId
    ? JSON.stringify({ 'GameCTL Admin': { identity: adminId, groups: ['#css/admin'] } }, null, 2)
    : ''
  const adminsCM = `cs2-${depName}-admins`
  // cs2-<server>-config — durable welcome_message / hostname overrides.
  // The CS2 settings panel writes to this CM so live edits survive a
  // pod recreate (gen-config below reads it and patches the files).
  const configCM = `cs2-${depName}-config`

  // gen-config init container — writes the custom_files overlay onto a
  // shared emptyDir that the CS2 container then consumes at /home/custom_files.
  const OV = '/home/custom_files'
  const adminsDest = `${OV}/addons/counterstrikesharp/configs/admins.json`
  // GameModeManager.json — overlays the kus image's bundled plugin config.
  // Its own (buggy) RTV is turned off there; see cs2GameModeManager.js.
  const gmmDir = `${OV}/addons/counterstrikesharp/configs/plugins/GameModeManager`
  const gmmJson = buildGameModeManagerConfig()

  // GameCtlRtv — the two-stage RTV plugin (mode vote → map vote). The compiled
  // DLL is base64-embedded (cs2RtvPluginDll.js) and decoded into the overlay;
  // the mode/map catalog (cs2RtvCatalog.js) becomes GameCtlRtv.json. Its
  // workshop maps also seed subscribed_file_ids.txt so the kus image
  // pre-downloads them at boot — replacing the image's ~174-map default pile.
  const rtvDir = `${OV}/addons/counterstrikesharp/plugins/GameCtlRtv`
  const rtvCfgDir = `${OV}/addons/counterstrikesharp/configs/plugins/GameCtlRtv`
  // GameCtlSurfHUD — minimal speed + map-timer plugin for movement modes
  // (surf / bhop / kz). Auto-loaded on those modes via the custom_<mode>.cfg
  // overlays below; not loaded by default so non-movement modes (comp,
  // casual, dm) keep a clean center-HUD.
  const surfHudDir = `${OV}/addons/counterstrikesharp/plugins/disabled/GameCtlSurfHUD`
  // GameCtlDmRounds — server-wide weapon-rotation in DM (replaces the
  // upstream-broken kus Deathmatch.dll round logic). Kept in disabled/ so
  // it only runs when custom_deathmatch.cfg explicitly loads it.
  const dmRoundsDir = `${OV}/addons/counterstrikesharp/plugins/disabled/GameCtlDmRounds`
  const rtvJson = buildRtvConfigJson(f.rtvPool, f.welcomeMessage || '')
  const rtvIds = rtvWorkshopIds(f.rtvPool)

  // custom_retake.cfg — the kus image's Retakes mode (cs2-retakes/retakes.cfg)
  // ships bot_quota 0, because retakes is human-only by design. On a homelab
  // server that means no retake rounds run until ~9 humans join — the mode
  // just drops you onto an idle map. retake_settings.cfg execs custom_retake.cfg
  // AFTER retakes.cfg, so this override wins: bots fill the empty slots (fill
  // mode ⇒ they drop out as real players join). Written for every deploy —
  // only retake.cfg ever execs it, so it's inert in the other modes, and a
  // live switch to Retakes from the manage panel picks it up too.
  const retakeBots = Math.max(0, Math.min(9, Math.round(Number(f.retakeBots ?? 8)) || 0))
  const retakeCfg = [
    '// GameCTL — keep Retakes playable when there are not enough humans.',
    '// cs2-retakes/retakes.cfg sets bot_quota 0; retake_settings.cfg execs',
    '// this file after it, so this wins. fill mode: bots leave as humans join.',
    '// Kept below the RetakesPlugin active cap (9) so a joining player drops',
    '// into a free slot instead of landing in the waiting queue behind bots.',
    '// Cross-mode safety — unload sibling GameCtl plugins.',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    '// Reset cvars DM/zombie leave drifted.',
    'mp_respawn_on_death_t 0',
    'mp_respawn_on_death_ct 0',
    'mp_ignore_round_win_conditions 0',
    'mp_round_restart_delay 3',
    'bot_quota_mode fill',
    `bot_quota ${retakeBots}`,
    'bot_difficulty 2',
    '',
  ].join('\n')

  // Bot-AI behaviour-tree cfgs. The kus image's stock settings/bots_*.cfg
  // point mp_bot_ai_bt at .kv3 paths that don't resolve as shipped:
  // bots_dont_buy / bots_buy use Windows-style backslashes, and bots_dm /
  // bots_ar point at scripts/ai/{deathmatch,armsrace}/ dirs that aren't in
  // the image at all. A path that doesn't resolve leaves bots with no
  // behaviour tree, so they idle holding a knife. These overlay copies
  // repoint each one at a tree that exists (forward slashes, addons/scripts).
  const botAiCfg = (file, tree) => [
    `// GameCTL — corrected bot-AI path. The kus stock ${file} points`,
    '// mp_bot_ai_bt at an unresolvable .kv3 path, leaving bots knife-idling;',
    '// this points it at a behaviour tree that actually exists.',
    `mp_bot_ai_bt "addons/scripts/ai/${tree}/bt_default.kv3"`,
    'mp_bot_ai_bt_clear_cache',
    `echo "settings/${file} executed"`,
    '',
  ].join('\n')
  const botCfgs = {
    'bots_dont_buy.cfg': botAiCfg('bots_dont_buy.cfg', 'dont_buy'),
    'bots_buy.cfg': botAiCfg('bots_buy.cfg', 'buy'),
    // DM bots: dont_buy tree. The "buy" tree expects a round_start
    // weapon-pick phase that DM (game_mode 2) never has, so bots default
    // to knife. dont_buy assumes bots are pre-equipped — which is
    // exactly what GameCtlDmRounds does on every rotation + spawn.
    'bots_dm.cfg': botAiCfg('bots_dm.cfg', 'dont_buy'),
    'bots_ar.cfg': botAiCfg('bots_ar.cfg', 'buy'),
  }

  // unload_plugins.cfg — overlay of the kus image's mode-switch reset.
  // The image's copy unloads every mode-scoped plugin so a !rtv into a new
  // mode boots from a clean slate, then that mode's cfg reloads the ones
  // it wants. The kus list doesn't know about our GameCtlSurfHUD though,
  // so its speed counter / surf timer leaked into Minigames and other
  // non-movement modes. This overlay mirrors the upstream list verbatim
  // and appends our own unload — surf/bhop/kz then re-load via the
  // custom_<mode>.cfg files. ModuleName from GameCtlSurfHUD.cs:45.
  const unloadPluginsCfg = [
    '// GameCTL — overlay of the kus image\'s unload_plugins.cfg. Mirrors',
    '// upstream verbatim then appends GameCtlSurfHUD so the surf HUD does',
    '// not leak into non-movement modes after a !rtv.',
    'css_plugins unload "MatchZy"',
    'css_plugins unload "SharpTimer"',
    'css_plugins unload "ST-Fixes"',
    'css_plugins unload "Damage Informations"',
    'css_plugins unload "CS2_GunGame"',
    'css_plugins unload "Remove Map Weapons"',
    'css_plugins unload "K4-Arenas"',
    'css_plugins unload "Retakes Plugin"',
    'css_plugins unload "Executes Plugin"',
    'css_plugins unload "Instadefuse Plugin"',
    'css_plugins unload "Retakes Allocator Plugin"',
    'css_plugins unload "Deathmatch Core"',
    'css_plugins unload "Advertisement"',
    'css_plugins unload "WhiteList"',
    'css_plugins unload "Open Prefire Prac"',
    'css_plugins unload "Deathrun Manager Plugin"',
    'css_plugins unload "MutualScoringPlayers"',
    'css_plugins unload "OneInTheChamber"',
    'css_plugins unload "Advanced Weapon System"',
    'css_plugins unload "CS2 QuakeSounds"',
    '// GameCTL additions — keep these confined to their mode.',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    '// CS2 Announcement Broadcaster is the center-screen "ROUND X" flash',
    '// nobody wants — unload everywhere; GameCTL\'s plugins use chat for',
    '// announcements.',
    'css_plugins unload "CS2 Announcement Broadcaster"',
    '// Reload CS2Rcon — MatchZy load unloads it; mode switches need it back.',
    'css_plugins reload "CS2Rcon"',
    '',
  ].join('\n')

  // custom_deathmatch.cfg — lock down buys + kick bots so the kus DM
  // weapon-round rules (pistols / pistols-HS / snipers / SMGs / …) are
  // the only weapon path.
  //
  // - mp_buy_anywhere 0 + mp_buytime 0 + mp_startmoney/mp_maxmoney 0
  //   means players can't open the buy menu and have $0 anyway — the
  //   Deathmatch plugin gives them the round's weapon automatically.
  // - bot_kick + bot_quota 0: the kus default seeds 10 bots, but bots
  //   don't follow the per-round weapon rotation so they just stand
  //   around with a knife. DM is human-only territory; clear them.
  // deathmatch_settings.cfg execs this AFTER its own block, so these
  // wins; exec_after_map_start re-runs deathmatch_settings on each map.
  // custom_deathmatch.cfg — drop the broken kus Deathmatch.dll, run
  // vanilla CS2 FFA.
  //
  // The kus image's Deathmatch.dll has OnWeaponCanAcquire bound to a
  // native function pointer that no longer exists on the current CS2
  // build (NativeException: Invalid function pointer, same shape as
  // the SharpTimer breakage earlier). Every buy / pickup throws, so
  // bots are stuck on knives and the center HUD renders garbage. Until
  // kus rebuilds the plugin we just unload it and lean on CS2's stock
  // FFA. !gun goes away with the plugin but it was already broken.
  //
  // deathmatch.cfg loads the plugin BEFORE deathmatch_settings.cfg's
  // exec_after_map_start re-runs us, so the unload here runs after
  // the load and clears it.
  const customDeathmatchCfg = [
    '// GameCTL — drop the upstream-broken kus DM plugin, use vanilla FFA',
    '// + our own GameCtlDmRounds plugin for the weapon round-rotation.',
    '// Force Deathmatch game_type/mode explicitly: kus deathmatch.cfg',
    '// starts with game_type 0; game_mode 0 (Casual) and only flips it',
    '// via gamemode_deathmatch.cfg deeper in the chain. game_type/mode',
    '// are only honoured on the next changelevel, so an in-place !rtv',
    '// leaves the scoreboard reading as Casual.',
    'css_plugins unload "Deathmatch Core"',
    '// Cross-mode safety — unload sibling GameCtl plugins so we don\'t',
    '// stack their event handlers on top of DM Rounds.',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    '// GameCtl Surf HUD draws PrintToCenter every tick on movement maps.',
    '// On a !mode swap from surf → DM the plugin is still loaded and its',
    '// speed/timer text leaks into the DM HUD until something clears it.',
    '// Unload it here so it cleans up via its Unload() handler (clears',
    '// PrintToCenter for every player).',
    'css_plugins unload "GameCtl Surf HUD"',
    '// CS2 Announcement Broadcaster posts a center-HTML flash on every',
    '// round/mode change — competes with GameCtlDmRounds chat announces',
    '// and is just noise in DM. Unload it.',
    'css_plugins unload "CS2 Announcement Broadcaster"',
    '// MutualScoringPlayers is the mid-screen kill-feed popup. The kus',
    '// deathmatch.cfg loads it AFTER this exec runs, so we also re-run',
    '// the unload below at the end of deathmatch_settings.cfg via the',
    '// second exec of this file. The pair makes sure it stays unloaded.',
    'css_plugins unload "MutualScoringPlayers"',
    'css_plugins load "plugins/disabled/GameCtlDmRounds/GameCtlDmRounds.dll"',
    '',
    'game_type 1',
    'game_mode 2',
    'sv_skirmish_id 0',
    '',
    '// Disable Valve\'s native DM bonus-weapon cycle. Only the cvars',
    '// that actually exist on this CS2 build (verified via libserver.so',
    '// grep) — mp_dm_bonus_percentage and mp_freeforall are gone.',
    'mp_dm_time_between_bonus_min 999999',
    'mp_dm_time_between_bonus_max 999999',
    'mp_dm_bonus_length_min 0',
    'mp_dm_bonus_length_max 0',
    '',
    '// Kill the buy menu — both humans and bots get weapons handed to',
    '// them by GameCtlDmRounds on every rotation + spawn, so nobody',
    '// needs the B-menu. No money, no buy zone, no buy time.',
    'mp_buy_anywhere 0',
    'mp_buy_during_immunity 0',
    'mp_buytime 0',
    'mp_startmoney 0',
    'mp_maxmoney 0',
    'mp_afterroundmoney 0',
    'mp_playercashawards 0',
    'mp_teamcashawards 0',
    'mp_buy_allow_grenades 0',
    '',
    // mp_freeforall doesn't exist on this CS2 build; mp_teammates_are_enemies
    // alone gives FFA behaviour in game_mode 2.
    'mp_teammates_are_enemies 1',
    'mp_friendlyfire 0',
    'mp_solid_teammates 0',
    'mp_respawn_on_death_t 1',
    'mp_respawn_on_death_ct 1',
    'mp_respawn_immunitytime 2',
    'mp_freezetime 0',
    // Full warmup-disable set. mp_warmup_end alone doesn\'t prevent CS2',
    // from re-entering warmup on a map change if mp_warmuptime is non-0
    // or mp_warmuptime_all_players_connected is set.
    'mp_warmuptime 0',
    'mp_warmuptime_all_players_connected 0',
    'mp_warmup_pausetimer 0',
    'mp_warmup_offline_enabled 0',
    'mp_team_intro_time 0',
    'mp_warmup_end',
    'mp_buy_anywhere 1',
    'mp_buytime 99999',
    'mp_startmoney 16000',
    'mp_maxmoney 16000',
    'mp_afterroundmoney 16000',
    'mp_playercashawards 1',
    'mp_teamcashawards 1',
    'mp_buy_during_immunity 1',
    '',
    'bot_quota 8',
    'bot_quota_mode fill',
    'bot_difficulty 2',
    'bot_chatter normal',
    'bot_join_after_player 0',
    '',
    'echo "custom_deathmatch.cfg — kus DM plugin unloaded, vanilla FFA active"',
    '',
  ].join('\n')

  // custom_minigames.cfg — strip the casual-mode bomb + round timer the
  // stock minigames_settings.cfg inherits from gamemode_casual.cfg. The
  // user-visible problems on skeet / lego / course maps:
  //   - T players spawn with the C4 (game_type/mode 0 ⇒ casual w/ bomb)
  //   - A visible round timer counts down and ends the "round"
  // Neither makes sense for a chill arena minigame. We turn off C4 hand-out,
  // ignore round win conditions, and push roundtime to a max so the timer
  // effectively disappears.
  const customMinigamesCfg = [
    '// GameCTL — drop bomb + endless rounds + skip the "frozen at spawn"',
    '// dance for the minigames mode. The stock minigames_settings.cfg only',
    '// calls mp_warmup_end once at exec time; without these knobs the next',
    '// round freezetime locks players in place again, and on skeet / scoring',
    '// maps that round-restart is constant.',
    '// Cross-mode safety — unload sibling GameCtl plugins.',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    'mp_give_player_c4 0',
    'mp_ignore_round_win_conditions 1',
    'mp_roundtime 60',
    'mp_roundtime_defuse 60',
    'mp_timelimit 0',
    'mp_maxrounds 0',
    'mp_freezetime 0',
    'mp_warmuptime 0',
    'mp_warmuptime_all_players_connected 0',
    'mp_warmup_pausetimer 0',
    'mp_warmup_end',
    'mp_team_intro_time 0',
    'mp_respawn_immunitytime 0',
    'echo "custom_minigames.cfg — no bomb, no round timer, no freezetime"',
    '',
  ].join('\n')

  // custom_gg.cfg — Gun Game / Arms Race FFA + spawn-spread overrides.
  // gg_settings.cfg ships mp_teammates_are_enemies 0 (team Arms Race), so
  // mates spawn together and can't shoot each other — players complain
  // they're always stacked beside teammates. This file is exec'd AFTER
  // gg_settings.cfg (`exec custom_gg.cfg` is the last meaningful line
  // there), so these overrides win for both fresh map loads and the
  // re-exec on every map start (`exec_after_map_start "exec gg_settings.cfg"`).
  //   - mp_teammates_are_enemies 1 + mp_friendlyfire 1: real FFA, everyone
  //     can damage everyone.
  //   - mp_solid_teammates 1: no walking through teammates either.
  //   - mp_randomspawn 1: pick any spawn point on the map regardless of
  //     team — biggest single fix for "always beside each other".
  //   - mp_respawn_immunitytime 3: a beat longer than the 2s default so
  //     fresh respawns aren't instantly headshot by someone camping a
  //     popular spawn cluster.
  const customGgCfg = [
    '// GameCTL — FFA + better spawn distribution for Gun Game / Arms Race.',
    '// gg_settings.cfg execs this last, and exec_after_map_start re-runs',
    '// gg_settings.cfg every map load — so these stick across the mode.',
    '// Cross-mode safety — unload sibling GameCtl plugins.',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    'mp_teammates_are_enemies 1',
    'mp_friendlyfire 1',
    'mp_solid_teammates 1',
    'mp_randomspawn 1',
    'mp_respawn_immunitytime 3',
    '// GG is continuous-respawn FFA — opposite of comp/aim.',
    'mp_respawn_on_death_t 1',
    'mp_respawn_on_death_ct 1',
    'echo "custom_gg.cfg — FFA + random spawns active"',
    '',
  ].join('\n')

  // custom_bhop.cfg — execd late by bhop_settings.cfg, after the kus image's
  // base cfgs set mp_freezetime/mp_warmuptime. Clears them so players can
  // move the instant they spawn (the 15s freezetime is the "can't move at
  // spawn" everyone hits on bhop). Also loads GameCtlSurfHUD for the
  // speed + best-time HUD.
  const customBhopCfg = [
    '// GameCTL — skip the warmup/freezetime that locks bhop players at spawn.',
    'mp_warmuptime 0',
    'mp_warmuptime_all_players_connected 0',
    'mp_warmup_pausetimer 0',
    'mp_warmup_end',
    'mp_freezetime 0',
    '// Cross-mode safety — clear sibling GameCtl plugins.',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    'css_plugins load "plugins/disabled/GameCtlSurfHUD/GameCtlSurfHUD.dll"',
    '',
  ].join('\n')

  // custom_surf.cfg — opts surf mode into our speed/timer HUD. The kus
  // image's surf.cfg already tries to load SharpTimer, but SharpTimer
  // remains broken at HookFunction (Invalid function pointer) on the
  // current CS2 build; GameCtlSurfHUD fills that gap with a minimal
  // speed-in-u/s + map-completion timer based on detecting end-zone
  // trigger_multiple names.
  const customSurfCfg = [
    '// GameCTL — load the GameCtlSurfHUD plugin for surf maps.',
    '// SharpTimer ships in the image but loads dead on CS2; this plugin',
    '// provides the speed + map-timer subset most surf players actually use.',
    '// Cross-mode safety — clear sibling GameCtl plugins.',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    'css_plugins load "plugins/disabled/GameCtlSurfHUD/GameCtlSurfHUD.dll"',
    '',
    '// No bots on surf. The ghost replay used to be a driven CT bot, which',
    '// is why this file (and the kus / SharpTimer baselines we override)',
    '// kept bot_quota at 2 with fill mode + bot_auto_vacate 0. The ghost is',
    '// now a prop_dynamic + worldtext label (see GameCtlSurfHUD.StartReplay),',
    '// so bots are pure noise. bot_kick clears any already-spawned ones,',
    '// bot_quota 0 + normal mode prevents the engine from refilling on',
    '// round_start.',
    'bot_kick',
    'bot_quota 0',
    'bot_quota_mode normal',
    '',
  ].join('\n')

  // surf_settings.cfg — overlay over kus's baseline so we can drop the
  // unconditional `bot_kick` it ships with. That kick fires on every
  // map start (kus pins it via exec_after_map_start "exec surf_settings.cfg")
  // and races our ghost-replay bot off the server. Everything else
  // matches the kus baseline so surf mode keeps its expected behavior.
  const surfSettingsCfg = [
    'exec gamemode_casual.cfg',
    '',
    'sv_cheats 1',
    '',
    'exec settings/course.cfg',
    'exec settings/map_voting.cfg',
    'exec settings/surf_on.cfg',
    'exec settings/alltalk_on.cfg',
    'exec settings/one_round.cfg',
    'exec settings/no_warmup.cfg',
    'exec settings/no_drop_weapons.cfg',
    '',
    '// Enable extend in end of map vote',
    'css_rtv_extend true',
    '',
    '// Surf has no bots — the ghost replay is a prop now, not a driven',
    '// CT bot. bot_kick here matches the kus baseline that this overlay',
    '// replaces; custom_surf.cfg below pins bot_quota 0 + normal mode so',
    '// the engine never refills.',
    'bot_kick',
    '',
    'exec custom_surf.cfg',
    '',
    'sv_cheats 0',
    '',
    'echo "surf_settings.cfg executed (gamectl overlay — bot_kick removed)"',
    '',
  ].join('\n')

  // custom_bots.cfg — the kus image's bots.cfg ends with
  // `exec custom_bots.cfg`, so this is the documented override hook.
  // We use it to keep surf bot-free regardless of what kus's bots.cfg
  // sets upstream.
  const customBotsCfg = [
    '// GameCTL — no bots on surf. bots.cfg defaults vary; this is the',
    '// override hook so we end up with quota=0 in every cfg path.',
    'bot_kick',
    'bot_quota 0',
    'bot_quota_mode normal',
    'echo "custom_bots.cfg applied — bots disabled on surf"',
    '',
  ].join('\n')

  // SharpTimer/MapData/MapExecs/surf_.cfg — verbatim from the kus image
  // baseline except bot_quota_mode flipped from "fill" to "normal". In
  // "fill" mode with quota=1 the engine maintains a TOTAL of 1 player+bot,
  // so once a human joins CT no bot is ever added. We keep all the other
  // surf-tuning cvars exactly as SharpTimer wants them.
  const sharpTimerSurfMapExec = [
    '// Round Settings',
    'mp_roundtime 30',
    'mp_roundtime_defuse 30',
    'mp_roundtime_hostage 30',
    'mp_timelimit 30 ',
    'mp_maxrounds 0\t',
    'mp_freezetime 0',
    'mp_halftime false              ',
    'mp_overtime_enable false ',
    'mp_round_restart_delay 0               ',
    'mp_team_intro_time 0 ',
    'mp_team_timeout_max 0                  ',
    'mp_technical_timeout_per_team 0',
    'sv_warmup_to_freezetime_delay 0        ',
    'mp_buytime 0',
    'mp_ignore_round_win_conditions true    ',
    'mp_respawn_immunitytime -1',
    'mp_respawn_on_death_ct true',
    'mp_respawn_on_death_t true',
    'mp_warmuptime 0',
    'mp_warmup_end',
    '',
    '// Movement',
    'sv_airaccelerate 150',
    'sv_enablebunnyhopping 1',
    'sv_autobunnyhopping 1',
    'sv_falldamage_scale 0',
    'sv_staminajumpcost 0',
    'sv_staminalandcost 0',
    'sv_timebetweenducks 0.400000',
    'sv_staminarecoveryrate 60.0',
    'sv_staminamax 80.0',
    'sv_ladder_scale_speed 0.780000',
    'sv_jump_impulse 301.993378',
    'sv_friction 5.2',
    'sv_accelerate_use_weapon_speed false',
    'sv_accelerate 6.5',
    'sv_maxvelocity 9876.0',
    'sv_air_max_wishspeed 30.000000',
    'sv_gravity 800.0',
    'sv_wateraccelerate 10.0',
    'sv_jump_precision_enable false',
    '',
    '',
    '// Team & Map Settings',
    'ff_damage_reduction_bullets 0',
    'ff_damage_reduction_grenade 0',
    'ff_damage_reduction_grenade_self 0',
    'ff_damage_reduction_other 0',
    'mp_damage_headshot_only 1',
    'mp_damage_scale_ct_head 0.0',
    'mp_damage_scale_t_head 0.0',
    'mp_damage_scale_ct_body 0.0',
    'mp_damage_scale_t_body 0.0',
    'mp_autokick 0',
    'mp_autoteambalance 0',
    'mp_forcecamera 0                          ',
    'mp_force_pick_time 60',
    'mp_friendlyfire 0',
    'mp_limitteams 0                          ',
    'mp_randomspawn 0',
    'mp_randomspawn_los 0',
    'mp_solid_teammates 0                     ',
    'mp_spectators_max 64',
    'mp_suicide_penalty false',
    'mp_team_timeout_max 0                    ',
    'mp_teamname_1 "SHARPTIMER"                     ',
    'mp_teamname_2 "SHARPTIMER"                     ',
    'sv_falldamage_scale 0',
    'sv_show_teammate_death_notification 0',
    'sv_disable_radar 1',
    '',
    '// Money & Weapon Stuff',
    'mp_afterroundmoney 0',
    'mp_free_armor 0                          ',
    'mp_maxmoney 0',
    'mp_startmoney 0                      ',
    'mp_teamcashawards false',
    'mp_playercashawards false',
    'mp_weapons_allow_map_placed false',
    'mp_weapons_allow_zeus 0',
    'sv_infinite_ammo 2',
    'mp_ct_default_secondary weapon_usp_silencer',
    'mp_t_default_secondary weapon_usp_silencer',
    'mp_drop_knife_enable 1',
    'mp_weapons_allow_map_placed 0',
    'mp_death_drop_gun 0',
    '',
    '',
    '// Voting Settings',
    'sv_workshop_allow_other_maps true',
    'mp_endmatch_votenextmap true                                   ',
    'mp_endmatch_votenextmap_keepcurrent false                      ',
    'mp_match_end_changelevel true                                  ',
    'mp_match_end_restart false                                     ',
    'mp_match_restart_delay 0                                       ',
    'sv_allow_votes true                                            ',
    '',
    '// Voice Settings',
    'sv_auto_full_alltalk_during_warmup_half_end true',
    'sv_deadtalk true                                               ',
    'sv_full_alltalk true',
    'sv_ignoregrenaderadio true',
    'sv_talk_enemy_dead true                                        ',
    'sv_talk_enemy_living true                                      ',
    '',
    '// Misc',
    'mp_disconnect_kills_players true                           ',
    '',
    '// Bot Settings',
    'bot_controllable 0',
    '// GameCTL: no bots on surf — the ghost replay is a prop now, not a',
    '// driven bot. quota=0 + normal mode + kick keeps the SharpTimer',
    '// MapExec re-execs from re-seeding bots on map start.',
    'bot_kick',
    "bot_quota 0",
    "bot_quota_mode normal",
    '',
    '// SharpTimer Settings',
    'sharptimer_remove_legs true',
    'sharptimer_remove_collision true',
    'sharptimer_remove_damage true',
    'sharptimer_kill_pointservercommand_entities true',
    '',
    'sharptimer_use2Dspeed_enabled true',
    'sharptimer_disable_telehop true',
    'sharptimer_max_start_speed_enabled true',
    'sharptimer_max_start_speed 320',
    'sharptimer_force_knife_speed true',
    'sharptimer_forced_player_speed 260',
    '',
    'sharptimer_respawn_enabled true',
    'sharptimer_top_enabled true ',
    'sharptimer_rank_enabled true ',
    '',
    'sharptimer_checkpoints_enabled true',
    'sharptimer_remove_checkpoints_restrictions true',
    'sharptimer_checkpoints_only_when_timer_stopped true',
    '',
  ].join('\n')

  // custom_kz.cfg — same plugin, since KZ is even more timer-focused
  // than surf and SharpTimer is equally broken there.
  const customKzCfg = [
    '// GameCTL — load the GameCtlSurfHUD plugin for KZ maps.',
    '// Cross-mode safety — clear sibling GameCtl plugins.',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    'css_plugins load "plugins/disabled/GameCtlSurfHUD/GameCtlSurfHUD.dll"',
    '',
  ].join('\n')

  // custom_aim.cfg — Aim mode overlay. The kus image's custom_aim.cfg
  // is a placeholder; players reported endless respawning + 10s
  // round-end pauses after switching aim ← DM, because DM's
  // mp_respawn_on_death_*=1 and mp_round_restart_delay=10 leaked
  // through. This cfg explicitly resets those + self-pins them on
  // every round_start so other modes' drift can't bleed in.
  const customAimCfg = [
    '// GameCTL — Aim overlay. Cross-mode safety + cvar resets.',
    '// Cross-mode safety — unload sibling GameCtl plugins.',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    '',
    '// Aim is round-based, single-life, fast turnover.',
    'mp_respawn_on_death_t 0',
    'mp_respawn_on_death_ct 0',
    'mp_ignore_round_win_conditions 0',
    'mp_round_restart_delay 3',
    'mp_freezetime 3',
    'mp_team_intro_time 0',
    'mp_warmuptime 0',
    'mp_warmup_pausetimer 0',
    'mp_roundtime 1.92',
    'mp_maxrounds 24',
    'mp_buy_anywhere 1',
    'mp_buytime 0',
    'mp_startmoney 16000',
    'mp_maxmoney 16000',
    'mp_autoteambalance 0',
    'mp_limitteams 0',
    'sv_disable_radar 1',
    '',
    '// Re-apply on every round_start so kus aim_settings.cfg drift',
    '// can\'t change these back.',
    'exec_after_round_start "exec custom_aim.cfg"',
    'echo "custom_aim.cfg applied"',
    '',
  ].join('\n')

  // custom_hns.cfg — Prop Hunt overlay. Loads the GameCtlPropHunt
  // plugin which now provides just !heal (one-shot CT medishot, 1 use
  // per round). The base kus hns mode is fine as-is — props already
  // shoot with their default glocks.
  const customHnsCfg = [
    '// GameCTL — Prop Hunt overlay. Cross-mode safety + plugin load.',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins load "plugins/disabled/GameCtlPropHunt/GameCtlPropHunt.dll"',
    '',
    'mp_freezetime 3',
    'mp_team_intro_time 0',
    'mp_round_restart_delay 3',
    'mp_roundtime 5',
    'mp_roundtime_defuse 5',
    'mp_warmuptime 10',
    'mp_maxrounds 12',
    'mp_halftime 1',
    'sv_full_alltalk 1',
    'echo "custom_hns.cfg applied"',
    '',
  ].join('\n')

  // custom_1v1.cfg — shortens the round-restart so K4-Arenas players don't
  // respawn into the dying tail of the previous round still shooting them.
  const custom1v1Cfg = [
    '// GameCTL — 1v1 Arenas overlay. K4-Arenas wants single-life',
    '// rounds: a kill ends the round, plugin rotates everyone to new',
    '// arenas with new opponents. kus 1v1_settings.cfg sets respawn=1',
    '// (wrong for rotation) so we OVERRIDE here.',
    'exec_after_round_start ""',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Hard-disable K4-Arenas-Bots if the kus base ever loads it — bots',
    '// don\'t get the K4 arena weapon hand-out, end up knife-only, and',
    '// break round rotation. 1v1 mode is human-only by policy.',
    'css_plugins unload "K4-Arenas-Bots"',
    '// Single-life-per-round so K4-Arenas can rotate on round_end.',
    'mp_respawn_on_death_t 0',
    'mp_respawn_on_death_ct 0',
    'mp_ignore_round_win_conditions 0',
    '// Reset bot-AI cvars that GameCtlDmRounds zombie-mode flips on but',
    '// the DM Rounds plugin\'s Unload() doesn\'t reset. Without this,',
    '// switching zombie → 1v1 leaves bots knife-only / unable to shoot.',
    'sv_cheats 1',
    'bot_knives_only 0',
    'bot_pistols_only 0',
    'bot_dont_shoot 0',
    'bot_freeze 0',
    'bot_zombie 0',
    'bot_ignore_enemies 0',
    'bot_mimic 0',
    'sv_cheats 0',
    'sv_infinite_ammo 0',
    'mp_round_restart_delay 1',
    'mp_match_restart_delay 1',
    '// No bots in 1v1 — kus 1v1_settings.cfg sets bot_quota 1 and the',
    '// stock K4 image fills the lobby with bots that block arena slots,',
    '// stand around with knives, and stall the rotation. Force-kick on',
    '// every mode-enter and pin quota=0 so the engine can\'t reseed.',
    'bot_quota 0',
    'bot_quota_mode normal',
    'bot_join_after_player 0',
    'bot_auto_vacate 0',
    'mp_autoteambalance 0',
    'bot_kick',
    '',
  ].join('\n')

  // K4-Arenas.json — overlay of the kus image's auto-generated K4-Arenas
  // plugin config. Two goals here:
  //   1. Variance: a long round-rotation across rifles, SMGs, snipers,
  //      shotguns, pistols, LMGs, knife, taser — every category cycles
  //      through specific weapons so players see ~20+ different fights
  //      instead of the stock "rifle / sniper / shotgun / pistol …" few.
  //   2. Fairness: both sides ALWAYS get the same weapon. We hard-pin
  //      PrimaryWeapon / SecondaryWeapon and set UsePreferredPrimary +
  //      UsePreferredSecondary to false so K4-Arenas can't fall back to
  //      per-player preference (which would let one side bring an AK
  //      while the other brought a Galil — exactly what the operator
  //      asked us to fix).
  //
  // TeamSize is pinned to 1 on every round. The stock config ships 2vs2
  // and 3vs3 entries (off by default but selectable in the gun-menu);
  // 1v1 mode is meant to be 1v1 — drop them.
  //
  // ConfigVersion 10 matches the schema CSSharp ships on this build, so
  // the plugin will accept this file verbatim instead of regenerating.
  const k4ArenasRound = (name, primary, secondary, armor) => ({
    TranslationName: name,
    TeamSize: 1,
    PrimaryWeapon: primary,
    SecondaryWeapon: secondary,
    UsePreferredPrimary: false,
    PrimaryPreference: null,
    UsePreferredSecondary: false,
    Armor: armor,
    Helmet: armor,
    EnabledByDefault: true,
  })
  const k4ArenasRoundSettings = [
    // Rifles
    k4ArenasRound('AK-47',          'weapon_ak47',           null, true),
    k4ArenasRound('M4A1-S',         'weapon_m4a1_silencer',  null, true),
    k4ArenasRound('M4A4',           'weapon_m4a1',           null, true),
    k4ArenasRound('AUG',            'weapon_aug',            null, true),
    k4ArenasRound('SG 553',         'weapon_sg556',          null, true),
    k4ArenasRound('FAMAS',          'weapon_famas',          null, true),
    k4ArenasRound('Galil AR',       'weapon_galilar',        null, true),
    // SMGs
    k4ArenasRound('MP9',            'weapon_mp9',            null, true),
    k4ArenasRound('MAC-10',         'weapon_mac10',          null, true),
    k4ArenasRound('MP7',            'weapon_mp7',            null, true),
    k4ArenasRound('UMP-45',         'weapon_ump45',          null, true),
    k4ArenasRound('P90',            'weapon_p90',            null, true),
    k4ArenasRound('PP-Bizon',       'weapon_bizon',          null, true),
    k4ArenasRound('MP5-SD',         'weapon_mp5sd',          null, true),
    // Snipers
    k4ArenasRound('AWP',            'weapon_awp',            null, true),
    k4ArenasRound('Scout (SSG 08)', 'weapon_ssg08',          null, true),
    k4ArenasRound('SCAR-20',        'weapon_scar20',         null, true),
    k4ArenasRound('G3SG1',          'weapon_g3sg1',          null, true),
    // Shotguns
    k4ArenasRound('Nova',           'weapon_nova',           null, true),
    k4ArenasRound('XM1014',         'weapon_xm1014',         null, true),
    k4ArenasRound('MAG-7',          'weapon_mag7',           null, true),
    k4ArenasRound('Sawed-Off',      'weapon_sawedoff',       null, true),
    // LMGs
    k4ArenasRound('M249',           'weapon_m249',           null, true),
    k4ArenasRound('Negev',          'weapon_negev',          null, true),
    // Pistols (PrimaryWeapon null so K4 doesn't strip the pistol slot)
    k4ArenasRound('Glock-18',       null, 'weapon_glock',          false),
    k4ArenasRound('USP-S',          null, 'weapon_usp_silencer',   false),
    k4ArenasRound('P2000',          null, 'weapon_hkp2000',        false),
    k4ArenasRound('P250',           null, 'weapon_p250',           false),
    k4ArenasRound('Five-SeveN',     null, 'weapon_fiveseven',      false),
    k4ArenasRound('Tec-9',          null, 'weapon_tec9',           false),
    k4ArenasRound('CZ75-Auto',      null, 'weapon_cz75a',          false),
    k4ArenasRound('Dual Berettas',  null, 'weapon_elite',          false),
    k4ArenasRound('Desert Eagle',   null, 'weapon_deagle',         false),
    k4ArenasRound('R8 Revolver',    null, 'weapon_revolver',       false),
    // Specials
    k4ArenasRound('Zeus x27',       null, 'weapon_taser',          false),
    k4ArenasRound('Knife',          null, null,                    false),
  ]
  const k4ArenasJson = JSON.stringify({
    'use-predefined-config': true,
    'database-settings': {
      host: 'localhost',
      username: 'root',
      database: 'database',
      password: 'password',
      port: 3306,
      sslmode: 'preferred',
      'table-prefix': '',
      'table-purge-days': 30,
    },
    'command-settings': {
      'gun-pref-commands':       ['guns', 'gunpref', 'weaponpref'],
      'round-pref-commands':     ['rounds', 'roundpref'],
      'queue-commands':          ['queue'],
      'afk-commands':            ['afk'],
      'challenge-commands':      ['challenge', 'duel'],
      'challenge-accept-commands':  ['caccept', 'capprove'],
      'challenge-decline-commands': ['cdecline', 'cdeny'],
      'center-menu-mode': true,
      'center-announce-mode': true,
      'freeze-in-center-menu': true,
      'show-menu-credits': true,
    },
    'round-settings': k4ArenasRoundSettings,
    'compatibility-settings': {
      'force-arena-clantags': false,
      'block-flash-of-not-opponent': false,
      'block-damage-of-not-opponent': false,
      'give-knife-by-default': true,
      'disable-clantags': false,
      'prevent-draw-rounds': true,
    },
    // Disable per-player weapon preferences entirely — fairness > choice.
    // With these off the !guns menu can't override the round's pinned
    // weapon, so both sides always end up with the same gun.
    'default-weapon-settings': {
      'default-rifle':   null,
      'default-sniper':  null,
      'default-smg':     null,
      'default-lmg':     null,
      'default-shotgun': null,
      'default-pistol':  null,
      'default-round':   'AK-47',
    },
    'allowed-weapon-prefs': {
      rifle:   false,
      sniper:  false,
      smg:     false,
      lmg:     false,
      shotgun: false,
      pistol:  false,
    },
    ConfigVersion: 10,
  }, null, 2)
  const k4ArenasDir = `${OV}/addons/counterstrikesharp/configs/plugins/K4-Arenas`

  // settings/quake_sounds.cfg — the kus stock cfg has the QuakeSounds plugin
  // load *commented out* and tells you to ship the uncommented version via
  // custom_files. We do exactly that — every mode that execs this cfg
  // (deathmatch, 1v1, retake, …) gets Headshot / Monster Kill / etc.
  const quakeSoundsCfg = [
    '// GameCTL — enable the QuakeSounds plugin (Headshot, Monster Kill, …).',
    'css_plugins load "plugins/disabled/QuakeSounds/QuakeSounds.dll"',
    'echo "settings/quake_sounds.cfg executed"',
    '',
  ].join('\n')

  // prac_free.cfg — the Free Practice mode: a relaxed sandbox with free buy,
  // infinite ammo, grenade trajectory + bullet impacts, noclip (via
  // sv_cheats), bots for live targets, instant respawn, no round timer.
  // (FaceIT-style scrim practice is a separate mode that execs prac.cfg.)
  const pracFreeCfg = [
    'echo "GameCTL Free Practice — exec\'d"',
    'game_type 0',
    'game_mode 1',
    'css_gamemode "Free Practice"',
    '',
    '// Keep CSSharp + MatchZy loaded — MatchZy\'s `css_prac` is what',
    '// actually opens the buy menu anywhere; without it the cvars set',
    '// mp_buy_anywhere=1 but the plugin layer still blocks the menu.',
    '// We intentionally do NOT exec unload_plugins.cfg here.',
    'css_plugins load "plugins/disabled/MatchZy/MatchZy.dll"',
    'exec settings/quake_sounds.cfg',
    '',
    '// sv_cheats 1 MUST come first — cvars with FCVAR_CHEAT',
    '// (sv_infinite_ammo, sv_grenade_trajectory_*, sv_showimpacts*,',
    '// mp_buy_anywhere, mp_buy_during_immunity, …) are silently dropped',
    '// when sv_cheats=0 with "Convar X is cheat protected, change ignored".',
    '// noclip in console also requires sv_cheats 1.',
    'sv_cheats 1',
    'sm_allow_noclip 1',
    '',
    '// Grenade trajectory + bullet impacts. CS2 renamed CS:GO\'s',
    '// sv_grenade_trajectory* to sv_grenade_trajectory_prac_* — the old',
    '// names come back as "Unknown command" on a live server.',
    'sv_grenade_trajectory_prac_trailtime 20',
    'sv_grenade_trajectory_prac_pipreview 1',
    'sv_grenade_trajectory_time_spectator 20',
    // Note: CS2 only exposes the three sv_grenade_trajectory cvars above —
    // there is no stock per-player PIP, per-thrower colour, dash or
    // thickness. Filtering the PIP to a player\'s own throws would need a
    // CSSharp plugin that hooks grenade ownership; deferred.
    'sv_showimpacts 1',
    'sv_showimpacts_time 10',
    'sv_infinite_ammo 2',
    '',
    '// All grenade slots full, all weapon classes unlocked for both teams.',
    'ammo_grenade_limit_total 5',
    'ammo_grenade_limit_default 5',
    'ammo_grenade_limit_flashbang 5',
    'mp_weapons_allow_typecount -1',
    'mp_weapons_allow_heavy -1',
    'mp_weapons_allow_pistols -1',
    'mp_weapons_allow_rifles -1',
    'mp_weapons_allow_smgs -1',
    'mp_weapons_allow_zeus -1',
    '',
    '// Free buy, unlimited cash. These are also cheat-class — they need',
    '// sv_cheats 1 (set above) to actually take effect.',
    'mp_buy_anywhere 1',
    'mp_buy_during_immunity 1',
    'mp_buytime 99999',
    'mp_maxmoney 99999',
    'mp_startmoney 65535',
    'mp_afterroundmoney 65535',
    'mp_buy_allow_grenades 1',
    'mp_free_armor 2',
    '',
    '// Instant respawn, no freeze, long rounds.',
    'mp_respawn_immunitytime 0',
    'mp_respawn_on_death_t 1',
    'mp_respawn_on_death_ct 1',
    'mp_freezetime 0',
    'mp_roundtime 60',
    'mp_roundtime_defuse 60',
    'mp_warmuptime 0',
    'mp_warmup_end',
    'mp_match_end_restart 0',
    'mp_ignore_round_win_conditions 1',
    '',
    '// No bots by default — Free Practice is a solo/duo sandbox for smoke',
    '// lineups + nade-cam, not target practice. Operators add bots from the',
    '// details panel ("Add T bot" / "Set bot quota") when they want them.',
    'bot_kick',
    'bot_quota 0',
    'bot_quota_mode normal',
    'mp_autoteambalance 0',
    'mp_limitteams 0',
    'mp_friendlyfire 0',
    'sv_alltalk 1',
    'sv_deadtalk 1',
    'mp_join_grace_time 0',
    '',
    '// MatchZy practice mode — opens the buy menu through the plugin,',
    '// activates grenade replay/save-position, infinite-money behavior.',
    'matchzy_autostart_mode 2',
    'css_prac',
    '',
    '// MatchZy\'s css_prac sets sv_cheats 0 internally, which silently',
    '// disables noclip + grenade trajectory drawing. Flip it back on AFTER',
    '// css_prac so the operator can actually use noclip in console and see',
    '// nade cam in-game. The already-applied cheat-class cvars above',
    '// (mp_buy_anywhere, sv_infinite_ammo, …) stay at their set values',
    '// regardless of sv_cheats, so flipping sv_cheats back on only restores',
    '// the cheat-runtime features (noclip, give, etc.).',
    'sv_cheats 1',
    '',
    '// Re-arm on map start only. We deliberately do NOT use',
    '// exec_after_round_start "exec prac_free.cfg" — this cfg ends with',
    '// `css_prac`, which itself triggers a round restart inside MatchZy.',
    '// A round-start re-arm would call css_prac again → another restart →',
    '// infinite restart loop (operator sees "weapons given over and over").',
    '// Cheat-class cvars (sv_cheats, mp_buy_anywhere, …) persist across',
    '// rounds in CS2, so the round re-arm wasn\'t needed in the first place.',
    'exec_after_map_start "exec prac_free.cfg"',
    '',
    'echo "prac_free.cfg executed — MatchZy practice + sandbox cvars on, no bots"',
    '',
  ].join('\n')

  // custom_practice.cfg — overlays the kus image's "Practice Mode" (prac.cfg
  // → practice.cfg → practice_settings.cfg). practice_settings.cfg already
  // sets sv_cheats 1 + sv_grenade_trajectory + sv_showimpacts, BUT it ends
  // with `sv_cheats 0` AFTER our hook, killing every cheat-class training
  // toy (noclip, grenade cam, bullet impacts). practice.cfg execs our hook
  // ONCE at mode load AND wires exec_after_round_start to re-execute it,
  // so this cfg flips sv_cheats back on after every round-start reset and
  // adds the longer trajectory windows pro players use.
  const customPracticeCfg = [
    '// GameCTL — keep the FaceIT Practice training toys ON.',
    '// kus\'s practice_settings.cfg ends with `sv_cheats 0`, which silently',
    "// disables noclip, sv_grenade_trajectory and sv_showimpacts. Re-enable",
    '// them here, and re-arm so a map/round restart can\'t clobber them.',
    '// IMPORTANT: sv_cheats 1 must precede the cheat-class cvars; CS2 drops',
    '// them silently otherwise ("Convar X is cheat protected, change ignored").',
    '// Cross-mode safety — unload sibling GameCtl plugins.',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    'sv_cheats 1',
    'sm_allow_noclip 1',
    'sv_grenade_trajectory 1',
    'sv_grenade_trajectory_dash 1',
    'sv_grenade_trajectory_thickness 0.2',
    'sv_grenade_trajectory_time 20',
    'sv_showimpacts 1',
    'sv_showimpacts_time 10',
    'sv_infinite_ammo 2',
    'ammo_grenade_limit_total 5',
    'mp_buy_anywhere 1',
    'mp_buytime 9999',
    'mp_maxmoney 60000',
    'mp_startmoney 60000',
    'mp_freezetime 0',
    'mp_warmup_end',
    'mp_respawn_on_death_ct 1',
    'mp_respawn_on_death_t 1',
    'mp_ignore_round_win_conditions 1',
    '// Re-arm on every round start so practice_settings.cfg\'s trailing',
    '// `sv_cheats 0` (re-exec\'d on map start by practice.cfg) doesn\'t win.',
    'exec_after_round_start "exec custom_practice.cfg"',
    'echo "custom_practice.cfg executed — training toys re-enabled"',
    '',
  ].join('\n')

  // custom_casual.cfg — kus\'s casual_settings.cfg is EMPTY, so casual mode
  // never execs settings/map_voting.cfg → Valve\'s end-of-match picture
  // map picker stays enabled. Disable it here so the in-game !rtv vote is
  // the only map-switch surface, matching every other mode.
  // Mini Maps — Competitive bomb-defusal on shrunk-scale workshop maps.
  // Tiny maps fit big lobbies if you take the team caps off; comp tops
  // out at 5/team by default (mp_limitteams 2 + Valve cap). We unlock
  // those so the operator can run 8v8 / 10v10 on a mini_dust2.
  const customMinimapsCfg = [
    '// GameCTL Mini Maps — Competitive with team caps unlocked.',
    '// game_type 0 / game_mode 1 = Valve Competitive.',
    '// Cross-mode safety — unload sibling GameCtl plugins.',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    '// Reset cvars DM/zombie leave drifted.',
    'mp_respawn_on_death_t 0',
    'mp_respawn_on_death_ct 0',
    'mp_ignore_round_win_conditions 0',
    'mp_round_restart_delay 3',
    'game_type 0',
    'game_mode 1',
    'sv_skirmish_id 0',
    '',
    '// Team-cap unlock: stock comp enforces 5/team via mp_limitteams + a',
    '// hidden Valve floor. Setting limitteams 0 (no cap) + autoteambalance',
    '// 0 (don\'t force-shuffle people back) lets the operator stack 8/8',
    '// or more onto the mini-map without the engine kicking joiners with',
    '// "Team is full". sv_visiblemaxplayers 32 widens the visible roster.',
    'mp_limitteams 0',
    'mp_autoteambalance 0',
    'sv_visiblemaxplayers 32',
    '',
    '// Comp pacing without the long lobby-screen ritual.',
    'mp_warmuptime 10',
    'mp_warmuptime_all_players_connected 0',
    'mp_freezetime 5',
    'mp_roundtime 1.92',
    'mp_roundtime_defuse 1.92',
    'mp_maxrounds 30',
    'mp_halftime 1',
    'mp_match_end_restart 0',
    'mp_team_intro_time 0',
    'mp_buytime 20',
    '',
    '// No auto end-of-match map picker — we want !rtv to drive map changes.',
    'sv_allow_votes 0',
    'mp_endmatch_votenextmap 0',
    'mp_endmatch_votenextleveltime 0',
    'mp_endmatch_votenextmap_keepcurrent 0',
    'mp_match_end_changelevel 0',
    '',
    '// Mini maps are small — bots crowd quickly. Default off, the operator',
    '// can use !bots N if they want to fill an empty server.',
    'bot_quota 0',
    'bot_quota_mode normal',
    '',
    'echo "custom_minimaps.cfg applied"',
    '',
  ].join('\n')

  // Competitive — pinned via exec_after_round_start (self-reapplying)
  // so MatchZy resets / surf leftover exec_after chains can't drift
  // these cvars away. Standard $800 pistol economy, team caps unlocked
  // (so 8v8/10v10 fits on mini-comp maps), bot AI cleared of any
  // zombie-mode flags (knives_only / dont_shoot / etc).
  const customCompCfg = [
    '// GameCTL Competitive — auto-reapplies on every round_start so',
    '// other mode\'s exec_after chains can\'t drift our cvars.',
    '// Belt-and-suspenders cross-mode unload — kus comp.cfg already',
    '// execs unload_plugins.cfg, but a !mode swap can sometimes skip',
    '// the chain (we\'ve seen Surf HUD persist in comp after a',
    '// surf → comp swap). Unload our 3 mode plugins explicitly here.',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    '',
    '// Reset cvars that DM/zombie modes leave drifted (respawn flags,',
    '// ignore_round_win, restart_delay). Without this, comp ← DM',
    '// leaves players respawning + rounds never ending.',
    'mp_respawn_on_death_t 0',
    'mp_respawn_on_death_ct 0',
    'mp_ignore_round_win_conditions 0',
    'mp_round_restart_delay 3',
    'game_type 0',
    'game_mode 1',
    'sv_skirmish_id 0',
    '',
    '// Team caps unlocked — supports 8v8 / 10v10 on mini-comp maps.',
    'mp_limitteams 0',
    'mp_autoteambalance 0',
    'sv_visiblemaxplayers 32',
    '',
    '// Standard comp pacing.',
    'mp_freezetime 5',
    'mp_warmuptime 10',
    'mp_warmuptime_all_players_connected 0',
    'mp_roundtime 1.92',
    'mp_roundtime_defuse 1.92',
    'mp_maxrounds 30',
    'mp_halftime 1',
    'mp_match_end_restart 0',
    'mp_team_intro_time 0',
    'mp_ignore_round_win_conditions 0',
    '',
    '// Standard comp economy — $800 pistol start, earned money up to $16000.',
    'mp_startmoney 800',
    'mp_maxmoney 16000',
    'mp_afterroundmoney 0',
    'mp_buytime 20',
    'mp_buy_anywhere 0',
    'mp_playercashawards 1',
    'mp_teamcashawards 1',
    '',
    '// Bot management mostly NOT TOUCHED here — basic CS2 bot_add /',
    '// bot_kick from console work like vanilla comp. ONE knob we DO',
    '// pin: bot_quota_mode = normal. Kus bots.cfg flips it to "fill"',
    '// at every round_start, which makes ANY manual bot_add trigger',
    '// the engine to auto-fill the rest of the slots. With "normal"',
    '// the quota = exact bot count, so a manual bot_add stays a',
    '// one-shot.',
    'bot_quota_mode normal',
    '',
    '// No end-of-match map vote — !rtv handles map changes.',
    'sv_allow_votes 0',
    'mp_endmatch_votenextmap 0',
    'mp_endmatch_votenextleveltime 0',
    'mp_endmatch_votenextmap_keepcurrent 0',
    'mp_match_end_changelevel 0',
    '',
    '// Self-pin: re-exec this cfg on every round_start so MatchZy and',
    '// any leftover exec_after chains can\'t drift the cvars away.',
    'exec_after_round_start "exec custom_comp.cfg"',
    'echo "custom_comp.cfg applied"',
    '',
  ].join('\n')

  const customCasualCfg = [
    '// GameCTL — disable the Valve end-of-match map picker in Casual.',
    '// kus\'s casual_settings.cfg is empty so the kill-switch in',
    '// settings/map_voting.cfg never fires; assert it here.',
    '// Cross-mode safety — unload sibling GameCtl plugins.',
    'css_plugins unload "GameCtl Surf HUD"',
    'css_plugins unload "GameCtl DM Rounds"',
    'css_plugins unload "GameCtl PropHunt"',
    '// Clear any prior self-pinning round_start hook (other modes set this).',
    'exec_after_round_start ""',
    '// Reset cvars DM/zombie leave drifted.',
    'mp_respawn_on_death_t 0',
    'mp_respawn_on_death_ct 0',
    'mp_ignore_round_win_conditions 0',
    'mp_round_restart_delay 3',
    'sv_allow_votes 0',
    'mp_endmatch_votenextmap 0',
    'mp_endmatch_votenextleveltime 0',
    'mp_endmatch_votenextmap_keepcurrent 0',
    'mp_match_end_changelevel 0',
    'exec_after_round_start "exec custom_casual.cfg"',
    'echo "custom_casual.cfg executed — map picker disabled"',
    '',
  ].join('\n')

  const writeSteps = [
    'set -e',
    `mkdir -p ${OV}/cfg/settings ${OV}/addons/counterstrikesharp/configs ${gmmDir} ${rtvDir} ${rtvCfgDir}`,
    `cat > ${OV}/cfg/on_boot.cfg <<'GAMECTL_EOF'\n${onBoot}GAMECTL_EOF`,
    `cat > ${OV}/cfg/gamectl_server.cfg <<'GAMECTL_EOF'\n${serverCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_retake.cfg <<'GAMECTL_EOF'\n${retakeCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_bhop.cfg <<'GAMECTL_EOF'\n${customBhopCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_gg.cfg <<'GAMECTL_EOF'\n${customGgCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_deathmatch.cfg <<'GAMECTL_EOF'\n${customDeathmatchCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_minigames.cfg <<'GAMECTL_EOF'\n${customMinigamesCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/unload_plugins.cfg <<'GAMECTL_EOF'\n${unloadPluginsCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_surf.cfg <<'GAMECTL_EOF'\n${customSurfCfg}GAMECTL_EOF`,
    // Overlay over the kus-baked surf_settings.cfg — re-asserts bot_kick
    // and pins bot_quota 0 so surf maps stay bot-free.
    `cat > ${OV}/cfg/surf_settings.cfg <<'GAMECTL_EOF'\n${surfSettingsCfg}GAMECTL_EOF`,
    // custom_bots.cfg — kus bots.cfg execs this as its override hook.
    // Used here to force bot_quota 0 on surf regardless of upstream
    // defaults (the ghost replay is a prop, not a driven bot anymore).
    `cat > ${OV}/cfg/custom_bots.cfg <<'GAMECTL_EOF'\n${customBotsCfg}GAMECTL_EOF`,
    // Overlay over SharpTimer's MapExecs surf_.cfg — same bot-disable
    // story: this file re-execs on every surf map load and would otherwise
    // re-seed bots via the SharpTimer-shipped quota=2 fill defaults.
    `mkdir -p ${OV}/cfg/SharpTimer/MapData/MapExecs`,
    `cat > ${OV}/cfg/SharpTimer/MapData/MapExecs/surf_.cfg <<'GAMECTL_EOF'\n${sharpTimerSurfMapExec}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_kz.cfg <<'GAMECTL_EOF'\n${customKzCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_hns.cfg <<'GAMECTL_EOF'\n${customHnsCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_aim.cfg <<'GAMECTL_EOF'\n${customAimCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_1v1.cfg <<'GAMECTL_EOF'\n${custom1v1Cfg}GAMECTL_EOF`,
    `mkdir -p ${k4ArenasDir}`,
    `cat > ${k4ArenasDir}/K4-Arenas.json <<'GAMECTL_K4ARENAS_EOF'\n${k4ArenasJson}\nGAMECTL_K4ARENAS_EOF`,
    `cat > ${OV}/cfg/prac_free.cfg <<'GAMECTL_EOF'\n${pracFreeCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_practice.cfg <<'GAMECTL_EOF'\n${customPracticeCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_casual.cfg <<'GAMECTL_EOF'\n${customCasualCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_minimaps.cfg <<'GAMECTL_EOF'\n${customMinimapsCfg}GAMECTL_EOF`,
    `cat > ${OV}/cfg/custom_comp.cfg <<'GAMECTL_EOF'\n${customCompCfg}GAMECTL_EOF`,
    ...Object.entries(botCfgs).map(([name, body]) =>
      `cat > ${OV}/cfg/settings/${name} <<'GAMECTL_EOF'\n${body}GAMECTL_EOF`),
    `cat > ${OV}/cfg/settings/quake_sounds.cfg <<'GAMECTL_EOF'\n${quakeSoundsCfg}GAMECTL_EOF`,
    `cat > ${gmmDir}/GameModeManager.json <<'GAMECTL_GMM_EOF'\n${gmmJson}\nGAMECTL_GMM_EOF`,
    // GameCtlRtv plugin: config (the mode/map catalog) + the compiled DLL.
    `cat > ${rtvCfgDir}/GameCtlRtv.json <<'GAMECTL_RTVJSON_EOF'\n${rtvJson}\nGAMECTL_RTVJSON_EOF`,
    `base64 -d > ${rtvDir}/GameCtlRtv.dll <<'GAMECTL_RTVDLL_EOF'\n${GAMECTL_RTV_DLL_BASE64}\nGAMECTL_RTVDLL_EOF`,
    // GameCtlSurfHUD — kept in plugins/disabled/ so it only loads when a
    // surf/bhop/kz mode's custom_<mode>.cfg explicitly loads it.
    `mkdir -p ${surfHudDir}`,
    `base64 -d > ${surfHudDir}/GameCtlSurfHUD.dll <<'GAMECTL_SURFHUDDLL_EOF'\n${GAMECTL_SURF_HUD_DLL_BASE64}\nGAMECTL_SURFHUDDLL_EOF`,
    `mkdir -p ${dmRoundsDir}`,
    `base64 -d > ${dmRoundsDir}/GameCtlDmRounds.dll <<'GAMECTL_DMROUNDSDLL_EOF'\n${GAMECTL_DM_ROUNDS_DLL_BASE64}\nGAMECTL_DMROUNDSDLL_EOF`,
    // Pre-download the RTV maps at boot — replaces the kus image's ~174-map
    // default subscription pile so map switches are instant.
    `cat > ${OV}/subscribed_file_ids.txt <<'GAMECTL_RTVIDS_EOF'\n${rtvIds.join('\n')}\nGAMECTL_RTVIDS_EOF`,
  ]
  // Workshop collection: keep its maps cached/updated for RTV nomination.
  const wsColl = String(f.workshopCollection || '').trim()
  if (wsColl) {
    writeSteps.push(`printf '%s\\n' '${wsColl.replace(/[^0-9]/g, '')}' > ${OV}/subscribed_collection_ids.txt`)
  }
  // admins.json: the ConfigMap (live-managed) wins; else the wizard seed.
  writeSteps.push(`if [ -s /admincm/admins.json ]; then`)
  writeSteps.push(`  cp /admincm/admins.json ${adminsDest}`)
  writeSteps.push(`  echo "[gamectl] admins.json from ConfigMap ${adminsCM}"`)
  if (adminsSeed) {
    writeSteps.push(`else`)
    writeSteps.push(`  cat > ${adminsDest} <<'GAMECTL_EOF'\n${adminsSeed}\nGAMECTL_EOF`)
    writeSteps.push(`  echo "[gamectl] admins.json seeded from wizard"`)
  }
  writeSteps.push(`fi`)
  // ConfigMap overrides — cs2-<server>-config holds operator edits made
  // through the manage screen (welcome message, hostname) that need to
  // survive a pod recreate. The CM is optional, so first-deploy servers
  // just fall through with the wizard defaults baked into the files above.
  // Edits are JSON-/cfg-substituted in place; head -1 keeps things to a
  // single line so a stray newline can't break GameCtlRtv.json's structure.
  writeSteps.push(`if [ -s /configcm/welcome_message ]; then`)
  writeSteps.push(`  WELCOME=$(head -1 /configcm/welcome_message | sed 's|\\\\|\\\\\\\\|g; s|"|\\\\"|g')`)
  writeSteps.push(`  sed -i 's|"welcome_message": "[^"]*"|"welcome_message": "'"$WELCOME"'"|' ${rtvCfgDir}/GameCtlRtv.json`)
  writeSteps.push(`  echo "[gamectl] welcome_message overridden from ConfigMap ${configCM}"`)
  writeSteps.push(`fi`)
  writeSteps.push(`if [ -s /configcm/hostname ]; then`)
  writeSteps.push(`  HN=$(head -1 /configcm/hostname | sed 's|\\\\|\\\\\\\\|g; s|"|\\\\"|g')`)
  writeSteps.push(`  sed -i 's|^hostname "[^"]*"|hostname "'"$HN"'"|' ${OV}/cfg/gamectl_server.cfg`)
  writeSteps.push(`  echo "[gamectl] hostname overridden from ConfigMap ${configCM}"`)
  writeSteps.push(`fi`)
  // workshop-downloader sidecar gate. The sidecar checks for the
  // .gamectl-wsdl-enabled sentinel on the PVC every pass and idles if it
  // is missing — so background mass-downloads are opt-in. We seed it
  // exactly ONCE (.gamectl-wsdl-initialized marks the first-boot decision)
  // based on the wizard's "Auto-preload workshop maps" toggle. After that
  // the operator owns the on/off state via the manage screen, so we never
  // overwrite their choice on a later pod restart.
  const preloadOn = f.preloadWorkshopMaps === true || f.preloadWorkshopMaps === 'true'
  writeSteps.push(`if [ ! -e /pvc/.gamectl-wsdl-initialized ]; then`)
  if (preloadOn) {
    writeSteps.push(`  touch /pvc/.gamectl-wsdl-enabled`)
    writeSteps.push(`  echo "[gamectl] workshop-downloader sidecar enabled (wizard opt-in)"`)
  } else {
    writeSteps.push(`  echo "[gamectl] workshop-downloader sidecar disabled by default (opt in from manage screen)"`)
  }
  writeSteps.push(`  touch /pvc/.gamectl-wsdl-initialized`)
  writeSteps.push(`fi`)
  writeSteps.push('echo "[gamectl] custom_files overlay written"')

  // The gen-config script has grown past Linux's exec ARG_MAX once the
  // embedded plugin DLLs added up (verified live: ~140 KB blows up as
  // `argument list too long`). Ship the script as its own ConfigMap and
  // mount it at /genconfig — that pushes the size cap to 1 MB and keeps
  // the init container command tiny.
  const genConfigCM = `cs2-${depName}-genconfig`
  const genConfigScript = writeSteps.join('\n')
  docs.push({
    apiVersion: 'v1', kind: 'ConfigMap',
    metadata: { name: genConfigCM, namespace: ns, labels },
    data: { 'gen-config.sh': genConfigScript },
  })

  const initContainers = [{
    name: 'gen-config',
    image: 'busybox:stable-musl',
    command: ['/bin/sh', '/genconfig/gen-config.sh'],
    volumeMounts: [
      { name: 'custom-files', mountPath: OV },
      // The CS2 admin panel's canonical list. optional: absent until the
      // first admin is added through the panel.
      { name: 'admins-cm', mountPath: '/admincm' },
      // Durable welcome/hostname overrides written by the manage screen.
      // optional: absent on a first deploy → wizard defaults apply.
      { name: 'config-cm', mountPath: '/configcm' },
      // The cs2 data PVC. We only touch sentinel files here
      // (.gamectl-wsdl-enabled / .gamectl-wsdl-initialized) to seed the
      // workshop-downloader sidecar's first-boot on/off state — the cs2
      // install itself is owned by the main container.
      { name: 'data', mountPath: '/pvc' },
      // The gen-config script itself (above 1 MB-cap ConfigMap).
      { name: 'genconfig', mountPath: '/genconfig', readOnly: true },
    ],
  }]

  // The kus image is configured through these env vars (see its
  // install_docker.sh). Hostname is NOT an env var — it's set by our
  // gamectl_server.cfg overlay above.
  const env = [
    { name: 'API_KEY', value: f.steamApiKey || '' },        // Steam Web API key (Workshop maps)
    { name: 'STEAM_ACCOUNT', value: f.gslt || '' },          // GSLT — public server listing
    { name: 'RCON_PASSWORD', value: f.rconPassword || 'ChangeMe12345' },
    { name: 'SERVER_PASSWORD', value: f.serverPassword || '' },
    { name: 'PORT', value: String(port) },
    { name: 'TICKRATE', value: String(f.tickrate || 128) },
    { name: 'MAXPLAYERS', value: String(f.maxPlayers || 24) },
    { name: 'LAN', value: '0' },
    { name: 'EXEC', value: 'on_boot.cfg' },
    { name: 'CUSTOM_FOLDER', value: 'custom_files' },
    // GameCTL-only discriminator — the live panel reads this to show the
    // current mode (the image ignores unknown env vars).
    { name: 'GAMECTL_CS2_MODE', value: f.gameMode || 'surf' },
    // SteamCMD validate gate, honored by our command override below. CS2
    // already updates on every start (pre-warm + plain app_update); "1" adds
    // a full `validate` integrity pass (slower — re-hashes ~65G), "0" skips it
    // (default, fast). The manage-screen Auto-update toggle flips this via
    // autoUpdateVars (instance_settings.go) on the next Restart.
    { name: 'GAMECTL_VALIDATE', value: f.updateOnStart ? '1' : '0' },
  ]

  // Deployment annotations: MetalLB pool (if any) + the preload-workshop
  // toggle the reconciler watches for.
  const depAnnotations = {
    ...(mlbAnno.annotations || {}),
    ...(f.preloadWorkshopMaps === true || f.preloadWorkshopMaps === 'true'
      ? { 'gamectl.io/preload-workshop-maps': 'true' }
      : {}),
  }
  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: {
      name: depName, namespace: ns, labels,
      ...(Object.keys(depAnnotations).length ? { annotations: depAnnotations } : {}),
    },
    spec: {
      replicas: 1,
      // Recreate: the install volume is single-writer — the old CS2 process
      // must fully release it before the new pod starts.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          // The kus image runs as the steam user (uid/gid 1000); fsGroup
          // lets that user own the mounted volumes. No privileged pod —
          // the image's internal sudo is self-contained.
          securityContext: { fsGroup: 1000 },
          initContainers,
          containers: [{
            name: depName,
            image: f.image || 'ghcr.io/kus/cs2-modded-server:latest',
            imagePullPolicy: 'Always',
            // Override the image entrypoint to inject -maxplayers 64
            // into the cs2 launch line. The kus image's install_docker.sh
            // launches cs2 WITHOUT -maxplayers, so the engine defaults
            // to a 16-slot cap — verified live by "The game is full" on
            // the 17th bot. sed-patch the script in place, then run
            // the original entrypoint. Idempotent: if -maxplayers is
            // already there, sed -n does nothing.
            //
            // Also wrap the cs2 launch with `stdbuf -oL -eL` so its
            // stdout/stderr are line-buffered. The CS2 dedicated server
            // uses C stdio which defaults to BLOCK buffering when
            // stdout is a pipe (i.e. when k8s collects logs), so logs
            // dump in ~64KB batches with minutes of dead air between —
            // making the GameCTL "Logs" panel look stale even though
            // the server is generating output. stdbuf line-buffers
            // every newline so kubectl logs (and the UI tail-poll) see
            // events as they happen.
            command: ['/bin/bash', '-c'],
            args: [
              // NOTE: these seds patch the upstream kus install_docker.sh in
              // place. If kus changes those lines the sed silently no-ops, so
              // each is followed by a re-check that logs a WARN to the pod logs
              // — turning otherwise-invisible upstream drift into a visible
              // signal (also why the image should be pinned, not :latest).
              "grep -q ' -maxplayers ' /home/cs2-modded-server/install_docker.sh || " +
              "sudo sed -i 's|./game/bin/linuxsteamrt64/cs2 |./game/bin/linuxsteamrt64/cs2 -maxplayers 64 |' /home/cs2-modded-server/install_docker.sh; " +
              "grep -q ' -maxplayers ' /home/cs2-modded-server/install_docker.sh || echo '[gamectl] WARN: -maxplayers patch did not apply — kus install_docker.sh changed?' >&2; " +
              "grep -q 'stdbuf -oL -eL' /home/cs2-modded-server/install_docker.sh || " +
              "sudo sed -i 's|sudo -u \\$user ./game/bin/linuxsteamrt64/cs2|sudo -u $user stdbuf -oL -eL ./game/bin/linuxsteamrt64/cs2|g' /home/cs2-modded-server/install_docker.sh; " +
              "grep -q 'stdbuf -oL -eL' /home/cs2-modded-server/install_docker.sh || echo '[gamectl] WARN: stdbuf log-buffering patch did not apply — kus install_docker.sh changed?' >&2; " +
              // SteamCMD reliability. The kus image stores steamcmd in an
              // ephemeral /steamcmd, so every pod re-downloads it; a fresh
              // steamcmd self-updates mid-run and leaves `app_update 730` stuck
              // at state 0x6 (the image then launches the STALE build, so the
              // server silently falls behind the live client). A leftover
              // partial-staging dir wedges it the same way. Before the kus
              // updater runs we therefore (1) clear stale staging and (2)
              // pre-warm steamcmd so its self-update is already done — after
              // which a plain app_update reliably pulls the latest build.
              "sudo rm -rf /home/steam/cs2/steamapps/downloading/* /home/steam/cs2/steamapps/temp/* 2>/dev/null || true; " +
              "[ -f /steamcmd/steamcmd.sh ] || { sudo mkdir -p /steamcmd && sudo wget -q -O /tmp/sc.tgz https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz && sudo tar -xzf /tmp/sc.tgz -C /steamcmd; }; " +
              "sudo chown -R steam:steam /steamcmd; " +
              "sudo -u steam /steamcmd/steamcmd.sh +login anonymous +quit || true; " +
              // GAMECTL_VALIDATE=1 (manage-screen Auto-update toggle) forces a
              // full `validate` integrity pass; default 0 = fast plain update.
              "if [ \"${GAMECTL_VALIDATE:-0}\" = \"1\" ]; then grep -q '+app_update 730 validate' /home/cs2-modded-server/install_docker.sh || " +
              "sudo sed -i 's|+app_update 730|+app_update 730 validate|' /home/cs2-modded-server/install_docker.sh; fi; " +
              "exec sudo -E bash /home/cs2-modded-server/install_docker.sh"
            ],
            env,
            ports: [
              { name: 'game-tcp', containerPort: port, protocol: 'TCP' },
              { name: 'game-udp', containerPort: port, protocol: 'UDP' },
              { name: 'tv-udp', containerPort: tvPort, protocol: 'UDP' },
            ],
            volumeMounts: [
              { name: 'data', mountPath: '/home/steam/cs2' },
              { name: 'custom-files', mountPath: OV },
            ],
            resources: {
              requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '2Gi' },
              limits: { cpu: f.cpuLimit || '4', memory: f.memLimit || '6Gi' },
            },
          }, {
            // workshop-downloader — sidecar that fills the gaps the kus
            // image's boot-time steamcmd misses. host_workshop_map does NOT
            // trigger downloads on this build (verified live), so any map in
            // subscribed_file_ids.txt that didn't finish at boot stays missing
            // until something downloads it. This loop downloads any missing
            // map in the background and re-checks every few minutes.
            //
            // Uses cm2network/steamcmd — a small purpose-built image with
            // steamcmd already installed at /home/steam/steamcmd/, runs as
            // the steam user (uid 1000), shares the PVC at /home/steam/cs2.
            // (The kus image *also* has steamcmd but only after its entry-
            // point downloads it — bypassing the entrypoint leaves no copy.)
            name: 'workshop-downloader',
            image: 'cm2network/steamcmd:latest',
            imagePullPolicy: 'IfNotPresent',
            command: ['/bin/sh', '-c'],
            args: [[
              'set -u',
              'SUB=/home/steam/cs2/game/csgo/subscribed_file_ids.txt',
              'WS=/home/steam/cs2/game/bin/linuxsteamrt64/steamapps/workshop/content/730',
              'INSTALL=/home/steam/cs2/game/bin/linuxsteamrt64',
              'STEAMCMD=/home/steam/steamcmd/steamcmd.sh',
              '# Opt-in gate. The "Pre-download all workshop maps" button on the',
              '# manage screen touches/removes this file; the sidecar idles until',
              '# the operator says go, so a fresh deploy never starts a multi-GB',
              '# background fetch without consent.',
              'GATE=/home/steam/cs2/.gamectl-wsdl-enabled',
              '# CS2WorkshopGetStatus reads this to show "X is downloading now" in',
              '# the UI even when the sidecar (not a manual cycle) is the one fetching.',
              'CUR=/home/steam/cs2/.gamectl-wsdl-current',
              'rm -f "$CUR"',
              'trap \'rm -f "$CUR"\' EXIT',
              '# Wait for the gen-config init container + the main container to lay',
              '# down the subscribed_file_ids.txt overlay onto game/csgo/.',
              'while [ ! -f "$SUB" ]; do echo "[wsdl] waiting for $SUB"; sleep 30; done',
              'echo "[wsdl] starting — $(wc -l < "$SUB") subscribed maps tracked"',
              '# Give the main container\'s own boot downloads a head start.',
              'sleep 120',
              'while true; do',
              '  if [ ! -e "$GATE" ]; then',
              '    echo "[wsdl] gate $GATE absent — sidecar idle, checking again in 30s"',
              '    sleep 30',
              '    continue',
              '  fi',
              '  total=0; cached=0; missing=0; ok=0; fail=0',
              '  while IFS= read -r id; do',
              '    [ -z "$id" ] && continue',
              '    total=$((total+1))',
              '    if [ -f "$WS/$id/$id.vpk" ] || [ -f "$WS/$id/${id}_dir.vpk" ]; then cached=$((cached+1)); continue; fi',
              '    missing=$((missing+1))',
              '    echo "[wsdl] missing $id — downloading"',
              '    echo "$id" > "$CUR"',
              '    "$STEAMCMD" +force_install_dir "$INSTALL" +login anonymous +workshop_download_item 730 "$id" validate +quit 2>&1 | tail -3',
              '    rm -f "$CUR"',
              '    if [ -f "$WS/$id/$id.vpk" ] || [ -f "$WS/$id/${id}_dir.vpk" ]; then ok=$((ok+1)); echo "[wsdl] OK $id"; else fail=$((fail+1)); echo "[wsdl] FAIL $id"; fi',
              '  done < "$SUB"',
              '  echo "[wsdl] pass: $cached/$total cached, $missing missing, $ok downloaded, $fail failed — sleeping 10m"',
              '  sleep 600',
              'done',
            ].join('\n')],
            volumeMounts: [
              { name: 'data', mountPath: '/home/steam/cs2' },
            ],
            resources: {
              requests: { cpu: '100m', memory: '256Mi' },
              limits:   { cpu: '500m', memory: '768Mi' },
            },
          }],
          volumes: [
            { name: 'data', persistentVolumeClaim: { claimName: pvcName } },
            { name: 'custom-files', emptyDir: {} },
            // CS2 admin panel's canonical admin list. optional: it doesn't
            // exist until the first admin is added via the panel.
            { name: 'admins-cm', configMap: { name: adminsCM, optional: true } },
            // Welcome message + hostname overrides edited via the manage
            // screen. optional: absent on first deploy.
            { name: 'config-cm', configMap: { name: configCM, optional: true } },
            // The gen-config init script (shipped as its own CM since the
            // inline -c form blows ARG_MAX once the plugin DLLs are big).
            { name: 'genconfig', configMap: { name: genConfigCM } },
          ],
        },
      },
    },
  })

  docs.push({
    apiVersion: 'v1', kind: 'Service',
    metadata: { name: depName, namespace: ns, labels, ...mlbAnno },
    spec: {
      type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined,
      externalTrafficPolicy: 'Local', selector: labels,
      ports: [
        { name: 'game-tcp', port, targetPort: port, protocol: 'TCP' },
        { name: 'game-udp', port, targetPort: port, protocol: 'UDP' },
        { name: 'tv-udp', port: tvPort, targetPort: tvPort, protocol: 'UDP' },
      ],
    },
  })

  // lineWidth: -1 disables YAML's automatic line-wrapping. Without this,
  // long lines in the embedded shell heredoc (cfg comments, long cvar
  // commands) get folded mid-line, which inside a CS2 cfg means the
  // command before the fold runs but the rest is lost — a long
  // `// comment` becomes two truncated comments and a stray identifier.
  return docs.map((d) => yaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n')
}
