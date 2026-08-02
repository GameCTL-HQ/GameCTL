import yaml from 'js-yaml'

// DayZ dedicated server (Steam app 223350) on SteamCMD — NOT anonymous.
//
// 223350 is entitlement-gated: `+login anonymous +app_update 223350` returns
// nothing and the pod then dies on a missing DayZServer binary. It needs a
// Steam account that OWNS DayZ, which is why this generator wires
// USERNAME/PASSWRD to the shared, write-only `gamectl-steam` Secret
// (Settings → Steam) via secretKeyRef with optional:false — a missing Secret
// fails the pod at CreateContainerConfigError with a legible reason instead
// of silently falling back to an anonymous login that can't work.
//
// Base image: ich777/steamcmd:dayz (Debian + Valve steamcmd + a DayZ
// entrypoint). Layout it expects:
//   /serverdata/steamcmd     steamcmd itself
//   /serverdata/serverfiles  the ~15G game install + configs + profiles
// Both are subPaths of the one PVC, so the install survives restarts and a
// normal boot is a fast delta-check rather than a re-download.
//
// Config: GameCTL writes its own `gamectl.cfg` (serverDZ.cfg syntax) from the
// wizard fields on every boot and launches with -config=gamectl.cfg. The
// image's stock serverDZ.cfg is left alone on the volume, so turning the
// managed-config toggle off hands control back to a hand-edited file without
// anything having been overwritten.

// Mission templates shipped with the server. `dayzOffline.*` are the vanilla
// missions; a custom mission dir dropped on the volume can be typed in too.
export const DAYZ_MISSIONS = [
  { label: 'Chernarus+ (dayzOffline.chernarusplus)', value: 'dayzOffline.chernarusplus' },
  { label: 'Livonia / Enoch (dayzOffline.enoch)', value: 'dayzOffline.enoch' },
  { label: 'Sakhal (dayzOffline.sakhal) — Frostline DLC', value: 'dayzOffline.sakhal' },
]

const SERVER_DIR = '/serverdata/serverfiles'
const STEAMCMD_DIR = '/serverdata/steamcmd'
const CFG_NAME = 'gamectl.cfg'

export const defaultDayzForm = {
  namespace: 'gamectl-dayz',
  serverName: 'dayz',
  image: 'ich777/steamcmd:dayz',

  // Storage: operator-declared location (resolveStorage → storageMode +
  // nfsServer/dataPvPath or localDataPath). The install alone is ~15G.
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/dayz',
  localDataPath: '/mnt/1TBSSD/GameCTL/dayz',
  dataStorage: '50Gi',

  // Server
  hostname: 'GameCTL DayZ',
  mission: 'dayzOffline.chernarusplus',
  maxPlayers: 20,
  serverPassword: '',        // join password (blank = open)
  adminPassword: 'ChangeMe12345',
  instanceId: 1,
  timeAcceleration: 12,      // serverTimeAcceleration (1 = real time)
  thirdPerson: 1,            // 1 = allowed, 0 = first-person only
  manageConfig: 1,           // 0 = leave serverDZ.cfg to the operator
  validateOnStart: false,

  // Networking
  gamePort: 2302,
  queryPort: 2303,
  lbIP: '',
}

