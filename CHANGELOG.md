# Changelog

All notable changes to GameCTL are documented here. This file is the
human-readable companion to `server/internal/releasenotes/releases.json`,
which is embedded into the binary and surfaced in-app by the update tool
("What's new"). **Keep the two in sync** — when you add a release here,
add the matching structured entry to `releases.json` (same `version`).

The newest release is first. `version` matches the build stamp injected
via `-X main.version=$(VERSION)` (a git tag like `v0.0.2-beta`, or a
short commit SHA for untagged builds).

Only real releases are listed — there is no "Unreleased" section. A build
whose version doesn't match a tagged entry (any SHA/dev build between
tags) resolves to the **newest release** in the in-app notes, so What's
new always describes something that actually shipped. Write changes into
the release entry as you cut it, not into a staging section beforehand.

## [v0.0.39-beta] - 2026-07-28

> The deploy wizard now knows which ports the rest of your cluster is already using — it names the server that holds one, recommends free ones you can click, and stops the Build button rather than letting a collision through. Publishing through ProxyCTL no longer dead-ends when a public port is taken; it republishes on a free one and still delivers to the port your server actually listens on. Plus Factorio finally honours the ports you pick, gains a LAN/public visibility toggle, and a CS2 install-time crash loop is fixed.

### Added

- **The deploy wizard knows what ports are already in use** — Port fields were generated blind: nothing told you the 27015 you typed is already CS2's RCON port, and the collision only surfaced later as a broken server or a rejected publish. Every port field is now checked against a live inventory of every Service port in the cluster. It names whoever holds the number ("also used by cs2 (gamectl/game-tcp)"), and offers the nearest free ports as one-click chips. The check is graded rather than absolute, because two ClusterIP Services legitimately share a number: sharing is a warning that needs an explicit acknowledgement, while the same port and protocol on the same LoadBalancer IP is a hard error with no override. Build YAML stays disabled until one or the other is satisfied, and the acknowledgement is tied to the exact conflict it was given for — change a port and it drops, so a "yes, I know" can never be carried onto a collision you never saw. Applied across every game's port fields, so a newly added game inherits the check instead of opting in.
- **Factorio: choose who can find and join** — A visibility toggle picks between Open/LAN (unlisted, no factorio.com account required on either end) and Public (listed on the factorio.com server browser, with player verification on). Public authenticates with either a token or your account password, whichever you have. The setting is re-applied on every restart, so switching later is a redeploy rather than a hand-edit on the volume.

### Fixed

- **Publishing through ProxyCTL no longer dead-ends on a taken public port** — ProxyCTL routes one public port to exactly one target, so publishing a second game on a Source-default port failed with "27015/udp is already routed by enabled entry cs2" and stopped there; the deploy's publish phase became something you had to go resolve by hand in another app. ProxyCTL was already returning the nearest free port in that error and already supported a public-to-target remap — GameCTL was discarding both. It now retries on the suggested public port, pinned to deliver to the port the game actually listens on, so nothing about the game server changes and only the number players type moves. Each remap is reported in the task log, and a conflict that genuinely can't be resolved reaches the UI with the structure needed to offer you a concrete alternative.
- **Factorio honours the ports you choose** — The generator emitted RCON_PORT but never PORT, so changing the game port renamed the container and Service ports while the server carried on listening on 34197. RCON had no wizard field at all, pinning it to 27015 no matter what CS2 or Project Zomboid already held. Both are now wired through, RCON is editable, and it defaults to 27016 — Factorio has no convention there, so vacating the contested Source default costs nothing. Factorio settings the wizard owns are also re-applied on every start now; previously the image seeded its config only on first boot, so changing one of them on an existing server silently did nothing forever.
- **CS2 servers no longer crash-loop on install** — The install init container ran under a login shell. As PID 1 that made bash source ~/.bash_logout on exit, which on Debian-based images calls clear_console; that fails in a container, and with `set -e` still in effect the failure replaced the script's own successful exit. The pod sat in Init:CrashLoopBackOff having logged nothing but its success message. Triggered in the wild when the upstream SteamCMD image picked up a base carrying that .bash_logout.
- **Heartbeat strips span the full window** — The strip anchored its left edge to the oldest sample on hand, so bars grew in from the left and the bar count itself climbed for the first ~20 minutes of history — bars multiplying and narrowing on every refresh, with each card rendering a different-length strip. It now always spans the requested window, with empty buckets in grey, so a young history reads honestly as "1h, partly filled".
- **Heartbeat strips fill their container** — A short history rendered as a few huge slabs in a left-aligned stub, sitting above full-width CPU/RAM lines at about a third their width. Bars now flex to fill, so fewer buckets simply render wider.

### Changed

- **"What's new" no longer shows an empty "Unreleased" section** — Any build whose version didn't match a tag — that is, every dev build between releases, which is what you are most likely running — was shown a placeholder that told it nothing. It now falls back to the newest released entry.
- **The metrics-server install command is always on the Monitoring settings page** — It used to appear only once GameCTL had decided something was wrong, which is not when you go looking for it.

## [v0.0.38-beta] - 2026-07-27

> Restart no longer hangs on servers that were deployed before GameCTL pinned the Recreate rollout strategy — with one-click repair for the ones you already have. Resource and memory fields become stepped controls instead of free text, so a mistyped quantity can't silently resize a server. Plus working metrics-server detection, heartbeat uptime graphs throughout, and safer instance naming.

### Fixed

