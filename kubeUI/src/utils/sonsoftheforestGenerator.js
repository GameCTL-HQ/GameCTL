import yaml from 'js-yaml'

// Sons of the Forest — GameCTL's own from-scratch image. The Windows-only
// server (Steam app 2465200, anonymous) runs under WineHQ stable + xvfb.
// dedicatedserver.cfg (JSON) is managed from env; the owners whitelist is
// pre-created so first boot passes the game's self-tests.
export const defaultSonsoftheforestForm = {
  namespace: 'gamectl-sonsoftheforest',
  serverName: 'sonsoftheforest',
  image: 'ghcr.io/gamectl-hq/sonsoftheforest-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/sonsoftheforest',
  dataStorage: '30Gi',
  localDataPath: '/mnt/1TBSSD/GameCTL/sonsoftheforest',
  hostname: 'GameCTL Sons of the Forest',
  serverPassword: '',
  maxPlayers: 8,
  saveSlot: 1,
  gameMode: 'Normal',
  ownerSteamIds: '',
  gamePort: 8766,
  queryPort: 27016,
  blobPort: 9700,
  updateOnStart: false,

  lbIP: '',
  externalTrafficPolicy: 'Cluster',
}

export function buildSonsoftheforestYaml(f = defaultSonsoftheforestForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'sonsoftheforest'
  const labels = { app: name, game: 'sonsoftheforest', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.gamePort || 8766)

  const docs = []
  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume',
    metadata: { name: pvName, labels },
    spec: isLocal
      ? { capacity: { storage: f.dataStorage || '30Gi' }, accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/GameCTL/sonsoftheforest', type: 'DirectoryOrCreate' } }
      : { capacity: { storage: f.dataStorage || '30Gi' }, accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'nfs-static',
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/sonsoftheforest' } },
  })

  const pvcName = `${name}-pvc`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: pvcName, namespace: ns, labels },
    spec: { accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'],
      storageClassName: isLocal ? 'manual' : 'nfs-static',
      resources: { requests: { storage: f.dataStorage || '30Gi' } }, volumeName: pvName },
  })

  const wantUpdate = f.updateOnStart === true || String(f.updateOnStart) === 'true'
  const env = [
    { name: 'SERVER_NAME', value: f.hostname || 'GameCTL Sons of the Forest' },
    { name: 'SERVER_PASSWORD', value: f.serverPassword || '' },
    { name: 'GAME_PORT', value: String(port) },
    { name: 'QUERY_PORT', value: String(f.queryPort || 27016) },
    { name: 'BLOB_PORT', value: String(f.blobPort || 9700) },
    { name: 'MAX_PLAYERS', value: String(f.maxPlayers ?? 8) },
    { name: 'SAVE_SLOT', value: String(f.saveSlot ?? 1) },
    { name: 'GAME_MODE', value: f.gameMode || 'Normal' },
    { name: 'OWNER_STEAMIDS', value: f.ownerSteamIds || '' },
    { name: 'GAMECTL_VALIDATE', value: wantUpdate ? '1' : '0' },
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
            image: f.image || 'ghcr.io/gamectl-hq/sonsoftheforest-kube:latest',
            imagePullPolicy: 'Always',
            env,
            ports: [
              { name: 'game-udp', containerPort: port, protocol: 'UDP' },
              { name: 'query-udp', containerPort: Number(f.queryPort || 27016), protocol: 'UDP' },
              { name: 'blob-udp', containerPort: Number(f.blobPort || 9700), protocol: 'UDP' },
            ],
            volumeMounts: [{ name: 'data', mountPath: '/data' }],
            resources: {
              requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '3Gi' },
              limits: { cpu: f.cpuLimit || '4', memory: f.memLimit || '8Gi' },
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
        { name: 'query-udp', port: Number(f.queryPort || 27016), targetPort: Number(f.queryPort || 27016), protocol: 'UDP' },
        { name: 'blob-udp', port: Number(f.blobPort || 9700), targetPort: Number(f.blobPort || 9700), protocol: 'UDP' },
      ],
    },
  })

  return docs.map((d) => yaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n')
}
