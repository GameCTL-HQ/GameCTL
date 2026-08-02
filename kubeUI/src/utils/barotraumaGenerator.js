import yaml from 'js-yaml'

// Barotrauma — anonymous SteamCMD (no account), Linux-native dedicated
// server. Default UDP port 27015. Default image is a community one;
// validate on a dev build (the image field is editable).
export const defaultBarotraumaForm = {
  namespace: 'gamectl-barotrauma',
  serverName: 'barotrauma',
  image: 'ghcr.io/gamectl-hq/barotrauma-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/barotrauma',
  dataStorage: '10Gi',
  localDataPath: '/mnt/1TBSSD/barotrauma',
  serverNameDisplay: 'GameCTL Barotrauma',
  maxPlayers: 8,
  serverPass: '',
  serverPort: 27015,
  // Barotrauma's query port is separate from the game port and is what the
  // in-game browser probes. Forward only the game port and players can still
  // join by IP while the server never appears in any list.
  queryPort: 27016,
  isPublic: false,
  lbIP: '10.0.0.197',
}

export function buildBarotraumaYaml(f = defaultBarotraumaForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'barotrauma'
  const labels = { app: name, game: 'barotrauma', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.serverPort || 27015)
  const queryPort = Number(f.queryPort || 27016)
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels }, spec: isLocal ? {
    capacity: { storage: f.dataStorage || '10Gi' }, accessModes: ['ReadWriteOnce'], storageClassName: 'manual',
    persistentVolumeReclaimPolicy: 'Retain', hostPath: { path: f.localDataPath || '/mnt/1TBSSD/barotrauma', type: 'DirectoryOrCreate' }
  } : {
    capacity: { storage: f.dataStorage || '10Gi' }, accessModes: ['ReadWriteMany'], storageClassName: 'nfs-static',
    persistentVolumeReclaimPolicy: 'Retain', nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/barotrauma' }
  } })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], storageClassName: isLocal ? 'manual' : ('nfs-static'), resources: { requests: { storage: f.dataStorage || '10Gi' } }, volumeName: pvName
  } })

  // Every one of these is applied to serversettings.xml by the image's
  // entrypoint on each boot, so they are the ONLY supported way to set them --
  // hand-editing the XML on the volume is overwritten at startup.
  //
  // BAR_PORT is passed explicitly rather than left at the image default: the
  // game must advertise and bind the same port the Service and the WireGuard
  // gateway forward. A silent mismatch here (game on 27015, gateway DNATing
  // 27022) is why this server was unreachable from outside.
  const env = [
    { name: 'BAR_NAME', value: f.serverNameDisplay || 'GameCTL Barotrauma' },
    { name: 'BAR_PORT', value: String(port) },
    { name: 'BAR_QUERYPORT', value: String(queryPort) },
    { name: 'BAR_MAXPLAYERS', value: String(f.maxPlayers || 8) },
    { name: 'BAR_PUBLIC', value: String(!!f.isPublic) },
    { name: 'UPDATE_ON_START', value: 'false' }, // GameCTL auto-update toggle target
  ]
  if (f.serverPass) env.push({ name: 'BAR_PASSWORD', value: String(f.serverPass) })

  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment',
    // publish-mode=egress: Barotrauma registers with its master server, and the
    // master lists the server at the SOURCE address of that registration.
    // An inbound-only tunnel is not enough -- the pod's egress leaves via the
    // cluster's home WAN while the public ports live on the droplet, so the
    // master advertises an address nothing is listening on and the server shows
    // up unjoinable, or not at all. Routing the pod's egress through the droplet
    // makes the address the master records the same one players can reach.
    // Same reason iw4x (dpmaster) and wreckfest2 (PlayFab) carry this.
    //
    // Symptom when missing: every port is correct and externally queryable --
    // A2S answers on the public IP -- and the server still never appears.
    metadata: {
      name, namespace: ns, labels,
      ...mlbAnno,
      annotations: { ...(mlbAnno.annotations || {}), 'gamectl.io/publish-mode': 'egress' },
    },
    spec: {
    // Recreate, not RollingUpdate: a rolling update schedules the replacement
    // pod while the old one still holds its CPU/RAM and its volume, so a
    // Restart deadlocks on a cluster with no spare headroom — and two
    // servers would briefly write the same save data.
    strategy: { type: 'Recreate' },
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      containers: [ { name: 'server', image: f.image || 'ghcr.io/gamectl-hq/barotrauma-kube:latest', imagePullPolicy: 'Always', env,
        ports: [
          { name: 'game-udp', containerPort: port, protocol: 'UDP' },
          { name: 'query-udp', containerPort: queryPort, protocol: 'UDP' },
        ],
        volumeMounts: [ { name: 'data', mountPath: '/home/steam/.local/share/Daedalic Entertainment GmbH/Barotrauma/Multiplayer' } ],
        resources: { requests: { cpu: f.cpuRequest || '500m', memory: f.memRequest || '1Gi' }, limits: { cpu: f.cpuLimit || '2', memory: f.memLimit || '2Gi' } },
      } ],
      volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ]
    } }
  } })

  // NOTE ON EXPOSURE: this defaults to LoadBalancer + lbIP, but a ProxyCTL-hosted
  // server is switched to ClusterIP and reached through the WireGuard gateway's
  // DNAT instead -- in which case lbIP is unused and the gateway's forwarded
  // ports are what actually matter. Adding a port here is therefore only half
  // the job for a proxied server: ProxyCTL must forward it too, or the query
  // port stays unreachable and the server still never lists.
  docs.push({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    type: 'LoadBalancer', loadBalancerIP: f.lbIP || undefined, externalTrafficPolicy: 'Local', selector: labels, ports: [
      { name: 'game-udp', port, targetPort: port, protocol: 'UDP' },
      { name: 'query-udp', port: queryPort, targetPort: queryPort, protocol: 'UDP' },
    ]
  } })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
