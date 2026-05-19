import yaml from 'js-yaml'

export const defaultCs2Form = {
  namespace: 'gamectl-cs2',
  // Storage mode and paths
  storageMode: 'local', // 'local' (hostPath) | 'remote' (NFS)
  // Local hostPath (back-compat: pvPath will be used if localDataPath not provided)
  localDataPath: '/mnt/1TBSSD/cs2',
  // Remote (NFS)
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/cs2',
  storage: '100Gi', // ~65G install + game data + custom maps headroom
  image: 'joedwards32/cs2:latest',
  serverName: 'cs2', // deployment/service name
  hostname: 'CS2 Server',
  srcdsToken: '',
  svPassword: '',
  rconPassword: 'ChangeMe12345',
  port: 27015,
  tickrate: 128,
  mapChoice: 'de_inferno', // dropdown selection; '__custom__' uses `map`
  map: 'de_inferno', // effective/custom map name (workshop or off-list)
  gameModeChoice: 'competitive', // see MODES in buildCs2Yaml
  botDifficulty: 1,              // 0 easy · 1 normal · 2 hard · 3 expert
  gametype: '0',                 // only used when gameModeChoice === 'custom'
  gamemode: '1',
  maxplayers: '', // blank ⇒ auto-sized per game mode (override with a number)
  tvEnable: 0,
  tvPort: 27020,
  // Default OFF: the ~65G install persists on NFS, so a fresh deploy
  // should reuse it and start fast. The image's validate path is
  // destructive on any SteamCMD hiccup (it rm -rf's steamapps on retry →
  // full re-download from base), so don't run it unattended on every
  // wizard deploy. Enable updates deliberately from the instance's
  // Details screen (non-disruptive toggle + Restart) when a Valve patch
  // actually drops. 1 = skip validate/update.
  skipUpdate: 1,
  lbIP: '10.0.0.220',
  additionalArgs: '',
}

