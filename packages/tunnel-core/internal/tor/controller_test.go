// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"bufio"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"errors"
	"io"
	"net"
	"net/textproto"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestReadReplyFormats(t *testing.T) {
	input := strings.Join([]string{
		"250-ServiceID=abc",
		"250+config-text=",
		"SocksPort 0",
		"..dot stuffed",
		".",
		"250 OK",
		"650 STATUS_CLIENT NOTICE BOOTSTRAP PROGRESS=5",
		"250-first",
		"251 second",
	}, "\r\n") + "\r\n"
	reader := textproto.NewReader(bufio.NewReader(strings.NewReader(input)))
	reply, err := readReply(reader)
	if err != nil {
		t.Fatal(err)
	}
	if reply.status != 250 || len(reply.lines) != 3 || reply.lines[1] != "config-text=SocksPort 0\n.dot stuffed" {
		t.Fatalf("reply = %+v", reply)
	}
	event, err := readReply(reader)
	if err != nil || event.status != statusAsyncEvent {
		t.Fatalf("event = %+v, %v", event, err)
	}
	if _, err := readReply(reader); err == nil {
		t.Fatal("status change inside a reply was accepted")
	}
	for _, bad := range []string{"25\r\n", "abc OK\r\n", "250*OK\r\n"} {
		if _, err := readReply(textproto.NewReader(bufio.NewReader(strings.NewReader(bad)))); err == nil {
			t.Errorf("readReply(%q) accepted", bad)
		}
	}
}

func TestParseArgumentsAndBootstrap(t *testing.T) {
	words, keywords := parseArguments(`METHODS=COOKIE,SAFECOOKIE COOKIEFILE="C:\\Tor data\\cookie \"x\"" bare`)
	if keywords["METHODS"] != "COOKIE,SAFECOOKIE" || keywords["COOKIEFILE"] != `C:\Tor data\cookie "x"` || len(words) != 1 || words[0] != "bare" {
		t.Fatalf("words %q keywords %q", words, keywords)
	}
	status, ok := parseBootstrap(`NOTICE BOOTSTRAP PROGRESS=37 TAG=loading_descriptors SUMMARY="Loading relay descriptors"`)
	if !ok || status.Progress != 37 || status.Tag != "loading_descriptors" || status.Summary != "Loading relay descriptors" || status.Warning != "" {
		t.Fatalf("status = %+v", status)
	}
	status, ok = parseBootstrap(`WARN BOOTSTRAP PROGRESS=10 TAG=conn_done SUMMARY="Connected" WARNING="Connection refused" REASON=CONNECTREFUSED`)
	if !ok || status.Warning != "Connection refused" {
		t.Fatalf("warning status = %+v", status)
	}
	for _, bad := range []string{"NOTICE CIRCUIT_ESTABLISHED", "NOTICE BOOTSTRAP PROGRESS=101", "NOTICE BOOTSTRAP"} {
		if _, ok := parseBootstrap(bad); ok {
			t.Errorf("parseBootstrap(%q) accepted", bad)
		}
	}
}

func TestOnionRequestCommand(t *testing.T) {
	key, err := GenerateOnionKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	command, err := onionRequest{key: key, virtualPort: OnionPort, target: "127.0.0.1:4100", nonAnonymous: true}.command()
	if err != nil {
		t.Fatal(err)
	}
	want := "ADD_ONION ED25519-V3:" + key.torBlob() + " Flags=NonAnonymous Port=443,127.0.0.1:4100"
	if command != want {
		t.Fatalf("command = %q", command)
	}
	clientKey, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encoded := strings.ToLower(serviceIDEncoding.EncodeToString(clientKey.PublicKey().Bytes()))
	command, err = onionRequest{key: key, virtualPort: OnionPort, target: "127.0.0.1:4100", nonAnonymous: true, clientAuthV3: []string{encoded}}.command()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(command, " Flags=NonAnonymous,V3Auth ") || !strings.HasSuffix(command, " ClientAuthV3="+encoded) {
		t.Fatalf("client auth command = %q", command)
	}
	invalid := []onionRequest{
		{virtualPort: OnionPort, target: "127.0.0.1:1"},
		{key: key, virtualPort: 0, target: "127.0.0.1:1"},
		{key: key, virtualPort: OnionPort, target: "127.0.0.1"},
		{key: key, virtualPort: OnionPort, target: "127.0.0.1:1 Flags=Detach"},
		{key: key, virtualPort: OnionPort, target: "127.0.0.1:1", clientAuthV3: []string{"short"}},
	}
	for index, request := range invalid {
		if _, err := request.command(); err == nil {
			t.Errorf("invalid request %d accepted", index)
		}
	}
}

