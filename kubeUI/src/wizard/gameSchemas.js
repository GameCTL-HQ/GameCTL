import { defaultCs2Form, buildCs2Yaml } from '../utils/cs2Generator'
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
  // Highlighted in the wizard: MetalLB is currently the only supported
  // way to expose a game server (raw TCP/UDP), so it's mandatory for
  // every game — draw the eye to it.
  emphasis: 'required',
  hint: 'Required — game servers are exposed via a MetalLB LoadBalancer (raw TCP/UDP).',
  ...overrides,
})

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
  cs2:          { cpuReq: '500m', memReq: '1Gi',   cpuLim: '2', memLim: '2Gi',
    desc: 'CS2: CPU-bound per server tick. 0.5–2 CPU covers common tickrates; 1–2Gi RAM is plenty for one map rotation. Bump CPU for high tickrate / GOTV.' },
  factorio:     { cpuReq: '500m', memReq: '1Gi',   cpuLim: '2', memLim: '2Gi',
    desc: 'Factorio: UPS is single-core CPU-bound and memory grows with map size. 1Gi/2Gi suits early–mid games — raise memory for megabases.' },
  quake3:       { cpuReq: '250m', memReq: '256Mi', cpuLim: '1', memLim: '512Mi',
    desc: 'Quake 3: tiny by modern standards. A fraction of a core and 256–512Mi RAM handle a full server.' },
  satisfactory: { cpuReq: '1',    memReq: '2Gi',   cpuLim: '4', memLim: '8Gi',
    desc: 'Satisfactory: the factory tick is heavy and the save grows over time. ~2Gi steady reservation with an 8Gi cap and up to 4 CPU; raise the request as the save grows large.' },
  sevendays:    { cpuReq: '1',    memReq: '3Gi',   cpuLim: '2', memLim: '6Gi',
    desc: '7 Days to Die: heavy world + zombie sim. ~3Gi steady reservation with a 6Gi cap and 1–2 CPU; raise the request for larger maps / more players.' },
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
            { label: 'Spigot', value: 'SPIGOT' },
          ] },
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
          { name: 'bluemapAcceptDownload', label: 'Accept BlueMap downloads (EULA)', type: 'select',
            options: [ {label:'No — map stays down until accepted', value:0}, {label:'Yes — I accept', value:1} ],
            showIf: (f)=> Number(f.bluemapEnabled) === 1,
            emphasis: 'required',
            hint: 'Required to render the map: BlueMap downloads Minecraft client assets to build the 3D tiles, so (like the Mojang EULA) it will not start its webserver until this is accepted. Left at "No", BlueMap is installed but the map/webserver stays down. Minecraft EULA: https://aka.ms/MinecraftEULA' },
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
          { name: 'serverName', label: 'Server name', type: 'text', required: true },
          { name: 'namespace', label: 'Namespace', type: 'text', required: true },
          imageField(),
          { name: 'hostname', label: 'Hostname (displayed)', type: 'text', required: true },
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
          { name: 'storage', label: 'Storage size', type: 'text', required: true },
          { name: 'skipUpdate', label: 'Auto-update', type: 'select', options: [ {label:'Disabled (recommended — reuse the persisted install)', value:1}, {label:'Enabled (validate/update every start)', value:0} ], hint: 'The game still installs on first deploy either way (SteamCMD always runs). This only controls the integrity "validate" pass. Leave Disabled: the ~65G install persists on NFS and is reused for fast, safe starts. Enabled runs a full validate every boot, and on any SteamCMD hiccup the image deletes the install manifest and re-downloads all ~65G from scratch — not what you want unattended. When a Valve patch actually drops, enable updates deliberately from the instance’s Details screen (non-disruptive toggle, then Restart).' },
          { name: 'hibernateWhenEmpty', label: 'Hibernate when empty', type: 'select', options: [ {label:'Enabled (recommended — sleep when no one is on)', value:1}, {label:'Disabled (keep ticking; bots play solo)', value:0} ], hint: 'When no humans are connected the server tick pauses and CPU drops to ~0 (CS2 default). First human to connect wakes it (~1s) and bots fill immediately via bot_quota_mode fill. Disable only if you want bots to keep playing for spectating/testing without a human joining — uses full CPU 24/7.' },
        ],
      },
      {
        id: 'network',
        title: 'Networking',
        fields: [
          { name: 'port', label: 'Game port', type: 'number', required: true, min: 1024, max: 65535 },
          { name: 'tickrate', label: 'Tickrate', type: 'number', required: true, min: 32, max: 256 },
          poolField(),
          lbIPField(),
          { name: 'tvEnable', label: 'GOTV enable', type: 'select', options: [ {label:'Disabled', value:0}, {label:'Enabled', value:1} ] },
          { name: 'tvPort', label: 'GOTV port', type: 'number', min: 1024, max: 65535 },
        ],
      },
      {
        id: 'gameplay',
        title: 'Gameplay',
        fields: [
          { name: 'mapChoice', label: 'Start map', type: 'select', options: [
            { label: 'de_dust2', value: 'de_dust2' },
            { label: 'de_mirage', value: 'de_mirage' },
            { label: 'de_inferno', value: 'de_inferno' },
            { label: 'de_nuke', value: 'de_nuke' },
            { label: 'de_overpass', value: 'de_overpass' },
            { label: 'de_vertigo', value: 'de_vertigo' },
            { label: 'de_ancient', value: 'de_ancient' },
            { label: 'de_anubis', value: 'de_anubis' },
            { label: 'de_train', value: 'de_train' },
            { label: 'cs_office', value: 'cs_office' },
            { label: 'cs_italy', value: 'cs_italy' },
            { label: 'Custom / workshop map…', value: '__custom__' },
          ] },
          { name: 'map', label: 'Custom / workshop map name', type: 'text', required: true,
            placeholder: 'e.g. de_cache or a workshop map name',
            showIf: (f) => f.mapChoice === '__custom__' },
          { name: 'gameModeChoice', label: 'Game mode', type: 'select', options: [
            { label: 'Competitive (5v5)', value: 'competitive' },
            { label: 'Casual', value: 'casual' },
            { label: 'Wingman (2v2)', value: 'wingman' },
            { label: 'Demolition', value: 'demolition' },
            { label: 'Deathmatch', value: 'deathmatch' },
            { label: 'Arms Race (Gun Game)', value: 'armsrace' },
            { label: 'Custom (set raw game_type / game_mode)', value: 'custom' },
          ], hint: 'Bots are auto-filled and actually play this mode (server is kept un-hibernated and bots join immediately). Team modes balance to ~5v5 (Wingman 2v2); Deathmatch/Arms Race fill to the player cap.' },
          { name: 'gametype', label: 'Raw game_type', type: 'number', min: 0, max: 4, required: true,
            showIf: (f) => f.gameModeChoice === 'custom' },
          { name: 'gamemode', label: 'Raw game_mode', type: 'number', min: 0, max: 4, required: true,
            showIf: (f) => f.gameModeChoice === 'custom' },
          { name: 'botDifficulty', label: 'Bot difficulty', type: 'select', options: [
            { label: 'Easy', value: 0 },
            { label: 'Normal', value: 1 },
            { label: 'Hard', value: 2 },
            { label: 'Expert', value: 3 },
          ] },
          { name: 'maxplayers', label: 'Max players (override)', type: 'number', min: 1, max: 64,
            placeholder: 'auto from game mode',
            hint: 'Total connection slots. The game mode decides how many actually play (Competitive 5v5, Wingman 2v2, Deathmatch FFA) — extra slots are spectators/overflow. Leave blank to size automatically per mode (e.g. Competitive ≈ 12, Casual 20, Wingman 6); set a value only to override.' },
          { name: 'additionalArgs', label: 'Additional +cvars / args', type: 'text', placeholder: 'optional' },
        ],
      },
      {
        id: 'security',
        title: 'Security',
        fields: [
          { name: 'srcdsToken', label: 'SRCDS Token (GSLT)', type: 'text', placeholder: 'app-730 token from steamgamesettings.com (optional)', hint: 'Recommended for an internet-facing CS2 server: persistent server identity, public server-browser listing, and VAC-eligible. The server still runs and is joinable by direct connect without one (anonymous game-server account), so this isn’t a hard blocker. Get a free token for App ID 730 at https://steamgamesettings.com.' },
          { name: 'svPassword', label: 'Server password', type: 'text', placeholder: 'optional' },
          { name: 'rconPassword', label: 'RCON password', type: 'text', required: true },
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
