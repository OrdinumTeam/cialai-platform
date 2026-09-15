// SPDX-License-Identifier: Apache-2.0
// Package tor is the reserve path and rendezvous carrier. On desktops it runs
// the bundled C Tor as a supervised child process that hosts a single-hop
// onion service with a persistent key; on every platform it dials onion
// services through a SOCKS5 proxy and wraps the stream in pinned TLS.
//
// The process is created through bine's process.Creator. The control protocol
// is spoken by a small client in this file instead of bine's control.Conn,
// because that one holds its read lock while delivering events to blocking
// channels and only reads the cookie path announced by PROTOCOLINFO, while
// phones receive the cookie path from the native side.
package tor

import (
	"bufio"
	"context"
	"crypto/ecdh"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/textproto"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
)

const (
	statusOK           = 250
	statusAsyncEvent   = 650
	maxReplyLines      = 4096
	maxQueuedEvents    = 1024
	cookieLength       = 32
	safeCookieServer   = "Tor safe cookie authentication server-to-controller hash"
	safeCookieClient   = "Tor safe cookie authentication controller-to-server hash"
	bootstrapPhaseInfo = "status/bootstrap-phase"
)

var (
	ErrControlClosed    = errors.New("tor control connection closed")
	ErrUnsupportedAuth  = errors.New("tor control port offers no supported authentication")
	ErrCookieMismatch   = errors.New("tor control port does not know the authentication cookie")
	ErrAddressMismatch  = errors.New("tor published a different onion address than the persisted key")
	ErrInvalidClientKey = errors.New("client authorization key must be a base32 x25519 public key")
)

// ControlError is a non-2xx reply from the Tor control port.
type ControlError struct {
	Status  int
	Message string
}

func (err *ControlError) Error() string {
	return fmt.Sprintf("tor control replied %d %s", err.Status, err.Message)
}

type controlReply struct {
	status int
	lines  []string
}

// controlConn is one authenticated control connection. A single reader
// goroutine separates asynchronous 650 events, kept in a bounded queue, from
// command replies, so waiting for events never blocks a command.
type controlConn struct {
	conn    net.Conn
	reader  *textproto.Reader
	command sync.Mutex
	replies chan controlReply
	done    chan struct{}

	mu          sync.Mutex
	readErr     error
	events      []string
	eventSignal chan struct{}
	closeOnce   sync.Once
}

func newControlConn(conn net.Conn) *controlConn {
	control := &controlConn{
		conn:        conn,
		reader:      textproto.NewReader(bufio.NewReader(conn)),
		replies:     make(chan controlReply, 1),
		done:        make(chan struct{}),
		eventSignal: make(chan struct{}, 1),
	}
	go control.readLoop()
	return control
}

func dialControl(ctx context.Context, address string) (*controlConn, error) {
	network, target, err := splitEndpoint(address)
	if err != nil {
		return nil, err
	}
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, network, target)
	if err != nil {
		return nil, fmt.Errorf("dial tor control port: %w", err)
	}
	return newControlConn(conn), nil
}

func (control *controlConn) readLoop() {
	for {
		reply, err := readReply(control.reader)
		if err != nil {
			control.fail(err)
			return
		}
		if reply.status == statusAsyncEvent {
			control.queueEvent(strings.Join(reply.lines, "\n"))
			continue
		}
		select {
		case control.replies <- reply:
		default:
			control.fail(errors.New("tor control sent a reply nobody asked for"))
			return
		}
	}
}

func (control *controlConn) fail(err error) {
	control.mu.Lock()
	if control.readErr == nil {
		control.readErr = err
	}
	control.mu.Unlock()
	control.Close()
}

func (control *controlConn) err() error {
	control.mu.Lock()
	defer control.mu.Unlock()
	if control.readErr == nil || errors.Is(control.readErr, io.EOF) || errors.Is(control.readErr, net.ErrClosed) {
		return ErrControlClosed
	}
	return fmt.Errorf("%w: %v", ErrControlClosed, control.readErr)
}

func (control *controlConn) queueEvent(event string) {
	control.mu.Lock()
	if len(control.events) == maxQueuedEvents {
		// Only bootstrap and descriptor events are subscribed; dropping the
		// oldest keeps memory bounded if nobody drains the queue.
		control.events = slices.Delete(control.events, 0, 1)
	}
	control.events = append(control.events, event)
	control.mu.Unlock()
	select {
	case control.eventSignal <- struct{}{}:
	default:
	}
}