- **Restart no longer deadlocks on single-replica game servers** — Eight generators (Barotrauma, Core Keeper, Factorio, Necesse, Project Zomboid, Quake 3, Terraria, Valheim) emitted no rollout strategy, so Kubernetes defaulted to RollingUpdate and scheduled the replacement pod BEFORE terminating the old one. The new pod had to find a second copy of the CPU and RAM the running server still held — on a cluster without that headroom it stayed Pending forever and Restart looked hung. Both pods also mounted the same save data during the overlap, and on a ReadWriteOnce volume the new pod could not attach at all. Those generators now emit strategy: Recreate, and the apply-time normalizer enforces it for every single-replica, volume-backed Deployment so a redeploy repairs older instances too.
- **metrics-server detection works on a stock install** — The check inspected the metrics-server Deployment in kube-system and the metrics.k8s.io APIService — neither of which GameCTL's namespace-confined RBAC permits — so on every stock install it failed with a permission error the UI swallowed, and no CPU/RAM guidance ever appeared. It now performs the same namespaced metrics read the sampler already relies on, so it works with the permissions GameCTL ships with, and distinguishes "cannot determine" from "not installed" rather than nagging when it simply cannot tell.
- **Storage paths tolerate a trailing or doubled slash** — A Storage Location typed as "/mnt/ssd/" was rejected with "path is not normalized", which never mentioned the trailing slash that caused it, and the preview rendered the game's data path with a doubled slash. Paths are now normalized (whitespace, repeated and trailing slashes) before validation on the server and as you type in the UI, while directory traversal is still rejected rather than silently rewritten. This also fixes the installer's storage-location option failing when its path ended in a slash.

### Added

- **One-click repair for servers deployed before that fix** — Restart only patches the pod template, so it keeps whatever strategy a Deployment already has — meaning existing servers were not fixed by restarting them, and nothing repaired them implicitly. GameCTL now detects instances still on RollingUpdate and offers to fix them from the game hub (all at once) or from a single server's manage screen. The change is non-disruptive: the rollout strategy lives outside the pod template, so nothing restarts — it only changes what the NEXT restart does. Switching an existing Deployment also required clearing the API server's defaulted rollingUpdate block first, which server-side apply cannot express; GameCTL now does that with a merge patch.

### Changed

- **metrics-server is installed by you, not by GameCTL** — The in-app "Install metrics-server" button applied cluster-scoped RBAC, an APIService, and a kube-system Deployment from inside the pod — work GameCTL's ServiceAccount is deliberately not allowed to do, so the button could only ever fail with a permission error. It is replaced by the exact kubectl command to run, with a copy button, shown only when metrics genuinely are unavailable. GameCTL's permissions stay as narrow as they were.
- **CPU and memory are stepped controls, not free text** — Kubernetes quantities are easy to get wrong in ways the API accepts silently: "2G" is two billion bytes rather than 2Gi, and a bare "2" for memory means two BYTES. Both the deploy wizard's Resources step and the manage screen's resource editor now use plus/minus steppers — CPU in millicores, memory in half-Gi increments — that emit a valid quantity every time and show what the value means in plain language. The manage screen's controls are also much larger and refuse to apply a request that exceeds its limit.
- **Minecraft's JVM heap is a stepper too** — The Memory field is written straight into the server's MEMORY setting and the container's requests and limits are derived from it (heap minus 1Gi, heap plus 1Gi). Its parser silently falls back to the 4G default on anything it cannot read, so "4 GB" or "4gb" quietly gave you a different heap AND different container resources with no error. It is now a whole-GB stepper that always emits the expected form, and shows the container limit it implies as you change it.
- **Instance names are assigned, and identity fields are locked** — GameCTL deploys every game into a single namespace, so a duplicate server name did not error — it overwrote the running instance and shared its storage folder. The wizard now assigns the next free name automatically (valheim, then valheim-2, valheim-3) and makes the server name and namespace read-only, with a guard that renames and asks you to rebuild if a name is taken between opening the wizard and deploying.
- **Only supported games appear in the deploy picker** — The picker previously offered everything in the catalog minus a per-game "coming soon" flag, so a generator added to the repo became deployable by default and a forgotten flag was invisible to the operator. Deployable games are now an explicit allowlist: a new game is not offered until it has been deployed and verified. The games available today are unchanged.
- **Uptime is shown as a heartbeat graph everywhere** — The manage screen drew uptime as a latency line with unreachable samples plotted as 0ms, which rendered an outage as an impossibly fast response instead of an absence. Every uptime view now uses the same heartbeat bars — one bar per time bucket, green when all checks in it passed — with latency as its own line built only from samples that actually answered. Hovering a bar raises it and shows that bucket's time range and result, the graphs carry visible start and end times, and the hub cards state the window they cover.
- **Requests wait longer before giving up** — The UI's request timeout was 15 seconds. Several endpoints talk to the Kubernetes API before answering, and a busy cluster could exceed that — surfacing as a bare "Network Error" on a request that had in fact succeeded. It is now 30 seconds: long enough to ride out a slow API server, short enough that a genuinely dead backend still reports quickly.

## [v0.0.33-beta] - 2026-07-19

> Wreckfest 2 joins the roster as GameCTL's first Wine-based game, so Windows-only dedicated servers are now on the table. Plus clearer storage docs and an MIT license.

### Added

- **Wreckfest 2 support (first Wine-based game)** — Full wizard support for Wreckfest 2 on GameCTL's own from-scratch image (ghcr.io/gamectl-hq/wreckfest2-kube). The WF2 dedicated server is Windows-only, so it runs under WineHQ stable with a virtual display — the first game in the fleet to do so, and the pattern future Windows-only servers will follow. The wizard covers the server browser name, welcome message, join password, event rotation, lobby countdown and vote times, admin flags, and the game port (default 30100 UDP). Like the rest of the fleet the ~2GB server installs to your volume on first boot and normal boots never run SteamCMD.
- **MIT license** — GameCTL now ships a LICENSE file (MIT), so the project is explicitly free to use, fork and self-host.

### Changed

- **Clearer storage prerequisites in the README** — Documents that importing existing game files as any user is supported, and that the images self-heal ownership on boot — so you do not have to chown a save directory by hand before pointing GameCTL at it.
## [v0.0.32-beta] - 2026-07-18

> GameCTL now pairs with ProxyCTL end to end: pick an "Internet" mode in
> the deploy wizard and your server — and its companion sites (BlueMap,
> CS2 surf records) — get their public DNS as part of the deploy itself.
> Deleting a server can clean all of it up again.

### Added

