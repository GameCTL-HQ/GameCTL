import yaml from 'js-yaml'

export const defaultMinecraftForm = {
  namespace: 'gamectl-minecraft',
  serverName: 'minecraft',
  image: 'ghcr.io/gamectl-hq/minecraft-kube:latest',
  memory: '4G',
  type: 'PAPER', // PAPER|VANILLA (SPIGOT maps to Paper in the image)
  mcVersion: 'LATEST', // pin (e.g. 26.1.2) to protect an existing world from auto-upgrade
  rconPassword: 'ChangeMe12345', // Source-RCON for the manage-screen console

  // Storage mode
  storageMode: 'remote', // 'remote' (NFS) | 'local' (hostPath)

  // NFS storage for world data
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/minecraft',
  dataStorage: '50Gi',

  // Local hostPath storage (used when storageMode === 'local')
  localDataPath: '/mnt/1TBSSD/minecraft',

  // Networking
  minecraftPort: 25565,
  minecraftLbIP: '10.0.0.168',

  // BlueMap optional. Its webroot persists inside the main minecraft
  // data volume (subdir /data/bluemap/web) — there is no separate
  // BlueMap PV/PVC/path anymore, so no bluemapPvPath/bluemapStorage/
  // localBluemapPath fields here.
  bluemapEnabled: 1, // 1=yes, 0=no
  // BlueMap downloads Minecraft client assets to render the map and
  // refuses to start its webserver until accept-download is true (a
  // Mojang-EULA-style gate). Default OFF — the map stays down until the
  // operator explicitly accepts in the wizard, mirroring Mojang's gate.
  // Default ACCEPTED: deploying through the wizard already implies the
  // Mojang EULA (the generator bakes EULA=TRUE), and BlueMap's gate mirrors
  // that same EULA — leaving it "No" just ships a map that's silently down.
  // The wizard select still offers the opt-out.
  bluemapAcceptDownload: 1, // 1 = accepted
  bluemapPort: 8100,
  bluemapLbIP: '10.0.0.186',
}

