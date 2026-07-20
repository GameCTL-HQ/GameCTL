import yaml from 'js-yaml'

// Wreckfest 2 — GameCTL's first Wine-based game. The WF2 dedicated server is
// Windows-only (Steam app 3519390, anonymous), so ghcr.io/gamectl-hq/
// wreckfest2-kube runs it under WineHQ stable + xvfb. Fleet NFS-install
// model: the ~2GB server installs to the volume on first boot; steam HOME +
// wine prefix persist beside it; a normal boot never runs steamcmd.
// server_config.scnf (scnf v0 / ncnf v2 / gcnf v5) is generated from env by
// the entrypoint each boot (GAMECTL_MANAGE_CONFIG=1).
export const defaultWreckfest2Form = {
  namespace: 'gamectl-wreckfest2',
  serverName: 'wreckfest2',
  image: 'ghcr.io/gamectl-hq/wreckfest2-kube:latest',
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/wreckfest2',
  dataStorage: '10Gi',
  localDataPath: '/mnt/1TBSSD/GameCTL/wreckfest2',

  hostname: 'GameCTL Wreckfest 2',   // in-game server browser name
  description: 'Welcome to my server!',
  serverPassword: '',
  gamePort: 30100,
  eventLoop: 'default_loop',
  countdownTime: 100000,             // lobby countdown (ms)
  votingTime: 20000,                 // vote time (ms)
  serverFlags: '',                   // e.g. "leader enabled"
  updateOnStart: false,

  lbIP: '',
  externalTrafficPolicy: 'Cluster',
}

export function buildWreckfest2Yaml(f = defaultWreckfest2Form) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'wreckfest2'
  const labels = { app: name, game: 'wreckfest2', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const port = Number(f.gamePort || 30100)

  const docs = []
  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume',
    metadata: { name: pvName, labels },
    spec: isLocal
      ? { capacity: { storage: f.dataStorage || '10Gi' }, accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/GameCTL/wreckfest2', type: 'DirectoryOrCreate' } }
      : { capacity: { storage: f.dataStorage || '10Gi' }, accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain', storageClassName: 'nfs-static',
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/wreckfest2' } },
  })

  const pvcName = `${name}-pvc`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolumeClaim',
    metadata: { name: pvcName, namespace: ns, labels },
    spec: { accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'],
      storageClassName: isLocal ? 'manual' : 'nfs-static',
      resources: { requests: { storage: f.dataStorage || '10Gi' } }, volumeName: pvName },
  })

  const wantUpdate = f.updateOnStart === true || String(f.updateOnStart) === 'true'
  const env = [
    { name: 'SERVER_NAME', value: f.hostname || 'GameCTL Wreckfest 2' },
    { name: 'SERVER_DESCRIPTION', value: f.description || 'Welcome to my server!' },
    { name: 'SERVER_PASSWORD', value: f.serverPassword || '' },
    { name: 'GAME_PORT', value: String(port) },
    { name: 'EVENT_LOOP', value: f.eventLoop || 'default_loop' },
    { name: 'COUNTDOWN_TIME', value: String(f.countdownTime ?? 100000) },
    { name: 'VOTING_TIME', value: String(f.votingTime ?? 20000) },
    { name: 'SERVER_FLAGS', value: f.serverFlags || '' },
    // Update+validate on next (re)start; flipped by the manage-screen
    // Auto-update toggle. Normal boots never run steamcmd.
    { name: 'GAMECTL_VALIDATE', value: wantUpdate ? '1' : '0' },
  ]

  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment',
    // publish-mode=egress: WF2's server browser (PlayFab) records the
    // server's OUTBOUND IP, so a ProxyCTL publish must also route the
    // pod's egress through the droplet (WireGuard sidecar) or joins are
    // sent to an unreachable home WAN address.
    metadata: { name, namespace: ns, labels, annotations: { 'gamectl.io/publish-mode': 'egress' } },
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
          // Entrypoint starts as root (steamcmd + one-time chowns) and drops
          // to uid/gid 1000 via setpriv before launching wine.
          securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
          containers: [{
            name: 'server',
            image: f.image || 'ghcr.io/gamectl-hq/wreckfest2-kube:latest',
            imagePullPolicy: 'Always',
            env,
            ports: [
              { name: 'game-udp', containerPort: port, protocol: 'UDP' },
              { name: 'game-tcp', containerPort: port, protocol: 'TCP' },
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
        { name: 'game-tcp', port, targetPort: port, protocol: 'TCP' },
      ],
    },
  })

  return docs.map((d) => yaml.dump(d, { noRefs: true, lineWidth: -1 })).join('---\n')
}