- **ProxyCTL integration — publish game servers on the internet from
  GameCTL.** When a sibling [ProxyCTL](https://proxyctl.cc) install is
  detected in the cluster:
  - Each server instance gains a compact **Networking panel** showing both
    exposure paths side by side: the LAN (MetalLB) address and the public
    (ProxyCTL) one. Link ProxyCTL once (URL + operator login, verified via
    its `/api/token` and stored in the `gamectl-proxyctl` Secret), then
    publish per server: subdomain + a domain from ProxyCTL's list, ports
    auto-derived from the game Service, entry targeting the Service's live
    ClusterIP, and an automatic ProxyCTL Apply (tunnel + Cloudflare DNS).
    Pause/resume, re-apply, drift detection ("Service ClusterIP moved —
    update & re-apply"), and unpublish (optionally removing the DNS
    record) are all one click.
  - The deploy wizard's Networking step gains a **Player access** choice —
    LAN (MetalLB), LAN + Internet, or **Internet only**. Internet-only
    skips MetalLB: the generated Service stays ClusterIP (ProxyCTL's
    in-cluster WireGuard gateway reaches it directly), so public-only
    servers don't consume a LAN IP. The MetalLB pool/IP fields hide when
    they don't apply; at least one exposure path is always selected.
  - Instances with more than one bindable Service get **one publish row per
    target** — Minecraft + BlueMap, CS2 + its surf-records website — each
    with its own subdomain, ports, and pause/unpublish controls (role
    chips: game / bluemap / records). Companion Services that run their own
    workload (like `<name>-records`) are discovered by ownership-checked
    name prefix, so `cs2` never claims `cs2-2`'s Services.
  - **RCON ports are never published.** Game Services carry an `rcon` port
    for GameCTL's own console (ClusterIP-internal); the port derivation
    excludes it so a publish can't put RCON on the public droplet.
  - **Web companions publish over Cloudflare Tunnel, not raw ports.**
    HTTP targets (BlueMap, the surf-records site — detected by their
    http/web-named TCP ports) create ProxyCTL **WebRoutes**: cloudflared
    in-cluster → Cloudflare edge, TLS + WAF included, no droplet port
    burned. The panel shows the `https://` address with an open-in-tab
    link; game ports keep using L4 entries. Publishing a web target
    triggers ProxyCTL's tunnel reconcile (first run can take ~a minute —
    the publish endpoints got a longer request slot for it).
  - With "Internet only" selected in the wizard, MetalLB pool/IP fields
    now hide on **every** step — including the BlueMap step's own
    LoadBalancer IP, which previously sat greyed-out asking for a pool
    that no longer existed.
  - **Deploy + DNS in one action.** With an "Internet" exposure mode, the
    wizard's Networking step offers a public subdomain + domain (from the
    linked ProxyCTL); the choice rides the manifest as `gamectl.io/publish-*`
    annotations and, right after a successful apply, the deploy task runs a
    "Publish via ProxyCTL" phase that creates every target's binding — game
    as `<sub>.<domain>` (L4), companions as `<sub>-<role>.<domain>`
    (Cloudflare Tunnel) — and pushes ProxyCTL's apply/tunnel reconcile.
    Works headless (Services get ClusterIPs at apply time, and the phase
    runs server-side, so closing the browser doesn't matter); best-effort
    (a publish failure marks the phase in the task log, never the deploy);
    skippable (leave the domain unset and publish later from the panel).
  - Wizard polish: the **Public subdomain** field shows the actual server
    name as its value (live-mirrored until you override it) instead of a
    placeholder; the **Public domain** dropdown pre-selects your first
    ProxyCTL domain (the empty "publish later" option is now the explicit
    opt-out); and Minecraft's **BlueMap download EULA defaults to
    accepted** — the wizard deploy already accepts the same Mojang EULA
    (EULA=TRUE), so the old "No" default just shipped a map that was
    silently down.
  - **Delete cleans up public access too.** The delete confirmation gains
    an "Also remove ProxyCTL public access" checkbox (on by default,
    optional): the delete task first runs an "Unpublish from ProxyCTL"
    phase — removing the instance's tunnel entries, web routes, and their
    DNS records, then re-applying ProxyCTL — before the cluster sweep
    deletes the Services the bindings resolve through. Best-effort and
    skipped automatically when nothing is published or ProxyCTL isn't
    linked; a failed unpublish never blocks the delete.
  - New API: `GET /api/proxyctl/status`, `PUT`/`DELETE /api/proxyctl/link`,
    and `GET`/`POST`/`DELETE /api/games/instances/{ns}/{name}/publish`
    (`service` selects the target on multi-Service instances).
  - Without ProxyCTL nothing changes — MetalLB remains the built-in
    (mandatory) path and the extra UI never renders.
  - **Released builds hide the "Unreleased" notes section.** The in-app
    What's-new list only shows the Unreleased staging entry on dev/SHA
    builds; tagged releases list exactly what shipped.

## [v0.0.31-beta] - 2026-07-17

> Fixes game-server creation failing against NFSv3-only servers (common on
> NAS defaults) with a misleading "Couldn't reach NFS server" error.

### Fixed

- **Game-server creation works on NFSv3-only NFS servers.** The NFS helper
  pods mounted exports without `nolock`, so on servers that only speak NFSv3,
  `mount.nfs` tried to launch `rpc.statd` through a wrapper that calls GNU
  `flock -e` — an option BusyBox's `flock` doesn't have. statd died, the mount
  failed with exit 32, and the UI blamed it on "Couldn't reach NFS server"
  (with `flock: unrecognized option: e` buried in the helper log). The helper
  pods only create, inspect, and delete directories — NFS file locking buys
  them nothing — so they now mount with `nolock` and skip statd entirely.
  NFSv4 servers ignore the option, so nothing changes for them.

## [v0.0.30-beta] - 2026-07-17

> GameCTL updates only when you ask. It pins itself to a fixed version, so a pod
> restart can no longer bump you to a new build unprompted.

### Fixed

- **GameCTL no longer updates itself without prompting.** Installs now pin an
  immutable version tag instead of a moving `:latest`. Previously the deployment
  re-pulled the newest published image on any restart, so an ordinary pod
  reschedule — a node drain, an eviction, or re-running the installer — could
  silently upgrade GameCTL to a build you never chose. Now a restart re-pulls the
  exact same version, and the only thing that moves you to a new release is
  clicking **Update**.

### Changed

- **"Update" pins the specific new release.** The in-app update button used to
  just restart the deployment and let it grab whatever `:latest` pointed at. It
  now sets the container image to the exact release tag it's offering, so you
  land on precisely that version — and stay on it across restarts until you
  choose to update again.

## [v0.0.29-beta] - 2026-07-17

> Game servers now deploy on NAS boxes that only speak NFSv3 — GameCTL lets the
> mount negotiate its NFS version instead of demanding v4.2.

### Fixed

- **NFS storage works with servers that don't speak NFSv4.2.** GameCTL previously
  pinned every NFS mount to version 4.2. On a NAS that only offers NFSv3 (common
  on older Synology/QNAP units, or anywhere v4 is disabled) the mount silently
  failed and the game pod hung before it ever started — surfacing as an
  unexplained deploy timeout rather than a storage error. Mounts now leave the
  version unset so the client negotiates the best version both ends support (4.2,
  4.1, 4.0 or 3). This affects every game's generated storage as well as the
  internal helper that creates and cleans up NFS directories. If your server
  already speaks 4.2 nothing changes.

## [v0.0.28-beta] - 2026-07-12

> Save-file backups — now rock-solid to list and easy to inspect — plus
> reliability polish: Valheim starts cleanly on the first deploy, and new NFS
> shares get a guided setup.

### Added

- **Save-file backups with schedule, retention and restore.** Each game's
  Manage screen has a new **Backups** panel: pick a destination storage
  location (e.g. a roomy HDD share), an interval (hourly / 6h / daily /
  weekly or a custom cron) and how many backups to keep, and GameCTL renders
  a CronJob that snapshots **just the save files** and rotates out the
  oldest. **Back up now** takes an on-demand snapshot and **Restore** stops
  the server, restores a chosen archive, then starts it again — both tracked
  in the Tasks menu. The backup knows each game's real save paths (Satisfactory
  `SaveGames`, Factorio `saves`/`mods`, Core Keeper worlds, Minecraft world
  folder via `LEVEL`, …) so it skips multi-GB game installs; a **whole
  volume** scope is selectable per game, and match servers with no persistent
  save (CS2, Quake, L4D2) are flagged as having nothing to back up. Backup
  Jobs mount the game's data NFS export read-only + the destination
  read-write (the same inline-NFS pattern game pods use — no PVC, no
  privilege), and are labelled `gamectl.io/instance` + owned by the
  Deployment so they're cleaned up when the instance is deleted.
