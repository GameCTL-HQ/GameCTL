import yaml from 'js-yaml'

// Terraria via TShock (mark2dot0/tshock, verified). Vanilla-compatible
// + REST/plugins). Direct connect on 7777/TCP through a LoadBalancer; the
// TShock REST API (7878/TCP) is exposed too but stays cluster-internal
// unless you add it to the Service. First boot auto-creates the world from
// the env below — validate on a dev build before relying on it.
export const defaultTerrariaForm = {
  namespace: 'gamectl-terraria',
  serverName: 'terraria',
  image: 'mark2dot0/tshock:latest',
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

  // The mark2dot0/tshock entrypoint ignores env vars — it execs
  // `TerrariaServer.exe -configpath /config -worldpath /world ... "$@"`.
  // With no args the server drops into the interactive world picker and
  // spins forever on EOF. We must pass real Terraria server CLI args so
  // it auto-creates the world on first boot and loads it thereafter.
  const worldName = f.worldName || 'GameCTL'
  const args = [
    '-world', `/world/${worldName}.wld`,
    '-autocreate', String(f.worldSize || 3),
    '-worldname', worldName,
    '-difficulty', String(f.difficulty ?? 0),
    '-maxplayers', String(f.maxPlayers || 8),
    '-port', String(port),
  ]
  if (f.serverPass) args.push('-password', String(f.serverPass))

  docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      containers: [ { name: 'server', image: f.image || 'mark2dot0/tshock:latest', imagePullPolicy: 'Always', args,
        ports: [
          { name: 'game-tcp', containerPort: port, protocol: 'TCP' },
          { name: 'rest-tcp', containerPort: 7878, protocol: 'TCP' },
        ],
        volumeMounts: [ { name: 'data', mountPath: '/world' } ],
        resources: { requests: { cpu: f.cpuRequest || '250m', memory: f.memRequest || '512Mi' }, limits: { cpu: f.cpuLimit || '1', memory: f.memLimit || '2Gi' } },
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
