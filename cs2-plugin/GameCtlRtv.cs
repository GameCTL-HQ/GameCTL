using System.IO;
using System.Reflection;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Menu;
using CounterStrikeSharp.API.Modules.Utils;
using Timer = CounterStrikeSharp.API.Modules.Timers.Timer;

namespace GameCtlRtv;

// ---------------------------------------------------------------------------
// Config — shipped by GameCTL as
// addons/counterstrikesharp/configs/plugins/GameCtlRtv/GameCtlRtv.json
// ---------------------------------------------------------------------------

public sealed class MapEntry
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    // Workshop numeric id, or a stock map name (de_dust2, …).
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    // true  => host_workshop_map <id>;  false => changelevel <id>
    [JsonPropertyName("workshop")] public bool Workshop { get; set; }
}

public sealed class ModeEntry
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    // Mode cfg the server execs on switch, e.g. "surf.cfg" (game/csgo/cfg).
    [JsonPropertyName("cfg")] public string Cfg { get; set; } = "";
    [JsonPropertyName("maps")] public List<MapEntry> Maps { get; set; } = new();
}

// One line of the !help command list.
public sealed class HelpEntry
{
    [JsonPropertyName("cmd")] public string Cmd { get; set; } = "";
    [JsonPropertyName("desc")] public string Desc { get; set; } = "";
}

public sealed class GameCtlRtvConfig : BasePluginConfig
{
    // Percentage of connected humans that must !rtv to start the vote.
    [JsonPropertyName("rtv_percentage")] public int RtvPercentage { get; set; } = 60;
    // Seconds each stage's vote stays open.
    [JsonPropertyName("mode_vote_duration")] public int ModeVoteDuration { get; set; } = 25;
    [JsonPropertyName("map_vote_duration")] public int MapVoteDuration { get; set; } = 25;
    // Seconds between exec'ing the mode cfg and changing the map (lets the
    // mode's plugins load/unload before the level change).
    [JsonPropertyName("change_delay")] public int ChangeDelay { get; set; } = 6;
    [JsonPropertyName("modes")] public List<ModeEntry> Modes { get; set; } = new();
    // Lines shown by !help.
    [JsonPropertyName("help")] public List<HelpEntry> Help { get; set; } = new();
    // Greeting printed to a connecting player a few seconds after they spawn
    // in. Blank = no welcome. Supports the same {green}/{yellow}/{default}
    // colour tokens chat messages use.
    [JsonPropertyName("welcome_message")] public string WelcomeMessage { get; set; } = "";
    [JsonPropertyName("welcome_delay")] public int WelcomeDelay { get; set; } = 3;
    // End-of-map auto-vote. Fired when mp_timelimit / mp_maxrounds is about
    // to expire — scoped to the CURRENT mode's cached maps so we just pick
    // the next map without prompting for a mode swap.
    [JsonPropertyName("end_of_map_vote_enabled")] public bool EndOfMapVoteEnabled { get; set; } = true;
    [JsonPropertyName("end_of_map_vote_duration")] public int EndOfMapVoteDuration { get; set; } = 30;
    // Seconds before mp_timelimit expires that the vote should open.
    [JsonPropertyName("end_of_map_seconds_before")] public int EndOfMapSecondsBefore { get; set; } = 90;
    // Rounds before mp_maxrounds is hit that the vote should open.
    [JsonPropertyName("end_of_map_rounds_before")] public int EndOfMapRoundsBefore { get; set; } = 2;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

public sealed class GameCtlRtvPlugin : BasePlugin, IPluginConfig<GameCtlRtvConfig>
{
    public override string ModuleName => "GameCtl RTV";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleAuthor => "GameCTL";
    public override string ModuleDescription =>
        "Two-stage rock-the-vote: players vote a game mode, then a map of that mode.";

    public GameCtlRtvConfig Config { get; set; } = new();
    public void OnConfigParsed(GameCtlRtvConfig config) => Config = config;

    private enum Phase { Idle, ModeVote, MapVote, ModeOnlyVote }

    private Phase _phase = Phase.Idle;
    private readonly HashSet<ulong> _rtvVoters = new();   // who has typed !rtv
    private readonly Dictionary<ulong, int> _ballots = new(); // steamid -> option index
    private List<string> _optionLabels = new();           // labels for the current stage
    private List<ModeEntry> _voteModes = new();            // modes on the stage-1 ballot
    private List<MapEntry> _voteMaps = new();              // maps on the stage-2 ballot
    private ModeEntry? _chosenMode;
    // The mode the server is currently running. Seeded at Load() from
    // $GAMECTL_CS2_MODE and refreshed every time ApplyAndReset switches
    // mode. Used by the end-of-map auto-vote to scope the map ballot to
    // the active mode's cached maps.
    private ModeEntry? _activeMode;
    // End-of-map trigger state. Cleared and re-armed on every OnMapStart.
    private Timer? _endOfMapTimer;
    private int _roundsPlayed;
    private int _maxRoundsTrigger; // 0 = disabled; otherwise rounds-played threshold to fire vote
    private bool _endOfMapFired;

    // CS2's dedicated-server workshop cache. host_workshop_map can ONLY
    // change to a map that's already in here — on-demand downloads do not
    // happen on this image (verified live). So the plugin filters its vote
    // menus to only cached maps; players never pick a phantom map that the
    // server would then silently refuse to load.
    private const string WorkshopDir = "/home/steam/cs2/game/bin/linuxsteamrt64/steamapps/workshop/content/730";
    private static bool IsMapCached(MapEntry m)
    {
        if (!m.Workshop) return true; // stock maps always work
        if (string.IsNullOrWhiteSpace(m.Id)) return false;
        string dir = Path.Combine(WorkshopDir, m.Id);
        // CS2 workshop maps ship as either a single <id>.vpk OR a chunked
        // <id>_dir.vpk + <id>_NNN.vpk pair. Both are valid + loadable.
        return File.Exists(Path.Combine(dir, $"{m.Id}.vpk")) ||
               File.Exists(Path.Combine(dir, $"{m.Id}_dir.vpk"));
    }
    private static List<MapEntry> CachedMaps(ModeEntry mode) =>
        mode.Maps.Where(IsMapCached).ToList();
    private Timer? _voteTimer;