- **Guided NFS share setup + a backup-archive how-to.** The **Storage
  Locations** screen has a collapsible **"How to make an NFS Share? (Ubuntu)"**
  walkthrough with copy-paste `apt` commands (installs `nfs-kernel-server` +
  `nfs-common`, creates `/mnt/nfs-share`, exports it), plus a reminder that the
  export must let the cluster mount it — export to `*` or list your node / pod
  network. The **Backups** panel gains a **"How to open a .tar.gz backup"**
  note (`tar -tzvf` to peek inside, `tar -xzf` to extract) pointing at the
  exact on-share path.

### Fixed

- **Stored backups now list reliably — even on clusters without internet.**
  The Backups panel could show *No backups yet* even when archives existed on
  the share. Listing now mounts the destination the same way backups are
  written (an inline NFS volume) instead of an in-pod mount that needed the
  node to reach the internet, so archives show up everywhere.
- **Valheim starts reliably on the first deploy.** The Valheim image's
  SteamCMD occasionally fails its first download with *Failed to install app
  896660 (Missing configuration)*, leaving the pod stuck on the initial step
  (worst on slower hosts). GameCTL now primes and pre-downloads the server
  with retries before the image's own updater runs, so it comes up on the
  first try — and world saves stay on your persistent storage.

### Thanks

- **Thanks to Grizz for troubleshooting Valheim** — hands-on help tracking
  down the first-boot SteamCMD failure.

## [v0.0.21-beta] - 2026-05-29

> CS2 now reliably updates to the latest build on every (re)start — no more
> getting stuck on an old build that clients can't join — and surf's
> **!replay** / **!ghostcam** plus the speed/timer HUD finally ship (the
> embedded plugin had drifted behind its source). RTV gains more surf maps
> and admin map/mode pickers.

### Fixed

- **CS2 reliably updates to the latest build (no more SteamCMD "0x6" stuck
  updates).** On the kus image a freshly-downloaded SteamCMD self-updated
  mid-run and left the game update wedged at state 0x6, so the server
  silently launched a **stale** build and players on the newer client build
  couldn't connect. The boot now pre-warms SteamCMD and clears stale staging
  before updating, so the latest build always lands. The manage-screen
  "Auto-update on next start" toggle works for CS2 again (full validate vs
  fast start).
- **Surf !replay / !ghostcam and the speed/timer HUD now actually ship.** The
  surf HUD plugin (base64-embedded in the generator) had drifted behind its
  source, so deployed servers ran an old build missing the recent !replay /
  !ghostcam (chicken/hostage/cube ghost models + fading trail) and timer
  work. Rebuilt + re-embedded; a deploy gate + CI check now stop a stale
  plugin from silently shipping again.

### Added

