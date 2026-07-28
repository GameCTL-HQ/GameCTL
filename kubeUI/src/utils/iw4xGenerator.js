import yaml from 'js-yaml'

// IW4X — Call of Duty: Modern Warfare 2 (2009) custom multiplayer platform.
// Windows-only, so the server runs under Wine in GameCTL's own iw4x-kube image
// (source: images/iw4x-kube/). That image downloads NOTHING: it validates the
// files, prepares the Wine prefix, and launches. It replaced ich777/iw4x-server,
// which is abandoned upstream and whose IW4x and DLC download URLs are both
// dead domains that ended in an infinite sleep.
//
// ⚠️ Operator-supplied game files. Copy your own legally owned MW2 install —
// with IW4x installed into it client-side, so iw4x.exe and iw4x.dll are
// present — onto the chosen Storage Location before first boot. Closest
// precedent in this codebase is Quake 3's operator-supplied paks. GameCTL can
// build and deploy the entry, but the boot itself can only be verified by
// whoever owns the game.
//
// Config: GameCTL writes players/server.cfg (that exact path — IW4x reads it
// from there) on every boot and launches with +exec server.cfg. Anything the
// wizard doesn't cover goes in "Extra server.cfg lines" verbatim, so an
// unexpected dvar never requires a code change.

// g_gametype values (base MW2 modes).
export const IW4X_GAMETYPES = [
  { label: 'Team Deathmatch (war)', value: 'war' },
  { label: 'Free-for-All (dm)', value: 'dm' },
  { label: 'Domination (dom)', value: 'dom' },
  { label: 'Search & Destroy (sd)', value: 'sd' },
  { label: 'Sabotage (sab)', value: 'sab' },
  { label: 'Headquarters (koth)', value: 'koth' },
  { label: 'Capture the Flag (ctf)', value: 'ctf' },
  { label: 'Demolition (dd)', value: 'dd' },
]

// Base MW2 multiplayer maps (no DLC — Stimulus/Resurgence maps only exist if
// the operator's copy has them, and can be typed into the rotation field).
export const IW4X_MAPS = [
  { label: 'Afghan', value: 'mp_afghan' },
  { label: 'Bailout', value: 'mp_complex' },
  { label: 'Derail', value: 'mp_derail' },
  { label: 'Estate', value: 'mp_estate' },
  { label: 'Favela', value: 'mp_favela' },
  { label: 'Highrise', value: 'mp_highrise' },
  { label: 'Invasion', value: 'mp_invasion' },
  { label: 'Karachi', value: 'mp_checkpoint' },
  { label: 'Quarry', value: 'mp_quarry' },
  { label: 'Rundown', value: 'mp_rundown' },
  { label: 'Rust', value: 'mp_rust' },
  { label: 'Scrapyard', value: 'mp_boneyard' },
  { label: 'Skidrow', value: 'mp_nightshift' },
  { label: 'Sub Base', value: 'mp_subbase' },
  { label: 'Terminal', value: 'mp_terminal' },
  { label: 'Underpass', value: 'mp_underpass' },
  { label: 'Wasteland', value: 'mp_brecourt' },
]

const SERVER_DIR = '/iw4x'

export const defaultIw4xForm = {
  namespace: 'gamectl-iw4x',
  serverName: 'iw4x',
  image: 'ghcr.io/gamectl-hq/iw4x-kube:latest',

  // Storage: operator-declared location (resolveStorage → storageMode +
  // nfsServer/dataPvPath or localDataPath). MW2 + IW4X is ~14G.
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/iw4x',
  localDataPath: '/mnt/1TBSSD/GameCTL/iw4x',
  dataStorage: '25Gi',

  // Server
  hostname: 'GameCTL IW4X',
  gametype: 'war',
  startMap: 'mp_afghan',
  maxClients: 18,
  rconPassword: 'ChangeMe12345',
  serverPassword: '',
  motd: 'Powered by GameCTL',

  // Bots. Two genuinely different systems, hence botSystem:
  //   'botwarfare' — the Bot Warfare GSC mod (install to mods/mp_bots). Bots
  //                  navigate (it ships 479 MW2 waypoint files) and auto-fill
  //                  from bots_manage_* dvars. Verified live: bots_main=1 and
  //                  scores climb.
  //   'builtin'    — IW4x's own bots. No waypoints, so they spawn and stand
  //                  still, and there is no fill dvar at all: the image issues
  //                  `spawnBot <n>` over RCON (IW4X_BOTS).
  // The mod folder is mods/mp_bots, NOT mods/bots — the latter is a widespread
  // misreading that produces an empty fs_game and no error message anywhere.
  botSystem: 'botwarfare',
  fsGame: 'mods/mp_bots',
  botCount: 8,
  botSkill: 4,
  teamBalance: 1,
  // Names the bots join under, one per line or comma-separated. Blank leaves
  // whatever is already on the volume (the image seeds its own list on first
  // boot). IW4x reads these from userraw/bots.txt at STARTUP, so changing them
  // needs a restart, not just a redeploy of config.
  botNames: '',
  // GUIDs allowed to open Bot Warfare's in-game menu (Action Slot 2 / '5').
  // The mod checks this on CONNECT, so a player already in the server has to
  // rejoin after being added.
  botMenuGuids: '',

  extraCfg: '',
  manageConfig: 1,
  // Which Windows binary to run. The IW4x launcher installs iw4x.exe; only
  // change this if your install names it something else.
  iw4xBinary: 'iw4x.exe',

  // Networking — game + RCON share 28960.
  gamePort: 28960,
  lbIP: '',
}

