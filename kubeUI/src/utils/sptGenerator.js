import yaml from 'js-yaml'

// SPT + Project Fika (Escape from Tarkov co-op) backend using GameCTL's own
// image (repo: GameCTL-HQ/Tarkov-SPT-Castro-Fika-Kube), built from scratch. It:
//   - bakes the SPT server (TAG encodes SPT ver) + the current Fika server mod,
//     so it tracks the latest Fika client (no "Required Server Version" mismatch)
//   - seeds SPT + Fika onto the volume on first boot + binds http.json to
//     0.0.0.0 (LISTEN_ALL_NETWORKS=true)
// So it deploys from an EMPTY volume (no manual seeding). Persistent data lives
// at /opt/server (profiles, mods, server files).
//
// This is the persistent co-op BACKEND (stash/hideout/traders/profiles + the
// Fika server mod). It is NOT the Fika headless raid client (real EFT files +
// ~32Gi RAM) — that stays out of scope.

const SERVER_DIR = '/opt/server'

export const defaultSptForm = {
  namespace: 'gamectl-spt',
  serverName: 'fika',
  // GameCTL's own SPT + Fika image — built from scratch (repo:
  // GameCTL-HQ/Tarkov-SPT-Castro-Fika-Kube) so the baked Fika server tracks the
  // current Fika client and avoids "Required Server Version" mismatches. Public
  // on GHCR (a weekly Action rebuilds it against the latest Fika). The tag
  // encodes SPT + Fika versions; bump it after the Action publishes a newer one.
  image: 'ghcr.io/gamectl-hq/tarkov-spt-castro-fika-kube:spt4.0.13-fika2.3.5',
  // Storage: operator-declared location (resolveStorage -> storageMode +
  // nfsServer/dataPvPath or localDataPath). SPT + mods + profiles fit in ~20Gi.
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/fika',
  localDataPath: '/mnt/1TBSSD/GameCTL/fika',
  dataStorage: '20Gi',
  // Bind SPT's http listener to 0.0.0.0 so it's reachable via the Service/LB.
  // (Fika is baked into the image — no install/version knobs here.)
  listenAllNetworks: 1,
  // Mod sync: auto-syncs mods server->client with an on-launch update check, so
  // every player runs the same set. Uses NARCONet (C#, SPT 4.0.x) — Corter
  // ModSync is SPT 3.x-only, NARCONet is the 4.x-compatible one. On by default.
  // See docs/SPT_FIKA_MODSYNC.md.
  modSync: 1,
  // Download URL for the NARCONet release (server mod is auto-extracted; players
  // install the matching client — the BepInEx/plugins/MadManBeavis-NarcoNet
  // folder — from the same zip). NARCONet publishes on GitLab generic packages
  // (public, un-gated) — unlike the Forge (Cloudflare/login) and GitHub (stale at
  // 1.0.2). 1.0.16 is the current 4.0.13 build; same SPT/user/mods layout, so the
  // init extracts it unchanged. Full URL, not a version string.
  modSyncUrl: 'https://gitlab.com/api/v4/projects/80043430/packages/generic/narconet/1.0.16/NarcoNet-v1.0.16.zip',
  // Headless raid host support: when on, an init container patches fika.jsonc
  // (headless.profiles.amount 0->1, scripts.forceIp -> this server's LB URL)
  // so the server creates a headless profile and the headless machine can
  // check in. The headless CLIENT itself runs elsewhere (it's the full EFT
  // client, ~16-32Gi RAM) — see repo Tarkov-Fika-Headless-LXC for the
  // Proxmox/LXC build. Off by default.
  headless: 0,
  tz: 'UTC',
  // Networking. 6969 = SPT + Fika HTTP/WS — the only port clients ever use.
  //
  // There is deliberately no fikaUdpPort here. A "Fika relay UDP port" field
  // defaulting to 22100 used to exist and corresponded to nothing: Fika's
  // NAT-punch server is configured in fika.jsonc, its real default port is
  // 6790, and it ships with "enable": false — confirmed on the live volume.
  // The field only ever produced a Service port and a containerPort at a
  // listener that does not exist at any port, let alone 22100. Fika relays
  // peer traffic over the SPT HTTP port instead.
  httpPort: 6969,
  // Free IP inside the homelab MetalLB pool (10.0.0.160-183). The wizard's
  // LoadBalancer-IP picker lets the operator choose a different free one.
  lbIP: '10.0.0.172',
}