- **RTV: more surf maps, admin !modes / !maps pickers, and a changelevel-
  freeze fix.** Five more surf maps in the in-game !rtv pool, plus admin
  !modes / !maps pickers. GameCtlRtv is now the sole map/mode handler (the
  kus image's own Map/Mode commands are disabled), fixing a freeze where a
  typo'd !map name made the image announce a changelevel that then failed
  and hung everyone.

### Changed

- **CS2 wizard welcome-message example is now generic** — no personal server
  name in the first-install placeholder.

## [v0.0.20-beta] - 2026-05-22

> Surf servers now spawn players **weaponless** (knife only) instead of
> with the default pistol. Reminder: the SharpTimer timer needs a
> wizard surf **deploy** — the live-panel Surf button only switches
> cvars and can't install the plugin stack.

### Fixed

- **Surf servers no longer spawn players with a pistol.** The surf cfg
  profile now empties the default primary/secondary loadouts so
  players spawn with a knife only, disables the buy menu and money,
  gives free armor, and enables instant respawn (a missed ramp
  shouldn't bench you for a round). Surf is a pure movement mode — the
  starting pistol was leftover from CS2's Custom-mode defaults.

### Changed

- **Reminder: the surf timer requires a wizard surf deploy, not a live
  mode switch.** The SharpTimer plugin stack (timer, zones, speed HUD,
  records) is installed by an init container that only exists on a
  server *deployed* as surf through the wizard. Clicking the
  live-panel "Surf" button on a non-surf server switches
  `game_type`/cvars over RCON for the movement physics, but cannot
  install plugins — so there's no timer or speed display. Deploy (or
  re-deploy) the CS2 server with the "Surf (timer + records)" wizard
  mode to get the full experience.

## [v0.0.19-beta] - 2026-05-21

> CS2 gets a **Surf** game mode with the full SharpTimer plugin stack
> (timer, zones, records), Steam Workshop map support, and one-click
> game-mode switch buttons on the manage screen.

### Added

- **CS2 Surf mode — SharpTimer plugin stack, auto-installed.** The CS2
  wizard has a new "Surf (timer + records)" game mode. Picking it runs
  the server as `game_type 3` / `game_mode 0` (Custom) with surf
  movement cvars (`sv_airaccelerate 800`, bunnyhop, no fall damage,
  endless rounds) and adds an init container that installs the full
  CS2 surf plugin stack onto the data volume: Metamod:Source,
  CounterStrikeSharp (pinned to a SharpTimer-compatible build), the
  SharpTimer timer/zones/records plugin, plus MovementUnlocker and
  RampBugFix. The init container patches `gameinfo.gi` for the Metamod
  search path, is idempotent (a version-marker file gates
  re-downloads), and re-applies the patch every boot since a CS2
  update overwrites that file. SharpTimer records + config persist on
  the data volume across redeploys. On a brand-new data volume the
  `gameinfo.gi` patch lands on the second boot (CS2 isn't installed
  yet when init containers first run); deploying surf onto an existing
  CS2 data path works on the first boot.
- **CS2 Steam Workshop maps.** The CS2 wizard now has Workshop map
  fields — a single map's numeric Workshop ID or a whole collection's
  ID — wired to the image's `CS2_HOST_WORKSHOP_MAP` /
  `CS2_HOST_WORKSHOP_COLLECTION` env vars. Surf maps (and KZ, bhop) are
  all Workshop content. The live Map panel also grew a "Workshop map
  ID" input that loads any workshop map on the running server.
- **One-click game-mode switch buttons on the CS2 manage screen.** A
  row of one-click mode buttons (Competitive, Casual, Wingman,
  Demolition, Deathmatch, Arms Race, Surf) alongside the existing
  dropdown — click one to switch the running server immediately, with
  the active mode highlighted.

### Fixed

- **CS2 live panel showed the wrong current game mode.** The backend
  read un-prefixed env names (`GAMETYPE` / `GAMEMODE` / `MAXPLAYERS` /
  `SRCDS_ADDITIONAL_ARGS`) that the `joedwards32/cs2` image never
  receives — the generator emits `CS2_*`-prefixed names. So the manage
  screen's CS2 panel always fell back to "Competitive" / 16-player cap
  regardless of the server's actual mode. The backend now reads the
  correct `CS2_GAMETYPE` / `CS2_GAMEMODE` / `CS2_MAXPLAYERS` /
  `CS2_BOT_DIFFICULTY` vars, plus a new `CS2_GAMEMODE_PROFILE`
  discriminator so Surf is reported correctly.

## [v0.0.18-beta] - 2026-05-21

> Fixes the silent "copy address" and "copy password" buttons on
> plain-HTTP installs, and beefs up the visual confirmation so you can
> see the copy actually succeeded.

### Fixed

- **Copy buttons (IP address, credentials) now work over plain HTTP.**
  The browser's `navigator.clipboard.writeText` API only exists in
  secure contexts (HTTPS or `localhost`). GameCTL is commonly accessed
  over plain `http://lan-ip:8080`, where the API is undefined — so
  `navigator.clipboard?.writeText(...)` short-circuited to `undefined`,
  the `.then()` that set `copied=true` never ran, and the click was a
  silent no-op with no feedback. There's now a `copyText()` helper that
  tries the modern API first and falls back to a hidden-textarea +
  `document.execCommand('copy')` trick that works on every modern
  browser, including non-secure contexts. The CopyableAddress chip and
  the CredentialRow copy button both use it.

### Changed

- **Copy buttons show an obvious "✓ Copied!" confirmation.**
  Successful copies now color-swap the whole chip/button (emerald
  background + bigger `✓ Copied!` label) for ~1.5 seconds instead of a
  faint grey tick. Failed copies (e.g. when no clipboard API is
  available at all) color-swap to a rose `✗` with a hint to select
  manually, so the click is never a silent no-op.

## [v0.0.17-beta] - 2026-05-21

> Fixes the nonsense update banner that read "v0.0.15-beta is available
> — you're on v0.0.16-beta", and surfaces the Storage **Test** as a
> five-step plan so you can see exactly what the probe checks.

### Fixed

- **Update banner no longer claims an older release is "available".**
  The update checker compared versions with `!=` (inequality) instead
  of a proper semver "b > a" check, so any brief window where the
  GitHub Releases API still pointed at the previous release (a normal
  lag between `git push --tag` and the release workflow marking the
  new Release as "latest") would trip the banner with the wrong
  direction — *"v0.0.15-beta is available — you're on v0.0.16-beta"*.
  The checker now parses both sides as semver (with prerelease
  handling, so `v1.0.0-beta < v1.0.0`) and only sets
  `updateAvailable=true` when latest is strictly newer than the
  running build. Unparseable inputs (SHA-stamped dev builds, empty
  strings, `dev`) never flip the banner.

### Changed

- **Storage Test button now shows the five-step plan + per-stage
  outcomes.** The Test button result panel now renders the probe's
  checklist — Mount the share / Create the `.gamectl-probe` test
  directory / Write a small test file / Read it back and verify the
  bytes / Delete the test file — with a green check next to each step
  that ran successfully and a red ✗ on the failing one (subsequent
  steps are shown as "not reached"). While the probe pod is running
  the same list is shown with a pulsing indicator so you can see what
  the test is actually doing. The backend's `StorageProbeResult` now
  includes a `steps` array driving this; existing fields (`ok`,
  `stage`, `message`, `hint`, `details`) are unchanged.

## [v0.0.16-beta] - 2026-05-21

> Storage Locations now has a **Test** button per row that actually
> verifies reachability + read/write before you deploy a game against
> it. Spawns a one-shot probe pod that mounts the share the same way a
> real game would, writes + reads + deletes a tiny test file, and
> classifies any failure with a targeted hint — no more "the deploy
> looked fine until the pod tried to write".

### Added

- **Storage Locations: Test reachability + read/write per row.** Each
  row in Storage Locations now has a "Test reachability + read/write"
  button. Clicking it spawns a short-lived probe pod in the gamectl
  namespace that mounts the same inline NFS (or hostPath) volume a
  real game would use, then in order: `mkdir`'s the `.gamectl-probe`
  subdir under the configured top-level folder, writes a tiny test
  file, reads it back and compares bytes, deletes the file, and
  exits. The UI shows a green `✓ Mount + read/write OK · <ms>` on
  success and a red strip with the failing stage + a targeted hint on
  failure. The probe pod is always deleted on the way out and has a
  20s hard deadline. New endpoint: `POST /api/storage/locations/test`.
- **Targeted error classifier for storage test failures.** Failures
  don't just print the raw kubelet message — the backend classifies
  them by stage so the hint matches the actual cause. Examples:
  `mount` stage "access denied" → *"The NFS server refused the mount.
  Add the node's IP to /etc/exports and run `exportfs -ra`"*; `mount`
  stage "no route to host" → *"NFS server unreachable from the node;
  check port 2049/TCP"*; `mkdir` stage → *"Read-only export or
  `root_squash` + wrong uid; mark the export `rw` (consider
  `no_root_squash`)"*; `write` stage → *"Read-only export or
  filesystem out of space"*; `timeout` stage → falls back to the
  mount classifier with the kubelet's waiting message in the details.
  The raw output is always available under a "raw output" details
  twirldown for the cases where the classifier guessed wrong.

## [v0.0.15-beta] - 2026-05-21

> Closes the loop on the install flow. install.sh has been printing the
> bootstrap token in the URL it tells operators to open
> (`http://host:8080/?token=…`) for several releases, but the UI half —
> reading that param and seeding the first-run setup field — was
> missing in the published build, so the field showed up empty and the
> token had to be pasted by hand. **Please update.**

### Fixed

- **First-run setup: bootstrap token from `?token=…` actually pre-fills
  the field.** `install.sh` prints the first-run URL with the bootstrap
  token in the query string (`http://host:8080/?token=abc…`) so the
  operator only needs a username + password. The UI side of that —
  reading the param and seeding the setup form — was missing from the
  published image: the field initialized as an empty string and the
  token had to be pasted by hand. Now the bootstrap field is
  initialized from `URLSearchParams(location.search).get('token')` on
  first render, and on a successful setup POST the token query param
  is removed from the URL via `history.replaceState` so a refresh
  doesn't re-attempt with the now-dead token.

## [v0.0.14-beta] - 2026-05-20

> Finishes the k3s fresh-install path the previous two releases started
> — **please update**. v0.0.13's kubeconfig-perm fix copied the file to
> `~/.kube/config`, but the k3s-wrapped `kubectl` (a symlink to the
> `k3s` binary) **hardcodes** `/etc/rancher/k3s/k3s.yaml` unless
> `$KUBECONFIG` is set, so the installer still aborted on the retry.

### Fixed

- **Installer now sets `$KUBECONFIG` so the k3s `kubectl` wrapper
  actually uses `~/.kube/config`.** On k3s, `kubectl` is typically a
  symlink to the `k3s` binary (`k3s kubectl`), and that wrapper
  hardcodes `/etc/rancher/k3s/k3s.yaml` unless `$KUBECONFIG` is set in
  the environment. So v0.0.13-beta's copy to `~/.kube/config` wasn't
  enough by itself — the wrapper kept trying the root-only file and
  the installer aborted on the second cluster-reachability check. The
  installer now does both halves of the fix: copies the kubeconfig
  (if not already done) AND exports `KUBECONFIG=$HOME/.kube/config`
  for the rest of its run, and appends the same `export` to
  `~/.bashrc` so future shells work without manual setup. The
  detection block also now handles the "partial fix from a previous
  run" state (file already at `~/.kube/config`) by re-using it
  instead of re-prompting.

## [v0.0.13-beta] - 2026-05-20

> Follow-on hotfix to **v0.0.12-beta**. The installer now handles the
> second-most-common first-install footgun on a fresh k3s box —
> `kubectl` refusing to talk to the cluster because
> `/etc/rancher/k3s/k3s.yaml` is root-only. The installer detects this
> and offers to copy the kubeconfig to `~/.kube/config` (y/N).

### Fixed

- **Installer auto-fixes the k3s kubeconfig-permission failure.** On a
  fresh k3s install, `/etc/rancher/k3s/k3s.yaml` is owned `root:root`
  mode `600` by default, so `kubectl` as a normal user gets "permission
  denied" on the kubeconfig and the installer aborts with "kubectl
  can't reach a cluster." The installer now detects this specific
  shape (k3s present, no `KUBECONFIG` set, no `~/.kube/config`, not
  running as root) and offers a y/N prompt to copy the kubeconfig to
  `~/.kube/config` owned by the current user (mode `0600`). On "no",
  it prints the exact one-liner to run by hand. Decline-and-retry
  behavior is non-destructive — nothing is touched without consent.

### Changed

- **README: "Tested on k3s" note added to the install section.**
  GameCTL targets any conformant Kubernetes 1.28+, but the installer's
  bootstrap helpers (auto-detected ingress, optional MetalLB install,
  k3s kubeconfig-permission fix) are shaped around k3s — the easiest
  path from "blank Linux box" to "running GameCTL". Other distros
  (microk8s, kubeadm, EKS/GKE/AKS, kind) work too; the note in the
  README is now explicit about that scope.

## [v0.0.12-beta] - 2026-05-20

> **Hotfix release — please update.** The `curl | bash` installer was
> aborting on a fresh shell before it could deploy anything (BASH_SOURCE
> unbound under `set -u`), so new k3s installs were blocked. Also a full
> Terraria fix and a small CS2 wizard add-on.

### Fixed

- **Installer no longer aborts under `curl | bash`.** Running
  `curl -fsSL https://gamectl.cc/install.sh | bash` on a fresh machine
  failed before doing any work with `BASH_SOURCE[0]: unbound variable`
  / `cd: null directory`. When the script is piped from stdin there's
  no file on disk, so `BASH_SOURCE[0]` is unset, and combined with
  `set -u` the `SCRIPT_DIR` resolution aborted. The installer now
  defaults `BASH_SOURCE[0]` to empty, skips the `cd` when no source
  file exists, and falls through to fetching the manifest from the
  published URL — the intended path for `curl | bash`.
- **Terraria: server actually starts and is playable end-to-end.**
  Three bugs were stacked. (1) The `mark2dot0/tshock` image was last
  updated in 2021 and is pinned to Terraria 1.4.2.3, so current
  1.4.5.x clients connected, the TCP handshake completed, then the
  protocol handshake silently failed — the client hung forever at
  "Found Server". The wizard now defaults to
  `ryshe/terraria:vanilla-1.4.5.6` (actively maintained, matches
  current retail Terraria, no TShock account/login dance).
  (2) `TerrariaServer.exe` spawns an input-reader thread
  (`startDedInputCallBack`) that NPEs on a null Console stream when
  stdin isn't attached — the container now sets `stdin: true` and
  `tty: true` so the dedicated server boots instead of crashlooping.
  (3) World gen is single-threaded; the previous 1-core CPU limit
  made Large worlds take 20+ minutes. Defaults are now
  `cpu: 500m / 2`, surfaced as editable fields in the wizard form.

### Added

- **CS2 wizard: "Hibernate when empty" toggle (default on).** CS2's
  `sv_hibernate_when_empty 1` keeps an empty server idle (no map
  tick) so it doesn't burn CPU during off-hours. Exposed as a wizard
  checkbox, on by default. Turn it off if you want a server that
  stays warmed up — e.g. for a quick-join workflow where the first
  connector shouldn't wait the few seconds for the map to wake.

## [v0.0.11-beta] - 2026-05-19

### Fixed

- **CS2: 5v5 vs bots actually plays now (movement, weapons, bot fill).**
  A stack of related bugs left freshly-deployed CS2 servers with one
  frozen bot, players who connected but couldn't move or switch weapons,
  and instant `Going to intermission…` loops. Root causes fixed
  together: the generator emitted env vars the `joedwards32/cs2` image
  does **not** read (`HOSTNAME` / `RCON_PASSWORD` / `GAMETYPE` /
  `SRCDS_ADDITIONAL_ARGS` — now `CS2_SERVERNAME` / `CS2_RCONPW` /
  `CS2_GAMETYPE` / `CS2_ADDITIONAL_ARGS`); CS2 regenerates
  `gamemode_<mode>.cfg` from the depot on every boot, wiping the image's
  bot `sed` (now overridden by an operator-owned
  `gamemode_<mode>_server.cfg` written by an init container, with
  mode-pinned `mp_maxrounds`, `mp_roundtime`, `mp_freezetime`,
  `mp_halftime`, `mp_match_can_clinch`, `mp_autoteambalance`/
  `mp_limitteams` so Casual↔Competitive panel switches can't strand the
  server in a Game-Over latch); CS2's match-start team-intro cinematic
  and competitive's online-warmup hold (`mp_team_intro_time` /
  `mp_warmup_online_enabled`) — both froze players in place on a
  community/bot server — are disabled in that override.
