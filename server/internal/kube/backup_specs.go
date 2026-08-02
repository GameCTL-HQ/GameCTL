package kube

import "strings"

// BackupSpec describes, per game, what part of the data volume is worth backing
// up. GameCTL stores each server's data at <export>/GameCTL[-suffix]/<server>
// mounted into the container at DataMount; SavePaths are the subdirectories of
// that mount that hold the actual save/world state (everything else — game
// binaries, caches, logs, re-downloadable jars — is skipped by default).
//
// SavePaths are existence-filtered at backup time, so listing several candidate
// names (e.g. both "worlds_local" and the legacy "worlds") is safe: only the
// ones that exist are archived. A spec with SavePaths ["."] means "the whole
// data volume is save data" (the mount already points at just the worlds).
type BackupSpec struct {
	// DataMount is the container path the data volume is mounted at. Used to
	// pick the right inline NFS volume off the Deployment when a game mounts
	// more than one. Empty falls back to "the sole NFS-backed mount".
	DataMount string
	// SavePaths are paths relative to the data-volume root that constitute the
	// save. "." means the whole volume.
	SavePaths []string
	// ExcludePaths are paths relative to the data-volume root to skip when
	// SavePaths is ["."]. Some of GameCTL's own from-scratch images nest the
	// game's steamcmd/wine install (large, re-downloadable) inside the SAME
	// mount as the save data with no clean save-only subfolder to name
	// instead (e.g. Barotrauma's Multiplayer campaign saves sit next to
	// .gamectl/install). Ignored unless SavePaths is exactly ["."].
	ExcludePaths []string
	// Supported is false for games with no meaningful save to back up: pure
	// match/session servers (CS2, Quake3, L4D1/2, Sandstorm's wave-based
	// Checkpoint PVE, Wreckfest/Wreckfest2, BeamMP) with no persistent
	// world/character state — config only, regenerated from env each boot.
	Supported bool
	// Note is a short human explanation shown in the UI.
	Note string
}

