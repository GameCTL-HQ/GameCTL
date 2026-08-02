using System.Text.Json;
using System.Text.Json.Serialization;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Cvars;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;

namespace GameCtlDmRounds;

// GameCtlDmRounds — replaces the kus Deathmatch.dll round-rotation feature
// (pistols → SMGs → snipers → rifles → shotguns → repeat) for the DM mode.
//
// The kus plugin's OnWeaponCanAcquire hook is broken on the current CS2
// build (NativeException: Invalid function pointer). This plugin avoids
// that whole virtual-function-hook surface entirely:
//
//   1. A simple AddTimer rotates _currentRound every ROUND_SECONDS.
//   2. On rotation, we walk every alive player (bots + humans), strip
//      their weapons, and GiveNamedItem the round's primary. Knife stays.
//   3. EventPlayerSpawn fires the same equip path so fresh respawns also
//      land with the round weapon.
//   4. Chat is the announcement surface — center-HUD rendering was where
//      the kus plugin tripped on hook breakage; chat is plain text and
//      can't fail.
//
// No virtual hooks, no native function pointers, no fragile API surface
// — just timers + spawn events + GiveNamedItem. The plugin is loaded
// explicitly by custom_deathmatch.cfg and unloaded by unload_plugins.cfg.

public sealed class GameCtlDmRounds : BasePlugin
{
    public override string ModuleName    => "GameCtl DM Rounds";
    public override string ModuleVersion => "1.0.0";
    public override string ModuleAuthor  => "GameCTL";
    public override string ModuleDescription =>
        "Server-wide weapon-rotation rounds for vanilla CS2 deathmatch.";

    // ── tunables ─────────────────────────────────────────────────────────

    // Seconds per round. 90 = a fast cycle so players see every category
    // in a 5-minute play session. Knock it up if rounds feel rushed.
    private const float ROUND_SECONDS = 90f;

    // IsPistol distinguishes secondary-slot weapons so we can target the
    // right *_default_secondary vs *_default_primary cvar on rotation.
    private sealed record WeaponRound(string Name, string Weapon, bool IsPistol, string Color);

    // The pool. Color is the chat \xNN code for the announcement.
    //   \x04 light green | \x06 lime | \x07 red | \x09 sky | \x10 grey
    private static readonly WeaponRound[] Rounds = new[]
    {
        new WeaponRound("Pistols (Deagle)",     "weapon_deagle",         true,  "\x06"),
        new WeaponRound("Pistols (USP-S)",      "weapon_usp_silencer",   true,  "\x06"),
        new WeaponRound("SMGs (MP9)",           "weapon_mp9",            false, "\x09"),
        new WeaponRound("SMGs (MAC-10)",        "weapon_mac10",          false, "\x09"),
        new WeaponRound("Shotguns (XM1014)",    "weapon_xm1014",         false, "\x07"),
        new WeaponRound("Snipers (Scout)",      "weapon_ssg08",          false, "\x04"),
        new WeaponRound("Snipers (AWP)",        "weapon_awp",            false, "\x04"),
        new WeaponRound("Rifles (AK-47)",       "weapon_ak47",           false, "\x10"),
        new WeaponRound("Rifles (M4A4)",        "weapon_m4a1",           false, "\x10"),
        new WeaponRound("Rifles (FAMAS/Galil)", "weapon_famas",          false, "\x10"),
        new WeaponRound("Auto-snipers (SCAR)",  "weapon_scar20",         false, "\x04"),
    };

    private int _round;
    private CounterStrikeSharp.API.Modules.Timers.Timer? _timer;
    // When the next rotation will fire, so !round can report time-left.
    private DateTime _nextRotationAt = DateTime.UtcNow;

    // Zombie mode: bots-with-knives swarm vs human shotguns. When on,
    // the weapon rotation is paused; OnPlayerSpawn equips per-role
    // (bots=knife, humans=xm1014) on every respawn.
    private bool _zombieMode = false;

    // True only when the live game_mode is 2 (Deathmatch). Used to gate
    // the weapon-rotation feature so the plugin can also be loaded in
    // Casual (where the operator wants !zombiemode for bigger team caps)
    // WITHOUT triggering DM-style weapon rotations every 90s on a
    // bomb-defusal round.
    private static bool IsDmMode() =>
        ConVar.Find("game_mode")?.GetPrimitiveValue<int>() == 2;
    // Negev: ~150-round LMG, slow but devastating against the horde.
    private const string HUMAN_ZOMBIE_WEAPON = "weapon_xm1014";
    // Where the per-player zombie PB records live. Same disk pattern as
    // the surf records — NFS PVC root so values survive pod restart.
    private const string ZOMBIE_RECORDS_PATH = "/home/steam/cs2/gamectl_zombie_records.json";

    // Zombie SURVIVAL round state (the lifecycle nested inside zombie
    // mode): one-life-per-human, last-survivor-wins. _zombieMode just
    // means "the mode is selected" — _zombieRoundActive means "a survival
    // round is currently in progress, deaths count".
    private bool _zombieRoundActive = false;
    private readonly HashSet<ulong> _zombieAlive = new();
    private readonly Dictionary<ulong, int> _zombieKills = new();
    private ZombieRecordsFile _zombieRecords = new();
    private readonly object _zombieRecordsLock = new();

    public sealed class ZombieRecord
    {
        [JsonPropertyName("name")]                     public string Name { get; set; } = "";
        [JsonPropertyName("best_survive_ms")]          public long   BestSurviveMs { get; set; }
        [JsonPropertyName("best_kills")]               public int    BestKills { get; set; }
        [JsonPropertyName("best_survive_finished_at")] public string BestSurviveFinishedAt { get; set; } = "";
        [JsonPropertyName("best_kills_finished_at")]   public string BestKillsFinishedAt { get; set; } = "";
    }
    public sealed class ZombieRecordsFile
    {
        [JsonPropertyName("version")] public int Version { get; set; } = 1;
        // steamid64 (string) → record
        [JsonPropertyName("records")] public Dictionary<string, ZombieRecord> Records { get; set; } = new();
    }
    // Stuck-bot nudge: CS2's bot nav mesh doesn't cover the top of
    // crates / vents / beams, so when a CT climbs up there, T-bots
    // pathfind to the base and give up. We detect bots that have been
    // stationary on the ground for >2s while humans are alive, then
    // give them a velocity nudge horizontally toward the nearest human
    // + an upward kick (an artificial jump) — combined with their 0.5
    // GravityScale this gets them onto most perches within a few hops.
    // Per-bot map: steamid → time we first noticed them stationary.
    private readonly Dictionary<ulong, DateTime> _botStuckSince = new();
    // Cached RNG for the random-hop chaos path. One per plugin instance
    // (Random isn't thread-safe — we only ever call it from the
    // watchdog tick which runs on the game thread).
    private readonly Random _nudgeRng = new();

    // When each human died (DateTime). Recorded on death so we can
    // print per-player survive times at round end.
    private readonly Dictionary<ulong, DateTime> _zombieDeathAt = new();
    // Cached display names per steamid — survives the controller being
    // gone by the time we print results (e.g. they disconnected).
    private readonly Dictionary<ulong, string> _zombieNames = new();
    private DateTime _zombieRoundStartedAt;
    private static readonly string[] ZombieNades = {
        "weapon_hegrenade", "weapon_flashbang",
        "weapon_smokegrenade", "weapon_molotov",
    };

    // ── lifecycle ────────────────────────────────────────────────────────