- **CS2 wizard no longer re-downloads the full ~65G install on
  restart.** The `joedwards32/cs2` image's SteamCMD retry path does
  `rm -rf $STEAMAPPDIR/steamapps` (deleting the appmanifest) on any
  non-zero exit; that forces the next attempt to pull the whole game
  from base. With auto-update on, the heavy ~65G `validate` could trip
  this on its own (especially OOM-killed under the previous 2Gi memory
  cap). The wizard now defaults **Auto-update to Disabled** (the install
  persists on NFS and is reused for fast starts; first deploys still
  install fine — SteamCMD always runs), and the cs2 memory limit is
  bumped 2Gi → **4Gi** so validate has headroom when you do enable
  updates. Default data PVC size **50Gi → 100Gi** (the install alone is
  ~65G).
- **Terraria no longer hangs on the "Choose World" prompt.** The
  `mark2dot0/tshock` image ignores the `WORLD_*`/`MAX_PLAYERS` env vars
  the generator was setting, so first-time servers dropped into the
  interactive world picker and spun forever on EOF. The Deployment now
  passes real Terraria server CLI args (`-world /world/<name>.wld
  -autocreate <size> -worldname <name> -difficulty <n> -maxplayers <n>
  -port <n> [-password <pw>]`) — the world auto-creates on first boot
  and loads thereafter.
