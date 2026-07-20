import yaml from 'js-yaml'

// Wreckfest (1) — GameCTL's own from-scratch image. The Windows-only server
// (Steam app 361580, anonymous) runs under WineHQ stable + xvfb; ~6GB
// installs to the volume on first boot. server_config.cfg is managed from
// env (based on the shipped example) each boot.
export const defaultWreckfestForm = {
  namespace: 'gamectl-wreckfest',
  serverName: 'wreckfest',
  image: 'ghcr.io/gamectl-hq/wreckfest-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/wreckfest',
  dataStorage: '30Gi',
  localDataPath: '/mnt/1TBSSD/GameCTL/wreckfest',
  hostname: 'GameCTL Wreckfest',
  welcomeMessage: 'Welcome to my server!',
  serverPassword: '',
  maxPlayers: 24,
  extraCfg: '',
  gamePort: 33540,
  queryPort: 27016,
  steamPort: 27015,
  updateOnStart: false,

  lbIP: '',
  externalTrafficPolicy: 'Cluster',
}

export function buildWreckfestYaml(f = defaultWreckfestForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'wreckfest'
  const labels = { app: name, game: 'wreckfest', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.gamePort || 33540)

  const docs = []
  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume',
    metadata: { name: pvName, labels },
    spec: isLocal
      ? { capacity: { storage: f.dataStorage || '30Gi' }, accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/GameCTL/wreckfest', type: 'DirectoryOrCreate' } }
      : { capacity: { storage: f.dataStorage || '30Gi' }, accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'nfs-static',
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/wreckfest' } },
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
    { name: 'SERVER_NAME', value: f.hostname || 'GameCTL Wreckfest' },
    { name: 'WELCOME_MESSAGE', value: f.welcomeMessage || 'Welcome to my server!' },
    { name: 'SERVER_PASSWORD', value: f.serverPassword || '' },
    { name: 'GAME_PORT', value: String(port) },
    { name: 'QUERY_PORT', value: String(f.queryPort || 27016) },
    { name: 'STEAM_PORT', value: String(f.steamPort || 27015) },
    { name: 'MAX_PLAYERS', value: String(f.maxPlayers ?? 24) },
    { name: 'EXTRA_CFG', value: f.extraCfg || '' },
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
            image: f.image || 'ghcr.io/gamectl-hq/wreckfest-kube:latest',
            imagePullPolicy: 'Always',
            env,
            ports: [
              { name: 'game-udp', containerPort: port, protocol: 'UDP' },
              { name: 'query-udp', containerPort: Number(f.queryPort || 27016), protocol: 'UDP' },
              { name: 'steam-udp', containerPort: Number(f.steamPort || 27015), protocol: 'UDP' },
            ],
            volumeMounts: [{ name: 'data', mountPath: '/data' }],
            resources: {
              requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '2Gi' },
              limits: { cpu: f.cpuLimit || '4', memory: f.memLimit || '6Gi' },
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
        { name: 'steam-udp', port: Number(f.steamPort || 27015), targetPort: Number(f.steamPort || 27015), protocol: 'UDP' },
      ],
    },
  })

  return docs.map((d) => yaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n')
}
