import { defaultCs2Form, buildCs2Yaml, CS2_MODES } from '../utils/cs2Generator'
import { defaultMinecraftForm, buildMinecraftYaml } from '../utils/minecraftGenerator'
import { defaultSatisfactoryForm, buildSatisfactoryYaml } from '../utils/satisfactoryGenerator'
import { defaultValheimForm, buildValheimYaml } from '../utils/valheimGenerator'
import { default7d2dForm, build7d2dYaml } from '../utils/sevendaysGenerator'
import { defaultFactorioForm, buildFactorioYaml } from '../utils/factorioGenerator'
import { defaultWreckfestForm, buildWreckfestYaml } from '../utils/wreckfestGenerator'
import { defaultWreckfest2Form, buildWreckfest2Yaml } from '../utils/wreckfest2Generator'
import { defaultQuake3Form, buildQuake3Yaml } from '../utils/quake3Generator'
import { defaultCorekeeperForm, buildCorekeeperYaml } from '../utils/corekeeperGenerator'
import { defaultTerrariaForm, buildTerrariaYaml } from '../utils/terrariaGenerator'
import { defaultProjectzomboidForm, buildProjectzomboidYaml } from '../utils/projectzomboidGenerator'
import { defaultNecesseForm, buildNecesseYaml } from '../utils/necesseGenerator'
import { defaultLeft4dead2Form, buildLeft4dead2Yaml } from '../utils/left4dead2Generator'
import { defaultSonsoftheforestForm, buildSonsoftheforestYaml } from '../utils/sonsoftheforestGenerator'
import { defaultUnturnedForm, buildUnturnedYaml } from '../utils/unturnedGenerator'
import { defaultLeftfordeadForm, buildLeftfordeadYaml } from '../utils/leftfordeadGenerator'
import { defaultBeammpForm, buildBeammpYaml } from '../utils/beammpGenerator'
import { defaultBarotraumaForm, buildBarotraumaYaml } from '../utils/barotraumaGenerator'
import { defaultAbioticfactorForm, buildAbioticfactorYaml } from '../utils/abioticfactorGenerator'
import { defaultSandstormForm, buildSandstormYaml, SANDSTORM_CHECKPOINT_SCENARIOS, SANDSTORM_ISMC_MUTATORS } from '../utils/sandstormGenerator'
import { defaultSptForm, buildSptYaml } from '../utils/sptGenerator'
import { defaultDayzForm, buildDayzYaml, DAYZ_MISSIONS } from '../utils/dayzGenerator'
import { defaultIw4xForm, buildIw4xYaml, IW4X_GAMETYPES, IW4X_MAPS } from '../utils/iw4xGenerator'
import { defaultPalworldForm, buildPalworldYaml } from '../utils/palworldGenerator'

// -----------------------------------------------------------------------------
// Shared discovery-driven field helpers.
//
// Each returns a field definition consumable by the wizard's Field component.
// They use type: 'remote-select' which fetches options from a backend
// /api/cluster/* endpoint at render time, so the dropdowns always reflect
// the live cluster (pools, free IPs, storage classes) rather than hardcoded
// defaults that drift.
// -----------------------------------------------------------------------------

const poolField = (overrides = {}) => ({
  name: 'metallbPool',
  label: 'MetalLB pool',
  type: 'remote-select',
  endpoint: '/cluster/metallb/pools',
  valueKey: 'name',
  labelKey: 'name',
  placeholder: '— pick a pool (required) —',
  required: true,
  // Highlighted in the wizard: with LAN exposure selected, MetalLB is how
  // the game server gets its raw TCP/UDP address — draw the eye to it.
  emphasis: 'required',
  hint: 'Required for LAN exposure — the server gets a MetalLB LoadBalancer IP (raw TCP/UDP).',
  ...overrides,
})

// Exposure choice injected into every game's Networking step (see the
// post-process at the bottom of this file). "How do players reach this
// server?" — at least one path is always selected:
//   lan      → MetalLB LoadBalancer on the local network (the default)
//   both     → MetalLB + publish through ProxyCTL after deploy
//   proxyctl → no LoadBalancer at all; the Service stays ClusterIP and
//              ProxyCTL's WireGuard gateway reaches it in-cluster
// The wizard hides this field when no ProxyCTL install is detected, and
// rewrites the generated Service to ClusterIP for 'proxyctl'. Publishing
// itself (subdomain + domain + Apply) happens on the server's Networking
// panel after deploy, once the Service's ClusterIP exists.
const exposeField = {
  name: 'expose',
  label: 'Player access',
  type: 'select',
  default: 'lan',
  fullWidth: true,
  options: [
    { value: 'lan', label: 'LAN — MetalLB LoadBalancer IP' },
    { value: 'both', label: 'LAN + Internet — MetalLB now, publish via ProxyCTL after deploy' },
    { value: 'proxyctl', label: 'Internet only — ProxyCTL tunnel (no MetalLB IP)' },
  ],
  hint: 'ProxyCTL detected in your cluster. "Internet" modes tunnel the server through your ProxyCTL droplet — pick a public domain below and the DNS association happens as part of the deploy.',
}

// Deploy-time publish fields (shown for the "Internet" exposure modes).
// The wizard stamps these onto the Deployment as gamectl.io/publish-*
// annotations; after a successful apply the backend creates the ProxyCTL
// entries/web-routes and applies them — deploy + DNS in one action.
// Leaving the domain unset skips auto-publish (the server's Networking
// panel can publish any time).
const publishHostField = {
  name: 'publishHost',
  label: 'Public subdomain',
  type: 'text',
  // Mirrors the actual server name as the input's value until overridden —
  // the operator sees the real hostname they're about to mint, not a
  // placeholder describing it.
  fallbackField: 'serverName',
  hint: 'Game publishes as <subdomain>.<domain>; companion sites (BlueMap, surf records) get <subdomain>-<role>.<domain> over the Cloudflare Tunnel. Rename later from the Networking panel if you want.',
  showIf: (f) => f?.expose === 'both' || f?.expose === 'proxyctl',
}
const publishDomainField = {
  name: 'publishDomain',
  label: 'Public domain (ProxyCTL)',
  type: 'remote-select',
  endpoint: '/proxyctl/domains',
  dataPath: 'domains',
  // Default to the first real domain — publishing is the point of picking
  // an Internet mode; the empty option is the explicit opt-out.
  autoSelectFirst: true,
  placeholder: '— none — publish later from the server page —',
  hint: 'Published automatically at deploy time. Domains come from your linked ProxyCTL (Cloudflare zones + manual); pick the "none" option to skip.',
  showIf: (f) => f?.expose === 'both' || f?.expose === 'proxyctl',
}

const lbIPField = (name = 'lbIP', label = 'LoadBalancer IP', overrides = {}) => ({
  name,
  label,
  type: 'remote-select',
  endpointFn: (f) => f?.metallbPool
    ? `/cluster/metallb/free-ips?pool=${encodeURIComponent(f.metallbPool)}`
    : null,
  dependsOn: 'metallbPool',
  dataPath: 'free',
  placeholder: '— pick a free IP —',
  required: true,
  ...overrides,
})

// Shared container-image field. Version pinning is the one update lever
// that works for EVERY game (most images aren't SteamCMD, so they have no
// runtime auto-update — you update by changing the tag and redeploying).
// Centralized so the field + guidance read identically across every wizard.
const imageField = (overrides = {}) => ({
  name: 'image',
  label: 'Container image',
  type: 'text',
  required: true,
  hint: 'Pin a specific tag (e.g. repo/image:1.2.3) to lock the game version — reproducible, and you can roll back. A floating tag like :latest/:stable always pulls the newest build (handy, but the version moves under you). To update or roll back later: change this tag and redeploy.',
  ...overrides,
})

// Standard storage step fields (used by most games).
//
// StorageClass is intentionally NOT a wizard field: with the static NFS PV
// shape we generate, the storage class name is just a label that PV and
// PVC have to agree on — no provisioner gets called. Generators hardcode
// 'nfs-static' (remote) / 'manual' (hostPath) so the user never has to
// pick something they don't actually need.
// Storage is now an operator-declared NFS location picked from the Storage
// screen (persisted in the gamectl-storage ConfigMap). The wizard resolves
// the chosen location to nfsServer + dataPvPath (= <export>/gamectl/<server>)
// before building YAML, so the unchanged generators keep working. (Longhorn
// / dynamic StorageClass is a later addition.)
// eslint-disable-next-line no-unused-vars
const standardStorageFields = (placeholder) => ([
  { name: 'storageLocation', label: 'NFS storage location', type: 'remote-select',
    endpoint: '/storage/locations', dataPath: 'locations',
    valueKey: 'name', labelKey: 'name', required: true,
    emphasis: 'required',
            hint: 'Required — game data is written to <storage export>/GameCTL/<server name> on the location you pick.',
            placeholder: '— pick a location (manage under Storage) —' },
  { name: 'dataStorage', label: 'Storage size', type: 'text', required: true },
])

// Editable container resources, per game. Defaults are the sane per-game
// values; the operator can tune them in the wizard. Generators read these
// (f.cpuRequest/memRequest/cpuLimit/memLimit) with the same defaults as
// fallback, so blank = default.
// Placeholder echoes the recommended default so a cleared field still
// shows what value GameCTL will fall back to.
// Stepped, not free text: these are Kubernetes Quantities, where "2G" is
// 2×10⁹ bytes rather than 2Gi and a bare number means BYTES — mistakes the
// API accepts silently and the operator only notices as a mis-sized pod.
// CPU steps in millicores, memory in half-Gi.
const resourceFields = (d) => ([
  { name: 'cpuRequest', label: 'CPU request',    type: 'cpu-milli', default: d.cpuReq },
  { name: 'memRequest', label: 'Memory request', type: 'mem-gi',    default: d.memReq },
  { name: 'cpuLimit',   label: 'CPU limit',      type: 'cpu-milli', default: d.cpuLim },
  { name: 'memLimit',   label: 'Memory limit',   type: 'mem-gi',    default: d.memLim },
])
// Generic explainer shown on every Resources step, plus a per-game note.
const RES_HELP =
  'Requests = CPU/RAM guaranteed and reserved for this server when Kubernetes places the pod. ' +
  'Limits = the hard ceiling — exceeding the memory limit OOM-kills the server; going over the CPU ' +
  'limit only throttles it. The values below are sane defaults for this game; tune them if needed.'

