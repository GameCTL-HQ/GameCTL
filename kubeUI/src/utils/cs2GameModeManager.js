// GameModeManager plugin config for the kus CS2 modded image.
//
// This is a VENDORED copy of the GameModeManager.json that
// ghcr.io/kus/cs2-modded-server ships by default (config "Version": 12,
// captured 2026-05-22). GameCTL writes it into the custom_files overlay so
// it can apply one tweak — see buildGameModeManagerConfig below.
//
// Why vendor the WHOLE file: CounterStrikeSharp deserializes the config as a
// unit, so a partial overlay file would drop everything it omits — here that
// means the entire 32-entry GameModes.List and its map groups. The file has
// to be shipped complete.
//
// Maintenance: if the kus image bumps GameModeManager (a higher "Version" or
// a new mode), re-capture this object from a fresh pod:
//   kubectl exec -n gamectl <cs2-pod> -- cat \
//     /home/steam/cs2/game/csgo/addons/counterstrikesharp/configs/plugins/GameModeManager/GameModeManager.json
// and re-apply the tweak in buildGameModeManagerConfig.

// The kus default, verbatim — ChangeImmediately is false here, exactly as the
// image ships it. The GameCTL change is applied in code, not baked in, so the
// one-line difference from upstream stays visible.
export const GAMEMODEMANAGER_BASE = {
  Version: 12,
  RTV: {
    Enabled: true,
    Style: 'center',
    PerMap: false,
    HideHud: false,
    MinRounds: 0,
    MinPlayers: 1,
    VoteDuration: 60,
    OptionsToShow: 15,
    VotePercentage: 51,
    OptionsInCoolDown: 3,
    EndOfMapVote: true,
    IncludeModes: false,
    IncludeExtend: true,
    MaxExtends: 6,
    ExtendTime: 10,
    ExtendRounds: 5,
    ModePercentage: 40,
    EnabledInWarmup: false,
    HideHudAfterVote: false,
    NominationEnabled: true,
    MaxNominationWinners: 1,
    ChangeImmediately: false,
    TriggerKillsBeforeEnd: 13,
    TriggerRoundsBeforeEnd: 2,
    TriggerSecondsBeforeEnd: 120,
  },
  Maps: { Mode: 0, Delay: 5, Style: 'center', Default: 'de_dust2' },
  Votes: { Enabled: true, Maps: true, Style: 'center', GameModes: true, GameSettings: false },
  Settings: { Enabled: true, Style: 'center', Folder: 'settings' },
  Warmup: {
    Enabled: false,
    Time: 0,
    PerMap: false,
    Default: { Name: 'Deathmatch', Config: 'warmup/dm.cfg' },
    List: [
      { Name: 'Deathmatch', Config: 'warmup/dm.cfg' },
      { Name: 'Knives Only', Config: 'warmup/knives_only.cfg' },
      { Name: 'Scoutz Only', Config: 'warmup/scoutz_only.cfg' },
    ],
  },
  // Map/Maps/Mode/Modes disabled: GameCtlRtv owns those triggers and was
  // racing with kus's blind-changelevel handler — on a typo'd !map name
  // kus would announce "map changing in 5s" and freeze everyone while
  // the changelevel failed. Disabling kus's registration here makes
  // GameCtlRtv the sole handler, so its catalog-validation no-op on
  // bad input is final. TimeLeft/TimeLimit stay on (kus owns those).
  Commands: { Map: false, Maps: false, Mode: false, Modes: false, TimeLeft: true, TimeLimit: true, Style: 'center' },
  Rotation: {
    Enabled: false,
    Cycle: 0,
    MapGroups: ['mg_active', 'mg_comp'],
    WhenServerEmpty: false,
    CustomTimeLimit: 600,
    ModeRotation: false,
    ModeInterval: 4,
    ModeSchedules: false,
    Schedule: [
      { Time: '10:00', Mode: 'Casual' },
      { Time: '15:00', Mode: 'Practice' },
      { Time: '17:00', Mode: 'Competitive' },
    ],
  },
  GameModes: {
    Style: 'center',
    Default: { Name: 'Casual', Config: 'casual.cfg', DefaultMap: null, MapGroups: ['mg_active', 'mg_comp'] },
    MapGroupFile: 'gamemodes_server.txt',
    List: [
      { Name: 'Gun Game', Config: 'gg.cfg', DefaultMap: 'ar_pool_day', MapGroups: ['mg_gg'] },
      { Name: 'Deathmatch', Config: 'deathmatch.cfg', DefaultMap: 'de_dust2', MapGroups: ['mg_dm'] },
      { Name: 'Competitive', Config: 'comp.cfg', DefaultMap: 'de_inferno', MapGroups: ['mg_comp'] },
      { Name: 'Wingman', Config: 'wingman.cfg', DefaultMap: 'de_nuke', MapGroups: ['mg_wingman'] },
      { Name: 'Practice Mode', Config: 'prac.cfg', DefaultMap: 'de_dust2', MapGroups: ['mg_comp'] },
      { Name: 'Prefire', Config: 'prefire.cfg', DefaultMap: 'de_inferno', MapGroups: ['mg_prefire'] },
      { Name: 'Retakes', Config: 'retake.cfg', DefaultMap: 'de_dust2', MapGroups: ['mg_retake'] },
      { Name: 'Executes', Config: 'executes.cfg', DefaultMap: 'de_mirage', MapGroups: ['mg_executes'] },
      { Name: 'Awp Only', Config: 'awp.cfg', DefaultMap: '3142070597', MapGroups: ['mg_awp'] },
      { Name: '1v1 Arenas', Config: '1v1.cfg', DefaultMap: '3070253400', MapGroups: ['mg_1v1'] },
      { Name: 'Aim', Config: 'aim.cfg', DefaultMap: '3084291314', MapGroups: ['mg_aim'] },
      { Name: 'Bhop', Config: 'bhop.cfg', DefaultMap: '3088973190', MapGroups: ['mg_bhop'] },
      { Name: 'Surf', Config: 'surf.cfg', DefaultMap: '3082548297', MapGroups: ['mg_surf'] },
      { Name: 'Kreedz Climbing', Config: 'kz.cfg', DefaultMap: '3086304337', MapGroups: ['mg_kz'] },
      { Name: 'Capture The Flag', Config: 'ctf.cfg', DefaultMap: '3555531615', MapGroups: ['mg_ctf'] },
      { Name: 'Hide N Seek', Config: 'hns.cfg', DefaultMap: '3348038890', MapGroups: ['mg_hns'] },
      { Name: 'Soccer', Config: 'soccer.cfg', DefaultMap: '3238565662', MapGroups: ['mg_soccer'] },
      { Name: 'Course', Config: 'course.cfg', DefaultMap: '3070455802', MapGroups: ['mg_course'] },
      { Name: 'Deathrun', Config: 'deathrun.cfg', DefaultMap: '3164611860', MapGroups: ['mg_deathrun'] },
      { Name: 'Minigames', Config: 'minigames.cfg', DefaultMap: '3082120895', MapGroups: ['mg_minigames'] },
      { Name: 'ScoutzKnivez', Config: 'scoutzknivez.cfg', DefaultMap: '3073929825', MapGroups: ['mg_scoutzknivez'] },
      { Name: 'One In The Chamber', Config: 'oitc.cfg', DefaultMap: 'ar_pool_day', MapGroups: ['mg_gg'] },
      { Name: 'Battle Ball', Config: 'battle.cfg', DefaultMap: '3280650663', MapGroups: ['mg_battle'] },
      { Name: 'Battle Royale', Config: 'br.cfg', DefaultMap: '3462095803', MapGroups: ['mg_battleroyale'] },
      { Name: 'Casual', Config: 'casual.cfg', DefaultMap: 'de_dust2', MapGroups: ['mg_active', 'mg_comp'] },
      { Name: 'Casual (1.6)', Config: 'casual-1.6.cfg', DefaultMap: '3201205818', MapGroups: ['mg_casual-1.6'] },
      { Name: 'Competitive (Valve)', Config: 'valve-competitive.cfg', DefaultMap: 'de_dust2', MapGroups: ['mg_valve_competitive'] },
      { Name: 'Deathmatch FFA (Valve)', Config: 'valve-deathmatch-freeforall.cfg', DefaultMap: 'de_dust2', MapGroups: ['mg_valve_deathmatch'] },
      { Name: 'Arms Race (Valve)', Config: 'valve-armsrace.cfg', DefaultMap: 'ar_pool_day', MapGroups: ['mg_valve_arms_race'] },
      { Name: 'Wingman (Valve)', Config: 'valve-wingman.cfg', DefaultMap: 'de_nuke', MapGroups: ['mg_valve_wingman'] },
      { Name: 'Retakes (Valve)', Config: 'valve-retake.cfg', DefaultMap: 'de_dust2', MapGroups: ['mg_valve_retakes'] },
      { Name: 'Competitive 45°', Config: '45.cfg', DefaultMap: '3276886893', MapGroups: ['mg_45'] },
    ],
  },
}

