import yaml from 'js-yaml'

// Necesse — tiny Java server, no Steam at all. Default UDP port 14159.
// Image default is a community one; validate on a dev build (env/mount
// path can vary by image) — the wizard's image field is editable.
export const defaultNecesseForm = {
  namespace: 'gamectl-necesse',
  serverName: 'necesse',
  image: 'ghcr.io/gamectl-hq/necesse-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/necesse',
  dataStorage: '5Gi',
  localDataPath: '/mnt/1TBSSD/necesse',
  worldName: 'GameCTL',
  maxPlayers: 10,
  serverPass: '',
  serverPort: 14159,
  lbIP: '10.0.0.194',
}

export function buildNecesseYaml(f = defaultNecesseForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'necesse'
  const labels = { app: name, game: 'necesse', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.serverPort || 14159)
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels }, spec: isLocal ? {
    capacity: { storage: f.dataStorage || '5Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: 'manual',
    persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: f.localDataPath || '/mnt/1TBSSD/necesse', type: 'DirectoryOrCreate' }
  } : {
    capacity: { storage: f.dataStorage || '5Gi' }, accessModes: ['ReadWriteMany'], storageClassName: 'nfs-static',
    persistentVolumeReclaimPolicy: 'Retain', nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/necesse' }
  } })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], storageClassName: isLocal ? 'manual' : ('nfs-static'), resources: { requests: { storage: f.dataStorage || '5Gi' } }, volumeName: pvName
  } })

  // Env keys match the image entrypoint (WORLD/SLOTS/PASSWORD/PORT).
  //
  // PORT must be passed. The old comment here claimed the image had no port env
  // and that serverPort "only drives the Service mapping" -- that was wrong; the
  // entrypoint has always honoured `port="${PORT:-14159}"` and passes it to
  // Server.jar as -port. Leaving it unset meant the game stayed pinned to 14159
  // while the Service (and ProxyCTL's DNAT, which preserves the destination
  // port) followed whatever the wizard allocated. That only looks fine while
  // 14159 happens to be free; the moment the wizard reassigns the port because
  // something else claimed it, the Service moves, the game does not, and the
  // server is silently unreachable with no error anywhere. Barotrauma shipped
  // exactly this bug and sat unreachable behind a 27022 forward while binding
  // 27015.
  const env = [
    { name: 'WORLD', value: f.worldName || 'GameCTL' },
    { name: 'SLOTS', value: String(f.maxPlayers || 10) },
    { name: 'PORT', value: String(port) },
    { name: 'UPDATE_ON_START', value: 'false' }, // GameCTL auto-update toggle target
  ]
  if (f.serverPass) env.push({ name: 'PASSWORD', value: String(f.serverPass) })

  docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    // Recreate, not RollingUpdate: a rolling update schedules the replacement
    // pod while the old one still holds its CPU/RAM and its volume, so a
    // Restart deadlocks on a cluster with no spare headroom — and two
    // servers would briefly write the same save data.
    strategy: { type: 'Recreate' },
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      containers: [ { name: 'server', image: f.image || 'ghcr.io/gamectl-hq/necesse-kube:latest', imagePullPolicy: 'Always', env,
        ports: [ { name: 'game-udp', containerPort: port, protocol: 'UDP' } ],
        volumeMounts: [ { name: 'data', mountPath: '/necesse/saves' } ],
        resources: { requests: { cpu: f.cpuRequest || '250m', memory: f.memRequest || '512Mi' }, limits: { cpu: f.cpuLimit || '1', memory: f.memLimit || '1Gi' } },
      } ],
      volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ]
    } }
  } })

  docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Local', selector: labels, ports: [
      { name: 'game-udp', port, targetPort: port, protocol: 'UDP' },
    ]
  } })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
