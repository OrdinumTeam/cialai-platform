// SPDX-License-Identifier: Apache-2.0

package rendezvous

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"math/big"
	"net"
	"net/netip"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestClientAndServerSwitchFromTorToDirect(t *testing.T) {
	serverKey := testKey(1)
	clientKey := testKey(2)
	serverCandidates := []Candidate{{Type: "mapped", Address: "198.51.100.10:4740", Protocol: "pcp"}}
	clientCandidates := []Candidate{
		{Type: "lan", Address: "192.168.1.20:58321"},
		{Type: "stun", Address: "203.0.113.20:58321", Protocol: "stun.example:3478"},
	}
	network := newFakeNetwork(clientCandidates)
	serverDirect := &fakeDirect{role: "server", key: serverKey, candidates: serverCandidates, network: network}
	clientDirect := &fakeDirect{role: "client", key: clientKey, candidates: clientCandidates, network: network}
	serverControl, clientControl, closeControls := controlPair(t)
	defer closeControls()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	type result struct {
		outcome Outcome
		err     error
	}
	serverResult := make(chan result, 1)
	go func() {
		outcome, err := Server(ctx, serverControl, serverDirect, clientKey)
		serverResult <- result{outcome: outcome, err: err}
	}()
	clientOutcome, err := Client(ctx, clientControl, clientDirect, serverKey)
	if err != nil {
		t.Fatal(err)
	}
	server := <-serverResult
	if server.err != nil {
		t.Fatal(server.err)
	}
	if clientOutcome.Measurement.Path != PathDirect || server.outcome.Measurement.Path != PathDirect {
		t.Fatalf("paths client=%q server=%q", clientOutcome.Measurement.Path, server.outcome.Measurement.Path)
	}
	if clientOutcome.Measurement.SessionID != server.outcome.Measurement.SessionID {
		t.Fatal("client and server recorded different session IDs")
	}
	if clientOutcome.Measurement.ConfirmedAfterMS <= 0 || server.outcome.Measurement.ConfirmedAfterMS <= 0 {
		t.Fatal("switch duration was not recorded")
	}
	punched := network.serverPunchCandidates()
	if !slices.Contains(punched, clientCandidates[1]) {
		t.Fatalf("server did not punch the reflected client candidate: %+v", punched)
	}
	if clientOutcome.Connection == nil || server.outcome.Connection == nil {
		t.Fatal("direct connection was not returned to both peers")
	}
	_ = clientOutcome.Connection.Close()
	_ = server.outcome.Connection.Close()
}

func TestFailedDirectDialKeepsTorControlPath(t *testing.T) {
	serverKey := testKey(3)
	clientKey := testKey(4)
	clientCandidates := []Candidate{{Type: "stun", Address: "203.0.113.40:50000"}}
	network := newFakeNetwork(clientCandidates)
	network.dialErr = errors.New("symmetric NAT")
	serverDirect := &fakeDirect{
		role: "server", key: serverKey,
		candidates: []Candidate{{Type: "stun", Address: "198.51.100.30:4740"}}, network: network,
	}
	clientDirect := &fakeDirect{role: "client", key: clientKey, candidates: clientCandidates, network: network}
	serverControl, clientControl, closeControls := controlPair(t)
	defer closeControls()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	type result struct {
		outcome Outcome
		err     error
	}
	serverResult := make(chan result, 1)
	go func() {
		outcome, err := Server(ctx, serverControl, serverDirect, clientKey)
		serverResult <- result{outcome: outcome, err: err}
	}()
	clientOutcome, err := Client(ctx, clientControl, clientDirect, serverKey)
	if err != nil {
		t.Fatal(err)
	}
	server := <-serverResult
	if server.err != nil {
		t.Fatal(server.err)
	}
	if clientOutcome.Measurement.Path != PathTor || server.outcome.Measurement.Path != PathTor {
		t.Fatalf("fallback paths client=%q server=%q", clientOutcome.Measurement.Path, server.outcome.Measurement.Path)
	}
	if clientOutcome.Connection != nil || server.outcome.Connection != nil {
		t.Fatal("fallback unexpectedly returned a direct connection")
	}
	if clientOutcome.Measurement.Failure == "" || server.outcome.Measurement.Failure == "" {
		t.Fatal("fallback reason was not recorded")
	}
}

func TestClientRejectsOfferKeyDifferentFromTorPeer(t *testing.T) {
	serverKey := testKey(5)
	clientKey := testKey(6)
	network := newFakeNetwork([]Candidate{{Type: "stun", Address: "203.0.113.60:50000"}})
	serverDirect := &fakeDirect{
		role: "server", key: serverKey,
		candidates: []Candidate{{Type: "stun", Address: "198.51.100.50:4740"}}, network: network,
	}
	clientDirect := &fakeDirect{
		role: "client", key: clientKey,
		candidates: []Candidate{{Type: "stun", Address: "203.0.113.60:50000"}}, network: network,
	}
	serverControl, clientControl, closeControls := controlPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	serverDone := make(chan error, 1)
	go func() {
		_, err := Server(ctx, serverControl, serverDirect, clientKey)
		serverDone <- err
	}()
	_, err := Client(ctx, clientControl, clientDirect, testKey(99))
	if err == nil || !strings.Contains(err.Error(), "does not match the authenticated Tor peer") {
		t.Fatalf("unexpected client error: %v", err)
	}
	cancel()
	closeControls()
	<-serverDone
}