// Init container command: install the NARCONet SERVER mod into /opt/server
// before the server starts. NARCONet's release zip carries client files
// (BepInEx plugin + NarcoNet.Updater.exe, which players install) and the C#
// server mod under SPT/user/mods/NarcoNet-Server/ — we extract only the server
// mod. Idempotent via a URL marker; runs as root for apk + chown. NARCONet's
// sync runs over SPT's own HTTP (6969) — no extra port.
function modSyncInitCmd(url) {
  const u = String(url || defaultSptForm.modSyncUrl)
  // SPT server mods live under <SERVER_DIR>/SPT/user/mods (the zhliau image
  // roots the actual SPT install at /opt/server/SPT — Fika installs there too).
  // Installing to /opt/server/user/mods silently no-ops: SPT never scans it.
  return ['/bin/sh', '-c',
    `set -e; SRV=${SERVER_DIR}/SPT; URL="${u}"; MARK="$SRV/.gamectl-modsync-url"; MOD="$SRV/user/mods/NarcoNet-Server"; ` +
    'if [ "$(cat "$MARK" 2>/dev/null)" = "$URL" ] && [ -d "$MOD" ]; then echo "gamectl: NARCONet already installed"; exit 0; fi; ' +
    'apk add --no-cache curl unzip >/dev/null 2>&1 || { echo "ERROR: need curl+unzip" >&2; exit 1; }; ' +
    'echo "gamectl: installing NARCONet server mod"; ' +
    'curl -sL --max-time 120 -o /tmp/ms.zip "$URL"; rm -rf /tmp/nx; mkdir -p /tmp/nx; unzip -o -q /tmp/ms.zip -d /tmp/nx; ' +
    'SRC=$(dirname "$(find /tmp/nx -type d -iname "NarcoNet-Server" | head -1)"); ' +
    '[ -d "$SRC/NarcoNet-Server" ] || { echo "ERROR: NarcoNet-Server not found in zip" >&2; exit 1; }; ' +
    'mkdir -p "$SRV/user/mods"; rm -rf "$MOD"; cp -a "$SRC/NarcoNet-Server" "$SRV/user/mods/"; ' +
    'echo "$URL" > "$MARK"; chown -R 1000:1000 "$MOD" "$MARK" 2>/dev/null || true; ' +
    'echo "gamectl: NARCONet server mod installed"',
  ]
}

// Init container command: enable Fika headless support by patching fika.jsonc
// on the volume before the server boots. Idempotent: amount is only ever
// bumped 0->1 (operator-raised values are left alone) and forceIp is pinned to
// this server's client-facing URL. On a FRESH install fika.jsonc doesn't exist
// until the Fika server's first boot writes it — then this applies on the next
// restart (the toggle re-runs every boot, so no manual step).
function headlessInitCmd(f) {
  const cfg = `${SERVER_DIR}/SPT/user/mods/fika-server/assets/configs/fika.jsonc`
  const port = Number(f.httpPort || 6969)
  const forceUrl = f.lbIP ? `https://${f.lbIP}:${port}` : ''
  return ['/bin/sh', '-c',
    `set -e; CFG="${cfg}"; ` +
    'if [ ! -f "$CFG" ]; then echo "gamectl: fika.jsonc not written yet (first boot) — headless enable applies on next restart"; exit 0; fi; ' +
    'sed -i "s|\\"amount\\": 0,|\\"amount\\": 1,|" "$CFG"; ' +
    (forceUrl
      ? `sed -i "s|\\"forceIp\\": \\"[^\\"]*\\"|\\"forceIp\\": \\"${forceUrl}\\"|" "$CFG"; `
      : 'echo "gamectl: no LoadBalancer IP set — leaving forceIp as-is"; ') +
    'echo "gamectl: headless support enabled in fika.jsonc"',
  ]
}

