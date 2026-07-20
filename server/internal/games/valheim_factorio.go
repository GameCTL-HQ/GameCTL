package games

import (
	"context"
	"encoding/binary"
	"fmt"
	"net"
	"time"

	"github.com/rumblefrog/go-a2s"
)

// Valheim and Factorio deep probes.
//
// Both games' Kubernetes Services (per the UI generators) expose ONLY UDP
// ports — neither has a TCP port, so the generic TCP port-open fallback in
// tcp.go can never match and is intentionally not used for them.
//
// Valheim: the dedicated server answers Steam A2S queries on its *query*
// port, which by Valheim convention is the game port + 1. The valheim
// generator emits three UDP Service ports:
//
//	vh-udp-0  -> serverPort      (2456 default)  game/connection
//	vh-udp-1  -> serverPort + 1  (2457 default)  Steam A2S query  <-- probe this
//	vh-udp-2  -> serverPort + 2  (2458 default)  auxiliary
//
// So the PortHint pins name "vh-udp-1" + protocol UDP. Exact name+proto
// match lands on the query port directly. If a future generator renames
// the port, pickProbePort falls back to name-only then UDP-only; the
// UDP-only fallback would pick vh-udp-0 (the game port, not A2S) and the
// probe would return a clean "query info" error rather than misfiring on a
// wrong-protocol port or crashing.
//
// Factorio: Factorio's native multiplayer protocol is a bespoke UDP
// protocol on game-udp (34197). It does NOT speak Source A2S on that port.
// The factorio generator also emits query-udp (27015), the Steam query
// port — but a real A2S info response is only available there when the
// server has Steam server-list registration enabled (factoriotools image:
// the server must be public + token-authed). For a private/LAN homelab
// server nothing answers query-udp (verified live: A2S AND the native
// handshake both time out on 27015). The only port that responds for a
// private server is game-udp, and only to the native connection-request
// handshake. So we probe game-udp with a native UDP liveness handshake:
// it can confirm reachability + latency (not players/version, since the
// native wire format is undocumented and version-specific). This is
// strictly better than the prior query-udp-targeted design, under which
// BOTH probe stages always failed and Factorio showed permanently
// unreachable despite being alive.
//
// NOTE (follow-up, generator change — do NOT make here): a UDP Service port
// alone does not give a guaranteed reachability signal because UDP has no
// handshake; an A2S timeout cannot distinguish "server down" from "Steam
// query disabled". If we want a guaranteed Factorio reachability pill,
// the factorio generator would need to additionally expose a TCP port
// (e.g. the RCON port, name "rcon-tcp") so a TCP port-open probe can
// confirm the container is listening. That requires editing
// kubeUI/src/utils/factorioGenerator.js to add an RCON env var + a
// { name: 'rcon-tcp', port: <rconPort>, protocol: 'TCP' } Service/container
// port, then registering probeTCP for "factorio" with
// PortHint{Protocol:"TCP", PortName:"rcon-tcp"}.

func init() {
	// Valheim: A2S on the query port (game port + 1) == Service port
	// "vh-udp-1". Pin both name and protocol so the picker selects the
	// query port and not the game/aux UDP ports.
	RegisterWithHint("valheim", probeValheim, PortHint{
		Protocol: "UDP",
		PortName: "vh-udp-1",
	})

	// Factorio: probe the *native* game port (game-udp / 34197), NOT the
	// Steam query-udp port. Verified live against factoriotools/factorio:
	// the Steam query port (27015) does NOT answer A2S unless the server is
	// publicly registered with the Steam master server (impossible for a
	// private homelab server — needs a public IP + game-server login
	// token), AND it does not answer the native protocol either. The native
	// connection-request handshake only gets a reply on game-udp:34197.
	// Pinning query-udp here meant BOTH probe stages always failed and
	// Factorio showed permanently unreachable despite being alive. Pin
	// game-udp so the native liveness handshake reaches a port that
	// actually responds.
	RegisterWithHint("factorio", probeFactorio, PortHint{
		Protocol: "UDP",
		PortName: "game-udp",
	})
}

