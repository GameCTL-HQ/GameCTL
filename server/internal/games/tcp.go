package games

import (
	"context"
	"net"
	"time"
)

// Generic TCP port-open probe. Use as a fallback for games whose protocol
// we don't speak yet — confirms the game server is listening, no protocol
// info (motd / version / players).
//
// Register via games.Register("<game-id>", probeTCP) per game, or as a
// catch-all once we add a default-probe mechanism.

func init() {
	tcp := PortHint{Protocol: "TCP"}
	// Plain TCP port-open fallback for games whose deeper protocol isn't
	// implemented (or worth implementing) yet.
	//
	// NOTE: factorio is intentionally NOT registered here. The factorio
	// generator's Service exposes only UDP ports (game-udp, query-udp) —
	// there is no "query-tcp" port, so a TCP hint never matched and the
	// probe was silently skipped. Factorio now has a best-effort A2S probe
	// on query-udp registered in valheim_factorio.go.
	// terraria is intentionally NOT registered. Vanilla TerrariaServer.exe
	// treats every incoming TCP connection as a partial join attempt and
	// triggers a full world save+validate+backup cycle, which blocks the
	// main thread long enough that real clients accept the TCP socket
	// ("found server" client-side) but never get a handshake reply.
	// Probing the game port at any cadence stalls every join. Rely on pod
	// status for the Online pill instead.
	RegisterWithHint("ts3", probeTCP, tcp)
	// Satisfactory's HTTP probe doesn't have a stable path across container
	// versions; fall back to plain TCP on the tcp-game port to confirm Online.
	RegisterWithHint("satisfactory", probeTCP, PortHint{Protocol: "TCP", PortName: "tcp-game"})
	// quake3's service is pure-UDP — no TCP port to probe. Skip
	// registration so the UI just shows the basic Online pill without a
	// failed probe error line. (Valheim is also pure-UDP but DOES speak
	// Steam A2S on its query port — see valheim_factorio.go.)
}

func probeTCP(ctx context.Context, addr string, timeout time.Duration) (*Health, error) {
	dialer := net.Dialer{Timeout: timeout}
	start := time.Now()
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, err
	}
	conn.Close()
	return &Health{
		Type:      "tcp",
		Reachable: true,
		LatencyMS: time.Since(start).Milliseconds(),
	}, nil
}
