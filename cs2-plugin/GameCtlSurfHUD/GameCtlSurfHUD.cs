using System.Drawing;
using System.Text.Json;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace GameCtlSurfHUD;

// GameCtlSurfHUD — speed + map-timer HUD + persistent leaderboards for the
// movement modes (surf / bhop / kz).
//
// Replaces SharpTimer (broken upstream — Invalid function pointer at
// HookFunction since the May CS2 update).
//
// HUD layer: PrintToCenter (plain, not HTML — HTML overlay has an
// uncancelable slide animation). Refreshed every tick + per-player content
// cache so the overlay reads as a solid permanent display.
//
// Timer layer:
//   - Start: player crosses START_SPEED u/s (covers surf maps that
//     teleport directly onto a ramp with no named "start" zone).
//   - End: player overlaps any trigger_multiple whose name looks like an
//     end zone (mapend / end / goal / finish / zoneend). Position-based
//     detection — no virtual-function hooks (which differ by CSSharp
//     version and would re-introduce the SharpTimer-style fragility).
//
// Records layer:
//   - JSON file on NFS: RECORDS_PATH. Schema: { records: {<map>:{<sid>: …}}}
//   - Loaded once at plugin Load, refreshed at map start.
//   - Saved (atomic: write .tmp + rename) only on a new PB — non-blocking
//     File I/O via Task.Run so the game tick isn't stalled by the write.
//
// Chat / console commands:
//   - !pb            → caller's PB on current map
//   - !top           → top 10 times on current map
//   - !rank          → caller's rank on current map
//   - !wr            → server record (top 1) on current map
//   Each is registered with [ConsoleCommand("css_xxx", …)] which CSSharp
//   automatically aliases to the !xxx chat command.

public class GameCtlSurfHUD : BasePlugin
{
    public override string ModuleName => "GameCtl Surf HUD";
    public override string ModuleVersion => "1.1.0";
    public override string ModuleAuthor => "GameCTL";
    public override string ModuleDescription => "Speed + map-timer HUD + persistent leaderboards for surf/bhop/kz";

    // Tunables.
    private const int    HUD_TICK_INTERVAL  = 1;
    private const int    SPEED_ROUND_TO     = 10;
    private const float  START_SPEED        = 250f;
    // Operator-set end zones are sphere-radius around a single point —
    // surf players cross at 1000+ u/s AND approach from variable
    // angles (banked turns, drop-ins from above, off-ramp slides).
    // 400u (~800u-diameter catch window) is generous enough that any
    // angle approach through the trigger volume registers, while still
    // small enough to not catch a player just lurking nearby.
    private const float  END_TRIGGER_RADIUS   = 400f;
    // Start zones are usually entered cleanly from teleport — keep the
    // tighter radius so the timer doesn't auto-start on a player who
    // just respawned and hasn't actually crossed the start line.
    private const float  START_TRIGGER_RADIUS = 100f;
    private const int    LEADERBOARD_LIMIT  = 10;

    // /home/steam/cs2 is the NFS-mounted PVC root — survives pod restart
    // independently of any plugin-config dir cleanup.
    private const string RECORDS_PATH = "/home/steam/cs2/gamectl_surf_records.json";
    // Append-only log of EVERY finish (not just PBs). One JSON object per
    // line. The cs2-records site reads this to render an "all attempts"
    // view per map and per player, while the records file above stays the
    // PB-only canonical leaderboard.
    private const string ATTEMPTS_PATH = "/home/steam/cs2/gamectl_surf_attempts.jsonl";
    // Operator-defined zones for maps without proper named triggers. Admin
    // stands at the spot and runs !setstart / !setend. Overrides the
    // auto-detected trigger_multiple end zones for the map.
    private const string ZONES_PATH   = "/home/steam/cs2/gamectl_surf_zones.json";

    // Replay files: one JSON per (map, steamid) under this directory.
    // Persisted only on a PB-beat; older replays for the same map+sid
    // overwritten. Format defined in Replay.cs.
    private const string REPLAY_DIR   = "/home/steam/cs2/gamectl_surf_replays";

    // ── records (persistent) ──────────────────────────────────────────────

    public sealed class RecordEntry
    {
        [JsonPropertyName("name")]        public string Name        { get; set; } = "";
        [JsonPropertyName("time_ms")]     public long   TimeMs      { get; set; }
        [JsonPropertyName("finished_at")] public string FinishedAt  { get; set; } = "";
    }

    public sealed class RecordsFile
    {
        [JsonPropertyName("version")] public int Version { get; set; } = 1;
        // map → steamid64 (string) → entry
        [JsonPropertyName("records")] public Dictionary<string, Dictionary<string, RecordEntry>> Records { get; set; } = new();
    }

    private RecordsFile _records = new();
    private readonly object _recordsLock = new();
    private string _currentMap = "";

    // ── operator-defined zones (persistent) ──────────────────────────────

    public sealed class ZoneVec
    {
        [JsonPropertyName("x")] public float X { get; set; }
        [JsonPropertyName("y")] public float Y { get; set; }
        [JsonPropertyName("z")] public float Z { get; set; }
    }

    public sealed class MapZoneEntry
    {
        [JsonPropertyName("start")] public ZoneVec? Start { get; set; }
        [JsonPropertyName("end")]   public ZoneVec? End   { get; set; }
    }

    public sealed class ZonesFile
    {
        [JsonPropertyName("version")] public int Version { get; set; } = 1;
        [JsonPropertyName("zones")]   public Dictionary<string, MapZoneEntry> Zones { get; set; } = new();
    }

    private ZonesFile _zones = new();
    private readonly object _zonesLock = new();
    // Operator end-zone center for the current map, if set. Takes priority
    // over auto-detected trigger_multiple zones — we clear _endZones and
    // use only this.
    private Vector? _operatorEnd;
    private Vector? _operatorStart; // not yet used for start-zone logic, reserved

    // ── per-player live state (in-memory only) ────────────────────────────

    private readonly Dictionary<ulong, DateTime> _runStart  = new();
    private readonly Dictionary<ulong, bool>     _wasAtEnd  = new();
    // Best for the CURRENT session — duplicates the persistent record but
    // lets the HUD show "PB" without a disk read per frame.
    private readonly Dictionary<ulong, TimeSpan> _sessionBest = new();
    private readonly Dictionary<ulong, string>   _lastHud   = new();

    // Jumpstats: track each player's on-ground state across ticks so we
    // can detect the ground→air (takeoff) and air→ground (land)
    // transitions. We keep the most recent jump's takeoff + landing
    // horizontal speeds per player and surface them in the HUD; no chat
    // spam. Speed delta is positive on a "gained" jump (good strafe).
    private readonly Dictionary<ulong, bool>     _wasOnGround = new();
    private readonly Dictionary<ulong, float>    _takeoffSpd  = new();
    private readonly Dictionary<ulong, (float take, float land)> _lastJump = new();
    private const int FL_ONGROUND = 1;

    private readonly List<Vector> _endZones = new();
    // Auto-detected start zones (similar to _endZones). When this list is
    // non-empty the speed-threshold start-trigger is bypassed and the timer
    // only starts the instant the player crosses one of these.
    private readonly List<Vector> _startZones = new();

    // Candidate buffers built up during OnEntitySpawned. After the map has
    // a moment to finish spawning entities (`PickBestZones` runs ~2s after
    // map start), we sift these for the BEST start/end name — "map_start"
    // > "s1_start" > any other "_start" — so a multi-stage map with seven
    // stage-start triggers doesn't get treated as seven valid run starts
    // (which would let a partial run set a PB).
    private sealed record TriggerCand(string Name, Vector Pos);
    private readonly List<TriggerCand> _candStarts = new();
    private readonly List<TriggerCand> _candEnds   = new();
    private CounterStrikeSharp.API.Modules.Timers.Timer? _zoneSettleTimer;
    private int _tickCount;

    // Per-player edge-detect for the start zone (so re-entering a start
    // trigger restarts the run cleanly without the speed-threshold path
    // also racing it).
    private readonly Dictionary<ulong, bool> _wasAtStart = new();

    // ── replay recording / playback state ─────────────────────────────────

    // Per-player live frame buffer. Reset on run start / death; flushed
    // to disk in OnFinish when the player beats their PB.
    private readonly Dictionary<ulong, List<ReplayFrame>> _replayRec = new();

    // Available models for the !replay ghost — alias → vmdl path. All
    // three are verified-present in CS2's base pak01_dir.vpk so they
    // work on any map without per-map precaching. Chicken is the default
    // (animated, identifiable); cube is the guaranteed fallback.
    private static readonly Dictionary<string,string> GHOST_MODEL_OPTIONS = new(StringComparer.OrdinalIgnoreCase) {
        ["chicken"] = "models/chicken/chicken.vmdl",
        ["hostage"] = "models/hostage/hostage.vmdl",
        ["cube"]    = "models/dev/dev_cube.vmdl",
    };
    // Operator-selected preference via `!replay <name>`. null = default chain.
    private string? _ghostModelPref = null;

    // Trail = small breadcrumb props dropped at the ghost's position every
    // TRAIL_TICK_EVERY ticks. Each segment's render alpha is ramped down
    // every game tick from full → zero across TRAIL_LIFETIME_TICKS, then
    // the entity is removed. The list-based tracker makes the fade smooth
    // — naïve AddTimer removal gave a hard "pop out" at the tail.
    // Toggleable per-session via `!replay trail on/off`. Default: on.
    private bool _ghostTrailEnabled = true;
    private int  _ghostTrailTickAccum = 0;
    private const int  TRAIL_TICK_EVERY      = 4;       // drop every 4 game ticks
    private const int  TRAIL_LIFETIME_TICKS  = 96;      // ~1.5s at 64-tick
    private static readonly Color TRAIL_TINT = Color.FromArgb(255, 110, 220, 255); // sky-blue
    private readonly List<(CDynamicProp prop, int spawnTick)> _trail = new();

    // Ghost playback state — set when !replay starts. Single ghost at
    // a time server-wide (the WR for the current map).
    private CCSPlayerController? _ghostBot;
    private List<ReplayFrame>? _ghostFrames;
    private int _ghostFrameIdx;
    private string _ghostName = "?";
    private long _ghostTimeMs;

    // ── lifecycle ────────────────────────────────────────────────────────

