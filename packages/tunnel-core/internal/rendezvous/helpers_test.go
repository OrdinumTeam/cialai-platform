// SPDX-License-Identifier: Apache-2.0
package rendezvous

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"net/netip"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

const testTimeout = 5 * time.Second

func testContext(t testing.TB) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	t.Cleanup(cancel)
	return ctx
}

type testKeys struct {
	phone   *identity.Identity
	desktop *identity.Identity
}

func newKeys(t testing.TB) testKeys {
	t.Helper()
	return testKeys{phone: generate(t, identity.RolePhone), desktop: generate(t, identity.RoleDesktop)}
}

func generate(t testing.TB, role identity.Role) *identity.Identity {
	t.Helper()
	generated, err := identity.Generate(role, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return generated
}

func (keys testKeys) of(role identity.Role) *identity.Identity {
	if role == identity.RoleDesktop {
		return keys.desktop
	}
	return keys.phone
}

func otherRole(role identity.Role) identity.Role {
	if role == identity.RoleDesktop {
		return identity.RolePhone
	}
	return identity.RoleDesktop
}

// config returns a channel configuration with keepalive disabled, so tests
// that read raw frames see only what they provoke.
func (keys testKeys) config(role identity.Role) Config {
	return Config{
		Role:         role,
		LocalKey:     keys.of(role).PublicKeyString(),
		PeerKey:      keys.of(otherRole(role)).PublicKeyString(),
		PingInterval: -1,
		HelloTimeout: testTimeout,
	}
}

func (keys testKeys) hello(role identity.Role) message {
	return message{Type: typeHello, Hello: &hello{Proto: ProtocolVersion, Role: string(role), Key: keys.of(role).PublicKeyString()}}
}

// fakeSession is a transport.ControlSession whose control stream is one end
// of a net.Pipe.
type fakeSession struct {
	peerKey string
	remote  *fakeSession
	control chan transport.Stream
	done    chan struct{}
	once    sync.Once
}

var _ transport.ControlSession = (*fakeSession)(nil)

func newFakeSession(peerKey string) *fakeSession {
	return &fakeSession{peerKey: peerKey, control: make(chan transport.Stream, 1), done: make(chan struct{})}
}

func sessionPair(keys testKeys) (phone, desktop *fakeSession) {
	phone = newFakeSession(keys.desktop.PublicKeyString())
	desktop = newFakeSession(keys.phone.PublicKeyString())
	phone.remote, desktop.remote = desktop, phone
	return phone, desktop
}

func (session *fakeSession) PeerKey() string   { return session.peerKey }
func (session *fakeSession) Transport() string { return transport.NameDirect }
func (session *fakeSession) Registered() bool  { return true }
func (session *fakeSession) OpenStream(context.Context) (transport.Stream, error) {
	return nil, transport.ErrStreamRefused
}
func (session *fakeSession) AcceptStream(context.Context) (transport.Stream, error) {
	return nil, transport.ErrStreamRefused
}
func (session *fakeSession) LocalAddr() net.Addr   { return nil }
func (session *fakeSession) RemoteAddr() net.Addr  { return nil }
func (session *fakeSession) Done() <-chan struct{} { return session.done }
func (session *fakeSession) Close() error {
	session.once.Do(func() { close(session.done) })
	return nil
}

func (session *fakeSession) OpenControl(ctx context.Context) (transport.Stream, error) {
	near, far := net.Pipe()
	select {
	case session.remote.control <- pipeStream{Conn: far, session: session.remote}:
		return pipeStream{Conn: near, session: session}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (session *fakeSession) AcceptControl(ctx context.Context) (transport.Stream, error) {
	select {
	case stream := <-session.control:
		return stream, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

type pipeStream struct {
	net.Conn
	session transport.Session
}

func (stream pipeStream) Session() transport.Session { return stream.session }

// connPair establishes a phone and a desktop channel over fake sessions; the
// peer keys come from the sessions.
func connPair(t testing.TB, keys testKeys, phoneSetup, desktopSetup func(*Config)) (phone, desktop *Conn) {
	t.Helper()
	phoneSession, desktopSession := sessionPair(keys)
	phoneConfig, desktopConfig := keys.config(identity.RolePhone), keys.config(identity.RoleDesktop)
	phoneConfig.PeerKey, desktopConfig.PeerKey = "", ""
	if phoneSetup != nil {
		phoneSetup(&phoneConfig)
	}
	if desktopSetup != nil {
		desktopSetup(&desktopConfig)
	}
	ctx := testContext(t)
	type result struct {
		conn *Conn
		err  error
	}
	accepted := make(chan result, 1)
	go func() {
		conn, err := Accept(ctx, desktopSession, desktopConfig)
		accepted <- result{conn: conn, err: err}
	}()
	phone, err := Open(ctx, phoneSession, phoneConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = phone.Close() })
	desktopResult := <-accepted
	if desktopResult.err != nil {
		t.Fatal(desktopResult.err)
	}
	t.Cleanup(func() { _ = desktopResult.conn.Close() })
	return phone, desktopResult.conn
}

// rawPeer speaks frames directly, so tests can break the protocol.
type rawPeer struct {
	t      testing.TB
	conn   net.Conn
	frames chan message
	seq    uint64
}

func newRawPeer(t testing.TB, conn net.Conn, read bool) *rawPeer {
	peer := &rawPeer{t: t, conn: conn, frames: make(chan message, 64)}
	stop := make(chan struct{})
	t.Cleanup(func() {
		close(stop)
		_ = conn.Close()
	})
	if !read {
		return peer
	}
	go func() {
		defer close(peer.frames)
		buffer := make([]byte, MaxFrameSize)
		for {
			raw, err := readFrame(conn, buffer)
			if err != nil {
				return
			}
			var msg message
			if err := json.Unmarshal(raw, &msg); err != nil {
				return
			}
			select {
			case peer.frames <- msg:
			case <-stop:
				return
			}
		}
	}()
	return peer
}

// send numbers msg with the next sequence number and writes it unvalidated.
// Write errors are returned: the channel may already have closed the pipe.
func (peer *rawPeer) send(msg message) error {
	peer.seq++
	msg.Seq = peer.seq
	return peer.sendAs(msg)
}

// sendAs writes msg with the sequence number it already carries.
func (peer *rawPeer) sendAs(msg message) error {
	payload, err := json.Marshal(msg)
	if err != nil {
		peer.t.Fatal(err)
	}
	return peer.writeRaw(appendFrame(nil, payload))
}

func (peer *rawPeer) writeRaw(frame []byte) error {
	_ = peer.conn.SetWriteDeadline(time.Now().Add(testTimeout))
	_, err := peer.conn.Write(frame)
	return err
}

func (peer *rawPeer) mustSend(msg message) {
	peer.t.Helper()
	if err := peer.send(msg); err != nil {
		peer.t.Fatalf("raw send %s: %v", msg.Type, err)
	}
}

// expect returns the next frame from the channel, which must be of kind.
func (peer *rawPeer) expect(kind messageType) message {
	peer.t.Helper()
	select {
	case msg, ok := <-peer.frames:
		if !ok {
			peer.t.Fatalf("stream ended while waiting for %s", kind)
		}
		if msg.Type != kind {
			peer.t.Fatalf("got %s seq %d, want %s", msg.Type, msg.Seq, kind)
		}
		return msg
	case <-time.After(testTimeout):
		peer.t.Fatalf("no %s within %s", kind, testTimeout)
	}
	return message{}
}

type establishResult struct {
	conn *Conn
	err  error
}

// establishRaw starts a channel of role against a raw peer of the other role.
func establishRaw(t testing.TB, keys testKeys, role identity.Role, setup func(*Config)) (*rawPeer, <-chan establishResult) {
	t.Helper()
	near, far := net.Pipe()
	config := keys.config(role)
	if setup != nil {
		setup(&config)
	}
	results := make(chan establishResult, 1)
	ctx := testContext(t)
	go func() {
		conn, err := Establish(ctx, near, config)
		results <- establishResult{conn: conn, err: err}
	}()
	return newRawPeer(t, far, true), results
}

func waitEstablish(t testing.TB, results <-chan establishResult) establishResult {
	t.Helper()
	select {
	case result := <-results:
		if result.conn != nil {
			t.Cleanup(func() { _ = result.conn.Close() })
		}
		return result
	case <-time.After(2 * testTimeout):
		t.Fatal("Establish did not return")
	}
	return establishResult{}
}

// connWithRaw returns an established channel of role and the raw peer that
// completed hello.
func connWithRaw(t testing.TB, keys testKeys, role identity.Role, setup func(*Config)) (*Conn, *rawPeer) {
	t.Helper()
	peer, results := establishRaw(t, keys, role, setup)
	peer.expect(typeHello)
	peer.mustSend(keys.hello(otherRole(role)))
	result := waitEstablish(t, results)
	if result.err != nil {
		t.Fatal(result.err)
	}
	return result.conn, peer
}

// waitClosed waits for the channel to end and checks its error.
func waitClosed(t testing.TB, conn *Conn, target error) {
	t.Helper()
	select {
	case <-conn.Done():
	case <-time.After(testTimeout):
		t.Fatalf("channel still open, want %v", target)
	}
	if err := conn.Err(); !errors.Is(err, target) {
		t.Fatalf("channel error = %v, want %v", err, target)
	}
}

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock() *fakeClock {
	return &fakeClock{now: time.Date(2026, 9, 14, 20, 0, 0, 0, time.UTC)}
}

func (clock *fakeClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *fakeClock) Advance(duration time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(duration)
}

// fakeNAT drops unsolicited packets: a phone dial only gets through once the
// desktop sent opening packets to one of the phone addresses.
type fakeNAT struct {
	mu      sync.Mutex
	opened  map[netip.AddrPort]bool
	changed chan struct{}
}

func newFakeNAT() *fakeNAT {
	return &fakeNAT{opened: make(map[netip.AddrPort]bool), changed: make(chan struct{})}
}

func (nat *fakeNAT) open(targets []netip.AddrPort) {
	nat.mu.Lock()
	defer nat.mu.Unlock()
	for _, target := range targets {
		nat.opened[target] = true
	}
	close(nat.changed)
	nat.changed = make(chan struct{})
}

func (nat *fakeNAT) waitOpen(ctx context.Context, addresses []netip.AddrPort) error {
	for {
		nat.mu.Lock()
		changed := nat.changed
		open := slices.ContainsFunc(addresses, func(address netip.AddrPort) bool { return nat.opened[address] })
		nat.mu.Unlock()
		if open {
			return nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

// fakePuncher records its calls. Punch opens the fake NAT, after block is
// closed when block is set; DialCandidates waits until the NAT opened one of
// self.
type fakePuncher struct {
	nat   *fakeNAT
	self  []netip.AddrPort
	block chan struct{}

	mu      sync.Mutex
	punched [][]netip.AddrPort
	dialed  [][]netip.AddrPort
}

var _ transport.Puncher = (*fakePuncher)(nil)

func (puncher *fakePuncher) Punch(ctx context.Context, targets []netip.AddrPort) (transport.PunchReport, error) {
	puncher.mu.Lock()
	puncher.punched = append(puncher.punched, slices.Clone(targets))
	puncher.mu.Unlock()
	if puncher.block != nil {
		select {
		case <-puncher.block:
		case <-ctx.Done():
			return transport.PunchReport{}, ctx.Err()
		}
	}
	puncher.nat.open(targets)
	return transport.PunchReport{Sent: len(targets), Acknowledged: targets[:1]}, nil
}

func (puncher *fakePuncher) DialCandidates(ctx context.Context, targets []netip.AddrPort, peerKey ed25519.PublicKey) (transport.Session, error) {
	puncher.mu.Lock()
	puncher.dialed = append(puncher.dialed, slices.Clone(targets))
	puncher.mu.Unlock()
	if err := puncher.nat.waitOpen(ctx, puncher.self); err != nil {
		return nil, err
	}
	return newFakeSession(identity.EncodePublicKey(peerKey)), nil
}

func (puncher *fakePuncher) calls() (punched, dialed [][]netip.AddrPort) {
	puncher.mu.Lock()
	defer puncher.mu.Unlock()
	return slices.Clone(puncher.punched), slices.Clone(puncher.dialed)
}

func testCard(t testing.TB, desktop *identity.Identity, list ...pairing.Candidate) candidates.Card {
	t.Helper()
	onion, err := tor.GenerateOnionKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	card, err := candidates.NewCard(pairing.Desktop{ID: desktop.ID(), Name: "Mac do estúdio", PublicKey: desktop.PublicKeyString()},
		onion.Address()+":443", list, time.Now(), time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return card
}

func lan(address string) pairing.Candidate {
	return pairing.Candidate{Type: pairing.CandidateLAN, Address: address}
}

func addrPorts(list ...pairing.Candidate) []netip.AddrPort {
	return CandidateSet{Candidates: list}.AddrPorts()
}
