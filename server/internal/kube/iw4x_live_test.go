package kube

import "testing"

// Real output captured from a running IW4x server (bots spawned, colour codes
// and all). The column layout is fiddly enough that a regex change should have
// to justify itself against this.
const sampleStatus = `map: mp_afghan
num score ping guid                             name            lastmsg address               qport rate
--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----
  0     0  999                             bot0 Ghost^7             14300 00000000.000000000000:0    1 99999
  1   220  999                             bot1 Roach^7             13750 00000000.000000000000:256    2 99999
  2   -10   48 110000112345678                  RealPlayer^7          250 10.0.0.50:28960     3 25000
`

func TestIW4XStatusParse(t *testing.T) {
	got := IW4XStatusParse(sampleStatus)
	if len(got) != 3 {
		t.Fatalf("expected 3 players, got %d: %+v", len(got), got)
	}

	if got[0].Name != "Ghost" {
		t.Errorf("colour code not stripped: %q", got[0].Name)
	}
	if !got[0].IsBot || !got[1].IsBot {
		t.Errorf("botN guids should be detected as bots: %+v", got[:2])
	}
	if got[1].Score != 220 {
		t.Errorf("score parse: got %d want 220", got[1].Score)
	}

	// The human: real guid, real ping, and a negative score (which happens
	// after a suicide and must not break the row match).
	p := got[2]
	if p.IsBot {
		t.Errorf("a real client with a steam guid must not be flagged a bot: %+v", p)
	}
	if p.Name != "RealPlayer" || p.Ping != 48 || p.Score != -10 {
		t.Errorf("human row parsed wrong: %+v", p)
	}
	// The admin panel adds players by GUID, so losing it here would leave the
	// "+ PlayerName" buttons submitting nothing.
	if p.GUID != "110000112345678" {
		t.Errorf("guid not captured: %q", p.GUID)
	}
	if got[0].GUID != "bot0" {
		t.Errorf("bot guid not captured: %q", got[0].GUID)
	}
}

// An empty server prints the header and nothing else; that must yield no
// players rather than a phantom row from the dashes separator.
func TestIW4XStatusParseEmpty(t *testing.T) {
	const empty = `map: mp_rust
num score ping guid                             name            lastmsg address               qport rate
--- ----- ---- -------------------------------- --------------- ------- --------------------- ----- -----
`
	if got := IW4XStatusParse(empty); len(got) != 0 {
		t.Fatalf("expected no players, got %+v", got)
	}
}

func TestParseDvar(t *testing.T) {
	cases := map[string]string{
		`"g_gametype" is: "war^7" default: "war^7"`:          "war",
		`"mapname" is: "mp_afghan^7" default: "mp_afghan^7"`: "mp_afghan",
		`"bots_manage_fill" is: "8^7" default: "0^7"`:        "8",
		`Unknown command "nonsense"`:                         "",
	}
	for in, want := range cases {
		if got := parseDvar(in); got != want {
			t.Errorf("parseDvar(%q) = %q, want %q", in, got, want)
		}
	}
}