    private const string Tag = " {green}[RTV]{default}";

    public override void Load(bool hotReload)
    {
        AddCommand("css_rtv", "Rock the vote — start a mode + map vote", CommandRtv);
        AddCommand("css_unrtv", "Withdraw your rock-the-vote", CommandUnRtv);
        AddCommand("css_help", "List the server's player commands", CommandHelp);
        AddCommand("css_votemap", "[admin] Trigger an end-of-map map vote now", CommandVoteMap);
        // !modes / !maps — owned by this plugin (rather than GameModeManager)
        // so the offered options are filtered to maps that are actually
        // cached on disk. GameModeManager's versions can't see the cache and
        // silently no-op on uncached picks.
        AddCommand("css_modes", "[admin] Switch game mode (private menu)", CommandModes);
        AddCommand("css_maps", "[admin] Switch map within the current mode (private menu)", CommandMaps);
        // !mode <name> — admin direct mode swap. kus GameModeManager's !mode
        // command exec's the mode cfg but DOESN'T changelevel — so swapping
        // from aim to competitive on aim_redline_fp leaves you on aim_redline
        // playing comp rules. This handler runs alongside theirs (CSSharp
        // dispatches to every registered command handler) and does the
        // missing piece: changelevel to the first cached map in the new
        // mode's pool, so the map matches the mode.
        AddCommand("css_mode", "[admin] swap mode + jump to first cached map of that mode",
                   CommandModeSwitch);
        // !map <query> — substring filter over the active mode's cached map
        // pool. Opens a vote menu on the matches so typing "!map skeet"
        // narrows a 30-map list down to a couple of clickable options.
        AddCommand("css_map", "Filter the current mode's maps by substring and vote",
                   CommandMapSearch);

        // Pre-listeners — kus's GameModeManager registers !map and !mode in
        // parallel with our handlers and blindly calls changelevel on the
        // raw arg. On a bad name that triggers a server-wide pause + failed
        // map switch. We pre-validate against our catalog and return Stop
        // on no-match so kus's handler never sees the call. Valid input
        // falls through to our handler (kus's also runs as before — its
        // double-action on valid input is the same harmless behavior we've
        // tolerated all along).
        AddCommandListener("css_map",  PreMapListener,  HookMode.Pre);
        AddCommandListener("css_mode", PreModeListener, HookMode.Pre);

        // Seed the active mode from the wizard-stamped env var. The
        // catalog/config JSON only carries Name + Cfg + Maps (no "key"),
        // so we match by Cfg first ("surf" → "surf.cfg") and fall back
        // to a fuzzy Name match. If none match, end-of-map voting
        // simply no-ops until ApplyAndReset switches mode for us.
        _activeMode = ResolveActiveModeFromEnv();

        // A fresh map = a fresh RTV slate, AND a freshly armed end-of-map
        // trigger that fires either N seconds before mp_timelimit or
        // N rounds before mp_maxrounds, whichever comes first.
        RegisterListener<Listeners.OnMapStart>(_ =>
        {
            ResetAll();
            ArmEndOfMapTrigger();
        });

        // Tally rounds for the mp_maxrounds-based trigger. The vote fires
        // at the END of the round that crosses the threshold, so the
        // change-level lands during the next freeze-time.
        RegisterEventHandler<EventRoundEnd>((@event, info) =>
        {
            _roundsPlayed++;
            if (!_endOfMapFired
                && _maxRoundsTrigger > 0
                && _roundsPlayed >= _maxRoundsTrigger)
            {
                _endOfMapFired = true;
                StartEndOfMapVote();
            }
            return HookResult.Continue;
        });

        // Welcome incoming players. The delay lets the join chatter settle
        // before the greeting lands.
        RegisterListener<Listeners.OnClientPutInServer>(slot =>
        {
            if (string.IsNullOrWhiteSpace(Config.WelcomeMessage)) return;
            var p = Utilities.GetPlayerFromSlot(slot);
            if (p is null || !p.IsValid || p.IsBot) return;
            var line = Colorize($"{Tag} {Config.WelcomeMessage}");
            AddTimer(Math.Max(1, Config.WelcomeDelay), () =>
            {
                if (p.IsValid && !p.IsBot) p.PrintToChat(line);
            });
        });

        // If this is a hot reload (or the server was already up before the
        // plugin loaded), there's no upcoming OnMapStart event to arm us —
        // do it now so we don't sit dead until the next map change.
        if (hotReload) ArmEndOfMapTrigger();
    }

    private ModeEntry? ResolveActiveModeFromEnv()
    {
        if (Config.Modes.Count == 0) return null;
        var key = Environment.GetEnvironmentVariable("GAMECTL_CS2_MODE");
        if (string.IsNullOrWhiteSpace(key)) return Config.Modes[0];
        var needle = key.Trim().ToLowerInvariant();
        // Catalog convention: mode "key" → cfg "<key>.cfg" (surf → surf.cfg).
        var byCfg = Config.Modes.FirstOrDefault(m =>
            string.Equals(m.Cfg, needle + ".cfg", StringComparison.OrdinalIgnoreCase));
        if (byCfg is not null) return byCfg;
        // Fallback: fuzzy name contains the key.
        var byName = Config.Modes.FirstOrDefault(m =>
            m.Name.ToLowerInvariant().Contains(needle));
        return byName ?? Config.Modes[0];
    }

