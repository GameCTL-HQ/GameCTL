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
	// Supported is false for games with no meaningful save to back up (a pure
	// match server like CS2 / Quake / L4D2 — config only, nothing persistent).
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
		// The wolveix image keeps the 4.5GB game install + saves under /config;
		// only SaveGames is the actual save.
		SavePaths: []string{"FactoryGame/Saved/SaveGames"},
		Supported: true,
		Note:      "Save games only (excludes the ~4.5GB game install under /config).",
	},
	"factorio": {
		DataMount: "/factorio",
		SavePaths: []string{"saves", "mods", "config"},
		Supported: true,
		Note:      "Save .zips, installed mods, and server config.",
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
		DataMount: "/steamcmd/7dtd",
		// 7 Days stores saves in the server profile, which may sit outside this
		// (install) volume depending on -userdatafolder. Existence-filtering
		// catches it when it is here; otherwise the run warns and the operator
		// can switch the scope to whole-volume.
		SavePaths: []string{"Saves", "saves", "SaveGames"},
		Supported: true,
		Note:      "Save games if stored on the data volume; otherwise use whole-volume scope.",
	},
	"necesse": {
		DataMount: "/necesse/saves",
		SavePaths: []string{"."},
		Supported: true,
		Note:      "All Necesse world saves.",
	},
	"barotrauma": {
		DataMount: "/home/steam/.local/share/Daedalic Entertainment GmbH/Barotrauma/Multiplayer",
		SavePaths: []string{"."},
		Supported: true,
		Note:      "Multiplayer campaign saves.",
	},

	// Match servers with no persistent save worth backing up.
	"cs2":        {Supported: false, Note: "CS2 is a match server — no world/save to back up (only server config, which lives in the deploy)."},
	"quake3":     {Supported: false, Note: "Quake 3 is a match server — no persistent save."},
	"l4d2":       {Supported: false, Note: "Left 4 Dead 2 is a match server — no persistent save."},
	"left4dead2": {Supported: false, Note: "Left 4 Dead 2 is a match server — no persistent save."},
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
