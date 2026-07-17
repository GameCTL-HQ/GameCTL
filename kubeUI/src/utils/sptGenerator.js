import yaml from 'js-yaml'

// SPT + Project Fika (Escape from Tarkov co-op) — the persistent stash / hideout
// / trader / profile backend (the SPT server + Fika co-op server mod). This is
// NOT the Fika headless raid client (that one needs the real EFT game files +
// ~32Gi RAM and is deliberately out of scope).
//
// Base image: the operator's own `fika-runtime` (Ubuntu 22.04 + wine64 +
// dotnet-9; entrypoint run-fika.sh). Its entrypoint launches SERVER_EXE — the
// working config runs the NATIVE Linux SPT server (SPT.Server.Linux,
// RUN_LINUX_BINARY=1); flip the toggle to run the Windows exe under Wine.
//
// The image ships NO game files: the SPT + Fika install must already exist on
// the persistent volume (seed it once — see INSTALL/DATA below). GameCTL builds
// + deploys the wrapper; it does not install SPT/Fika.
//
// Storage: one operator-declared NFS location, two subPaths:
//   server/  -> /fika  (SPT install: SPT.Server.Linux, user/mods, user/profiles, configs)
//   data/    -> /data  (Wine prefix + run-fika.sh logs)
// Seed by copying the existing install: the old server files -> <loc>/server/,
// the old wine/data dir -> <loc>/data/. Fika + other mods are managed by
// dropping/removing folders under <loc>/server/SPT/user/mods/ on the NAS, then
// restarting the deployment.

// SPT install lives on subPath 'server', mounted here.
const SERVER_DIR = '/fika'
// Wine prefix + logs on subPath 'data', mounted here.
const DATA_DIR = '/data'
// SPT's HTTP listener config, inside the install. SPT ships this defaulting to
// ip/backendIp 127.0.0.1 (unreachable via a Service/LB) — an init container
// rewrites it every deploy so bind + advertised addr track the wizard settings.
const HTTP_CONFIG = `${SERVER_DIR}/SPT/SPT_Data/configs/http.json`

export const defaultSptForm = {
  namespace: 'gamectl-spt',
  serverName: 'fika',
  image: 'registry.example.com:5000/fika-runtime:latest',
  // Storage: operator-declared location (resolveStorage -> storageMode +
  // nfsServer/dataPvPath or localDataPath). SPT install + mods + profiles +
  // wine prefix fit comfortably in ~20Gi.
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/fika',
  localDataPath: '/mnt/1TBSSD/GameCTL/fika',
  dataStorage: '20Gi',
  // Runtime: 1 = native Linux SPT server (recommended, no Wine); 0 = Windows exe
  // under Wine (SPT.Server.exe). Drives SERVER_EXE + RUN_LINUX_BINARY.
  runLinuxBinary: 1,
  // Privileged was needed for the Wine socket. Running the Linux binary it may
  // be droppable — left on by default to match the known-good deploy; try off.
  privileged: 1,
  tz: 'UTC',
  // Networking. 6969 = SPT/Fika HTTP+WS (the one clients hit). 25565 + 22100 are
  // the extra Fika ports from the working deploy.
  httpPort: 6969,
  altTcpPort: 25565,
  fikaUdpPort: 22100,
  // Free IP inside the homelab MetalLB pool (10.0.0.160-183). The wizard's
  // LoadBalancer-IP picker lets the operator choose a different free one.
  lbIP: '10.0.0.174',
}

// -----------------------------------------------------------------------------
// Project Fika mod seeding.
//
// The fika-runtime image ships NO mods — Fika is seeded onto the NFS install
// like any other SPT mod (see docs/SPT_FIKA_PLAN.md). SPT 4.x is the C# server
// rewrite, so Fika must come from the C# successor repos, NOT the archived
// TypeScript Fika-Server (2.4.x = SPT 3.x only):
//   server mod -> project-fika/Fika-Server-CSharp  (Fika.Server.Release.<v>.zip)
//   client dll -> project-fika/Fika-Plugin         (Fika.Release.<v>.zip)
// The matched pair below both target SPT 4.0.x / EFT 0.16.9 (dated 2026-07-15).
// Bump these together when a newer matched pair ships.
export const FIKA_SERVER_VERSION = '2.3.5'
export const FIKA_CLIENT_VERSION = '2.3.5'
export const FIKA_RELEASES = {
  server: 'https://github.com/project-fika/Fika-Server-CSharp/releases',
  client: 'https://github.com/project-fika/Fika-Plugin/releases',
}

