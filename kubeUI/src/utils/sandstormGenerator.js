import yaml from 'js-yaml'

// Insurgency: Sandstorm dedicated server (Steam app 581330), geared for PVE
// co-op (Checkpoint) with optional ISMC mod pack.
//
// Base image: andrewmhub/insurgency-sandstorm (actively maintained, ISMC-aware).
// Its stock entrypoint only reads LAUNCH_SERVER_ENV/HOSTNAME/PORT/QUERYPORT and
// downloads 581330 at start. We override the command with a wrapper so GameCTL
// controls the full launch string, writes Mods.txt for ISMC, and persists the
// whole install (game + config + mods) on the chosen NFS/local location at
// /home/steam/steamcmd/sandstorm — no re-download on restart.
//
// ISMC = Insurgency Sandstorm Modding Community pack (mod.io id 150867). Enabled
// via -Mods + Mods.txt and a "theater" mutator (e.g. ISMCarmory_Legacy); ISS
// dedicated servers pull public mod.io mods with just -Mods (no API key).

// PVE Checkpoint scenarios (co-op vs bots). value = <Map>?Scenario=<Scenario>.
export const SANDSTORM_CHECKPOINT_SCENARIOS = [
  { label: 'Farmhouse — Checkpoint (Security)', value: 'Farmhouse?Scenario=Scenario_Farmhouse_Checkpoint_Security' },
  { label: 'Refinery — Checkpoint (Security)', value: 'Refinery?Scenario=Scenario_Refinery_Checkpoint_Security' },
  { label: 'Hillside — Checkpoint (Security)', value: 'Hillside?Scenario=Scenario_Hillside_Checkpoint_Security' },
  { label: 'Crossing — Checkpoint (Security)', value: 'Crossing?Scenario=Scenario_Crossing_Checkpoint_Security' },
  { label: 'Summit — Checkpoint (Security)', value: 'Summit?Scenario=Scenario_Summit_Checkpoint_Security' },
  { label: 'Precinct — Checkpoint (Security)', value: 'Precinct?Scenario=Scenario_Precinct_Checkpoint_Security' },
  { label: 'Ministry — Checkpoint (Security)', value: 'Ministry?Scenario=Scenario_Ministry_Checkpoint_Security' },
  { label: 'Hideout — Checkpoint (Security)', value: 'Hideout?Scenario=Scenario_Hideout_Checkpoint_Security' },
  { label: 'Outskirts — Checkpoint (Security)', value: 'Outskirts?Scenario=Scenario_Outskirts_Checkpoint_Security' },
]

// ISMC theater mutator — pick exactly one; drives which weapon/class ruleset.
export const SANDSTORM_ISMC_MUTATORS = [
  { label: 'ISMCarmory_Legacy (ISMC guns + NWI cosmetics, classic classes)', value: 'ISMCarmory_Legacy' },
  { label: 'ISMC_Casual (BluFor/RedFor per side, all classes)', value: 'ISMC_Casual' },
]

export const defaultSandstormForm = {
  namespace: 'gamectl-sandstorm',
  serverName: 'sandstorm',
  image: 'andrewmhub/insurgency-sandstorm:latest',
  // Storage: operator-declared location (resolveStorage → storageMode +
  // nfsServer/dataPvPath or localDataPath). ISS install ~15G, +mods.
  storageMode: 'remote',
  nfsServer: '10.0.0.100',
  dataPvPath: '/mnt/1TBSSD/GameCTL/sandstorm',
  localDataPath: '/mnt/1TBSSD/GameCTL/sandstorm',
  dataStorage: '25Gi',
  // Server
  hostname: 'GameCTL Insurgency (PVE)',
  scenario: 'Farmhouse?Scenario=Scenario_Farmhouse_Checkpoint_Security',
  maxPlayers: 8,
  gslt: '',            // Game Server Login Token (steamcommunity.com/dev/managegameservers, App 581330)
  gameStatsToken: '',  // community server browser stats token (optional)
  serverPassword: '',  // join password (optional)
  // ISMC mod pack
  ismcEnabled: 0,      // 0 = vanilla PVE, 1 = ISMC
  ismcMutator: 'ISMCarmory_Legacy',
  extraMutators: '',   // additional comma-separated mutators (e.g. ISMCJumpShoot)
  extraMods: '',       // extra mod.io ids (comma or space separated) added to Mods.txt
  modioToken: '',      // mod.io OAuth access token (mod.io/me/access#tokens, the eyJ… JWT) — REQUIRED for mods
  // Networking
  gamePort: 27102,
  queryPort: 27131,
  // Free IP inside the homelab MetalLB pool (10.0.0.160-183). The wizard's
  // LoadBalancer-IP picker lets the operator choose a different free one.
  lbIP: '10.0.0.173',
}

