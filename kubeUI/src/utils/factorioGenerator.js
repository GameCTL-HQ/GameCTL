import yaml from 'js-yaml'

export const defaultFactorioForm = {
  namespace: 'gamectl-factorio',
  serverName: 'factorio',
  image: 'ghcr.io/gamectl-hq/factorio-kube:2.0.77',
  // Storage mode
  storageMode: 'remote', // 'remote' (NFS) | 'local' (hostPath)
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/factorio',
  dataStorage: '20Gi',
  localDataPath: '/mnt/1TBSSD/factorio',
  gamePort: 34197, // UDP
  queryPort: 27015, // UDP (steam)
  rconPort: 27015, // TCP — Factorio image default RCON port (--rcon-port)
  rconPassword: 'ChangeMe12345', // Source-RCON for the manage-screen console
  lbIP: '10.0.0.190',
}

export function buildFactorioYaml(f = defaultFactorioForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'factorio'
  const labels = { app: name, game: 'factorio', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels }, spec: isLocal ? {
    capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: 'manual',
    persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: f.localDataPath || '/mnt/1TBSSD/factorio', type: 'DirectoryOrCreate' }
  } : {
    capacity: { storage: f.dataStorage || '20Gi' }, accessModes: ['ReadWriteMany'], storageClassName: 'nfs-static',
    persistentVolumeReclaimPolicy: 'Retain', nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/factorio' }
  } })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], storageClassName: isLocal ? 'manual' : ('nfs-static'), resources: { requests: { storage: f.dataStorage || '20Gi' } }, volumeName: pvName
  } })

  // Source-RCON so the GameCTL manage screen can run console commands.
  // NOTE: the factoriotools/factorio image does NOT honor an RCON_PASSWORD
  // env var — its entrypoint always enables RCON and reads the password
  // from $CONFIG/rconpw (/factorio/config/rconpw), generating a random one
  // if that file is absent. So we (a) still set RCON_PASSWORD in the
  // Deployment env because that is what GameCTL's backend reads to know the
  // password and to light up the generic console (resolveRCON /
  // rconAvailable look for a non-empty RCON_PASSWORD env value), and (b)
  // add an init container that writes that same password into
  // /factorio/config/rconpw before the server starts, so the image's RCON
  // actually uses it. RCON_PORT *is* honored by the entrypoint
  // (--rcon-port). Keep the rcon port OFF any public tunnel — it's reached
  // internally via the Service ClusterIP only (cs2 brute-force lesson).
  const rconPort = Number(f.rconPort || 27015)
  const rconPw = f.rconPassword || 'ChangeMe12345'
  const env = [
    { name: 'RCON_PORT', value: String(rconPort) },
    { name: 'RCON_PASSWORD', value: rconPw },
  ]

  docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      // Seed the RCON password file the image actually reads. Runs every
      // (re)start and overwrites so the wizard value stays authoritative.
      initContainers: [ { name: 'rcon-seed', image: f.image || 'ghcr.io/gamectl-hq/factorio-kube:2.0.77', imagePullPolicy: 'Always',
        command: ['sh', '-c', 'mkdir -p /factorio/config && printf %s "$RCON_PASSWORD" > /factorio/config/rconpw'],
        env: [ { name: 'RCON_PASSWORD', value: rconPw } ],
        volumeMounts: [ { name: 'data', mountPath: '/factorio' } ],
      } ],
      containers: [ { name: 'server', image: f.image || 'ghcr.io/gamectl-hq/factorio-kube:2.0.77', imagePullPolicy: 'Always', env,
        ports: [
          { name: 'game-udp', containerPort: Number(f.gamePort || 34197), protocol: 'UDP' },
          { name: 'query-udp', containerPort: Number(f.queryPort || 27015), protocol: 'UDP' },
          // RCON for the GameCTL console — internal-only. Do NOT forward
          // this port on any public tunnel/ingress (a public RCON port
          // gets brute-force-scanned; see the cs2 fix).
          { name: 'rcon', containerPort: rconPort, protocol: 'TCP' },
        ],
        volumeMounts: [ { name: 'data', mountPath: '/factorio' } ],
        resources: { requests: { cpu: f.cpuRequest || '500m', memory: f.memRequest || '1Gi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '2Gi' } },
      } ],
      volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ]
    } }
  } })

  docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Local', selector: labels, ports: [
      { name: 'game-udp', port: Number(f.gamePort || 34197), targetPort: Number(f.gamePort || 34197), protocol: 'UDP' },
      { name: 'query-udp', port: Number(f.queryPort || 27015), targetPort: Number(f.queryPort || 27015), protocol: 'UDP' },
      // RCON for the GameCTL console. Reached internally via the Service
      // ClusterIP — do NOT forward this port on any public tunnel/ingress
      // (a public RCON port gets brute-force-scanned; see the cs2 fix).
      // Distinct protocol (TCP) from query-udp so 27015 can coexist.
      { name: 'rcon', port: rconPort, targetPort: rconPort, protocol: 'TCP' }
    ]
  } })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