    public override void Load(bool hotReload)
    {
        _round = new Random().Next(Rounds.Length);
        LoadZombieRecords();

        _timer = AddTimer(ROUND_SECONDS, AdvanceRound, TimerFlags.REPEAT);
        _nextRotationAt = DateTime.UtcNow.AddSeconds(ROUND_SECONDS);
        // Bot ActiveWeapon watchdog: every 1 second walk alive bots and
        // re-pin their ActiveWeapon to the round weapon if they've drifted
        // to knife. The bot AI on this build keeps re-selecting knife as
        // ActiveWeapon after a respawn or kill — 3s was too slow (~5% of
        // bots got caught knifing visibly); 1s closes the window enough
        // that you barely see it.
        AddTimer(1.0f, BotWeaponWatchdog, TimerFlags.REPEAT);
        // Zombie-mode team enforcement: every 1s while zombiemode is
        // active, kick any CT bots. bot_join_team t alone doesn't keep
        // refills on T (~30% still go CT). bot_quota_mode fill +
        // bot_join_team t will refill the kicked CT slots with fresh T
        // bots within seconds. A 1s tick catches new CT bots fast
        // enough that they're never alive long enough to matter.
        AddTimer(1.0f, BotTeamWatchdog, TimerFlags.REPEAT);
        // Hook player spawn so freshly-respawned bots + humans get the
        // round weapon. CS2's Valve DM (game_mode 2) does NOT honour
        // mp_t/ct_default_primary for spawn loadout (verified live —
        // cvars set, weapons not given) so we have to GiveNamedItem
        // each player ourselves.
        RegisterEventHandler<EventPlayerSpawn>(OnPlayerSpawn);
        // Death tracking for the zombie survival round.
        RegisterEventHandler<EventPlayerDeath>(OnPlayerDeath_Zombie);

        // Public info commands.
        AddCommand("css_round",   "Show current DM weapon round + time left", CommandRound);
        AddCommand("css_rounds",  "List all weapons in the DM rotation pool", CommandRounds);
        // Admin-only controls.
        AddCommand("css_nextround", "[admin] Skip to the next DM weapon round", CommandNextRound);
        AddCommand("css_setround",  "[admin] Jump to a specific round index (!setround 3)", CommandSetRound);
        AddCommand("css_botdiff",   "Set bot difficulty 0-3 (easy/normal/hard/expert)", CommandBotDiff);
        AddCommand("css_bots",      "Set bot quota (!bots 4) — up to 64",               CommandBots);
        AddCommand("css_zombiemode","Toggle zombie mode: knife-bot swarm vs human shotguns", CommandZombieMode);
        AddCommand("css_zpb",       "Your zombie-mode PB (best survive + best kills)", CommandZombiePB);
        AddCommand("css_zwr",       "Server-record zombie-mode survive time + kill count", CommandZombieWR);

        AnnounceRound();
        EquipAllAlive();

        Server.PrintToConsole("[GameCtlDmRounds] Loaded — rotation active.");
    }

    public override void Unload(bool hotReload)
    {
        _timer?.Kill();
        _timer = null;
    }

    // ── rotation ─────────────────────────────────────────────────────────

    private void AdvanceRound()
    {
        try
        {
            // Zombie mode pauses normal rotation — re-equip everyone for
            // their role on each tick instead so respawns / picked-up
            // weapons get scrubbed.
            if (_zombieMode)
            {
                _nextRotationAt = DateTime.UtcNow.AddSeconds(ROUND_SECONDS);
                EquipAllForZombieMode();
                return;
            }
            _round = (_round + 1) % Rounds.Length;
            _nextRotationAt = DateTime.UtcNow.AddSeconds(ROUND_SECONDS);
            Server.PrintToConsole($"[GameCtlDmRounds] AdvanceRound -> round {_round} = {Rounds[_round].Name}");
            AnnounceRound();
            EquipAllAlive();
        }
        catch (Exception e)
        {
            Server.PrintToConsole($"[GameCtlDmRounds] AdvanceRound EXCEPTION: {e.Message}\n{e.StackTrace}");
        }
    }

    private void AnnounceRound()
    {
        var r = Rounds[_round];
        // Plain chat (no fancy colour escapes) — \x06 etc. has been seen
        // get stripped or hidden on some CS2 builds and the player ends
        // up seeing nothing.
        var line = $"[DM] New round: {r.Name} - everyone respawns with it. Next in {(int)ROUND_SECONDS}s.";
        Server.PrintToConsole($"[GameCtlDmRounds] Announce: {line}");
        Server.PrintToChatAll(line);
    }

    // ApplyDefaultWeaponCvars sets CS2's per-team spawn-weapon cvars so
    // every fresh spawn — bot or human — comes up with the round weapon
    // out of the box. game_mode 2 honours these for FFA. Going through
    // the native spawn path side-steps the CSSharp GiveNamedItem
    // KeyNotFoundException that fires for bot slots on this CSSharp/CS2
    // combo.
    //
    // Pistols populate *_default_secondary (and we clear *_default_primary
    // so players actually run the pistol, not a rifle alongside it).
    // Non-pistols flip the inverse.

