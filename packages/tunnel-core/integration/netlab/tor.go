// SPDX-License-Identifier: Apache-2.0
//go:build netlab

package main

import (
	"bufio"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"os"
	"os/signal"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/cretz/bine/torutil"
	tored25519 "github.com/cretz/bine/torutil/ed25519"
)

// The tor role replaces the bundled tor binary in the desktop container. The
// sidecar supervisor starts it exactly as it starts tor, with -f torrc, and
// drives it through the control port: cookie authentication, TAKEOWNERSHIP,
// SETEVENTS, ADD_ONION, DEL_ONION, SETCONF DisableNetwork=0, GETINFO
// bootstrap and SIGNAL SHUTDOWN. Instead of joining the Tor network it
// publishes the service id derived from each ADD_ONION key at the relay named
// by NETLAB_RELAY, the desktop service and the temporary ones of a Broto
// pairing by QR, and forwards every stream the relay attaches to the target of
// that service. Killing this process is the laboratory version of the tor
// process crashing.

const (
	torVersion            = "Tor version 0.4.9.12-netlab."
	torCookieLength       = 32
	torSafeCookieServer   = "Tor safe cookie authentication server-to-controller hash"
	torSafeCookieClient   = "Tor safe cookie authentication controller-to-server hash"
	torBootstrapInfo      = "status/bootstrap-phase"
	torRelayRetry         = time.Second
	torRelayEnvironment   = "NETLAB_RELAY"
	torOwnerCheckInterval = time.Second
)

type fakeTor struct {
	relay string

	mu          sync.Mutex
	cookie      []byte
	cookiePath  string
	services    map[string]*torService
	network     bool
	progress    int
	subscribers map[*torControl]struct{}
	exit        chan int
	exitOnce    sync.Once
}

// torService is one ADD_ONION service and, once the network runs, the loop
// that keeps it published at the relay until DEL_ONION.
type torService struct {
	id      string
	target  string
	removed chan struct{}

	mu   sync.Mutex
	conn net.Conn
}

// track records the current relay connection, so DEL_ONION can end it; it
// fails once the service was removed.
func (service *torService) track(conn net.Conn) bool {
	service.mu.Lock()
	defer service.mu.Unlock()
	select {
	case <-service.removed:
		return false
	default:
	}
	service.conn = conn
	return true
}

// remove stops publishing: the relay drops a service whose connection ends.
func (service *torService) remove() {
	service.mu.Lock()
	select {
	case <-service.removed:
	default:
		close(service.removed)
	}
	conn := service.conn
	service.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

type torControl struct {
	conn    net.Conn
	writeMu sync.Mutex
	events  []string
}

func (control *torControl) write(lines ...string) {
	control.writeMu.Lock()
	defer control.writeMu.Unlock()
	_, _ = io.WriteString(control.conn, strings.Join(lines, "\r\n")+"\r\n")
}

func runTor(args []string) int {
	if len(args) == 1 && args[0] == "--version" {
		fmt.Println(torVersion)
		return 0
	}
	torrc, err := readTorrc(args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "[err] netlab tor:", err)
		return 1
	}
	tor := &fakeTor{
		relay:       os.Getenv(torRelayEnvironment),
		cookiePath:  torrc["CookieAuthFile"],
		services:    map[string]*torService{},
		subscribers: map[*torControl]struct{}{},
		exit:        make(chan int, 1),
	}
	if tor.relay == "" {
		fmt.Fprintln(os.Stderr, "[err] netlab tor: NETLAB_RELAY is not set")
		return 1
	}
	tor.cookie = make([]byte, torCookieLength)
	if _, err := rand.Read(tor.cookie); err != nil {
		return 1
	}
	if err := os.WriteFile(tor.cookiePath, tor.cookie, 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "[err] netlab tor:", err)
		return 1
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 1
	}
	if err := os.WriteFile(torrc["ControlPortWriteToFile"], []byte("PORT="+listener.Addr().String()+"\n"), 0o600); err != nil {
		fmt.Fprintln(os.Stderr, "[err] netlab tor:", err)
		return 1
	}
	notice("Tor 0.4.9.12-netlab opening control listener on %s", listener.Addr())
	if owner, err := strconv.Atoi(torrc["__OwningControllerProcess"]); err == nil && owner > 0 {
		go tor.watchOwner(owner)
	}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-signals
		tor.stop(0)
	}()
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go tor.serve(conn)
		}
	}()
	code := <-tor.exit
	notice("Catching signal, exiting cleanly")
	return code
}

func notice(format string, args ...any) {
	fmt.Printf("%s [notice] %s\n", time.Now().Format("Jan 02 15:04:05.000"), fmt.Sprintf(format, args...))
}

func (tor *fakeTor) stop(code int) {
	tor.exitOnce.Do(func() { tor.exit <- code })
}

// watchOwner exits when the owning controller process is gone, as
// __OwningControllerProcess makes tor do.
func (tor *fakeTor) watchOwner(pid int) {
	for {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			notice("Owning controller process %d vanished -- exiting now", pid)
			tor.stop(0)
			return
		}
		time.Sleep(torOwnerCheckInterval)
	}
}