    public override void Load(bool hotReload)
    {
        LoadRecords();
        LoadZones();
        _currentMap = Server.MapName ?? "";
        ApplyOperatorZonesForCurrentMap();
        // If this is a hot reload (plugin reloaded mid-map), seed each
        // connected player's session best from the persistent store so
        // the HUD shows "PB" right away instead of waiting for a finish.
        SeedSessionBestsFromRecords();

        RegisterListener<Listeners.OnTick>(OnTick);
        RegisterListener<Listeners.OnEntitySpawned>(OnEntitySpawned);
        RegisterListener<Listeners.OnMapStart>(OnMapStart);
        // Precache the ghost-replay player model into each map's
        // resource manifest. Without this, SetModel("characters/...")
        // throws "Missing from a manifest?" and the prop spawns
        // invisible.
        RegisterListener<Listeners.OnServerPrecacheResources>(manifest =>
        {
            try
            {
                // Ghost-prop candidates verified present in CS2's
                // pak01_dir.vpk — the previous toilet paths weren't
                // actually in the engine's content and silently
                // rendered as the purple ERROR model.
                manifest.AddResource("models/chicken/chicken.vmdl");
                manifest.AddResource("models/hostage/hostage.vmdl");
                manifest.AddResource("models/dev/dev_cube.vmdl");
                Server.PrintToConsole("[GameCtlSurfHUD] precached ghost model candidates (chicken/hostage/dev_cube)");
            }
            catch (Exception e) { Server.PrintToConsole($"[GameCtlSurfHUD] precache failed: {e.Message}"); }
        });
        RegisterEventHandler<EventPlayerSpawn>(OnPlayerSpawn);
        // Greet the player with the current map's top times once they're
        // actually in the world. Connect-full fires too early — the
        // PrintToChat is silently dropped. Use the activate event instead.
        RegisterEventHandler<EventPlayerActivate>(OnPlayerActivate);

        // CSSharp 1.0.367 doesn't have the [ConsoleCommand] attribute —
        // AddCommand is the registration API. Matches the kus image's
        // version. Both `css_pb` and `!pb` route to the same handler.
        AddCommand("css_pb",    "Show your personal best on this map", OnPbCommand);
        AddCommand("css_top",   "Show the top times on this map",      OnTopCommand);
        AddCommand("css_times", "Show the top times on this map",      OnTopCommand);
        AddCommand("css_rank",  "Show your rank on this map",          OnRankCommand);
        AddCommand("css_wr",    "Show the server record on this map",  OnWrCommand);
        AddCommand("css_r",     "Reset to start (surf quick reset)",   OnResetCommand);
        // Admin-gated zone editors.
        // Ghost replay — plays back the WR run via a fake CT bot with
        // a WASD HUD so spectators see the input pattern. !replay /
        // !replaybest start it, !replaystop kills the ghost.
        AddCommand("css_replay",     "Spectate a ghost-bot replay of the WR run",     OnReplayCommand);
        AddCommand("css_replaybest", "Same as !replay — start ghost playback of WR",  OnReplayCommand);
        AddCommand("css_replaystop", "Stop the ghost-bot replay",                     OnReplayStopCommand);
        AddCommand("css_ghostcam",   "Lock/unlock your camera to follow the replay",  OnGhostCamCommand);
        AddCommand("css_specghost",  "Same as !ghostcam (alias)",                     OnGhostCamCommand);
        AddCommand("css_setstart",   "[admin] Set start zone at your position",  OnSetStartCommand);
        AddCommand("css_setend",     "[admin] Set end zone at your position",    OnSetEndCommand);
        AddCommand("css_clearzones", "[admin] Clear zones for this map",         OnClearZonesCommand);
        AddCommand("css_zones",      "Show this map's operator-set zones",       OnZonesCommand);

        Server.PrintToConsole($"[GameCtlSurfHUD] Loaded — {CountRecordsForMap(_currentMap)} record(s) for current map.");
        // bot_auto_vacate 0 — kus's bots.cfg defaults this to 1 so the
        // engine kicks bots when humans join their team. That kills any
        // ghost-replay bot on surf maps. Assert it on every plugin load,
        // then re-assert every 30s in case a cfg re-exec puts it back.
        Server.ExecuteCommand("bot_auto_vacate 0; bot_join_after_player 0");
        AddTimer(30.0f, () => Server.ExecuteCommand("bot_auto_vacate 0"), TimerFlags.REPEAT);
        // DEBUG command injector: any line written to /tmp/cs2-cmd.txt
        // gets exec'd via Server.ExecuteCommand, then the file is
        // truncated. Lets us iterate on bot-spawn cvars from a shell
        // without needing working RCON. Safe to leave enabled — the
        // file is only writable by the steam user inside the container.
        AddTimer(0.5f, () => {
            try
            {
                const string p = "/tmp/cs2-cmd.txt";
                if (!System.IO.File.Exists(p)) return;
                var info = new System.IO.FileInfo(p);
                if (info.Length == 0) return;
                var lines = System.IO.File.ReadAllLines(p);
                System.IO.File.WriteAllText(p, "");
                foreach (var ln in lines)
                {
                    var cmd = ln.Trim();
                    if (cmd.Length == 0 || cmd.StartsWith("#")) continue;
                    Server.PrintToConsole($"[GameCtlSurfHUD] inject> {cmd}");
                    Server.ExecuteCommand(cmd);
                }
            }
            catch (Exception e) { Server.PrintToConsole($"[GameCtlSurfHUD] inject err: {e.Message}"); }
        }, TimerFlags.REPEAT);
        // Auto-spawn disabled: bot_add_ct was returning no bot in some
        // map+mode combos and the 8-poll retry was confusing things.
        // Manual !replay is the only entry point until we have a
        // reliable bot-spawn path.
    }

    public override void Unload(bool hotReload)
    {
        // PrintToCenter is a sticky text slot — once we draw to it, it
        // stays on every connected player's screen until something else
        // overwrites it. When the plugin unloads (mode switch from surf
        // -> DM), our last surf timer was leaking into DM. Clear it for
        // everyone on the way out.
        foreach (var p in Utilities.GetPlayers())
        {
            if (p == null || !p.IsValid || p.IsBot || p.IsHLTV) continue;
            try { p.PrintToCenter(""); } catch { }
        }
    }

    private void OnMapStart(string mapName)
    {
        _currentMap = mapName;
        _endZones.Clear();
        _startZones.Clear();
        _candStarts.Clear();
        _candEnds.Clear();
        _runStart.Clear();
        _wasAtEnd.Clear();
        _wasAtStart.Clear();
        _sessionBest.Clear();
        _lastHud.Clear();
        _wasOnGround.Clear();
        _takeoffSpd.Clear();
        _lastJump.Clear();
        // Disk may have been updated by another process — pick up changes.
        LoadRecords();
        LoadZones();
        ApplyOperatorZonesForCurrentMap();
        SeedSessionBestsFromRecords();
        // Settle timer: entities keep spawning for a couple seconds after
        // OnMapStart fires. Give them a chance to land, then pick the
        // CANONICAL start + end out of whatever candidates we collected —
        // multi-stage maps have lots of named triggers, but only one
        // "real" map-wide start and end.
        _zoneSettleTimer?.Kill();
        _zoneSettleTimer = AddTimer(2.5f, PickBestZones);
        Server.PrintToConsole($"[GameCtlSurfHUD] Map start: {mapName} — {CountRecordsForMap(mapName)} record(s) loaded.");
        // Clear any ghost state from the previous map. Auto-spawn
        // disabled until the bot_add path is reliable — players use
        // !replay manually.
        _ghostBot = null; _ghostFrames = null; _ghostFrameIdx = 0;
    }

    // PickBestZones runs ~2.5s after map start, after every relevant
    // trigger has had a chance to fire OnEntitySpawned. It scores each
    // candidate and keeps only the best — so a 6-stage surf map with
    // `s1_start`..`s6_start` + `map_end` produces ONE start (s1) + ONE
    // end (map_end), not seven valid runs. Operator-set zones win
    // unconditionally and short-circuit this.
    private void PickBestZones()
    {
        if (_operatorStart != null && _operatorEnd != null)
        {
            Server.PrintToConsole("[GameCtlSurfHUD] Operator zones set — skipping auto-pick.");
            return;
        }

        // Score: lower is better (we'll sort ascending).
        //  -100  exact match for the canonical map-wide name (map_start / map_end)
        //   -50  zone_/timer_ etc. names that explicitly name the map (not a stage)
        //    -1  s1_start / stage1_start / first numbered stage
        //     0  any other numbered stage start (sN_start, N>=2)
        //   100  unscored fallback (rare — caught by EndsWith("_start"))
        //  +500  bonus zone (b*_*) — we want these LAST or excluded.
        static int ScoreStart(string name)
        {
            if (name == "map_start" || name == "mapstart") return -100;
            if (name.Contains("map_start") || name.Contains("mapstart")) return -90;
            if (name.Contains("zone_start") || name.Contains("zonestart") ||
                name.Contains("timer_start") || name.Contains("startzone") || name.Contains("start_zone"))
                return -50;
            if (name.StartsWith("b") && name.Contains("_start")) return 500;  // bonus
            // s1_start / stage1_start / s_1_start → very early stage
            if ((name.StartsWith("s1_") || name.StartsWith("stage1_") || name.StartsWith("s_1_")) &&
                name.EndsWith("_start")) return -1;
            // Generic sN_start for N >= 2 — valid stage starts, but not "the" start.
            if ((name.StartsWith("s") || name.StartsWith("stage")) && name.EndsWith("_start")) return 0;
            return 100;
        }
        static int ScoreEnd(string name)
        {
            if (name == "map_end" || name == "mapend" || name == "map_finish") return -100;
            if (name.Contains("map_end") || name.Contains("mapend") ||
                name.Contains("map_finish") || name.Contains("mapfinish")) return -90;
            if (name.Contains("zone_end") || name.Contains("zoneend") ||
                name.Contains("timer_end") || name.Contains("timer_finish") ||
                name.Contains("finish_zone") || name.Contains("finishzone") ||
                name.Contains("end_zone") || name.Contains("endzone"))
                return -50;
            if (name.StartsWith("b") && (name.EndsWith("_end") || name.Contains("_end"))) return 500;
            if ((name.StartsWith("s") || name.StartsWith("stage")) && name.EndsWith("_end")) return 0;
            if (name == "end" || name.Contains("goal") || name.Contains("finish")) return -10;
            return 100;
        }

        if (_operatorStart == null && _candStarts.Count > 0)
        {
            var best = _candStarts.OrderBy(c => ScoreStart(c.Name)).First();
            // Skip if best is still a bonus (score >= 500) — better to
            // have no auto-start than fall back to a bonus stage.
            if (ScoreStart(best.Name) < 500)
            {
                _startZones.Clear();
                _startZones.Add(best.Pos);
                Server.PrintToConsole($"[GameCtlSurfHUD] AUTO START: '{best.Name}' at ({best.Pos.X:F0},{best.Pos.Y:F0},{best.Pos.Z:F0}) (chosen from {_candStarts.Count} candidates).");
            }
        }
        if (_operatorEnd == null && _candEnds.Count > 0)
        {
            var best = _candEnds.OrderBy(c => ScoreEnd(c.Name)).First();
            if (ScoreEnd(best.Name) < 500)
            {
                _endZones.Clear();
                _endZones.Add(best.Pos);
                Server.PrintToConsole($"[GameCtlSurfHUD] AUTO END:   '{best.Name}' at ({best.Pos.X:F0},{best.Pos.Y:F0},{best.Pos.Z:F0}) (chosen from {_candEnds.Count} candidates).");
            }
        }

        if (_startZones.Count == 0)
            Server.PrintToConsole("[GameCtlSurfHUD] No auto-detectable start zone — falling back to speed threshold. Admin can !setstart to pin one.");
        if (_endZones.Count == 0)
            Server.PrintToConsole("[GameCtlSurfHUD] No auto-detectable end zone — finish detection disabled. Admin should !setend to pin one.");
    }