// Close closes the connection; with TAKEOWNERSHIP in effect Tor exits too.
func (control *controlConn) Close() error {
	var err error
	control.closeOnce.Do(func() {
		err = control.conn.Close()
		close(control.done)
	})
	return err
}

// nextEvent returns the next asynchronous event as "NAME rest...".
func (control *controlConn) nextEvent(ctx context.Context) (string, error) {
	for {
		control.mu.Lock()
		if len(control.events) > 0 {
			event := control.events[0]
			control.events = slices.Delete(control.events, 0, 1)
			control.mu.Unlock()
			return event, nil
		}
		control.mu.Unlock()
		select {
		case <-control.eventSignal:
		case <-control.done:
			return "", control.err()
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
}

// do sends one command line and waits for its reply. A cancelled context
// closes the connection, because a late reply would otherwise be taken as the
// answer to the next command.
func (control *controlConn) do(ctx context.Context, line string) (controlReply, error) {
	if strings.ContainsAny(line, "\r\n") {
		return controlReply{}, errors.New("tor control command contains a line break")
	}
	control.command.Lock()
	defer control.command.Unlock()
	select {
	case <-control.done:
		return controlReply{}, control.err()
	default:
	}
	// A zero deadline clears the one left by a previous command.
	deadline, _ := ctx.Deadline()
	_ = control.conn.SetWriteDeadline(deadline)
	if _, err := io.WriteString(control.conn, line+"\r\n"); err != nil {
		control.fail(err)
		return controlReply{}, control.err()
	}
	select {
	case reply := <-control.replies:
		return reply, reply.check()
	case <-control.done:
		select {
		case reply := <-control.replies:
			return reply, reply.check()
		default:
			return controlReply{}, control.err()
		}
	case <-ctx.Done():
		control.Close()
		return controlReply{}, ctx.Err()
	}
}

func (reply controlReply) check() error {
	if reply.status/100 == 2 {
		return nil
	}
	return &ControlError{Status: reply.status, Message: strings.Join(reply.lines, " ")}
}

// readReply reads one reply: "NNN-" middle lines, "NNN+" data blocks ended by
// a lone ".", and the final "NNN " line. Data blocks are kept as "key=data".
func readReply(reader *textproto.Reader) (controlReply, error) {
	var reply controlReply
	for len(reply.lines) < maxReplyLines {
		line, err := reader.ReadLine()
		if err != nil {
			return controlReply{}, err
		}
		if len(line) < 4 {
			return controlReply{}, fmt.Errorf("truncated tor control line %q", line)
		}
		status, err := strconv.Atoi(line[:3])
		if err != nil || status < 100 {
			return controlReply{}, fmt.Errorf("invalid tor control status %q", line[:3])
		}
		if reply.lines == nil {
			reply.status = status
		} else if status != reply.status {
			return controlReply{}, fmt.Errorf("tor control status changed from %d to %d", reply.status, status)
		}
		switch line[3] {
		case ' ':
			reply.lines = append(reply.lines, line[4:])
			return reply, nil
		case '-':
			reply.lines = append(reply.lines, line[4:])
		case '+':
			body, err := reader.ReadDotLines()
			if err != nil {
				return controlReply{}, err
			}
			reply.lines = append(reply.lines, line[4:]+strings.Join(body, "\n"))
		default:
			return controlReply{}, fmt.Errorf("invalid tor control separator %q", line[3])
		}
	}
	return controlReply{}, errors.New("tor control reply is too long")
}

// authenticate prefers SAFECOOKIE, which also proves that the listener knows
// the cookie. With an empty cookiePath the COOKIEFILE from PROTOCOLINFO is
// used, and NULL authentication is accepted only in that case.
func (control *controlConn) authenticate(ctx context.Context, cookiePath string) error {
	reply, err := control.do(ctx, "PROTOCOLINFO 1")
	if err != nil {
		return err
	}
	var methods []string
	announcedCookie := ""
	for _, line := range reply.lines {
		rest, ok := strings.CutPrefix(line, "AUTH ")
		if !ok {
			continue
		}
		_, keywords := parseArguments(rest)
		methods = strings.Split(keywords["METHODS"], ",")
		announcedCookie = keywords["COOKIEFILE"]
	}
	switch {
	case slices.Contains(methods, "SAFECOOKIE"):
		path := cookiePath
		if path == "" {
			path = announcedCookie
		}
		if path == "" {
			return errors.New("tor control port did not announce a cookie file")
		}
		return control.safeCookie(ctx, path)
	case slices.Contains(methods, "NULL") && cookiePath == "":
		_, err := control.do(ctx, "AUTHENTICATE")
		return err
	default:
		return ErrUnsupportedAuth
	}
}

func (control *controlConn) safeCookie(ctx context.Context, path string) error {
	cookie, err := readCookie(path)
	if err != nil {
		return err
	}
	defer clear(cookie)
	clientNonce := make([]byte, cookieLength)
	if _, err := rand.Read(clientNonce); err != nil {
		return err
	}
	reply, err := control.do(ctx, "AUTHCHALLENGE SAFECOOKIE "+hex.EncodeToString(clientNonce))
	if err != nil {
		return err
	}
	_, keywords := parseArguments(strings.TrimPrefix(reply.lines[len(reply.lines)-1], "AUTHCHALLENGE "))
	serverHash, hashErr := hex.DecodeString(keywords["SERVERHASH"])
	serverNonce, nonceErr := hex.DecodeString(keywords["SERVERNONCE"])
	if hashErr != nil || nonceErr != nil || len(serverHash) != sha256.Size || len(serverNonce) != cookieLength {
		return errors.New("tor control sent an invalid AUTHCHALLENGE reply")
	}
	if !hmac.Equal(serverHash, cookieHMAC(safeCookieServer, cookie, clientNonce, serverNonce)) {
		return ErrCookieMismatch
	}
	_, err = control.do(ctx, "AUTHENTICATE "+hex.EncodeToString(cookieHMAC(safeCookieClient, cookie, clientNonce, serverNonce)))
	return err
}

func readCookie(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("read tor control cookie: %w", err)
	}
	defer file.Close()
	cookie, err := io.ReadAll(io.LimitReader(file, cookieLength+1))
	if err != nil {
		return nil, fmt.Errorf("read tor control cookie: %w", err)
	}
	if len(cookie) != cookieLength {
		return nil, errors.New("tor control cookie has the wrong length")
	}
	return cookie, nil
}

func cookieHMAC(label string, cookie, clientNonce, serverNonce []byte) []byte {
	mac := hmac.New(sha256.New, []byte(label))
	mac.Write(cookie)
	mac.Write(clientNonce)
	mac.Write(serverNonce)
	return mac.Sum(nil)
}

// getInfo returns the requested GETINFO keys.
func (control *controlConn) getInfo(ctx context.Context, keys ...string) (map[string]string, error) {
	reply, err := control.do(ctx, "GETINFO "+strings.Join(keys, " "))
	if err != nil {
		return nil, err
	}
	values := make(map[string]string, len(keys))
	for _, line := range reply.lines {
		if key, value, ok := strings.Cut(line, "="); ok && slices.Contains(keys, key) {
			values[key] = value
		}
	}
	return values, nil
}

func (control *controlConn) bootstrap(ctx context.Context) (Bootstrap, error) {
	values, err := control.getInfo(ctx, bootstrapPhaseInfo)
	if err != nil {
		return Bootstrap{}, err
	}
	status, ok := parseBootstrap(values[bootstrapPhaseInfo])
	if !ok {
		return Bootstrap{}, errors.New("tor sent an unreadable bootstrap phase")
	}
	return status, nil
}

// Bootstrap is Tor's progress toward usable circuits.
type Bootstrap struct {
	Progress int
	Tag      string
	Summary  string
	// Warning is set when Tor reports a problem while bootstrapping.
	Warning string
}

// parseBootstrap reads "SEVERITY BOOTSTRAP PROGRESS=n TAG=t SUMMARY=\"...\"",
// the body of both GETINFO status/bootstrap-phase and STATUS_CLIENT events.
func parseBootstrap(text string) (Bootstrap, bool) {
	positional, keywords := parseArguments(text)
	if len(positional) < 2 || positional[1] != "BOOTSTRAP" {
		return Bootstrap{}, false
	}
	progress, err := strconv.Atoi(keywords["PROGRESS"])
	if err != nil || progress < 0 || progress > 100 {
		return Bootstrap{}, false
	}
	status := Bootstrap{Progress: progress, Tag: keywords["TAG"], Summary: keywords["SUMMARY"]}
	if positional[0] == "WARN" || positional[0] == "ERR" {
		status.Warning = keywords["WARNING"]
		if status.Warning == "" {
			status.Warning = keywords["REASON"]
		}
	}
	return status, true
}

// parseArguments splits a control line into positional words and KEY=VALUE
// keywords, honoring quoted values with backslash escapes.
func parseArguments(text string) ([]string, map[string]string) {
	var positional []string
	keywords := map[string]string{}
	for len(text) > 0 {
		text = strings.TrimLeft(text, " ")
		if text == "" {
			break
		}
		end := 0
		var token strings.Builder
		quoted := false
		for end < len(text) {
			char := text[end]
			if quoted {
				switch char {
				case '\\':
					if end+1 < len(text) {
						token.WriteByte(unescapeControl(text[end+1]))
						end += 2
						continue
					}
				case '"':
					quoted = false
					end++
					continue
				}
				token.WriteByte(char)
				end++
				continue
			}
			if char == ' ' {
				break
			}
			if char == '"' {
				quoted = true
				end++
				continue
			}
			token.WriteByte(char)
			end++
		}
		word := token.String()
		raw := text[:end]
		text = text[end:]
		if key, _, ok := strings.Cut(raw, "="); ok && key != "" && !strings.Contains(key, `"`) {
			keywords[key] = word[len(key)+1:]
			continue
		}
		positional = append(positional, word)
	}
	return positional, keywords
}

func unescapeControl(char byte) byte {
	switch char {
	case 'n':
		return '\n'
	case 'r':
		return '\r'
	case 't':
		return '\t'
	default:
		return char
	}
}

// onionRequest is a raw ADD_ONION command. The desktop service is always
// NonAnonymous (single hop). Client authorization is prepared behind a flag:
// with clientAuthV3 set, only the listed x25519 keys can reach the service.
type onionRequest struct {
	key          *OnionKey
	virtualPort  int
	target       string
	nonAnonymous bool
	clientAuthV3 []string
}

func (request onionRequest) command() (string, error) {
	if request.key == nil {
		return "", errors.New("onion key is required")
	}
	if request.virtualPort < 1 || request.virtualPort > 65535 {
		return "", errors.New("onion virtual port is out of range")
	}
	if _, _, err := net.SplitHostPort(request.target); err != nil || strings.ContainsAny(request.target, " ,\r\n") {
		return "", errors.New("onion target must be host:port")
	}
	var flags []string
	if request.nonAnonymous {
		flags = append(flags, "NonAnonymous")
	}
	if len(request.clientAuthV3) > 0 {
		flags = append(flags, "V3Auth")
	}
	command := "ADD_ONION ED25519-V3:" + request.key.torBlob()
	if len(flags) > 0 {
		command += " Flags=" + strings.Join(flags, ",")
	}
	command += " Port=" + strconv.Itoa(request.virtualPort) + "," + request.target
	for _, key := range request.clientAuthV3 {
		if err := validateClientAuthKey(key); err != nil {
			return "", err
		}
		command += " ClientAuthV3=" + key
	}
	return command, nil
}

func validateClientAuthKey(key string) error {
	raw, err := serviceIDEncoding.DecodeString(strings.ToUpper(key))
	if err != nil || len(raw) != 32 {
		return ErrInvalidClientKey
	}
	if _, err := ecdh.X25519().NewPublicKey(raw); err != nil {
		return ErrInvalidClientKey
	}
	return nil
}

// addOnion registers the service and returns the service id chosen by Tor.
func (control *controlConn) addOnion(ctx context.Context, request onionRequest) (string, error) {
	command, err := request.command()
	if err != nil {
		return "", err
	}
	reply, err := control.do(ctx, command)
	if err != nil {
		return "", fmt.Errorf("ADD_ONION: %w", err)
	}
	for _, line := range reply.lines {
		if id, ok := strings.CutPrefix(line, "ServiceID="); ok {
			return id, nil
		}
	}
	return "", errors.New("ADD_ONION reply has no ServiceID")
}

// splitEndpoint accepts "host:port" on a loopback IP or "unix:/absolute/path".
func splitEndpoint(address string) (string, string, error) {
	if path, ok := strings.CutPrefix(address, "unix:"); ok {
		if path == "" || !strings.HasPrefix(path, "/") {
			return "", "", fmt.Errorf("unix endpoint %q must be an absolute path", address)
		}
		return "unix", path, nil
	}
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return "", "", fmt.Errorf("endpoint %q must be host:port: %w", address, err)
	}
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsLoopback() {
		return "", "", fmt.Errorf("endpoint %q must be a loopback address", address)
	}
	if number, err := strconv.Atoi(port); err != nil || number < 1 || number > 65535 {
		return "", "", fmt.Errorf("endpoint %q has an invalid port", address)
	}
	return "tcp", address, nil
}
