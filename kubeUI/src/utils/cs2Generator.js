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
  // Steam Workshop maps (surf maps live on the Workshop). When either is
  // set the image boots that workshop content and CS2_STARTMAP is ignored.
  // workshopMap = a single map's numeric Workshop ID; workshopCollection =
  // a whole collection's ID (maps then cycled via RCON ds_workshop_*).
  workshopMap: '',
  workshopCollection: '',
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
  // Hibernate when empty: 1 = sleep w/ no humans (CPU≈0), 0 = keep ticking.
  hibernateWhenEmpty: 1,
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
    // surf: CS2 has no native surf mode — it runs as game_type 3 /
    // game_mode 0 (Custom), which loads the near-empty gamemode_custom
    // cfg the operator fully owns, so surf cvars + the SharpTimer plugin
    // don't fight Valve round logic. No bots; big slot count.
    surf:        { gt: 3, gm: 0, bots: 0,   slots: 32 },
    custom:      { gt: Number(f.gametype ?? 0), gm: Number(f.gamemode ?? 1), bots: 10, slots: 16 },
  }
  const mode = MODES[f.gameModeChoice] || MODES.competitive
  // Manual override only when the operator set a positive value.
  const ovr = Number(f.maxplayers)
  const slots = Number.isFinite(ovr) && ovr > 0 ? ovr : mode.slots
  const isSurf = f.gameModeChoice === 'surf'
  // FFA modes fill bots up to the actual slot count; surf runs bot-free.
  const botFill = isSurf ? 0
    : (f.gameModeChoice === 'deathmatch' || f.gameModeChoice === 'armsrace')
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
    surf: 'custom', // game_type 3/game_mode 0 → gamemode_custom_server.cfg
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
    // surf: no round structure at all — one endless "round" so a surf run
    // is never cut short by a round/time limit or a freeze.
    if (isSurf) return [
      'mp_maxrounds 0', 'mp_timelimit 0', 'mp_roundtime 60',
      'mp_freezetime 0', 'mp_round_restart_delay 0', 'mp_warmuptime 0',
      'mp_ignore_round_win_conditions 1',
    ]
    // competitive (default) / custom
    return ['mp_maxrounds 24', 'mp_roundtime 1.92', 'mp_freezetime 6', 'mp_halftime 1', 'mp_match_can_clinch 1']
  })()
  // Surf movement cvars. With the SharpTimer + MovementUnlocker plugin
  // stack (installed by the surf-stack init container) these apply with
  // sv_cheats 0 — MovementUnlocker un-gates the cheat-flagged sv_* movement
  // cvars. sv_airaccelerate is the load-bearing one: 800 = forgiving "fun"
  // surf; drop toward 150 for tight skill surf.
  const surfCfg = isSurf ? [
    '',
    '// --- GameCTL surf profile ---',
    'sv_airaccelerate 800',
    'sv_air_max_wishspeed 37.5',
    'sv_maxvelocity 7200',
    'sv_accelerate 10',
    'sv_enablebunnyhopping 1',
    'sv_autobunnyhopping 1',
    'sv_staminamax 0',
    'sv_staminajumpcost 0',
    'sv_staminalandcost 0',
    'sv_falldamage_scale 0',
    'mp_solid_teammates 0',
    'mp_friendlyfire 0',
  ] : []
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
    ...surfCfg,
    'mp_autoteambalance 1',
    'mp_limitteams 2',
    // Hibernate when no humans are connected. With 1 (default) the server
    // tick pauses, CPU drops to ~0, bots freeze. First human to connect
    // wakes the server (~1s) and bot_quota_mode fill repopulates
    // immediately. Set to 0 if you want bots to keep playing solo for
    // spectating / testing without a human joining.
    `sv_hibernate_when_empty ${Number(f.hibernateWhenEmpty ?? 1) ? 1 : 0}`,
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

  // Surf needs a plugin stack on the data volume: Metamod:Source →
  // CounterStrikeSharp → SharpTimer (timer/zones/records), plus the
  // MovementUnlocker + RampBugFix Metamod plugins. This init container
  // installs them onto the PVC and patches gameinfo.gi for the Metamod
  // search path. It is idempotent (a version-marker file gates the
  // download) and re-patches gameinfo.gi every boot because a CS2 update
  // rewrites that file. CounterStrikeSharp is PINNED — SharpTimer pins a
  // minimum CSS API build, so "always latest" risks an API-mismatch.
  //
  // First-deploy note: on a brand-new data volume CS2 itself isn't
  // installed yet when init containers run, so gameinfo.gi doesn't exist
  // — the plugin FILES are still staged, and the gameinfo.gi patch lands
  // on the next pod start (after the ~65G install completes). Deploying
  // surf onto an existing CS2 data path patches on the first boot.
  if (isSurf) {
    const STACK_VERSION = '1' // bump to force a re-download on next boot
    const CSS_TAG = 'v1.0.368' // pinned: SharpTimer needs CSS API >= v1.0.281
    const surfScript = [
      'set -e',
      'apk add --no-cache curl tar unzip jq >/dev/null 2>&1',
      'ROOT=/home/steam/cs2-dedicated',
      'CSGO="$ROOT/game/csgo"',
      'MARKER="$ROOT/.gamectl-surf-stack"',
      `WANT='${STACK_VERSION}'`,
      `CSS_TAG='${CSS_TAG}'`,
      'mkdir -p "$CSGO"',
      'gh_asset() {  # $1=repo  $2=name-regex  → prints browser_download_url',
      `  curl -fsSL "https://api.github.com/repos/$1/releases/latest" \\`,
      `    | jq -r ".assets[] | select(.name|test(\\"$2\\")) | .browser_download_url" | head -1`,
      '}',
      'if [ "$(cat "$MARKER" 2>/dev/null)" = "$WANT" ]; then',
      '  echo "[surf] plugin stack v$WANT already installed"',
      'else',
      '  TMP=$(mktemp -d); cd "$TMP"',
      '  echo "[surf] Metamod:Source"',
      '  MM=$(curl -fsSL https://mms.alliedmods.net/mmsdrop/2.0/mmsource-latest-linux)',
      '  curl -fsSL "https://mms.alliedmods.net/mmsdrop/2.0/$MM" -o mm.tar.gz',
      '  tar -xzf mm.tar.gz -C "$CSGO"',
      '  echo "[surf] CounterStrikeSharp $CSS_TAG"',
      '  curl -fsSL "https://github.com/roflmuffin/CounterStrikeSharp/releases/download/$CSS_TAG/counterstrikesharp-with-runtime-linux-${CSS_TAG#v}.zip" -o css.zip',
      '  unzip -oq css.zip -d "$CSGO"',
      '  echo "[surf] SharpTimer"',
      '  curl -fsSL "$(gh_asset Letaryat/poor-sharptimer \'SharpTimer.*\\\\.zip\')" -o st.zip',
      '  unzip -oq st.zip "addons/*" -d "$CSGO"',
      '  if [ ! -d "$CSGO/cfg/SharpTimer" ]; then unzip -oq st.zip "cfg/*" -d "$CSGO"; fi',
      '  echo "[surf] MovementUnlocker"',
      '  curl -fsSL "$(gh_asset Source2ZE/MovementUnlocker \'linux\\\\.tar\\\\.gz$\')" -o mu.tar.gz',
      '  tar -xzf mu.tar.gz -C "$CSGO"',
      '  echo "[surf] RampBugFix"',
      '  curl -fsSL "$(gh_asset Interesting-exe/CS2Fixes-RampbugFix \'linux\\\\.tar\\\\.gz$\')" -o rb.tar.gz',
      '  tar -xzf rb.tar.gz -C "$CSGO"',
      '  cd /; rm -rf "$TMP"',
      '  echo "$WANT" > "$MARKER"',
      '  echo "[surf] plugin stack installed"',
      'fi',
      '# Re-apply the Metamod search path to gameinfo.gi (CS2 updates',
      '# overwrite it). Skip cleanly if CS2 is not installed yet.',
      'GI="$CSGO/gameinfo.gi"',
      'if [ -f "$GI" ]; then',
      '  if grep -q "csgo/addons/metamod" "$GI"; then',
      '    echo "[surf] gameinfo.gi already patched"',
      '  else',
      `    awk '{print} /Game_LowViolence[ \\t]+csgo_lv/ && !d {print "\\t\\t\\tGame\\tcsgo/addons/metamod"; d=1}' "$GI" > "$GI.tmp" && mv "$GI.tmp" "$GI"`,
      '    echo "[surf] patched gameinfo.gi"',
      '  fi',
      'else',
      '  echo "[surf] CS2 not installed yet — gameinfo.gi will be patched on the next restart"',
      'fi',
      'echo "[surf] done"',
    ].join('\n')
    initContainers.push({
      name: 'surf-plugins',
      image: 'alpine:3.20',
      command: ['/bin/sh', '-c', surfScript],
      volumeMounts: [{ name: 'data', mountPath: '/home/steam/cs2-dedicated' }],
      resources: { requests: { cpu: '100m', memory: '128Mi' }, limits: { cpu: '1', memory: '512Mi' } },
    })
  }

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
    // GameCTL-only discriminator (the image ignores unknown CS2_* vars).
    // surf shares no native game mode, so the backend can't tell surf
    // from a plain Custom server by (gametype,gamemode) alone — this
    // names the profile so the live panel shows the right current mode.
    { name: 'CS2_GAMEMODE_PROFILE', value: f.gameModeChoice || 'competitive' },
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

  // Steam Workshop maps. The image boots a workshop map/collection when
  // these are set (and then ignores CS2_STARTMAP). A single map ID wins
  // over a collection if both are somehow provided. Surf maps are all
  // Workshop content, so a surf deploy almost always sets one of these.
  const wsMap = String(f.workshopMap || '').trim()
  const wsColl = String(f.workshopCollection || '').trim()
  if (wsMap) {
    env.push({ name: 'CS2_HOST_WORKSHOP_MAP', value: wsMap })
  } else if (wsColl) {
    env.push({ name: 'CS2_HOST_WORKSHOP_COLLECTION', value: wsColl })
  }

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