// probeValheim performs a real Steam A2S query against the Valheim query
// port (game port + 1, the port the picker already selected via the
// "vh-udp-1" hint). Valheim's dedicated server fully implements A2S Info
// and A2S Player, so we surface:
//
//	MOTD    -> server display name
//	Map     -> the loaded world name (A2S "Map" field; Valheim puts the
//	           world/save name here)
//	Version -> server build/version string
//	Players / MaxPlayers
//	PlayerSample -> connected player names (Valheim returns these)
//
// The address handed in is host:queryPort; A2S is connectionless UDP and
// lossy on the first datagram, so go-a2s retries internally within the
// timeout.
func probeValheim(ctx context.Context, addr string, timeout time.Duration) (*Health, error) {
	client, err := a2s.NewClient(addr, a2s.TimeoutOption(timeout))
	if err != nil {
		return nil, fmt.Errorf("connect: %w", err)
	}
	defer client.Close()

	start := time.Now()
	info, err := client.QueryInfo()
	if err != nil {
		return nil, fmt.Errorf("A2S query info (is the Valheim query port %s reachable?): %w", addr, err)
	}
	latency := time.Since(start).Milliseconds()

	h := &Health{
		Type:       "valheim",
		Reachable:  true,
		LatencyMS:  latency,
		MOTD:       info.Name,
		Map:        info.Map,
		Version:    info.Version,
		Players:    int(info.Players),
		MaxPlayers: int(info.MaxPlayers),
	}
	if pl, err := client.QueryPlayer(); err == nil && pl != nil {
		for _, p := range pl.Players {
			if p != nil && p.Name != "" {
				h.PlayerSample = append(h.PlayerSample, p.Name)
			}
			if len(h.PlayerSample) >= 10 {
				break
			}
		}
	}
	return h, nil
}

// probeFactorio probes the Factorio *native* game port (game-udp / 34197;
// the picker selected it via the "game-udp" hint).
//
// Factorio has no usable deep query for a private server:
//
//   - Source A2S only answers when the server is publicly registered with
//     the Steam master server (public IP + a valid Steam game-server login
//     token). That is impossible for a private homelab server and the
//     factoriotools image does not answer A2S on the game port at all —
//     verified live: A2S times out on both game-udp and query-udp here.
//   - The native multiplayer wire format is undocumented and changes
//     between game versions, so parsing players/version reliably is
//     impractical.
//
// So this is a native-protocol UDP *liveness* handshake: send Factorio's
// connection-request datagram to game-udp and treat ANY datagram back as
// proof the process is alive and bound. Verified live: the server replies
// (~9 bytes) on game-udp:34197 and is silent on query-udp:27015. This
// surfaces reachability + latency but not players/version — the limitation
// is intentional and documented here. (The earlier two-stage A2S-first
// design pointed at query-udp where nothing ever answered, so Factorio
// always showed unreachable; this path actually gets a response.)
func probeFactorio(ctx context.Context, addr string, timeout time.Duration) (*Health, error) {
	h, err := factorioUDPLiveness(ctx, addr, timeout)
	if err != nil {
		return nil, fmt.Errorf("factorio: native UDP liveness handshake to game port %s got no reply (server down or port not reachable): %w", addr, err)
	}
	return h, nil
}

// factorioUDPLiveness sends a minimal Factorio connection-request datagram
// and waits for any reply, proving the server process is alive and bound
// to the UDP port without attempting to parse the (undocumented, version-
// dependent) multiplayer protocol.
//
// Factorio's network layer frames every packet with a one-byte header
// whose low bits encode a message type. 0x02 is ConnectionRequest. We send
// a short ConnectionRequest with a random connection id; live servers
// answer with a ConnectionRequestReply (or a ConnectionRequestStatus)
// datagram. We do not decode the reply — its presence alone is the signal.
// A dead/unbound port yields an ICMP port-unreachable (read error) or a
// timeout instead.
func factorioUDPLiveness(ctx context.Context, addr string, timeout time.Duration) (*Health, error) {
	d := net.Dialer{Timeout: timeout}
	conn, err := d.DialContext(ctx, "udp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial udp %s: %w", addr, err)
	}
	defer conn.Close()

	deadline := time.Now().Add(timeout)
	_ = conn.SetDeadline(deadline)

	// ConnectionRequest packet:
	//   byte 0: message header (0x02 = ConnectionRequest, no fragment flag)
	//   bytes 1..2: Factorio network protocol version (best-effort; the
	//               server replies regardless to negotiate / reject)
	//   bytes 3..6: random connection request id
	pkt := make([]byte, 7)
	pkt[0] = 0x02
	binary.LittleEndian.PutUint16(pkt[1:3], 0) // protocol version: let server decide
	binary.LittleEndian.PutUint32(pkt[3:7], uint32(time.Now().UnixNano()))

	start := time.Now()
	if _, err := conn.Write(pkt); err != nil {
		return nil, fmt.Errorf("send connection-request: %w", err)
	}

	buf := make([]byte, 1024)
	n, err := conn.Read(buf)
	if err != nil {
		return nil, fmt.Errorf("no reply (server down or port closed): %w", err)
	}
	if n == 0 {
		return nil, fmt.Errorf("empty reply from %s", addr)
	}

	// Any datagram back == the Factorio process is alive and listening.
	// We deliberately do NOT decode it: the multiplayer wire format is
	// undocumented and changes between game versions, so players/version
	// are not available via this path (only via A2S, stage 1).
	return &Health{
		Type:      "factorio",
		Reachable: true,
		LatencyMS: time.Since(start).Milliseconds(),
		MOTD:      "online (UDP liveness; enable Steam server-list registration for player/version detail)",
	}, nil
}
