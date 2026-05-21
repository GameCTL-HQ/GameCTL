import yaml from 'js-yaml'

// Vanilla Terraria dedicated server via ryshe/terraria (actively
// maintained, tracks current retail Terraria). Direct connect on 7777/TCP
// through a LoadBalancer. First boot auto-creates the world from the
// args below; subsequent boots load the existing .wld at the same path.
//
// We deliberately use vanilla (not TShock) so retail clients can join
// without any account/login dance. To switch to TShock later, pick a
// `ryshe/terraria:tshock-*` tag — args/paths are identical.
export const defaultTerrariaForm = {
  namespace: 'gamectl-terraria',
  serverName: 'terraria',
  image: 'ryshe/terraria:vanilla-1.4.5.6',
  storageMode: 'remote', // 'remote' (NFS) | 'local' (hostPath)
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/terraria',
  dataStorage: '10Gi',
  localDataPath: '/mnt/1TBSSD/terraria',
  worldName: 'GameCTL',
  worldSize: 3, // 1 small | 2 medium | 3 large
  difficulty: 0, // 0 classic | 1 expert | 2 master | 3 journey
  maxPlayers: 8,
  serverPass: '',
  serverPort: 7777,
  lbIP: '10.0.0.192',
  cpuRequest: '500m',
  cpuLimit: '2',
  memRequest: '512Mi',
  memLimit: '2Gi',
}

export function buildTerrariaYaml(f = defaultTerrariaForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'terraria'
  const labels = { app: name, game: 'terraria', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.serverPort || 7777)
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels }, spec: isLocal ? {
    capacity: { storage: f.dataStorage || '10Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: 'manual',
    persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: f.localDataPath || '/mnt/1TBSSD/terraria', type: 'DirectoryOrCreate' }
  } : {
    capacity: { storage: f.dataStorage || '10Gi' }, accessModes: ['ReadWriteMany'], storageClassName: 'nfs-static',
    persistentVolumeReclaimPolicy: 'Retain', mountOptions: ['nfsvers=4.2'], nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/terraria' }
  } })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], storageClassName: isLocal ? 'manual' : ('nfs-static'), resources: { requests: { storage: f.dataStorage || '10Gi' } }, volumeName: pvName
  } })

  // ryshe/terraria mounts world data at /root/.local/share/Terraria/Worlds
  // (the path TerrariaServer.exe uses by default on Linux). With no args
  // the server drops into the interactive world picker and spins forever
  // on EOF, so we pass real Terraria server CLI args to auto-create on
  // first boot and load the same .wld thereafter.
  // The container also needs stdin+tty: TerrariaServer.exe spawns an
  // input-reader thread (startDedInputCallBack) that NPEs on a null
  // Console stream when stdin isn't attached.
  const worldsDir = '/root/.local/share/Terraria/Worlds'
  const worldName = f.worldName || 'GameCTL'
  const args = [
    '-world', `${worldsDir}/${worldName}.wld`,
    '-autocreate', String(f.worldSize || 3),
    '-worldname', worldName,
    '-difficulty', String(f.difficulty ?? 0),
    '-maxplayers', String(f.maxPlayers || 8),
    '-port', String(port),
  ]
  if (f.serverPass) args.push('-password', String(f.serverPass))

  docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      containers: [ { name: 'server', image: f.image || 'ryshe/terraria:vanilla-1.4.5.6', imagePullPolicy: 'Always', args,
        stdin: true, tty: true,
        ports: [
          { name: 'game-tcp', containerPort: port, protocol: 'TCP' },
        ],
        volumeMounts: [ { name: 'data', mountPath: worldsDir } ],
        resources: { requests: { cpu: f.cpuRequest || '500m', memory: f.memRequest || '512Mi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '2Gi' } },
      } ],
      volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ]
    } }
  } })

  docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Local', selector: labels, ports: [
      { name: 'game-tcp', port, targetPort: port, protocol: 'TCP' },
    ]
  } })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
