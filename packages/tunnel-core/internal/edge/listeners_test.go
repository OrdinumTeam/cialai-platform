// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/onion"
)

// The listeners learn revoked keys from the registry the edge uses.
var _ transport.RevocationList = (*pairing.Registry)(nil)

// streamClient speaks HTTP/1.1 by hand over one transport stream, so every
// request, the WebSocket upgrade included, provably uses the same session.
// net/http would dial a second connection for the upgrade.
type streamClient struct {
	conn   net.Conn
	reader *bufio.Reader
}

func newStreamClient(t *testing.T, conn net.Conn) *streamClient {
	t.Helper()
	t.Cleanup(func() { _ = conn.Close() })
	return &streamClient{conn: conn, reader: bufio.NewReader(conn)}
}

func (client *streamClient) do(t *testing.T, method, path string, body []byte, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, "http://edge"+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	_ = client.conn.SetDeadline(time.Now().Add(testTimeout))
	if err := request.Write(client.conn); err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	response, err := http.ReadResponse(client.reader, request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	if response.StatusCode == http.StatusSwitchingProtocols {
		return response, nil
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response, data
}

type upgradedStream struct {
	io.Reader
	io.Writer
}

func listenUDP(t *testing.T) net.PacketConn {
	t.Helper()
	packetConn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return packetConn
}

// realListeners are the direct QUIC listener and the onion TLS listener on
// loopback, joined by transport.MultiListener in front of the edge. The onion
// listener wraps plain loopback TCP, standing in for the Tor process.
type realListeners struct {
	h      *edgeHarness
	direct *direct.Listener
	onion  *onion.Listener
}

func startRealListeners(t *testing.T, h *edgeHarness) *realListeners {
	t.Helper()
	endpoint, err := direct.New(direct.Config{PacketConn: listenUDP(t), Identity: h.desktop})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	directListener, err := endpoint.Listen(direct.ListenConfig{Registry: h.config.Devices, Pairing: h.config.Sessions})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	onionListener, err := onion.Listen(raw, h.desktop, onion.ListenConfig{Registry: h.config.Devices, Pairing: h.config.Sessions})
	if err != nil {
		t.Fatal(err)
	}
	h.start(t, transport.NewMultiListener(directListener, onionListener))
	return &realListeners{h: h, direct: directListener, onion: onionListener}
}

// dialDirect opens a QUIC session as phone from a new phone endpoint.
func (listeners *realListeners) dialDirect(t *testing.T, phone *identity.Identity) (transport.Session, error) {
	t.Helper()
	phoneEndpoint, err := direct.New(direct.Config{PacketConn: listenUDP(t), Identity: phone})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = phoneEndpoint.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	return phoneEndpoint.Dial(ctx, listeners.direct.Addr().String(), listeners.h.desktop.PublicKey())
}

// dialOnion opens one onion connection, and so one Tor session and stream, as
// phone.
func (listeners *realListeners) dialOnion(t *testing.T, phone *identity.Identity) net.Conn {
	t.Helper()
	config, err := identity.ClientConfig(phone, listeners.h.desktop.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	conn, err := (&tls.Dialer{Config: config}).DialContext(ctx, "tcp", listeners.onion.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// phoneLink opens streams to the edge as one phone over one transport: direct
// streams share one QUIC session, while every onion stream is a connection of
// its own, as Tor carries one stream per connection.
type phoneLink struct {
	listeners *realListeners
	name      string
	phone     *identity.Identity
	session   transport.Session
}

func (listeners *realListeners) link(t *testing.T, name string, phone *identity.Identity) *phoneLink {
	t.Helper()
	link := &phoneLink{listeners: listeners, name: name, phone: phone}
	if name == transport.NameDirect {
		session, err := listeners.dialDirect(t, phone)
		if err != nil {
			t.Fatal(err)
		}
		link.session = session
	}
	return link
}

func (link *phoneLink) openStream(t *testing.T) net.Conn {
	t.Helper()
	if link.name == transport.NameTor {
		return link.listeners.dialOnion(t, link.phone)
	}
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()
	stream, err := link.session.OpenStream(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return stream
}

func waitSessionDone(t *testing.T, session transport.Session) {
	t.Helper()
	select {
	case <-session.Done():
	case <-time.After(testTimeout):
		t.Fatal("session did not close")
	}
}

// expectConnDropped waits until the desktop ends conn without answering.
func expectConnDropped(t *testing.T, conn net.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(testTimeout))
	_, err := conn.Read(make([]byte, 1))
	var netErr net.Error
	if err == nil || (errors.As(err, &netErr) && netErr.Timeout()) {
		t.Fatalf("connection stayed open: %v", err)
	}
}

// The real direct QUIC listener and the onion TLS listener, joined by
// transport.MultiListener, run the whole pairing on loopback: restricted
// session, POST /pair, promotion and /pty on the same session.
func TestEdgeServesRealDirectAndOnionListenersThroughOneAcceptPoint(t *testing.T) {
	bridgeURL, _ := newBridge(t)
	h := prepareEdge(t, bridgeURL)
	listeners := startRealListeners(t, h)

	for _, name := range []string{transport.NameDirect, transport.NameTor} {
		t.Run(name, func(t *testing.T) {
			phoneIdentity := mustIdentity(t, identity.RolePhone)
			key := phoneIdentity.PublicKeyString()
			pairID, secret := h.beginPairing(t)
			stream := listeners.link(t, name, phoneIdentity).openStream(t)
			phone := newStreamClient(t, stream)

			response, body := phone.do(t, http.MethodGet, "/api/health", nil, nil)
			expectProblem(t, response, body, http.StatusUnauthorized, "pair_required")
			response, body = phone.do(t, http.MethodGet, "/pty", nil, upgradeHeaders(""))
			expectProblem(t, response, body, http.StatusUnauthorized, "pair_required")

			response, body = phone.do(t, http.MethodPost, "/pair", pairBody(pairID, secret, key), nil)
			if response.StatusCode != http.StatusOK {
				t.Fatalf("pair over %s failed: HTTP %d %s", name, response.StatusCode, body)
			}
			var result struct {
				DeviceID string `json:"deviceId"`
				Token    string `json:"token"`
			}
			if err := json.Unmarshal(body, &result); err != nil {
				t.Fatal(err)
			}
			if device, _ := h.config.Devices.Get(result.DeviceID); device.DeviceKey != key || device.LastTransport != name {
				t.Fatalf("device not recorded from the %s session: %#v", name, device)
			}

			if response, body := phone.do(t, http.MethodGet, "/api/health", nil, nil); response.StatusCode != http.StatusOK {
				t.Fatalf("promoted %s session did not reach health: HTTP %d %s", name, response.StatusCode, body)
			}
			response, body = phone.do(t, http.MethodGet, "/pty", nil, upgradeHeaders(result.Token))
			if response.StatusCode != http.StatusSwitchingProtocols {
				t.Fatalf("promoted %s session could not open /pty: HTTP %d %s", name, response.StatusCode, body)
			}
			expectEcho(t, upgradedStream{Reader: phone.reader, Writer: stream})
			h.events.wait(t, "session.opened", func(data any) bool {
				fields := data.(map[string]string)
				return fields["deviceId"] == result.DeviceID && fields["transport"] == name
			})
		})
	}
}

// closeFrame4401 is the unmasked WebSocket close frame, code 4401 and no
// reason, that the bridge sends to a revoked device.
var closeFrame4401 = []byte{0x88, 0x02, 0x11, 0x31}

// revocableBridge stands in for the desktop bridge: it echoes the upgraded
// bytes and, when the edge emits devices.changed with revoked, closes the
// sockets of that device with 4401, as the supervisor does through
// BridgeControl::revoke_device.
type revocableBridge struct {
	url string

	mu      sync.Mutex
	sockets map[string][]net.Conn
}

func newRevocableBridge(t *testing.T) *revocableBridge {
	t.Helper()
	bridge := &revocableBridge{sockets: make(map[string][]net.Conn)}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if !isUpgrade(request) {
			response.WriteHeader(http.StatusNoContent)
			return
		}
		conn, buffered, err := response.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		_, _ = buffered.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
		_ = buffered.Flush()
		deviceID := request.Header.Get("X-Cialai-Device-Id")
		bridge.mu.Lock()
		bridge.sockets[deviceID] = append(bridge.sockets[deviceID], conn)
		bridge.mu.Unlock()
		go func() {
			defer conn.Close()
			_, _ = io.Copy(conn, buffered)
		}()
	}))
	t.Cleanup(server.Close)
	bridge.url = server.URL
	return bridge
}

func (bridge *revocableBridge) onEvent(name string, data any) {
	fields, ok := data.(map[string]any)
	if name != "devices.changed" || !ok || fields["revoked"] != true {
		return
	}
	deviceID, _ := fields["deviceId"].(string)
	bridge.mu.Lock()
	sockets := bridge.sockets[deviceID]
	delete(bridge.sockets, deviceID)
	bridge.mu.Unlock()
	for _, conn := range sockets {
		_, _ = conn.Write(closeFrame4401)
		_ = conn.Close()
	}
}

// Revocation over the real direct QUIC and onion TLS listeners: the 4401 close
// of the bridge reaches the phone, the transport sessions of the key close in
// under one second, and the key can no longer open a session or reach a route.
func TestRevokeClosesRealDirectAndTorSessionsInUnderOneSecond(t *testing.T) {
	for _, name := range []string{transport.NameDirect, transport.NameTor} {
		t.Run(name+"/phone answers the close", func(t *testing.T) { testRevokeOverRealListeners(t, name, true) })
		t.Run(name+"/phone ignores the close", func(t *testing.T) { testRevokeOverRealListeners(t, name, false) })
	}
}

func testRevokeOverRealListeners(t *testing.T, name string, phoneAnswers bool) {
	bridge := newRevocableBridge(t)
	h := prepareEdge(t, bridge.url)
	h.events.setHook(bridge.onEvent)
	listeners := startRealListeners(t, h)
	phoneIdentity := mustIdentity(t, identity.RolePhone)
	device, token := h.pairDevice(t, phoneIdentity.PublicKeyString())
	link := listeners.link(t, name, phoneIdentity)

	socketStream := link.openStream(t)
	socket := newStreamClient(t, socketStream)
	response, body := socket.do(t, http.MethodGet, "/pty", nil, upgradeHeaders(token))
	if response.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("upgrade over %s failed: HTTP %d %s", name, response.StatusCode, body)
	}
	expectEcho(t, upgradedStream{Reader: socket.reader, Writer: socketStream})
	// A second stream of the key stays idle after one request: over QUIC it
	// shares the session of the socket, over Tor it is a session of its own.
	idle := newStreamClient(t, link.openStream(t))
	if response, body := idle.do(t, http.MethodGet, "/api/health", nil, nil); response.StatusCode != http.StatusOK {
		t.Fatalf("idle %s stream did not reach health: HTTP %d %s", name, response.StatusCode, body)
	}
	dropped := make(chan time.Time, 1)
	go func() {
		_ = idle.conn.SetReadDeadline(time.Now().Add(testTimeout))
		_, _ = idle.reader.ReadByte()
		dropped <- time.Now()
	}()
	// The phone reads the close like the page does; answering it ends the
	// WebSocket on the phone side, ignoring it leaves the socket open.
	closeRead := make(chan []byte, 1)
	go func() {
		_ = socketStream.SetReadDeadline(time.Now().Add(testTimeout))
		frame := make([]byte, len(closeFrame4401))
		n, _ := io.ReadFull(socket.reader, frame)
		closeRead <- frame[:n]
		if phoneAnswers {
			_, _ = io.Copy(io.Discard, socket.reader)
			_ = socketStream.Close()
		}
	}()

	started := time.Now()
	result, err := h.server.Revoke(device.ID)
	if err != nil {
		t.Fatal(err)
	}
	returned := time.Since(started)
	var closedAfter time.Duration
	select {
	case at := <-dropped:
		closedAfter = at.Sub(started)
	case <-time.After(testTimeout):
		t.Fatal("the idle stream of the revoked key stayed open")
	}
	t.Logf("%s, phone answers %v: Revoke returned after %s, phone saw the session close after %s, result %+v", name, phoneAnswers, returned, closedAfter, result)
	if closedAfter >= time.Second || returned >= time.Second {
		t.Fatalf("revocation over %s took %s to close the session and %s to return", name, closedAfter, returned)
	}
	if frame := <-closeRead; !bytes.Equal(frame, closeFrame4401) {
		t.Fatalf("the phone did not receive the 4401 close before the %s session closed: %x", name, frame)
	}
	if result.Sessions < 1 {
		t.Fatalf("no %s session of the key was closed: %+v", name, result)
	}
	if phoneAnswers && (returned >= h.server.revokeGrace || result.Sockets != 0) {
		t.Fatalf("revocation waited for the grace although the socket ended: %s %+v", returned, result)
	}
	if !phoneAnswers && returned < h.server.revokeGrace {
		t.Fatalf("revocation cut a socket still open before the grace: %s", returned)
	}
	if link.session != nil {
		waitSessionDone(t, link.session)
		if err := link.session.(*direct.Session).Err(); !errors.Is(err, transport.ErrRevoked) {
			t.Fatalf("direct session closed with %v, want revoked", err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		_, err := link.session.OpenStream(ctx)
		cancel()
		if !errors.Is(err, transport.ErrRevoked) {
			t.Fatalf("revoked direct session opened a stream: %v", err)
		}
	}

	// Outside pairing a new handshake of the key is refused: QUIC tells the
	// phone the key was revoked, the onion connection just ends.
	if name == transport.NameDirect {
		again, err := listeners.dialDirect(t, phoneIdentity)
		if err == nil {
			waitSessionDone(t, again)
			err = again.(*direct.Session).Err()
		}
		if !errors.Is(err, transport.ErrRevoked) {
			t.Fatalf("revoked key reconnected over QUIC: %v", err)
		}
	} else {
		expectConnDropped(t, listeners.dialOnion(t, phoneIdentity))
	}

	// During a pairing the key only gets the restricted entry, so the phone
	// can pair again, and the edge refuses the socket.
	h.beginPairing(t)
	restricted := newStreamClient(t, listeners.link(t, name, phoneIdentity).openStream(t))
	response, body = restricted.do(t, http.MethodGet, "/pty", nil, upgradeHeaders(token))
	expectProblem(t, response, body, http.StatusUnauthorized, "pair_required")
}
