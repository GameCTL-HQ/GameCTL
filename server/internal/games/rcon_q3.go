package games

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"
)

// idTech3 ("Quake 3") connectionless RCON over UDP — the protocol IW4x, and
// every other idTech3 descendant, actually speaks. Not to be confused with
// Valve's Source RCON in rcon.go, which is TCP, stateful, and authenticates
// once per connection.
//
// Wire format is a single fire-and-forget datagram, with the reply arriving as
// one or more datagrams carrying the same connectionless header:
//
//	→  FF FF FF FF "rcon <password> <command>"
//	←  FF FF FF FF "print\n<output>"
//
// There is no auth handshake and no session: the password rides on every
// command, in cleartext. That is worth knowing operationally — it shares the
// game port, so it must stay off any public tunnel (see the note in
// rcon_console.go).
//
// Replies can span several datagrams (`status` on a full server does), so we
// keep reading until a short idle gap rather than stopping at the first one.

const (
	q3RconIdle = 350 * time.Millisecond // gap that marks "reply finished"
	q3RconMax  = 64 * 1024              // cap on assembled reply
)

// RCONQuake3 sends one console command and returns the server's printed
// output with the connectionless framing removed.
func RCONQuake3(ctx context.Context, addr, password, cmd string) (string, error) {
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "udp", addr)
	if err != nil {
		return "", fmt.Errorf("dial: %w", err)
	}
	defer conn.Close()

	deadline := time.Now().Add(6 * time.Second)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	_ = conn.SetDeadline(deadline)

	if _, err := conn.Write([]byte("\xff\xff\xff\xffrcon " + password + " " + cmd)); err != nil {
		return "", fmt.Errorf("send: %w", err)
	}

	var out strings.Builder
	buf := make([]byte, 8192)
	for out.Len() < q3RconMax {
		n, err := conn.Read(buf)
		if err != nil {
			// Silence is NOT an error here. Only queries print: `status` and a
			// bare dvar name answer, while `map`, `say`, `clientkick` and any
			// `<dvar> <value>` assignment execute and say nothing at all. An
			// earlier version treated no-reply as a failure, which made every
			// action button in the manage panel report an i/o timeout while
			// having actually worked.
			//
			// A wrong password is still caught: the engine answers that with a
			// printed refusal (handled below), so it does not look like a
			// silent success.
			break
		}
		out.Write(stripQ3Header(buf[:n]))
		// Subsequent datagrams of a multi-part reply follow immediately;
		// anything slower than this means the server has finished.
		_ = conn.SetReadDeadline(time.Now().Add(q3RconIdle))
	}

	text := out.String()
	// With silence now meaning success, a printed refusal is the only signal
	// left that the password was wrong — so match the wordings the engines
	// actually use ("Invalid password.", "Bad rconpassword.").
	low := strings.ToLower(text)
	if strings.Contains(low, "invalid password") || strings.Contains(low, "bad rconpassword") {
		return "", fmt.Errorf("invalid rcon password")
	}
	return strings.TrimRight(text, "\n"), nil
}

// stripQ3Header removes the 0xFFFFFFFF connectionless prefix and the "print\n"
// tag that precedes command output.
func stripQ3Header(b []byte) []byte {
	if len(b) >= 4 && b[0] == 0xff && b[1] == 0xff && b[2] == 0xff && b[3] == 0xff {
		b = b[4:]
	}
	if rest, ok := cutPrefix(b, []byte("print\n")); ok {
		b = rest
	}
	return b
}

func cutPrefix(b, prefix []byte) ([]byte, bool) {
	if len(b) >= len(prefix) && string(b[:len(prefix)]) == string(prefix) {
		return b[len(prefix):], true
	}
	return b, false
}
