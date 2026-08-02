package games

import (
	"context"
	"net"
	"strings"
	"testing"
	"time"
)

// fakeQ3Server answers one rcon datagram with the supplied reply chunks,
// echoing back what it received so the test can assert the request framing.
func fakeQ3Server(t *testing.T, replies [][]byte, got chan<- string) string {
	t.Helper()
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { pc.Close() })

	go func() {
		buf := make([]byte, 4096)
		n, addr, err := pc.ReadFrom(buf)
		if err != nil {
			return
		}
		got <- string(buf[:n])
		for _, r := range replies {
			_, _ = pc.WriteTo(r, addr)
		}
	}()
	return pc.LocalAddr().String()
}

func TestRCONQuake3RequestFraming(t *testing.T) {
	got := make(chan string, 1)
	addr := fakeQ3Server(t, [][]byte{[]byte("\xff\xff\xff\xffprint\nmap: mp_afghan\n")}, got)

	out, err := RCONQuake3(context.Background(), addr, "s3cret", "status")
	if err != nil {
		t.Fatalf("RCONQuake3: %v", err)
	}

	req := <-got
	// The connectionless header is what makes this an idTech3 packet rather
	// than a stray UDP payload the engine ignores.
	if !strings.HasPrefix(req, "\xff\xff\xff\xffrcon s3cret status") {
		t.Errorf("request framing wrong: %q", req)
	}
	if out != "map: mp_afghan" {
		t.Errorf("reply not unwrapped: %q", out)
	}
}

// `status` on a populated server arrives as several datagrams; stopping at the
// first one silently truncates the player list.
func TestRCONQuake3MultiDatagramReply(t *testing.T) {
	got := make(chan string, 1)
	addr := fakeQ3Server(t, [][]byte{
		[]byte("\xff\xff\xff\xffprint\nnum score ping\n"),
		[]byte("\xff\xff\xff\xffprint\n  0     0   999 Ghost\n"),
		[]byte("\xff\xff\xff\xffprint\n  1   220   999 Roach\n"),
	}, got)

	out, err := RCONQuake3(context.Background(), addr, "pw", "status")
	if err != nil {
		t.Fatalf("RCONQuake3: %v", err)
	}
	<-got
	for _, want := range []string{"num score ping", "Ghost", "Roach"} {
		if !strings.Contains(out, want) {
			t.Errorf("reply missing %q; got %q", want, out)
		}
	}
}

func TestRCONQuake3BadPassword(t *testing.T) {
	got := make(chan string, 1)
	addr := fakeQ3Server(t, [][]byte{[]byte("\xff\xff\xff\xffprint\nInvalid password.\n")}, got)

	if _, err := RCONQuake3(context.Background(), addr, "wrong", "status"); err == nil {
		t.Fatal("expected an error for an invalid password, got nil")
	}
	<-got
}

// Silent commands are the COMMON case, not an error: `map`, `say`,
// `clientkick` and dvar assignments all execute without printing. Treating
// silence as a failure made every action button report an i/o timeout while
// having actually worked.
func TestRCONQuake3SilentCommandIsNotAnError(t *testing.T) {
	pc, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer pc.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := RCONQuake3(ctx, pc.LocalAddr().String(), "pw", "map mp_rust")
	if err != nil {
		t.Fatalf("a silent command must not error: %v", err)
	}
	if out != "" {
		t.Errorf("expected empty output, got %q", out)
	}
}

// A wrong password is now the only thing that must still fail, since it is
// what separates "executed silently" from "refused".
func TestRCONQuake3BadPasswordVariants(t *testing.T) {
	for _, reply := range []string{"Invalid password.", "Bad rconpassword."} {
		got := make(chan string, 1)
		addr := fakeQ3Server(t, [][]byte{[]byte("\xff\xff\xff\xffprint\n" + reply + "\n")}, got)
		if _, err := RCONQuake3(context.Background(), addr, "wrong", "status"); err == nil {
			t.Errorf("expected an error for %q", reply)
		}
		<-got
	}
}
