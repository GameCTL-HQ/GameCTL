import yaml from 'js-yaml'

export const defaultSatisfactoryForm = {
  namespace: 'gamectl-satisfactory',
  serverName: 'satisfactory',
  image: 'ghcr.io/gamectl-hq/satisfactory-kube:latest',
  // Storage mode
  storageMode: 'remote', // 'remote' (NFS) | 'local' (hostPath)

  // Storage (NFS)
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/satisfactory',
  dataStorage: '50Gi',

  // Local storage
  localDataPath: '/mnt/1TBSSD/satisfactory',

  // Server config
  puid: '1000',
  pgid: '1000',
  branch: 'public', // public | experimental
  installIfMissing: 'true',
  runUpdateOnStart: 'false',
  // SteamCMD update behavior (wolveix image reads SKIPUPDATE, NOT the two above).
  // Default: do NOT re-run SteamCMD on every start. The image still auto-installs
  // if the game files are missing (run.sh line ~104), so first boot works and a
  // wiped/empty volume self-heals — but a populated /config volume is reused.
  // updateOnStart=true  -> always validate/update via SteamCMD on every start.
  // forceUpdate=true    -> one-shot: update on the NEXT rollout only (the wizard /
  //                        operator flips this back to false after triggering, and
  //                        it stamps a pod annotation to force a fresh rollout).
  updateOnStart: true, // auto-update enabled by default
  forceUpdate: false,
  attempts: 6,
  // Satisfactory 1.0 (Update 8 onward) collapsed the server onto ONE port that
  // carries both TCP and UDP. The old pre-U8 split -- reliable 8888, beacon
  // 15000, query 15777 -- no longer exists in the game at all.
  //
  // Verified on the live pod: it binds 7777/udp and NOTHING else. beaconPort
  // and queryPort reached no env, flag or config file (they only ever produced
  // Service ports and containerPorts pointing at a process that never listened
  // there), so they are removed rather than wired to a flag that does not
  // exist. Keeping them as editable fields implied a working knob and would
  // send players and ProxyCTL forwards at dead ports.
  serverGamePort: 7777,
  multihome: '0.0.0.0',
  enableCrossplay: 'false',
  home: '/srv/satisfactory',
  xdgConfigHome: '/srv/satisfactory/.config',

  // Networking
  lbIP: '10.0.0.186',
  externalTrafficPolicy: 'Cluster', // Local | Cluster
}

