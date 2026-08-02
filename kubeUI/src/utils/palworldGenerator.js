import yaml from 'js-yaml'

// Palworld — anonymous SteamCMD (app 2394010), UE5 dedicated server.
// Game traffic is UDP 8211; the Steam query port (27015 by default) is a
// SEPARATE port and must be exposed too. Barotrauma in this same cluster is
// invisible in its server browser partly because only the game port was ever
// forwarded, so both are wired up here from the start.
export const defaultPalworldForm = {
  namespace: 'gamectl-palworld',
  serverName: 'palworld',
  image: 'ghcr.io/gamectl-hq/palworld-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1tbssdfast/GameCTL/palworld',
  dataStorage: '40Gi',
  localDataPath: '/mnt/1tbssdfast/GameCTL/palworld',
  serverNameDisplay: 'GameCTL Palworld',
  maxPlayers: 16,
  serverPass: '',
  adminPass: '',
  serverPort: 8211,
  queryPort: 27015,
  isPublic: false,
  lbIP: '10.0.0.198',
}

export function buildPalworldYaml(f = defaultPalworldForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'palworld'
  const labels = { app: name, game: 'palworld', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.serverPort || 8211)
  const queryPort = Number(f.queryPort || 27015)
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels }, spec: isLocal ? {
    capacity: { storage: f.dataStorage || '40Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: 'manual',
    persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: f.localDataPath || '/mnt/1tbssdfast/GameCTL/palworld', type: 'DirectoryOrCreate' }
  } : {
    capacity: { storage: f.dataStorage || '40Gi' }, accessModes: ['ReadWriteMany'], storageClassName: 'nfs-static',
    persistentVolumeReclaimPolicy: 'Retain', nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1tbssdfast/GameCTL/palworld' }
  } })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], storageClassName: isLocal ? 'manual' : 'nfs-static',
    resources: { requests: { storage: f.dataStorage || '40Gi' } }, volumeName: pvName
  } })

  // Every knob the image honours is passed as env. Nothing is hand-edited into
  // the ini on the volume: the entrypoint rewrites the env-managed keys on each
  // boot, so a manual edit would silently be overwritten anyway.
  const env = [
    { name: 'PAL_NAME', value: f.serverNameDisplay || 'GameCTL Palworld' },
    { name: 'PAL_PORT', value: String(port) },
    { name: 'PAL_QUERY_PORT', value: String(queryPort) },
    { name: 'PAL_MAX_PLAYERS', value: String(f.maxPlayers || 16) },
    { name: 'PAL_PUBLIC', value: String(!!f.isPublic) },
  ]
  if (f.serverPass) env.push({ name: 'PAL_PASSWORD', value: String(f.serverPass) })
  if (f.adminPass) env.push({ name: 'PAL_ADMIN_PASSWORD', value: String(f.adminPass) })

  docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    // Recreate, not RollingUpdate: two Palworld servers writing the same save
    // directory corrupts it, and the replacement pod would otherwise contend
    // for the volume and the node's RAM while the old one is still up.
    strategy: { type: 'Recreate' },
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      securityContext: { fsGroup: 1000 },
      containers: [ { name: 'server', image: f.image || 'ghcr.io/gamectl-hq/palworld-kube:latest', imagePullPolicy: 'Always', env,
        ports: [
          { name: 'game-udp', containerPort: port, protocol: 'UDP' },
          { name: 'query-udp', containerPort: queryPort, protocol: 'UDP' },
        ],
        volumeMounts: [ { name: 'data', mountPath: '/palworld' } ],
        // Palworld is genuinely memory-hungry (UE5 + per-player pal simulation);
        // 8Gi is a realistic floor for 16 players, not a pessimistic guess.
        resources: {
          requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '8Gi' },
          limits: { cpu: f.cpuLimit || '4', memory: f.memLimit || '12Gi' },
        },
        // First boot downloads ~8GB, so give it room before liveness bites.
        startupProbe: { tcpSocket: { port: queryPort }, periodSeconds: 15, failureThreshold: 80 },
      } ],
      volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ]
    } }
  } })

  docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Local', selector: labels, ports: [
      { name: 'game-udp', port, targetPort: port, protocol: 'UDP' },
      // Without this the server can be connected to directly but never appears
      // in the in-game browser.
      { name: 'query-udp', port: queryPort, targetPort: queryPort, protocol: 'UDP' },
    ]
  } })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