- **Grey-screen crash on the CS2 manage page (and missing Minecraft RCON
  console).** The per-game RCON quick-commands code referenced an
  undefined `game` identifier during render, throwing a `ReferenceError`
  that took down the whole manage page on cs2 (grey screen) and silently
  hid the RCON console + OP buttons on Minecraft. Affected every
  RCON-capable game (cs2, minecraft, factorio, project-zomboid).
- **Logs and RCON console no longer scroll the whole page on refresh.**
  The log/RCON panels used `scrollIntoView()` on a sentinel inside the
  box, which scrolls the nearest scrollable ancestor up to and including
  the document — so every 5-second log auto-refresh yanked the page
  down to keep the log in view, pulling buttons out from under the
  operator. Both now scroll only their inner container. The log viewer
  also stops auto-following the tail the moment you scroll up to read
  older lines, and resumes tailing when you scroll back to the bottom.
- **RCON now finds the password regardless of image convention.**
  Backend RCON only looked for an env var named `RCON_PASSWORD`, but
  the CS2_* env mapping fix renamed it to `CS2_RCONPW` (the
  joedwards32/cs2 image's actual name) — so the CS2 Live panel and
  RCON console reported "server has no `RCON_PASSWORD` set" even though
  the password was right there. The lookup now recognizes
  `RCON_PASSWORD` and `CS2_RCONPW` (and falls back across the known
  list).

### Added

- **Restart / Stop / Start on every instance card.** Each game instance
  card now has explicit **Restart**, **Stop**, and **Start** controls
  next to Delete. Restart does a rolling restart (and applies any
  pending settings — see auto-update below). Stop/Start scale to 0/1
  replicas.
- **One-click CS2 controls on the manage screen.** The CS2 live-controls
  panel grew a "Quick actions" row driven by Source RCON: **Restart
  round** (`mp_restartgame 1`), **End warmup**, **Swap teams**,
  **Pause/Unpause**, **Add bot**, **Kick bots**, plus a **Change-map**
  dropdown of the standard pool with a one-click **Load map**. All ride
  the existing `/rcon` endpoint — no pod restart for any of them.
- **Full Minecraft live-controls panel on the manage screen.** New
  per-instance panel mirroring the CS2 layout: Difficulty and Default
  gamemode selects with Apply; **World** subsection split into Time
  (Day/Night/Noon/Midnight), Weather (Clear/Rain/Thunder, applied with
  a long duration so the change visibly sticks), Actions
  (Save / Save off / Save on / Reload / List), and Whitelist
  (on / off / reload list); a **Gamerule** dropdown of 20 boolean
  gamerules with **true / false / query** buttons; a **Players** section
  with a name input plus Role buttons (OP / De-op / Kick / Ban /
  Pardon / Whitelist +/−) and per-player Gamemode buttons (Survival /
  Creative / Adventure / Spectator); and a **Broadcast** row that
  pushes a `/say` message with Enter-to-send. The generic RCON terminal
  still renders below for anything not on a button.

### Changed

- **Auto-update toggle no longer restarts the server when flipped.**
  Toggling the per-instance "Auto-update on next start" setting used to
  immediately roll the Deployment. The choice is now recorded as a
  Deployment metadata annotation (no pod disruption); the live toggle
  shows an amber **"pending — restart to apply"** badge when the saved
  value differs from the running pod's env. The new **Restart** button
  is the single point where the change applies — it folds the pending
  env into the same rollout.
- **CS2 wizard: GSLT field clarified with a steamgamesettings.com
  link.** The SRCDS Token (GSLT) wizard field now has a placeholder and
  hint explaining what a token gives you (persistent server identity,
  public server-browser listing, VAC-eligible) and links to
  steamgamesettings.com for app ID 730. The server runs and is joinable
  by direct connect without one — it's not strictly required, just
  recommended for an internet-facing server.
- **CS2 wizard cleanup.** Removed the "Pin to node (hostname)" field —
  CS2 was the only game exposing a `nodeSelector`, an empty-by-default
  convenience with no resource or `hostPath` reason to keep it; it's gone
  from both the wizard schema and the generated Deployment. The free-text
  "Map" field is now a **"Start map" dropdown** of common competitive and
  classic maps (de_dust2, de_mirage, de_inferno, de_nuke, de_overpass,
  de_vertigo, de_ancient, de_anubis, de_train, cs_office, cs_italy) with a
  "Custom / workshop map…" option for off-list or workshop maps. The
  selection is now wired to `CS2_STARTMAP` (with `CS2_MAPGROUP=mg_active`),
  the env vars the upstream image actually reads — previously the
  configured map had no effect.
- **Minecraft: BlueMap storage consolidated.** When BlueMap is enabled,
  GameCTL no longer provisions a separate PV/PVC (and its own storage
  path) for the web tiles. The webroot lives under the main Minecraft data
  volume, so the extra volume was redundant. The redundant
  `PersistentVolume`/`PersistentVolumeClaim`, pod volume and volume mount
  are removed; tiles now persist on the existing data PVC and remain
  regenerable from the world. The BlueMap Service and plugin install are
  still gated by the BlueMap toggle — only the storage backing changed.
  **Migration:** for a server whose tiles currently live on the old
  separate path, re-applying the manifests drops the old binding and
  BlueMap re-renders into the data volume on next start (no data loss —
  the world is the source of truth). To skip the re-render, copy the
  existing tiles into `<data-volume>/bluemap/web/` before re-applying; the
  old path and its PV can be removed once the new render is confirmed.

## [v0.0.10-beta] - 2026-05-17

### Fixed

- **Satisfactory: persistent install & saves (production bug).** The
  Satisfactory data PVC was mounted at `/srv/satisfactory`, but the
  `wolveix/satisfactory-server` image installs the ~4.5 GB game files,
  saves, and backups under `/config`. Nothing on the persistent volume
  was actually the game data, so **every pod restart re-downloaded the
  whole game via SteamCMD**, frequently crash-looping on SteamCMD
  exit code 8, and **lost all saves**. The data volume is now mounted at
  `/config`, so installs and saves persist across restarts and upgrades —
  no more multi-GB re-download or lost worlds.

### Added

- **Satisfactory: per-game SteamCMD update controls.** New wizard
  options replace the old inert "Run update on start" field (the image
  never read `RUN_UPDATE_ON_START`/`INSTALL_IF_MISSING`). They drive the
  `SKIPUPDATE` env var the `wolveix` image actually reads:
  - **Update via SteamCMD on every start** — when off (default), a
    populated `/config` volume is reused as-is (fast starts, no
    needless revalidation); the image still self-installs onto an
    empty/wiped volume.
  - **Force a one-time SteamCMD update on next deploy** — runs a single
    validate/update on the next rollout. It also stamps a
    `gamectl.io/steamcmd-update` pod annotation so the Deployment
    actually rolls a new pod (an unchanged spec wouldn't restart).
- **In-app release notes.** The update tool now shows, in-app, what each
  GameCTL build changes — per-fix bullets sourced from this changelog and
  keyed to the running/available version.
