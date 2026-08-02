import yaml from 'js-yaml'

// Core Keeper supports two connection modes:
//   relay  — players join via the Steam relay using GAME_ID (a join code).
//            No Service / LoadBalancer / port. This is the known-good mode
//            (matches the live escaping/core-keeper-dedicated deploy).
//   direct — also expose a LoadBalancer port for direct/LAN connect.
//            Provided as an option; validate on a dev build before relying
//            on it (the image's direct-port behaviour varies by version).
export const defaultCorekeeperForm = {
  namespace: 'gamectl-corekeeper',
  serverName: 'corekeeper',
  image: 'ghcr.io/gamectl-hq/corekeeper-kube:latest',
  storageMode: 'remote', // 'remote' (NFS) | 'local' (hostPath)
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/corekeeper',
  dataStorage: '20Gi',
  localDataPath: '/mnt/1TBSSD/corekeeper',
  worldName: 'Core Keeper',
  maxPlayers: 8,
  connectMode: 'relay', // 'relay' (GAME_ID) | 'direct' (LoadBalancer port)
  gameId: 'ChangeMe12345', // REQUIRED relay join code (12+ chars; ChangeMe12345 = 13)
  serverPort: 27015, // used only in direct mode
  lbIP: '10.0.0.191',
}

export function buildCorekeeperYaml(f = defaultCorekeeperForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'corekeeper'
  const labels = { app: name, game: 'corekeeper', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const isLocal = (f.storageMode || 'remote') === 'local'
  const direct = (f.connectMode || 'relay') === 'direct'

  // Relay mode joins via the Steam relay using GAME_ID. Core Keeper join
  // codes are 12 or more characters — anything shorter won't connect, so
  // fail the build early with a clear message instead of deploying a
  // server nobody can reach.
  if (!direct) {
    const code = String(f.gameId || '').trim()
    if (code.length < 12) {
      throw new Error(
        `Core Keeper Game ID (relay join code) must be at least 12 characters — ` +
        `got ${code.length}. Players connect with this code; a too-short code won't connect. ` +
        `Use a 12+ character code, or switch Connect mode to "direct".`
      )
    }
  }

  const mlbAnno = (direct && f.metallbPool) ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels }, spec: isLocal ? {
    capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: 'manual',
    persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: f.localDataPath || '/mnt/1TBSSD/corekeeper', type: 'DirectoryOrCreate' }
  } : {
    capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteMany'], storageClassName: 'nfs-static',
    persistentVolumeReclaimPolicy: 'Retain', nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/corekeeper' }
  } })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], storageClassName: isLocal ? 'manual' : ('nfs-static'), resources: { requests: { storage: f.dataStorage || '20Gi' } }, volumeName: pvName
  } })

  const port = Number(f.serverPort || 27015)
  const env = [
    { name: 'WORLD_NAME', value: f.worldName || 'Core Keeper' },
    { name: 'MAX_PLAYERS', value: String(f.maxPlayers || 8) },
    { name: 'UPDATE_ON_START', value: 'false' }, // GameCTL auto-update toggle target
    { name: 'GAME_ID', value: String(f.gameId || '') },
  ]
  if (direct) env.push({ name: 'SERVER_PORT', value: String(port) })

  docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    // Recreate, not RollingUpdate: a rolling update schedules the replacement
    // pod while the old one still holds its CPU/RAM and its volume, so a
    // Restart deadlocks on a cluster with no spare headroom — and two
    // servers would briefly write the same save data.
    strategy: { type: 'Recreate' },
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      containers: [ { name: 'server', image: f.image || 'ghcr.io/gamectl-hq/corekeeper-kube:latest', imagePullPolicy: 'Always', env,
        ...(direct ? { ports: [
          { name: 'game-udp', containerPort: port, protocol: 'UDP' },
          { name: 'game-tcp', containerPort: port, protocol: 'TCP' },
        ] } : {}),
        volumeMounts: [ { name: 'data', mountPath: '/home/steam/core-keeper-data' } ],
        resources: { requests: { cpu: f.cpuRequest || '500m', memory: f.memRequest || '1Gi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '4Gi' } },
      } ],
      volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ]
    } }
  } })

  // Only relay mode needs no Service. Direct mode publishes a LoadBalancer.
  if (direct) {
    docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
      type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Local', selector: labels, ports: [
        { name: 'game-udp', port, targetPort: port, protocol: 'UDP' },
        { name: 'game-tcp', port, targetPort: port, protocol: 'TCP' },
      ]
    } })
  }

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