    private void OnEntitySpawned(CEntityInstance entity)
    {
        if (entity == null) return;
        // Accept trigger_multiple AND trigger_once — some surf maps use the
        // single-fire variant for the finish line / a one-shot starter.
        if (entity.DesignerName != "trigger_multiple" && entity.DesignerName != "trigger_once") return;

        var raw = entity.Entity?.Name ?? "";
        var name = raw.ToLowerInvariant();

        // Diagnostic: log every named trigger we see so the operator can
        // inspect the server console after a detection failure and tell us
        // what targetname the map actually uses.
        if (raw != "")
        {
            Server.PrintToConsole($"[GameCtlSurfHUD] Saw {entity.DesignerName}: '{raw}'.");
        }

        // Start-zone match — anything that LOOKS like a timer-start line.
        // Auto-detection means unmodified surf/bhop/kz maps "just work" —
        // the operator only needs !setstart/!setend on weird maps with
        // no named triggers.
        bool isStart =
            name.Contains("mapstart")     || name.Contains("map_start") ||
            name.Contains("zonestart")    || name.Contains("zone_start") ||
            name.Contains("startzone")    || name.Contains("start_zone") ||
            name.Contains("timer_start")  || name.Contains("trigger_start") ||
            name.Contains("surf_begin")   || name.Contains("surfstart") ||
            name == "start"               || name.EndsWith("_start");

        // Broader end-zone match — anything that LOOKS like a finish line.
        // Order matters: more specific first. We accept "end" suffix too
        // so names like "map_end", "tier1_end", "stage_end" register.
        bool isEnd =
            name.Contains("mapend")    || name.Contains("map_end") ||
            name.Contains("zoneend")   || name.Contains("zone_end") ||
            name.Contains("endzone")   || name.Contains("end_zone") ||
            name.Contains("mapfinish") || name.Contains("map_finish") ||
            name.Contains("timer_end") || name.Contains("timer_finish") ||
            name.Contains("trigger_end")    || name.Contains("trigger_finish") ||
            name.Contains("finishzone")     || name.Contains("finish_zone") ||
            name.Contains("goal")      || name.Contains("finish") ||
            name == "end"              || name.EndsWith("_end");

        if (!isStart && !isEnd) return;

        var baseEnt = new CBaseEntity(entity.Handle);
        var origin = baseEnt.AbsOrigin;
        if (origin == null) return;
        var v = new Vector(origin.X, origin.Y, origin.Z);

        // Buffer the candidate. PickBestZones (2.5s after map start)
        // picks one canonical start + end from these — multi-stage
        // surf maps with seven sN_start triggers + a map_end should
        // resolve to ONE start (the lowest-numbered stage or map_start)
        // + ONE end (map_end), not seven valid runs.
        if (isStart && _operatorStart == null)
        {
            _candStarts.Add(new TriggerCand(name, v));
            Server.PrintToConsole($"[GameCtlSurfHUD] start candidate: '{raw}' at ({origin.X:F0},{origin.Y:F0},{origin.Z:F0}).");
        }
        if (isEnd && _operatorEnd == null)
        {
            _candEnds.Add(new TriggerCand(name, v));
            Server.PrintToConsole($"[GameCtlSurfHUD] end candidate:   '{raw}' at ({origin.X:F0},{origin.Y:F0},{origin.Z:F0}).");
        }
    }

