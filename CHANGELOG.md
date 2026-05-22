# Changelog

All notable changes to GameCTL are documented here. This file is the
human-readable companion to `server/internal/releasenotes/releases.json`,
which is embedded into the binary and surfaced in-app by the update tool
("What's new"). **Keep the two in sync** — when you add a release here,
add the matching structured entry to `releases.json` (same `version`).

The newest release is first. `version` matches the build stamp injected
via `-X main.version=$(VERSION)` (a git tag like `v0.0.2-beta`, or a
short commit SHA for untagged builds). `unreleased` collects changes that
ship in the next build that isn't yet tagged — the in-app tool shows it
for any running build whose version doesn't match a tagged entry.

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