export function buildSatisfactoryYaml(f = defaultSatisfactoryForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'satisfactory'
  const labels = { app: name, game: 'satisfactory', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'

  const docs = []

  // Namespace
  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  // PV (NFS or hostPath)
  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1',
    kind: 'PersistentVolume',
    metadata: { name: pvName, labels },
    spec: isLocal
      ? {
          capacity: { storage: f.dataStorage || '50Gi' },
          accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/satisfactory', type: 'DirectoryOrCreate' },
        }
      : {
          capacity: { storage: f.dataStorage || '50Gi' },
          accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'nfs-static',
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/satisfactory' },
        },
  })

  // PVC
  const pvcName = `${name}-pvc`
  docs.push({
    apiVersion: 'v1',
    kind: 'PersistentVolumeClaim',
    metadata: { name: pvcName, namespace: ns, labels },
    spec: {
      accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'],
      storageClassName: isLocal ? 'manual' : ('nfs-static'),
      resources: { requests: { storage: f.dataStorage || '50Gi' } },
      volumeName: pvName,
    },
  })

  // The wolveix image installs the 4.5GB game files, saves AND backups under
  // /config (run.sh: +force_install_dir /config/gamefiles, /config/saved, ...).
  // The data PVC therefore MUST be mounted at /config or every pod start
  // re-downloads the whole game via SteamCMD (slow + exit-code-8 crash loops).
  // /srv/satisfactory stays as $HOME for transient runtime/config only.
  const dataMountPath = '/config'

  // Resolve SteamCMD update behavior. wolveix run.sh reads SKIPUPDATE:
  //   SKIPUPDATE=true  -> skip steamcmd (but it auto-flips to false if game
  //                       files are missing, so first install still works)
  //   SKIPUPDATE=false -> run steamcmd +app_update ... validate every start
  const wantUpdate = (f.updateOnStart === true || String(f.updateOnStart) === 'true')
    || (f.forceUpdate === true || String(f.forceUpdate) === 'true')
  const skipUpdate = wantUpdate ? 'false' : 'true'

  // Deployment
  const env = [
    { name: 'PUID', value: String(f.puid ?? '1000') },
    { name: 'PGID', value: String(f.pgid ?? '1000') },
    { name: 'BRANCH', value: f.branch || 'public' },
    // SKIPUPDATE is the var the wolveix image actually reads.
    { name: 'SKIPUPDATE', value: skipUpdate },
    // Kept for documentation/compat with non-wolveix images; inert for wolveix.
    { name: 'INSTALL_IF_MISSING', value: String(f.installIfMissing ?? 'true') },
    { name: 'RUN_UPDATE_ON_START', value: String(f.runUpdateOnStart ?? 'false') },
    { name: 'ATTEMPTS', value: String(f.attempts ?? 6) },
    { name: 'SERVERGAMEPORT', value: String(f.serverGamePort ?? 7777) },
    { name: 'RELIABLEPORT', value: String(f.reliablePort ?? 8888) },
    { name: 'MULTIHOME', value: f.multihome || '0.0.0.0' },
    { name: 'ENABLE_CROSSPLAY', value: String(f.enableCrossplay ?? 'false') },
    { name: 'HOME', value: f.home || '/srv/satisfactory' },
    { name: 'XDG_CONFIG_HOME', value: f.xdgConfigHome || '/srv/satisfactory/.config' },
  ]

  docs.push({
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: { name, namespace: ns, labels },
    spec: {
      replicas: 1,
      // Single-instance on one volume: stop old pod before starting new.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: {
        metadata: {
          labels,
          // Forcing an update stamps a changing annotation so the Deployment
          // rolls a new pod (otherwise an unchanged spec won't restart) and
          // that one rollout runs SteamCMD via SKIPUPDATE=false above.
          annotations: wantUpdate
            ? { 'gamectl.io/steamcmd-update': new Date().toISOString() }
            : {},
        },
        spec: {
          terminationGracePeriodSeconds: 60,
          securityContext: { runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
          containers: [
            {
              name: 'server',
              image: f.image || 'ghcr.io/gamectl-hq/satisfactory-kube:latest',
              imagePullPolicy: 'Always',
              env,
              ports: [
                { name: 'game-udp', containerPort: Number(f.serverGamePort || 7777), protocol: 'UDP' },
                { name: 'game-tcp', containerPort: Number(f.serverGamePort || 7777), protocol: 'TCP' },
                { name: 'reliable-udp', containerPort: Number(f.reliablePort || 8888), protocol: 'UDP' },
                { name: 'reliable-tcp', containerPort: Number(f.reliablePort || 8888), protocol: 'TCP' },
              ],
              volumeMounts: [ { name: 'data', mountPath: dataMountPath } ],
              resources: { requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '2Gi' }, limits: { cpu: f.cpuLimit || '4', memory: f.memLimit || '8Gi' } },
            },
          ],
          volumes: [ { name: 'data', persistentVolumeClaim: { claimName: pvcName } } ],
        },
      },
    },
  })

  // Service
  docs.push({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: { name, namespace: ns, labels, ...mlbAnno },
    spec: {
      type: 'LoadBalancer',
      loadBalancerIP: f.lbIP || undefined,
      selector: labels,
      externalTrafficPolicy: f.externalTrafficPolicy || 'Cluster',
      ports: [
        { name: 'udp-game', port: Number(f.serverGamePort || 7777), targetPort: Number(f.serverGamePort || 7777), protocol: 'UDP' },
        { name: 'tcp-game', port: Number(f.serverGamePort || 7777), targetPort: Number(f.serverGamePort || 7777), protocol: 'TCP' },
        { name: 'udp-reliable', port: Number(f.reliablePort || 8888), targetPort: Number(f.reliablePort || 8888), protocol: 'UDP' },
        { name: 'tcp-reliable', port: Number(f.reliablePort || 8888), targetPort: Number(f.reliablePort || 8888), protocol: 'TCP' },
      ],
    },
  })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