func (tor *fakeTor) serve(conn net.Conn) {
	control := &torControl{conn: conn}
	reader := textproto.NewReader(bufio.NewReader(conn))
	authenticated, owner := false, false
	var clientNonce, serverNonce []byte
	defer func() {
		_ = conn.Close()
		tor.mu.Lock()
		delete(tor.subscribers, control)
		tor.mu.Unlock()
		if owner {
			notice("Owning controller connection has closed -- exiting now")
			tor.stop(0)
		}
	}()
	for {
		line, err := reader.ReadLine()
		if err != nil {
			return
		}
		verb, rest, _ := strings.Cut(line, " ")
		if !authenticated && !slices.Contains([]string{"PROTOCOLINFO", "AUTHCHALLENGE", "AUTHENTICATE"}, verb) {
			control.write("514 Authentication required.")
			return
		}
		switch verb {
		case "PROTOCOLINFO":
			control.write("250-PROTOCOLINFO 1",
				fmt.Sprintf("250-AUTH METHODS=COOKIE,SAFECOOKIE COOKIEFILE=%q", tor.cookiePath),
				`250-VERSION Tor="0.4.9.12-netlab"`,
				"250 OK")
		case "AUTHCHALLENGE":
			nonce, err := hex.DecodeString(strings.TrimPrefix(rest, "SAFECOOKIE "))
			if err != nil || len(nonce) != torCookieLength {
				control.write("513 Invalid base16 client nonce")
				return
			}
			clientNonce = nonce
			serverNonce = make([]byte, torCookieLength)
			_, _ = rand.Read(serverNonce)
			control.write(fmt.Sprintf("250 AUTHCHALLENGE SERVERHASH=%X SERVERNONCE=%X",
				torCookieHMAC(torSafeCookieServer, tor.cookie, clientNonce, serverNonce), serverNonce))
		case "AUTHENTICATE":
			proof, err := hex.DecodeString(rest)
			if err != nil || clientNonce == nil || !hmac.Equal(proof, torCookieHMAC(torSafeCookieClient, tor.cookie, clientNonce, serverNonce)) {
				control.write("515 Authentication failed: Safe cookie response did not match expected value.")
				return
			}
			authenticated = true
			control.write("250 OK")
		case "TAKEOWNERSHIP":
			owner = true
			control.write("250 OK")
		case "SETEVENTS":
			tor.mu.Lock()
			control.events = strings.Fields(rest)
			tor.subscribers[control] = struct{}{}
			tor.mu.Unlock()
			control.write("250 OK")
		case "GETINFO":
			if rest != torBootstrapInfo {
				control.write(`552 Unrecognized key "` + rest + `"`)
				continue
			}
			tor.mu.Lock()
			progress := tor.progress
			tor.mu.Unlock()
			control.write("250-"+torBootstrapInfo+"="+bootstrapLine(progress), "250 OK")
		case "ADD_ONION":
			id, target, err := parseAddOnion(rest)
			if err != nil {
				control.write("512 " + err.Error())
				continue
			}
			tor.mu.Lock()
			service, exists := tor.services[id]
			if !exists {
				service = &torService{id: id, target: target, removed: make(chan struct{})}
				tor.services[id] = service
			}
			network := tor.network
			tor.mu.Unlock()
			if exists {
				control.write("550 Onion address collision")
				continue
			}
			control.write("250-ServiceID="+id, "250 OK")
			if network {
				go tor.publishLoop(service)
			}
		case "DEL_ONION":
			tor.mu.Lock()
			service := tor.services[rest]
			delete(tor.services, rest)
			tor.mu.Unlock()
			if service == nil {
				control.write("552 Unknown Onion Service id")
				continue
			}
			service.remove()
			notice("Removed the onion service %s.onion", rest)
			control.write("250 OK")
		case "SETCONF":
			control.write("250 OK")
			if rest == "DisableNetwork=0" {
				tor.enableNetwork()
			}
		case "SIGNAL":
			control.write("250 OK")
			if rest == "SHUTDOWN" || rest == "HALT" {
				tor.stop(0)
				return
			}
		default:
			control.write(`510 Unrecognized command "` + verb + `"`)
		}
	}
}

func bootstrapLine(progress int) string {
	if progress >= 100 {
		return `NOTICE BOOTSTRAP PROGRESS=100 TAG=done SUMMARY="Done"`
	}
	return fmt.Sprintf(`NOTICE BOOTSTRAP PROGRESS=%d TAG=conn SUMMARY="Connecting to the netlab relay"`, progress)
}

// broadcast sends an asynchronous event to the controllers subscribed to it.
func (tor *fakeTor) broadcast(name, body string) {
	tor.mu.Lock()
	var targets []*torControl
	for control := range tor.subscribers {
		if slices.Contains(control.events, name) {
			targets = append(targets, control)
		}
	}
	tor.mu.Unlock()
	for _, control := range targets {
		control.write("650 " + name + " " + body)
	}
}