// backupSpecs is keyed by the Deployment's `game` label (e.g. "corekeeper",
// "7d2d"). Paths verified against the live homelab data dirs on the NFS share.
var backupSpecs = map[string]BackupSpec{
	"corekeeper": {
		DataMount: "/home/steam/core-keeper-data",
		// Core Keeper's layout varies by image revision; list every plausible
		// world/save dir + the server config and let existence-filtering keep
		// whatever this server actually uses. The whole dir is only a few MB.
		SavePaths: []string{
			"saves", "servermaps", "maps", "worlds", "worldinfos", "worldgenparams",
			"ServerConfig.json", "Admins.json", "PlayerBans.json", "prefs.json",
		},
		Supported: true,
		Note:      "World saves, maps and server config (skips mods/logs).",
	},
	"satisfactory": {
		DataMount: "/config",
		// GameCTL's from-scratch image installs the ~15GB game to
		// /config/gamefiles and symlinks the Epic/FactoryGame save dir it
		// writes to onto /config/saved — that's the whole save, cleanly
		// separate from the install (see Satisfactory-Kube entrypoint.sh).
		SavePaths: []string{"saved"},
		Supported: true,
		Note:      "Save games only (excludes the ~15GB game install under /config/gamefiles).",
	},
	"factorio": {
		DataMount: "/factorio",
		SavePaths: []string{"saves", "mods", "config", "scenarios"},
		Supported: true,
		Note:      "Save .zips, installed mods, scenarios and server config (skips the baked-in game binary).",
	},
	"minecraft": {
		DataMount: "/data",
		// World dir name is configurable (server.properties level-name); the
		// effective paths are resolved from the LEVEL env at backup time. These
		// are the fallback when no LEVEL is set.
		SavePaths: []string{"world", "world_nether", "world_the_end"},
		Supported: true,
		Note:      "World folder(s) (excludes the server jar, libraries and BlueMap tiles).",
	},
	"valheim": {
		DataMount: "/config",
		SavePaths: []string{"worlds_local", "worlds"},
		Supported: true,
		Note:      "World .db/.fwl files (worlds_local).",
	},
	"terraria": {
		DataMount: "/root/.local/share/Terraria/Worlds",
		SavePaths: []string{"."}, // the mount IS the Worlds dir
		Supported: true,
		Note:      "All Terraria worlds.",
	},
	"projectzomboid": {
		DataMount: "/home/steam/Zomboid",
		SavePaths: []string{"Saves", "db", "Server"},
		Supported: true,
		Note:      "Saves, the player DB and server config (skips the game's own backups/ + Workshop).",
	},
	"7d2d": {
		// GameCTL's from-scratch image mounts the game's actual UserDataFolder
		// (/app/.local/share/7DaysToDie), NOT the steamcmd install dir — an
		// earlier version of this spec pointed at /steamcmd/7dtd, which never
		// matched any volume mount and made backups fall back to "the sole NFS
		// volume" (working by luck, not intent). See 7DTD-Kube entrypoint.sh.
		DataMount: "/app/.local/share/7DaysToDie",
		// serverconfig.xml holds the operator's own edits beyond the handful
		// of keys GameCTL manages (world gen, difficulty, ...) — worth saving
		// alongside the world itself.
		SavePaths: []string{"Saves", "serverconfig.xml"},
		Supported: true,
		Note:      "World saves + serverconfig.xml (the game install lives in .gamectl/install on the same mount and is skipped).",
	},
	"necesse": {
		DataMount: "/necesse/saves",
		// The mount root is Necesse's own "-localdir" saves folder, but the
		// from-scratch image also installs the game into .gamectl/install
		// INSIDE it — SavePaths ["."] would archive that steamcmd install
		// every run. The actual world lives in a subfolder named after the
		// WORLD env; effectiveSavePaths (backup.go) resolves this dynamically
		// per-instance the same way it does Minecraft's LEVEL. This entry's
		// SavePaths is just the default ("GameCTL") fallback.
		SavePaths: []string{"GameCTL"},
		Supported: true,
		Note:      "This server's world save (excludes the game install nested in the same mount).",
	},
	"barotrauma": {
		DataMount: "/home/steam/.local/share/Daedalic Entertainment GmbH/Barotrauma/Multiplayer",
		// Campaign .save files land directly at the mount root with no
		// separate subfolder to name, but the from-scratch image also nests
		// its game install at .gamectl/install right beside them — exclude
		// it rather than archive the steamcmd install every run.
		SavePaths:    []string{"."},
		ExcludePaths: []string{".gamectl"},
		Supported:    true,
		Note:         "Multiplayer campaign saves (excludes the game install under .gamectl on the same mount).",
	},
	"abioticfactor": {
		// Like every UE title, Abiotic Factor writes its "Saved" dir (world
		// saves) as a sibling of Binaries/ inside the read-only install tree
		// by default — AbioticFactor-Kube's entrypoint.sh now symlinks that
		// onto $DATA/server (same fix as SonsOfTheForest/Wreckfest below),
		// so this mirrors their DataMount/SavePaths exactly.
		DataMount: "/data",
		SavePaths: []string{"server"},
		Supported: true,
		Note:      "World saves (excludes the game install + Wine prefix).",
	},
	"sonsoftheforest": {
		// Unlike AbioticFactor, SOTF is launched with -userdatapath pointed at
		// $DATA/server, so save slots + config land in a clean subfolder
		// (see SonsOfTheForest-Kube entrypoint.sh).
		DataMount: "/data",
		SavePaths: []string{"server"},
		Supported: true,
		Note:      "Save slots, dedicated server config and owner whitelist (excludes the game install + Wine prefix).",
	},
	"unturned": {
		// The server identity (world + config) lives at
		// .gamectl/install/Servers/$SERVER_ID — nested inside the shared
		// install, but effectiveSavePaths (backup.go) resolves the exact
		// per-instance subfolder from the SERVER_ID env the same way it
		// resolves Minecraft's LEVEL. This entry's SavePaths is just the
		// default ("gamectl") fallback.
		DataMount: "/data",
		SavePaths: []string{".gamectl/install/Servers/gamectl"},
		Supported: true,
		Note:      "This server identity's world + config (excludes the shared Unturned install).",
	},
	"spt": {
		// The whole SPT+Fika distribution is seeded onto one un-partitioned
		// directory (no install/save split) — but SPT's player profiles
		// (stash, hideout, quests, skills — the actual "save") always live at
		// user/profiles, separate from the binaries/configs/mods the image
		// re-seeds itself on boot.
		DataMount: "/opt/server",
		SavePaths: []string{"SPT/user/profiles"},
		Supported: true,
		Note:      "Player profiles — stash, hideout, quests, skills (excludes the SPT+Fika install/mods, which the image re-seeds on boot).",
	},

	// Match/session servers with no persistent save worth backing up — config
	// only, regenerated from env each boot (see each *-Kube entrypoint.sh).
	"cs2":         {Supported: false, Note: "CS2 is a match server — no world/save to back up (only server config, which lives in the deploy)."},
	"quake3":      {Supported: false, Note: "Quake 3 is a match server — no persistent save."},
	"left4dead2":  {Supported: false, Note: "Left 4 Dead 2 is a match server — no persistent save (server.cfg is regenerated from env each boot)."},
	"leftfordead": {Supported: false, Note: "Left 4 Dead is a match server — no persistent save (server.cfg is regenerated from env each boot)."},
	"beammp":      {Supported: false, Note: "BeamMP is session-based — no persistent world/character save (config is regenerated from env each boot)."},
	"sandstorm":   {Supported: false, Note: "Insurgency: Sandstorm's Checkpoint PVE is wave-based — no persistent world/character save between sessions."},
	"wreckfest":   {Supported: false, Note: "Wreckfest is a competitive racing server — no persistent world/campaign save (server_config.cfg is regenerated from env each boot)."},
	"wreckfest2":  {Supported: false, Note: "Wreckfest 2 is a competitive racing server — no persistent world/campaign save (server_config.scnf is regenerated from env each boot)."},
}

// backupSpecFor returns the spec for a game label. Unknown games default to a
// whole-volume backup so something is still captured, with a clear note.
func backupSpecFor(game string) BackupSpec {
	if s, ok := backupSpecs[strings.ToLower(strings.TrimSpace(game))]; ok {
		return s
	}
	return BackupSpec{
		SavePaths: []string{"."},
		Supported: true,
		Note:      "No per-game save path is known for this game — backups capture the whole data volume.",
	}
}