const resourceStep = (d) => ({
  id: 'resources',
  title: 'Resources',
  note: d.desc ? `${RES_HELP}\n\n${d.desc}` : RES_HELP,
  fields: resourceFields(d),
})

// Per-game resource defaults (mirror the generator fallbacks) + a one-line
// description of why those numbers fit that game. Minecraft is intentionally
// blank → the generator derives it from the JVM Memory field (request=heap,
// limit=heap+1Gi), so changing Memory keeps them in sync.
const RES = {
  minecraft:    { cpuReq: '1', memReq: '3Gi', cpuLim: '2', memLim: '5Gi',
    desc: 'Minecraft: recommended defaults sized for the default 4G JVM heap — memory request = heap − 1Gi (real working-set sits below the configured heap, so we avoid over-reserving), memory limit = heap + 1Gi (caps a runaway). If you change the Memory field substantially, tune these to match (≈ heap−1Gi request / heap+1Gi limit).' },
  valheim:      { cpuReq: '500m', memReq: '2Gi',   cpuLim: '2', memLim: '5Gi',
    desc: 'Valheim: a single mostly-serial world sim. ~2Gi covers a typical world; the 5Gi cap absorbs world-save spikes. Raise the request for large worlds / many players.' },
  cs2:          { cpuReq: '1', memReq: '2Gi',   cpuLim: '4', memLim: '6Gi',
    desc: 'CS2 (GameCTL cs2-kube image): CPU-bound per tick; a SteamCMD validate (first install / auto-update) is memory-hungry. 1–4 CPU covers 128-tick; 2Gi steady / 6Gi cap keeps validate from being OOM-killed. Bump CPU for high player counts / GOTV.' },
  factorio:     { cpuReq: '500m', memReq: '1Gi',   cpuLim: '2', memLim: '2Gi',
    desc: 'Factorio: UPS is single-core CPU-bound and memory grows with map size. 1Gi/2Gi suits early–mid games — raise memory for megabases.' },
  quake3:       { cpuReq: '250m', memReq: '256Mi', cpuLim: '1', memLim: '512Mi',
    desc: 'Quake 3: tiny by modern standards. A fraction of a core and 256–512Mi RAM handle a full server.' },
  wreckfest2:   { cpuReq: '1',    memReq: '2Gi',   cpuLim: '4', memLim: '6Gi',
    desc: 'Wreckfest 2 (GameCTL wreckfest2-kube image): the Windows server runs under Wine + a virtual display, which adds a little CPU/memory overhead on top of the game itself. 2Gi steady / 6Gi cap with up to 4 CPU covers a 24-player grid with bots.' },
  wreckfest:    { cpuReq: '1',    memReq: '2Gi',   cpuLim: '4', memLim: '6Gi',
    desc: 'Wreckfest (GameCTL wreckfest-kube image): the Windows server runs under Wine + a virtual display. 2Gi steady / 6Gi cap with up to 4 CPU covers a full 24-player grid.' },
  sonsoftheforest: { cpuReq: '1', memReq: '3Gi',  cpuLim: '4', memLim: '8Gi',
    desc: 'Sons of the Forest (Wine): the Unity world sim is memory-hungry. 3Gi steady / 8Gi cap with up to 4 CPU for an 8-player world.' },
  abioticfactor: { cpuReq: '1',  memReq: '2Gi',   cpuLim: '4', memLim: '6Gi',
    desc: 'Abiotic Factor (Wine): UE server, light for a co-op title. 2Gi steady / 6Gi cap with up to 4 CPU covers 6 players.' },
  left4dead2:   { cpuReq: '500m', memReq: '1Gi',   cpuLim: '2', memLim: '4Gi',
    desc: 'L4D2 srcds is light by modern standards: 1Gi steady / 4Gi cap and 2 CPU covers an 8-player campaign with room for addons.' },
  leftfordead:  { cpuReq: '500m', memReq: '1Gi',   cpuLim: '2', memLim: '4Gi',
    desc: 'L4D1 srcds mirrors L4D2: 1Gi steady / 4Gi cap and 2 CPU is comfortable for 8 players.' },
  unturned:     { cpuReq: '500m', memReq: '2Gi',   cpuLim: '2', memLim: '6Gi',
    desc: 'Unturned (Unity headless): ~2Gi steady, more with big maps/mods; 6Gi cap with 2 CPU covers a 24-player vanilla map.' },
  beammp:       { cpuReq: '250m', memReq: '512Mi', cpuLim: '2', memLim: '2Gi',
    desc: 'The BeamMP server only relays physics between clients — it is very light. Mods (Resources) mostly cost disk, not RAM.' },
  satisfactory: { cpuReq: '1',    memReq: '2Gi',   cpuLim: '4', memLim: '8Gi',
    desc: 'Satisfactory: the factory tick is heavy and the save grows over time. ~2Gi steady reservation with an 8Gi cap and up to 4 CPU; raise the request as the save grows large.' },
  sevendays:    { cpuReq: '1',    memReq: '3Gi',   cpuLim: '2', memLim: '6Gi',
    desc: '7 Days to Die: heavy world + zombie sim. ~3Gi steady reservation with a 6Gi cap and 1–2 CPU; raise the request for larger maps / more players.' },
  sandstorm:    { cpuReq: '1',    memReq: '3Gi',   cpuLim: '3', memLim: '8Gi',
    desc: 'Insurgency: Sandstorm (UE4): CPU-bound per tick with AI-heavy Checkpoint PVE. 3Gi steady / 8Gi cap and 1–3 CPU; ISMC + many bots use more.' },
  spt:          { cpuReq: '1',    memReq: '2Gi',   cpuLim: '2', memLim: '8Gi',
    desc: 'SPT + Fika (stash/hideout/trader backend only, NOT the headless raid client): mostly idle serving the persistent backend. ~2Gi steady / 8Gi cap and 1–2 CPU is plenty; the heavy raid simulation runs on players\' own game clients, not here.' },
  corekeeper:   { cpuReq: '500m', memReq: '1Gi',   cpuLim: '2', memLim: '4Gi',
    desc: 'Core Keeper: light. ~1Gi steady / 4Gi cap matches the known-good live deploy; raise for big worlds / many players.' },
  terraria:     { cpuReq: '250m', memReq: '512Mi', cpuLim: '1', memLim: '2Gi',
    desc: 'Terraria: very light. 512Mi/2Gi and a fraction of a core handle a full server; large worlds use a little more.' },
  projectzomboid: { cpuReq: '1', memReq: '2Gi', cpuLim: '2', memLim: '5Gi',
    desc: 'Project Zomboid: Java, moderately heavy and grows with explored map / players. ~2Gi steady, 5Gi cap.' },
  necesse:      { cpuReq: '250m', memReq: '512Mi', cpuLim: '1', memLim: '1Gi',
    desc: 'Necesse: tiny Java server. 512Mi/1Gi and a fraction of a core is plenty.' },
  left4dead2:   { cpuReq: '500m', memReq: '1Gi', cpuLim: '2', memLim: '2Gi',
    desc: 'Left 4 Dead 2: light Source-engine server. ~1Gi/2Gi and 0.5–2 CPU per campaign.' },
  beammp:       { cpuReq: '500m', memReq: '1Gi', cpuLim: '2', memLim: '2Gi',
    desc: 'BeamMP: standalone server, light–medium. ~1Gi/2Gi; physics sync scales with players.' },
  barotrauma:   { cpuReq: '500m', memReq: '1Gi', cpuLim: '2', memLim: '2Gi',
    desc: 'Barotrauma: light–medium. ~1Gi/2Gi and 0.5–2 CPU for a typical crew.' },
  dayz:         { cpuReq: '1', memReq: '2Gi', cpuLim: '2', memLim: '6Gi',
    desc: 'DayZ (SteamCMD, official Linux dedicated server — not Wine): the persistence/AI sim is single-thread-heavy and memory grows with players and loot. 1 CPU / 2Gi steady with a 2 CPU / 6Gi cap suits ~20 players; the 6Gi headroom also covers the memory-hungry SteamCMD download on first boot.' },
  iw4x:         { cpuReq: '1', memReq: '2Gi', cpuLim: '2', memLim: '4Gi',
    desc: 'IW4X (MW2 under Wine): a 2009 engine, modest even with Wine\'s overhead. 1 CPU / 2Gi steady with a 2 CPU / 4Gi cap covers an 18-player server with bots.' },
  palworld:     { cpuReq: '1', memReq: '8Gi', cpuLim: '4', memLim: '12Gi',
    desc: 'Palworld: the heaviest server here by some margin. UE5 plus per-player pal simulation means ~8Gi is a working floor rather than a pessimistic guess, and it climbs with base size and world age. The 12Gi cap is deliberately below a 16GB node\'s allocatable so the node stays schedulable for anything else.' },
}