// Build the pre-filled seed commands the operator runs from their workstation
// after downloading + extracting the two Fika release zips. Paths are derived
// from the resolved Storage Location (host + install base) so they never drift
// from the actual deploy. `nfsHost` empty => a local (hostPath) location, so
// the rsync targets a local path instead of root@host: over SSH.
export function buildFikaSeed({
  nfsHost = '',
  installBase = '/mnt/1TBSSD/GameCTL/fika',
  namespace = 'gamectl',
  serverName = 'fika',
  serverVer = FIKA_SERVER_VERSION,
  clientVer = FIKA_CLIENT_VERSION,
} = {}) {
  const base = String(installBase).replace(/\/+$/, '')
  // rsync/ssh target: over SSH to the NAS for NFS, or the local path otherwise.
  const dest = nfsHost ? `root@${nfsHost}:${base}` : base
  const serverModDir = `${dest}/server/SPT/user/mods/fika-server/`
  const pluginDir = `${dest}/server/BepInEx/plugins/`
  const backup =
    `d=${base}/server; [ -d "$d/SPT/user/mods/fika-server" ] && ` +
    `mkdir -p "$d/backups" && ` +
    `cp -a "$d/SPT/user/mods/fika-server" "$d/backups/fika-server.$(date +%F-%H%M%S)" || true`
  return [
    '# ── Seed Project Fika onto the SPT install (run from your workstation) ──',
    '# 1. Download + extract the MATCHED pair (both target SPT 4.0.x / EFT 0.16.9):',
    `#      server mod: Fika.Server.Release.${serverVer}.zip   ${FIKA_RELEASES.server}`,
    `#      client dll: Fika.Release.${clientVer}.zip           ${FIKA_RELEASES.client}`,
    "#    Do NOT use the archived TypeScript Fika-Server 2.4.x — that's SPT 3.x only.",
    '#    Verify the extracted layout matches the source paths in steps 3-4.',
    '',
    '# 2. Back up any existing Fika server mod (no-op on first install):',
    nfsHost ? `ssh root@${nfsHost} '${backup}'` : backup,
    '',
    '# 3. Seed the SERVER mod  ->  SPT/user/mods/fika-server/  (clean replace)',
    'rsync -av --delete --chown=1000:1000 \\',
    `  ./Fika.Server.Release.${serverVer}/user/mods/fika-server/ \\`,
    `  ${serverModDir}`,
    '',
    '# 4. Seed the CLIENT plugin into the mod-sync source (server hands it to players):',
    'rsync -av --chown=1000:1000 \\',
    `  ./Fika.Release.${clientVer}/BepInEx/plugins/ \\`,
    `  ${pluginDir}`,
    '',
    '# 5. Restart the server to load Fika:',
    `kubectl -n ${namespace} rollout restart deploy/${serverName}`,
    `kubectl -n ${namespace} rollout status  deploy/${serverName} --timeout=180s`,
    '',
    '# 6. Confirm Fika loaded and 6969 still serves:',
    `kubectl -n ${namespace} logs deploy/${serverName} --tail=200 | grep -i fika`,
  ].join('\n')
}

// Deploy learning: SPT binds to 127.0.0.1 by default, so it's unreachable via a
// Service/LoadBalancer. Rewrite http.json before the server starts so it binds
// 0.0.0.0 and advertises the LB IP (backendIp) to clients. Runs every deploy, so
// backendIp/port always track the wizard's LB IP + port — no drift when they
// change. Runs as root (no_root_squash NFS) to edit the file regardless of its
// current owner, then hands ownership back to uid 1000. sed-in-place preserves
// any other keys SPT keeps in the file.
function httpConfigInitCmd(backendIp, port) {
  const setBackend = backendIp
    ? `sed -i -E 's#("backendIp"[[:space:]]*:[[:space:]]*)"[^"]*"#\\1"${backendIp}"#' "$cfg"; `
    : 'echo "WARN: no fixed LB IP (pool auto-assign) — leaving backendIp as-is; set it once clients need a reachable address" >&2; '
  return [
    '/bin/sh', '-c',
    `cfg=${HTTP_CONFIG}; ` +
    'if [ ! -f "$cfg" ]; then echo "ERROR: $cfg not found — is the SPT install seeded on this volume?" >&2; exit 1; fi; ' +
    `sed -i -E 's#("ip"[[:space:]]*:[[:space:]]*)"[^"]*"#\\1"0.0.0.0"#' "$cfg"; ` +
    `sed -i -E 's#("port"[[:space:]]*:[[:space:]]*)[0-9]+#\\1${port}#' "$cfg"; ` +
    `sed -i -E 's#("backendPort"[[:space:]]*:[[:space:]]*)[0-9]+#\\1${port}#' "$cfg"; ` +
    setBackend +
    'chown 1000:1000 "$cfg" 2>/dev/null || true; ' +
    'echo "patched http.json:"; cat "$cfg"',
  ]
}