func TestProtocolRejectsUnknownAndMismatchedFields(t *testing.T) {
	sessionID := base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{9}, 32))
	valid := []byte(`{"version":1,"type":"fallback","sessionId":"` + sessionID + `","reason":"timeout"}`)
	message, err := decodeMessage(valid)
	if err != nil {
		t.Fatal(err)
	}
	if message.Type != MessageFallback {
		t.Fatalf("type = %q", message.Type)
	}
	for _, raw := range [][]byte{
		append(slices.Clone(valid), []byte(` {}`)...),
		[]byte(`{"version":1,"type":"fallback","sessionId":"` + sessionID + `","reason":"timeout","unknown":true}`),
		[]byte(`{"version":1,"type":"direct_ready","sessionId":"` + sessionID + `","reason":"wrong"}`),
	} {
		if _, err := decodeMessage(raw); err == nil {
			t.Fatalf("invalid message accepted: %s", raw)
		}
	}
}

func TestProtocolCapsControlMessage(t *testing.T) {
	reader := bufio.NewReader(bytes.NewReader(append(bytes.Repeat([]byte{'x'}, maxMessageBytes), '\n')))
	if _, err := readBoundedLine(reader); err == nil {
		t.Fatal("oversized control message was accepted")
	}
}

func TestTLSControlUsesAuthenticatedPeerKey(t *testing.T) {
	serverCertificate, serverPublic := testCertificate(t, "server")
	clientCertificate, clientPublic := testCertificate(t, "client")
	serverRaw, clientRaw := net.Pipe()
	t.Cleanup(func() {
		_ = serverRaw.Close()
		_ = clientRaw.Close()
	})
	serverTLS := tls.Server(serverRaw, &tls.Config{
		MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverCertificate},
		ClientAuth: tls.RequireAnyClientCert,
	})
	clientTLS := tls.Client(clientRaw, &tls.Config{
		MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{clientCertificate},
		InsecureSkipVerify: true, // Test-only certificate; the adapter checks the accepted peer key.
	})
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	type result struct {
		control *TLSControl
		err     error
	}
	serverResult := make(chan result, 1)
	go func() {
		control, err := NewTLSControl(ctx, serverTLS)
		serverResult <- result{control: control, err: err}
	}()
	clientControl, err := NewTLSControl(ctx, clientTLS)
	if err != nil {
		t.Fatal(err)
	}
	server := <-serverResult
	if server.err != nil {
		t.Fatal(server.err)
	}
	if clientControl.PeerPublicKey != base64.RawURLEncoding.EncodeToString(serverPublic) {
		t.Fatal("client control did not expose the authenticated server key")
	}
	if server.control.PeerPublicKey != base64.RawURLEncoding.EncodeToString(clientPublic) {
		t.Fatal("server control did not expose the authenticated client key")
	}
	sessionID, err := NewSessionID()
	if err != nil {
		t.Fatal(err)
	}
	want := Message{Version: ProtocolVersion, Type: MessageFallback, SessionID: sessionID, Reason: "test"}
	if err := clientControl.Send(ctx, want); err != nil {
		t.Fatal(err)
	}
	got, err := server.control.Receive(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("message = %+v, want %+v", got, want)
	}
}