export function buildMinecraftYaml(f = defaultMinecraftForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'minecraft'
  const labels = { app: name, game: 'minecraft', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const docs = []
  const isLocal = (f.storageMode || 'remote') === 'local'

  // Namespace
  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  // PV for Minecraft data (NFS or hostPath)
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
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/minecraft', type: 'DirectoryOrCreate' },
        }
      : {
          capacity: { storage: f.dataStorage || '50Gi' },
          accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'nfs-static',
          nfs: {
            server: f.nfsServer || '10.0.0.100',
            path: f.dataPvPath || '/mnt/1TBSSD/minecraft',
            readOnly: false,
          },
        },
  })

  // PVC for Minecraft data
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

  // BlueMap gate. NOTE (storage consolidation): BlueMap's webroot is
  // *not* backed by its own PV/PVC/host path anymore. The webroot lives
  // at /data/bluemap/web, which is already a subdirectory of the main
  // minecraft data volume (mounted at /data from `${name}-pvc`). A
  // separate top-level bluemap PV/PVC pointed at its own NFS/host path
  // (`bluemapPvPath`/`localBluemapPath`) was redundant: it shadowed a
  // path that is already persisted by the data volume, and the tiles are
  // fully regenerable from the world anyway. We therefore create no
  // bluemap PV/PVC/extra volume/extra volumeMount — BlueMap web tiles
  // persist across restarts on the existing data PVC as a normal subdir.
  const isPaper = String(f?.type || '').toUpperCase() === 'PAPER'
  const bluemapOn = isPaper && Number(f.bluemapEnabled) === 1

  // Deployment
  const env = [
    { name: 'EULA', value: 'TRUE' },
    // The image writes this into server.properties as server-port. Without it
    // the JVM binds 25565 no matter what the wizard picked, while the Service,
    // the LB and ProxyCTL's DNAT (which preserves the destination port) all
    // follow the choice — a server listening where nothing is sent, healthy in
    // every check, silent in every log.
    { name: 'SERVER_PORT', value: String(Number(f.minecraftPort || 25565)) },
    { name: 'MEMORY', value: f.memory || '4G' },
    { name: 'TYPE', value: f.type || 'PAPER' },
    { name: 'VERSION', value: f.mcVersion || 'LATEST' },
    // Only install BlueMap plugin when feature is enabled
    ...(bluemapOn ? [{ name: 'SPIGET_RESOURCES', value: '83557' }] : []),
    { name: 'OVERRIDE_OPS', value: 'FALSE' },
    { name: 'OVERRIDE_WHITELIST', value: 'FALSE' },
    // Source-RCON so the GameCTL manage screen can run console commands
    // (op <player>, list, say, …). itzg reads ENABLE_RCON / RCON_PASSWORD
    // / RCON_PORT. RCON_PASSWORD is also what makes the generic console
    // light up in the UI. Keep the rcon port OFF any public tunnel —
    // it's reached internally via the Service ClusterIP only.
    { name: 'ENABLE_RCON', value: 'true' },
    { name: 'RCON_PASSWORD', value: f.rconPassword || 'ChangeMe12345' },
    { name: 'RCON_PORT', value: '25575' },
  ]

  const ports = [
    { name: 'minecraft-tcp', containerPort: Number(f.minecraftPort || 25565), protocol: 'TCP' },
    { name: 'rcon', containerPort: 25575, protocol: 'TCP' },
    ...(bluemapOn ? [{ name: 'bluemap-web', containerPort: Number(f.bluemapPort || 8100), protocol: 'TCP' }] : []),
  ]

  // BlueMap webroot (/data/bluemap/web) is intentionally NOT a separate
  // volume/mount: it is a subdirectory of /data and is persisted by the
  // single minecraft data volume below.
  const volumeMounts = [
    { name: 'minecraft-storage', mountPath: '/data' },
  ]

  const volumes = [
    { name: 'minecraft-storage', persistentVolumeClaim: { claimName: dataPvcName } },
  ]

  // Container resources sized from the JVM heap (MEMORY). The container
  // needs heap + JVM/native/OS overhead, so request = heap and limit =
  // heap + 1Gi headroom. Without this the scheduler treats the pod as
  // ~free and overpacks nodes (then they OOM). Parses "4G"/"4096M".
  const memG = (() => {
    const m = String(f.memory || '4G').trim().match(/^(\d+)\s*([GgMm])/)
    if (!m) return 4
    const n = Number(m[1])
    return m[2].toUpperCase() === 'M' ? Math.max(1, Math.ceil(n / 1024)) : n
  })()
  // Wizard can override any of these; blank falls back to the JVM-derived
  // default. Request is heap − 1Gi (min 1Gi): real idle/working-set sits
  // well below the configured heap, so reserving the full heap just makes
  // the scheduler refuse other pods on nodes that actually have RAM free.
  // The limit stays heap + 1Gi so a runaway is still capped.
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
      // Recreate, not RollingUpdate: the world dir holds session.lock on the
      // shared volume, so a rolling update deadlocks — the new pod can't take
      // the lock while the old one runs, and the old one never scales down
      // because the new one never goes Ready. Kill-then-start is the only
      // safe order for a single-world server.
      strategy: { type: 'Recreate' },
      selector: { matchLabels: labels },
      template: {
        metadata: { labels },
        spec: {
          securityContext: { fsGroup: 1000, fsGroupChangePolicy: 'OnRootMismatch' },
          // BlueMap init: NFS volumes routinely ignore fsGroup, so
          // /data/bluemap/web and /data/plugins/BlueMap otherwise get
          // created root-owned and BlueMap (uid 1000) hits
          // AccessDeniedException → empty webapp → 404. Pre-create them
          // 1000:1000 every (re)start. When the operator has accepted the
          // BlueMap download EULA in the wizard, also pre-seed core.conf
          // with accept-download: true *before* the server starts (no
          // RCON-reload timing fragility); BlueMap merges its other
          // defaults around the pre-set key. Toggle OFF → not seeded →
          // BlueMap stays gated (map down), mirroring Mojang's own gate.
          ...(bluemapOn ? {
            initContainers: [{
              name: 'bluemap-init',
              image: 'busybox:stable',
              command: ['sh', '-c',
                'set -e; ' +
                'mkdir -p /data/bluemap/web /data/plugins/BlueMap; ' +
                'chown -R 1000:1000 /data/bluemap /data/plugins/BlueMap; ' +
                (Number(f.bluemapAcceptDownload) === 1
                  ? 'C=/data/plugins/BlueMap/core.conf; ' +
                    'if [ ! -f "$C" ]; then printf "accept-download: true\\n" > "$C"; ' +
                    'elif grep -qE "^[[:space:]]*accept-download:" "$C"; then ' +
                    'sed -i "s/^[[:space:]]*accept-download:.*/accept-download: true/" "$C"; ' +
                    'else printf "accept-download: true\\n" >> "$C"; fi; ' +
                    'chown 1000:1000 "$C"; '
                  : '') +
                // BlueMap's listen port lives ONLY in webserver.conf — it has
                // no env var and BlueMap ignores the containerPort entirely.
                // Without this, changing the BlueMap port in the wizard moved
                // the Service to a port BlueMap was never listening on and the
                // map just 404'd/timed out, with BlueMap logging a clean start
                // on 8100 the whole time. Same class of bug as the game port.
                //
                // Written before the server starts (no plugin-reload timing to
                // get wrong). If the file does not exist yet — first boot,
                // BlueMap has not generated it — a one-key file is enough:
                // BlueMap merges its own defaults around a pre-set key, which
                // is exactly how core.conf above is seeded.
                'W=/data/plugins/BlueMap/webserver.conf; ' +
                `BMPORT=${Number(f.bluemapPort || 8100)}; ` +
                'if [ ! -f "$W" ]; then printf "port: %s\\n" "$BMPORT" > "$W"; ' +
                'elif grep -qE "^[[:space:]]*port:" "$W"; then ' +
                'sed -i "s/^[[:space:]]*port:.*/port: $BMPORT/" "$W"; ' +
                'else printf "port: %s\\n" "$BMPORT" >> "$W"; fi; ' +
                'chown 1000:1000 "$W"; ',
              ],
              securityContext: { runAsUser: 0 },
              volumeMounts: [{ name: 'minecraft-storage', mountPath: '/data' }],
            }],
          } : {}),
          containers: [
            {
              name: 'minecraft-server',
              image: f.image || 'ghcr.io/gamectl-hq/minecraft-kube:latest',
              imagePullPolicy: 'Always',
              env,
              ports,
              volumeMounts,
              resources,
              // Readiness flips to true only once the JVM is listening on the
              // game port — distinguishes "container started" from "Minecraft
              // accepting connections" in the GameCTL UI.
              readinessProbe: {
                tcpSocket: { port: Number(f.minecraftPort || 25565) },
                initialDelaySeconds: 20,
                periodSeconds: 5,
                timeoutSeconds: 2,
                failureThreshold: 3,
              },
              // Liveness is permissive — slow world generation shouldn't kill
              // the pod. Only restart if the port stops accepting connections
              // for a long stretch (5 min).
              livenessProbe: {
                tcpSocket: { port: Number(f.minecraftPort || 25565) },
                initialDelaySeconds: 180,
                periodSeconds: 30,
                timeoutSeconds: 5,
                failureThreshold: 10,
              },
            },
          ],
          volumes,
        },
      },
    },
  })

  // Minecraft Service (MetalLB)
  docs.push({
    apiVersion: 'v1',
    kind: 'Service',
    metadata: {
      name: `${name}-service`,
      namespace: ns,
      labels,
      annotations: { 'metallb.universe.tf/address-pool': f.metallbPool || 'homelab-pool' },
    },
    spec: {
      type: 'LoadBalancer',
      externalTrafficPolicy: 'Local',
      loadBalancerIP: f.minecraftLbIP || undefined,
      ports: [
        { name: 'minecraft-tcp', port: Number(f.minecraftPort || 25565), targetPort: Number(f.minecraftPort || 25565), protocol: 'TCP' },
        // RCON for the GameCTL console. Reached internally via the Service
        // ClusterIP — do NOT forward this port on any public tunnel/ingress
        // (a public RCON port gets brute-force-scanned; see the cs2 fix).
        { name: 'rcon', port: 25575, targetPort: 25575, protocol: 'TCP' },
      ],
      selector: labels,
    },
  })

  // BlueMap Service (optional)
  if (bluemapOn) {
  docs.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: {
    name: `${name}-bluemap-service`,
    namespace: ns,
    labels,
        annotations: { 'metallb.universe.tf/address-pool': f.metallbPool || 'homelab-pool' },
      },
      spec: {
        type: 'LoadBalancer',
        externalTrafficPolicy: 'Local',
        loadBalancerIP: f.bluemapLbIP || undefined,
        ports: [
          { name: 'bluemap-web', port: Number(f.bluemapPort || 8100), targetPort: Number(f.bluemapPort || 8100), protocol: 'TCP' },
        ],
        selector: labels,
      },
    })
  }

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
