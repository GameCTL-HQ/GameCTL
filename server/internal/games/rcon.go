package games

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"time"
)

// Minimal Source RCON client (Valve's SERVERDATA TCP protocol) — enough to
// authenticate and run a sequence of console commands against a running CS2
// server. Used for live, no-restart config changes from the manage screen.
//
// Packet: int32 size | int32 id | int32 type | body(NUL) | NUL
// types: 3 = SERVERDATA_AUTH, 2 = SERVERDATA_EXECCOMMAND / AUTH_RESPONSE,
//        0 = SERVERDATA_RESPONSE_VALUE.

const (
	rconAuth        = 3
	rconExec        = 2
	rconRespValue   = 0
	rconAuthFailID  = -1
	rconWritebufCap = 4096
)

func rconPacket(id, typ int32, body string) []byte {
	b := new(bytes.Buffer)
	payload := new(bytes.Buffer)
	binary.Write(payload, binary.LittleEndian, id)
	binary.Write(payload, binary.LittleEndian, typ)
	payload.WriteString(body)
	payload.WriteByte(0) // body terminator
	payload.WriteByte(0) // packet terminator
	binary.Write(b, binary.LittleEndian, int32(payload.Len()))
	b.Write(payload.Bytes())
	return b.Bytes()
}

func rconReadPacket(conn net.Conn) (id, typ int32, body string, err error) {
	var sz int32
	if err = binary.Read(conn, binary.LittleEndian, &sz); err != nil {
		return
	}
	if sz < 10 || sz > rconWritebufCap {
		return 0, 0, "", fmt.Errorf("rcon: bad packet size %d", sz)
	}
	buf := make([]byte, sz)
	if _, err = io.ReadFull(conn, buf); err != nil {
		return
	}
	id = int32(binary.LittleEndian.Uint32(buf[0:4]))
	typ = int32(binary.LittleEndian.Uint32(buf[4:8]))
	body = string(bytes.TrimRight(buf[8:], "\x00"))
	return
}

// RCON connects, authenticates, runs each command in order, and returns the
// concatenated server output. Total operation bounded by `timeout`.
func RCON(ctx context.Context, addr, password string, cmds []string) (string, error) {
	if password == "" {
		return "", fmt.Errorf("rcon: no password configured for this server")
	}
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return "", fmt.Errorf("rcon dial %s: %w", addr, err)
	}
	defer conn.Close()
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	} else {
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	}

	if _, err = conn.Write(rconPacket(1, rconAuth, password)); err != nil {
		return "", fmt.Errorf("rcon auth send: %w", err)
	}
	// Server replies with an (empty) RESPONSE_VALUE then an AUTH_RESPONSE
	// whose id == -1 on failure. Read until we see the auth response.
	for {
		id, typ, _, rerr := rconReadPacket(conn)
		if rerr != nil {
			return "", fmt.Errorf("rcon auth read: %w", rerr)
		}
		if typ == rconExec { // AUTH_RESPONSE
			if id == rconAuthFailID {
				return "", fmt.Errorf("rcon: authentication failed (bad password)")
			}
			break
		}
	}

	var out bytes.Buffer
	for _, c := range cmds {
		if _, err = conn.Write(rconPacket(2, rconExec, c)); err != nil {
			return out.String(), fmt.Errorf("rcon exec %q: %w", c, err)
		}
		_, typ, body, rerr := rconReadPacket(conn)
		if rerr != nil {
			return out.String(), fmt.Errorf("rcon read %q: %w", c, rerr)
		}
		if typ == rconRespValue && body != "" {
			out.WriteString(body)
		}
	}
	return out.String(), nil
}
