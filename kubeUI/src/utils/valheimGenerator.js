import yaml from 'js-yaml'

export const defaultValheimForm = {
  namespace: 'gamectl-valheim',
  serverName: 'valheim',
  image: 'lloesche/valheim-server:latest',
  // Storage mode
  storageMode: 'remote', // 'remote' (NFS) | 'local' (hostPath)
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/valheim',
  dataStorage: '20Gi',
  // Local storage path
  localDataPath: '/mnt/1TBSSD/valheim',
  serverNameDisplay: 'Valheim Server',
  worldName: 'Dedicated',
  serverPass: 'ChangeMe12345', // Valheim refuses to start with <5 chars; change this
  serverPublic: 1,
  serverPort: 2456,
  lbIP: '10.0.0.187',
}

export function buildValheimYaml(f = defaultValheimForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'valheim'
  const labels = { app: name, game: 'valheim', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels },
    spec: isLocal
      ? {
          capacity: { storage: f.dataStorage || '20Gi' },
          accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/valheim', type: 'DirectoryOrCreate' },
        }
      : {
          capacity: { storage: f.dataStorage || '20Gi' },
          accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'nfs-static',
          mountOptions: ['nfsvers=4.2'],
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/valheim' },
        },
  })

  const pvcName = `${name}-pvc`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels },
    spec: {
      accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'],
      resources: { requests: { storage: f.dataStorage || '20Gi' } },
      storageClassName: isLocal ? 'manual' : ('nfs-static'),
      volumeName: pvName,
    },
  })

  const env = [
    { name: 'SERVER_NAME', value: f.serverNameDisplay || 'Valheim Server' },
    { name: 'WORLD_NAME', value: f.worldName || 'Dedicated' },
    // Valheim refuses to start (world generator never inits) if the
    // password is empty or <5 chars — fall back to a safe default.
    { name: 'SERVER_PASS', value: (f.serverPass && String(f.serverPass).length >= 5) ? f.serverPass : 'ChangeMe12345' },
    { name: 'SERVER_PUBLIC', value: String(f.serverPublic ?? 1) },
    { name: 'SERVER_PORT', value: String(f.serverPort || 2456) },
  ]

  const base = Number(f.serverPort || 2456)

  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno },
    spec: {
      replicas: 1,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          securityContext: { fsGroup: 1000 },
          containers: [
            {
              name: 'server', image: f.image || 'lloesche/valheim-server:latest', imagePullPolicy: 'Always', env,
              ports: [
                { name: 'vh-udp-0', containerPort: base, protocol: 'UDP' },
                { name: 'vh-udp-1', containerPort: base + 1, protocol: 'UDP' },
                { name: 'vh-udp-2', containerPort: base + 2, protocol: 'UDP' },
              ],
              volumeMounts: [ { name: 'data', mountPath: '/config' } ],
              resources: { requests: { cpu: f.cpuRequest || '500m', memory: f.memRequest || '2Gi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '5Gi' } },
            },
          ],
          volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ],
        },
      },
    },
  })

  docs.push({
    apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno },
    spec: {
      type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Local', selector: labels,
      ports: [
        { name: 'vh-udp-0', port: base, targetPort: base, protocol: 'UDP' },
        { name: 'vh-udp-1', port: base + 1, targetPort: base + 1, protocol: 'UDP' },
        { name: 'vh-udp-2', port: base + 2, targetPort: base + 2, protocol: 'UDP' },
      ],
    },
  })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
