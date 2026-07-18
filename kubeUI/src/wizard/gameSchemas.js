import { defaultCs2Form, buildCs2Yaml, CS2_MODES } from '../utils/cs2Generator'
import { defaultMinecraftForm, buildMinecraftYaml } from '../utils/minecraftGenerator'
import { defaultSatisfactoryForm, buildSatisfactoryYaml } from '../utils/satisfactoryGenerator'
import { defaultValheimForm, buildValheimYaml } from '../utils/valheimGenerator'
import { default7d2dForm, build7d2dYaml } from '../utils/sevendaysGenerator'
import { defaultFactorioForm, buildFactorioYaml } from '../utils/factorioGenerator'
import { defaultWreckfestForm, buildWreckfestYaml } from '../utils/wreckfestGenerator'
import { defaultCarxForm, buildCarxYaml } from '../utils/carxGenerator'
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
import { defaultAssettocorsaForm, buildAssettocorsaYaml } from '../utils/assettocorsaGenerator'
import { defaultSandstormForm, buildSandstormYaml, SANDSTORM_CHECKPOINT_SCENARIOS, SANDSTORM_ISMC_MUTATORS } from '../utils/sandstormGenerator'
import { defaultSptForm, buildSptYaml } from '../utils/sptGenerator'

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
const recPh = (v) => (v ? `${v} (recommended default)` : '')
const resourceFields = (d) => ([
  { name: 'cpuRequest', label: 'CPU request',   type: 'text', default: d.cpuReq, placeholder: recPh(d.cpuReq) },
  { name: 'memRequest', label: 'Memory request', type: 'text', default: d.memReq, placeholder: recPh(d.memReq) },
  { name: 'cpuLimit',   label: 'CPU limit',     type: 'text', default: d.cpuLim, placeholder: recPh(d.cpuLim) },
  { name: 'memLimit',   label: 'Memory limit',  type: 'text', default: d.memLim, placeholder: recPh(d.memLim) },
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
}

export const games = [
  {
    id: 'quake3',
    name: 'Quake 3 Arena',
    short: 'Q3A',
    comingSoon: true,
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2200/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2200/header.jpg',
    defaults: defaultQuake3Form,
    toYaml: buildQuake3Yaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'serverName', label: 'Server name', type: 'text', required: true },
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        imageField(),
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/quake3') },
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
          { name: 'memory', label: 'Memory', type: 'text', required: true },
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
      ]},
      { id: 'storage', title: 'Storage', fields: standardStorageFields('/mnt/1TBSSD/factorio') },
      resourceStep(RES.factorio),
      { id: 'network', title: 'Networking', fields: [
        { name: 'gamePort', label: 'Game port (UDP)', type: 'number', required: true },
        { name: 'queryPort', label: 'Steam query (UDP)', type: 'number', required: true },
        poolField(),
        lbIPField(),
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'wreckfest',
    name: 'Wreckfest (Windows/Proton required)',
    short: 'WRECK',
    comingSoon: true,
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/228380/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/228380/header.jpg',
    defaults: defaultWreckfestForm,
    toYaml: buildWreckfestYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        { name: 'note', label: 'Note', type: 'text', placeholder: 'This game requires Windows node or Wine/Proton' },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'carx',
    name: 'CarX (Windows/Proton likely required)',
    short: 'CARX',
    comingSoon: true,
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/635260/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/635260/header.jpg',
    defaults: defaultCarxForm,
    toYaml: buildCarxYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        { name: 'note', label: 'Note', type: 'text', placeholder: 'Dedicated server availability varies; Windows may be required' },
      ]},
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
          { name: 'updateOnStart', label: 'Validate on start', type: 'select',
            options: [ {label:'Off — fast start (CS2 still auto-updates)', value:false}, {label:'On — full SteamCMD validate each start (slower)', value:true} ],
            hint: 'CS2 already updates to the latest build on every (re)start — GameCTL pre-warms SteamCMD and clears stale staging so the update reliably lands (no more “0x6” stuck-update leaving the server on an old build that clients can’t join). Leave this Off for fast restarts. Turn it On only to add a full validate pass that re-hashes ~65G of game files — useful to recover a corrupted install. Flippable later on the instance’s Details screen, then Restart.' },
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
    id: 'left4dead2',
    name: 'Left 4 Dead 2',
    short: 'L4D2',
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/550/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/550/header.jpg',
    comingSoon: true,
    defaults: defaultLeft4dead2Form,
    toYaml: buildLeft4dead2Yaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        { name: 'note', label: 'Note', type: 'text', placeholder: 'No verified turnkey image yet (sourceservers has no auto-start Cmd)' },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'sonsoftheforest',
    name: 'Sons of the Forest (Windows/Proton required)',
    short: 'SOTF',
    comingSoon: true,
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1326470/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1326470/header.jpg',
    defaults: defaultSonsoftheforestForm,
    toYaml: buildSonsoftheforestYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        { name: 'note', label: 'Note', type: 'text', placeholder: 'Windows-only dedicated server; needs Wine/Proton' },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'unturned',
    name: 'Unturned (image TBD)',
    short: 'UNT',
    comingSoon: true,
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/304930/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/304930/header.jpg',
    defaults: defaultUnturnedForm,
    toYaml: buildUnturnedYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        { name: 'note', label: 'Note', type: 'text', placeholder: 'Linux server exists (SteamCMD 1110390); needs a verified image' },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'leftfordead',
    name: 'Left 4 Dead (image TBD)',
    short: 'L4D',
    comingSoon: true,
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/500/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/500/header.jpg',
    defaults: defaultLeftfordeadForm,
    toYaml: buildLeftfordeadYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        { name: 'note', label: 'Note', type: 'text', placeholder: 'L4D2 is available; L4D1 needs a maintained image' },
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
    comingSoon: true,
    defaults: defaultBeammpForm,
    toYaml: buildBeammpYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        { name: 'note', label: 'Note', type: 'text', placeholder: 'Available image is a Pterodactyl egg; needs a clean image / generated ServerConfig.toml' },
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
    name: 'Abiotic Factor (Windows/Proton required)',
    short: 'ABIO',
    comingSoon: true,
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/427410/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/427410/header.jpg',
    defaults: defaultAbioticfactorForm,
    toYaml: buildAbioticfactorYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        { name: 'note', label: 'Note', type: 'text', placeholder: 'Windows-only dedicated server; needs Wine/Proton' },
      ]},
      { id: 'review', title: 'Review', fields: [] },
    ],
  },
  {
    id: 'assettocorsa',
    name: 'Assetto Corsa (Windows/Proton required)',
    short: 'AC',
    comingSoon: true,
    icon: 'https://cdn.cloudflare.steamstatic.com/steam/apps/244210/capsule_184x69.jpg',
    cover: 'https://cdn.cloudflare.steamstatic.com/steam/apps/244210/header.jpg',
    defaults: defaultAssettocorsaForm,
    toYaml: buildAssettocorsaYaml,
    steps: [
      { id: 'general', title: 'General', fields: [
        { name: 'namespace', label: 'Namespace', type: 'text', required: true },
        { name: 'note', label: 'Note', type: 'text', placeholder: 'Windows-native dedicated server; needs Wine/Proton' },
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
    if (s.id === 'network') {
      s.fields.unshift({ ...exposeField }, { ...publishHostField }, { ...publishDomainField })
    }
  }
}