func TestSplitEndpoint(t *testing.T) {
	good := []string{"127.0.0.1:9050", "[::1]:9051"}
	bad := []string{"", "10.0.0.1:9050", "localhost:9050", "127.0.0.1:0", "127.0.0.1:99999", "unix:relative", "unix:"}
	if runtime.GOOS == "windows" {
		bad = append(bad, "unix:/var/run/tor/socks")
	} else {
		good = append(good, "unix:/var/run/tor/socks")
	}
	for _, good := range good {
		if _, _, err := splitEndpoint(good); err != nil {
			t.Errorf("splitEndpoint(%q) = %v", good, err)
		}
	}
	for _, bad := range bad {
		if _, _, err := splitEndpoint(bad); err == nil {
			t.Errorf("splitEndpoint(%q) accepted", bad)
		}
	}
}

// startFakeTor runs a fake tor from a generated torrc and returns it with its
// control address and cookie path.
func startFakeTor(t *testing.T) (*fakeTor, string, string) {
	t.Helper()
	dir := t.TempDir()
	cookie := filepath.Join(dir, "cookie")
	portFile := filepath.Join(dir, "port")
	contents, err := renderTorrc(torrcOptions{role: roleClient, dataDir: dir, controlPortFile: portFile, cookieFile: cookie, ownerPID: os.Getpid()})
	if err != nil {
		t.Fatal(err)
	}
	torrc := filepath.Join(dir, "torrc")
	if err := os.WriteFile(torrc, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	fake := newFakeTor(context.Background(), []string{"-f", torrc}, fakeBehavior{})
	if err := fake.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { fake.exit(nil) })
	data, err := os.ReadFile(portFile)
	if err != nil {
		t.Fatal(err)
	}
	address, ok := parseControlPortFile(string(data))
	if !ok {
		t.Fatalf("control port file = %q", data)
	}
	return fake, address, cookie
}

func TestAuthenticateSafeCookieAgainstFakeTor(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	fake, address, cookie := startFakeTor(t)
	control, err := dialControl(ctx, address)
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	if err := control.authenticate(ctx, cookie); err != nil {
		t.Fatal(err)
	}
	status, err := control.bootstrap(ctx)
	if err != nil || status.Progress != 0 || status.Tag != "starting" {
		t.Fatalf("bootstrap = %+v, %v", status, err)
	}
	var unknown *ControlError
	if _, err := control.do(ctx, "FROBNICATE"); !errors.As(err, &unknown) || unknown.Status != 510 {
		t.Fatalf("unknown command err = %v", err)
	}
	if got := fake.received(); !strings.HasPrefix(got[0], "PROTOCOLINFO") || !strings.HasPrefix(got[1], "AUTHCHALLENGE SAFECOOKIE ") {
		t.Fatalf("commands = %q", got)
	}

	// A cookie the listener does not know fails before AUTHENTICATE is sent,
	// so a fake control port cannot learn a valid proof.
	wrong := filepath.Join(t.TempDir(), "cookie")
	if err := os.WriteFile(wrong, make([]byte, cookieLength), 0o600); err != nil {
		t.Fatal(err)
	}
	proofs := func() int {
		count := 0
		for _, command := range fake.received() {
			if strings.HasPrefix(command, "AUTHENTICATE ") {
				count++
			}
		}
		return count
	}
	before := proofs()
	other, err := dialControl(ctx, address)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if err := other.authenticate(ctx, wrong); !errors.Is(err, ErrCookieMismatch) {
		t.Fatalf("wrong cookie err = %v", err)
	}
	if proofs() != before {
		t.Fatal("a proof was sent for the wrong cookie")
	}
	short := filepath.Join(t.TempDir(), "short")
	if err := os.WriteFile(short, []byte("abc"), 0o600); err != nil {
		t.Fatal(err)
	}
	third, err := dialControl(ctx, address)
	if err != nil {
		t.Fatal(err)
	}
	defer third.Close()
	if err := third.authenticate(ctx, short); err == nil {
		t.Fatal("short cookie accepted")
	}
}