func (tor *fakeTor) setProgress(progress int) {
	tor.mu.Lock()
	tor.progress = progress
	tor.mu.Unlock()
	notice("Bootstrapped %d%%", progress)
	tor.broadcast("STATUS_CLIENT", bootstrapLine(progress))
}

func (tor *fakeTor) enableNetwork() {
	tor.mu.Lock()
	started := tor.network
	tor.network = true
	services := make([]*torService, 0, len(tor.services))
	for _, service := range tor.services {
		services = append(services, service)
	}
	tor.mu.Unlock()
	if started {
		return
	}
	tor.setProgress(10)
	for _, service := range services {
		go tor.publishLoop(service)
	}
}

// raiseProgress reports bootstrap progress, which never goes back.
func (tor *fakeTor) raiseProgress(progress int) {
	tor.mu.Lock()
	current := tor.progress
	tor.mu.Unlock()
	if current < progress {
		tor.setProgress(progress)
	}
}

// publishLoop keeps one service published at the relay, reconnecting after
// the relay restarts, and reports every publication as a descriptor upload.
// It ends with DEL_ONION.
func (tor *fakeTor) publishLoop(service *torService) {
	for {
		err := tor.publishOnce(service)
		select {
		case <-service.removed:
			return
		default:
		}
		notice("Relay connection of %s.onion ended: %v", service.id, err)
		select {
		case <-service.removed:
			return
		case <-time.After(torRelayRetry):
		}
	}
}

func (tor *fakeTor) publishOnce(service *torService) error {
	id := service.id
	conn, err := net.DialTimeout("tcp", tor.relay, 5*time.Second)
	if err != nil {
		return err
	}
	defer conn.Close()
	if !service.track(conn) {
		return errors.New("onion service removed")
	}
	tor.raiseProgress(50)
	if _, err := io.WriteString(conn, "PUBLISH "+id+"\n"); err != nil {
		return err
	}
	reader := bufio.NewReader(conn)
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	line, err := reader.ReadString('\n')
	if err != nil {
		return err
	}
	_ = conn.SetReadDeadline(time.Time{})
	if strings.TrimSpace(line) != "OK" {
		return fmt.Errorf("relay refused the service: %q", line)
	}
	tor.raiseProgress(100)
	notice("Uploaded the descriptor of %s.onion to the netlab relay", id)
	tor.broadcast("HS_DESC", "UPLOADED "+id+" NO_AUTH $0000000000000000000000000000000000000000~netlab UNKNOWN")
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return err
		}
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "STREAM" {
			go tor.attach(service, fields[1])
		}
	}
}

// attach opens the relay side of one stream and forwards it to the target of
// its service.
func (tor *fakeTor) attach(service *torService, stream string) {
	id, target := service.id, service.target
	local, err := net.DialTimeout("tcp", target, 5*time.Second)
	if err != nil {
		notice("Stream %s: target %s refused: %v", stream, target, err)
		return
	}
	remote, err := net.DialTimeout("tcp", tor.relay, 5*time.Second)
	if err != nil {
		_ = local.Close()
		return
	}
	if _, err := io.WriteString(remote, "ATTACH "+id+" "+stream+"\n"); err != nil {
		_ = local.Close()
		_ = remote.Close()
		return
	}
	splice(remote, nil, local)
}

// parseAddOnion derives the service id from the ED25519-V3 key blob the way
// Tor does and reads the target of virtual port 443.
func parseAddOnion(arguments string) (string, string, error) {
	words := strings.Fields(arguments)
	if len(words) == 0 {
		return "", "", errors.New("missing key")
	}
	blob, ok := strings.CutPrefix(words[0], "ED25519-V3:")
	if !ok {
		return "", "", errors.New("unsupported key type")
	}
	raw, err := base64.StdEncoding.DecodeString(blob)
	if err != nil || len(raw) != tored25519.PrivateKeySize {
		return "", "", errors.New("invalid key blob")
	}
	target := ""
	for _, word := range words[1:] {
		if port, ok := strings.CutPrefix(word, "Port="); ok {
			virtual, address, found := strings.Cut(port, ",")
			if !found || virtual != "443" {
				return "", "", errors.New("the onion service must map port 443 to host:port")
			}
			target = address
		}
	}
	if target == "" {
		return "", "", errors.New("missing Port")
	}
	return torutil.OnionServiceIDFromPrivateKey(tored25519.PrivateKey(raw).KeyPair()), target, nil
}

func torCookieHMAC(label string, cookie, clientNonce, serverNonce []byte) []byte {
	mac := hmac.New(sha256.New, []byte(label))
	mac.Write(cookie)
	mac.Write(clientNonce)
	mac.Write(serverNonce)
	return mac.Sum(nil)
}

func readTorrc(args []string) (map[string]string, error) {
	index := slices.Index(args, "-f")
	if index < 0 || index+1 >= len(args) {
		return nil, errors.New("tor needs -f torrc")
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
			return nil, fmt.Errorf("torrc lacks %s", required)
		}
	}
	return values, nil
}