// server.cfg, generated from the wizard fields. IW4X reads plain idTech-style
// `set <dvar> "<value>"` lines.
function buildServerCfg(f) {
  const q = (s) => String(s ?? '').replace(/"/g, "'")
  const lines = [
    '// Generated by GameCTL — regenerated on every boot while the',
    '// "GameCTL manages server.cfg" toggle is on. Hand edits are lost;',
    '// use the wizard\'s "Extra server.cfg lines" field instead.',
    `set sv_hostname "${q(f.hostname || 'GameCTL IW4X')}"`,
    `set sv_motd "${q(f.motd || '')}"`,
    `set sv_maxclients "${Number(f.maxClients || 18)}"`,
    `set rcon_password "${q(f.rconPassword || '')}"`,
    `set g_password "${q(f.serverPassword || '')}"`,
    `set g_gametype "${q(f.gametype || 'war')}"`,
    `set scr_teambalance "${Number(f.teamBalance ?? 1) === 1 ? 1 : 0}"`,
    'set sv_punkbuster "0"',
    'set sv_cheats "0"',
  ]

  if (f.botSystem === 'botwarfare') {
    // Real Bot Warfare dvars — these only do something when the mod is
    // actually installed at fs_game, which is why the wizard ties the two
    // together instead of exposing them independently.
    lines.push(
      '// bots (Bot Warfare — mods/mp_bots)',
      `set bots_manage_fill "${Number(f.botCount || 8)}"`,
      'set bots_manage_fill_mode "0"',
      'set bots_manage_fill_kick "1"',
      'set bots_team "autoassign"',
      `set bots_skill "${Number(f.botSkill || 4)}"`,
      'set sv_replaceBots "1"',
      // The in-game menu is gated on doHostCheck(): a player is granted it by
      // being in bots_main_GUIDs, or by ishost() — which nobody is on a
      // dedicated server, so without this list the menu is unreachable.
      'set bots_main_menu "1"',
      // The admin list lives in its own file so the manage screen can edit it
      // without this generated config clobbering it on the next boot. Exec'd
      // last, so whatever the panel wrote wins over anything above.
      'exec gamectl-admins.cfg',
    )
  } else if (f.botSystem === 'builtin') {
    // Built-in bots: nothing to configure beyond making room for humans.
    // Spawning happens via IW4X_BOTS → spawnBot.
    lines.push(
      '// bots (IW4x built-in)',
      'set sv_replaceBots "1"',
    )
  }

  const extra = String(f.extraCfg || '').trim()
  if (extra) {
    lines.push('// extra (from the wizard)')
    // Semicolons split too, so the single-line wizard field can hold several
    // dvars without needing a multi-line control.
    for (const raw of extra.split(/[\n;]+/)) {
      const l = raw.trim()
      if (l) lines.push(l)
    }
  }
  return lines.join('\n') + '\n'
}

export function buildIw4xYaml(f = defaultIw4xForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'iw4x'
  const labels = { app: name, game: 'iw4x', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const size = f.dataStorage || '25Gi'
  const port = Number(f.gamePort || 28960)
  const manage = Number(f.manageConfig ?? 1) === 1
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels },
    spec: isLocal
      ? {
          capacity: { storage: size }, accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/GameCTL/iw4x', type: 'DirectoryOrCreate' },
        }
      : {
          capacity: { storage: size }, accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'nfs-static',
          // No nfsvers / mountOptions — see the project notes.
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/iw4x' },
        },
  })

  const pvcName = `${name}-pvc`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: pvcName, namespace: ns, labels },
    spec: {
      accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'],
      resources: { requests: { storage: size } },
      storageClassName: isLocal ? 'manual' : 'nfs-static',
      volumeName: pvName,
    },
  })

  // Launch args, appended by the image to `wine iw4x.exe -dedicated +set
  // net_port ${GAME_PORT}` — so net_port is NOT ours to pass, it would be a
  // duplicate. fs_game comes before +map so the mod's dvars exist when the
  // map loads; +map is last so the server boots straight into it.
  const params = []
  if (String(f.fsGame || '').trim()) params.push(`+set fs_game ${String(f.fsGame).trim()}`)
  if (manage) params.push('+exec server.cfg')
  params.push('+set playlistFilename playlists.info')
  params.push(`+set sv_maxclients ${Number(f.maxClients || 18)}`)
  params.push(`+set g_gametype ${f.gametype || 'war'}`)
  params.push(`+map ${f.startMap || 'mp_afghan'}`)

  // The full env contract of images/iw4x-kube. Nothing here downloads, updates
  // or validates anything against the network — the image is a Wine runtime
  // over game files the operator supplies, and it exits non-zero (with the
  // missing filename) rather than sleeping when they aren't there.
  const env = [
    { name: 'DATA_DIR', value: SERVER_DIR },
    { name: 'GAME_PARAMS', value: params.join(' ') },
    { name: 'GAME_PORT', value: String(port) },
  ]
  if (String(f.iw4xBinary || '').trim() && String(f.iw4xBinary).trim() !== 'iw4x.exe') {
    env.push({ name: 'IW4X_BINARY', value: String(f.iw4xBinary).trim() })
  }
  // RCON_PASSWORD serves two purposes: the image needs it to issue spawnBot
  // locally, and it's the env name GameCTL's own rcon helper already looks for
  // (kube/rcon_console.go), so the manage screen can talk to the server too.
  // Same value the generated server.cfg sets rcon_password to.
  if (String(f.rconPassword || '').trim()) {
    env.push({ name: 'RCON_PASSWORD', value: String(f.rconPassword).trim() })
  }
  // IW4x has no bot auto-fill dvar — the image waits for the map to come up
  // and then issues `spawnBot <n>` over local RCON.
  if (f.botSystem === 'builtin' && Number(f.botCount || 0) > 0) {
    env.push({ name: 'IW4X_BOTS', value: String(Number(f.botCount)) })
  }

  // server.cfg goes in players/, full stop — the entrypoint actively renames
  // main/server.cfg to server.cfg.bak and reads players/server.cfg, falling
  // back to downloading ich777's stock config when ours isn't there. Writing
  // it anywhere else silently ran the stock config instead of yours.
  const cfg = buildServerCfg(f)
  // Accept commas or newlines; IW4x caps names at 16 chars and treats a comma
  // inside a name as a clan-tag separator, so trim to keep the file honest.
  const botNames = String(f.botNames || '')
    .split(/[\n,]+/)
    .map((n) => n.trim().slice(0, 16))
    .filter(Boolean)
  const initContainers = manage ? [{
    name: 'config-seed',
    image: 'busybox:stable-musl',
    // Same uid/gid as the server: the files land owned correctly without a
    // chown, which a root_squash NFS export would refuse anyway.
    securityContext: { runAsUser: 1000, runAsGroup: 1000 },
    command: ['/bin/sh', '-c'],
    args: [[
      'set -e',
      'mkdir -p /iw4x/players /iw4x/main',
      "cat > /iw4x/players/server.cfg <<'GAMECTL_EOF'",
      cfg,
      'GAMECTL_EOF',
      'echo "gamectl: wrote players/server.cfg"',
      // Admin list (Bot Warfare menu access). Seeded from the wizard field on
      // FIRST boot only; after that the manage screen owns this file, so a
      // redeploy never silently drops an admin added from the panel.
      'if [ ! -f /iw4x/players/gamectl-admins.cfg ]; then',
      `  printf '%s\\n' '// GameCTL-managed — Bot Warfare menu admins. Edit from the manage screen.' 'set bots_main_GUIDs "${String(f.botMenuGuids || '').split(/[\s,]+/).map((g) => g.trim()).filter(Boolean).join(',')}"' > /iw4x/players/gamectl-admins.cfg`,
      '  echo "gamectl: seeded players/gamectl-admins.cfg"',
      'fi',
      // Bot names. IW4x reads userraw/bots.txt once at startup (verified: with
      // the file only in main/ the roster falls back to bot0, bot1, …). Only
      // written when the operator supplied names, so the image's own seeded
      // list — and any hand-edited file — survives an empty field.
      ...(botNames.length ? [
        'mkdir -p /iw4x/userraw',
        "cat > /iw4x/userraw/bots.txt <<'GAMECTL_EOF'",
        botNames.join('\n'),
        'GAMECTL_EOF',
        `echo "gamectl: wrote userraw/bots.txt (${botNames.length} names)"`,
      ] : []),
      // Residue cleanup for volumes that once ran the old ich777 image: a
      // parking-page HTML file saved as iw4x_files.zip, and the 22-byte empty
      // .iwd we wrote to get past that image's inescapable DLC gate. Neither
      // means anything to iw4x-kube, and leaving the fake .iwd would make it
      // report "DLC map packs detected" about a file containing no maps.
      // Size-gated so a REAL DLC .iwd is never touched.
      'for z in /iw4x/iw4x_files.zip /iw4x/iw4x_dlc.zip; do',
      '  [ -f "$z" ] || continue',
      // `if !` rather than `... && continue`: under set -e a failing grep as
      // the last command of an && list exits the script, so the cleanup
      // would never run on exactly the files it exists to clean up.
      '  if ! head -c 2 "$z" | grep -q PK; then',
      '    echo "gamectl: removing $z — leftover failed download from the old image" >&2',
      '    rm -f "$z"',
      '  fi',
      'done',
      'if [ -f /iw4x/main/iw_dlc3_00.iwd ] && [ "$(wc -c < /iw4x/main/iw_dlc3_00.iwd)" -le 32 ]; then',
      '  echo "gamectl: removing the empty placeholder iw_dlc3_00.iwd — iw4x-kube does not require DLC" >&2',
      '  rm -f /iw4x/main/iw_dlc3_00.iwd',
      'fi',
      // Validating the game files themselves is the image's job now: it names
      // the exact missing file and exits non-zero instead of sleeping.
    ].join('\n')],
    volumeMounts: [{ name: 'data', mountPath: '/iw4x' }],
  }] : []

  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment',
    // publish-mode=egress: IW4x heartbeats to the dpmaster at dp.iw4x.io:20810,
    // and the master lists the server at the SOURCE address of that heartbeat —
    // clients then query that address directly. An inbound-only tunnel isn't
    // enough: the master would advertise the home WAN IP while the public port
    // lives on the droplet, so the server shows up unjoinable or not at all.
    // Routing the pod's egress through the droplet (WireGuard sidecar) makes
    // the address the master sees the same one players can reach. Same reason
    // wreckfest2 carries this annotation for PlayFab.
    metadata: { name, namespace: ns, labels, annotations: { 'gamectl.io/publish-mode': 'egress' } },
    spec: {
      replicas: 1,
      // One install on one volume — never run two pods against it.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          terminationGracePeriodSeconds: 30,
          securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
          ...(initContainers.length ? { initContainers } : {}),
          containers: [{
            name: 'server',
            image: f.image || 'ich777/iw4x-server:latest',
            imagePullPolicy: 'Always',
            env,
            ports: [
              { name: 'game-udp', containerPort: port, protocol: 'UDP' },
              { name: 'game-tcp', containerPort: port, protocol: 'TCP' },
            ],
            volumeMounts: [{ name: 'data', mountPath: SERVER_DIR }],
            resources: {
              requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '2Gi' },
              limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '4Gi' },
            },
          }],
          volumes: [{ name: 'data', persistentVolumeClaim: { claimName: pvcName } }],
        },
      },
    },
  })

  docs.push({
    apiVersion: 'v1', kind: 'Service',
    metadata: { name, namespace: ns, labels, ...mlbAnno },
    spec: {
      type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined,
      selector: labels,
      ports: [
        { name: 'game-udp', port, targetPort: port, protocol: 'UDP' },
        { name: 'game-tcp', port, targetPort: port, protocol: 'TCP' },
      ],
    },
  })

  return docs.map((d) => yaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n')
}