export function buildCs2Yaml(f = defaultCs2Form) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const depName = f.serverName || 'cs2'
  const labels = { app: depName, game: 'cs2', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'local') === 'local'

  const docs = []

  // Namespace
  docs.push({
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { name: ns, labels },
  })

  // PV (hostPath or NFS)
  const pvName = `${depName}-pv`
  docs.push({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: pvName, labels },
    spec: isLocal
      ? {
          capacity: { storage: f.storage || '100Gi' },
          accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'manual',
          hostPath: { path: (f.localDataPath || f.pvPath || '/mnt/1TBSSD/cs2'), type: 'DirectoryOrCreate' },
        }
      : {
          capacity: { storage: f.storage || '100Gi' },
          accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'nfs-static',
          mountOptions: ['nfsvers=4.2'],
          nfs: {
            server: f.nfsServer || '10.0.0.100',
            path: f.dataPvPath || '/mnt/1TBSSD/cs2',
            readOnly: false,
          },
        },
  })

  // PVC
  docs.push({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: `${depName}-pvc`, namespace: ns, labels },
    spec: {
      accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'],
      storageClassName: isLocal ? 'manual' : ('nfs-static'),
      resources: { requests: { storage: f.storage || '100Gi' } },
      volumeName: pvName,
    },
  })

  // Resolve the start map: a dropdown pick, or the free-text `map` when the
  // user chose "Custom / workshop map…" (mapChoice === '__custom__').
  const startMap = (f.mapChoice && f.mapChoice !== '__custom__')
    ? f.mapChoice
    : (f.map || 'de_inferno')

  // Resolve game mode → CS2's (game_type, game_mode) pair + a sensible bot
  // fill. "5v5" modes fill to 10 with autobalance; FFA/ladder modes fill to
  // the player cap. Custom defers to the raw gametype/gamemode fields.
  // `slots` = total connection slots (active players for the mode +
  // spectator/overflow headroom). CS2's game mode — not maxplayers —
  // decides how many actually play; extra slots are spectators. The
  // wizard's Max players is an optional OVERRIDE; blank ⇒ auto per mode.
  const MODES = {
    competitive: { gt: 0, gm: 1, bots: 10,  slots: 12 }, // 5v5 + 2 spec
    casual:      { gt: 0, gm: 0, bots: 10,  slots: 20 }, // up to 10v10
    wingman:     { gt: 0, gm: 2, bots: 4,   slots: 6  }, // 2v2 + spec
    demolition:  { gt: 1, gm: 1, bots: 10,  slots: 12 }, // 5v5 + spec
    deathmatch:  { gt: 1, gm: 2, bots: 16,  slots: 16 }, // FFA
    armsrace:    { gt: 1, gm: 0, bots: 16,  slots: 16 }, // GunGame
    custom:      { gt: Number(f.gametype ?? 0), gm: Number(f.gamemode ?? 1), bots: 10, slots: 16 },
  }
  const mode = MODES[f.gameModeChoice] || MODES.competitive
  // Manual override only when the operator set a positive value.
  const ovr = Number(f.maxplayers)
  const slots = Number.isFinite(ovr) && ovr > 0 ? ovr : mode.slots
  // FFA modes fill bots up to the actual slot count.
  const botFill = (f.gameModeChoice === 'deathmatch' || f.gameModeChoice === 'armsrace')
    ? Math.min(slots, 16) : mode.bots
  const botDifficulty = String(f.botDifficulty ?? 2) // 0 easy → 3 expert

  // CS2 REGENERATES game/csgo/cfg/gamemode_<mode>.cfg from the depot on
  // every boot, so the image's pre-launch `sed` of bot_quota into it does
  // not survive — bots fall back to Valve's gamemode default (bot_quota 1,
  // mode "competitive"). The engine, however, execs the operator-owned
  // gamemode_<mode>_server.cfg AFTER its own cfg and never regenerates it.
  // An init container writes that file onto the data PVC every start so
  // the bot config sticks across reboots AND in-game map changes.
  const GM_CFG = {
    competitive: 'competitive', casual: 'casual', wingman: 'competitive2v2',
    demolition: 'demolition', deathmatch: 'deathmatch', armsrace: 'armsrace',
  }
  const gmBase = GM_CFG[f.gameModeChoice] ||
    (mode.gt === 1 ? (mode.gm === 0 ? 'armsrace' : mode.gm === 2 ? 'deathmatch' : 'demolition')
                   : (mode.gm === 0 ? 'casual' : mode.gm === 2 ? 'competitive2v2' : 'competitive'))
  // Mode-specific round config. Pinning these defends against the Casual
  // ↔ Competitive live-panel switch leaving the server at mp_maxrounds=0,
  // which traps CS2 in a "Game Over" latch where `bot_add` returns
  // "cannot add bots after game is over" and players spawn frozen — only
  // a fresh `changelevel` clears it.
  const roundCfg = (() => {
    if (f.gameModeChoice === 'wingman') return ['mp_maxrounds 16', 'mp_roundtime 1.92', 'mp_freezetime 6', 'mp_halftime 1']
    if (f.gameModeChoice === 'casual') return ['mp_maxrounds 0', 'mp_timelimit 10', 'mp_freezetime 6']
    if (f.gameModeChoice === 'deathmatch') return ['mp_maxrounds 0', 'mp_timelimit 10', 'mp_freezetime 0']
    if (f.gameModeChoice === 'armsrace') return ['mp_maxrounds 0', 'mp_timelimit 10', 'mp_freezetime 0']
    if (f.gameModeChoice === 'demolition') return ['mp_maxrounds 20', 'mp_roundtime 2', 'mp_freezetime 6']
    // competitive (default) / custom
    return ['mp_maxrounds 24', 'mp_roundtime 1.92', 'mp_freezetime 6', 'mp_halftime 1', 'mp_match_can_clinch 1']
  })()
  const overrideCfg = [
    '// GameCTL operator override — execd by CS2 after the (regenerated)',
    '// base gamemode cfg, so these settings actually stick.',
    `bot_quota ${botFill}`,
    'bot_quota_mode fill',
    `bot_difficulty ${botDifficulty}`,
    'bot_join_after_player 0',
    // mp_team_intro_time 0 disables the match-start camera cinematic that
    // FREEZES every player (and bots) in place — on a bot/community server
    // it re-triggers and feels like "nobody can move". The online-warmup
    // hold is competitive matchmaking flow that never resolves without an
    // MM backend, so disable it and keep warmup short + unpaused.
    'mp_team_intro_time 0',
    'mp_warmup_online_enabled 0',
    'mp_warmuptime 10',
    'mp_warmup_pausetimer 0',
    ...roundCfg,
    'mp_autoteambalance 1',
    'mp_limitteams 2',
    'sv_hibernate_when_empty 0',
    '',
  ].join('\n')
  const cfgDir = '/home/steam/cs2-dedicated/game/csgo/cfg'
  const initContainers = [{
    name: 'cfg-override',
    image: f.image || 'cs2:latest',
    command: ['/bin/sh', '-c',
      `mkdir -p ${cfgDir} && cat > ${cfgDir}/gamemode_${gmBase}_server.cfg <<'GAMECTL_EOF'\n${overrideCfg}GAMECTL_EOF\necho "wrote gamemode_${gmBase}_server.cfg"`],
    volumeMounts: [{ name: 'data', mountPath: '/home/steam/cs2-dedicated' }],
  }]

  // The joedwards32/cs2 image is configured ENTIRELY through CS2_*/TV_*
  // env vars (see its entry.sh) — NOT the SRCDS_*/HOSTNAME/PORT/GAMETYPE
  // scheme an earlier generator assumed. With the wrong names the image
  // silently used its own defaults: rcon stayed "changeme" (so GameCTL's
  // RCON console + CS2 Live "Apply" panel failed auth), and bot_quota
  // fell through to Valve's gamemode_competitive.cfg (bot_quota 1, mode
  // "competitive") → "only 1 bot, frozen". The image applies CS2_BOT_* by
  // sed-rewriting EVERY cfg/* (incl. the gamemode cfg) after install, so
  // these stick where command-line +cvars would just get overridden.
  const env = [
    { name: 'CS2_SERVERNAME', value: f.hostname || 'CS2 Server' },
    { name: 'CS2_PW', value: f.svPassword || '' },
    { name: 'CS2_RCONPW', value: f.rconPassword || 'ChangeMe12345' },
    { name: 'CS2_PORT', value: String(f.port || 27015) },
    { name: 'CS2_MAXPLAYERS', value: String(slots) },
    { name: 'CS2_STARTMAP', value: startMap },
    { name: 'CS2_MAPGROUP', value: 'mg_active' },
    { name: 'CS2_GAMETYPE', value: String(mode.gt) },
    { name: 'CS2_GAMEMODE', value: String(mode.gm) },
    // 5v5 competitive with bots players replace on join: quota at the
    // mode's bot count + "fill" — bots top the server up to the quota and
    // yield a slot 1:1 as humans connect. Image seds this into every cfg.
    { name: 'CS2_BOT_QUOTA', value: String(botFill) },
    { name: 'CS2_BOT_QUOTA_MODE', value: 'fill' },
    { name: 'CS2_BOT_DIFFICULTY', value: botDifficulty },
    { name: 'TV_ENABLE', value: String(f.tvEnable || 0) },
    { name: 'TV_PORT', value: String(f.tvPort || 27020) },
    { name: 'SRCDS_TOKEN', value: f.srcdsToken || '' },
    // skipUpdate truthy ⇒ no SteamCMD validate on boot (fast start);
    // default validates each start (slower, but self-heals the install).
    { name: 'STEAMAPPVALIDATE', value: String(f.skipUpdate ? 0 : 1) },
  ]
  // CS2_ADDITIONAL_ARGS is appended verbatim to the server command line.
  // Keep sv_rcon_banpenalty 0: a tunnel/proxy forwarder opens bare TCP to
  // the game port, which CS2 miscounts as RCON brute-force and would ban
  // (locking out the gateway). RCON auth is still required regardless.
  const extra = (f.additionalArgs || '').trim()
  env.push({ name: 'CS2_ADDITIONAL_ARGS', value: extra ? `+sv_rcon_banpenalty 0 ${extra}` : '+sv_rcon_banpenalty 0' })

  const dep = {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
  metadata: { name: depName, namespace: ns, labels, ...mlbAnno },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          securityContext: { fsGroup: 1000, runAsUser: 1000, runAsGroup: 1000 },
          initContainers,
          containers: [
            {
              name: depName,
              image: f.image || 'cs2:latest',
              imagePullPolicy: 'Always',
              env,
              ports: [
                { name: 'game-tcp', containerPort: Number(f.port || 27015), protocol: 'TCP' },
                { name: 'game-udp', containerPort: Number(f.port || 27015), protocol: 'UDP' },
                { name: 'gotv-udp', containerPort: Number(f.tvPort || 27020), protocol: 'UDP' },
              ],
              // joedwards32/cs2 installs & runs CS2 from STEAMAPPDIR=
              // /home/steam/cs2-dedicated. The data volume MUST mount there
              // or the ~65G install lands on ephemeral container fs and
              // SteamCMD re-downloads the entire game every pod start
              // (auto-update is then just a fast validate, as intended).
              volumeMounts: [ { name: 'data', mountPath: '/home/steam/cs2-dedicated' } ],
              // 4Gi limit (req stays 1Gi so scheduling is unchanged): a SteamCMD
      // `validate` of the ~65G install is memory-heavy and gets OOM-killed
      // under a 2Gi cap — the kill is exactly what trips the image's
      // destructive retry/manifest-wipe. Headroom keeps validate safe.
      resources: { requests: { cpu: f.cpuRequest || '500m', memory: f.memRequest || '1Gi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '4Gi' } },
            },
          ],
          volumes: [ { name: 'data', persistentVolumeClaim: { claimName: `${depName}-pvc` } } ],
        },
      },
    },
  }
  docs.push(dep)

  // Service
  docs.push({
    apiVersion: 'v1',
    kind: 'Service',
  metadata: { name: depName, namespace: ns, labels, ...mlbAnno },
    spec: {
      type: 'LoadBalancer',
      loadBalancerIP: f.lbIP || undefined,
      externalTrafficPolicy: 'Local',
      selector: labels,
      ports: [
        { name: 'game-tcp', port: Number(f.port || 27015), targetPort: Number(f.port || 27015), protocol: 'TCP' },
        { name: 'game-udp', port: Number(f.port || 27015), targetPort: Number(f.port || 27015), protocol: 'UDP' },
        { name: 'gotv-udp', port: Number(f.tvPort || 27020), targetPort: Number(f.tvPort || 27020), protocol: 'UDP' },
      ],
    },
  })

  // Compose multi-doc YAML
  return docs.map((d) => yaml.dump(d, { noRefs: true })).join('---\n')
}