export function buildSptYaml(f = defaultSptForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'fika'
  const labels = { app: name, game: 'spt', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const priv = Number(f.privileged ?? 1) === 1
  const linux = Number(f.runLinuxBinary ?? 1) === 1
  const serverExe = linux ? `${SERVER_DIR}/SPT/SPT.Server.Linux` : `${SERVER_DIR}/SPT/SPT.Server.exe`
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels },
    spec: isLocal
      ? {
          capacity: { storage: f.dataStorage || '20Gi' },
          accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/GameCTL/fika', type: 'DirectoryOrCreate' },
        }
      : {
          capacity: { storage: f.dataStorage || '20Gi' },
          accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'nfs-static',
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/fika' },
        },
  })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], resources: { requests: { storage: f.dataStorage || '20Gi' } }, storageClassName: isLocal ? 'manual' : 'nfs-static', volumeName: pvName
  } })

  const httpPort = Number(f.httpPort || 6969)
  const altPort = Number(f.altTcpPort || 25565)
  const udpPort = Number(f.fikaUdpPort || 22100)

  const env = [
    { name: 'SERVER_EXE', value: serverExe },
    { name: 'RUN_LINUX_BINARY', value: linux ? '1' : '0' },
    { name: 'WINEPREFIX', value: `${DATA_DIR}/prefix` },
    { name: 'WINEDEBUG', value: '-all' },
    { name: 'TZ', value: f.tz || 'UTC' },
  ]

  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno },
    spec: {
      replicas: 1, selector: { matchLabels: labels },
      // Single-instance game server: stop the old pod before starting the new
      // (avoids two servers on the same NFS install + the 2x-resource surge a
      // rolling update needs).
      strategy: { type: 'Recreate' },
      template: { metadata: { labels }, spec: {
        // Image runs as the 'fika' user (uid 1000); fsGroup lets it write the
        // mounted NFS dirs.
        securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
        // Rewrite SPT's http.json so it binds 0.0.0.0 + advertises the LB IP
        // before the server boots (SPT defaults to 127.0.0.1 = unreachable via
        // the Service). Only mounts the server subPath; runs as root to edit the
        // file regardless of owner, then chowns it back to 1000.
        initContainers: [ {
          name: 'config-http', image: f.image || 'registry.example.com:5000/fika-runtime:latest', imagePullPolicy: 'Always',
          securityContext: { runAsUser: 0 },
          command: httpConfigInitCmd(f.lbIP || '', httpPort),
          volumeMounts: [ { name: 'data', mountPath: SERVER_DIR, subPath: 'server' } ],
        } ],
        containers: [ {
          name: 'server', image: f.image || 'registry.example.com:5000/fika-runtime:latest', imagePullPolicy: 'Always', env,
          // No command/args override: the image ENTRYPOINT (run-fika.sh) reads
          // SERVER_EXE/RUN_LINUX_BINARY and launches the server.
          ports: [
            { name: 'spt-http', containerPort: httpPort, protocol: 'TCP' },
            { name: 'fika-tcp', containerPort: altPort, protocol: 'TCP' },
            { name: 'fika-udp', containerPort: udpPort, protocol: 'UDP' },
          ],
          // Two subPaths of the one NFS PVC: the SPT install (server/, mounted at
          // /fika) and the Wine prefix + logs (data/, mounted at /data). Both
          // must persist — profiles + mods live under server/SPT/user/.
          volumeMounts: [
            { name: 'data', mountPath: SERVER_DIR, subPath: 'server' },
            { name: 'data', mountPath: DATA_DIR, subPath: 'data' },
          ],
          resources: { requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '2Gi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '8Gi' } },
          // securityContext.privileged was required for the Wine socket on the
          // working deploy. Toggle off to test dropping it (Linux binary path).
          securityContext: { privileged: priv, allowPrivilegeEscalation: priv },
          // Deploy learning: don't grep the log for "Server has started" — the log
          // lives on the shared NFS volume, so after a restart the probe matches
          // the PREVIOUS run's line and passes before the new server binds. A TCP
          // probe on the SPT port is the real "up and serving" signal. Startup
          // allows ~10min for a cold boot / DB import; liveness/readiness only run
          // once startup succeeds.
          startupProbe: { tcpSocket: { port: httpPort }, periodSeconds: 10, failureThreshold: 60 },
          livenessProbe: { tcpSocket: { port: httpPort }, periodSeconds: 30, failureThreshold: 5 },
          readinessProbe: { tcpSocket: { port: httpPort }, periodSeconds: 10, failureThreshold: 3 },
        } ],
        volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ]
      } }
    }
  })

  docs.push({
    apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno },
    // Deploy learning: externalTrafficPolicy 'Local' dropped traffic here — the
    // MetalLB L2 node announcing the VIP often isn't the pod's node, so packets
    // to the pod's port were blackholed (ICMP still answered, so ping lied).
    // 'Cluster' lets kube-proxy route to the pod on any node; SPT doesn't need
    // the client source IP, so the SNAT that comes with it is fine.
    spec: {
      type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Cluster', selector: labels,
      ports: [
        { name: 'spt-http', port: httpPort, targetPort: httpPort, protocol: 'TCP' },
        { name: 'fika-tcp', port: altPort, targetPort: altPort, protocol: 'TCP' },
        { name: 'fika-udp', port: udpPort, targetPort: udpPort, protocol: 'UDP' },
      ]
    }
  })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
