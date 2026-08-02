package games

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"time"
)

// Minecraft Server List Ping (modern, post-1.7).
// Protocol:
//   1. Connect TCP, send Handshake packet (next_state=1)
//   2. Send Status Request packet (empty body, id 0x00)
//   3. Read Status Response — JSON with version/players/description
// We don't bother with the optional Ping/Pong roundtrip; latency from the
// status read is good enough for a UI badge.

func init() { Register("minecraft", probeMinecraft) }

// rawStatus mirrors the upstream JSON shape. `description` can be a string
// (legacy) or an object with {text, extra[]} (modern chat-component). We
// normalize both.
type rawStatus struct {
	Version struct {
		Name     string `json:"name"`
		Protocol int    `json:"protocol"`
	} `json:"version"`
	Players struct {
		Max    int `json:"max"`
		Online int `json:"online"`
		Sample []struct {
			Name string `json:"name"`
			ID   string `json:"id"`
		} `json:"sample,omitempty"`
	} `json:"players"`
	Description json.RawMessage `json:"description"`
}

func probeMinecraft(ctx context.Context, addr string, timeout time.Duration) (*Health, error) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, fmt.Errorf("split host:port %q: %w", addr, err)
	}
	var port int
	if _, err := fmt.Sscanf(portStr, "%d", &port); err != nil {
		return nil, fmt.Errorf("bad port %q: %w", portStr, err)
	}

	dialer := net.Dialer{Timeout: timeout}
	conn, err := dialer.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()
	deadline := time.Now().Add(timeout)
	conn.SetDeadline(deadline)

	// Build handshake packet body
	body := []byte{0x00} // packet id: Handshake
	body = appendVarInt(body, -1) // protocol version (-1 = "any")
	body = appendString(body, host)
	body = binary.BigEndian.AppendUint16(body, uint16(port))
	body = appendVarInt(body, 1) // next state = Status

	if err := writePacket(conn, body); err != nil {
		return nil, fmt.Errorf("send handshake: %w", err)
	}
	// Status Request: empty packet, id 0x00
	if err := writePacket(conn, []byte{0x00}); err != nil {
		return nil, fmt.Errorf("send status request: %w", err)
	}

	start := time.Now()
	// Status Response
	if _, err := readVarInt(conn); err != nil { // total packet length
		return nil, fmt.Errorf("read length: %w", err)
	}
	pid, err := readVarInt(conn)
	if err != nil {
		return nil, fmt.Errorf("read packet id: %w", err)
	}
	if pid != 0 {
		return nil, fmt.Errorf("unexpected packet id %d", pid)
	}
	js, err := readString(conn)
	if err != nil {
		return nil, fmt.Errorf("read status json: %w", err)
	}
	latency := time.Since(start).Milliseconds()

	var raw rawStatus
	if err := json.Unmarshal([]byte(js), &raw); err != nil {
		return nil, fmt.Errorf("parse status json: %w", err)
	}

	h := &Health{
		Type:       "minecraft",
		Reachable:  true,
		LatencyMS:  latency,
		Version:    raw.Version.Name,
		MOTD:       flattenMOTD(raw.Description),
		Players:    raw.Players.Online,
		MaxPlayers: raw.Players.Max,
	}
	for _, p := range raw.Players.Sample {
		if p.Name != "" {
			h.PlayerSample = append(h.PlayerSample, p.Name)
		}
	}
	return h, nil
}

// flattenMOTD normalizes the various MOTD encodings (plain string,
// {text, extra[]} chat component) into a single readable string. Strips
// §-prefixed color codes since the UI doesn't render them.
func flattenMOTD(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	// Try plain string first
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return stripColors(s)
	}
	// Try chat component
	var obj struct {
		Text  string          `json:"text"`
		Extra []rawChatChild  `json:"extra,omitempty"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		var b strings.Builder
		b.WriteString(obj.Text)
		for _, c := range obj.Extra {
			b.WriteString(c.flatten())
		}
		return stripColors(b.String())
	}
	return ""
}

type rawChatChild struct {
	Text  string          `json:"text"`
	Extra json.RawMessage `json:"extra,omitempty"`
}

func (c rawChatChild) flatten() string {
	if len(c.Extra) == 0 {
		return c.Text
	}
	// Recurse on the nested extra array
	var children []rawChatChild
	if err := json.Unmarshal(c.Extra, &children); err == nil {
		var b strings.Builder
		b.WriteString(c.Text)
		for _, cc := range children {
			b.WriteString(cc.flatten())
		}
		return b.String()
	}
	return c.Text
}

// stripColors removes Minecraft's § color codes (§a, §6, etc.) and trims.
func stripColors(s string) string {
	var b strings.Builder
	skip := false
	for _, r := range s {
		if skip {
			skip = false
			continue
		}
		if r == '§' {
			skip = true
			continue
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

// --- Minecraft VarInt + length-prefixed-string helpers ---

func appendVarInt(b []byte, n int) []byte {
	ux := uint32(n)
	for {
		if ux&0xFFFFFF80 == 0 {
			return append(b, byte(ux))
		}
		b = append(b, byte(ux&0x7F)|0x80)
		ux >>= 7
	}
}

func readVarInt(r io.Reader) (int, error) {
	var v uint32
	var shift uint
	buf := make([]byte, 1)
	for i := 0; i < 5; i++ {
		if _, err := io.ReadFull(r, buf); err != nil {
			return 0, err
		}
		v |= uint32(buf[0]&0x7F) << shift
		if buf[0]&0x80 == 0 {
			return int(int32(v)), nil
		}
		shift += 7
	}
	return 0, fmt.Errorf("varint too long")
}

func appendString(b []byte, s string) []byte {
	b = appendVarInt(b, len(s))
	return append(b, s...)
}

func readString(r io.Reader) (string, error) {
	n, err := readVarInt(r)
	if err != nil {
		return "", err
	}
	if n < 0 || n > 1<<20 {
		return "", fmt.Errorf("implausible string length %d", n)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return "", err
	}
	return string(buf), nil
}

func writePacket(w io.Writer, data []byte) error {
	var hdr []byte
	hdr = appendVarInt(hdr, len(data))
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	_, err := w.Write(data)
	return err
}
