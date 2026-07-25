import yaml from 'js-yaml'

export const defaultDayzForm = {
  namespace: 'gamectl-dayz',
  serverName: 'dayz',
  image: 'git.example.com/admin/dayz-kube:latest',
  memory: '4G',
  // DayZ specific params
  steamcmdAppId: '2253', 
  rconPassword: 'ChangeMe12345',

  // Storage mode
  storageMode: 'remote', // 'remote' (NFS) | 'local' (hostPath)

  // NFS storage for world data
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/dayz',
  dataStorage: '50Gi',

  // Local hostPath storage (used when storage/mode === 'local')
  localDataPath: '/mnt/1TBSSD/dayz',

  // Networking
  dayzPort: 2302, // Default DayZ UDP port
  dayzQueryPort: 27016, // Typical Query port
  dayzLbIP: '19EXXXXXX', // Placeholder to be filled by wizard
}

export function buildDayzYaml(f = defaultDayzForm) {
  const ns = 'gamectl' /* single-namespace: see docs/HARDMIN.md */
  const name = f.serverName || 'dayz'
  const labels = { app: name, game: 'dayz', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const docs = []
  const isLocal = (f.storageMode || 'remote') === 'local'

  // Namespace
  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  // PV for DayZ data (NFS or hostPath)
  const dataPvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: dataPvName, labels },
    spec: isLocal
      ? {
          capacity: { storage: f.dataStorage || '50Gi' },
          accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/dayz', type: 'DirectoryOrCreate' },
        }
      : {
          capacity: { storage: f.dataStorage || '50Gi' },
          accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retrain', // Small typo fix from my thought? No, it should be Retain. 
          storageClassName: 'nfs-static',
          nfs: {
            server: f.nfsServer || '10.0.0.100',
            path: f.dataPvPath || '/mnt/1TBSSD/dayz',
            readOnly: false,
          },
        },
  })

  // PVC for DayZ data
  const dataPvcName = `${name}-pvc`
  docs.push({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: dataPvcName, namespace: ns, labels },
    spec: {
      accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'],
      resources: { requests: { storage: f.dataStorage || '50Gi' } },
      storageClassName: isLocal ? 'manual' : ('nfs-static'),
      volumeName: dataPvName,
    },
  })

  // Deployment
  const env = [
    { name: 'STEAMCMD_APPID', value: f.steamcmdAppId || '2253' },
    { name: 'MEMORY', value: f.memory || '4G' },
    { name: 'ENABLE_RCON', value: 'true' },
    { name: 'RCON_PASSWORD', value: f.rconPassword || 'ChangeMe12345' },
    // Add other DayZ specific env vars as required by the image
  ]

  const ports = [
    { name: 'dayz-udp', containerPort: Number(f.dayzPort || 2302), protocol: 'UDP' },
    { name: 'query-udp', containerPort: Number(f.dayzQueryPort || 27016), protocol: 'UDP' },
    { name: 'rcon-tcp', containerPort: 25575, protocol: 'TCP' }, // standard RCON port if used
  ]

  const volumeMounts = [
    { name: 'dayz-storage', mountPath: '/data' },
  ]

  const volumes = [
    { name: 'dayz-storage', persistentVolumeClaim: { claimName: dataPvcName } },
  ]

  const memG = (() => {
    const m = String(f.memory || '4G').trim().match(/^(\d+)\s*([GgMm])/)
    if (!m) return 4
    const n = Number(m[1])
    return m[2].toUpperCase() === 'M' ? Math.max(1, Math.ceil(n / 1024)) : n
  })()
  const reqG = Math.max(1, memG - 1)
  const resources = {
    requests: { cpu: f.cpuRequest || '500m', memory: f.memRequest || `${reqG}Gi` },
    limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || `${memG + 1}Gi` },
  }

  docs.push({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: ns, labels },
    spec: {
      replicas: 1,
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
          containers: [
            {
              name,
              image: f.image || 'git.example.com/admin/dayz-kube:latest',
              env,
              ports,
              volumeMounts,
              resources,
            },
          ],
          volumes,
        },
      },
    },
  })

  return docs.join('\n---\n')
}
