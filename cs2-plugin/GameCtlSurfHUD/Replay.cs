using System.Text.Json;
using System.Text.Json.Serialization;

namespace GameCtlSurfHUD;

// Replay — per-tick recording of a surf run's pos / angles / button
// state, persisted on PB-beat alongside gamectl_surf_records.json.
// On `!replay` an admin spawns a ghost bot whose pawn we teleport
// frame-by-frame from the recording, with a WASD overlay so
// spectators can see the player's input pattern.
//
// File: /home/steam/cs2/gamectl_surf_replays/<map>__<sid>.json
//   Versioned + JSON so it's easy to inspect / hand-edit / migrate.
//   Tick rate: one frame per OnTick (game tick) — file size ~500KB
//   for a 5-minute run at 128tick which is fine on the NFS PVC.

public sealed class ReplayFrame
{
    // Pos (3 floats) — write as separate fields rather than a nested
    // Vector so the JSON stays one-line-per-frame readable.
    [JsonPropertyName("x")]    public float X       { get; set; }
    [JsonPropertyName("y")]    public float Y       { get; set; }
    [JsonPropertyName("z")]    public float Z       { get; set; }
    // View angles. Yaw is the one we care most about — players watch
    // the ghost camera direction to learn route. Pitch + roll for
    // completeness.
    [JsonPropertyName("p")]    public float Pitch   { get; set; }
    [JsonPropertyName("yaw")]  public float Yaw     { get; set; }
    [JsonPropertyName("r")]    public float Roll    { get; set; }
    // Input button bitmask captured at this tick. Decoded against
    // ReplayButtons.* constants for the WASD HUD.
    [JsonPropertyName("b")]    public ulong Buttons { get; set; }
}

public sealed class ReplayFile
{
    [JsonPropertyName("version")]      public int    Version    { get; set; } = 1;
    [JsonPropertyName("map")]          public string Map        { get; set; } = "";
    [JsonPropertyName("sid")]          public string Sid        { get; set; } = "";
    [JsonPropertyName("name")]         public string Name       { get; set; } = "";
    [JsonPropertyName("time_ms")]      public long   TimeMs     { get; set; }
    [JsonPropertyName("finished_at")]  public string FinishedAt { get; set; } = "";
    [JsonPropertyName("tick_interval")] public float TickInterval { get; set; } = 1.0f / 64f;
    [JsonPropertyName("frames")]       public List<ReplayFrame> Frames { get; set; } = new();
}

// CS2 button bit constants — used by both the recorder (filter bits
// we care about) and the overlay (test each bit for the HUD char).
// Sourced from CCSPlayer_MovementServices field names in the schema.
public static class ReplayButtons
{
    public const ulong ATTACK    = 1UL << 0;
    public const ulong JUMP      = 1UL << 1;
    public const ulong DUCK      = 1UL << 2;
    public const ulong FORWARD   = 1UL << 3;
    public const ulong BACK      = 1UL << 4;
    public const ulong USE       = 1UL << 5;
    public const ulong MOVELEFT  = 1UL << 9;
    public const ulong MOVERIGHT = 1UL << 10;
    public const ulong ATTACK2   = 1UL << 11;
    public const ulong RELOAD    = 1UL << 13;
    // We render only the movement / jump / duck subset for the WASD HUD.
    public const ulong MOVEMENT_MASK = FORWARD | BACK | MOVELEFT | MOVERIGHT | JUMP | DUCK;
}

// Format a buttons bitmask as a WASD-ish HUD line. Active keys
// uppercase + bracketed, inactive lowercase. Compact for PrintToCenter.
// Example output:
//   "[W]    s   [A] [D]  jump  duck"  vs  "w s a d  jump duck"
public static class ReplayHud
{
    public static string FormatButtons(ulong b)
    {
        // Use unicode arrows / blocks since CS2's HUD font supports them.
        string w = (b & ReplayButtons.FORWARD)   != 0 ? "■W" : "·w";
        string s = (b & ReplayButtons.BACK)      != 0 ? "■S" : "·s";
        string a = (b & ReplayButtons.MOVELEFT)  != 0 ? "■A" : "·a";
        string d = (b & ReplayButtons.MOVERIGHT) != 0 ? "■D" : "·d";
        string j = (b & ReplayButtons.JUMP)      != 0 ? "■JUMP" : "·jump";
        string c = (b & ReplayButtons.DUCK)      != 0 ? "■DUCK" : "·duck";
        return $"{w} {s} {a} {d}  {j} {c}";
    }
}
