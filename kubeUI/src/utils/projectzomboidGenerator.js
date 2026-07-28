import yaml from 'js-yaml'

// Project Zomboid — anonymous SteamCMD (no account). renegademaster image
// is the well-maintained one. Direct connect on 16261/UDP (+16262/UDP).
// Validate on a dev build: env keys can differ by image version.
export const defaultProjectzomboidForm = {
  namespace: 'gamectl-projectzomboid',
  serverName: 'projectzomboid',
  image: 'ghcr.io/gamectl-hq/zomboid-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/projectzomboid',
  dataStorage: '20Gi',
  localDataPath: '/mnt/1TBSSD/projectzomboid',
  serverNameDisplay: 'GameCTL PZ',
  adminPassword: 'ChangeMe12345',
  rconPort: 27015, // TCP — renegademaster image default RCON port
  rconPassword: 'ChangeMe12345', // Source-RCON for the manage-screen console
  serverPort: 16261,
  lbIP: '10.0.0.193',
}

export function buildProjectzomboidYaml(f = defaultProjectzomboidForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'projectzomboid'
  const labels = { app: name, game: 'projectzomboid', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const base = Number(f.serverPort || 16261)
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels }, spec: isLocal ? {
    capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: 'manual',
    persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: f.localDataPath || '/mnt/1TBSSD/projectzomboid', type: 'DirectoryOrCreate' }
  } : {
    capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteMany'], storageClassName: 'nfs-static',
    persistentVolumeReclaimPolicy: 'Retain', nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/projectzomboid' }
  } })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], storageClassName: isLocal ? 'manual' : ('nfs-static'), resources: { requests: { storage: f.dataStorage || '20Gi' } }, volumeName: pvName
  } })

  // Source-RCON so the GameCTL manage screen can run console commands.
  // The renegademaster/zomboid-dedicated-server image honors RCON_PORT and
  // RCON_PASSWORD env vars directly (it writes them into the PZ server ini's
  // RCONPort / RCONPassword); there is no separate enable flag — RCON
  // listens whenever a password is set. RCON_PASSWORD is also what makes
  // GameCTL's generic console light up (resolveRCON / rconAvailable look
  // for a non-empty RCON_PASSWORD env value). Keep the rcon port OFF any
  // public tunnel — internal Service ClusterIP only (cs2 brute-force lesson).
  const rconPort = Number(f.rconPort || 27015)
  const env = [
    { name: 'SERVER_NAME', value: f.serverNameDisplay || 'GameCTL PZ' },
    { name: 'ADMIN_PASSWORD', value: f.adminPassword || 'ChangeMe12345' },
    { name: 'RCON_PORT', value: String(rconPort) },
    { name: 'RCON_PASSWORD', value: f.rconPassword || 'ChangeMe12345' },
    { name: 'UPDATE_ON_START', value: 'false' }, // GameCTL auto-update toggle target
  ]

  docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    // Recreate, not RollingUpdate: a rolling update schedules the replacement
    // pod while the old one still holds its CPU/RAM and its volume, so a
    // Restart deadlocks on a cluster with no spare headroom — and two
    // servers would briefly write the same save data.
    strategy: { type: 'Recreate' },
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      containers: [ { name: 'server', image: f.image || 'ghcr.io/gamectl-hq/zomboid-kube:latest', imagePullPolicy: 'Always', env,
        ports: [
          { name: 'pz-udp-0', containerPort: base, protocol: 'UDP' },
          { name: 'pz-udp-1', containerPort: base + 1, protocol: 'UDP' },
          // RCON for the GameCTL console — internal-only. Do NOT forward
          // this port on any public tunnel/ingress (a public RCON port
          // gets brute-force-scanned; see the cs2 fix).
          { name: 'rcon', containerPort: rconPort, protocol: 'TCP' },
        ],
        volumeMounts: [ { name: 'data', mountPath: '/home/steam/Zomboid' } ],
        resources: { requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '2Gi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '5Gi' } },
      } ],
      volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ]
    } }
  } })

  docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Local', selector: labels, ports: [
      { name: 'pz-udp-0', port: base, targetPort: base, protocol: 'UDP' },
      { name: 'pz-udp-1', port: base + 1, targetPort: base + 1, protocol: 'UDP' },
      // RCON for the GameCTL console. Reached internally via the Service
      // ClusterIP — do NOT forward this port on any public tunnel/ingress
      // (a public RCON port gets brute-force-scanned; see the cs2 fix).
      { name: 'rcon', port: rconPort, targetPort: rconPort, protocol: 'TCP' },
    ]
  } })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