export const games = [
  {
    id: 'quake3',
    name: 'Quake 3 Arena',
    short: 'Q3A',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2200/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2200/header.jpg',
    defaults: defaultQuake3Form,
    toYaml: buildQuake3Yaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'Game data is NOT distributed with the image (the engine is open-source ioquake3; the paks are not). After deploy, copy your legally owned baseq3/pak0.pk3 (plus pak1-8 from the 1.32 point release) into the volume — the server waits with instructions until they exist, and file ownership is fixed automatically on boot.',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'GameCTL\'s own from-scratch image — the GPL ioquake3 engine compiled from source. Game paks are operator-supplied on the volume.' }),
        { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
        { name: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 64 },
        { name: 'startMap', label: 'Boot map', type: 'text', placeholder: 'q3dm7' },
        { name: 'serverPassword', label: 'Join password (optional)', type: 'text' },
        { name: 'rconPassword', label: 'RCON password (optional)', type: 'text' },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/GameCTL/quake3') },
      resourceStep(RES.quake3),
      { id: 'network', title: 'Networking', fields: [
        { name: 'serverPort', label: 'Game port (UDP)', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'minecraft',
    name: 'Minecraft',
    short: 'MC',
    icon: 'https://commons.wikimedia.org/wiki/Special:FilePath/Minecraft-creeper-face.svg',
    cover: 'https://commons.wikimedia.org/wiki/Special:FilePath/Minecraft-creeper-face.svg',
    defaults: defaultMinecraftForm,
    toYaml: buildMinecraftYaml,
    steps: [
      {
        id: 'general',
        title: 'General',
        fields: [
          { name: 'serverName', label: 'Server name', type: 'text', required: true },
          { name: 'namespace', label: 'Namespace', type: 'text', required: true },
          imageField(),
          { name: 'memory', label: 'Memory (JVM heap)', type: 'memory-g', required: true,
            min: 1, max: 32,
            hint: 'Whole GB, stepped — the value is written straight into MEMORY (e.g. 4G) and the container request/limit are derived from it (heap−1Gi / heap+1Gi). Anything the generator can\'t parse silently reverts to 4G, so this is not free text.' },
          { name: 'rconPassword', label: 'RCON password', type: 'text', default: 'ChangeMe12345',
            hint: 'Enables the in-app server console (op players, list, say, run any command). Internal-only — keep this port off any public tunnel.' },
          { name: 'type', label: 'Type', type: 'select', options: [
            { label: 'Paper', value: 'PAPER' },
            { label: 'Vanilla', value: 'VANILLA' },
          ] },
          { name: 'mcVersion', label: 'Minecraft version', type: 'text', placeholder: 'LATEST',
            hint: 'LATEST tracks the newest release on each restart. Pin a version (e.g. 26.1.2) to protect an existing world — worlds are version-bound and upgrades are one-way.' },
        ],
      },
      {
        id: 'storage',
        title: 'Storage',
        fields: [
          { name: 'storageLocation', label: 'NFS storage location', type: 'remote-select',
            endpoint: '/storage/locations', dataPath: 'locations',
            valueKey: 'name', labelKey: 'name', required: true,
            emphasis: 'required',
            hint: 'Required — game data is written to <storage export>/GameCTL/<server name> on the location you pick.',
            placeholder: '— pick a location (manage under Storage) —' },
          { name: 'dataStorage', label: 'World storage size', type: 'text', required: true },
        ],
      },
      resourceStep(RES.minecraft),
      {
        id: 'network',
        title: 'Networking',
        fields: [
          { name: 'minecraftPort', label: 'Minecraft TCP port', type: 'number', required: true, min: 1, max: 65535 },
          poolField(),
          lbIPField('minecraftLbIP', 'LoadBalancer IP (MC)', { exclude: ['bluemapLbIP'] }),
        ],
      },
      {
        id: 'bluemap',
        title: 'BlueMap',
        fields: [
          { name: 'bluemapEnabled', label: 'Enable BlueMap', type: 'select', options: [ {label:'Yes', value:1}, {label:'No', value:0} ] },
          // BlueMap tiles live on a subdirectory of the main Minecraft data
          // volume (/data/bluemap/web) — there is no separate BlueMap PV,
          // so bluemapStorage / localBluemapPath were dead fields (blank,
          // ignored by the generator) and have been removed.
          // Defaults to accepted: the wizard deploy already accepts the
          // Mojang EULA (generator bakes EULA=TRUE) and BlueMap's download
          // gate mirrors that same EULA — "Yes" is what makes the map
          // actually come up. The "No" option remains the explicit opt-out.
          { name: 'bluemapAcceptDownload', label: 'Accept BlueMap downloads (EULA)', type: 'select',
            options: [ {label:'Yes — I accept (same Mojang EULA the server runs under)', value:1}, {label:'No — map stays down until accepted', value:0} ],
            showIf: (f)=> Number(f.bluemapEnabled) === 1,
            hint: 'BlueMap downloads Minecraft client assets to render the 3D tiles, gated behind the same Mojang EULA your server already accepts by deploying. Set "No" to keep BlueMap installed but its map/webserver down. Minecraft EULA: https://aka.ms/MinecraftEULA' },
          { name: 'bluemapPort', label: 'BlueMap port', type: 'number', min:1, max:65535 },
          lbIPField('bluemapLbIP', 'LoadBalancer IP (BlueMap)', { required: false, showIf: (f)=> Number(f.bluemapEnabled) === 1, exclude: ['minecraftLbIP'] }),
        ],
      },
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'valheim',
    name: 'Valheim',
    short: 'VH',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/892970/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/892970/header.jpg',
    defaults: defaultValheimForm,
    toYaml: buildValheimYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
        { name: 'serverNameDisplay', label: 'Display name', type: 'text' },
        { name: 'worldName', label: 'World name', type: 'text' },
        { name: 'serverPass', label: 'Password — REQUIRED, 5+ chars (server won\'t start without it)', type: 'text', required: true, minlength: 5, default: 'ChangeMe12345' },
        { name: 'serverPublic', label: 'Public listing', type: 'select', options: [ {label:'Yes', value:1}, {label:'No', value:0} ] },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/valheim') },
      resourceStep(RES.valheim),
      { id: 'network', title: 'Networking', fields: [
        { name: 'serverPort', label: 'Base UDP port', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: '7d2d',
    name: '7 Days to Die',
    short: '7D2D',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/251570/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/251570/header.jpg',
    defaults: default7d2dForm,
    toYaml: build7d2dYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/7d2d') },
      resourceStep(RES.sevendays),
      { id: 'network', title: 'Networking', fields: [
        { name: 'serverPort', label: 'Game port (also opens +1/+2 UDP for Steam)', type: 'number', required: true },
        { name: 'telnetPort', label: 'Telnet port', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'sandstorm',
    name: 'Insurgency: Sandstorm',
    short: 'ISS',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/581320/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/581320/header.jpg',
    defaults: defaultSandstormForm,
    toYaml: buildSandstormYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
        { name: 'hostname', label: 'In-game server name', type: 'text', required: true },
        { name: 'maxPlayers', label: 'Max players (co-op slots)', type: 'number', required: true,
          hint: 'Checkpoint PVE is typically 6–8 human players vs bots.' },
        { name: 'serverPassword', label: 'Join password', type: 'text', placeholder: 'optional' },
      ]},
      { id: 'steam', title: 'Steam & Listing', fields: [
        { name: 'gslt', label: 'GSLT (game server login token)', type: 'text',
          placeholder: 'app-581330 token — recommended for public listing',
          hint: 'Create one for App ID 581330 for a persistent identity + public server-browser listing:',
          helpUrl: 'https://steamcommunity.com/dev/managegameservers', helpLabel: 'Get a GSLT (App ID 581330) ↗' },
        { name: 'gameStatsToken', label: 'Game Stats token', type: 'text', placeholder: 'optional — community stats' },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/GameCTL/sandstorm') },
      { id: 'scenario', title: 'Scenario & Mods', fields: [
        { name: 'scenario', label: 'PVE Checkpoint scenario', type: 'select', required: true,
          options: SANDSTORM_CHECKPOINT_SCENARIOS,
          hint: 'Checkpoint = co-op vs AI bots. The map rotates through its Checkpoint objectives.' },
        { name: 'ismcEnabled', label: 'ISMC mod pack', type: 'select',
          options: [ { label: 'Off — vanilla weapons', value: 0 }, { label: 'On — ISMC (mod.io 150867)', value: 1 } ],
          hint: 'ISMC overhauls weapons/attachments. Enabling adds mod.io id 150867 to Mods.txt and launches with -Mods; clients auto-download it from mod.io on join.' },
        { name: 'modioToken', label: 'mod.io OAuth access token', type: 'text',
          showIf: (f) => Number(f.ismcEnabled) === 1, required: true, emphasis: 'required',
          placeholder: 'OAuth access token (eyJ… JWT) — REQUIRED for mods',
          hint: 'Mods will NOT download without this. Log in (or create a free mod.io account), then mint an OAuth 2 ACCESS TOKEN (the long eyJ… JWT, not the short API key) from the Access page:',
          helpUrl: 'https://mod.io/me/access#tokens', helpLabel: 'Get your mod.io OAuth access token (login required) ↗' },
        { name: 'ismcMutator', label: 'ISMC theater mutator', type: 'select',
          options: SANDSTORM_ISMC_MUTATORS, showIf: (f) => Number(f.ismcEnabled) === 1,
          hint: 'Pick exactly one theater ruleset (guns/classes).' },
        { name: 'extraMutators', label: 'Extra mutators (comma-separated)', type: 'text',
          placeholder: 'e.g. ISMCJumpShoot', showIf: (f) => Number(f.ismcEnabled) === 1 },
        { name: 'extraMods', label: 'Extra mod.io IDs (comma/space-separated)', type: 'text',
          placeholder: 'optional — added to Mods.txt', showIf: (f) => Number(f.ismcEnabled) === 1 },
      ]},
      resourceStep(RES.sandstorm),
      { id: 'network', title: 'Networking', fields: [
        { name: 'gamePort', label: 'Game port (UDP)', type: 'number', required: true },
        { name: 'queryPort', label: 'Query port (UDP)', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'spt',
    name: 'SPT + Fika (Tarkov co-op)',
    short: 'SPT',
    // SPT/Fika has no Steam app; the old 1259420 URLs were Days Gone. Vendored
    // locally (public/brand/tiles) so they're stable and embedded in the binary.
    icon: '/brand/tiles/icon-spt.png',
    cover: '/brand/tiles/cover-spt.jpg',
    defaults: defaultSptForm,
    toYaml: buildSptYaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'The persistent SPT + Fika co-op backend (stash / hideout / traders / profiles). Uses GameCTL\'s own image (repo: Tarkov-SPT-Castro-Fika-Kube), built from scratch with SPT + the current Fika server baked in — so it tracks the latest Fika client and deploys from an empty volume, no manual seeding. This is NOT the Fika headless raid client.',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'GameCTL SPT+Fika image (ghcr.io/gamectl-hq/tarkov-spt-castro-fika-kube) — the TAG encodes SPT + Fika versions (spt<sptver>-fika<fikaver>). A weekly Action publishes new tags as Fika updates; point here at a newer tag to move up.' }),
        { name: 'modSync', label: 'Mod sync (NARCONet)', type: 'select',
          options: [ { label: 'On — auto-sync mods to every player (recommended)', value: 1 }, { label: 'Off', value: 0 } ],
          hint: 'Installs the NARCONet server mod so every player is kept on the same mod set, with an on-launch update check. Works on SPT 4.0.x (the C# mod). Served over 6969 — no extra port. Players install the matching NARCONet client (see docs/SPT_FIKA_MODSYNC.md).' },
        { name: 'modSyncUrl', label: 'NARCONet download URL', type: 'text', showIf: (f) => Number(f.modSync) === 1,
          placeholder: 'GitHub release .zip URL',
          hint: 'Full URL to the NARCONet release zip (server mod is auto-installed; players drop the BepInEx plugin from the same zip). Default is the un-gated GitLab package (currently 1.0.16); keep server + players on the same version.',
          helpUrl: 'https://forge.sp-tarkov.com/mod/2441/narconet-mod-sync', helpLabel: 'NARCONet on the Forge ↗' },
        { name: 'headless', label: 'Headless raid host support', type: 'select',
          options: [ { label: 'Off (default)', value: 0 }, { label: 'On — create a headless profile + pin forceIp', value: 1 } ],
          hint: 'Patches fika.jsonc so the server creates one headless-client profile and advertises this server\'s LoadBalancer URL to it. The headless client itself is the full EFT game client (16-32Gi RAM) and runs on a SEPARATE machine — this toggle only prepares the server side. Profile ID appears under user/profiles after a restart. On fresh installs it takes effect from the second boot (fika.jsonc is written on first boot).',
          helpUrl: 'https://wiki.project-fika.com/advanced-features/headless-client', helpLabel: 'Fika headless docs ↗' },
      ]},
      { id: 'storage', title: 'Storage',
        note: 'Deploys from an empty volume — the image installs SPT + Fika itself. Server files, mods, profiles and daily backups persist at <location>/GameCTL/<server> (mounted /opt/server).',
        fields: standardStorageFields('/mnt/1TBSSD/GameCTL/fika') },
      resourceStep(RES.spt),
      { id: 'network', title: 'Networking', fields: [
        { name: 'httpPort', label: 'SPT/Fika port (TCP — clients connect here)', type: 'number', required: true },
        { name: 'fikaUdpPort', label: 'Fika relay UDP port (dedicated/relay setups)', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'dayz',
    name: 'DayZ',
    short: 'DZ',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/221100/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/221100/header.jpg',
    defaults: defaultDayzForm,
    toYaml: buildDayzYaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'DayZ\'s dedicated server (Steam app 223350) is NOT anonymously downloadable — SteamCMD must log in with an account that OWNS DayZ. Save one under Steam (header nav) first; this deploy references that shared write-only Secret, and without it the pod stops at CreateContainerConfigError instead of booting. Use a dedicated secondary account with Steam Guard 2FA disabled — headless SteamCMD cannot answer a 2FA prompt. First boot downloads ~15G, so expect several minutes before the server answers.',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'ich777\'s SteamCMD image with the DayZ entrypoint (Docker Hub: ich777/steamcmd:dayz). Any image that reads USERNAME/PASSWRD/GAME_ID/GAME_PARAMS and installs to /serverdata/serverfiles works — the manifest sets those explicitly rather than relying on image defaults.' }),
        { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
        { name: 'mission', label: 'Map / mission', type: 'select', options: DAYZ_MISSIONS,
          hint: 'The vanilla missions that ship with the server. A custom mission folder copied onto the volume can be used by turning the managed-config toggle off and pointing serverDZ.cfg at it.' },
        { name: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 127 },
        { name: 'serverPassword', label: 'Join password (optional)', type: 'text' },
        { name: 'adminPassword', label: 'Admin password', type: 'text', default: 'ChangeMe12345',
          hint: 'passwordAdmin in serverDZ.cfg — grants the in-game admin/#login commands. Keep it off any public tunnel.' },
        { name: 'timeAcceleration', label: 'Time acceleration', type: 'number', min: 1, max: 64,
          hint: 'serverTimeAcceleration — 1 is real time, 12 gives a ~2h day/night cycle.' },
        { name: 'thirdPerson', label: 'Third person', type: 'select', options: [
          { label: 'Allowed', value: 1 },
          { label: 'First person only', value: 0 },
        ]},
        { name: 'manageConfig', label: 'GameCTL manages the server config', type: 'select', options: [
          { label: 'Yes — write gamectl.cfg from these fields each boot', value: 1 },
          { label: 'No — I\'ll hand-edit serverDZ.cfg on the volume', value: 0 },
        ], hint: 'On: the fields above are rendered to gamectl.cfg on every boot and the server launches with -config=gamectl.cfg. The image\'s stock serverDZ.cfg is never touched, so switching this off hands you a clean file to edit.' },
        { name: 'validateOnStart', label: 'Validate install on next start', type: 'select', options: [
          { label: 'No — fast delta-check (default)', value: false },
          { label: 'Yes — full SteamCMD validate', value: true },
        ], hint: 'A validate re-hashes the whole ~15G install over NFS. Worth it after a corrupt update, wasteful on every boot.' },
      ]},
      { id: 'storage', title: 'Storage',
        note: 'The game install (~15G), configs, profiles/logs and persistence all live at <location>/GameCTL/<server name>. 50Gi is a sane starting size; a long-lived persistence database grows.',
        fields: standardStorageFields('/mnt/1TBSSD/GameCTL/dayz') },
      resourceStep(RES.dayz),
      { id: 'network', title: 'Networking', fields: [
        { name: 'gamePort', label: 'Game port (UDP)', type: 'number', required: true },
        { name: 'queryPort', label: 'Steam query port (UDP)', type: 'number', required: true,
          hint: 'Written into the config as steamQueryPort and used by the in-app health probe for live player counts.' },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'iw4x',
    name: 'IW4X (Modern Warfare 2)',
    short: 'IW4X',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/10180/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/10180/header.jpg',
    defaults: defaultIw4xForm,
    toYaml: buildIw4xYaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'IW4X is the community server platform for Call of Duty: Modern Warfare 2 (2009). GameCTL\'s own iw4x-kube image is a Wine runtime only — it downloads nothing. You supply the whole game directory: your legally owned MW2 install with IW4x installed into it client-side (the Storage step prints the copy commands). Missing files are reported by name and the pod exits, rather than sitting there looking healthy. DLC is optional; base-map-only installs are normal.',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'GameCTL\'s own iw4x-kube (source: images/iw4x-kube/) — Debian + 32-bit Wine, a persistent Wine prefix on the volume, file validation, and clean SIGTERM shutdown. It replaces ich777/iw4x-server, which is abandoned upstream and whose IW4x and DLC download URLs are both dead domains that ended in an infinite sleep.' }),
        { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
        { name: 'motd', label: 'MOTD', type: 'text' },
        { name: 'gametype', label: 'Game mode', type: 'select', options: IW4X_GAMETYPES },
        { name: 'startMap', label: 'Boot map', type: 'select', options: IW4X_MAPS,
          hint: 'Base MW2 maps. DLC maps (Stimulus / Resurgence) only exist if your copy has them — add them to a rotation via "Extra server.cfg lines".' },
        { name: 'maxClients', label: 'Max clients', type: 'number', min: 1, max: 18 },
        { name: 'spectateMode', label: 'Spectating', type: 'select', options: [
          { label: 'Free — spectate anyone', value: 2 },
          { label: 'Team only (MW2 default)', value: 1 },
          { label: 'Off — no spectating', value: 0 },
        ], hint: 'scr_game_spectatetype. Free lets a player watch anyone on either team; team-only restricts them to their own side.' },
        { name: 'mapRotation', label: 'Map rotation', type: 'text',
          placeholder: 'mp_afghan, mp_rust, mp_terminal',
          hint: 'Comma-separated map ids, played in order at the end of each match; append :gametype to mix modes (mp_rust:dom). Defaults to all 16 base maps — do not clear it lightly. IW4x parses this ONCE, at the first match end: if it is empty then, rotation is dead for the life of the process and no later change can revive it without a restart. Editing this field therefore needs a redeploy to take effect.' },
        { name: 'serverPassword', label: 'Join password (optional)', type: 'text' },
        { name: 'rconPassword', label: 'RCON password', type: 'text', default: 'ChangeMe12345',
          hint: 'RCON rides the same UDP port as the game — keep that port off any public tunnel.' },
      ]},
      { id: 'bots', title: 'Bots',
        note: 'Two different bot systems, and the difference matters: only Bot Warfare gives you bots that MOVE. IW4x\'s built-in bots have no waypoints — they spawn and stand still — and no fill setting, so GameCTL spawns them over RCON instead.',
        fields: [
        { name: 'botSystem', label: 'Bot system', type: 'select', options: [
          { label: 'Bot Warfare mod — bots navigate and fight (recommended)', value: 'botwarfare' },
          { label: 'IW4x built-in — bots spawn but do not move', value: 'builtin' },
          { label: 'No bots', value: 'off' },
        ], hint: 'Bot Warfare is a GSC mod you install onto the volume yourself: extract the release into the game root so it lands at mods/mp_bots/z_svr_bots.iwd (it brings 479 MW2 waypoint files). Note mods/mp_bots — NOT mods/bots, a common misreading that leaves fs_game pointing at an empty folder with no error anywhere.',
          helpUrl: 'https://github.com/ineedbots/iw4_bot_warfare/releases', helpLabel: 'Bot Warfare releases ↗' },
        { name: 'fsGame', label: 'Mod folder (fs_game)', type: 'text', placeholder: 'mods/mp_bots',
          hint: 'Must point at the installed mod for Bot Warfare to load. Blank = vanilla. The image warns in its log if this names a folder that does not exist on the volume.' },
        { name: 'botCount', label: 'Bots', type: 'number', min: 1, max: 17, default: 12,
          showIf: (f) => f.botSystem === 'botwarfare' || f.botSystem === 'builtin',
          hint: 'Bot Warfare keeps the server topped up to this many players (bots_manage_fill) and kicks bots as humans join. Built-in bots are spawned once at boot.' },
        { name: 'botSkill', label: 'Bot skill (1–7)', type: 'number', min: 1, max: 7,
          showIf: (f) => f.botSystem === 'botwarfare',
          hint: 'bots_skill — Bot Warfare only.' },
        { name: 'botMenuGuids', label: 'Bot menu admins (GUIDs)', type: 'text',
          showIf: (f) => f.botSystem === 'botwarfare',
          placeholder: 'e.g. 1a2b3c4d5e6f7890, 110000100000000',
          hint: 'Comma-separated player GUIDs allowed to open Bot Warfare\'s in-game menu (Action Slot 2, default the "5" key) to tune bots live. On a dedicated server nobody is the "host", so without this the menu cannot be opened by anyone. Find a GUID in the roster above, or run `status` in the console. The check runs on CONNECT — add yourself, then rejoin.' },
        { name: 'botNames', label: 'Bot names', type: 'text',
          showIf: (f) => f.botSystem === 'botwarfare' || f.botSystem === 'builtin',
          placeholder: 'Ghost, Roach, Soap, Price',
          hint: 'Comma-separated. Written to userraw/bots.txt, which IW4x reads at startup — so a change takes effect on the next restart, and names are capped at 16 characters. Leave blank to keep whatever is on the volume (the image seeds a default list on first boot).' },
        { name: 'teamBalance', label: 'Auto team balance', type: 'select', options: [
          { label: 'On (scr_teambalance 1)', value: 1 },
          { label: 'Off', value: 0 },
        ]},
        { name: 'extraCfg', label: 'Extra server.cfg lines', type: 'text',
          hint: 'Appended verbatim at the end of server.cfg, so these win over everything above. Separate multiple dvars with semicolons, e.g. set scr_war_scorelimit "7500"; set sv_maxPing "180".',
          helpUrl: 'https://docs.iw4x.io/hosting/server-hosting/', helpLabel: 'IW4X server hosting docs ↗' },
        { name: 'manageConfig', label: 'GameCTL manages server.cfg', type: 'select', options: [
          { label: 'Yes — write server.cfg from these fields each boot', value: 1 },
          { label: 'No — I\'ll maintain players/server.cfg on the volume', value: 0 },
        ], hint: 'Written to players/server.cfg, which is where IW4x reads it from.' },
        { name: 'iw4xBinary', label: 'IW4x executable', type: 'text', placeholder: 'iw4x.exe',
          hint: 'The Windows binary the image launches under Wine. The IW4x launcher installs iw4x.exe — change this only if your install names it differently.' },
      ]},
      { id: 'storage', title: 'Storage',
        note: 'IW4X installs itself here on first boot; your MW2 files go in the same directory. Budget ~25Gi for MW2 (~14G) plus IW4X, mods and logs.',
        // The one hard prerequisite this game has. Rendered as copy-paste
        // commands with the real host/path substituted, because "put your game
        // files somewhere" is exactly the instruction people get wrong.
        seedTitle: 'Copy your MW2 + IW4x install (before first boot)',
        seedNote: 'Copy the folder AFTER installing IW4x into it client-side, so it contains iw4x.exe and iw4x.dll alongside your MW2 files. iw4x-kube never downloads game content — this copy IS the install. Paths below come from the Storage Location you picked.',
        seedBuilder: ({ nfsHost, installBase, namespace, serverName }) => ([
          '# Source: your MW2 folder WITH IW4x already installed into it',
          '#   (Steam: steamapps/common/Call of Duty Modern Warfare 2)',
          '# Must contain: iw4x.exe  iw4x.dll  main/  zone/  (+ zone/<language>)',
          '# DLC maps: main/iw_dlc3_00.iwd — without it the container sleeps waiting on a dead DLC URL',
          '',
          nfsHost
            ? `rsync -av --info=progress2 "/path/to/Call of Duty Modern Warfare 2/" root@${nfsHost}:${installBase}/`
            : `rsync -av --info=progress2 "/path/to/Call of Duty Modern Warfare 2/" ${installBase}/`,
          '',
          '# No shell on the storage host? Stream it through the running pod instead:',
          `# kubectl -n ${namespace} cp "/path/to/Call of Duty Modern Warfare 2/main" \\`,
          `#   $(kubectl -n ${namespace} get pod -l app=${serverName} -o name | head -1 | cut -d/ -f2):/iw4x/main`,
          '',
          '# Then fix ownership so the server (uid 1000) can read them:',
          nfsHost ? `# ssh root@${nfsHost} chown -R 1000:1000 ${installBase}` : `# chown -R 1000:1000 ${installBase}`,
        ].join('\n')),
        fields: standardStorageFields('/mnt/1TBSSD/GameCTL/iw4x') },
      resourceStep(RES.iw4x),
      { id: 'network', title: 'Networking', fields: [
        { name: 'gamePort', label: 'Game port (TCP + UDP)', type: 'number', required: true,
          hint: 'IW4X uses one port for the game and RCON. 28960 is the default clients expect.' },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'factorio',
    name: 'Factorio',
    short: 'FACT',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/427520/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/427520/header.jpg',
    defaults: defaultFactorioForm,
    toYaml: buildFactorioYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
        { name: 'rconPassword', label: 'RCON password', type: 'text', default: 'ChangeMe12345',
          hint: 'Enables the in-app server console. Internal-only — keep this port off any public tunnel.' },
        { name: 'visibility', label: 'Who can find and join', type: 'select', fullWidth: true,
          options: [
            { label: 'Open / LAN — no factorio.com account required', value: 'lan' },
            { label: 'Public — listed on the factorio.com server browser', value: 'public' },
          ],
          hint: 'Open/LAN: unlisted, and players join without being verified against factorio.com. Public: listed in the in-game browser, and every player must own a verified copy. Re-applied on every restart, so you can switch later by redeploying.' },
        { name: 'factorioUsername', label: 'factorio.com username', type: 'text',
          showIf: (f) => f.visibility === 'public',
          emphasis: 'required',
          hint: 'Required to list publicly — the server will not appear in the browser without valid credentials.' },
        { name: 'authMethod', label: 'Authenticate with', type: 'select',
          showIf: (f) => f.visibility === 'public',
          options: [
            { label: 'Token (recommended)', value: 'token' },
            { label: 'Account password', value: 'password' },
          ],
          hint: 'Factorio accepts either. A token is scoped to the server and you can revoke it from your profile; the password is your whole factorio.com account.' },
        { name: 'factorioToken', label: 'factorio.com token', type: 'text',
          showIf: (f) => f.visibility === 'public' && (f.authMethod || 'token') === 'token',
          emphasis: 'required',
          helpUrl: 'https://factorio.com/profile', helpLabel: 'Get your token ↗',
          hint: 'From your factorio.com profile page. Stored in the Deployment env, same as the RCON password.' },
        { name: 'factorioPassword', label: 'factorio.com password', type: 'text',
          showIf: (f) => f.visibility === 'public' && f.authMethod === 'password',
          emphasis: 'required',
          hint: 'Your factorio.com account password. Stored in plaintext in the Deployment env — prefer a token if you can.' },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/factorio') },
      resourceStep(RES.factorio),
      { id: 'network', title: 'Networking', fields: [
        { name: 'gamePort', label: 'Game port (UDP)', type: 'number', required: true },
        { name: 'queryPort', label: 'Steam query (UDP)', type: 'number', required: true },
        { name: 'rconPort', label: 'RCON port (TCP)', type: 'number', required: true,
          hint: 'Drives the in-app console. 27015 is the Source default, so CS2 / Project Zomboid may already hold it — move this if you want them distinct. Internal-only either way: never forward it on a public tunnel.' },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'wreckfest',
    name: 'Wreckfest',
    short: 'WRECK',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/228380/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/228380/header.jpg',
    defaults: defaultWreckfestForm,
    toYaml: buildWreckfestYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'GameCTL\'s own from-scratch image — the Windows-only server under WineHQ stable + xvfb. The game installs from SteamCMD to the volume, not the image.' }),
        { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
        { name: 'welcomeMessage', label: 'Welcome message', type: 'text' },
        { name: 'serverPassword', label: 'Join password (optional)', type: 'text' },
        { name: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 24 },
        { name: 'extraCfg', label: 'Extra server_config.cfg lines (advanced)', type: 'text',
          hint: 'Appended verbatim — e.g. track/gamemode/ai settings from the shipped example config.' },
        { name: 'updateOnStart', label: 'Update+validate on next start', type: 'select',
          options: [ { label: 'No — fast boot (default)', value: false }, { label: 'Yes — SteamCMD validate on next restart', value: true } ] },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/GameCTL/wreckfest') },
      resourceStep(RES.wreckfest),
      { id: 'network', title: 'Networking', fields: [
        poolField(), lbIPField(),
        { name: 'gamePort', label: 'Game port (UDP)', type: 'number', required: true },
        { name: 'queryPort', label: 'Query port (UDP)', type: 'number', required: true,
          hint: 'LAN discovery works on 27015-27020 / 26900-26905.' },
        { name: 'steamPort', label: 'Steam port (UDP)', type: 'number', required: true },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'wreckfest2',
    name: 'Wreckfest 2',
    short: 'WF2',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1203190/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1203190/header.jpg',
    defaults: defaultWreckfest2Form,
    toYaml: buildWreckfest2Yaml,
    steps: [
      {
        id: 'general',
        title: 'General',
        fields: [
          { name: 'serverName', label: 'Server name', type: 'text', required: true },
          { name: 'namespace', label: 'Namespace', type: 'text', required: true },
          imageField({ hint: 'GameCTL\'s own from-scratch image — the Windows-only WF2 server (Steam app 3519390) under WineHQ stable + xvfb. Pin a sha tag to lock the wine build; the game itself updates from SteamCMD on the volume, not the image.' }),
          { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
          { name: 'description', label: 'Welcome message', type: 'text' },
          { name: 'serverPassword', label: 'Join password (optional)', type: 'text' },
        ],
      },
      {
        id: 'gameplay',
        title: 'Gameplay',
        fields: [
          { name: 'eventLoop', label: 'Event rotation', type: 'text',
            hint: 'Name of the event loop the server rotates through (default_loop unless you ship a custom rotation file in /data/server).' },
          { name: 'countdownTime', label: 'Lobby countdown (ms)', type: 'number' },
          { name: 'votingTime', label: 'Vote time (ms)', type: 'number' },
          { name: 'serverFlags', label: 'Flags', type: 'text', placeholder: 'e.g. leader enabled',
            hint: '"leader enabled" grants the first joiner admin permissions.' },
          { name: 'updateOnStart', label: 'Update+validate on next start', type: 'select',
            options: [ { label: 'No — fast boot (default)', value: false }, { label: 'Yes — SteamCMD validate on next restart', value: true } ],
            hint: 'Normal boots never run SteamCMD. Flip on (or use the manage screen\'s Auto-update toggle) to pull a new WF2 build on the next restart.' },
        ],
      },
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/GameCTL/wreckfest2') },
      resourceStep(RES.wreckfest2),
      {
        id: 'network',
        title: 'Networking',
        fields: [
          poolField(),
          lbIPField(),
          { name: 'gamePort', label: 'Game port (UDP)', type: 'number', required: true,
            hint: 'Default 30100. Each WF2 server needs a unique port.' },
        ],
      },
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'satisfactory',
    name: 'Satisfactory',
    short: 'SAT',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/526870/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/526870/header.jpg',
    defaults: defaultSatisfactoryForm,
    toYaml: buildSatisfactoryYaml,
    steps: [
      {
        id: 'general',
        title: 'General',
        fields: [
          { name: 'serverName', label: 'Server name', type: 'text', required: true },
          { name: 'namespace', label: 'Namespace', type: 'text', required: true },
          imageField(),
          { name: 'branch', label: 'Branch', type: 'select', options: [ {label:'Public', value:'public'}, {label:'Experimental', value:'experimental'} ] },
        ],
      },
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/satisfactory') },
      resourceStep(RES.satisfactory),
      {
        id: 'network',
        title: 'Networking',
        fields: [
          poolField(),
          lbIPField(),
          { name: 'serverGamePort', label: 'Game port', type: 'number', required: true },
          { name: 'reliablePort', label: 'Reliable port', type: 'number', required: true },
          { name: 'beaconPort', label: 'Beacon port', type: 'number', required: true },
          { name: 'queryPort', label: 'Query port', type: 'number', required: true },
          { name: 'externalTrafficPolicy', label: 'External traffic policy', type: 'select', options: [ {label:'Cluster', value:'Cluster'}, {label:'Local', value:'Local'} ] },
        ],
      },
      {
        id: 'runtime',
        title: 'Runtime',
        fields: [
          { name: 'puid', label: 'PUID', type: 'text', required: true },
          { name: 'pgid', label: 'PGID', type: 'text', required: true },
          { name: 'installIfMissing', label: 'Install if missing', type: 'select', options: [ {label:'true', value:'true'}, {label:'false', value:'false'} ] },
          { name: 'updateOnStart', label: 'Auto-update', type: 'select', options: [ {label:'Enabled (validate/update via SteamCMD every start)', value:true}, {label:'Disabled (reuse persisted install — pin current version)', value:false} ], hint: 'Leave Enabled for the first deploy so SteamCMD fetches the game files. Once it is installed you can switch this to Disabled (here or later on the instance’s Details screen) to pin the version and get faster starts — SteamCMD only re-downloads when there is an actual update, but the validate pass still adds startup time.' },
          { name: 'forceUpdate', label: 'Force a one-time SteamCMD update on next deploy', type: 'select', options: [ {label:'No', value:false}, {label:'Yes (run update once, then switch back to No)', value:true} ] },
          { name: 'attempts', label: 'Attempts', type: 'number' },
          { name: 'multihome', label: 'Multihome', type: 'text' },
          { name: 'enableCrossplay', label: 'Enable crossplay', type: 'select', options: [ {label:'true', value:'true'}, {label:'false', value:'false'} ] },
          { name: 'home', label: 'HOME (data mount path)', type: 'text' },
          { name: 'xdgConfigHome', label: 'XDG_CONFIG_HOME', type: 'text' },
        ],
      },
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'cs2',
    name: 'Counter-Strike 2',
    short: 'CS2',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/730/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg',
    defaults: defaultCs2Form,
    toYaml: buildCs2Yaml,
    steps: [
      {
        id: 'general',
        title: 'General',
        fields: [
          { name: 'serverName', label: 'Server name', type: 'text', required: true,
            hint: 'Kubernetes Deployment/Service name — lowercase, no spaces.' },
          { name: 'hostname', label: 'In-game server name', type: 'text', required: true },
          { name: 'welcomeMessage', label: 'Welcome message (chat)', type: 'text',
            placeholder: "e.g. Welcome to the server — type !help for commands",
            hint: 'Printed to each joining player a few seconds after they connect. Leave blank to disable. Supports {green}/{yellow}/{default} color tokens.' },
          imageField(),
          { name: 'updateOnStart', label: 'Update+validate on next restart', type: 'select',
            options: [ {label:'Off — install once, then fast restarts', value:false}, {label:'On — run one SteamCMD validate/update before the next boot', value:true} ],
            hint: 'New CS2 instances always install onto the persistent volume on first boot. Leave this Off for the normal path: later restarts reuse that cached install and start quickly. Turn it On only when you want one explicit SteamCMD repair/update on the next restart; GameCTL consumes the request once, then goes back to fast boots.' },
          { name: 'gameMode', label: 'Game mode', type: 'select',
            options: Object.entries(CS2_MODES).map(([k, v]) => ({ label: v.label, value: k })),
            hint: 'The server boots straight into this mode. GameCTL\'s own cs2-kube image ships the mode catalog with Metamod + CounterStrikeSharp working — Surf/Bhop/KZ get the SharpTimer timer + speed HUD, 1v1 Arenas gets multi-arena, all modes get RTV map voting (!rtv) and game-mode voting (!gamemode). Players can vote to other modes/maps in-game.' },
          { name: 'retakeBots', label: 'Retake bots', type: 'number', min: 0, max: 9,
            showIf: (f) => f.gameMode === 'retake',
            hint: 'Retakes needs ~9 players or rounds never run. Default 0 (human-only) keeps the mode clean — the upstream bot AI gets confused in retakes (knife-idling, buy-on-top-of-allocator). Raise this to fill empty slots and accept the jank; 8 keeps one of the 9 slots free for joining humans.' },
        ],
      },
      {
        id: 'storage',
        title: 'Storage',
        fields: [
          // Uses the operator-declared Storage Locations (Storage screen) like
          // every other game — the wizard's resolveStorage() turns the picked
          // location into storageMode + nfsServer/dataPvPath (remote) or
          // localDataPath (local), which cs2Generator already consumes.
          { name: 'storageLocation', label: 'Storage location', type: 'remote-select',
            endpoint: '/storage/locations', dataPath: 'locations',
            valueKey: 'name', labelKey: 'name', required: true,
            emphasis: 'required',
            hint: 'Required — the ~65G CS2 install downloads on first boot and persists at <storage>/GameCTL/<server> on the location you pick, so restarts are fast. NFS or local both work.',
            placeholder: '— pick a location (manage under Storage) —' },
          { name: 'storage', label: 'Storage size', type: 'text', required: true,
            hint: '~65G install + maps + headroom — 90Gi recommended.' },
        ],
      },
      {
        id: 'network',
        title: 'Networking',
        fields: [
          { name: 'port', label: 'Game port', type: 'number', required: true, min: 1024, max: 65535 },
          { name: 'tickrate', label: 'Tickrate', type: 'number', required: true, min: 32, max: 256 },
          { name: 'maxPlayers', label: 'Max players', type: 'number', required: true, min: 2, max: 64 },
          poolField(),
          lbIPField(),
          { name: 'tvPort', label: 'GOTV port', type: 'number', min: 1024, max: 65535 },
        ],
      },
      {
        id: 'maps',
        title: 'Maps',
        fields: [
          { name: 'workshopMap', label: 'Boot map', type: 'cs2-bootmap',
            hint: 'The map the server starts on. Pick from the curated maps for your game mode, or choose “Custom workshop ID” to boot any Steam Workshop map. Blank = the mode’s own default.' },
          { name: 'rtvPool', label: 'RTV map pool', type: 'cs2-rtvpool', fullWidth: true,
            hint: 'Which maps each mode offers in the in-game two-stage !rtv vote (vote a mode, then a map). Everything is on by default — click a map to drop it. These maps are also pre-downloaded at boot so switches are instant.' },
          { name: 'workshopCollection', label: 'Extra workshop collection ID (optional)', type: 'text',
            placeholder: 'optional — an extra map collection to keep cached',
            hint: 'A Steam Workshop collection ID kept cached alongside the RTV pool — handy if you want extra maps available for !nominate.' },
          { name: 'preloadWorkshopMaps', label: 'Auto-preload workshop maps at boot', type: 'select',
            options: [ { label: 'No — fetch on demand', value: false }, { label: 'Yes — cycle host_workshop_map after boot', value: true } ],
            hint: 'CS2 only fetches a workshop map when something asks for it, so first-time !rtv to an uncached map can hang. With this on, GameCTL waits for the pod to be ready + nobody connected, then cycles host_workshop_map for each missing id (~45s/map, ~30-100 MB each). Re-runs on every (re)start until the full pool is cached.' },
          { name: 'deploySurfRecords', label: 'Surf records website', type: 'select',
            options: [ { label: 'No', value: 0 }, { label: 'Yes — deploy a records site alongside the server', value: 1 } ],
            hint: 'Deploys a companion website (leaderboards, player profiles, run replays) fed by the surf timer data GameCTL\'s Surf HUD plugin records on the game volume. Read-only — it can\'t touch the server. ClusterIP service <server>-records; publish it with ProxyCTL to put it on the internet.' },
          { name: 'recordsSiteBrand', label: 'Site owner / brand name', type: 'text',
            placeholder: 'e.g. examplelabs', showIf: (f) => Number(f.deploySurfRecords) === 1,
            hint: 'Your name on the site — title, header and footer read "<name> CS2 Surf Records". Defaults to the server hostname.' },
        ],
      },
      {
        id: 'security',
        title: 'Steam & Admin',
        fields: [
          { name: 'steamApiKey', label: 'Steam Web API key', type: 'text',
            placeholder: 'from steamcommunity.com/dev/apikey',
            hint: 'Required for Workshop maps — surf / 1v1 / aim / custom maps are all Workshop content. Register a free key (any domain works, e.g. localhost):',
            helpUrl: 'https://steamcommunity.com/dev/apikey', helpLabel: 'Get a Steam Web API key ↗' },
          { name: 'gslt', label: 'GSLT (game server login token)', type: 'text',
            placeholder: 'app-730 token — optional',
            hint: 'Recommended for an internet-facing server: persistent identity + public server-browser listing. Create one for App ID 730:',
            helpUrl: 'https://steamcommunity.com/dev/managegameservers', helpLabel: 'Get a GSLT (App ID 730) ↗' },
          { name: 'serverPassword', label: 'Server password', type: 'text', placeholder: 'optional' },
          { name: 'rconPassword', label: 'RCON password', type: 'text', required: true },
          { name: 'adminSteamId', label: 'Admin SteamID64', type: 'text',
            placeholder: 'optional — your 7656… SteamID64',
            hint: 'This SteamID64 is granted CounterStrikeSharp admin (#css/admin): admin chat commands, !modes, vote management. Find yours at steamid.io.' },
        ],
      },
      resourceStep(RES.cs2),
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'corekeeper',
    name: 'Core Keeper',
    short: 'CK',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1621690/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1621690/header.jpg',
    defaults: defaultCorekeeperForm,
    toYaml: buildCorekeeperYaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'Connect mode: "Steam relay" uses the Game ID (a join code) — no ports/LoadBalancer, and it is the known-good mode (matches the live deploy). "Direct" also publishes a LoadBalancer port; validate it on a dev build before relying on it.',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
        { name: 'worldName', label: 'World name', type: 'text', required: true },
        { name: 'maxPlayers', label: 'Max players', type: 'number', required: true, min: 1, max: 100 },
        { name: 'connectMode', label: 'Connect mode', type: 'select', options: [
          { label: 'Steam relay (Game ID — recommended)', value: 'relay' },
          { label: 'Direct LoadBalancer port', value: 'direct' },
        ] },
        { name: 'gameId', label: 'Game ID (relay join code — required)', type: 'text',
          default: 'ChangeMe12345',
          placeholder: 'at least 12 characters',
          hint: 'Required for relay mode — must be 12 or more characters, or players can\'t connect.',
          showIf: (f) => (f.connectMode || 'relay') === 'relay' },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/corekeeper') },
      resourceStep(RES.corekeeper),
      { id: 'network', title: 'Networking',
        showIf: (f) => (f.connectMode || 'relay') === 'direct',
        fields: [
        { name: 'serverPort', label: 'Server port', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'terraria',
    name: 'Terraria',
    short: 'TER',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/105600/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/105600/header.jpg',
    defaults: defaultTerrariaForm,
    toYaml: buildTerrariaYaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'Uses the ryshe/tshock image; first boot auto-creates the world from these settings. Validate on a dev build — image env handling can vary by version (the Diagnostics panel shows startup issues).',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
        { name: 'worldName', label: 'World name', type: 'text', required: true },
        { name: 'worldSize', label: 'World size', type: 'select', options: [
          { label: 'Small', value: 1 }, { label: 'Medium', value: 2 }, { label: 'Large', value: 3 },
        ] },
        { name: 'difficulty', label: 'Difficulty', type: 'select', options: [
          { label: 'Classic', value: 0 }, { label: 'Expert', value: 1 },
          { label: 'Master', value: 2 }, { label: 'Journey', value: 3 },
        ] },
        { name: 'maxPlayers', label: 'Max players', type: 'number', required: true, min: 1, max: 255 },
        { name: 'serverPass', label: 'Server password (optional)', type: 'text' },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/terraria') },
      resourceStep(RES.terraria),
      { id: 'network', title: 'Networking', fields: [
        { name: 'serverPort', label: 'Game port (TCP)', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'projectzomboid',
    name: 'Project Zomboid',
    short: 'PZ',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/108600/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/108600/header.jpg',
    defaults: defaultProjectzomboidForm,
    toYaml: buildProjectzomboidYaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'Anonymous SteamCMD (no account). renegademaster image; validate on a dev build — env keys vary by image version.',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
        { name: 'serverNameDisplay', label: 'Display name', type: 'text' },
        { name: 'adminPassword', label: 'Admin password', type: 'text', required: true },
        { name: 'rconPassword', label: 'RCON password', type: 'text', default: 'ChangeMe12345',
          hint: 'Enables the in-app server console. Internal-only — keep this port off any public tunnel.' },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/projectzomboid') },
      resourceStep(RES.projectzomboid),
      { id: 'network', title: 'Networking', fields: [
        { name: 'serverPort', label: 'Base UDP port (also opens +1)', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'necesse',
    name: 'Necesse',
    short: 'NEC',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1169040/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1169040/header.jpg',
    defaults: defaultNecesseForm,
    toYaml: buildNecesseYaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'Tiny Java server, no Steam. Default image is a community one — validate on a dev build (env/mount path can vary); the image field is editable.',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
        { name: 'worldName', label: 'World name', type: 'text', required: true },
        { name: 'maxPlayers', label: 'Max players', type: 'number', required: true, min: 1, max: 250 },
        { name: 'serverPass', label: 'Server password (optional)', type: 'text' },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/necesse') },
      resourceStep(RES.necesse),
      { id: 'network', title: 'Networking', fields: [
        { name: 'serverPort', label: 'Game port (UDP)', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'palworld',
    name: 'Palworld',
    short: 'PAL',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1623730/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1623730/header.jpg',
    defaults: defaultPalworldForm,
    toYaml: buildPalworldYaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'GameCTL\'s own image (SteamCMD app 2394010, anonymous). The ~8GB server installs to the volume on first boot, not the image, so a reschedule does not re-download it. Palworld is memory-hungry — check the Resources step before deploying onto a small node.',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
        { name: 'serverNameDisplay', label: 'Display name (in server list)', type: 'text', required: true },
        { name: 'maxPlayers', label: 'Max players', type: 'number', required: true, min: 1, max: 32 },
        { name: 'serverPass', label: 'Server password (optional)', type: 'text' },
        { name: 'adminPass', label: 'Admin password (optional)', type: 'text' },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1tbssdfast/GameCTL/palworld') },
      resourceStep(RES.palworld),
      { id: 'network', title: 'Networking',
        note: 'Palworld needs BOTH ports reachable. The game port carries play traffic; the separate query port is what the in-game server browser probes — forward only the game port and players can still connect by IP, but the server never appears in the list.',
        fields: [
        { name: 'serverPort', label: 'Game port (UDP)', type: 'number', required: true },
        { name: 'queryPort', label: 'Steam query port (UDP)', type: 'number', required: true },
        { name: 'isPublic', label: 'List in the public server browser', type: 'checkbox' },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'left4dead2',
    name: 'Left 4 Dead 2',
    short: 'L4D2',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/550/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/550/header.jpg',
    defaults: defaultLeft4dead2Form,
    toYaml: buildLeft4dead2Yaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'GameCTL\'s own from-scratch srcds image (Steam app 222860, anonymous). The ~11GB game installs to the volume on first boot, not the image.' }),
        { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
        { name: 'serverPassword', label: 'Join password (optional)', type: 'text' },
        { name: 'rconPassword', label: 'RCON password (optional)', type: 'text' },
        { name: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 32 },
        { name: 'startMap', label: 'Boot map', type: 'text', placeholder: 'c2m1_highway' },
        { name: 'updateOnStart', label: 'Update+validate on next start', type: 'select',
          options: [ { label: 'No — fast boot (default)', value: false }, { label: 'Yes — SteamCMD validate on next restart', value: true } ] },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/GameCTL/left4dead2') },
      resourceStep(RES.left4dead2),
      { id: 'network', title: 'Networking', fields: [
        poolField(), lbIPField(),
        { name: 'gamePort', label: 'Game port (UDP+TCP)', type: 'number', required: true },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'sonsoftheforest',
    name: 'Sons of the Forest',
    short: 'SOTF',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1326470/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1326470/header.jpg',
    defaults: defaultSonsoftheforestForm,
    toYaml: buildSonsoftheforestYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'GameCTL\'s own from-scratch image — the Windows-only server under WineHQ stable + xvfb. The game installs from SteamCMD to the volume, not the image.' }),
        { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
        { name: 'serverPassword', label: 'Join password (optional)', type: 'text' },
        { name: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 8 },
        { name: 'gameMode', label: 'Game mode', type: 'select', options: [
          { label: 'Normal', value: 'Normal' }, { label: 'Peaceful', value: 'Peaceful' },
          { label: 'Hard', value: 'Hard' }, { label: 'Hard Survival', value: 'HardSurvival' },
        ] },
        { name: 'saveSlot', label: 'Save slot', type: 'number', min: 1, max: 10 },
        { name: 'ownerSteamIds', label: 'Owner SteamID64s (optional, comma-separated)', type: 'text',
          hint: 'Written to the owners whitelist — these players get in-game admin.' },
        { name: 'updateOnStart', label: 'Update+validate on next start', type: 'select',
          options: [ { label: 'No — fast boot (default)', value: false }, { label: 'Yes — SteamCMD validate on next restart', value: true } ] },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/GameCTL/sonsoftheforest') },
      resourceStep(RES.sonsoftheforest),
      { id: 'network', title: 'Networking', fields: [
        poolField(), lbIPField(),
        { name: 'gamePort', label: 'Game port (UDP)', type: 'number', required: true },
        { name: 'queryPort', label: 'Query port (UDP)', type: 'number', required: true },
        { name: 'blobPort', label: 'Blob-sync port (UDP)', type: 'number', required: true },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'unturned',
    name: 'Unturned',
    short: 'UNT',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/304930/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/304930/header.jpg',
    defaults: defaultUnturnedForm,
    toYaml: buildUnturnedYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'GameCTL\'s own from-scratch image (Steam app 1110390, anonymous). The game installs to the volume on first boot; the world lives in Servers/<id> beside it.' }),
        { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
        { name: 'serverId', label: 'Server ID (world folder name)', type: 'text', required: true },
        { name: 'map', label: 'Map', type: 'select', options: [
          { label: 'PEI', value: 'PEI' }, { label: 'Washington', value: 'Washington' },
          { label: 'Russia', value: 'Russia' }, { label: 'Yukon', value: 'Yukon' },
        ] },
        { name: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 64 },
        { name: 'serverPassword', label: 'Join password (optional)', type: 'text' },
        { name: 'ownerSteamId', label: 'Owner SteamID64 (optional)', type: 'text', hint: 'Granted in-game owner/admin.' },
        { name: 'gslt', label: 'Steam GSLT (optional)', type: 'text',
          hint: 'Game Server Login Token (steamcommunity.com/dev/managegameservers, app 304930). Without it the server is LAN/relay-code only — not listed on the internet browser.' },
        { name: 'perspective', label: 'Perspective', type: 'select', options: [
          { label: 'Both', value: 'Both' }, { label: 'First person', value: 'First' }, { label: 'Third person', value: 'Third' },
        ] },
        { name: 'pvp', label: 'PvP', type: 'select', options: [
          { label: 'PvP', value: true }, { label: 'PvE', value: false } ] },
        { name: 'updateOnStart', label: 'Update+validate on next start', type: 'select',
          options: [ { label: 'No — fast boot (default)', value: false }, { label: 'Yes — SteamCMD validate on next restart', value: true } ] },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/GameCTL/unturned') },
      resourceStep(RES.unturned),
      { id: 'network', title: 'Networking', fields: [
        poolField(), lbIPField(),
        { name: 'gamePort', label: 'Game port (UDP; query uses port+1)', type: 'number', required: true },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'leftfordead',
    name: 'Left 4 Dead',
    short: 'L4D',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/500/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/500/header.jpg',
    defaults: defaultLeftfordeadForm,
    toYaml: buildLeftfordeadYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'GameCTL\'s own from-scratch srcds image (Steam app 222840, anonymous). The ~8GB game installs to the volume on first boot.' }),
        { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
        { name: 'serverPassword', label: 'Join password (optional)', type: 'text' },
        { name: 'rconPassword', label: 'RCON password (optional)', type: 'text' },
        { name: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 32 },
        { name: 'startMap', label: 'Boot map', type: 'text', placeholder: 'l4d_hospital01_apartment' },
        { name: 'updateOnStart', label: 'Update+validate on next start', type: 'select',
          options: [ { label: 'No — fast boot (default)', value: false }, { label: 'Yes — SteamCMD validate on next restart', value: true } ] },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/GameCTL/leftfordead') },
      resourceStep(RES.leftfordead),
      { id: 'network', title: 'Networking', fields: [
        poolField(), lbIPField(),
        { name: 'gamePort', label: 'Game port (UDP+TCP)', type: 'number', required: true },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'beammp',
    name: 'BeamMP',
    short: 'BMP',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/284160/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/284160/header.jpg',
    defaults: defaultBeammpForm,
    toYaml: buildBeammpYaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'BeamMP needs a free AuthKey: log into keymaster.beammp.com with Discord, create a key, and paste it below. Without it the server exits at boot with these same instructions.',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'GameCTL\'s own from-scratch image around the official open-source BeamMP server binary. No game files involved.' }),
        { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
        { name: 'authKey', label: 'BeamMP AuthKey', type: 'text', required: true,
          hint: 'Free from keymaster.beammp.com (Discord login).' },
        { name: 'map', label: 'Map', type: 'text', placeholder: '/levels/gridmap_v2/info.json',
          hint: 'BeamNG level path, e.g. /levels/west_coast_usa/info.json.' },
        { name: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 50 },
        { name: 'maxCars', label: 'Max cars per player', type: 'number', min: 1, max: 10 },
        { name: 'privateServer', label: 'Listing', type: 'select', options: [
          { label: 'Private (unlisted — join by IP)', value: true },
          { label: 'Public (listed in the BeamMP browser)', value: false } ] },
        { name: 'description', label: 'Listing description', type: 'text' },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/GameCTL/beammp') },
      resourceStep(RES.beammp),
      { id: 'network', title: 'Networking', fields: [
        poolField(), lbIPField(),
        { name: 'gamePort', label: 'Game port (TCP+UDP)', type: 'number', required: true },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'barotrauma',
    name: 'Barotrauma',
    short: 'BARO',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/602960/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/602960/header.jpg',
    defaults: defaultBarotraumaForm,
    toYaml: buildBarotraumaYaml,
    steps: [
      { id: 'general', title: 'General',
        note: 'Anonymous SteamCMD (no account), Linux-native. Default image is a community one — validate on a dev build; the image field is editable.',
        fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
        { name: 'serverNameDisplay', label: 'Display name', type: 'text' },
        { name: 'maxPlayers', label: 'Max players', type: 'number', required: true, min: 1, max: 64 },
        { name: 'serverPass', label: 'Server password (optional)', type: 'text' },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/barotrauma') },
      resourceStep(RES.barotrauma),
      { id: 'network', title: 'Networking', fields: [
        { name: 'serverPort', label: 'Game port (UDP)', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'abioticfactor',
    name: 'Abiotic Factor',
    short: 'ABIO',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/427410/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/427410/header.jpg',
    defaults: defaultAbioticfactorForm,
    toYaml: buildAbioticfactorYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField({ hint: 'GameCTL\'s own from-scratch image — the Windows-only server under WineHQ stable + xvfb. The game installs from SteamCMD to the volume, not the image.' }),
        { name: 'hostname', label: 'Server browser name', type: 'text', required: true },
        { name: 'serverPassword', label: 'Join password (optional)', type: 'text' },
        { name: 'maxPlayers', label: 'Max players', type: 'number', min: 1, max: 10 },
        { name: 'worldName', label: 'World save name', type: 'text', required: true },
        { name: 'extraArgs', label: 'Extra launch args (advanced)', type: 'text',
          hint: 'Appended to the UE server command line, e.g. -SandboxIniPath=... overrides.' },
        { name: 'updateOnStart', label: 'Update+validate on next start', type: 'select',
          options: [ { label: 'No — fast boot (default)', value: false }, { label: 'Yes — SteamCMD validate on next restart', value: true } ] },
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/GameCTL/abioticfactor') },
      resourceStep(RES.abioticfactor),
      { id: 'network', title: 'Networking', fields: [
        poolField(), lbIPField(),
        { name: 'gamePort', label: 'Game port (UDP)', type: 'number', required: true },
        { name: 'queryPort', label: 'Query port (UDP)', type: 'number', required: true },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
]

// -----------------------------------------------------------------------------
// Networking-step post-process: prepend the shared exposure choice to every
// game's Networking step and gate the MetalLB fields on it — one central
// pass instead of touching each schema. MetalLB pool/IP fields hide (and
// stop being required) when the operator picks "Internet only", composing
// with any showIf a field already declares (e.g. the BlueMap LB IP).
// -----------------------------------------------------------------------------
for (const g of games) {
  for (const s of g.steps || []) {
    // MetalLB pool/IP fields live in the Networking step AND in feature
    // steps (Minecraft's BlueMap step has its own LoadBalancer IP), so the
    // exposure gate applies to every step — with "Internet only" selected,
    // a BlueMap/companion site is published through ProxyCTL's Cloudflare
    // Tunnel instead of a MetalLB IP.
    for (const f of s.fields || []) {
      if (!/^metallbPool$|lbIP/i.test(String(f.name))) continue
      const orig = f.showIf
      f.showIf = (form) => form?.expose !== 'proxyctl' && (!orig || !!orig(form))
    }
    // Every numeric *Port field becomes a cluster-aware port input: it names
    // whoever already holds that number (see PortField in GameWizard.jsx).
    // Done as a sweep rather than per-schema so a newly added game gets the
    // check for free instead of only when someone remembers to opt in.
    // Protocol comes from the label — "(UDP)" / "Query port (UDP)" — since
    // that's what every schema already writes; default TCP matches k8s.
    for (const f of s.fields || []) {
      if (f.type !== 'number' || !/port$/i.test(String(f.name))) continue
      f.type = 'port'
      if (f.protocol) continue
      const label = String(f.label || '')
      const udp = /udp/i.test(label)
      const tcp = /tcp/i.test(label)
      f.protocol = udp && tcp ? ['TCP', 'UDP'] : udp ? 'UDP' : 'TCP'
    }
    if (s.id === 'network') {
      s.fields.unshift({ ...exposeField }, { ...publishHostField }, { ...publishDomainField })
    }
  }
}

// -----------------------------------------------------------------------------
// Supported-games allowlist.
//
// A game only becomes deployable by being named HERE. This is deliberately an
// allowlist and not the `comingSoon: true` opt-out it replaces: with an
// opt-out, adding a half-finished generator to this file silently publishes it
// to the deploy picker, and "someone forgot the flag" is not something a user
// can detect. Opt-in fails the safe way — a new game is invisible until it has
// actually been deployed and verified against a cluster.
//
// To add one: deploy it end-to-end from the wizard, confirm it runs, then add
// its id below.
//
// Exceptions, allowlisted on the operator's call: 'dayz' and 'iw4x' can only
// be boot-verified by someone who supplies the missing half themselves — a
// DayZ-owning Steam account, and a personal copy of MW2's game files. Nobody
// upstream can run that acceptance test, so they ship deployable with the
// prerequisite spelled out in each wizard's first step.
// -----------------------------------------------------------------------------
const SUPPORTED_GAME_IDS = new Set([
  '7d2d',
  'abioticfactor',
  'barotrauma',
  'beammp',
  'corekeeper',
  'cs2',
  'dayz',
  'factorio',
  'iw4x',
  'left4dead2',
  'leftfordead',
  'minecraft',
  'necesse',
  'projectzomboid',
  'quake3',
  'sandstorm',
  'satisfactory',
  'sonsoftheforest',
  'spt',
  'terraria',
  'unturned',
  'valheim',
  'wreckfest',
  'wreckfest2',
])

// isSupported reports whether a game may be deployed. `comingSoon` is still
// honoured so an entry can be shown as previewed-but-not-ready without being
// pulled from the allowlist.
export function isSupported(game) {
  return !!game && !game.comingSoon && SUPPORTED_GAME_IDS.has(game.id)
}

// deployableGames is what the picker offers. Anything in `games` but not here
// is either explicitly coming-soon or not yet allowlisted.
export const deployableGames = games.filter(isSupported)

// unsupportedGames — present in the catalog, not deployable. Rendered as
// "coming soon" so the catalog stays visible without implying it will deploy.
export const unsupportedGames = games.filter(g => !isSupported(g))