    // ActiveMode resolves the *current* mode dynamically at command time so
    // !maps / !map / end-of-map vote stay in sync even when the mode was
    // changed outside our plugin (GameModeManager !gamemode, RCON exec,
    // changelevel to a workshop ID, etc).
    //
    // Resolution order:
    //   1. css_gamemode string cvar (every mode cfg sets this to the
    //      display name) → catalog Name match. Most reliable.
    //   2. Server.MapName → first catalog mode whose pool contains the
    //      current map (by workshop id OR friendly name). Tie-breaker is
    //      catalog order which puts the "canonical" mode for shared maps
    //      (e.g. de_dust2 → Casual) first.
    //   3. Last-known _activeMode (set by our own ApplyAndReset).
    //   4. First catalog mode.
    private ModeEntry? ActiveMode()
    {
        if (Config.Modes.Count == 0) return null;
        // 1. css_gamemode cvar — set by each kus mode cfg.
        try
        {
            var gm = ConVar.Find("css_gamemode")?.StringValue;
            if (!string.IsNullOrWhiteSpace(gm))
            {
                var needle = gm.Trim().ToLowerInvariant();
                var byName = Config.Modes.FirstOrDefault(m =>
                    string.Equals(m.Name, gm.Trim(), StringComparison.OrdinalIgnoreCase) ||
                    m.Name.ToLowerInvariant().Contains(needle));
                if (byName is not null)
                {
                    _activeMode = byName;
                    return byName;
                }
            }
        }
        catch { /* cvar may not exist on every CSSharp build — fall through */ }
        // 2. Match the running map against each mode's pool. Server.MapName
        // for a workshop map is its INTERNAL bsp name (e.g. mini_mirage's
        // 3084978100 vpk reports as "minimirage_improved"), so a strict
        // string match against the catalog "mini_mirage" / id fails.
        // Normalize both sides to alphanumeric-lowercase and accept any
        // prefix overlap — "minimirage" ↔ "minimirageimproved" lines up.
        var cur = (Server.MapName ?? "").Trim();
        if (!string.IsNullOrEmpty(cur))
        {
            static string Norm(string s) =>
                new string(s.Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
            var curNorm = Norm(cur);
            var byMap = Config.Modes.FirstOrDefault(m =>
                (m.Maps ?? new()).Any(mp =>
                {
                    if (string.Equals(mp.Id,   cur, StringComparison.OrdinalIgnoreCase)) return true;
                    if (string.Equals(mp.Name, cur, StringComparison.OrdinalIgnoreCase)) return true;
                    var n = Norm(mp.Name);
                    if (n.Length >= 4 && (curNorm.StartsWith(n) || n.StartsWith(curNorm))) return true;
                    return false;
                }));
            if (byMap is not null)
            {
                _activeMode = byMap;
                return byMap;
            }
        }
        return _activeMode ?? Config.Modes[0];
    }

    private void CommandVoteMap(CCSPlayerController? player, CommandInfo command)
    {
        // Console invocation (player == null) is allowed too.
        if (player is not null && player.IsValid && !player.IsBot
            && !AdminManager.PlayerHasPermissions(player, "@css/root"))
        {
            Reply(player, "Admin only.");
            return;
        }
        StartEndOfMapVote();
    }

    private void CommandHelp(CCSPlayerController? player, CommandInfo command)
    {
        if (player is null || !player.IsValid || player.IsBot) return;
        if (Config.Help.Count == 0)
        {
            Reply(player, "No help has been configured for this server.");
            return;
        }
        player.PrintToChat(Colorize($"{Tag} {{yellow}}Server commands{{default}}"));
        foreach (var h in Config.Help)
            player.PrintToChat(Colorize($"   {{green}}{h.Cmd}{{default}}  —  {h.Desc}"));
    }

    // -- commands -----------------------------------------------------------

    private void CommandRtv(CCSPlayerController? player, CommandInfo command)
    {
        if (player is null || !player.IsValid || player.IsBot) return;

        if (Config.Modes.Count == 0)
        {
            Reply(player, "RTV has no modes configured — tell the server admin.");
            return;
        }
        if (_phase != Phase.Idle)
        {
            Reply(player, "A vote is already in progress.");
            return;
        }
        if (!_rtvVoters.Add(player.SteamID))
        {
            Reply(player, "You already rocked the vote — type {yellow}!unrtv{default} to take it back.");
            return;
        }

        int humans = CountHumans();
        int needed = Math.Max(1, (int)Math.Ceiling(humans * Config.RtvPercentage / 100.0));
        Announce($"{Colorize($"{{yellow}}{player.PlayerName}{{default}}")} wants to rock the vote " +
                 $"({Colorize($"{{yellow}}{_rtvVoters.Count}{{default}}")}/{needed}).");

        if (_rtvVoters.Count >= needed)
            StartModeVote();
    }

    private void CommandUnRtv(CCSPlayerController? player, CommandInfo command)
    {
        if (player is null || !player.IsValid || player.IsBot) return;
        if (_phase != Phase.Idle) { Reply(player, "Too late — the vote has already started."); return; }
        if (_rtvVoters.Remove(player.SteamID))
            Announce($"{Colorize($"{{yellow}}{player.PlayerName}{{default}}")} took back their rock-the-vote " +
                     $"({_rtvVoters.Count} remaining).");
        else
            Reply(player, "You haven't rocked the vote.");
    }

    // -- !modes / !maps (cache-aware replacements for GameModeManager) -----

    // Admin-only direct mode switch via a private CenterHtmlMenu. Mirrors
    // the !maps shape — no broadcast, no vote, no server-wide menu pop.
    // Players who want to vote a mode should use !rtv instead (that's the
    // only command in this plugin that's intentionally visible to all).
    private void CommandModes(CCSPlayerController? player, CommandInfo command)
    {
        if (player is null || !player.IsValid || player.IsBot) return;
        if (!AdminManager.PlayerHasPermissions(player, "@css/admin"))
        {
            Reply(player, "!modes is admin-only. Type \x04!rtv\x01 to vote a mode + map instead.");
            return;
        }
        if (_phase != Phase.Idle)
        {
            Reply(player, "A vote is already in progress.");
            return;
        }

        var modes = Config.Modes.Where(m => CachedMaps(m).Count > 0).ToList();
        if (modes.Count == 0)
        {
            Reply(player, "No modes with cached maps available.");
            return;
        }

        // Optional <query> argument — fuzzy-match against mode names
        // (alphanumeric-normalized, so "1v1 arenas" / "1v1arenas" /
        // "arenas" all hit the same entry, which fixes mode names with
        // spaces). NO swap on no-match: just list available modes so the
        // admin can correct their typo.
        var query = (command.ArgString ?? "").Trim();
        if (query.Length > 0)
        {
            static string NormM(string s) =>
                new string((s ?? "").Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
            var qN = NormM(query);
            var matches = modes.Where(m =>
            {
                if ((m.Name ?? "").ToLowerInvariant().Contains(query.ToLowerInvariant())) return true;
                if (NormM(m.Name).Contains(qN)) return true;
                if ((m.Cfg ?? "").ToLowerInvariant().Replace(".cfg","").Contains(query.ToLowerInvariant())) return true;
                return false;
            }).ToList();
            if (matches.Count == 0)
            {
                Reply(player, $"No mode matched \"\x04{query}\x01\". Available:");
                var preview = modes.Take(8).Select(m => m.Name).ToList();
                Reply(player, "  " + string.Join("  ·  ", preview) + (modes.Count > preview.Count ? "  …" : ""));
                Reply(player, $"({modes.Count} total — type \x04!modes\x01 with no argument for the picker.)");
                return;
            }
            if (matches.Count == 1)
            {
                var only = matches[0];
                var firstMap = CachedMaps(only)[0];
                Announce($"Admin {Colorize($"{{yellow}}{player.PlayerName}{{default}}")} switching to " +
                         $"{Colorize($"{{yellow}}{only.Name}{{default}}")} on " +
                         $"{Colorize($"{{yellow}}{firstMap.Name}{{default}}")}…");
                ApplyAndReset(only, firstMap);
                return;
            }
            // Multiple matches — narrow the picker to just those.
            modes = matches;
        }

        if (modes.Count == 1)
        {
            var only = modes[0];
            var firstMap = CachedMaps(only)[0];
            Announce($"Admin {Colorize($"{{yellow}}{player.PlayerName}{{default}}")} switching to " +
                     $"{Colorize($"{{yellow}}{only.Name}{{default}}")} on " +
                     $"{Colorize($"{{yellow}}{firstMap.Name}{{default}}")}…");
            ApplyAndReset(only, firstMap);
            return;
        }

        OpenAdminModeSwapMenu(player, modes, "Pick a game mode (admin)");
    }

    // Private admin menu for the !modes picker — on selection swap mode +
    // jump to the first cached map of that mode, single broadcast line on
    // pick. No vote phase, no server-wide menu.
    private void OpenAdminModeSwapMenu(CCSPlayerController admin, List<ModeEntry> modes, string title)
    {
        var menu = new CenterHtmlMenu(title, this) { ExitButton = true };
        foreach (var m in modes)
        {
            var mode = m; // capture for closure
            menu.AddMenuOption(mode.Name, (p, _) =>
            {
                if (p is null || !p.IsValid) return;
                if (!AdminManager.PlayerHasPermissions(p, "@css/admin")) return;
                MenuManager.CloseActiveMenu(p);
                var cached = CachedMaps(mode);
                if (cached.Count == 0)
                {
                    Reply(p, $"Mode \x04{mode.Name}\x01 has no cached maps.");
                    return;
                }
                var firstMap = cached[0];
                Announce($"Admin {Colorize($"{{yellow}}{p.PlayerName}{{default}}")} switching to " +
                         $"{Colorize($"{{yellow}}{mode.Name}{{default}}")} on " +
                         $"{Colorize($"{{yellow}}{firstMap.Name}{{default}}")}…");
                ApplyAndReset(mode, firstMap);
            });
        }
        OpenWithPageSize(admin, menu, 8);
        Reply(admin, "Pick a mode — selection swaps immediately. \x04!rtv\x01 if you want a server vote instead.");
    }

    // !maps — admin-only one-shot map swap within the CURRENT mode. The
    // admin sees a private menu of the active mode's cached maps; on pick
    // the server switches immediately, no vote. Common players have !rtv
    // for the vote-driven path (mode → map two-stage).
    // !mode <name> — find the mode in our catalog, exec its cfg, and
    // changelevel to the first cached map of that mode's pool. The kus
    // GameModeManager !mode handler runs in parallel and exec's the
    // cfg too — harmless double-exec. This handler adds the missing
    // changelevel so the loaded map matches the new mode.
    private void CommandModeSwitch(CCSPlayerController? player, CommandInfo command)
    {
        if (player is not null && (!player.IsValid || player.IsBot)) return;
        if (player is not null && !AdminManager.PlayerHasPermissions(player, "@css/admin"))
        {
            Reply(player, "!mode is admin-only. Try \x04!rtv\x01 to vote.");
            return;
        }
        var raw = (command.ArgString ?? "").Trim();
        if (raw.Length == 0)
        {
            Reply(player, "Usage: !mode <name> — e.g. !mode competitive, !mode aim");
            return;
        }
        // Match by mode Name (substring, case-insensitive) or by cfg name
        // (mode "competitive" -> "comp.cfg", strip ".cfg" + match base).
        static string Norm(string s) =>
            new string((s ?? "").Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
        var q = Norm(raw);
        var mode = Config.Modes.FirstOrDefault(m =>
            Norm(m.Name).Contains(q) ||
            Norm((m.Cfg ?? "").Replace(".cfg", "")).Contains(q));
        if (mode is null)
        {
            // No-op on typo — never attempt a swap. Show available
            // mode names so the user can correct.
            Reply(player, $"No catalog mode matched \"\x04{raw}\x01\". Available:");
            var preview = Config.Modes.Take(8).Select(m => m.Name).ToList();
            Reply(player, "  " + string.Join("  ·  ", preview) + (Config.Modes.Count > preview.Count ? "  …" : ""));
            Reply(player, $"({Config.Modes.Count} total — type \x04!modes\x01 for the vote menu, or \x04!modes <query>\x01 to fuzzy-search.)");
            return;
        }
        var cached = CachedMaps(mode);
        if (cached.Count == 0)
        {
            Reply(player, $"Mode \x04{mode.Name}\x01 has no cached maps — operator needs to download them.");
            return;
        }
        var first = cached[0];
        Announce($"Admin {Colorize($"{{yellow}}{player?.PlayerName ?? "Server"}{{default}}")} switching to " +
                 $"{Colorize($"{{yellow}}{mode.Name}{{default}}")} on " +
                 $"{Colorize($"{{yellow}}{first.Name}{{default}}")}…");
        ApplyAndReset(mode, first);
    }

    private void CommandMaps(CCSPlayerController? player, CommandInfo command)
    {
        if (player is null || !player.IsValid || player.IsBot) return;
        if (!AdminManager.PlayerHasPermissions(player, "@css/admin"))
        {
            Reply(player, "!maps is admin-only. Type \x04!rtv\x01 to vote a mode + map instead.");
            return;
        }
        if (_phase != Phase.Idle)
        {
            Reply(player, "A vote is already in progress.");
            return;
        }
        var mode = ActiveMode();
        if (mode is null)
        {
            Reply(player, "No modes configured.");
            return;
        }
        var cached = CachedMaps(mode);
        if (cached.Count == 0)
        {
            Reply(player, $"No cached maps for {mode.Name}.");
            return;
        }
        if (cached.Count == 1)
        {
            Announce($"Only one cached map for {Colorize($"{{yellow}}{mode.Name}{{default}}")} — switching to {Colorize($"{{yellow}}{cached[0].Name}{{default}}")}…");
            ApplyAndReset(mode, cached[0]);
            return;
        }
        OpenAdminSwapMenu(player, mode, cached,
            $"{mode.Name} &mdash; pick a map (admin)");
    }

    // !map <query> — admin-only filtered swap. Same idea as !maps but with
    // a substring filter so typing "!map skeet" narrows a long pool to a
    // few clickable options. Still a one-shot swap, no vote.
    private void CommandMapSearch(CCSPlayerController? player, CommandInfo command)
    {
        if (player is null || !player.IsValid || player.IsBot) return;
        if (!AdminManager.PlayerHasPermissions(player, "@css/admin"))
        {
            Reply(player, "!map is admin-only. Type \x04!rtv\x01 to vote a mode + map instead.");
            return;
        }
        if (_phase != Phase.Idle)
        {
            Reply(player, "A vote is already in progress.");
            return;
        }
        var query = (command.ArgString ?? "").Trim();
        if (query.Length == 0)
        {
            Reply(player, "Usage: !map <substring> — e.g. !map skeet, !map mirage");
            return;
        }
        var q = query.ToLowerInvariant();

        var mode = ActiveMode();
        if (mode is null)
        {
            Reply(player, "No modes configured.");
            return;
        }
        var cached = CachedMaps(mode);
        if (cached.Count == 0)
        {
            Reply(player, $"No cached maps for {mode.Name}.");
            return;
        }
        // Normalize both sides to alphanumeric-lowercase so that
        // "mini dust2", "mini_dust2", "MiniDust2", "minidust" all
        // match a catalog entry named "mini_dust2". User-reported bug:
        // typing the BSP name without underscores (or with spaces)
        // wasn't matching the catalog's snake_case names.
        static string Norm(string s) =>
            new string((s ?? "").Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
        var qNorm = Norm(query);
        var matches = cached.Where(m =>
        {
            var raw   = (m.Name ?? "").ToLowerInvariant();
            var rawId = (m.Id   ?? "").ToLowerInvariant();
            if (raw.Contains(q) || rawId.Contains(q)) return true;
            // Normalized fallback: strip underscores/spaces from both.
            var nm  = Norm(m.Name ?? "");
            if (nm.Contains(qNorm)) return true;
            return false;
        }).ToList();
        if (matches.Count == 0)
        {
            // Explicit no-op: we do NOT call ApplyAndReset / changelevel
            // on a typo. The kus GameModeManager's !map handler may run
            // alongside us and try literal-changelevel which can freeze
            // players on an invalid map — we can't unregister theirs,
            // but we'll at least tell the user what would have worked.
            Reply(player, $"No cached maps in \x04{mode.Name}\x01 match \"\x04{query}\x01\". Try one of:");
            var preview = cached.Take(6).Select(m => m.Name).ToList();
            Reply(player, "  " + string.Join("  ·  ", preview) + (cached.Count > preview.Count ? "  …" : ""));
            Reply(player, $"({cached.Count} total — see \x04!maps\x01 for the full pool.)");
            return;
        }
        if (matches.Count == 1)
        {
            var only = matches[0];
            Announce($"Admin {Colorize($"{{yellow}}{player.PlayerName}{{default}}")} switching to " +
                     $"{Colorize($"{{yellow}}{only.Name}{{default}}")} ({mode.Name})…");
            ApplyAndReset(mode, only);
            return;
        }
        const int MAX_MATCHES = 12;
        if (matches.Count > MAX_MATCHES)
        {
            Reply(player, $"{matches.Count} matches — showing first {MAX_MATCHES}. Narrow the query for finer picks.");
            matches = matches.Take(MAX_MATCHES).ToList();
        }
        OpenAdminSwapMenu(player, mode, matches,
            $"{mode.Name} &mdash; \"{query}\" ({matches.Count} matches)");
    }

    // Suppress kus GameModeManager's destructive blind-changelevel on a
    // bad !map arg. Empty arg → fall through (our handler prints usage).
    // Argued no-match → chat-notify the caller + Stop (kus never runs).
    // Match → Continue (both handlers run as before).
    private HookResult PreMapListener(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid || player.IsBot) return HookResult.Continue;
        var raw = (info.ArgString ?? "").Trim().Trim('"');
        if (raw.Length == 0) return HookResult.Continue;
        var mode = ActiveMode();
        if (mode is null) return HookResult.Continue;
        var cached = CachedMaps(mode);
        if (cached.Count == 0) return HookResult.Continue;

        static string Norm(string s) =>
            new string((s ?? "").Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
        var q = raw.ToLowerInvariant();
        var qNorm = Norm(raw);
        bool any = cached.Any(m =>
        {
            var name = (m.Name ?? "").ToLowerInvariant();
            var id   = (m.Id   ?? "").ToLowerInvariant();
            if (name.Contains(q) || id.Contains(q)) return true;
            if (Norm(m.Name ?? "").Contains(qNorm)) return true;
            return false;
        });
        if (!any)
        {
            Reply(player, $"No cached maps in \x04{mode.Name}\x01 match \"\x04{raw}\x01\" — type \x04!maps\x01 for the picker.");
            return HookResult.Stop;
        }
        return HookResult.Continue;
    }

    // Same shape for !mode. Validates against the full catalog (not just
    // the active mode) since !mode is for switching to a *different* mode.
    private HookResult PreModeListener(CCSPlayerController? player, CommandInfo info)
    {
        if (player is null || !player.IsValid || player.IsBot) return HookResult.Continue;
        var raw = (info.ArgString ?? "").Trim().Trim('"');
        if (raw.Length == 0) return HookResult.Continue;

        static string Norm(string s) =>
            new string((s ?? "").Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
        var q = Norm(raw);
        bool any = Config.Modes.Any(m =>
            Norm(m.Name ?? "").Contains(q) ||
            Norm((m.Cfg ?? "").Replace(".cfg", "")).Contains(q));
        if (!any)
        {
            Reply(player, $"No catalog mode matched \"\x04{raw}\x01\" — type \x04!modes\x01 for the picker.");
            return HookResult.Stop;
        }
        return HookResult.Continue;
    }

    // Open a private menu just for the admin caller — on selection switch
    // immediately. No vote, no ballot, no broadcast except a one-line
    // "Admin X switched to Y" once the pick lands.
    private void OpenAdminSwapMenu(CCSPlayerController admin, ModeEntry mode, List<MapEntry> options, string title)
    {
        var menu = new CenterHtmlMenu(title, this) { ExitButton = true };
        for (int i = 0; i < options.Count; i++)
        {
            var map = options[i]; // capture for the closure
            menu.AddMenuOption(map.Name, (p, _) =>
            {
                if (p is null || !p.IsValid) return;
                if (!AdminManager.PlayerHasPermissions(p, "@css/admin")) return;
                MenuManager.CloseActiveMenu(p);
                Announce($"Admin {Colorize($"{{yellow}}{p.PlayerName}{{default}}")} switching to " +
                         $"{Colorize($"{{yellow}}{map.Name}{{default}}")} ({mode.Name})…");
                ApplyAndReset(mode, map);
            });
        }
        OpenWithPageSize(admin, menu, 8);
        Reply(admin, $"Pick a map for {Colorize($"{{yellow}}{mode.Name}{{default}}")} — selection swaps immediately.");
    }

    // Shared single-stage map-vote launcher used by both !maps and the
    // end-of-map auto-vote. Caller has already validated cached.Count >= 2.
    private void StartMapVoteForMode(ModeEntry mode, List<MapEntry> cached, int duration, string announcement, string menuTitle)
    {
        _phase = Phase.MapVote;
        _chosenMode = mode;
        _voteMaps = cached;
        _ballots.Clear();
        _optionLabels = _voteMaps.Select(m => m.Name).ToList();

        Announce(announcement);
        foreach (var p in GetHumans())
            OpenVoteMenu(p, menuTitle, _optionLabels);

        _voteTimer?.Kill();
        _voteTimer = AddTimer(Math.Max(5, duration), FinishMapVote);
    }

    // -- stage 1: mode vote -------------------------------------------------

    private void StartModeVote()
    {
        _phase = Phase.ModeVote;
        _ballots.Clear();
        // Only offer modes that have at least one cached map — otherwise the
        // mode would just dead-end the vote with nothing to switch to.
        _voteModes = Config.Modes.Where(m => CachedMaps(m).Count > 0).ToList();
        if (_voteModes.Count == 0)
        {
            Announce("No modes with cached maps available — staying on current map.");
            ResetAll();
            return;
        }
        _optionLabels = _voteModes.Select(m => m.Name).ToList();
        Announce($"Vote passed — {Colorize("{yellow}pick a game mode{default}")}! " +
                 $"({Config.ModeVoteDuration}s)");

        foreach (var p in GetHumans())
            OpenVoteMenu(p, "Rock the Vote &mdash; Game Mode", _optionLabels);

        _voteTimer?.Kill();
        _voteTimer = AddTimer(Config.ModeVoteDuration, FinishModeVote);
    }

    private void FinishModeVote()
    {
        if (_phase != Phase.ModeVote) return;
        CloseAllMenus();

        int winner = TallyWinner(_voteModes.Count);
        _chosenMode = _voteModes[winner];
        Announce($"Game mode: {Colorize($"{{yellow}}{_chosenMode.Name}{{default}}")} " +
                 $"({DescribeTally(winner)}).");

        StartMapVote();
    }

    // -- stage 2: map vote --------------------------------------------------

    private void StartMapVote()
    {
        if (_chosenMode is null)
        {
            ApplyAndReset(null, null);
            return;
        }
        // Filter to cached maps only — the server can't switch to workshop
        // maps that haven't finished downloading at boot (host_workshop_map
        // is no-op for uncached on this image).
        _voteMaps = CachedMaps(_chosenMode);
        if (_voteMaps.Count == 0)
        {
            Announce($"No cached maps for {_chosenMode.Name} — staying on current map.");
            ResetAll();
            return;
        }
        if (_voteMaps.Count == 1)
        {
            ApplyAndReset(_chosenMode, _voteMaps[0]);
            return;
        }

        _phase = Phase.MapVote;
        _ballots.Clear();
        _optionLabels = _voteMaps.Select(m => m.Name).ToList();
        Announce($"Now {Colorize("{yellow}pick a map{default}")} for " +
                 $"{Colorize($"{{yellow}}{_chosenMode.Name}{{default}}")}! ({Config.MapVoteDuration}s)");

        foreach (var p in GetHumans())
            OpenVoteMenu(p, $"Rock the Vote &mdash; {_chosenMode.Name} Map", _optionLabels);

        _voteTimer?.Kill();
        _voteTimer = AddTimer(Config.MapVoteDuration, FinishMapVote);
    }

    private void FinishMapVote()
    {
        if (_phase != Phase.MapVote || _chosenMode is null) return;
        CloseAllMenus();

        int winner = TallyWinner(_voteMaps.Count);
        var map = _voteMaps[winner];
        Announce($"Winner: {Colorize($"{{yellow}}{_chosenMode.Name}{{default}} / {{yellow}}{map.Name}{{default}}")} " +
                 $"({DescribeTally(winner)}) — switching…");

        ApplyAndReset(_chosenMode, map);
    }

    // -- apply --------------------------------------------------------------

    private void ApplyAndReset(ModeEntry? mode, MapEntry? map)
    {
        _phase = Phase.Idle;
        _voteTimer?.Kill();
        _voteTimer = null;

        if (mode is not null)
        {
            // Track the new mode so the next map's end-of-map vote scopes
            // to its catalog.
            _activeMode = mode;
            if (!string.IsNullOrWhiteSpace(mode.Cfg))
                Server.ExecuteCommand($"exec {mode.Cfg}");
        }

        if (map is not null && !string.IsNullOrWhiteSpace(map.Id))
        {
            string cmd = map.Workshop
                ? $"host_workshop_map {map.Id}"
                : $"changelevel {map.Id}";
            // Give the mode cfg a moment to load its plugins before the level
            // change. The level change itself fires OnMapStart -> ResetAll.
            AddTimer(Math.Max(1, Config.ChangeDelay), () => Server.ExecuteCommand(cmd));
        }
        else
        {
            ResetAll();
        }
    }

    // -- voting plumbing ----------------------------------------------------

    private void OpenVoteMenu(CCSPlayerController player, string title, IReadOnlyList<string> options)
    {
        var menu = new CenterHtmlMenu(title, this) { ExitButton = false };
        for (int i = 0; i < options.Count; i++)
        {
            int idx = i;
            menu.AddMenuOption(options[i], (p, _) => CastBallot(p, idx));
        }
        OpenWithPageSize(player, menu, 8);
    }

    // CenterHtmlMenu's per-page count is on the runtime INSTANCE
    // (BaseMenuInstance.NumPerPage) but its setter is private — the API
    // hardcodes 6 per page. Reflect onto the auto-property backing field
    // so long surf/bhop pools don't need 8 pages to scroll. If the field
    // name ever changes upstream this silently no-ops (still functional,
    // just stuck at the default 6 — no crash).
    private static FieldInfo? _numPerPageField;
    private void OpenWithPageSize(CCSPlayerController player, CenterHtmlMenu menu, int perPage)
    {
        MenuManager.OpenCenterHtmlMenu(this, player, menu);
        var inst = MenuManager.GetActiveMenu(player);
        if (inst is BaseMenuInstance bmi)
        {
            _numPerPageField ??= typeof(BaseMenuInstance).GetField(
                "<NumPerPage>k__BackingField",
                BindingFlags.Instance | BindingFlags.NonPublic);
            try { _numPerPageField?.SetValue(bmi, perPage); } catch { /* fall back to default */ }
        }
    }

    private void CastBallot(CCSPlayerController? player, int idx)
    {
        if (player is null || !player.IsValid || player.IsBot) return;
        if (_phase is not (Phase.ModeVote or Phase.MapVote or Phase.ModeOnlyVote)) return;

        _ballots[player.SteamID] = idx;
        string label = idx >= 0 && idx < _optionLabels.Count ? _optionLabels[idx] : "?";
        Reply(player, $"You voted {Colorize($"{{yellow}}{label}{{default}}")}.");
        MenuManager.CloseActiveMenu(player);
    }

    // Index of the option with the most ballots. Ties (and the no-votes case)
    // are broken at random, so an empty vote still resolves to a real pick.
    private int TallyWinner(int optionCount)
    {
        if (optionCount <= 0) return 0;
        var counts = new int[optionCount];
        foreach (var choice in _ballots.Values)
            if (choice >= 0 && choice < optionCount)
                counts[choice]++;

        int max = counts.Max();
        var leaders = Enumerable.Range(0, optionCount).Where(i => counts[i] == max).ToList();
        return leaders[Random.Shared.Next(leaders.Count)];
    }

    private string DescribeTally(int winnerIdx)
    {
        int total = _ballots.Count;
        if (total == 0) return "no votes — picked at random";
        int got = _ballots.Values.Count(v => v == winnerIdx);
        return $"{got}/{total} votes";
    }

    // -- end-of-map auto vote ----------------------------------------------

    // Read mp_timelimit / mp_maxrounds and schedule the end-of-map vote.
    // Called from OnMapStart (and on hot-reload). Always clears any prior
    // arm first so we never double-fire across map changes.
    private void ArmEndOfMapTrigger()
    {
        _endOfMapTimer?.Kill();
        _endOfMapTimer = null;
        _roundsPlayed = 0;
        _maxRoundsTrigger = 0;
        _endOfMapFired = false;

        if (!Config.EndOfMapVoteEnabled) return;

        float timeLimitMin = ConVar.Find("mp_timelimit")?.GetPrimitiveValue<float>() ?? 0f;
        int   maxRounds    = ConVar.Find("mp_maxrounds")?.GetPrimitiveValue<int>()   ?? 0;

        if (timeLimitMin > 0f)
        {
            float secondsBefore = Math.Max(5, Config.EndOfMapSecondsBefore);
            float fireAt = timeLimitMin * 60f - secondsBefore;
            if (fireAt > 0f)
            {
                _endOfMapTimer = AddTimer(fireAt, () =>
                {
                    if (_endOfMapFired) return;
                    _endOfMapFired = true;
                    StartEndOfMapVote();
                });
            }
        }

        if (maxRounds > 0)
        {
            int trigger = maxRounds - Math.Max(0, Config.EndOfMapRoundsBefore);
            if (trigger < 1) trigger = 1;
            _maxRoundsTrigger = trigger;
        }
    }

    // Single-stage vote across the active mode's cached maps. Skips itself
    // cleanly if a !rtv flow is already running, or if the active mode has
    // no cached maps to switch to.
    private void StartEndOfMapVote()
    {
        if (!Config.EndOfMapVoteEnabled) return;
        if (_phase != Phase.Idle) return;

        // If we never resolved an active mode (or hot-reloaded into an
        // unconfigured state), fall back to the first catalog mode.
        var mode = ActiveMode();
        if (mode is null)
        {
            Announce("End-of-map vote: no modes configured — staying on current map.");
            return;
        }

        var cached = CachedMaps(mode);
        if (cached.Count == 0)
        {
            Announce($"End-of-map vote: no cached maps for {Colorize($"{{yellow}}{mode.Name}{{default}}")} — staying.");
            return;
        }
        if (cached.Count == 1)
        {
            Announce($"End-of-map vote: only one cached map for {Colorize($"{{yellow}}{mode.Name}{{default}}")} — switching to {Colorize($"{{yellow}}{cached[0].Name}{{default}}")}…");
            ApplyAndReset(mode, cached[0]);
            return;
        }

        int duration = Math.Max(5, Config.EndOfMapVoteDuration);
        StartMapVoteForMode(mode, cached, duration,
            $"Map ending — {Colorize("{yellow}pick the next map{default}")} for " +
            $"{Colorize($"{{yellow}}{mode.Name}{{default}}")}! ({duration}s)",
            $"End of Map &mdash; {mode.Name}");
    }

    // -- helpers ------------------------------------------------------------

    private void ResetAll()
    {
        _phase = Phase.Idle;
        _rtvVoters.Clear();
        _ballots.Clear();
        _optionLabels = new();
        _voteModes = new();
        _voteMaps = new();
        _chosenMode = null;
        _voteTimer?.Kill();
        _voteTimer = null;
        // Note: end-of-map state is NOT reset here — it's owned by
        // ArmEndOfMapTrigger / the OnMapStart hook so it can survive the
        // ResetAll that fires when a !rtv finishes mid-map.
    }

    private static List<CCSPlayerController> GetHumans() =>
        Utilities.GetPlayers()
            .Where(p => p is { IsValid: true, IsBot: false, IsHLTV: false })
            .ToList();

    private static int CountHumans() => GetHumans().Count;

    private static void CloseAllMenus()
    {
        foreach (var p in GetHumans())
            MenuManager.CloseActiveMenu(p);
    }

    private void Announce(string msg) => Server.PrintToChatAll(Colorize(Tag) + " " + msg);

    private static void Reply(CCSPlayerController player, string msg) =>
        player.PrintToChat(Colorize(Tag) + " " + Colorize(msg));

    // Translates {green}/{yellow}/{default} tokens to CSSharp chat colors so
    // message strings stay readable.
    private static string Colorize(string s) => s
        .Replace("{green}", ChatColors.Green.ToString())
        .Replace("{yellow}", ChatColors.Yellow.ToString())
        .Replace("{default}", ChatColors.Default.ToString());
}
