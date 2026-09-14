// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quic-go/quic-go"
)

func TestMutuallyPinnedHandshakeAndEcho(t *testing.T) {
	server := testIdentity(t, "server.key")
	client := testIdentity(t, "client.key")
	listener, serverTransport := testListener(t, server, client.public)
	serveOneEcho(t, listener)
	clientTransport := testTransport(t)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := clientTransport.Dial(ctx, listener.Addr(), clientTLSConfig(client, server.public), quicConfig())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseWithError(0, "test complete")
	latencies, err := measureEcho(ctx, conn, 3, 32)
	if err != nil {
		t.Fatal(err)
	}
	if len(latencies) != 3 || conn.ConnectionState().TLS.Version != 0x0304 {
		t.Fatal("TLS 1.3 echo measurement was not completed")
	}
	_ = serverTransport
}

func TestClientRejectsWrongServerKey(t *testing.T) {
	server := testIdentity(t, "server.key")
	client := testIdentity(t, "client.key")
	wrong := testIdentity(t, "wrong-server.key")
	listener, _ := testListener(t, server, client.public)
	clientTransport := testTransport(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, err := clientTransport.Dial(ctx, listener.Addr(), clientTLSConfig(client, wrong.public), quicConfig())
	if conn != nil {
		_ = conn.CloseWithError(1, "wrong key unexpectedly accepted")
	}
	if err == nil || !strings.Contains(err.Error(), "does not match the pin") {
		t.Fatalf("wrong server key was not rejected by the pin: %v", err)
	}
}

func TestServerRejectsWrongClientKey(t *testing.T) {
	server := testIdentity(t, "server.key")
	client := testIdentity(t, "client.key")
	allowed := testIdentity(t, "allowed-client.key")
	listener, _ := testListener(t, server, allowed.public)
	clientTransport := testTransport(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	accepted := make(chan *quic.Conn, 1)
	go func() {
		conn, err := listener.Accept(ctx)
		if err == nil {
			accepted <- conn
		}
		close(accepted)
	}()
	conn, err := clientTransport.Dial(ctx, listener.Addr(), clientTLSConfig(client, server.public), quicConfig())
	if err == nil {
		_, err = measureEcho(ctx, conn, 1, 8)
		_ = conn.CloseWithError(1, "authentication test complete")
	}
	if err == nil {
		t.Fatal("wrong client key completed an application stream")
	}
	if acceptedConn := <-accepted; acceptedConn != nil {
		_ = acceptedConn.CloseWithError(1, "wrong key unexpectedly accepted")
		t.Fatal("server delivered a connection authenticated with the wrong client key")
	}
}

func TestIdentityPersistsWithPrivatePermissions(t *testing.T) {
	path := filepath.Join(t.TempDir(), "identity.key")
	first, created, err := loadOrCreateIdentity(path)
	if err != nil || !created {
		t.Fatalf("create identity: created=%v err=%v", created, err)
	}
	second, created, err := loadOrCreateIdentity(path)
	if err != nil || created {
		t.Fatalf("reload identity: created=%v err=%v", created, err)
	}
	if !first.public.Equal(second.public) {
		t.Fatal("identity changed after reload")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("identity mode is %04o, want 0600", info.Mode().Perm())
	}
}

func TestOfferRejectsUnknownFieldsAndFingerprintMismatch(t *testing.T) {
	id := testIdentity(t, "offer.key")
	valid := offer{
		Version: offerVersion, Role: "server", PublicKey: encodePublicKey(id.public),
		Fingerprint: fingerprint(id.public),
		Candidates:  []candidate{{Type: "lan", Address: "127.0.0.1:4740"}},
		CreatedAt:   time.Now().UTC(),
	}
	path := filepath.Join(t.TempDir(), "offer.json")
	if err := writeOffer(path, valid); err != nil {
		t.Fatal(err)
	}
	if _, err := readOffer(path); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	raw = []byte(strings.Replace(string(raw), "\n}", ",\n  \"unexpected\": true\n}", 1))
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readOffer(path); err == nil || !strings.Contains(err.Error(), "unknown field") {
		t.Fatalf("unknown offer field was accepted: %v", err)
	}
	valid.Fingerprint = "0000000000000000"
	if err := validateOffer(valid); err == nil {
		t.Fatal("mismatched fingerprint was accepted")
	}
}

func TestNonQUICPunchUsesTheQUICSocket(t *testing.T) {
	left := testTransport(t)
	right := testTransport(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	leftMux := newPacketMux(left, true)
	rightMux := newPacketMux(right, true)
	go leftMux.run(ctx)
	go rightMux.run(ctx)

	remote := right.Conn.LocalAddr()
	attemptCtx, attemptCancel := context.WithTimeout(ctx, time.Second)
	defer attemptCancel()
	if !leftMux.punch(attemptCtx, remote) {
		t.Fatal("non-QUIC punch was not acknowledged")
	}
}

func testIdentity(t *testing.T, name string) *identity {
	t.Helper()
	id, _, err := loadOrCreateIdentity(filepath.Join(t.TempDir(), name))
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func testTransport(t *testing.T) *quic.Transport {
	t.Helper()
	packetConn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	transport := &quic.Transport{Conn: packetConn}
	t.Cleanup(func() {
		_ = transport.Close()
		_ = packetConn.Close()
	})
	return transport
}

func testListener(t *testing.T, id *identity, peer ed25519.PublicKey) (*quic.Listener, *quic.Transport) {
	t.Helper()
	transport := testTransport(t)
	listener, err := transport.Listen(serverTLSConfig(id, peer), quicConfig())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener, transport
}

func serveOneEcho(t *testing.T, listener *quic.Listener) {
	t.Helper()
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		conn, err := listener.Accept(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) {
				t.Logf("accept: %v", err)
			}
			return
		}
		defer conn.CloseWithError(0, "test complete")
		stream, err := conn.AcceptStream(ctx)
		if err != nil {
			t.Logf("accept stream: %v", err)
			return
		}
		defer stream.Close()
		_, _ = io.Copy(stream, stream)
	}()
}
