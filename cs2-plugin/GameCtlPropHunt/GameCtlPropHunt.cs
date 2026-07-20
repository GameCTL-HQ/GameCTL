using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Utils;

namespace GameCtlPropHunt;

// GameCtlPropHunt — minimal overlay for prop hunt.
//
// The earlier version tried to enforce hide-and-seek mechanics
// (third-person hiders, weapon strip, shot-penalty seekers). User
// confirmed the base hns mode is fine as-is — props can already shoot
// with their default glocks. The only addition they wanted:
//
//   !heal — one-shot full restore for CT seekers, ONE USE PER ROUND.
//
// That's all this plugin does now. No spawn hooks, no shot tracking,
// no taunts, no third-person. Just one command + per-round state.

public sealed class GameCtlPropHunt : BasePlugin
{
    public override string ModuleName    => "GameCtl PropHunt";
    public override string ModuleVersion => "2.0.0";
    public override string ModuleAuthor  => "GameCTL";
    public override string ModuleDescription =>
        "Prop-hunt overlay: one-shot !heal per round for CT seekers.";

    private const int HEAL_AMOUNT = 100;

    // Per-round, per-player single-use tracker. Cleared on round start.
    // Keyed by UserId (SteamID is 0 for bots — same fix pattern we use
    // in DmRounds — though only humans should ever invoke !heal).
    private readonly HashSet<ulong> _usedHealThisRound = new();

    public override void Load(bool hotReload)
    {
        AddCommand("css_heal", "One-shot CT seeker medishot (1 use per round)", CommandHeal);
        RegisterEventHandler<EventRoundStart>(OnRoundStart);
        Server.PrintToConsole("[GameCtlPropHunt] Loaded — !heal available (CT, 1 use/round).");
    }

    private HookResult OnRoundStart(EventRoundStart @event, GameEventInfo info)
    {
        _usedHealThisRound.Clear();
        return HookResult.Continue;
    }

    public void CommandHeal(CCSPlayerController? p, CommandInfo _)
    {
        if (p == null || !p.IsValid || p.IsBot) return;
        if ((CsTeam)p.TeamNum != CsTeam.CounterTerrorist)
        {
            p.PrintToChat(" \x06[PropHunt]\x01 !heal is for seekers (CT) only.");
            return;
        }
        var pawn = p.PlayerPawn?.Value;
        if (pawn == null || !pawn.IsValid) return;
        if (pawn.LifeState != (byte)LifeState_t.LIFE_ALIVE)
        {
            p.PrintToChat(" \x06[PropHunt]\x01 You're dead — can't heal.");
            return;
        }
        var key = (ulong)(p.UserId ?? (int)p.Index);
        if (_usedHealThisRound.Contains(key))
        {
            p.PrintToChat(" \x06[PropHunt]\x01 You already used your medishot this round. Resets on round_start.");
            return;
        }
        try
        {
            pawn.Health = HEAL_AMOUNT;
            Utilities.SetStateChanged(pawn, "CBaseEntity", "m_iHealth");
            _usedHealThisRound.Add(key);
            p.PrintToChat($" \x06[PropHunt]\x01 Medishot used — \x04{HEAL_AMOUNT}\x01 HP. (1/round)");
        }
        catch (Exception e)
        {
            Server.PrintToConsole($"[GameCtlPropHunt] heal failed for {p.PlayerName}: {e.Message}");
        }
    }
}