func TestQUICDirectTransportUsesOneSocketForOfferPunchDialAndAccept(t *testing.T) {
	serverCertificate, serverPublic := testCertificate(t, "quic-server")
	clientCertificate, clientPublic := testCertificate(t, "quic-client")
	const directALPN = "cialai-rendezvous-test/1"
	serverPacket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	clientPacket, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		_ = serverPacket.Close()
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverDirect, err := NewQUICDirectTransport(ctx, QUICDirectConfig{
		PacketConn: serverPacket, PublicKey: base64.RawURLEncoding.EncodeToString(serverPublic),
		ServerTLS: &tls.Config{
			MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{serverCertificate},
			ClientAuth: tls.RequireAnyClientCert, NextProtos: []string{directALPN},
		},
		IncludeLoopback: true, CollectionTimeout: 25 * time.Millisecond,
	})
	if err != nil {
		_ = clientPacket.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = serverDirect.Close() })
	clientDirect, err := NewQUICDirectTransport(ctx, QUICDirectConfig{
		PacketConn: clientPacket, PublicKey: base64.RawURLEncoding.EncodeToString(clientPublic),
		ClientTLS: &tls.Config{
			MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{clientCertificate},
			NextProtos: []string{directALPN}, InsecureSkipVerify: true,
		},
		IncludeLoopback: true, CollectionTimeout: 25 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = clientDirect.Close() })
	serverOffer, err := serverDirect.Offer(ctx, "server")
	if err != nil {
		t.Fatal(err)
	}
	clientOffer, err := clientDirect.Offer(ctx, "client")
	if err != nil {
		t.Fatal(err)
	}
	serverPort, _ := packetPort(serverPacket.LocalAddr())
	if !offerContainsPort(serverOffer, uint16(serverPort)) {
		t.Fatalf("server offer does not use its QUIC socket port %d: %+v", serverPort, serverOffer.Candidates)
	}
	punchContext, cancelPunch := context.WithTimeout(ctx, time.Second)
	report, err := clientDirect.Punch(punchContext, serverOffer.Candidates)
	cancelPunch()
	if err != nil || report.Sent == 0 || report.Acknowledged == 0 {
		t.Fatalf("punch report=%+v err=%v", report, err)
	}
	type acceptResult struct {
		connection DirectConnection
		err        error
	}
	accepted := make(chan acceptResult, 1)
	go func() {
		connection, err := serverDirect.Accept(ctx)
		accepted <- acceptResult{connection: connection, err: err}
	}()
	clientConnection, err := clientDirect.Dial(ctx, serverOffer.Candidates)
	if err != nil {
		t.Fatal(err)
	}
	defer clientConnection.Close()
	serverConnection := <-accepted
	if serverConnection.err != nil {
		t.Fatal(serverConnection.err)
	}
	defer serverConnection.connection.Close()
	if !containsCandidate(serverOffer.Candidates, clientConnection.Candidate()) {
		t.Fatalf("dial selected a candidate outside the offer: %+v", clientConnection.Candidate())
	}
	if !offerContainsPort(clientOffer, uint16(clientPacket.LocalAddr().(*net.UDPAddr).Port)) {
		t.Fatal("client offer does not use its QUIC socket port")
	}
}

func offerContainsPort(offer Offer, port uint16) bool {
	for _, candidate := range offer.Candidates {
		address, err := netip.ParseAddrPort(candidate.Address)
		if err == nil && address.Port() == port {
			return true
		}
	}
	return false
}

func testCertificate(t *testing.T, name string) (tls.Certificate, ed25519.PublicKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage:    x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: private, Leaf: leaf}, public
}

type fakeNetwork struct {
	accept            chan DirectConnection
	clientCandidates  []Candidate
	dialErr           error
	serverPunched     chan struct{}
	serverPunchedOnce sync.Once
	mu                sync.Mutex
	serverPunch       []Candidate
}

func newFakeNetwork(clientCandidates []Candidate) *fakeNetwork {
	return &fakeNetwork{
		accept:           make(chan DirectConnection, 1),
		clientCandidates: slices.Clone(clientCandidates),
		serverPunched:    make(chan struct{}),
	}
}

func (network *fakeNetwork) serverPunchCandidates() []Candidate {
	network.mu.Lock()
	defer network.mu.Unlock()
	return slices.Clone(network.serverPunch)
}

type fakeDirect struct {
	role       string
	key        string
	candidates []Candidate
	network    *fakeNetwork
}

func (direct *fakeDirect) Offer(_ context.Context, role string) (Offer, error) {
	if role != direct.role {
		return Offer{}, errors.New("wrong fake role")
	}
	return Offer{Role: role, PublicKey: direct.key, Candidates: slices.Clone(direct.candidates)}, nil
}

func (direct *fakeDirect) Punch(_ context.Context, candidates []Candidate) (PunchReport, error) {
	if direct.role == "server" {
		direct.network.mu.Lock()
		direct.network.serverPunch = slices.Clone(candidates)
		direct.network.mu.Unlock()
		direct.network.serverPunchedOnce.Do(func() { close(direct.network.serverPunched) })
	}
	return PunchReport{Sent: len(candidates), Acknowledged: 1}, nil
}

func (direct *fakeDirect) Dial(ctx context.Context, candidates []Candidate) (DirectConnection, error) {
	if direct.role != "client" {
		return nil, errors.New("only fake client dials")
	}
	if direct.network.dialErr != nil {
		return nil, direct.network.dialErr
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-direct.network.serverPunched:
	}
	clientConnection := &fakeConnection{candidate: candidates[0]}
	serverConnection := &fakeConnection{candidate: direct.network.clientCandidates[0]}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case direct.network.accept <- serverConnection:
		return clientConnection, nil
	}
}

func (direct *fakeDirect) Accept(ctx context.Context) (DirectConnection, error) {
	if direct.role != "server" {
		return nil, errors.New("only fake server accepts")
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case connection := <-direct.network.accept:
		return connection, nil
	}
}

type fakeConnection struct {
	candidate Candidate
}

func (connection *fakeConnection) Candidate() Candidate { return connection.candidate }
func (*fakeConnection) Close() error                    { return nil }

func controlPair(t *testing.T) (server, client Control, close func()) {
	t.Helper()
	serverStream, clientStream := net.Pipe()
	return NewJSONControl(serverStream), NewJSONControl(clientStream), func() {
		_ = serverStream.Close()
		_ = clientStream.Close()
	}
}

func testKey(value byte) string {
	return base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{value}, 32))
}
