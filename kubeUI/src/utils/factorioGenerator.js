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
  // TCP RCON for the in-app console. Defaults off the Source 27015 that CS2 /
  // Project Zomboid already hold — Factorio has no convention here, so there
  // is nothing to lose by moving it and one fewer number to disambiguate.
  rconPort: 27016,
  rconPassword: 'ChangeMe12345', // Source-RCON for the manage-screen console
  lbIP: '10.0.0.190',

  // Server visibility. Two coherent modes rather than three independent
  // switches, because the underlying settings are not actually independent:
  //   'lan'    → visibility.public=false, visibility.lan=true,
  //              require_user_verification=false. Anyone who can reach the
  //              port joins, verified with factorio.com or not.
  //   'public' → visibility.public=true, visibility.lan=true,
  //              require_user_verification=true. Listed on Factorio's public
  //              matching server, which REQUIRES factorio.com credentials —
  //              the server will not list without them.
  visibility: 'lan',
  factorioUsername: '',
  // Public listing takes EITHER a token or the account password — the image's
  // own server-settings.example.json documents token as "may be used instead
  // of 'password'". Token is the default because it is server-scoped and
  // revocable from the profile page, where the password is the whole account;
  // the password path exists for operators who have not fetched a token.
  authMethod: 'token', // 'token' | 'password'
  factorioToken: '',
  factorioPassword: '',
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

  // Ports the entrypoint actually reads. factorio-kube's entrypoint builds its
  // command line from $PORT (--port) and $RCON_PORT (--rcon-port), so a port
  // chosen in the wizard has to arrive as env — a containerPort/Service port
  // alone only renames the hole in front of a server still listening on its
  // built-in default. PORT was previously omitted entirely, which is why
  // changing the game port in the wizard did nothing.
  //
  // RCON_PASSWORD: the entrypoint prefers a pre-seeded
  // /factorio/config/rconpw over this env var, so the init container below
  // writes the wizard's value into that file to keep it authoritative across
  // restarts. The env var still has to be set regardless — it is what
  // GameCTL's backend reads to know the password and light up the generic
  // console (resolveRCON / rconAvailable look for a non-empty RCON_PASSWORD).
  //
  // Keep the rcon port OFF any public tunnel — it is reached internally via
  // the Service ClusterIP only (cs2 brute-force lesson).
  const gamePort = Number(f.gamePort || 34197)
  const queryPort = Number(f.queryPort || 27015)
  const rconPort = Number(f.rconPort || 27016)
  const rconPw = f.rconPassword || 'ChangeMe12345'
  const isPublic = (f.visibility || 'lan') === 'public'

  // Runs in the init container. Mirrors the entrypoint's own first-boot seed
  // (same example file, same jq) so a fresh volume and an existing one end up
  // in the same shape, then patches the wizard-owned keys.
  //
  // visibility.lan stays true in both modes: it costs nothing, and a public
  // server should still be discoverable by people on the same network.
  //
  // Credentials are written only when supplied, so flipping to LAN mode does
  // not wipe values the operator may want back later. The UNCHOSEN auth field
  // is cleared though: leaving a stale account password on the volume after
  // switching to token auth is a credential lying around for no reason.
  // FACTORIO_AUTH is empty in LAN mode, which leaves both fields alone.
  const initScript = [
    'set -e',
    'mkdir -p /factorio/config',
    // Clear partial autosaves before the server starts.
    //
    // Factorio autosaves by writing <name>.tmp.zip and then RENAMING it over
    // <name>.zip. That is atomic only if the rename happens — interrupt the
    // write (node suspended, NFS blip, pod killed mid-save) and a truncated
    // .tmp.zip is left behind. Because --start-server-load-latest picks the
    // NEWEST file in saves/, the server then loads the corpse instead of the
    // perfectly good save beside it and dies with
    //   "Opening zip .../world.tmp.zip failed: I/O error"
    // on every boot, forever, until a human deletes the file. That took a
    // Factorio server down three separate times.
    //
    // A partial autosave is by definition not a save, so it should never be
    // a load candidate. Move rather than delete: it costs nothing, and if a
    // save ever IS recoverable the bytes are still there. This keeps
    // --start-server-load-latest, which is the right recovery behaviour after
    // a genuine crash.
    'for t in /factorio/saves/*.tmp.zip; do',
    '  [ -e "$t" ] || continue',
    '  echo "[gamectl] quarantining partial autosave: $t"',
    '  mv -- "$t" "$t.partial-$(date +%Y%m%d-%H%M%S)" || rm -f -- "$t"',
    'done',
    'printf %s "$RCON_PASSWORD" > /factorio/config/rconpw',
    'S=/factorio/config/server-settings.json',
    '[ -f "$S" ] || jq \'.name = "Factorio (GameCTL)"\' /opt/factorio/data/server-settings.example.json > "$S"',
    'jq --argjson pub "$FACTORIO_PUBLIC" --argjson ver "$FACTORIO_VERIFY" \\',
    '   --arg user "$FACTORIO_USERNAME" --arg auth "$FACTORIO_AUTH" \\',
    '   --arg tok "$FACTORIO_TOKEN" --arg pw "$FACTORIO_PASSWORD" \\',
    '   \'.visibility.public = $pub | .visibility.lan = true',
    '    | .require_user_verification = $ver',
    '    | (if $user != "" then .username = $user else . end)',
    '    | (if $auth == "token"',
    '       then (.password = "") | (if $tok != "" then .token = $tok else . end)',
    '       elif $auth == "password"',
    '       then (.token = "") | (if $pw != "" then .password = $pw else . end)',
    '       else . end)\' \\',
    '   "$S" > "$S.tmp" && mv "$S.tmp" "$S"',
    'echo "gamectl: server-settings.json patched (public=$FACTORIO_PUBLIC verify=$FACTORIO_VERIFY auth=${FACTORIO_AUTH:-none})"',
  ].join('\n')
  const env = [
    { name: 'PORT', value: String(gamePort) },
    { name: 'RCON_PORT', value: String(rconPort) },
    { name: 'RCON_PASSWORD', value: rconPw },
  ]

  docs.push({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno }, spec: {
    // Recreate, not RollingUpdate: a rolling update schedules the replacement
    // pod while the old one still holds its CPU/RAM and its volume, so a
    // Restart deadlocks on a cluster with no spare headroom — and two
    // servers would briefly write the same save data.
    strategy: { type: 'Recreate' },
    replicas: 1, selector: { matchLabels: labels }, template: { metadata: { labels }, spec: {
      // Seed the two config files the image reads but never rewrites, so the
      // wizard stays authoritative across restarts:
      //
      //   rconpw               — the entrypoint prefers this file over
      //                          $RCON_PASSWORD, so it must be written here.
      //   server-settings.json — the entrypoint seeds this ONLY when absent
      //                          (first boot). Without this step, changing
      //                          visibility in the wizard and redeploying
      //                          would silently do nothing forever, because
      //                          the file already exists on the volume.
      //
      // Only the keys the wizard owns are patched — any other hand-edit on
      // the volume (max players, autosave, admins) survives untouched.
      initContainers: [ { name: 'config-seed', image: f.image || 'ghcr.io/gamectl-hq/factorio-kube:2.0.77', imagePullPolicy: 'Always',
        command: ['sh', '-c', initScript],
        env: [
          { name: 'RCON_PASSWORD', value: rconPw },
          { name: 'FACTORIO_PUBLIC', value: String(isPublic) },
          { name: 'FACTORIO_VERIFY', value: String(isPublic) },
          { name: 'FACTORIO_USERNAME', value: f.factorioUsername || '' },
          // Empty outside public mode, so the init script leaves both
          // credential fields on the volume exactly as it found them.
          { name: 'FACTORIO_AUTH', value: isPublic ? (f.authMethod || 'token') : '' },
          { name: 'FACTORIO_TOKEN', value: f.factorioToken || '' },
          { name: 'FACTORIO_PASSWORD', value: f.factorioPassword || '' },
        ],
        volumeMounts: [ { name: 'data', mountPath: '/factorio' } ],
      } ],
      containers: [ { name: 'server', image: f.image || 'ghcr.io/gamectl-hq/factorio-kube:2.0.77', imagePullPolicy: 'Always', env,
        ports: [
          { name: 'game-udp', containerPort: gamePort, protocol: 'UDP' },
          { name: 'query-udp', containerPort: queryPort, protocol: 'UDP' },
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
      { name: 'game-udp', port: gamePort, targetPort: gamePort, protocol: 'UDP' },
      { name: 'query-udp', port: queryPort, targetPort: queryPort, protocol: 'UDP' },
      // RCON for the GameCTL console. Reached internally via the Service
      // ClusterIP — do NOT forward this port on any public tunnel/ingress
      // (a public RCON port gets brute-force-scanned; see the cs2 fix).
      // Distinct protocol (TCP) from query-udp so 27015 can coexist.
      { name: 'rcon', port: rconPort, targetPort: rconPort, protocol: 'TCP' }
    ]
  } })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