import { buildGameModesList } from './cs2RtvCatalog'

// buildGameModeManagerConfig returns the GameModeManager.json text GameCTL
// ships in the custom_files overlay.
//
// GameCTL tweaks:
//   - RTV.Enabled = false. Rock-the-vote is handled by the GameCtlRtv plugin
//     (two-stage mode-then-map vote — see cs2RtvCatalog.js and /cs2-plugin).
//     GameModeManager's own RTV was buggy (it couldn't resolve the maps in
//     its pool) and would fight GameCtlRtv for the !rtv command.
//   - Votes.GameModes / Votes.Maps = false. GameModeManager's own !modes
//     and !maps chat commands have no awareness of which workshop maps are
//     actually cached on disk — picking an uncached map silently no-ops.
//     GameCtlRtv now OWNS those chat commands and filters by IsMapCached.
//   - GameModes.List is rebuilt from CS2_RTV_CATALOG so !modes shows the
//     same modes !rtv does — one source of truth, no more drift.
// ChangeImmediately is left true so GameModeManager's RTV still behaves
// sanely if an operator ever re-enables it.
export function buildGameModeManagerConfig() {
  const cfg = JSON.parse(JSON.stringify(GAMEMODEMANAGER_BASE))
  cfg.RTV.Enabled = false
  // Some versions of GameModeManager honour EndOfMapVote independently of
  // RTV.Enabled — turn it off explicitly so the picture-card map vote that
  // pops up at the end of a map doesn't fight GameCtlRtv.
  cfg.RTV.EndOfMapVote = false
  cfg.RTV.ChangeImmediately = true
  // Hand !modes / !maps off to GameCtlRtv so the menus are cache-filtered.
  cfg.Votes.GameModes = false
  cfg.Votes.Maps = false
  cfg.GameModes.List = buildGameModesList()
  return JSON.stringify(cfg, null, 2)
}
