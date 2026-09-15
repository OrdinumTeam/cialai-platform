// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cretz/bine/process"
	"github.com/cretz/bine/torutil"
	tored25519 "github.com/cretz/bine/torutil/ed25519"
)

// fakeTorEnv turns the test binary into a fake tor, so the exec path and the
// child lifecycle are covered without the real binary.
const fakeTorEnv = "CIALAI_FAKE_TOR"

const fakeTorVersion = "Tor version 0.4.9.12-fake."

func TestMain(m *testing.M) {
	if os.Getenv(fakeTorEnv) == "1" {
		os.Exit(runFakeTorProcess(os.Args[1:]))
	}
	if mode := os.Getenv(ownerEnv); mode != "" {
		os.Exit(runOwnerProcess(mode))
	}
	os.Exit(m.Run())
}

func runFakeTorProcess(args []string) int {
	if len(args) == 1 && args[0] == "--version" {
		fmt.Println(fakeTorVersion)
		return 0
	}
	tor := newFakeTor(context.Background(), args, fakeBehavior{})
	if err := tor.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := tor.Wait(); err != nil {
		return 1
	}
	return 0
}

type fakeBehavior struct {
	// wrongServiceID makes ADD_ONION answer with another service id.
	wrongServiceID bool
	// ignoreShutdown answers SIGNAL SHUTDOWN without exiting.
	ignoreShutdown bool
	// noUpload only reports uploads of other services.
	noUpload bool
	// failStart makes Start fail like a binary that cannot run.
	failStart bool
}

// fakeCreator is a bine process.Creator whose processes are fake tors running
// in this test process.
type fakeCreator struct {
	behavior fakeBehavior

	mu      sync.Mutex
	started []*fakeTor
	changed chan struct{}
}

func newFakeCreator(behavior fakeBehavior) *fakeCreator {
	return &fakeCreator{behavior: behavior, changed: make(chan struct{})}
}

func (creator *fakeCreator) New(ctx context.Context, args ...string) (process.Process, error) {
	tor := newFakeTor(ctx, args, creator.behavior)
	creator.mu.Lock()
	creator.started = append(creator.started, tor)
	close(creator.changed)
	creator.changed = make(chan struct{})
	creator.mu.Unlock()
	return tor, nil
}

// waitInstance returns the index-th fake tor once it was created.
func (creator *fakeCreator) waitInstance(t *testing.T, index int) *fakeTor {
	t.Helper()
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
	for {
		creator.mu.Lock()
		count, changed := len(creator.started), creator.changed
		var tor *fakeTor
		if count > index {
			tor = creator.started[index]
		}
		creator.mu.Unlock()
		if tor != nil {
			return tor
		}
		select {
		case <-changed:
		case <-timer.C:
			t.Fatalf("fake tor %d was never started", index)
		}
	}
}

func (creator *fakeCreator) count() int {
	creator.mu.Lock()
	defer creator.mu.Unlock()
	return len(creator.started)
}

type fakeTor struct {
	ctx      context.Context
	args     []string
	behavior fakeBehavior
	exited   chan struct{}

	mu         sync.Mutex
	listener   net.Listener
	cookie     []byte
	cookiePath string
	torrc      map[string]string
	commands   []string
	conns      map[net.Conn]struct{}
	services   []string
	network    bool
	exitErr    error
	exitOnce   sync.Once
}

func newFakeTor(ctx context.Context, args []string, behavior fakeBehavior) *fakeTor {
	return &fakeTor{
		ctx:      ctx,
		args:     args,
		behavior: behavior,
		exited:   make(chan struct{}),
		conns:    map[net.Conn]struct{}{},
	}
}

func (tor *fakeTor) Start() error {
	if tor.behavior.failStart {
		return errors.New("fork/exec tor: permission denied")
	}
	torrc, err := readFakeTorrc(tor.args)
	if err != nil {
		return err
	}
	cookie := make([]byte, cookieLength)
	if _, err := rand.Read(cookie); err != nil {
		return err
	}
	if err := os.WriteFile(torrc["CookieAuthFile"], cookie, 0o600); err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	if err := os.WriteFile(torrc["ControlPortWriteToFile"], []byte("PORT="+listener.Addr().String()+"\n"), 0o600); err != nil {
		_ = listener.Close()
		return err
	}
	tor.mu.Lock()
	tor.listener, tor.cookie, tor.cookiePath, tor.torrc = listener, cookie, torrc["CookieAuthFile"], torrc
	tor.mu.Unlock()
	go tor.accept(listener)
	go func() {
		select {
		case <-tor.ctx.Done():
			tor.exit(errors.New("signal: killed"))
		case <-tor.exited:
		}
	}()
	return nil
}

