import yaml from 'js-yaml'

export const defaultQuake3Form = {
  namespace: 'gamectl-quake3',
  serverName: 'quake3',
  image: 'ioquake3:latest',

  // Storage mode
  storageMode: 'remote', // 'remote' (NFS) | 'local' (hostPath)
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/quake3',
  dataStorage: '10Gi',
  localDataPath: '/mnt/1TBSSD/quake3',

  // Networking
  serverPort: 27960, // UDP
  lbIP: '',
}

export function buildQuake3Yaml(f = defaultQuake3Form) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'quake3'
  const labels = { app: name, game: 'quake3', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'

  const docs = []

  // Namespace
  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  // PV
  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels },
    spec: isLocal ? {
      capacity: { storage: f.dataStorage || '10Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: 'manual',
      persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: f.localDataPath || '/mnt/1TBSSD/quake3', type: 'DirectoryOrCreate' }
    } : {
      capacity: { storage: f.dataStorage || '10Gi' }, accessModes: ['ReadWriteMany'], storageClassName: 'nfs-static',
      persistentVolumeReclaimPolicy: 'Retain', nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/quake3' }
    }
  })

  // PVC
  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], storageClassName: isLocal ? 'manual' : ('nfs-static'),
    resources: { requests: { storage: f.dataStorage || '10Gi' } }, volumeName: pvName
  } })

  // Deployment (generic ioquake3 server container)
  docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      containers: [ {
        name: 'server', image: f.image || 'ioquake3:latest', imagePullPolicy: 'Always',
        ports: [ { name: 'game-udp', containerPort: Number(f.serverPort || 27960), protocol: 'UDP' } ],
        volumeMounts: [ { name: 'data', mountPath: '/data' } ],
        resources: { requests: { cpu: f.cpuRequest || '250m', memory: f.memRequest || '256Mi' }, limits: { cpu: f.cpuLimit || '1', memory: f.memLimit || '512Mi' } },
      } ],
      volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ]
    } }
  } })

  // Service
  docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Local', selector: labels,
    ports: [ { name: 'game-udp', port: Number(f.serverPort || 27960), targetPort: Number(f.serverPort || 27960), protocol: 'UDP' } ]
  } })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