    // Force-respawn every alive non-spectator so they re-spawn with the
    // newly-set default weapon cvars. game_mode 2 + mp_respawn_on_death_*
    // means respawn is instant for everyone. Going through CommitSuicide
    // is safer than RemoveWeapons + GiveNamedItem (which trips a
    // KeyNotFoundException on bot slots).
    // Equip every alive player with the round weapon.
    //
    // BOT vs HUMAN split: GiveNamedItem-into-existing-inventory does not
    // reliably replace primaries for BOTS on this CSSharp/CS2 combo (the
    // slot's "full" marker isn't cleared by ent.Remove() consistently,
    // so subsequent GiveNamedItem calls no-op and bot AI falls back to
    // knife). For bots we just CommitSuicide — DM respawn is instant,
    // OnPlayerSpawn equips them on a fresh inventory. For humans the
    // strip+give path works and is much less jarring than a kill.
    private void EquipAllAlive()
    {
        var r = Rounds[_round];
        int humans = 0, bots = 0;
        foreach (var p in Utilities.GetPlayers())
        {
            if (p == null || !p.IsValid || p.IsHLTV) continue;
            if (p.TeamNum < 2) continue;
            var pawn = p.PlayerPawn?.Value;
            if (pawn == null || !pawn.IsValid) continue;
            if (pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE) continue;
            try
            {
                if (p.IsBot)
                {
                    // Suicide → fresh respawn → OnPlayerSpawn equips.
                    p.CommitSuicide(false, true);
                    bots++;
                }
                else
                {
                    // Only give if they don't already have this weapon.
                    // Avoids creating duplicate weapon entities every
                    // rotation (the prior version churned a new entity
                    // each tick, racing PVS sync on joins).
                    if (!HasWeapon(pawn, r.Weapon))
                        p.GiveNamedItem(r.Weapon);
                    var pCapture = p;
                    var wCapture = r.Weapon;
                    Server.NextFrame(() => ForceSwitchTo(pCapture, wCapture));
                    humans++;
                }
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlDmRounds] equip {p.PlayerName} failed: {e.Message}");
            }
        }
        Server.PrintToConsole($"[GameCtlDmRounds] EquipAllAlive: gave {r.Weapon} to {humans} humans + suicided {bots} bots");
    }

    // No-op kept for compatibility — historical "strip non-knife weapons"
    // path was racing CS2's PVS sync and crashing the server with
    // "WriteEnterPVS: GetEntServerClass failed" when a client joined
    // mid-removal. The bot-knife problem is now handled exclusively by:
    //   1. CommitSuicide on bots at rotation → fresh inventory on respawn
    //   2. OnPlayerSpawn gives the round weapon
    //   3. BotWeaponWatchdog (every 3s) re-pins ActiveWeapon if it drifted
    // Zero entity removals. Players accumulate weapons (knife + current
    // round weapon + previous rounds') but it's purely cosmetic; AI uses
    // whatever ActiveWeapon points at.
    private static void StripGuns(CCSPlayerPawn pawn) { /* no-op */ }

    // HasWeapon returns true if the pawn already carries an entity with
    // the given DesignerName. Used to skip redundant GiveNamedItem calls
    // (which create churn that races CS2's PVS networking).
    private static bool HasWeapon(CCSPlayerPawn pawn, string weaponName)
    {
        var ws = pawn.WeaponServices;
        if (ws == null) return false;
        foreach (var slot in ws.MyWeapons)
        {
            var ent = slot.Value;
            if (ent != null && ent.IsValid && ent.DesignerName == weaponName)
                return true;
        }
        return false;
    }

    // ForceSwitchTo makes the player actually HOLD the given weapon.
    // CS2 removed bot_command (verified: "Unknown command 'bot_command'!"
    // on this build) and `use <weapon>` is client-side only, so bots
    // ignore both. The reliable path is to set pawn.WeaponServices
    // .ActiveWeapon directly to the weapon entity sitting in their
    // inventory — that's the same field the engine flips during a
    // human's slot-key press.
    private static void ForceSwitchTo(CCSPlayerController p, string weaponName)
    {
        try
        {
            var pawn = p.PlayerPawn?.Value;
            var ws = pawn?.WeaponServices;
            if (ws == null) return;

            // Walk inventory for the entity whose designer name matches
            // (weapon_ak47, weapon_awp, …). Found one wins.
            foreach (var slot in ws.MyWeapons)
            {
                var ent = slot.Value;
                if (ent == null || !ent.IsValid) continue;
                if (ent.DesignerName == weaponName)
                {
                    ws.ActiveWeapon.Raw = slot.Raw;
                    // Send the slot-key client cmd too — for humans it
                    // updates the HUD that ActiveWeapon was changed
                    // server-side. Harmless for bots.
                    p.ExecuteClientCommand($"use {weaponName}");
                    return;
                }
            }
        }
        catch { /* best effort */ }
    }

    // OnPlayerSpawn — fires on every respawn (bot + human). Defer a tick
    // so the spawn finishes laying down the default loadout, then push
    // the round weapon on top so the player has it ready + force the
    // active-weapon swap so bots actually use it instead of knifing.
    // ── chat commands ────────────────────────────────────────────────────

    // !round — show the current weapon + time left until next rotation.
    public void CommandRound(CCSPlayerController? p, CommandInfo _)
    {
        if (p == null || !p.IsValid || p.IsBot) return;
        var r = Rounds[_round];
        var left = (int)Math.Max(0, (_nextRotationAt - DateTime.UtcNow).TotalSeconds);
        p.PrintToChat($" [DM] Round {_round + 1}/{Rounds.Length}: {r.Name} — next rotation in {left}s.");
    }

    // !rounds — list every weapon in the rotation pool with index.
    public void CommandRounds(CCSPlayerController? p, CommandInfo _)
    {
        if (p == null || !p.IsValid || p.IsBot) return;
        p.PrintToChat($" [DM] {Rounds.Length} weapons in rotation:");
        for (int i = 0; i < Rounds.Length; i++)
        {
            var marker = (i == _round) ? " * " : "   ";
            p.PrintToChat($" [DM]{marker}{i + 1,2}. {Rounds[i].Name}");
        }
    }

    // !nextround — admin force-advance the rotation NOW.
    public void CommandNextRound(CCSPlayerController? p, CommandInfo _)
    {
        if (p == null || !p.IsValid || p.IsBot) return;
        if (!AdminManager.PlayerHasPermissions(p, "@css/admin"))
        {
            p.PrintToChat(" [DM] Admin only."); return;
        }
        AdvanceRound();
        _nextRotationAt = DateTime.UtcNow.AddSeconds(ROUND_SECONDS);
    }

    // !setround <index 1..N> — admin jump to a specific round.
    public void CommandSetRound(CCSPlayerController? p, CommandInfo cmd)
    {
        if (p == null || !p.IsValid || p.IsBot) return;
        if (!AdminManager.PlayerHasPermissions(p, "@css/admin"))
        {
            p.PrintToChat(" [DM] Admin only."); return;
        }
        var arg = (cmd.ArgString ?? "").Trim();
        if (!int.TryParse(arg, out var n) || n < 1 || n > Rounds.Length)
        {
            p.PrintToChat($" [DM] Usage: !setround <1-{Rounds.Length}> — see !rounds for the list.");
            return;
        }
        _round = n - 1 - 1; // AdvanceRound will increment, so set one before
        if (_round < 0) _round = Rounds.Length - 1;
        AdvanceRound();
        _nextRotationAt = DateTime.UtcNow.AddSeconds(ROUND_SECONDS);
    }

    // !botdiff <0-3> — admin set bot difficulty. CS2 stock:
    //   0 = easy   1 = normal   2 = hard   3 = expert
    // !botdiff <0-3> — ANY player can set bot difficulty.
    //   0 = easy   1 = normal   2 = hard   3 = expert
    public void CommandBotDiff(CCSPlayerController? p, CommandInfo cmd)
    {
        if (p == null || !p.IsValid || p.IsBot) return;
        var arg = (cmd.ArgString ?? "").Trim();
        if (!int.TryParse(arg, out var n) || n < 0 || n > 3)
        {
            p.PrintToChat(" [DM] Usage: !botdiff <0-3>  (0=easy, 1=normal, 2=hard, 3=expert)");
            return;
        }
        Server.ExecuteCommand($"bot_difficulty {n}");
        Server.ExecuteCommand("bot_kick");
        var labels = new[] { "easy", "normal", "hard", "expert" };
        Server.PrintToChatAll($" [DM] Bot difficulty set to {labels[n]} by {p.PlayerName}.");
    }

    // !bots <N> — ANY player can set bot quota. Cap at 64 (CS2 hard
    // server cap). Anyone using sane numbers (8–24) is fine; 64 unlocks
    // the zombie-style chaos for small homelab servers.
    public void CommandBots(CCSPlayerController? p, CommandInfo cmd)
    {
        if (p == null || !p.IsValid || p.IsBot) return;
        var arg = (cmd.ArgString ?? "").Trim();
        if (!int.TryParse(arg, out var n) || n < 0 || n > 64)
        {
            p.PrintToChat(" [DM] Usage: !bots <0-64>");
            return;
        }
        // Bump visible maxplayers so the engine actually slots all the
        // bots. sv_visiblemaxplayers controls the player-list cap; the
        // hard server maxplayers is whatever was set at boot but engine
        // accepts up to 64 slots on dedicated.
        if (n > 24) Server.ExecuteCommand("sv_visiblemaxplayers 64");
        Server.ExecuteCommand($"bot_quota {n}");
        Server.ExecuteCommand("bot_quota_mode fill");
        Server.PrintToChatAll($" [DM] Bot quota set to {n} by {p.PlayerName}.");
    }

    // BotWeaponWatchdog runs every 3s. For each alive bot, checks the
    // ActiveWeapon — if it's the knife (or no weapon at all), tries to
    // re-pin to the round weapon they should be holding. Cheap defense
    // against bot AI drifting back to knife after the equip path lands.
    private void BotWeaponWatchdog()
    {
        if (_zombieMode) return; // bots are supposed to be knife-only here
        // Pin DM timer-kill cvars every tick so MatchZy / kus
        // deathmatch_settings re-execs can't drift them. DM should
        // run forever — no auto-changelevel, no round-end conditions.
        ConVar.Find("mp_timelimit")?.SetValue(0);
        ConVar.Find("mp_ignore_round_win_conditions")?.SetValue(true);
        ConVar.Find("mp_roundtime")?.SetValue(60f);
        ConVar.Find("mp_freezetime")?.SetValue(0);
        var weapon = Rounds[_round].Weapon;
        int fixedUp = 0;
        foreach (var p in Utilities.GetPlayers())
        {
            if (p == null || !p.IsValid || !p.IsBot) continue;
            if (p.TeamNum < 2) continue;
            var pawn = p.PlayerPawn?.Value;
            if (pawn == null || !pawn.IsValid) continue;
            if (pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE) continue;
            var ws = pawn.WeaponServices;
            if (ws == null) continue;
            var active = ws.ActiveWeapon?.Value;
            var activeName = active?.DesignerName ?? "";
            if (activeName != weapon)
            {
                // Verify the weapon is in their inventory before trying
                // to switch — otherwise we'd silently no-op forever.
                bool hasIt = false;
                foreach (var slot in ws.MyWeapons)
                {
                    var ent = slot.Value;
                    if (ent != null && ent.IsValid && ent.DesignerName == weapon) { hasIt = true; break; }
                }
                if (!hasIt)
                {
                    try { p.GiveNamedItem(weapon); } catch { }
                    var pCapture = p;
                    Server.NextFrame(() => ForceSwitchTo(pCapture, weapon));
                }
                else
                {
                    ForceSwitchTo(p, weapon);
                }
                fixedUp++;
            }
        }
        if (fixedUp > 0)
            Server.PrintToConsole($"[GameCtlDmRounds] watchdog re-pinned {fixedUp} bot(s) to {weapon}");
    }

    private HookResult OnPlayerSpawn(EventPlayerSpawn @event, GameEventInfo info)
    {
        var p = @event.Userid;
        if (p == null || !p.IsValid || p.IsHLTV) return HookResult.Continue;
        if (p.TeamNum < 2) return HookResult.Continue;
        bool zombie = _zombieMode;
        bool isBot = p.IsBot;
        string weapon;
        if (zombie)
        {
            weapon = isBot ? "" : HUMAN_ZOMBIE_WEAPON;
        }
        else
        {
            weapon = Rounds[_round].Weapon;
        }
        AddTimer(0.3f, () =>
        {
            try
            {
                if (p == null || !p.IsValid) return;
                var pawn = p.PlayerPawn?.Value;
                if (pawn == null || !pawn.IsValid) return;
                if (pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE) return;
                // Zombie mode: enforce team assignment + give nades to
                // humans on top of the shotgun.
                if (zombie)
                {
                    ForceZombieTeam(p);
                    if (!isBot)
                    {
                        foreach (var nade in ZombieNades) p.GiveNamedItem(nade);
                    }
                }
                StripGuns(pawn);
                if (weapon.Length == 0) return;
                p.GiveNamedItem(weapon);
                var pCapture = p;
                var wCapture = weapon;
                Server.NextFrame(() => ForceSwitchTo(pCapture, wCapture));
                AddTimer(0.1f, () => ForceSwitchTo(pCapture, wCapture));
                AddTimer(0.3f, () => ForceSwitchTo(pCapture, wCapture));
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlDmRounds] spawn-give to {p.PlayerName} failed: {e.Message}");
            }
        });
        return HookResult.Continue;
    }

    // ── zombie mode ──────────────────────────────────────────────────────

    // EquipAllForZombieMode strips everyone + re-equips per role. Called
    // on toggle-on and on every rotation tick (90s) so bots that have
    // picked up dropped shotguns get scrubbed back to knife.
    private void EquipAllForZombieMode()
    {
        int humans = 0, zombies = 0;
        foreach (var p in Utilities.GetPlayers())
        {
            if (p == null || !p.IsValid || p.IsHLTV) continue;
            if (p.TeamNum < 2) continue;
            var pawn = p.PlayerPawn?.Value;
            if (pawn == null || !pawn.IsValid) continue;
            if (pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE) continue;
            try
            {
                ForceZombieTeam(p);
                StripGuns(pawn);
                if (p.IsBot)
                {
                    zombies++;
                }
                else
                {
                    p.GiveNamedItem(HUMAN_ZOMBIE_WEAPON);
                    foreach (var nade in ZombieNades) p.GiveNamedItem(nade);
                    var pCapture = p;
                    Server.NextFrame(() => ForceSwitchTo(pCapture, HUMAN_ZOMBIE_WEAPON));
                    humans++;
                }
            }
            catch { /* per-player failure: skip */ }
        }
        Server.PrintToConsole($"[GameCtlDmRounds] zombie equip: {humans} humans got {HUMAN_ZOMBIE_WEAPON}+nades, {zombies} bots stripped to knife");
    }

    // ForceZombieTeam pins bots to T, humans to CT — needed so the
    // teammates_are_enemies=0 rule produces "bots attack only humans"
    // instead of bots-vs-bots free-for-all.
    private static void ForceZombieTeam(CCSPlayerController p)
    {
        var want = p.IsBot ? CsTeam.Terrorist : CsTeam.CounterTerrorist;
        if ((CsTeam)p.TeamNum != want)
        {
            try { p.SwitchTeam(want); } catch { }
        }
    }

    // BotTeamWatchdog runs every 1s while zombie mode is active.
    //
    // Three jobs:
    //   1. Re-assert zombie cvars (cfg-chain reverts them otherwise).
    //   2. Force every CT bot onto T (SwitchTeam + Respawn — verified
    //      working when paired with kickid as a fallback). Just calling
    //      `bot_kick "<name>"` returns success but doesn't actually
    //      remove the bot on this build — replaced with kickid.
    //   3. Force humans to CT and ensure they have a negev. EquipAllFor-
    //      ZombieMode runs on round start + every 90s rotation; this
    //      catches anything in between (e.g. late joiners).
    //
    // bot_quota_mode is set to NORMAL (not fill) — fill auto-balances
    // bots between teams, which is the root cause of CT-bot drift even
    // when bot_join_team is t. With normal mode + bot_add_t loop, every
    // new bot is explicitly added to T and the engine has no team-
    // balance authority.
    private int _watchdogTick;
    private void BotTeamWatchdog()
    {
        _watchdogTick++;
        if (!_zombieMode) return;

        // No HUD timer / no auto-changelevel — cfg chain otherwise
        // re-applies mp_timelimit on round_start hooks.
        ConVar.Find("mp_ignore_round_win_conditions")?.SetValue(true);
        ConVar.Find("mp_timelimit")?.SetValue(0);
        // String cvar: ConVar.SetValue<T> is for numeric/bool cvars only.
        // Use StringValue for bot_join_team / bot_quota_mode.
        var bjt = ConVar.Find("bot_join_team");           if (bjt  != null) bjt.StringValue  = "t";
        var bqm = ConVar.Find("bot_quota_mode");          if (bqm  != null) bqm.StringValue  = "normal";
        ConVar.Find("mp_teammates_are_enemies")?.SetValue(false);
        ConVar.Find("mp_autoteambalance")?.SetValue(false);
        ConVar.Find("mp_limitteams")?.SetValue(0);
        ConVar.Find("bot_quota")?.SetValue(64);
        ConVar.Find("bot_knives_only")?.SetValue(true);
        ConVar.Find("bot_difficulty")?.SetValue(0);
        // sv_infinite_ammo + sv_cheats: cfg chain's sv_cheats 0 at the
        // end of deathmatch_settings.cfg reverts both. Re-pin every tick.
        ConVar.Find("sv_cheats")?.SetValue(true);
        ConVar.Find("sv_infinite_ammo")?.SetValue(1);
        // Solid teammates: CT humans can stand on each other's heads to
        // reach high spots. Default DM cfg sets mp_solid_teammates 0.
        ConVar.Find("mp_solid_teammates")?.SetValue(true);
        Server.ExecuteCommand("mp_visiblemaxplayers 64;sv_visiblemaxplayers 64");

        int tBots = 0, ctBots = 0, humans = 0, switched = 0, kicked = 0, negevs = 0;
        // Collected during the loop for the stuck-bot nudge pass below.
        var humanPositions = new List<(float x, float y, float z)>();
        var aliveBots = new List<(CCSPlayerController c, CCSPlayerPawn pw, ulong sid)>();
        foreach (var p in Utilities.GetPlayers())
        {
            if (p == null || !p.IsValid || p.IsHLTV) continue;
            bool isBot = p.IsBot || p.SteamID == 0;
            // Per-pawn gravity — bots 0.7 (jump ~50% higher), humans 1.0.
            try
            {
                var pw = p.PlayerPawn?.Value;
                if (pw != null && pw.IsValid)
                {
                    // T bots (all bots in zombie mode are pinned to T) get
                    // a big jump boost — knife-only zombies need to chase
                    // CTs onto crates, vents, beams that the nav mesh
                    // doesn't cover. 0.4 = ~2.5x normal jump height,
                    // enough to reach the tops of stacked crates and
                    // most second-floor balconies/ledges.
                    pw.GravityScale = isBot ? 0.4f : 1.0f;
                }
            }
            catch { }

            if (!isBot)
            {
                humans++;
                // Ensure humans are on CT.
                if ((CsTeam)p.TeamNum != CsTeam.CounterTerrorist)
                {
                    try { p.SwitchTeam(CsTeam.CounterTerrorist); } catch { }
                }
                // Ensure alive humans have a negev. Misses on the spawn
                // path show up as "no weapon" — this catches them.
                var pawn = p.PlayerPawn?.Value;
                if (pawn != null && pawn.IsValid &&
                    pawn.LifeState == (byte)LifeState_t.LIFE_ALIVE)
                {
                    var hp = pawn.AbsOrigin;
                    if (hp != null) humanPositions.Add((hp.X, hp.Y, hp.Z));
                    if (!HasWeapon(pawn, HUMAN_ZOMBIE_WEAPON))
                    {
                        try
                        {
                            p.GiveNamedItem(HUMAN_ZOMBIE_WEAPON);
                            foreach (var nade in ZombieNades)
                            {
                                if (!HasWeapon(pawn, nade)) p.GiveNamedItem(nade);
                            }
                            var pCapture = p;
                            Server.NextFrame(() => ForceSwitchTo(pCapture, HUMAN_ZOMBIE_WEAPON));
                            negevs++;
                        }
                        catch { }
                    }
                }
                continue;
            }

            // Bot — classify + move CT bots over.
            var team = (CsTeam)p.TeamNum;
            if (team == CsTeam.Terrorist)
            {
                tBots++;
                var bp = p.PlayerPawn?.Value;
                if (bp != null && bp.IsValid &&
                    bp.LifeState == (byte)LifeState_t.LIFE_ALIVE)
                {
                    // CS2 bots have SteamID == 0 — using it as a map key
                    // makes all 38 bots share the same throttle slot,
                    // and the first nudge of the tick locks out the
                    // other 37. Use UserId instead (unique per bot
                    // connection, stable across respawns).
                    ulong botKey = (ulong)(p.UserId ?? (int)p.Index);
                    aliveBots.Add((p, bp, botKey));
                }
            }
            else if (team == CsTeam.CounterTerrorist)
            {
                ctBots++;
                // SwitchTeam moves them without respawning at a different
                // spawn point. Fallback: kickid using the bot's userid
                // (bot_kick "<name>" silently no-ops on this build).
                try { p.SwitchTeam(CsTeam.Terrorist); switched++; }
                catch { }
                try
                {
                    if (p.UserId.HasValue)
                    {
                        Server.ExecuteCommand($"kickid {p.UserId.Value}");
                        kicked++;
                    }
                }
                catch { }
            }
        }

        // Bot-out-of-reach nudge.
        //
        // Two cases the natural AI can't handle:
        //   a) Bot is far away horizontally and is wandering / failing to
        //      close the gap (typical "horde lost" on big maps).
        //   b) Bot is RIGHT next to the human's box/crate/balcony but
        //      can't path up because the nav mesh doesn't cover the top.
        //      Horizontal distance is small — purely a vertical reach
        //      problem.
        //
        // Trigger fires if EITHER:
        //   - horizontal distance > 120u (chase case), OR
        //   - human is > 30u above the bot (perch case — regardless of
        //     horizontal distance, the AI gave up).
        //
        // Aggressive horde hop loop.
        //
        // Trigger (any of):
        //   - horiz > 50u  (chase — bot not in immediate knife range)
        //   - dz > 5u      (perch — human is even slightly above)
        //   - random      (~25% chance per bot per tick — pure chaos
        //                  hop so even bots in melee jitter upward;
        //                  helps them hop ledges they're standing
        //                  right under without any directional logic)
        //
        // Throttle: 0.4s per bot. Watchdog runs every 1s so this is
        // effectively "every tick" per bot but kept >0 so we don't
        // re-nudge mid-flight if something else fires faster later.
        // Cap: 40 nudges per tick — with 60 bots ~⅔ of the horde
        // hops every second.
        int nudged = 0;
        int chaseQ = 0, perchQ = 0, randQ = 0, throttled = 0;
        var rng = _nudgeRng;
        if (humanPositions.Count > 0 && aliveBots.Count > 0)
        {
            var now = DateTime.UtcNow;
            const float CHASE_HORIZ_THRESHOLD = 50f;
            const float PERCH_DZ_THRESHOLD    = 5f;
            const float RANDOM_HOP_CHANCE     = 0.25f;
            const int   MAX_NUDGES_PER_TICK   = 40;
            foreach (var b in aliveBots)
            {
                if (nudged >= MAX_NUDGES_PER_TICK) break;

                var pos = b.pw.AbsOrigin;
                if (pos == null) continue;

                // Nearest alive human — by HORIZONTAL distance (so a
                // bot at the base of a box picks the human on top of
                // it, not someone 300u away on the same floor).
                float bestHoriz2 = float.MaxValue;
                (float x, float y, float z) bestH = default;
                foreach (var h in humanPositions)
                {
                    float ex = h.x - pos.X, ey = h.y - pos.Y;
                    float d2 = ex * ex + ey * ey;
                    if (d2 < bestHoriz2) { bestHoriz2 = d2; bestH = h; }
                }
                float dx = bestH.x - pos.X, dy = bestH.y - pos.Y, dz = bestH.z - pos.Z;
                float horiz = MathF.Sqrt(dx * dx + dy * dy);

                // MELEE EXCLUSION: if the bot is already in knife range
                // (~70u horiz + within 50u vertical), don't touch them
                // — let normal AI swing. Without this, bots that
                // finally reach the human get yeeted away by the next
                // tick's nudge before they can attack.
                bool inMelee = horiz < 70f && dz < 50f && dz > -50f;
                if (inMelee)
                {
                    _botStuckSince.Remove(b.sid);
                    continue;
                }

                bool chase = horiz > CHASE_HORIZ_THRESHOLD;
                bool perch = dz > PERCH_DZ_THRESHOLD;
                bool randomHop = rng.NextDouble() < RANDOM_HOP_CHANCE;
                if (chase) chaseQ++;
                if (perch) perchQ++;
                if (randomHop) randQ++;
                if (!chase && !perch && !randomHop)
                {
                    _botStuckSince.Remove(b.sid);
                    continue;
                }

                // Per-bot throttle.
                if (_botStuckSince.TryGetValue(b.sid, out var lastAt) &&
                    (now - lastAt).TotalSeconds < 0.4)
                {
                    throttled++;
                    continue;
                }

                if (horiz < 5f) { dx = 0f; dy = 0f; }
                else { dx /= horiz; dy /= horiz; }

                try
                {
                    // Ballistic-style aim.
                    //
                    // Math: peak_height = vz² / (2 * g_eff).
                    // GravityScale 0.4 IS honored for player pawns
                    // (verified empirically — bots overshot ~2.5x
                    // when math assumed g=800). Use g_eff = 320
                    // (= 800 * 0.4).
                    //
                    //   targetHeight  = max(dz, 0) + 25  (small
                    //                   overshoot, bot is descending
                    //                   when crossing the ledge but
                    //                   not flying skyward).
                    //   zVel          = √(2 · 320 · targetHeight)
                    //   airtime       ≈ 2 · vz / 320
                    //   horizSpeed    = horiz / airtime  — exact XY
                    //                   speed to land on the target.
                    //
                    // Clamped to [260, 750]:
                    //   260 = a tangible jump (peak ~106u at g=320)
                    //   750 = peak ~880u — clears any perch a CT
                    //         could reach but stops the moon-shot
                    //         hover the user saw.
                    const float G_EFF = 320f;
                    float targetHeight = MathF.Max(dz, 0f) + 50f;
                    float zVel = MathF.Sqrt(2f * G_EFF * targetHeight);
                    zVel = Math.Clamp(zVel, 320f, 900f);

                    float airtime = MathF.Max(0.5f, 2f * zVel / G_EFF);
                    float horizSpeed = horiz < 5f ? 0f : horiz / airtime;
                    horizSpeed = Math.Clamp(horizSpeed, 0f, 700f);
                    // For chase cases (no perch, just out of range)
                    // make sure we still close the gap fast — at least
                    // bot run speed.
                    if (!perch && horiz > CHASE_HORIZ_THRESHOLD)
                        horizSpeed = MathF.Max(horizSpeed, 250f);

                    // The on-ground Z-velocity-clobber problem: when
                    // FL_ONGROUND is set, the engine resets vel.Z to 0
                    // each tick BEFORE applying our write. Teleport
                    // with origin = pos + 4u breaks ground contact in
                    // the same call so the Z applies cleanly. The 4u
                    // lift is sub-step displacement (visually invisible).
                    var liftedPos = new Vector(pos.X, pos.Y, pos.Z + 4f);
                    var newVel = new Vector(dx * horizSpeed, dy * horizSpeed, zVel);
                    b.pw.Teleport(liftedPos, null, newVel);
                    nudged++;
                    _botStuckSince[b.sid] = now;
                }
                catch { }
            }
            if (nudged > 0 || (_watchdogTick % 5) == 0)
                Server.PrintToConsole($"[GameCtlDmRounds] horde nudge tick #{_watchdogTick}: aliveBots={aliveBots.Count} humans={humanPositions.Count} chaseQ={chaseQ} perchQ={perchQ} randQ={randQ} throttled={throttled} nudged={nudged}");
        }

        // bot_quota_mode normal + manual bot_add_t — every new bot is
        // explicitly added to T. Drip 4/tick until we hit target.
        //
        // Profile-pool trick: CS2's bot profile name pool is per
        // bot_difficulty (~easy 38, normal 32, hard 28, expert 22). Once
        // a pool is exhausted, bot_add_t errors with "All bot profiles at
        // this difficulty level are in use" and silently no-ops further
        // adds. We cycle bot_difficulty before EACH bot_add_t so each
        // new bot pulls from a different pool — net total goes from ~38
        // (easy only) to ~120 combined. bot_knives_only flattens the
        // difficulty difference so smarts don't matter.
        const int TARGET_T_BOTS = 63;
        if (tBots < TARGET_T_BOTS)
        {
            int toAdd = Math.Min(4, TARGET_T_BOTS - tBots);
            for (int i = 0; i < toAdd; i++)
            {
                int diff = (_watchdogTick + i) % 4;
                ConVar.Find("bot_difficulty")?.SetValue(diff);
                Server.ExecuteCommand("bot_add_t");
            }
            // Restore easy as the resting difficulty so any engine read
            // of bot_difficulty between ticks sees the friendliest pool.
            ConVar.Find("bot_difficulty")?.SetValue(0);
        }

        if (switched + kicked + negevs > 0)
            Server.PrintToConsole($"[GameCtlDmRounds] watchdog: switched={switched} kicked={kicked} negev-equipped={negevs}");
        if ((_watchdogTick % 5) == 0)
            Server.PrintToConsole($"[GameCtlDmRounds] BotTeamWatchdog tick #{_watchdogTick}: {tBots} T-bots, {ctBots} CT-bots, {humans} humans (target {TARGET_T_BOTS})");
    }

    // ── zombie survival round ────────────────────────────────────────────

    // StartZombieRound resets the survival state, respawns any dead
    // humans, and announces the round in chat. Called by !zombiemode
    // when toggling ON, and by the auto-restart timer 10s after a
    // previous round ends.
    private void StartZombieRound()
    {
        _zombieRoundActive = true;
        _zombieRoundStartedAt = DateTime.UtcNow;
        _zombieAlive.Clear();
        _zombieKills.Clear();
        _zombieDeathAt.Clear();
        _zombieNames.Clear();

        foreach (var p in Utilities.GetPlayers())
        {
            if (p == null || !p.IsValid || p.IsBot || p.IsHLTV) continue;
            if (p.TeamNum < 2) continue;
            _zombieAlive.Add(p.SteamID);
            _zombieKills[p.SteamID] = 0;
            _zombieNames[p.SteamID] = p.PlayerName ?? "?";
            var pawn = p.PlayerPawn?.Value;
            if (pawn != null && pawn.IsValid &&
                pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE)
            {
                try { p.Respawn(); } catch { }
            }
        }
        Server.NextFrame(EquipAllForZombieMode);
        Server.PrintToChatAll($" [DM] Survival round started — see how long you can last. {_zombieAlive.Count} human(s) vs the horde.");
    }

    // EndZombieRound prints per-player survive times + kill counts
    // and schedules the next round 10s out (only if zombie mode is
    // still on). Round ends when ALL humans are dead — no "last
    // survivor wins" concept, just personal survival times.
    private void EndZombieRound()
    {
        if (!_zombieRoundActive) return;
        _zombieRoundActive = false;

        // Build the leaderboard from _zombieDeathAt + _zombieKills.
        // Sort by survive time DESC.
        var rows = _zombieDeathAt
            .Select(kv => new {
                Sid = kv.Key,
                Name = _zombieNames.TryGetValue(kv.Key, out var n) ? n : "?",
                Secs = (int)(kv.Value - _zombieRoundStartedAt).TotalSeconds,
                Kills = _zombieKills.TryGetValue(kv.Key, out var k) ? k : 0,
            })
            .OrderByDescending(r => r.Secs)
            .ToList();

        Server.PrintToChatAll(" [DM] *** SURVIVAL ROUND OVER *** Results:");
        for (int i = 0; i < rows.Count; i++)
        {
            var r = rows[i];
            Server.PrintToChatAll($" [DM]   {i + 1}. {r.Name}: lasted {r.Secs}s, {r.Kills} kills");
        }

        AddTimer(10.0f, () =>
        {
            if (_zombieMode && !_zombieRoundActive)
            {
                Server.PrintToChatAll(" [DM] Next survival round starting…");
                StartZombieRound();
            }
        });
    }

    // ── zombie PB persistence ───────────────────────────────────────────

    private void LoadZombieRecords()
    {
        lock (_zombieRecordsLock)
        {
            try
            {
                if (!File.Exists(ZOMBIE_RECORDS_PATH))
                {
                    _zombieRecords = new ZombieRecordsFile();
                    return;
                }
                var raw = File.ReadAllText(ZOMBIE_RECORDS_PATH);
                _zombieRecords = JsonSerializer.Deserialize<ZombieRecordsFile>(raw) ?? new ZombieRecordsFile();
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlDmRounds] load zombie records failed: {e.Message} — starting fresh");
                _zombieRecords = new ZombieRecordsFile();
            }
        }
    }

    private void SaveZombieRecords()
    {
        lock (_zombieRecordsLock)
        {
            try
            {
                var tmp = ZOMBIE_RECORDS_PATH + ".tmp";
                File.WriteAllText(tmp, JsonSerializer.Serialize(_zombieRecords,
                    new JsonSerializerOptions { WriteIndented = true }));
                File.Move(tmp, ZOMBIE_RECORDS_PATH, overwrite: true);
            }
            catch (Exception e)
            {
                Server.PrintToConsole($"[GameCtlDmRounds] save zombie records failed: {e.Message}");
            }
        }
    }

    // TryRecordPB checks if this run beat the player's previous best
    // survive-time OR best kill count. Updates + persists if either.
    // Returns (newSurvivePB, newKillsPB).
    private (bool, bool) TryRecordPB(ulong sid, string name, long surviveMs, int kills, DateTime when)
    {
        bool newSurvive = false, newKills = false;
        var sidStr = sid.ToString();
        lock (_zombieRecordsLock)
        {
            if (!_zombieRecords.Records.TryGetValue(sidStr, out var rec))
            {
                rec = new ZombieRecord { Name = name };
                _zombieRecords.Records[sidStr] = rec;
            }
            rec.Name = name; // keep latest name
            if (surviveMs > rec.BestSurviveMs)
            {
                rec.BestSurviveMs = surviveMs;
                rec.BestSurviveFinishedAt = when.ToString("o");
                newSurvive = true;
            }
            if (kills > rec.BestKills)
            {
                rec.BestKills = kills;
                rec.BestKillsFinishedAt = when.ToString("o");
                newKills = true;
            }
        }
        if (newSurvive || newKills)
            Task.Run(SaveZombieRecords);
        return (newSurvive, newKills);
    }

    public void CommandZombiePB(CCSPlayerController? p, CommandInfo _)
    {
        if (p == null || !p.IsValid || p.IsBot) return;
        var sidStr = p.SteamID.ToString();
        lock (_zombieRecordsLock)
        {
            if (!_zombieRecords.Records.TryGetValue(sidStr, out var rec))
            {
                p.PrintToChat(" [DM] You have no zombie-mode PB yet — survive a round to set one!");
                return;
            }
            var secs = rec.BestSurviveMs / 1000;
            p.PrintToChat($" [DM] Your zombie PB: lasted \x04{secs}s\x01, best round kills \x04{rec.BestKills}\x01.");
        }
    }

    public void CommandZombieWR(CCSPlayerController? p, CommandInfo _)
    {
        if (p == null || !p.IsValid || p.IsBot) return;
        ZombieRecord? topSurvive = null;
        ZombieRecord? topKills = null;
        lock (_zombieRecordsLock)
        {
            foreach (var r in _zombieRecords.Records.Values)
            {
                if (topSurvive == null || r.BestSurviveMs > topSurvive.BestSurviveMs) topSurvive = r;
                if (topKills   == null || r.BestKills > topKills.BestKills)           topKills   = r;
            }
        }
        if (topSurvive == null)
        {
            p.PrintToChat(" [DM] No zombie records yet — be the first to survive a round!");
            return;
        }
        var secs = topSurvive!.BestSurviveMs / 1000;
        p.PrintToChat($" [DM] Zombie WR: \x04{topSurvive.Name}\x01 lasted \x04{secs}s\x01.");
        if (topKills != null && topKills.BestKills > 0)
            p.PrintToChat($" [DM] Top kills:  \x04{topKills.Name}\x01 with \x04{topKills.BestKills}\x01 bot kills in a round.");
    }

    // OnPlayerDeath_Zombie tallies bot kills + records human death times.
    // Round ends only when EVERY human is dead — no last-survivor.
    private HookResult OnPlayerDeath_Zombie(EventPlayerDeath @event, GameEventInfo info)
    {
        if (!_zombieMode || !_zombieRoundActive) return HookResult.Continue;

        var victim = @event.Userid;
        var attacker = @event.Attacker;
        if (victim == null || !victim.IsValid) return HookResult.Continue;

        // Bot died — credit the human attacker (if any) with a kill.
        if (victim.IsBot)
        {
            if (attacker != null && attacker.IsValid && !attacker.IsBot)
            {
                var sid = attacker.SteamID;
                _zombieKills[sid] = _zombieKills.GetValueOrDefault(sid, 0) + 1;
            }
            return HookResult.Continue;
        }

        // Human died — record death time + announce.
        var vsid = victim.SteamID;
        if (!_zombieAlive.Remove(vsid)) return HookResult.Continue;
        var deathAt = DateTime.UtcNow;
        _zombieDeathAt[vsid] = deathAt;
        _zombieNames[vsid] = victim.PlayerName ?? _zombieNames.GetValueOrDefault(vsid, "?");

        var elapsedMs = (long)(deathAt - _zombieRoundStartedAt).TotalMilliseconds;
        var elapsedSec = (int)(elapsedMs / 1000);
        var killer = (attacker != null && attacker.IsValid)
            ? (attacker.IsBot ? $"zombie {attacker.PlayerName}" : attacker.PlayerName)
            : "the horde";
        var kills = _zombieKills.TryGetValue(vsid, out var k) ? k : 0;

        // PB check + persist if either survive time OR kill count beats
        // the player's previous best. Off the game thread to keep tick
        // latency minimal.
        var (sBest, kBest) = TryRecordPB(vsid, victim.PlayerName ?? "?", elapsedMs, kills, deathAt);
        var pbBlurb = "";
        if (sBest || kBest)
        {
            var bits = new List<string>();
            if (sBest) bits.Add("NEW survive PB");
            if (kBest) bits.Add("NEW kill PB");
            pbBlurb = $" — {string.Join(" + ", bits)}!";
        }
        Server.PrintToChatAll($" [DM] {victim.PlayerName} lasted {elapsedSec}s — killed by {killer} ({kills} bot kill(s)){pbBlurb}.");

        // Only when EVERYONE is dead — print results + restart.
        if (_zombieAlive.Count == 0) EndZombieRound();
        return HookResult.Continue;
    }

    // !zombiemode — ANY player can toggle the bots-with-knives swarm
    // vs human shotguns game mode. Pushes the bot count to the engine
    // hard cap (64) and unlocks sv_visiblemaxplayers so all the bots
    // slot in. The actual count the engine spawns depends on the map's
    // available player spawn points — small maps may cap at ~24.
    public void CommandZombieMode(CCSPlayerController? p, CommandInfo cmd)
    {
        // Allow console/RCON invocation (p == null) too. Bots can't
        // invoke chat commands anyway, but a bot somehow firing this
        // would be skipped via the IsBot check.
        if (p != null && (!p.IsValid || p.IsBot)) return;
        _zombieMode = !_zombieMode;
        var who = p?.PlayerName ?? "Server";
        Server.PrintToConsole($"[GameCtlDmRounds] CommandZombieMode by {who} -> _zombieMode={_zombieMode}");

        // bot_zombie + bot_knives_only are FCVAR_CHEAT — Server.ExecuteCommand
        // doesn't bypass the cheat check ("Convar 'bot_zombie' is cheat
        // protected, change ignored" even after sv_cheats 1 ran on the
        // same tick). Direct ConVar.SetValue API does bypass the check.
        if (_zombieMode)
        {
            // Stay in DM base mode (game_type 1 / game_mode 2).
            // Tried switching to Casual for bigger team caps — Casual
            // blocks T-only bot adds ("Team is full" on every bot_add_t
            // even with mp_limitteams 0). DM is the only base mode that
            // lets us pack 38+ bots onto T.
            //
            // Kill the natural timers — round-win conditions, map-time
            // limit, freeze-time, team-intro time. With mp_roundtime at
            // max + ignore_round_win_conditions, the round timer never
            // reaches a state that matters; DM keeps going forever.
            ConVar.Find("mp_ignore_round_win_conditions")?.SetValue(true);
            ConVar.Find("mp_timelimit")?.SetValue(0);
            ConVar.Find("mp_roundtime")?.SetValue(60f);
            ConVar.Find("mp_roundtime_defuse")?.SetValue(60f);
            ConVar.Find("mp_freezetime")?.SetValue(0);
            ConVar.Find("mp_team_intro_time")?.SetValue(0);
            ConVar.Find("mp_match_end_restart")?.SetValue(false);
            ConVar.Find("mp_match_can_clinch")?.SetValue(false);
            ConVar.Find("mp_maxrounds")?.SetValue(9999);
            ConVar.Find("sv_cheats")?.SetValue(true);
            ConVar.Find("bot_knives_only")?.SetValue(true);
            // Survival rules:
            //   - mp_teammates_are_enemies 0 + put bots on T, humans on
            //     CT → bots only target humans (cross-team), humans
            //     cooperate against zombies.
            //   - mp_respawn_on_death_ct 0 → humans have ONE life.
            //   - mp_respawn_on_death_t 1 → bots respawn endlessly as
            //     new zombies (the horde never runs out).
            //   - sv_infinite_ammo 1 → unlimited ammo (reload still needed).
            //   - ammo_grenade_limit_total 5 → humans can carry every nade.
            // Team-based: bots on T won't shoot/knife each other, only
            // hunt the human(s) on CT. mp_teammates_are_enemies 0 +
            // bot_join_team t + mp_limitteams 0 + the now-64 maxplayers
            // (from the entrypoint override) lets us pack many T-bots
            // without the "Team is full" wall.
            ConVar.Find("mp_teammates_are_enemies")?.SetValue(false);
            ConVar.Find("mp_respawn_on_death_ct")?.SetValue(false);
            ConVar.Find("mp_respawn_on_death_t")?.SetValue(true);
            ConVar.Find("sv_infinite_ammo")?.SetValue(1);
            ConVar.Find("ammo_grenade_limit_total")?.SetValue(5);
            // CRITICAL for "all bots on T". CS2 auto-balances bot fill
            // between teams unless these are off — leaves half the
            // zombies on CT where they immediately die and don't respawn
            // (mp_respawn_on_death_ct 0). User saw "half the bots have
            // CT pictures and don't spawn" before this set landed.
            ConVar.Find("mp_autoteambalance")?.SetValue(false);
            ConVar.Find("mp_limitteams")?.SetValue(0);
            // Per-pawn gravity: handled in BotTeamWatchdog via
            // pawn.GravityScale — bots get 0.6 (jump ~40% higher),
            // humans stay at 1.0. Server-wide sv_gravity stays at the
            // default 800 so the floor isn't slow-mo for everyone.
            // bot_join_team t forces fresh bot connections onto T —
            // critical because mp_respawn_on_death_ct 0 means any bot
            // that ended up on CT silently stays dead after their first
            // death. Set this BEFORE bot_kick + quota refill.
            //
            // bot_difficulty 0 (easy) — CS2's bot name profile pool is
            // per-difficulty. Expert (3) only ships ~22 unique profiles,
            // so bot_add_t errors with "All bot profiles at this
            // difficulty level are in use" after ~22 bots. Easy has the
            // largest pool (~40+ profiles). For zombies we want quantity
            // over individual smarts anyway — they're knife-only.
            // bot_quota_mode NORMAL (not fill) is critical — fill auto-
            // balances bots between teams, defeating bot_join_team t.
            // With normal mode + bot_add_t loop in the watchdog, every
            // new bot is explicitly added to T.
            var bjt = ConVar.Find("bot_join_team");  if (bjt != null) bjt.StringValue = "t";
            var bqm = ConVar.Find("bot_quota_mode"); if (bqm != null) bqm.StringValue = "normal";
            Server.ExecuteCommand(
                "sv_visiblemaxplayers 64;" +
                "bot_difficulty 0;" +
                "bot_kick;" +
                "bot_quota 64");
            ConVar.Find("bot_quota")?.SetValue(64);
            Server.PrintToChatAll($" [DM] *** ZOMBIE SURVIVAL *** activated by {who}. Bots target humans only. ONE LIFE.");
            StartZombieRound();
        }
        else
        {
            // Timers stay disabled even when zombie mode is off — the
            // user wants DM to run forever, no auto-cycle, no round
            // timer that hits zero and triggers anything.
            ConVar.Find("mp_timelimit")?.SetValue(0);
            ConVar.Find("mp_ignore_round_win_conditions")?.SetValue(true);
            ConVar.Find("mp_roundtime")?.SetValue(60f);
            ConVar.Find("mp_freezetime")?.SetValue(0);
            ConVar.Find("bot_knives_only")?.SetValue(false);
            ConVar.Find("sv_cheats")?.SetValue(false);
            // Reset all pawn gravity scales to normal (1.0) on toggle off.
            foreach (var pp in Utilities.GetPlayers())
            {
                var pw = pp?.PlayerPawn?.Value;
                if (pw != null && pw.IsValid) try { pw.GravityScale = 1.0f; } catch { }
            }
            ConVar.Find("mp_teammates_are_enemies")?.SetValue(true);
            ConVar.Find("mp_respawn_on_death_ct")?.SetValue(true);
            ConVar.Find("mp_respawn_on_death_t")?.SetValue(true);
            ConVar.Find("sv_infinite_ammo")?.SetValue(0);
            ConVar.Find("mp_autoteambalance")?.SetValue(true);
            ConVar.Find("mp_limitteams")?.SetValue(2);
            _zombieRoundActive = false;
            var bjt2 = ConVar.Find("bot_join_team");  if (bjt2 != null) bjt2.StringValue = "any";
            var bqm2 = ConVar.Find("bot_quota_mode"); if (bqm2 != null) bqm2.StringValue = "fill";
            Server.ExecuteCommand(
                "sv_visiblemaxplayers 24;" +
                "bot_difficulty 2;" +
                "bot_kick;" +
                "bot_quota 8");
            ConVar.Find("bot_quota")?.SetValue(8);
            Server.PrintToChatAll($" [DM] Zombie mode OFF — back to weapon-rotation DM by {who}.");
            EquipAllAlive();
        }
    }
}