// serverDZ.cfg-syntax config, generated from the wizard fields. Only the
// settings the wizard exposes are written — everything else stays at the
// server's own defaults, so this file doesn't drift as Bohemia adds params.
function buildServerCfg(f) {
  const q = (s) => String(s ?? '').replace(/"/g, "'")
  return [
    `hostname = "${q(f.hostname || 'GameCTL DayZ')}";`,
    `password = "${q(f.serverPassword || '')}";`,
    `passwordAdmin = "${q(f.adminPassword || '')}";`,
    `maxPlayers = ${Number(f.maxPlayers || 20)};`,
    `verifySignatures = 2;`,
    `forceSameBuild = 1;`,
    `disableVoN = 0;`,
    `vonCodecQuality = 20;`,
    `disable3rdPerson = ${Number(f.thirdPerson ?? 1) === 1 ? 0 : 1};`,
    `disableCrosshair = 0;`,
    `serverTime = "SystemTime";`,
    `serverTimeAcceleration = ${Number(f.timeAcceleration || 12)};`,
    `serverTimePersistent = 0;`,
    `guaranteedUpdates = 1;`,
    `loginQueueConcurrentPlayers = 5;`,
    `loginQueueMaxPlayers = 500;`,
    `instanceId = ${Number(f.instanceId || 1)};`,
    `storageAutoFix = 1;`,
    // Pinned rather than left default: the A2S health probe targets this
    // exact port, and DayZ's default has moved between builds.
    `steamQueryPort = ${Number(f.queryPort || 2303)};`,
    `class Missions`,
    `{`,
    `    class DayZ`,
    `    {`,
    `        template = "${q(f.mission || 'dayzOffline.chernarusplus')}";`,
    `    };`,
    `};`,
    '',
  ].join('\n')
}

export function buildDayzYaml(f = defaultDayzForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'dayz'
  const labels = { app: name, game: 'dayz', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const size = f.dataStorage || '50Gi'
  const port = Number(f.gamePort || 2302)
  const query = Number(f.queryPort || 2303)
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
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/GameCTL/dayz', type: 'DirectoryOrCreate' },
        }
      : {
          capacity: { storage: size }, accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'nfs-static',
          // No nfsvers / mountOptions — see the project notes.
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/dayz' },
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

  // -config is resolved relative to the server dir; -profiles collects the
  // logs the admin panel reads. BEpath keeps BattlEye's files on the volume.
  const gameParams = [
    `-config=${manage ? CFG_NAME : 'serverDZ.cfg'}`,
    `-port=${port}`,
    '-BEpath=battleye',
    '-profiles=profiles',
    '-dologs', '-adminlog', '-netlog', '-freezecheck',
  ].join(' ')

  const env = [
    // Shared, write-only Steam account (Settings → Steam). optional:false so a
    // missing/empty Secret is a loud pod-level failure, not a silent anonymous
    // login that leaves serverfiles/ empty. ich777's env names are USERNAME and
    // PASSWRD (no second "O") — match exactly.
    { name: 'USERNAME', valueFrom: { secretKeyRef: { name: 'gamectl-steam', key: 'username', optional: false } } },
    { name: 'PASSWRD', valueFrom: { secretKeyRef: { name: 'gamectl-steam', key: 'password', optional: false } } },
    { name: 'GAME_ID', value: '223350' },
    { name: 'GAME_PARAMS', value: gameParams },
    { name: 'GAME_PORT', value: String(port) },
    // Full re-hash of a ~15G install over NFS on every boot is expensive;
    // validate only when the operator asks for it.
    { name: 'VALIDATE', value: f.validateOnStart ? 'true' : 'false' },
    // ich777 images default to unRAID's 99/100. GameCTL's NFS exports are
    // chowned 1000:1000 like every other game here.
    { name: 'UID', value: '1000' },
    { name: 'GID', value: '1000' },
  ]

  const volumeMounts = [
    { name: 'data', mountPath: SERVER_DIR, subPath: 'serverfiles' },
    { name: 'data', mountPath: STEAMCMD_DIR, subPath: 'steamcmd' },
  ]

  // Managed config: rewritten every boot from the wizard fields. Deliberately
  // a separate file from the image's stock serverDZ.cfg — turning the toggle
  // off gives the operator a pristine file to hand-edit.
  const initContainers = manage ? [{
    name: 'config-seed',
    image: 'busybox:stable-musl',
    // Runs as the same uid/gid the server does, so the file it writes is
    // already owned correctly and no chown is needed — a root init container
    // would be squashed to nobody on a root_squash NFS export and fail to
    // write at all.
    securityContext: { runAsUser: 1000, runAsGroup: 1000 },
    command: ['/bin/sh', '-c'],
    args: [[
      'set -e',
      'mkdir -p /serverfiles',
      `cat > /serverfiles/${CFG_NAME} <<'GAMECTL_EOF'`,
      buildServerCfg(f),
      'GAMECTL_EOF',
      `echo "gamectl: wrote ${CFG_NAME}"`,
    ].join('\n')],
    volumeMounts: [{ name: 'data', mountPath: '/serverfiles', subPath: 'serverfiles' }],
  }] : []

  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace: ns, labels },
    spec: {
      replicas: 1,
      // One install on one volume — never run two pods against it.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          // First boot downloads ~15G before the server binds anything.
          terminationGracePeriodSeconds: 60,
          securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
          ...(initContainers.length ? { initContainers } : {}),
          containers: [{
            name: 'server',
            image: f.image || 'ich777/steamcmd:dayz',
            imagePullPolicy: 'Always',
            env,
            ports: [
              { name: 'game-udp', containerPort: port, protocol: 'UDP' },
              { name: 'query-udp', containerPort: query, protocol: 'UDP' },
            ],
            volumeMounts,
            resources: {
              requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '2Gi' },
              limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '6Gi' },
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
        { name: 'query-udp', port: query, targetPort: query, protocol: 'UDP' },
      ],
    },
  })

  return docs.map((d) => yaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n')
}
