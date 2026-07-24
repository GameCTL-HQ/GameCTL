import yaml from 'js-yaml'

// BeamMP — GameCTL's own from-scratch image around the official open-source
// BeamMP server binary. Requires a free AuthKey (keymaster.beammp.com);
// ServerConfig.toml is generated from env; Resources/ (mods) persists on
// the volume.
export const defaultBeammpForm = {
  namespace: 'gamectl-beammp',
  serverName: 'beammp',
  image: 'ghcr.io/gamectl-hq/beammp-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/beammp',
  dataStorage: '20Gi',
  localDataPath: '/mnt/1TBSSD/GameCTL/beammp',
  hostname: 'GameCTL BeamMP',
  authKey: '',
  maxPlayers: 8,
  maxCars: 2,
  map: '/levels/gridmap_v2/info.json',
  privateServer: true,
  description: 'BeamMP on GameCTL',
  gamePort: 30814,

  lbIP: '',
  externalTrafficPolicy: 'Cluster',
}

export function buildBeammpYaml(f = defaultBeammpForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'beammp'
  const labels = { app: name, game: 'beammp', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.gamePort || 30814)

  const docs = []
  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume',
    metadata: { name: pvName, labels },
    spec: isLocal
      ? { capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/GameCTL/beammp', type: 'DirectoryOrCreate' } }
      : { capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'nfs-static',
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/beammp' } },
  })

  const pvcName = `${name}-pvc`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: pvcName, namespace: ns, labels },
    spec: { accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'],
      storageClassName: isLocal ? 'manual' : 'nfs-static',
      resources: { requests: { storage: f.dataStorage || '20Gi' } }, volumeName: pvName },
  })

  const wantUpdate = f.updateOnStart === true || String(f.updateOnStart) === 'true'
  const env = [
    { name: 'SERVER_NAME', value: f.hostname || 'GameCTL BeamMP' },
    { name: 'BEAMMP_AUTH_KEY', value: f.authKey || '' },
    { name: 'GAME_PORT', value: String(port) },
    { name: 'MAX_PLAYERS', value: String(f.maxPlayers ?? 8) },
    { name: 'MAX_CARS', value: String(f.maxCars ?? 2) },
    { name: 'MAP', value: f.map || '/levels/gridmap_v2/info.json' },
    { name: 'PRIVATE', value: String(f.privateServer ?? true) },
    { name: 'DESCRIPTION', value: f.description || 'BeamMP on GameCTL' },
  ]

  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment',
    metadata: { name, namespace: ns, labels },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: {
        metadata: {
          labels,
          annotations: wantUpdate ? { 'gamectl.io/steamcmd-update': new Date().toISOString() } : {},
        },
        spec: {
          terminationGracePeriodSeconds: 60,
          securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
          containers: [{
            name: 'server',
            image: f.image || 'ghcr.io/gamectl-hq/beammp-kube:latest',
            imagePullPolicy: 'Always',
            env,
            ports: [
        { name: 'game-tcp', containerPort: port, protocol: 'TCP' },
        { name: 'game-udp', containerPort: port, protocol: 'UDP' }
            ],
            volumeMounts: [{ name: 'data', mountPath: '/data' }],
            resources: {
              requests: { cpu: f.cpuRequest || '250m', memory: f.memRequest || '512Mi' },
              limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '2Gi' },
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
      externalTrafficPolicy: f.externalTrafficPolicy || 'Cluster',
      selector: labels,
      ports: [
        { name: 'game-tcp', port, targetPort: port, protocol: 'TCP' },
        { name: 'game-udp', port, targetPort: port, protocol: 'UDP' },
      ],
    },
  })

  return docs.map((d) => yaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n')
}
