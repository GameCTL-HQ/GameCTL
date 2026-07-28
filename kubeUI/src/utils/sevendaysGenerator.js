import yaml from 'js-yaml'

export const default7d2dForm = {
  namespace: 'gamectl-sevendays',
  serverName: 'sevendays',
  image: 'ghcr.io/gamectl-hq/sevendays-kube:latest',
  // Storage mode
  storageMode: 'remote', // 'remote' (NFS) | 'local' (hostPath)
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/sevendays',
  dataStorage: '50Gi',
  localDataPath: '/mnt/1TBSSD/sevendays',
  serverPort: 26900,
  telnetPort: 8081,
  lbIP: '10.0.0.188',
}

export function build7d2dYaml(f = default7d2dForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || '7d2d'
  const labels = { app: name, game: '7d2d', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels },
    spec: isLocal
      ? {
          capacity: { storage: f.dataStorage || '50Gi' },
          accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/7d2d', type: 'DirectoryOrCreate' },
        }
      : {
          capacity: { storage: f.dataStorage || '50Gi' },
          accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'nfs-static',
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/7d2d' },
        },
  })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], resources: { requests: { storage: f.dataStorage || '50Gi' } }, storageClassName: isLocal ? 'manual' : ('nfs-static'), volumeName: pvName
  } })

  // 7d2d derives its Steam ports from ServerPort: the game listens on
  // ServerPort (TCP+UDP) and ServerPort+1 / ServerPort+2 (UDP) for the
  // Steam query + server-ID handshake. A custom query port is ignored by
  // modern builds, so all three UDP ports MUST be routed or clients fail
  // to join with "could not receive server ID".
  const base = Number(f.serverPort || 26900)
  const env = [
    { name: 'SERVER_PORT', value: String(base) },
    { name: 'TELNET_PORT', value: String(f.telnetPort || 8081) },
    // Recognized by GameCTL's per-instance auto-update toggle (see
    // instance_settings.go): boot never runs steamcmd unless this is true.
    { name: 'UPDATE_ON_START', value: 'false' },
  ]

  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno },
    spec: {
      replicas: 1, // Single-instance on one volume: stop old pod before starting new.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: { metadata: { labels }, spec: {
        containers: [ { name: 'server', image: f.image || 'ghcr.io/gamectl-hq/sevendays-kube:latest', imagePullPolicy: 'Always', env,
          ports: [
            { name: 'game-udp', containerPort: base, protocol: 'UDP' },
            { name: 'game-tcp', containerPort: base, protocol: 'TCP' },
            { name: 'steam-udp-1', containerPort: base + 1, protocol: 'UDP' },
            { name: 'steam-udp-2', containerPort: base + 2, protocol: 'UDP' },
            { name: 'telnet-tcp', containerPort: Number(f.telnetPort || 8081), protocol: 'TCP' },
          ],
          // didstopia/7dtd-server writes world saves / serveradmin.xml /
          // serverconfig.xml / profiles under $HOME/.local/share/7DaysToDie
          // (/app/.local/share/7DaysToDie), NOT the SteamCMD install dir.
          // Mounting /steamcmd/7dtd persisted only the (re-pulled) install
          // and lost the world every restart — same class as the cs2 bug.
          volumeMounts: [ { name: 'data', mountPath: '/app/.local/share/7DaysToDie' } ],
          resources: { requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '3Gi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '6Gi' } },
        } ],
        volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ]
      } }
    }
  })

  docs.push({
    apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno },
    spec: {
      type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Local', selector: labels,
      ports: [
        { name: 'game-udp', port: base, targetPort: base, protocol: 'UDP' },
        { name: 'game-tcp', port: base, targetPort: base, protocol: 'TCP' },
        { name: 'steam-udp-1', port: base + 1, targetPort: base + 1, protocol: 'UDP' },
        { name: 'steam-udp-2', port: base + 2, targetPort: base + 2, protocol: 'UDP' },
        { name: 'telnet-tcp', port: Number(f.telnetPort || 8081), targetPort: Number(f.telnetPort || 8081), protocol: 'TCP' },
      ]
    }
  })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
