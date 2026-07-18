import yaml from 'js-yaml'

// Barotrauma — anonymous SteamCMD (no account), Linux-native dedicated
// server. Default UDP port 27015. Default image is a community one;
// validate on a dev build (the image field is editable).
export const defaultBarotraumaForm = {
  namespace: 'gamectl-barotrauma',
  serverName: 'barotrauma',
  image: 'ghcr.io/gamectl-hq/barotrauma-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/barotrauma',
  dataStorage: '10Gi',
  localDataPath: '/mnt/1TBSSD/barotrauma',
  serverNameDisplay: 'GameCTL Barotrauma',
  maxPlayers: 8,
  serverPass: '',
  serverPort: 27015,
  lbIP: '10.0.0.197',
}

export function buildBarotraumaYaml(f = defaultBarotraumaForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'barotrauma'
  const labels = { app: name, game: 'barotrauma', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.serverPort || 27015)
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels }, spec: isLocal ? {
    capacity: { storage: f.dataStorage || '10Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: 'manual',
    persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: f.localDataPath || '/mnt/1TBSSD/barotrauma', type: 'DirectoryOrCreate' }
  } : {
    capacity: { storage: f.dataStorage || '10Gi' }, accessModes: ['ReadWriteMany'], storageClassName: 'nfs-static',
    persistentVolumeReclaimPolicy: 'Retain', nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/barotrauma' }
  } })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], storageClassName: isLocal ? 'manual' : ('nfs-static'), resources: { requests: { storage: f.dataStorage || '10Gi' } }, volumeName: pvName
  } })

  // Env keys match the goldfish92 image (BAR_NAME / BAR_PASSWORD). It has
  // no port/maxplayers env — those live in serversettings inside the save
  // volume; serverPort only drives the Service mapping.
  const env = [
    { name: 'BAR_NAME', value: f.serverNameDisplay || 'GameCTL Barotrauma' },
    { name: 'UPDATE_ON_START', value: 'false' }, // GameCTL auto-update toggle target
  ]
  if (f.serverPass) env.push({ name: 'BAR_PASSWORD', value: String(f.serverPass) })

  docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      containers: [ { name: 'server', image: f.image || 'ghcr.io/gamectl-hq/barotrauma-kube:latest', imagePullPolicy: 'Always', env,
        ports: [ { name: 'game-udp', containerPort: port, protocol: 'UDP' } ],
        volumeMounts: [ { name: 'data', mountPath: '/home/steam/.local/share/Daedalic Entertainment GmbH/Barotrauma/Multiplayer' } ],
        resources: { requests: { cpu: f.cpuRequest || '500m', memory: f.memRequest || '1Gi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '2Gi' } },
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