// scriptedControl serves one connection with handle, which receives each
// command line and writes raw protocol text.
func scriptedControl(t *testing.T, handle func(line string, conn net.Conn)) *controlConn {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		reader := textproto.NewReader(bufio.NewReader(conn))
		for {
			line, err := reader.ReadLine()
			if err != nil {
				return
			}
			handle(line, conn)
		}
	}()
	control, err := dialControl(context.Background(), listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = control.Close() })
	return control
}

func TestEventsDoNotBlockCommandsAndStayBounded(t *testing.T) {
	control := scriptedControl(t, func(line string, conn net.Conn) {
		var text strings.Builder
		for index := range maxQueuedEvents + 5 {
			text.WriteString("650 STATUS_CLIENT NOTICE BOOTSTRAP PROGRESS=" + string(rune('0'+index%10)) + "\r\n")
		}
		text.WriteString("650-HS_DESC UPLOADED abc\r\n650 extra\r\n")
		text.WriteString("250 OK\r\n")
		_, _ = io.WriteString(conn, text.String())
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := control.do(ctx, "SETEVENTS STATUS_CLIENT"); err != nil {
		t.Fatal(err)
	}
	control.mu.Lock()
	queued := len(control.events)
	last := control.events[queued-1]
	control.mu.Unlock()
	if queued != maxQueuedEvents || last != "HS_DESC UPLOADED abc\nextra" {
		t.Fatalf("queued %d events, last %q", queued, last)
	}
	event, err := control.nextEvent(ctx)
	if err != nil || !strings.HasPrefix(event, "STATUS_CLIENT") {
		t.Fatalf("nextEvent = %q, %v", event, err)
	}
}

func TestCancelledCommandClosesConnection(t *testing.T) {
	control := scriptedControl(t, func(string, net.Conn) {})
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := control.do(ctx, "GETINFO version"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("err = %v", err)
	}
	if _, err := control.do(context.Background(), "GETINFO version"); !errors.Is(err, ErrControlClosed) {
		t.Fatalf("command after cancel err = %v", err)
	}
	if _, err := control.nextEvent(context.Background()); !errors.Is(err, ErrControlClosed) {
		t.Fatalf("nextEvent after close err = %v", err)
	}
	if _, err := control.do(context.Background(), "GETINFO a\r\nSIGNAL HALT"); err == nil {
		t.Fatal("command with a line break was sent")
	}
}

func TestWriteDeadlineDoesNotLeakIntoNextCommand(t *testing.T) {
	control := scriptedControl(t, func(_ string, conn net.Conn) {
		_, _ = io.WriteString(conn, "250 OK\r\n")
	})
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	if _, err := control.do(ctx, "SETEVENTS"); err != nil {
		t.Fatal(err)
	}
	cancel()
	time.Sleep(60 * time.Millisecond)
	if _, err := control.do(context.Background(), "SETEVENTS"); err != nil {
		t.Fatalf("command after an expired deadline: %v", err)
	}
}

func TestUnsolicitedReplyClosesConnection(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			_, _ = io.WriteString(conn, "250 OK\r\n250 OK\r\n")
			time.Sleep(time.Second)
			_ = conn.Close()
		}
	}()
	control, err := dialControl(context.Background(), listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer control.Close()
	select {
	case <-control.done:
	case <-time.After(5 * time.Second):
		t.Fatal("connection stayed open after unsolicited replies")
	}
}