    // OnPlayerActivate — fires when the player has fully entered the world.
    // Print the top 3 times + the command list for the current map to
    // their chat + their console. Surf-only — the speed/timer HUD is only
    // loaded on movement modes anyway, so it's confusing to greet players
    // about !pb/!top on a casual server. A short delay keeps it from
    // competing with the kus image's MOTD spam.
    private HookResult OnPlayerActivate(EventPlayerActivate @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if (player == null || !player.IsValid || player.IsBot || player.IsHLTV) return HookResult.Continue;
        // Capture the controller reference — if the player disconnects
        // before the timer fires we just no-op on the IsValid check.
        AddTimer(4.0f, () =>
        {
            try
            {
                if (player == null || !player.IsValid || player.IsBot) return;
                GreetWithTopTimes(player);
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlSurfHUD] greet failed: {e.Message}");
            }
        });
        return HookResult.Continue;
    }

    private void GreetWithTopTimes(CCSPlayerController player)
    {
        // Show the WR + top 3 then the command cheat-sheet so new players
        // know what the plugin offers them. Keep the chat lines tight —
        // longer details go to their console.
        var top = GetTopForMap(_currentMap, 3);
        if (top.Count == 0)
        {
            player.PrintToChat($" \x06[Surf]\x01 No records yet on \x04{_currentMap}\x01 — be the first to set one!");
        }
        else
        {
            var wr = top[0].Value;
            player.PrintToChat($" \x06[Surf]\x01 Server record on \x04{_currentMap}\x01: \x04{FormatTime(TimeSpan.FromMilliseconds(wr.TimeMs))}\x01 by \x04{wr.Name}\x01.");
            player.PrintToConsole($"[Surf] Top {top.Count} on {_currentMap}:");
            for (int i = 0; i < top.Count; i++)
            {
                var e = top[i].Value;
                var line = $" \x06[Surf]\x01 \x10{i + 1,2}.\x01 {e.Name,-20} \x04{FormatTime(TimeSpan.FromMilliseconds(e.TimeMs))}\x01";
                player.PrintToChat(line);
                player.PrintToConsole($"  {i + 1,2}. {e.Name,-24} {FormatTime(TimeSpan.FromMilliseconds(e.TimeMs))}");
            }
        }
        // Command cheat-sheet — chat + console copy.
        player.PrintToChat($" \x06[Surf]\x01 \x04!r\x01 reset \x07·\x01 \x04!pb\x01 your best \x07·\x01 \x04!top\x01/\x04!times\x01 board \x07·\x01 \x04!wr\x01 server record \x07·\x01 \x04!rank\x01 your rank");
        player.PrintToChat($" \x06[Surf]\x01 \x04!replay\x01 spawn ghost (\x04!replay models\x01 to pick a body) \x07·\x01 \x04!ghostcam\x01 follow \x07·\x01 \x04!replaystop\x01 end. \x07Any PB you set is auto-recorded.\x01");
        // Surf stats site — leaderboards + replays for every map, off-server.
        player.PrintToChat($" \x06[Surf]\x01 Live stats + replays: \x04https://surfstats.examplelabs.cc/\x01");
        player.PrintToConsole("[Surf] Commands:");
        player.PrintToConsole("  !r           — reset to start (quick respawn)");
        player.PrintToConsole("  !pb          — your personal best on this map");
        player.PrintToConsole("  !top / !times — top 10 times on this map");
        player.PrintToConsole("  !wr          — server record on this map");
        player.PrintToConsole("  !rank        — your rank on this map");
        player.PrintToConsole("  !replay      — spawn the WR ghost (a chicken model that traces");
        player.PrintToConsole("                 the route). Picks the fastest saved replay across");
        player.PrintToConsole("                 all players — set a PB and yours becomes the ghost");
        player.PrintToConsole("                 if it's the fastest. Loops continuously until stopped.");
        player.PrintToConsole("  !replaybest  — same as !replay (alias).");
        player.PrintToConsole("  !replay models       — list the available ghost models (chicken / hostage / cube).");
        player.PrintToConsole("  !replay <model>      — set the ghost body, e.g. !replay cube. Restarts an active replay.");
        player.PrintToConsole("  !replay trail        — toggle the fading breadcrumb trail behind the ghost.");
        player.PrintToConsole("  !replay trail on/off — explicit on/off for the trail.");
        player.PrintToConsole("  !ghostcam    — lock your camera to chase-follow the ghost.");
        player.PrintToConsole("                 Need to !replay first. Type !ghostcam again to release.");
        player.PrintToConsole("                 While locked: WASD HUD shows the recorded player's input;");
        player.PrintToConsole("                 your own run won't time/record (you're riding the ghost).");
        player.PrintToConsole("  !specghost   — same as !ghostcam (alias).");
        player.PrintToConsole("  !replaystop  — stop the ghost replay + release all !ghostcam users.");
        player.PrintToConsole("");
        player.PrintToConsole("[Surf] Browse times + replays from any map at:");
        player.PrintToConsole("       https://surfstats.examplelabs.cc/");
    }

    private HookResult OnPlayerSpawn(EventPlayerSpawn @event, GameEventInfo info)
    {
        var player = @event.Userid;
        if (player == null || !player.IsValid) return HookResult.Continue;
        var key = player.SteamID;
        _runStart.Remove(key);
        _wasAtEnd[key] = false;
        _lastHud.Remove(key);
        _lastJump.Remove(key);
        _takeoffSpd.Remove(key);
        _wasOnGround[key] = true; // assume spawned on ground
        // Death / respawn aborts any active replay recording — we only
        // want frames from start-zone-to-end-zone, not from a mid-run
        // respawn glitch.
        _replayRec.Remove(key);
        // Seed this player's session best in case they're newly connected.
        if (TryGetRecord(_currentMap, key, out var rec))
            _sessionBest[key] = TimeSpan.FromMilliseconds(rec.TimeMs);
        return HookResult.Continue;
    }

    // ── tick / HUD ───────────────────────────────────────────────────────

    private void OnTick()
    {
        _tickCount++;
        if (_tickCount % HUD_TICK_INTERVAL != 0) return;

        // Belt-and-suspenders gate: the plugin is supposed to be unloaded
        // on non-movement modes via unload_plugins.cfg, but if that misses
        // (a custom cfg, a kus image update that overwrites our overlay,
        // …) we'd leak the speed/timer HUD into Deathmatch / Casual /
        // Minigames. Map name is the cheapest source of truth — if it
        // doesn't look like a movement map, skip every player.
        if (!IsMovementMap(_currentMap)) return;

        // Drive the ghost-bot replay (if running). Happens BEFORE the
        // per-player UpdateOne loop so the WASD HUD can be overwritten
        // by an active runner's own timer line in the same tick.
        GhostTick();

        foreach (var player in Utilities.GetPlayers())
        {
            if (player == null || !player.IsValid || player.IsBot || player.IsHLTV) continue;
            var pawn = player.PlayerPawn?.Value;
            if (pawn == null || !pawn.IsValid) continue;
            if (pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE) continue;
            // Players riding the ghost via !ghostcam are being teleported
            // every tick — they can't actually surf, and any timer/PB the
            // engine would credit them is the ghost's, not theirs.
            // Bail out before UpdateOne so the run never starts and the
            // current frame doesn't get recorded.
            if (_ghostFollowers.Contains(player.SteamID))
            {
                // Make sure their run is also cancelled if they entered
                // ghostcam mid-run.
                _runStart.Remove(player.SteamID);
                _replayRec.Remove(player.SteamID);
                continue;
            }
            UpdateOne(player, pawn);
        }
    }

    private static bool IsMovementMap(string map)
    {
        if (string.IsNullOrEmpty(map)) return false;
        return map.StartsWith("surf_", StringComparison.OrdinalIgnoreCase) ||
               map.StartsWith("bhop_", StringComparison.OrdinalIgnoreCase) ||
               map.StartsWith("kz_",   StringComparison.OrdinalIgnoreCase) ||
               map.StartsWith("xc_",   StringComparison.OrdinalIgnoreCase); // climbing/kz variants
    }

    private void UpdateOne(CCSPlayerController player, CCSPlayerPawn pawn)
    {
        var vel = pawn.AbsVelocity;
        float raw = (float)Math.Sqrt(vel.X * vel.X + vel.Y * vel.Y);
        int hSpeed = ((int)Math.Round(raw / SPEED_ROUND_TO)) * SPEED_ROUND_TO;

        var pos = pawn.AbsOrigin;
        var key = player.SteamID;

        // Jumpstats — edge-detect ground transitions.
        bool onGround = (pawn.Flags & FL_ONGROUND) != 0;
        bool wasOnGround = _wasOnGround.GetValueOrDefault(key, true);
        if (!onGround && wasOnGround)
        {
            // Took off — remember horizontal speed at the instant of liftoff.
            _takeoffSpd[key] = raw;
        }
        else if (onGround && !wasOnGround)
        {
            // Landed — record (takeoff, landing) for the HUD line.
            if (_takeoffSpd.TryGetValue(key, out var t))
            {
                _lastJump[key] = (t, raw);
            }
        }
        _wasOnGround[key] = onGround;

        // Start the timer:
        //   - If the map has detected start zones (or the operator pinned
        //     one) — the timer starts the instant the player enters one,
        //     so the run length matches the map's own timer.
        //   - Otherwise fall back to the speed threshold so maps without
        //     named start triggers still produce reasonable times.
        bool atStart = pos != null && IsInStartZone(pos);
        bool prevAtStart = _wasAtStart.GetValueOrDefault(key);
        bool haveStartZones = _startZones.Count > 0;
        if (haveStartZones)
        {
            // Edge-trigger: starting the run on entry. A player who lingers
            // in the start zone has _runStart reset each entry, which is
            // the standard surf-timer behaviour (re-entering restarts).
            if (atStart && !prevAtStart)
            {
                _runStart[key] = DateTime.UtcNow;
                _replayRec[key] = new List<ReplayFrame>();
            }
        }
        else if (!_runStart.ContainsKey(key) && hSpeed >= START_SPEED && pos != null && !IsInEndZone(pos))
        {
            _runStart[key] = DateTime.UtcNow;
            _replayRec[key] = new List<ReplayFrame>();
        }
        _wasAtStart[key] = atStart;

        // ── replay record ─────────────────────────────────────────────────
        // While the timer's running, append a frame per tick. Native
        // deref of pawn.EyeAngles / player.Buttons in the first tick
        // after a run starts segfaulted on a plugin hot-reload +
        // map_start sequence (engine still initializing the spawn).
        // Two guards: (a) skip first 30ms of run (let engine settle);
        // (b) wrap the deref in try/catch and drop the recording on
        // failure so we don't crash-loop.
        if (_runStart.TryGetValue(key, out var rsAt) &&
            _replayRec.TryGetValue(key, out var frames) &&
            pos != null &&
            (DateTime.UtcNow - rsAt).TotalMilliseconds > 30)
        {
            try
            {
                var eye = pawn.EyeAngles;
                ulong buttonMask = 0UL;
                try { buttonMask = (ulong)player.Buttons; } catch { }
                frames.Add(new ReplayFrame
                {
                    X     = pos.X, Y = pos.Y, Z = pos.Z,
                    Pitch = eye?.X ?? 0f, Yaw = eye?.Y ?? 0f, Roll = eye?.Z ?? 0f,
                    Buttons = buttonMask,
                });
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlSurfHUD] replay frame skipped (deref): {e.Message}");
                if (frames.Count == 0) _replayRec.Remove(key);
            }
        }

        bool atEnd = pos != null && IsInEndZone(pos);
        bool prevAtEnd = _wasAtEnd.GetValueOrDefault(key);
        if (atEnd && !prevAtEnd && _runStart.TryGetValue(key, out var start))
        {
            var elapsed = DateTime.UtcNow - start;
            _runStart.Remove(key);
            OnFinish(player, elapsed);
        }
        _wasAtEnd[key] = atEnd;

        // Draw HUD — minimal center text so it doesn't dominate the screen.
        // Two modes:
        //   - Active run (player has crossed start zone): single line
        //     `00:12.5  220 u/s` so they can pace.
        //   - Not in a run: empty string → engine clears the center text.
        //     Speed / PB / jumpstats are noise when not timing a run.
        // Big timing events (finish, PB break) still announce in chat via
        // OnFinish — no info lost, just no continuous center spam.
        string line;
        if (_runStart.TryGetValue(key, out var liveStart))
        {
            line = $"{FormatTimeMs(DateTime.UtcNow - liveStart)}  {hSpeed,4} u/s";
        }
        else
        {
            line = "";
        }

        if (_lastHud.TryGetValue(key, out var last) && last == line) return;
        _lastHud[key] = line;
        player.PrintToCenter(line);
    }

    // ── finish handling + records ────────────────────────────────────────

    private void OnFinish(CCSPlayerController player, TimeSpan elapsed)
    {
        var key = player.SteamID;
        var elapsedMs = (long)elapsed.TotalMilliseconds;

        TimeSpan? prevBest = _sessionBest.TryGetValue(key, out var sb) ? sb : null;
        string verdict;
        bool isNewPb = !prevBest.HasValue || elapsed < prevBest.Value;
        var pname = player.PlayerName ?? "";
        var psid  = key.ToString();
        var pmap  = _currentMap;
        // Snapshot the recorded frames BEFORE we clear them — the
        // Save off-thread reads from the captured list. _replayRec[key]
        // gets blown away after this method, so we copy the reference
        // (frames are immutable from here on).
        List<ReplayFrame>? recFrames = null;
        if (_replayRec.TryGetValue(key, out var rec))
        {
            recFrames = rec;
            _replayRec.Remove(key);
        }

        if (isNewPb)
        {
            _sessionBest[key] = elapsed;
            verdict = !prevBest.HasValue ? "first time on record!" :
                $"NEW PB! (was {FormatTime(prevBest.Value)})";

            // Persist atomically, off the game thread.
            Task.Run(() => SaveNewPb(pmap, psid, pname, elapsedMs));

            // Persist the replay alongside the PB. Only the PB run gets
            // a replay (no point storing slower attempts — they're
            // demoted on the next PB anyway).
            if (recFrames != null && recFrames.Count > 0)
            {
                Task.Run(() => SaveReplay(pmap, psid, pname, elapsedMs, recFrames!));
                // If this PB also beat the SERVER WR (fastest time on
                // map across all players), swap the live ghost over to
                // the new run. Compare against the in-memory _records
                // top-1 before this run was saved.
                long currentWr = _records.Records.TryGetValue(pmap, out var d) && d.Count > 0
                    ? d.Values.Min(r => r.TimeMs)
                    : long.MaxValue;
                if (elapsedMs < currentWr)
                {
                    // We're saving asynchronously; give the file time
                    // to land on disk before LoadBestReplay re-scans.
                    AddTimer(1.5f, () =>
                    {
                        var newBest = LoadBestReplay(pmap);
                        if (newBest != null && newBest.Sid == psid)
                        {
                            Server.PrintToChatAll($" \x06[Surf]\x01 \x04NEW SERVER WR\x01 — ghost bot now running \x04{pname}\x01's route.");
                            StartReplay(newBest, null);
                        }
                    });
                }
            }
        }
        else
        {
            verdict = $"+{FormatTime(elapsed - prevBest!.Value)} off PB";
        }
        // Append EVERY finish to the attempts log — PB or not — so the
        // records site can show all attempts. Off-thread file I/O so the
        // game tick isn't stalled by a disk write.
        Task.Run(() => AppendAttempt(pmap, psid, pname, elapsedMs, isNewPb));
        Server.PrintToChatAll($" \x06[Surf]\x01 {player.PlayerName} finished in \x04{FormatTime(elapsed)}\x01 — {verdict}");
    }

    // SaveReplay — atomic write of a ReplayFile JSON to
    //   /home/steam/cs2/gamectl_surf_replays/<map>__<sid>.json
    // Overwrites any prior replay for the same (map, sid) — a player's
    // PB only ever has one canonical recording.
    private void SaveReplay(string map, string sid, string name, long timeMs, List<ReplayFrame> frames)
    {
        try
        {
            Directory.CreateDirectory(REPLAY_DIR);
            var path = Path.Combine(REPLAY_DIR, $"{map}__{sid}.json");
            var doc = new ReplayFile
            {
                Map        = map,
                Sid        = sid,
                Name       = name,
                TimeMs     = timeMs,
                FinishedAt = DateTime.UtcNow.ToString("o"),
                Frames     = frames,
            };
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(doc));
            File.Move(tmp, path, overwrite: true);
            Server.PrintToConsole($"[GameCtlSurfHUD] replay saved: {path} ({frames.Count} frames)");
        }
        catch (Exception e)
        {
            Server.PrintToConsole($"[GameCtlSurfHUD] save replay failed: {e.Message}");
        }
    }

    // LoadBestReplay — find the fastest (lowest time_ms) replay file for
    // the given map, return the parsed ReplayFile or null. Used by
    // !replay to pick the server WR's recording.
    private ReplayFile? LoadBestReplay(string map)
    {
        try
        {
            if (!Directory.Exists(REPLAY_DIR)) return null;
            ReplayFile? best = null;
            foreach (var path in Directory.EnumerateFiles(REPLAY_DIR, $"{map}__*.json"))
            {
                try
                {
                    var doc = JsonSerializer.Deserialize<ReplayFile>(File.ReadAllText(path));
                    if (doc == null) continue;
                    if (best == null || doc.TimeMs < best.TimeMs) best = doc;
                }
                catch { /* skip corrupt replay file */ }
            }
            return best;
        }
        catch (Exception e)
        {
            Server.PrintToConsole($"[GameCtlSurfHUD] load best replay failed: {e.Message}");
            return null;
        }
    }

    // AppendAttempt writes one JSON object per line to the attempts log.
    // Line-delimited so each append is independent — no rewrite, no JSON
    // tree to maintain, and a crash mid-write at worst loses the trailing
    // partial line. The cs2-records site streams the file and renders the
    // entries (newest-first per map / per player).
    private void AppendAttempt(string map, string sid, string name, long timeMs, bool isPb)
    {
        try
        {
            var entry = new
            {
                map         = map,
                sid         = sid,
                name        = name,
                time_ms     = timeMs,
                pb          = isPb,
                finished_at = DateTime.UtcNow.ToString("o"),
            };
            var line = JsonSerializer.Serialize(entry) + "\n";
            File.AppendAllText(ATTEMPTS_PATH, line);
        }
        catch (Exception e)
        {
            Server.PrintToConsole($"[GameCtlSurfHUD] append attempt failed: {e.Message}");
        }
    }

    private void SaveNewPb(string map, string sid, string name, long timeMs)
    {
        lock (_recordsLock)
        {
            if (!_records.Records.TryGetValue(map, out var mapDict))
            {
                mapDict = new Dictionary<string, RecordEntry>();
                _records.Records[map] = mapDict;
            }
            mapDict[sid] = new RecordEntry
            {
                Name       = name,
                TimeMs     = timeMs,
                FinishedAt = DateTime.UtcNow.ToString("o"),
            };
            try
            {
                var tmp = RECORDS_PATH + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(_records,
                    new JsonSerializerOptions { WriteIndented = true }));
                File.Move(tmp, RECORDS_PATH, overwrite: true);
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlSurfHUD] save records failed: {e.Message}");
            }
        }
    }

    private void LoadRecords()
    {
        lock (_recordsLock)
        {
            try
            {
                if (!File.Exists(RECORDS_PATH))
                {
                    _records = new RecordsFile();
                    return;
                }
                var raw = File.ReadAllText(RECORDS_PATH);
                _records = JsonSerializer.Deserialize<RecordsFile>(raw) ?? new RecordsFile();
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlSurfHUD] load records failed: {e.Message} — starting fresh");
                _records = new RecordsFile();
            }
        }
    }

    private void SeedSessionBestsFromRecords()
    {
        foreach (var player in Utilities.GetPlayers())
        {
            if (player == null || !player.IsValid || player.IsBot) continue;
            if (TryGetRecord(_currentMap, player.SteamID, out var rec))
                _sessionBest[player.SteamID] = TimeSpan.FromMilliseconds(rec.TimeMs);
        }
    }

    private bool TryGetRecord(string map, ulong sid, out RecordEntry rec)
    {
        lock (_recordsLock)
        {
            if (_records.Records.TryGetValue(map, out var mapDict) &&
                mapDict.TryGetValue(sid.ToString(), out var r))
            {
                rec = r;
                return true;
            }
        }
        rec = new RecordEntry();
        return false;
    }

    private List<KeyValuePair<string, RecordEntry>> GetTopForMap(string map, int n)
    {
        lock (_recordsLock)
        {
            if (!_records.Records.TryGetValue(map, out var mapDict)) return new();
            return mapDict.OrderBy(kv => kv.Value.TimeMs).Take(n).ToList();
        }
    }

    private int CountRecordsForMap(string map)
    {
        lock (_recordsLock)
        {
            return _records.Records.TryGetValue(map, out var d) ? d.Count : 0;
        }
    }

    // ── operator zones ───────────────────────────────────────────────────

    private void LoadZones()
    {
        lock (_zonesLock)
        {
            try
            {
                if (!File.Exists(ZONES_PATH))
                {
                    _zones = new ZonesFile();
                    return;
                }
                var raw = File.ReadAllText(ZONES_PATH);
                _zones = JsonSerializer.Deserialize<ZonesFile>(raw) ?? new ZonesFile();
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlSurfHUD] load zones failed: {e.Message} — starting fresh");
                _zones = new ZonesFile();
            }
        }
    }

    private void SaveZones()
    {
        lock (_zonesLock)
        {
            try
            {
                var tmp = ZONES_PATH + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(_zones,
                    new JsonSerializerOptions { WriteIndented = true }));
                File.Move(tmp, ZONES_PATH, overwrite: true);
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlSurfHUD] save zones failed: {e.Message}");
            }
        }
    }

    // Apply the operator's zones for the current map: if an end zone is
    // defined, force _endZones to JUST that point (overrides auto-detection).
    private void ApplyOperatorZonesForCurrentMap()
    {
        _operatorEnd = null;
        _operatorStart = null;
        lock (_zonesLock)
        {
            if (!_zones.Zones.TryGetValue(_currentMap, out var z)) return;
            if (z.End != null)
            {
                _operatorEnd = new Vector(z.End.X, z.End.Y, z.End.Z);
                _endZones.Clear();
                _endZones.Add(_operatorEnd);
            }
            if (z.Start != null)
            {
                _operatorStart = new Vector(z.Start.X, z.Start.Y, z.Start.Z);
                _startZones.Clear();
                _startZones.Add(_operatorStart);
            }
        }
    }

    private bool IsAdmin(CCSPlayerController player)
    {
        return AdminManager.PlayerHasPermissions(player, "@css/admin");
    }

    // ── commands ─────────────────────────────────────────────────────────

    public void OnPbCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid) return;
        if (TryGetRecord(_currentMap, player.SteamID, out var rec))
        {
            player.PrintToChat($" \x06[Surf]\x01 Your PB on \x04{_currentMap}\x01 is \x04{FormatTime(TimeSpan.FromMilliseconds(rec.TimeMs))}\x01.");
        }
        else
        {
            player.PrintToChat($" \x06[Surf]\x01 You have no record on \x04{_currentMap}\x01 yet. Finish a run to set one!");
        }
    }

    public void OnTopCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid) return;
        var top = GetTopForMap(_currentMap, LEADERBOARD_LIMIT);
        if (top.Count == 0)
        {
            player.PrintToChat($" \x06[Surf]\x01 No records yet on \x04{_currentMap}\x01.");
            return;
        }
        player.PrintToChat($" \x06[Surf]\x01 Top {top.Count} on \x04{_currentMap}\x01:");
        for (int i = 0; i < top.Count; i++)
        {
            var e = top[i].Value;
            player.PrintToChat($" \x06[Surf]\x01 \x10{i + 1,2}.\x01 {e.Name,-20} \x04{FormatTime(TimeSpan.FromMilliseconds(e.TimeMs))}\x01");
        }
    }

    public void OnRankCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid) return;
        var sid = player.SteamID.ToString();
        List<KeyValuePair<string, RecordEntry>> all;
        lock (_recordsLock)
        {
            if (!_records.Records.TryGetValue(_currentMap, out var d) || !d.ContainsKey(sid))
            {
                player.PrintToChat($" \x06[Surf]\x01 You have no rank on \x04{_currentMap}\x01 yet — finish a run first.");
                return;
            }
            all = d.OrderBy(kv => kv.Value.TimeMs).ToList();
        }
        var rank = all.FindIndex(kv => kv.Key == sid) + 1;
        var pb = TimeSpan.FromMilliseconds(all[rank - 1].Value.TimeMs);
        player.PrintToChat($" \x06[Surf]\x01 You are \x04#{rank} of {all.Count}\x01 on \x04{_currentMap}\x01 with \x04{FormatTime(pb)}\x01.");
    }

    // !setstart / css_setstart — admin pins the start zone at their feet.
    // Reserved for future "must enter start before timer starts" logic;
    // currently saved for completeness and future use.
    public void OnSetStartCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid) return;
        if (!IsAdmin(player)) { player.PrintToChat(" \x06[Surf]\x01 Admin only."); return; }
        var pos = player.PlayerPawn?.Value?.AbsOrigin;
        if (pos == null) return;
        lock (_zonesLock)
        {
            if (!_zones.Zones.TryGetValue(_currentMap, out var z))
            {
                z = new MapZoneEntry();
                _zones.Zones[_currentMap] = z;
            }
            z.Start = new ZoneVec { X = pos.X, Y = pos.Y, Z = pos.Z };
        }
        SaveZones();
        ApplyOperatorZonesForCurrentMap();
        player.PrintToChat($" \x06[Surf]\x01 Start zone set at \x04({pos.X:F0}, {pos.Y:F0}, {pos.Z:F0})\x01 on \x04{_currentMap}\x01.");
    }

    // !setend / css_setend — admin pins the finish zone at their feet.
    // Replaces any auto-detected end triggers for this map. Effective on
    // the next finish-detection tick.
    public void OnSetEndCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid) return;
        if (!IsAdmin(player)) { player.PrintToChat(" \x06[Surf]\x01 Admin only."); return; }
        var pos = player.PlayerPawn?.Value?.AbsOrigin;
        if (pos == null) return;
        lock (_zonesLock)
        {
            if (!_zones.Zones.TryGetValue(_currentMap, out var z))
            {
                z = new MapZoneEntry();
                _zones.Zones[_currentMap] = z;
            }
            z.End = new ZoneVec { X = pos.X, Y = pos.Y, Z = pos.Z };
        }
        SaveZones();
        ApplyOperatorZonesForCurrentMap();
        player.PrintToChat($" \x06[Surf]\x01 End zone set at \x04({pos.X:F0}, {pos.Y:F0}, {pos.Z:F0})\x01 on \x04{_currentMap}\x01. Surf back to it to finish.");
    }

    public void OnClearZonesCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid) return;
        if (!IsAdmin(player)) { player.PrintToChat(" \x06[Surf]\x01 Admin only."); return; }
        lock (_zonesLock)
        {
            _zones.Zones.Remove(_currentMap);
        }
        SaveZones();
        _operatorEnd = null;
        _operatorStart = null;
        _endZones.Clear();
        player.PrintToChat($" \x06[Surf]\x01 Cleared operator zones for \x04{_currentMap}\x01. Auto-detected triggers will be used.");
    }

    public void OnZonesCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid) return;
        lock (_zonesLock)
        {
            if (!_zones.Zones.TryGetValue(_currentMap, out var z) || (z.Start == null && z.End == null))
            {
                player.PrintToChat($" \x06[Surf]\x01 No operator zones set for \x04{_currentMap}\x01.");
                return;
            }
            if (z.Start != null)
                player.PrintToChat($" \x06[Surf]\x01 Start: \x04({z.Start.X:F0}, {z.Start.Y:F0}, {z.Start.Z:F0})\x01");
            if (z.End != null)
                player.PrintToChat($" \x06[Surf]\x01 End:   \x04({z.End.X:F0}, {z.End.Y:F0}, {z.End.Z:F0})\x01");
        }
    }

    // !r / css_r — quick reset: respawn the player at the map's spawn,
    // wipe their live timer + jumpstat state. The standard surf-server UX
    // (skip the death/freezetime dance, just teleport back to the start).
    public void OnResetCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid) return;
        if (player.IsBot || player.IsHLTV) return;
        var key = player.SteamID;
        // Wipe local state ahead of the respawn so the next tick can't
        // observe stale takeoff/timer values mid-teleport.
        _runStart.Remove(key);
        _wasAtEnd[key] = false;
        _lastJump.Remove(key);
        _takeoffSpd.Remove(key);
        _lastHud.Remove(key);
        _wasOnGround[key] = true;
        player.Respawn();
    }

    public void OnWrCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid) return;
        var top = GetTopForMap(_currentMap, 1);
        if (top.Count == 0)
        {
            player.PrintToChat($" \x06[Surf]\x01 No server record yet on \x04{_currentMap}\x01 — be the first!");
            return;
        }
        var e = top[0].Value;
        player.PrintToChat($" \x06[Surf]\x01 Server record on \x04{_currentMap}\x01: \x04{FormatTime(TimeSpan.FromMilliseconds(e.TimeMs))}\x01 by \x04{e.Name}\x01.");
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private bool IsInEndZone(Vector pos)
    {
        for (int i = 0; i < _endZones.Count; i++)
        {
            var z = _endZones[i];
            float dx = pos.X - z.X, dy = pos.Y - z.Y, dz = pos.Z - z.Z;
            if (dx * dx + dy * dy + dz * dz <= END_TRIGGER_RADIUS * END_TRIGGER_RADIUS) return true;
        }
        return false;
    }

    private bool IsInStartZone(Vector pos)
    {
        for (int i = 0; i < _startZones.Count; i++)
        {
            var z = _startZones[i];
            float dx = pos.X - z.X, dy = pos.Y - z.Y, dz = pos.Z - z.Z;
            if (dx * dx + dy * dy + dz * dz <= START_TRIGGER_RADIUS * START_TRIGGER_RADIUS) return true;
        }
        return false;
    }

    private static string FormatTime(TimeSpan ts) =>
        $"{(int)ts.TotalMinutes:D2}:{ts.Seconds:D2}.{ts.Milliseconds / 10:D2}";

    // Used for the live in-run HUD — refreshed every tick. Earlier
    // versions chunked to half-seconds (FormatTimeHalf) to reduce
    // PrintToCenter churn, but players want to see ms-precision.
    // CS2's PrintToCenter is fine being called every tick with the
    // same content gated by the _lastHud equality check (which still
    // works since the ms field only changes when the value changes).
    private static string FormatTimeMs(TimeSpan ts) =>
        $"{(int)ts.TotalMinutes:D2}:{ts.Seconds:D2}.{ts.Milliseconds:D3}";

    // Kept for compatibility with any callers (the WASD ghost HUD
    // still uses half-second labels for the long replay-time string
    // since it's not user-time-critical).
    private static string FormatTimeHalf(TimeSpan ts) =>
        $"{(int)ts.TotalMinutes:D2}:{ts.Seconds:D2}.{(ts.Milliseconds >= 500 ? 5 : 0)}";

    // ── replay commands + ghost-bot playback ─────────────────────────────

    // !replay / !replaybest — load the fastest replay for the current
    // map and start ghost-bot playback. Spawns a CT bot via the engine,
    // then on each tick we override its pawn pos + view angles from the
    // recorded frame. Bot AI tries to do its own thing but the per-tick
    // teleport overrides whatever it decides.
    public void OnReplayCommand(CCSPlayerController? player, CommandInfo command)
    {
        // Allow console / RCON invocation (player == null) so admins
        // can test from outside the game. Bots still blocked.
        if (player != null && (!player.IsValid || player.IsBot)) return;

        // Subcommand routing: `!replay`, `!replay models`, `!replay <name>`.
        var arg = (command.ArgString ?? "").Trim().Trim('"');
        if (arg.Length > 0)
        {
            if (arg.Equals("models", StringComparison.OrdinalIgnoreCase) ||
                arg.Equals("model",  StringComparison.OrdinalIgnoreCase) ||
                arg.Equals("list",   StringComparison.OrdinalIgnoreCase))
            {
                var keys = string.Join(", ", GHOST_MODEL_OPTIONS.Keys);
                var cur  = _ghostModelPref ?? "chicken";
                var msg  = $"Ghost models: \x04{keys}\x01 (current: \x04{cur}\x01). Use \x04!replay <name>\x01 to switch.";
                if (player != null) Reply(player, msg); else Server.PrintToConsole(msg);
                return;
            }
            if (GHOST_MODEL_OPTIONS.ContainsKey(arg))
            {
                _ghostModelPref = arg.ToLowerInvariant();
                Server.PrintToChatAll($" \x06[Surf]\x01 Ghost model set to \x04{_ghostModelPref}\x01.");
                // If a replay is already running, restart it so the new
                // model takes effect immediately — otherwise the player
                // would have to !replaystop + !replay to see the change.
                if (_ghostFrames != null)
                {
                    var liveDoc = LoadBestReplay(_currentMap);
                    if (liveDoc != null) StartReplay(liveDoc, player);
                }
                return;
            }
            // `!replay trail`, `!replay trail on`, `!replay trail off` —
            // toggle the breadcrumb trail behind the ghost. Bare `trail`
            // flips current state so it's a one-word toggle.
            if (arg.StartsWith("trail", StringComparison.OrdinalIgnoreCase))
            {
                var sub = arg.Length > 5 ? arg.Substring(5).Trim() : "";
                bool desired = sub switch {
                    "on"  or "1" or "true"  or "yes" => true,
                    "off" or "0" or "false" or "no"  => false,
                    _ => !_ghostTrailEnabled,
                };
                _ghostTrailEnabled = desired;
                Server.PrintToChatAll($" \x06[Surf]\x01 Ghost trail \x04{(desired ? "on" : "off")}\x01.");
                return;
            }
            // Unknown arg — chat-notify, no side effects (mirrors the !map
            // typo-safety behavior on the GameCtlRtv side).
            var avail = string.Join(", ", GHOST_MODEL_OPTIONS.Keys);
            var hint = $"Unknown ghost model \x04{arg}\x01. Available: \x04{avail}\x01 (\x04!replay models\x01).";
            if (player != null) Reply(player, hint); else Server.PrintToConsole(hint);
            return;
        }

        var doc = LoadBestReplay(_currentMap);
        if (doc == null || doc.Frames.Count == 0)
        {
            Server.PrintToConsole($"[GameCtlSurfHUD] !replay: no replay saved for {_currentMap} — set a PB to record one.");
            if (player != null) Reply(player, $"No replay saved for \x04{_currentMap}\x01 yet — set a PB to record one.");
            return;
        }
        Server.PrintToConsole($"[GameCtlSurfHUD] !replay: starting playback of {doc.Name}'s {doc.TimeMs}ms run on {_currentMap} ({doc.Frames.Count} frames)");
        StartReplay(doc, player);
    }

    public void OnReplayStopCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid || player.IsBot) return;
        if (_ghostFrames == null)
        {
            Reply(player, "No replay running.");
            return;
        }
        StopReplay();
        Server.PrintToChatAll(" \x06[Surf]\x01 Replay stopped.");
    }

    // !ghostcam — toggle a chase-cam that snaps your view to follow
    // the ghost. Implemented by teleporting the player's pawn each
    // tick to a position 140u behind / 60u above the ghost looking
    // at it. Type !ghostcam again to release; you stop wherever the
    // camera left you.
    public void OnGhostCamCommand(CCSPlayerController? player, CommandInfo command)
    {
        if (player == null || !player.IsValid || player.IsBot) return;
        if (_ghostFrames == null)
        {
            Reply(player, "No replay running — fire \x04!replay\x01 first.");
            return;
        }
        if (_ghostFollowers.Add(player.SteamID))
        {
            Reply(player, "Camera \x04LOCKED\x01 to ghost. Type \x04!ghostcam\x01 again to release.");
        }
        else
        {
            _ghostFollowers.Remove(player.SteamID);
            Reply(player, "Camera released.");
        }
    }

    // The ghost is now a prop_dynamic_override carrying a player model
    // (CS2 ctm_st6 SEAL Frogman). This bypasses the engine's bot
    // manager entirely — kus's BotAI plugin only successfully applies
    // 3/4 of its memory patches on the current CS2 build (the failing
    // one, HasVisitedEnemySpawn, is what would allow `bot_add` on
    // nav-less surf maps after a host_workshop_map changelevel). Props
    // can be teleported every tick the same way and are visible to
    // every spectator with no engine cooperation required.
    private CBaseEntity? _ghostProp;
    // CPointWorldText doesn't render \n as a line break — to stack the
    // label vertically we spawn one entity per line and Z-offset them
    // every tick. _ghostLabel stays as the primary entity reference
    // (used by _ghostProp fallback) and _ghostLabelLines holds extras.
    private CPointWorldText? _ghostLabel;
    private readonly List<CPointWorldText> _ghostLabelLines = new();
    private HashSet<ulong> _ghostFollowers = new();
    private void TrySpawnGhostLabel(ReplayFrame f0)
    {
        // No-op: the floating point_worldtext label was redundant with
        // the center-screen WASD HUD (which already shows "[GHOST name
        // time]") and added visual clutter on top of the chicken. The
        // method is kept so the spawn / cleanup callsites still work;
        // any leftover label entities from a prior plugin load are
        // also removed here to keep the world clean.
        foreach (var t in _ghostLabelLines) { try { if (t.IsValid) t.Remove(); } catch { } }
        _ghostLabelLines.Clear();
        _ghostLabel = null;
    }
    private void StartReplay(ReplayFile doc, CCSPlayerController? invoker)
    {
        // If a replay is already running, stop it first — single ghost
        // at a time keeps the bookkeeping simple.
        if (_ghostBot != null || _ghostProp != null) StopReplay();

        _ghostFrames  = doc.Frames;
        _ghostFrameIdx = 0;
        _ghostName    = doc.Name;
        _ghostTimeMs  = doc.TimeMs;

        // Spawn the ghost prop at the first-frame position. If prop
        // creation fails for any reason (e.g. model not precached on
        // this map) we fall back to the legacy bot-adoption path so at
        // least something might appear.
        SpawnGhostProp(doc.Frames[0]);

        // Legacy spawn entities — harmless if the prop path works,
        // useful for the bot-adopt fallback if it doesn't.
        SpawnGhostSpawnPoint(doc.Frames[0]);

        // Persistent bot maintenance + try every team spawn path.
        // bot_add (no team) → engine picks; bot_add_ct + bot_add_t →
        // explicit. Whichever one materializes a bot, AdoptCtBot or
        // its sibling logic will find it.
        // bot_auto_vacate 0 is critical: the kus bots.cfg defaults it
        // to 1, which makes the engine kick any bot the moment a human
        // joins its team — killing the ghost replay before the first
        // frame runs.
        // The ghost is rendered as a point_worldtext marker (see
        // SpawnGhostProp), not a bot — so we no longer need bot_add /
        // bot_quota / mp_restartgame. mp_restartgame in particular is
        // DESTRUCTIVE: it resets the current round and wipes every
        // active player's run timer. !replay must never reset anyone
        // else's progress. The cvars below are cheap and don't disrupt
        // surfers.
        Server.ExecuteCommand(
            "bot_auto_vacate 0;" +
            "bot_join_after_player 0");

        Server.PrintToChatAll($" \x06[Surf]\x01 Replay ghost spawning — \x04{doc.Name}\x01's WR on \x04{doc.Map}\x01 \x04{FormatTime(TimeSpan.FromMilliseconds(doc.TimeMs))}\x01.");

        // 2-second delayed adoption — mp_restartgame takes ~1s to land
        // and the bot then needs another tick or two to fully connect.
        // The OnTick re-adopt loop continues from there if 2s isn't
        // enough.
        AddTimer(2.0f, () => AdoptCtBot());
    }

    // Spawn the visible ghost — a prop_dynamic_override carrying a
    // CT player model. CS2 ships the SEAL Frogman / SAS model paths
    // unconditionally so they don't need precaching per-map.
    private void SpawnGhostProp(ReplayFrame f0)
    {
        try { if (_ghostProp?.IsValid == true) _ghostProp.Remove(); } catch { }
        _ghostProp = null;
        // Verified paths from the CS2 base VPK, all precached in
        // OnServerPrecacheResources. If the operator has picked a
        // preference via `!replay <name>` we try that first, then fall
        // through the rest of the chain so an unexpected spawn failure
        // doesn't leave the ghost invisible.
        var models = new List<string>();
        if (_ghostModelPref != null && GHOST_MODEL_OPTIONS.TryGetValue(_ghostModelPref, out var preferred))
            models.Add(preferred);
        foreach (var path in GHOST_MODEL_OPTIONS.Values)
            if (!models.Contains(path)) models.Add(path);
        // Try prop_dynamic with a non-skeletal model first (toilet,
        // chicken, …). The SkeletonInstance assertion only fired on
        // player models — non-skeletal meshes don't trigger it, so a
        // toilet should actually hold.
        foreach (var m in models)
        {
            try
            {
                var ent = Utilities.CreateEntityByName<CDynamicProp>("prop_dynamic");
                if (ent == null) continue;
                // DispatchSpawn BEFORE SetModel: a freshly created entity sits in
                // the engine staging list (EF_IN_STAGING_LIST) until it spawns.
                // Calling SetModel() first runs SetupModel() on a staged entity and
                // trips skeletoninstance.cpp's assertion, which on the live CS2
                // build cascades into a hard Abort (the !replay crash). Spawn first,
                // then set the model once the staging flag is cleared.
                ent.DispatchSpawn();
                if (!ent.IsValid)
                {
                    Server.PrintToConsole($"[GameCtlSurfHUD] prop spawn ({m}) went invalid post-DispatchSpawn");
                    continue;
                }
                ent.SetModel(m);
                ent.Teleport(
                    new Vector(f0.X, f0.Y, f0.Z),
                    new QAngle(0f, f0.Yaw, 0f),
                    new Vector(0, 0, 0));
                if (ent.IsValid)
                {
                    _ghostProp = ent;
                    Server.PrintToConsole($"[GameCtlSurfHUD] ghost prop spawned with {m} at ({f0.X:F0},{f0.Y:F0},{f0.Z:F0})");
                    // Companion worldtext label above the prop so
                    // spectators see "GHOST: name time" + WASD hints.
                    TrySpawnGhostLabel(f0);
                    return;
                }
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlSurfHUD] prop ({m}) failed: {e.Message}");
            }
        }
        // Fall back to a pure worldtext marker if no model held.
        TrySpawnGhostLabel(f0);
        if (_ghostLabel != null)
        {
            _ghostProp = _ghostLabel;  // tick-loop drives this
            Server.PrintToConsole($"[GameCtlSurfHUD] ghost fell back to worldtext-only at ({f0.X:F0},{f0.Y:F0},{f0.Z:F0})");
        }
        Server.PrintToConsole("[GameCtlSurfHUD] all ghost prop model paths failed; falling back to bot-adopt path");
    }

    // Drop a chicken breadcrumb at the ghost's current pose. Registered
    // in _trail and faded out by UpdateTrailFade tick-by-tick — no per-
    // breadcrumb timer, no hard "pop out" at the tail. Chicken is small
    // enough to read as a trail dot rather than a chain of mini-ghosts,
    // and it's already in the OnServerPrecacheResources list.
    private void DropTrailBreadcrumb(ReplayFrame f)
    {
        try
        {
            var bc = Utilities.CreateEntityByName<CDynamicProp>("prop_dynamic");
            if (bc == null) return;
            // Spawn before SetModel — same staging-list fix as SpawnGhostProp.
            // This path runs every replay tick, so the old SetModel-first order
            // was the per-tick assertion spammer behind the !replay Abort.
            bc.DispatchSpawn();
            if (!bc.IsValid) return;
            bc.SetModel("models/chicken/chicken.vmdl");
            bc.Teleport(
                new Vector(f.X, f.Y, f.Z),
                new QAngle(0f, f.Yaw, 0f),
                new Vector(0, 0, 0));
            // Enable per-entity alpha — without TransAlpha the m_clrRender
            // alpha channel is ignored and the prop stays fully opaque.
            try
            {
                bc.RenderMode = RenderMode_t.kRenderTransAlpha;
                bc.Render = TRAIL_TINT;
                Utilities.SetStateChanged(bc, "CBaseModelEntity", "m_clrRender");
                Utilities.SetStateChanged(bc, "CBaseModelEntity", "m_nRenderMode");
            }
            catch { /* state-change is best-effort; entity still spawns */ }
            _trail.Add((bc, _tickCount));
        }
        catch (Exception e)
        {
            // Single log per ~250 fails so a broken model path doesn't
            // spam the console — most "drop fails" are transient (entity
            // pool pressure during a level change).
            if ((_ghostTrailTickAccum & 0xFF) == 0)
                Server.PrintToConsole($"[GameCtlSurfHUD] trail breadcrumb spawn failed: {e.Message}");
        }
    }

    // Tick-driven fade for every active breadcrumb. Linear alpha ramp
    // from 255 down to 0 across TRAIL_LIFETIME_TICKS, then remove. We
    // iterate in reverse so the inline RemoveAt is safe.
    private void UpdateTrailFade()
    {
        if (_trail.Count == 0) return;
        for (int i = _trail.Count - 1; i >= 0; i--)
        {
            var (prop, spawnTick) = _trail[i];
            if (prop == null || !prop.IsValid)
            {
                _trail.RemoveAt(i);
                continue;
            }
            int age = _tickCount - spawnTick;
            if (age >= TRAIL_LIFETIME_TICKS)
            {
                try { prop.Remove(); } catch { }
                _trail.RemoveAt(i);
                continue;
            }
            // Ease-out cubic feels more "trail-like" than linear — early
            // breadcrumbs stay bright longer, then fade hard at the tail.
            float t = (float)age / TRAIL_LIFETIME_TICKS;
            float k = 1f - t;
            byte alpha = (byte)Math.Clamp((int)(255f * k * k * k), 0, 255);
            try
            {
                prop.Render = Color.FromArgb(alpha, TRAIL_TINT.R, TRAIL_TINT.G, TRAIL_TINT.B);
                Utilities.SetStateChanged(prop, "CBaseModelEntity", "m_clrRender");
            }
            catch { }
        }
    }

    private void ClearTrail()
    {
        foreach (var (prop, _) in _trail)
        {
            try { if (prop?.IsValid == true) prop.Remove(); } catch { }
        }
        _trail.Clear();
    }

    // Surf maps don't always ship info_player_counterterrorist /
    // info_player_terrorist entities — only a single generic
    // info_player_start. Engine refuses bot_add_<team> without team
    // spawn points. We create BOTH and hope one of them lets the
    // engine materialize a bot. Each at the recorded first-frame
    // position so the bot starts where the surfer started.
    private CBaseEntity? _ghostSpawnEntCT;
    private CBaseEntity? _ghostSpawnEntT;
    private void SpawnGhostSpawnPoint(ReplayFrame f0)
    {
        // Clean any prior spawn entities.
        try { if (_ghostSpawnEntCT?.IsValid == true) _ghostSpawnEntCT.Remove(); } catch { }
        try { if (_ghostSpawnEntT?.IsValid  == true) _ghostSpawnEntT.Remove();  } catch { }
        _ghostSpawnEntCT = TryCreateSpawn("info_player_counterterrorist", f0);
        _ghostSpawnEntT  = TryCreateSpawn("info_player_terrorist", f0);
        if (_ghostSpawnEntCT == null && _ghostSpawnEntT == null)
            Server.PrintToConsole("[GameCtlSurfHUD] both spawn-entity create attempts failed");
    }
    private CBaseEntity? TryCreateSpawn(string cls, ReplayFrame f0)
    {
        try
        {
            var ent = Utilities.CreateEntityByName<CBaseEntity>(cls);
            if (ent == null) return null;
            ent.Teleport(
                new Vector(f0.X, f0.Y, f0.Z + 4f),
                new QAngle(0f, f0.Yaw, 0f),
                new Vector(0, 0, 0));
            ent.DispatchSpawn();
            Server.PrintToConsole($"[GameCtlSurfHUD] created {cls} at ({f0.X:F0},{f0.Y:F0},{f0.Z:F0})");
            return ent;
        }
        catch (Exception e)
        {
            Server.PrintToConsole($"[GameCtlSurfHUD] create {cls} failed: {e.Message}");
            return null;
        }
    }

    // AdoptCtBot — find ANY bot in the game and assign it as our ghost.
    // Renamed-but-kept-method-name for git history continuity. Surf
    // maps may only accept bots on whichever team has spawn entities,
    // so we no longer require CT — we adopt the first bot we see.
    private int _adoptScanCount = 0;
    private void AdoptCtBot()
    {
        int total = 0, bots = 0, validBots = 0, teamedBots = 0;
        foreach (var p in Utilities.GetPlayers())
        {
            total++;
            if (p == null || !p.IsValid) continue;
            if (!p.IsBot) continue;
            bots++;
            validBots++;
            if (p.TeamNum < 2)
            {
                // Bot still in spec/unassigned — coax it onto a team.
                continue;
            }
            teamedBots++;
            _ghostBot = p;
            var pawn = p.PlayerPawn?.Value;
            if (pawn != null && pawn.IsValid)
            {
                try { pawn.MoveType = MoveType_t.MOVETYPE_NOCLIP; } catch { }
                try { p.GiveNamedItem("weapon_knife"); } catch { }
            }
            Server.PrintToConsole($"[GameCtlSurfHUD] adopted ghost bot: {p.PlayerName} (team {p.TeamNum})");
            return;
        }
        // Ghost is a point_worldtext now (no bot needed). This path
        // is only hit if the worldtext spawn failed; we no longer
        // fire bot_add* periodically because that's destructive on
        // a server where real players are mid-run.
        if ((_adoptScanCount++ & 31) == 0)
            Server.PrintToConsole($"[GameCtlSurfHUD] AdoptCtBot: no bot to adopt (players={total}, bots={bots}, teamedBots={teamedBots}) — passive, not refiring");
    }

    // Called from OnMapStart — if a WR replay exists for this map,
    // auto-spawn the ghost a few seconds after the map settles.
    // Saves players from having to type !replay every map.
    private void AutoStartGhostForMap()
    {
        // 4-second delay: map needs to finish spawning entities, bot
        // pool needs to be ready, and any cfg-chain bot_quota writes
        // need to have settled.
        AddTimer(4.0f, () =>
        {
            try
            {
                var doc = LoadBestReplay(_currentMap);
                if (doc == null || doc.Frames.Count == 0)
                {
                    Server.PrintToConsole($"[GameCtlSurfHUD] no replay for {_currentMap} — set a PB to record one.");
                    return;
                }
                StartReplay(doc, null);
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlSurfHUD] auto-replay-start failed: {e.Message}");
            }
        });
    }

    private void StopReplay()
    {
        if (_ghostBot != null && _ghostBot.IsValid)
        {
            try
            {
                if (_ghostBot.UserId.HasValue)
                    Server.ExecuteCommand($"kickid {_ghostBot.UserId.Value}");
            }
            catch { }
        }
        _ghostBot = null;
        _ghostFrames = null;
        _ghostFrameIdx = 0;
        try { if (_ghostProp?.IsValid == true) _ghostProp.Remove(); } catch { }
        _ghostProp = null;
        try { if (_ghostLabel?.IsValid == true) _ghostLabel.Remove(); } catch { }
        _ghostLabel = null;
        foreach (var t in _ghostLabelLines)
        {
            try { if (t.IsValid) t.Remove(); } catch { }
        }
        _ghostLabelLines.Clear();
        _ghostFollowers.Clear();
        try { if (_ghostSpawnEntCT?.IsValid == true) _ghostSpawnEntCT.Remove(); } catch { }
        try { if (_ghostSpawnEntT?.IsValid  == true) _ghostSpawnEntT.Remove();  } catch { }
        _ghostSpawnEntCT = null;
        _ghostSpawnEntT = null;
        ClearTrail();

        // Clear WASD HUD for everyone watching.
        foreach (var p in Utilities.GetPlayers())
        {
            if (p == null || !p.IsValid || p.IsBot || p.IsHLTV) continue;
            try { p.PrintToCenter(""); } catch { }
        }
    }

    // GhostTick — runs every OnTick. If a replay is active, pose the
    // ghost bot from the next frame and update the WASD HUD on any
    // human who's currently spectating it. Wrapped in try/catch so a
    // mid-transition native deref can't take the whole tick down.
    //
    // IMPORTANT: only return early when there's no active replay. We
    // MUST enter _GhostTickInner even when _ghostBot is null so the
    // re-adopt path can pick up a bot that materialized after the
    // initial AdoptCtBot in StartReplay (bot_add is queued, not
    // synchronous — the bot lands a few ticks later).
    private void GhostTick()
    {
        if (_ghostFrames == null) return;
        try { _GhostTickInner(); }
        catch (Exception e)
        {
            Server.PrintToConsole($"[GameCtlSurfHUD] ghost tick failed: {e.Message} — stopping replay");
            StopReplay();
        }
    }
    private void _GhostTickInner()
    {
        if (_ghostFrames == null) return;

        // Loop back to frame 0 when we run out — continuous replay
        // until !replaystop. Briefly chat-announce each lap.
        if (_ghostFrameIdx >= _ghostFrames.Count)
        {
            _ghostFrameIdx = 0;
            Server.PrintToChatAll($" \x06[Surf]\x01 Replay loop — \x04{_ghostName}\x01 \x04{FormatTime(TimeSpan.FromMilliseconds(_ghostTimeMs))}\x01.");
        }
        var f = _ghostFrames[_ghostFrameIdx++];

        // Prefer the prop ghost — works on any map regardless of bot
        // navigation. Falls back to a bot pawn if the prop spawn
        // failed AND a bot is around.
        bool posed = false;
        if (_ghostProp != null && _ghostProp.IsValid)
        {
            try
            {
                _ghostProp.Teleport(
                    new Vector(f.X, f.Y, f.Z),
                    new QAngle(0f, f.Yaw, 0f),  // props rotate on yaw only
                    new Vector(0, 0, 0));
                posed = true;
                if (_ghostTrailEnabled && (++_ghostTrailTickAccum % TRAIL_TICK_EVERY) == 0)
                    DropTrailBreadcrumb(f);
                UpdateTrailFade();
            }
            catch (Exception e)
            {
                if ((_tickCount & 127) == 0)
                    Server.PrintToConsole($"[GameCtlSurfHUD] ghost prop teleport failed: {e.Message}");
            }
        }
        else if ((_tickCount & 127) == 0)
        {
            Server.PrintToConsole($"[GameCtlSurfHUD] ghost prop missing (null={_ghostProp==null}, valid={_ghostProp?.IsValid})");
        }
        // Drag the label along — fixed yaw because ReorientMode does
        // the billboarding. Single label above the prop, no stacking.
        if (_ghostLabel != null && _ghostLabel.IsValid && _ghostLabel != _ghostProp)
        {
            try
            {
                _ghostLabel.Teleport(
                    new Vector(f.X, f.Y, f.Z + 50f),
                    new QAngle(0f, 0f, 0f),
                    new Vector(0, 0, 0));
            }
            catch { }
        }
        // Chase-cam any !ghostcam followers. Position the camera ~140u
        // behind the ghost, 60u above, looking at the ghost. Done by
        // teleporting the follower's pawn — works for alive players
        // and spectators alike since both expose Teleport.
        if (_ghostFollowers.Count > 0)
        {
            double yawRad = f.Yaw * Math.PI / 180.0;
            float bx = (float)Math.Cos(yawRad);
            float by = (float)Math.Sin(yawRad);
            const float behind = 140f;
            const float above = 60f;
            var camPos = new Vector(f.X - bx * behind, f.Y - by * behind, f.Z + above);
            // Aim ~10° down toward the ghost.
            var camAng = new QAngle(15f, f.Yaw, 0f);
            foreach (var sid in _ghostFollowers)
            {
                CCSPlayerController? p = null;
                foreach (var cp in Utilities.GetPlayers())
                {
                    if (cp != null && cp.IsValid && cp.SteamID == sid) { p = cp; break; }
                }
                if (p == null) continue;
                var fp = p.PlayerPawn?.Value;
                if (fp == null || !fp.IsValid) continue;
                try { fp.Teleport(camPos, camAng, new Vector(0, 0, 0)); } catch { }
            }
        }
        if (!posed && _ghostBot != null && _ghostBot.IsValid)
        {
            var pawn = _ghostBot.PlayerPawn?.Value;
            if (pawn != null && pawn.IsValid)
            {
                if (pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE)
                {
                    try { _ghostBot.Respawn(); } catch { }
                    return;
                }
                try
                {
                    pawn.Teleport(
                        new Vector(f.X, f.Y, f.Z),
                        new QAngle(f.Pitch, f.Yaw, f.Roll),
                        new Vector(0, 0, 0));
                    posed = true;
                }
                catch { }
            }
        }
        if (!posed)
        {
            // No prop AND no bot — try to re-adopt a bot if one is
            // available (legacy fallback path).
            if ((_tickCount & 31) == 0)
                AdoptCtBot();
            return;
        }

        // WASD HUD overlay — only shown to players who actively opted
        // in via !ghostcam. Spectators / dead players who didn't ask
        // for it don't get their center-screen text clobbered.
        if (_ghostFollowers.Count > 0)
        {
            var hud = $"\x04[GHOST {_ghostName} {FormatTime(TimeSpan.FromMilliseconds(_ghostTimeMs))}]\x01\n" +
                      ReplayHud.FormatButtons(f.Buttons);
            foreach (var p in Utilities.GetPlayers())
            {
                if (p == null || !p.IsValid || p.IsBot || p.IsHLTV) continue;
                if (!_ghostFollowers.Contains(p.SteamID)) continue;
                try { p.PrintToCenter(hud); } catch { }
            }
        }
    }

    private void Reply(CCSPlayerController p, string msg) =>
        p.PrintToChat($" \x06[Surf]\x01 {msg}");
}