const ISMC_MODIO_ID = '150867'
const INSTALL_DIR = '/home/steam/steamcmd/sandstorm'

// Build the wrapper command: write Mods.txt (ISMC), steamcmd-update 581330,
// then launch the server with the full arg string. Persists on the mounted
// volume at INSTALL_DIR. app_update is idempotent, so restarts are fast.
function buildCommand(f) {
  const ismc = Number(f.ismcEnabled ?? 0) === 1
  const cfgServerDir = `${INSTALL_DIR}/Insurgency/Config/Server`

  // Mods.txt: ISMC id + any extras. Only written when mods are enabled.
  const modIds = []
  if (ismc) modIds.push(ISMC_MODIO_ID)
  for (const m of String(f.extraMods || '').split(/[\s,]+/)) {
    const id = m.trim()
    if (id) modIds.push(id)
  }

  // Travel URL: <Map>?Scenario=...?MaxPlayers=N[?Mutators=...]
  const mutators = []
  if (ismc && f.ismcMutator) mutators.push(f.ismcMutator)
  for (const m of String(f.extraMutators || '').split(/[\s,]+/)) {
    const mm = m.trim()
    if (mm) mutators.push(mm)
  }
  const base = `${f.scenario || 'Farmhouse?Scenario=Scenario_Farmhouse_Checkpoint_Security'}?MaxPlayers=${Number(f.maxPlayers || 8)}`
  const pw = f.serverPassword ? `?Password=${f.serverPassword}` : ''

  // -Flags (space separated). -Mods pulls Mods.txt ids from mod.io.
  const flags = ['-GameStats', '-log']
  if (f.gslt) flags.push(`-GSLTToken=${f.gslt}`)
  if (f.gameStatsToken) flags.push(`-GameStatsToken=${f.gameStatsToken}`)

  // Mods can't be applied on the FIRST scenario (they aren't downloaded yet),
  // so we boot the plain scenario, then -ModDownloadTravelTo makes the server
  // download the Mods.txt ids from mod.io and travel to the SAME scenario with
  // the mutator(s) applied. Without mods, just boot the scenario directly.
  let travel
  if (modIds.length) {
    travel = `${base}${pw}`
    flags.push('-Mods')
    const modTarget = mutators.length ? `${base}?Mutators=${mutators.join(',')}${pw}` : `${base}${pw}`
    flags.push(`-ModDownloadTravelTo="${modTarget}"`)
  } else {
    travel = mutators.length ? `${base}?Mutators=${mutators.join(',')}${pw}` : `${base}${pw}`
  }

  const port = Number(f.gamePort || 27102)
  const query = Number(f.queryPort || 27131)

  const savedCfgDir = `${INSTALL_DIR}/Insurgency/Saved/Config/LinuxServer`
  const lines = [
    'set -e',
    // Persist-friendly: ensure the config dirs exist on the mounted volume.
    `mkdir -p "${cfgServerDir}" "${savedCfgDir}"`,
  ]
  if (modIds.length) {
    lines.push(`printf '%s\\n' ${modIds.map(id => `'${id}'`).join(' ')} > "${cfgServerDir}/Mods.txt"`)
    lines.push(`echo "gamectl: Mods.txt -> $(cat "${cfgServerDir}/Mods.txt" | tr '\\n' ' ')"`)
    // mod.io downloads REQUIRE an API key in Engine.ini — without it the server
    // can't fetch mods (mod.io inits anonymously but stays empty). The operator
    // supplies their own key from mod.io → API Access (mod.io/me/access#api).
    if (String(f.modioToken || '').trim()) {
      lines.push(
        `printf '%s\\n' '[/script/modkit.modioclient]' 'bHasUserAcceptedTerms=True' ` +
        `'AccessToken=${String(f.modioToken).trim()}' > "${savedCfgDir}/Engine.ini"`
      )
      lines.push(`echo "gamectl: wrote mod.io AccessToken to Engine.ini"`)
    } else {
      lines.push(`echo "gamectl: WARNING mods listed but no modioToken set — mods will NOT download" >&2`)
    }
  } else {
    lines.push(`rm -f "${cfgServerDir}/Mods.txt" 2>/dev/null || true`)
  }
  // Update the game then launch. Plain app_update = full download on a fresh
  // volume, fast delta-check when already installed (no 'validate' so restarts
  // don't re-hash the whole ~5G install over NFS every time).
  lines.push(`/home/steam/steamcmd/steamcmd.sh +force_install_dir "${INSTALL_DIR}/" +login anonymous +app_update 581330 +quit`)
  lines.push(
    `exec "${INSTALL_DIR}/Insurgency/Binaries/Linux/InsurgencyServer-Linux-Shipping" ` +
    `"${travel}" ${flags.join(' ')} -Port=${port} -QueryPort=${query} -hostname="$HOSTNAME"`
  )
  return lines.join('\n')
}