func (tor *fakeTor) Wait() error {
	<-tor.exited
	tor.mu.Lock()
	defer tor.mu.Unlock()
	return tor.exitErr
}

func (*fakeTor) EmbeddedControlConn() (net.Conn, error) {
	return nil, process.ErrControlConnUnsupported
}

// crash ends the fake like a process that died on its own.
func (tor *fakeTor) crash() { tor.exit(errors.New("exit status 1")) }

func (tor *fakeTor) exit(err error) {
	tor.exitOnce.Do(func() {
		tor.mu.Lock()
		tor.exitErr = err
		if tor.listener != nil {
			_ = tor.listener.Close()
		}
		for conn := range tor.conns {
			_ = conn.Close()
		}
		// Closed under mu so accept never registers a connection afterwards.
		close(tor.exited)
		tor.mu.Unlock()
	})
}

func (tor *fakeTor) waitExit(t *testing.T) {
	t.Helper()
	select {
	case <-tor.exited:
	case <-time.After(10 * time.Second):
		t.Fatal("fake tor is still running")
	}
}

func (tor *fakeTor) hasExited() bool {
	select {
	case <-tor.exited:
		return true
	default:
		return false
	}
}

func (tor *fakeTor) received() []string {
	tor.mu.Lock()
	defer tor.mu.Unlock()
	return slices.Clone(tor.commands)
}

func (tor *fakeTor) accept(listener net.Listener) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			return
		}
		tor.mu.Lock()
		if tor.hasExited() {
			tor.mu.Unlock()
			_ = conn.Close()
			return
		}
		tor.conns[conn] = struct{}{}
		tor.mu.Unlock()
		go tor.serve(conn)
	}
}

// serve speaks the subset of the control protocol used by this package.
func (tor *fakeTor) serve(conn net.Conn) {
	reader := textproto.NewReader(bufio.NewReader(conn))
	var writeMu sync.Mutex
	write := func(lines ...string) {
		writeMu.Lock()
		defer writeMu.Unlock()
		_, _ = io.WriteString(conn, strings.Join(lines, "\r\n")+"\r\n")
	}
	authenticated, owner := false, false
	var clientNonce, serverNonce []byte
	events := ""
	defer func() {
		_ = conn.Close()
		tor.mu.Lock()
		delete(tor.conns, conn)
		tor.mu.Unlock()
		if owner {
			tor.exit(nil)
		}
	}()
	for {
		line, err := reader.ReadLine()
		if err != nil {
			return
		}
		tor.mu.Lock()
		tor.commands = append(tor.commands, line)
		cookie, cookiePath := tor.cookie, tor.cookiePath
		tor.mu.Unlock()
		verb, rest, _ := strings.Cut(line, " ")
		if !authenticated && !slices.Contains([]string{"PROTOCOLINFO", "AUTHCHALLENGE", "AUTHENTICATE"}, verb) {
			write("514 Authentication required.")
			return
		}
		switch verb {
		case "PROTOCOLINFO":
			write("250-PROTOCOLINFO 1",
				fmt.Sprintf("250-AUTH METHODS=COOKIE,SAFECOOKIE COOKIEFILE=%q", cookiePath),
				`250-VERSION Tor="0.4.8.fake"`,
				"250 OK")
		case "AUTHCHALLENGE":
			nonce, err := hex.DecodeString(strings.TrimPrefix(rest, "SAFECOOKIE "))
			if err != nil || len(nonce) != cookieLength {
				write("513 Invalid base16 client nonce")
				return
			}
			clientNonce = nonce
			serverNonce = make([]byte, cookieLength)
			_, _ = rand.Read(serverNonce)
			write(fmt.Sprintf("250 AUTHCHALLENGE SERVERHASH=%X SERVERNONCE=%X",
				cookieHMAC(safeCookieServer, cookie, clientNonce, serverNonce), serverNonce))
		case "AUTHENTICATE":
			proof, err := hex.DecodeString(rest)
			if err != nil || clientNonce == nil || !hmac.Equal(proof, cookieHMAC(safeCookieClient, cookie, clientNonce, serverNonce)) {
				write("515 Authentication failed: Safe cookie response did not match expected value.")
				return
			}
			authenticated = true
			write("250 OK")
		case "TAKEOWNERSHIP":
			owner = true
			write("250 OK")
		case "SETEVENTS":
			events = rest
			write("250 OK")
		case "GETINFO":
			tor.mu.Lock()
			progress := `NOTICE BOOTSTRAP PROGRESS=0 TAG=starting SUMMARY="Starting"`
			if tor.network {
				progress = `NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"`
			}
			tor.mu.Unlock()
			if rest != bootstrapPhaseInfo {
				write(`552 Unrecognized key "` + rest + `"`)
				continue
			}
			write("250-"+bootstrapPhaseInfo+"="+progress, "250 OK")
		case "ADD_ONION":
			id, err := fakeServiceID(rest)
			if err != nil {
				write("512 " + err.Error())
				continue
			}
			if tor.behavior.wrongServiceID {
				other, _ := GenerateOnionKey(nil)
				id = other.ServiceID()
			}
			tor.mu.Lock()
			tor.services = append(tor.services, id)
			tor.mu.Unlock()
			write("250-ServiceID="+id, "250 OK")
		case "SETCONF":
			write("250 OK")
			if rest == "DisableNetwork=0" {
				tor.enableNetwork(write, events)
			}
		case "SIGNAL":
			write("250 OK")
			if rest == "SHUTDOWN" && !tor.behavior.ignoreShutdown {
				tor.exit(nil)
				return
			}
		default:
			write(`510 Unrecognized command "` + verb + `"`)
		}
	}
}