export function buildSptYaml(f = defaultSptForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'fika'
  const labels = { app: name, game: 'spt', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
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

  // The GameCTL image reads these; SPT + Fika (baked) install themselves on
  // first boot. UID/GID pair with the pod's fsGroup for NFS write access.
  //
  // SPT_PORT is applied by the entrypoint to http.json (port + backendPort),
  // which is the ONLY place SPT's listen port exists — no flag, no other env.
  // Without it SPT stays on 6969 while the Service, the LB and ProxyCTL's
  // DNAT (which preserves the destination port) follow the wizard's choice.
  const env = [
    { name: 'SPT_PORT', value: String(httpPort) },
    { name: 'LISTEN_ALL_NETWORKS', value: Number(f.listenAllNetworks ?? 1) === 1 ? 'true' : 'false' },
    { name: 'UID', value: '1000' },
    { name: 'GID', value: '1000' },
    { name: 'TZ', value: f.tz || 'UTC' },
  ]

  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno },
    spec: {
      replicas: 1, selector: { matchLabels: labels },
      // Single-instance backend: stop the old pod before starting the new (one
      // server per install; avoids the 2x-resource surge of a rolling update).
      strategy: { type: 'Recreate' },
      template: { metadata: { labels }, spec: {
        // The image manages ownership via UID/GID env; fsGroup makes the mounted
        // NFS volume group-writable by 1000.
        securityContext: { fsGroup: 1000 },
        // Volume-prep init containers: NARCONet mod-sync install and/or Fika
        // headless enablement — both patch the data volume before boot.
        ...(() => {
          const inits = []
          if (Number(f.modSync ?? 1) === 1) inits.push({
            name: 'modsync-install', image: 'alpine:3.20', securityContext: { runAsUser: 0 },
            command: modSyncInitCmd(f.modSyncUrl),
            volumeMounts: [ { name: 'data', mountPath: SERVER_DIR } ],
          })
          if (Number(f.headless ?? 0) === 1) inits.push({
            name: 'headless-enable', image: 'alpine:3.20', securityContext: { runAsUser: 0 },
            command: headlessInitCmd(f),
            volumeMounts: [ { name: 'data', mountPath: SERVER_DIR } ],
          })
          return inits.length ? { initContainers: inits } : {}
        })(),
        containers: [ {
          name: 'server', image: f.image || 'ghcr.io/zhliau/fika-spt-server-docker:4.0.13', imagePullPolicy: 'Always', env,
          ports: [
            { name: 'spt-http', containerPort: httpPort, protocol: 'TCP' },
          ],
          // Single persistent volume — SPT server files, mods (incl. Fika),
          // profiles and backups all live under /opt/server.
          volumeMounts: [ { name: 'data', mountPath: SERVER_DIR } ],
          resources: { requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '2Gi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '8Gi' } },
          // TCP probe on the SPT port is the real "up and serving" signal (don't
          // grep the log — it's on the shared volume, so a restart matches the
          // previous run's line). Startup allows ~10min for a cold boot + Fika
          // install + DB import; liveness/readiness run once startup succeeds.
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
    // externalTrafficPolicy 'Cluster': the MetalLB L2 node announcing the VIP
    // often isn't the pod's node, so 'Local' blackholes traffic. SPT doesn't
    // need the client source IP, so the SNAT that comes with 'Cluster' is fine.
    spec: {
      type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Cluster', selector: labels,
      ports: [
        { name: 'spt-http', port: httpPort, targetPort: httpPort, protocol: 'TCP' },
      ]
    }
  })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