export function buildSandstormYaml(f = defaultSandstormForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const name = f.serverName || 'sandstorm'
  const labels = { app: name, game: 'sandstorm', 'app.kubernetes.io/part-of': 'games', 'app.kubernetes.io/managed-by': 'gamectl' }
  const mlbAnno = f.metallbPool ? { annotations: { 'metallb.universe.tf/address-pool': f.metallbPool } } : {}
  const isLocal = (f.storageMode || 'remote') === 'local'
  const docs = []

  docs.push({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: ns, labels } })

  const pvName = `${name}-pv`
  docs.push({
    apiVersion: 'v1', kind: 'PersistentVolume', metadata: { name: pvName, labels },
    spec: isLocal
      ? {
          capacity: { storage: f.dataStorage || '25Gi' },
          accessModes: ['ReadWriteOnce'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'manual',
          hostPath: { path: f.localDataPath || '/mnt/1TBSSD/GameCTL/sandstorm', type: 'DirectoryOrCreate' },
        }
      : {
          capacity: { storage: f.dataStorage || '25Gi' },
          accessModes: ['ReadWriteMany'],
          persistentVolumeReclaimPolicy: 'Retain',
          storageClassName: 'nfs-static',
          nfs: { server: f.nfsServer || '10.0.0.100', path: f.dataPvPath || '/mnt/1TBSSD/GameCTL/sandstorm' },
        },
  })

  const pvcName = `${name}-pvc`
  docs.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: pvcName, namespace: ns, labels }, spec: {
    accessModes: [isLocal ? 'ReadWriteOnce' : 'ReadWriteMany'], resources: { requests: { storage: f.dataStorage || '25Gi' } }, storageClassName: isLocal ? 'manual' : 'nfs-static', volumeName: pvName
  } })

  const port = Number(f.gamePort || 27102)
  const query = Number(f.queryPort || 27131)
  const env = [
    { name: 'HOSTNAME', value: f.hostname || 'GameCTL Insurgency (PVE)' },
  ]

  docs.push({
    apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: ns, labels, ...mlbAnno },
    spec: {
      replicas: 1, selector: { matchLabels: labels },
      // Single-instance game server: stop the old pod before starting the new
      // (avoids two servers on the same NFS install + the 2x-resource surge a
      // rolling update needs).
      strategy: { type: 'Recreate' },
      template: { metadata: { labels }, spec: {
        // Image runs as the 'steam' user (uid 1000); fsGroup lets it write the
        // mounted NFS dirs.
        securityContext: { fsGroup: 1000 },
        containers: [ {
          name: 'server', image: f.image || 'andrewmhub/insurgency-sandstorm:latest', imagePullPolicy: 'Always', env,
          command: ['/bin/bash', '-c'],
          args: [buildCommand(f)],
          ports: [
            { name: 'game-udp', containerPort: port, protocol: 'UDP' },
            { name: 'query-udp', containerPort: query, protocol: 'UDP' },
          ],
          // Two subPaths of the one NFS PVC: the game install AND the mod.io
          // download dir (ISMC lands in /home/steam/mod.io, NOT under the game
          // dir) — both must persist or mods re-download every restart.
          volumeMounts: [
            { name: 'data', mountPath: INSTALL_DIR, subPath: 'server' },
            { name: 'data', mountPath: '/home/steam/mod.io', subPath: 'modio' },
          ],
          resources: { requests: { cpu: f.cpuRequest || '1', memory: f.memRequest || '3Gi' }, limits: { cpu: f.cpuLimit || '3', memory: f.memLimit || '8Gi' } },
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
        { name: 'game-udp', port, targetPort: port, protocol: 'UDP' },
        { name: 'query-udp', port: query, targetPort: query, protocol: 'UDP' },
      ]
    }
  })

  return docs.map(d => yaml.dump(d, { noRefs: true })).join('---\n')
}
