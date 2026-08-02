import yaml from 'js-yaml'

// Left 4 Dead — GameCTL's own from-scratch srcds image (Steam app 222840,
// anonymous). Fleet NFS-install model: ~8GB installs to the volume on first
// boot; server.cfg is generated from env each boot (GAMECTL_MANAGE_CONFIG=1).
export const defaultLeftfordeadForm = {
  namespace: 'gamectl-leftfordead',
  serverName: 'leftfordead',
  image: 'ghcr.io/gamectl-hq/left4dead-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/leftfordead',
  dataStorage: '20Gi',
  localDataPath: '/mnt/1TBSSD/GameCTL/leftfordead',
  hostname: 'GameCTL L4D1',
  serverPassword: '',
  rconPassword: '',
  maxPlayers: 8,
  startMap: 'l4d_hospital01_apartment',
  gamePort: 27015,
  updateOnStart: false,

  lbIP: '',
  externalTrafficPolicy: 'Cluster',
}

export function buildLeftfordeadYaml(f = defaultLeftfordeadForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'leftfordead'
  const labels = { app: name, game: 'leftfordead', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
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
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/GameCTL/leftfordead', type: 'DirectoryOrCreate' } }
      : { capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'nfs-static',
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/leftfordead' } },
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
    { name: 'SERVER_NAME', value: f.hostname || 'GameCTL L4D1' },
    { name: 'SERVER_PASSWORD', value: f.serverPassword || '' },
    { name: 'RCON_PASSWORD', value: f.rconPassword || '' },
    { name: 'GAME_PORT', value: String(port) },
    { name: 'MAX_PLAYERS', value: String(f.maxPlayers ?? 8) },
    { name: 'START_MAP', value: f.startMap || 'l4d_hospital01_apartment' },
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
            image: f.image || 'ghcr.io/gamectl-hq/left4dead-kube:latest',
            imagePullPolicy: 'Always',
            env,
            ports: [
        { name: 'game-udp', containerPort: port, protocol: 'UDP' },
        { name: 'game-tcp', containerPort: port, protocol: 'TCP' }
            ],
            volumeMounts: [{ name: 'data', mountPath: '/data' }],
            resources: {
              requests: { cpu: f.cpuRequest || '500m', memory: f.memRequest || '1Gi' },
              limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '4Gi' },
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
        { name: 'game-tcp', port, targetPort: port, protocol: 'TCP' },
      ],
    },
  })

  return docs.map((d) => yaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n')
}
