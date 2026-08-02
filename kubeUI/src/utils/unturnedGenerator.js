import yaml from 'js-yaml'

// Unturned — GameCTL's own from-scratch image (Steam app 1110390, anonymous).
// Fleet NFS-install model; the server identity (world+config) lives in
// Servers/$SERVER_ID on the volume; Commands.dat is generated from env.
export const defaultUnturnedForm = {
  namespace: 'gamectl-unturned',
  serverName: 'unturned',
  image: 'ghcr.io/gamectl-hq/unturned-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/unturned',
  dataStorage: '20Gi',
  localDataPath: '/mnt/1TBSSD/GameCTL/unturned',
  hostname: 'GameCTL Unturned',
  serverId: 'gamectl',
  serverPassword: '',
  ownerSteamId: '',
  gslt: '',
  maxPlayers: 24,
  map: 'PEI',
  perspective: 'Both',
  pvp: true,
  gamePort: 27015,
  updateOnStart: false,

  lbIP: '',
  externalTrafficPolicy: 'Cluster',
}

export function buildUnturnedYaml(f = defaultUnturnedForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'unturned'
  const labels = { app: name, game: 'unturned', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.gamePort || 27015)

  const docs = []
  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume',
    metadata: { name: pvName, labels },
    spec: isLocal
      ? { capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/GameCTL/unturned', type: 'DirectoryOrCreate' } }
      : { capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'nfs-static',
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/unturned' } },
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
    { name: 'SERVER_NAME', value: f.hostname || 'GameCTL Unturned' },
    { name: 'SERVER_ID', value: f.serverId || 'gamectl' },
    { name: 'GAME_PORT', value: String(port) },
    { name: 'MAX_PLAYERS', value: String(f.maxPlayers ?? 24) },
    { name: 'MAP', value: f.map || 'PEI' },
    { name: 'SERVER_PASSWORD', value: f.serverPassword || '' },
    { name: 'OWNER_STEAMID', value: f.ownerSteamId || '' },
    { name: 'GSLT', value: f.gslt || '' },
    { name: 'PERSPECTIVE', value: f.perspective || 'Both' },
    { name: 'PVP', value: String(f.pvp ?? true) },
    { name: 'UPDATE_ON_START', value: wantUpdate ? 'true' : 'false' },
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
            image: f.image || 'ghcr.io/gamectl-hq/unturned-kube:latest',
            imagePullPolicy: 'Always',
            env,
            ports: [
        { name: 'game-udp', containerPort: port, protocol: 'UDP' },
        { name: 'query-udp', containerPort: port + 1, protocol: 'UDP' }
            ],
            volumeMounts: [{ name: 'data', mountPath: '/data' }],
            resources: {
              requests: { cpu: f.cpuRequest || '500m', memory: f.memRequest || '2Gi' },
              limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '6Gi' },
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
        { name: 'game-udp', port, targetPort: port, protocol: 'UDP' },
        { name: 'query-udp', port: port + 1, targetPort: port + 1, protocol: 'UDP' },
      ],
    },
  })

  return docs.map((d) => yaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n')
}