func (tor *fakeTor) enableNetwork(write func(...string), events string) {
	tor.mu.Lock()
	tor.network = true
	services := slices.Clone(tor.services)
	tor.mu.Unlock()
	subscribed := strings.Fields(events)
	if slices.Contains(subscribed, "STATUS_CLIENT") {
		write(`650 STATUS_CLIENT NOTICE CIRCUIT_ESTABLISHED`,
			`650 STATUS_CLIENT NOTICE BOOTSTRAP PROGRESS=45 TAG=requesting_descriptors SUMMARY="Asking for relay descriptors"`,
			`650 STATUS_CLIENT NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"`)
	}
	if slices.Contains(subscribed, "HS_DESC") {
		const relay = " UNKNOWN $0000000000000000000000000000000000000000~relay"
		for _, id := range services {
			other, _ := GenerateOnionKey(nil)
			write("650 HS_DESC UPLOAD "+id+relay, "650 HS_DESC UPLOADED "+other.ServiceID()+relay)
			if !tor.behavior.noUpload {
				write("650 HS_DESC UPLOADED " + id + relay)
			}
		}
	}
}

// fakeServiceID derives the id the way Tor does, through bine's independent
// Ed25519 code, so tests do not trust this package's own derivation.
func fakeServiceID(arguments string) (string, error) {
	// Fields, not parseArguments: the base64 blob ends in "=" padding.
	words := strings.Fields(arguments)
	if len(words) == 0 {
		return "", errors.New("missing key")
	}
	blob, ok := strings.CutPrefix(words[0], "ED25519-V3:")
	if !ok {
		return "", errors.New("unsupported key type")
	}
	if !slices.ContainsFunc(words, func(word string) bool { return strings.HasPrefix(word, "Port=") }) {
		return "", errors.New("missing Port")
	}
	raw, err := base64.StdEncoding.DecodeString(blob)
	if err != nil || len(raw) != tored25519.PrivateKeySize {
		return "", errors.New("invalid key blob")
	}
	return torutil.OnionServiceIDFromPrivateKey(tored25519.PrivateKey(raw).KeyPair()), nil
}

func readFakeTorrc(args []string) (map[string]string, error) {
	index := slices.Index(args, "-f")
	if index < 0 || index+1 >= len(args) {
		return nil, errors.New("fake tor needs -f torrc")
	}
	contents, err := os.ReadFile(args[index+1])
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	for line := range strings.Lines(string(contents)) {
		name, value, ok := strings.Cut(strings.TrimSpace(line), " ")
		if !ok || strings.HasPrefix(name, "#") {
			continue
		}
		if unquoted, ok := strings.CutPrefix(value, `"`); ok {
			value = strings.NewReplacer(`\\`, `\`, `\"`, `"`).Replace(strings.TrimSuffix(unquoted, `"`))
		}
		values[name] = value
	}
	for _, required := range []string{"ControlPortWriteToFile", "CookieAuthFile", "DataDirectory"} {
		if values[required] == "" {
			return nil, fmt.Errorf("fake tor torrc lacks %s", required)
		}
	}
	return values, nil
}
