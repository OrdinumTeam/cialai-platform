// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/cretz/bine/torutil"
)

func TestOnionKeyPersistsStableV3Address(t *testing.T) {
	path := filepath.Join(t.TempDir(), "private", "onion.key")
	first, created, err := loadOrCreateOnionKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if !created {
		t.Fatal("first load did not create a key")
	}
	firstID := torutil.OnionServiceIDFromPrivateKey(first)
	if len(firstID) != 56 {
		t.Fatalf("v3 service ID length = %d, want 56", len(firstID))
	}
	second, created, err := loadOrCreateOnionKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if created {
		t.Fatal("second load replaced the key")
	}
	if secondID := torutil.OnionServiceIDFromPrivateKey(second); secondID != firstID {
		t.Fatalf("service ID changed from %s to %s", firstID, secondID)
	}
	assertPrivateMode(t, path)
}

func TestIdentityPersistsAndPinsTLS13(t *testing.T) {
	server, _, err := loadOrCreateIdentity(filepath.Join(t.TempDir(), "server.key"))
	if err != nil {
		t.Fatal(err)
	}
	client, _, err := loadOrCreateIdentity(filepath.Join(t.TempDir(), "client.key"))
	if err != nil {
		t.Fatal(err)
	}
	serverSide, clientSide := localConnectionPair(t)
	serverResult := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go func() {
		serverResult <- serveConnection(ctx, serverSide, serverTLSConfig(server, client.public))
	}()
	connection := tls.Client(clientSide, clientTLSConfig(client, server.public))
	if err := connection.HandshakeContext(ctx); err != nil {
		t.Fatal(err)
	}
	if state := connection.ConnectionState(); state.Version != tls.VersionTLS13 || state.NegotiatedProtocol != alpn {
		t.Fatalf("unexpected TLS state: version=%x ALPN=%q", state.Version, state.NegotiatedProtocol)
	}
	if _, err := echoRoundTrip(connection, 7); err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-serverResult; err != nil {
		t.Fatal(err)
	}
}

func TestPinnedTLSRejectsWrongPeer(t *testing.T) {
	server := generatedIdentity(t)
	client := generatedIdentity(t)
	wrong := generatedIdentity(t)
	serverSide, clientSide := localConnectionPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverResult := make(chan error, 1)
	go func() {
		connection := tls.Server(serverSide, serverTLSConfig(server, wrong.public))
		serverResult <- connection.HandshakeContext(ctx)
		_ = connection.Close()
	}()
	connection := tls.Client(clientSide, clientTLSConfig(client, server.public))
	clientErr := connection.HandshakeContext(ctx)
	_ = connection.Close()
	serverErr := <-serverResult
	if clientErr == nil && serverErr == nil {
		t.Fatal("mismatched client pin unexpectedly completed TLS")
	}
}

func TestRendezvousDirectTLSUsesItsOwnPinnedALPN(t *testing.T) {
	server := generatedIdentity(t)
	client := generatedIdentity(t)
	serverSide, clientSide := localConnectionPair(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	serverResult := make(chan error, 1)
	go func() {
		connection := tls.Server(serverSide, directServerTLSConfig(server, client.public))
		serverResult <- connection.HandshakeContext(ctx)
		_ = connection.Close()
	}()
	connection := tls.Client(clientSide, directClientTLSConfig(client, server.public))
	if err := connection.HandshakeContext(ctx); err != nil {
		t.Fatal(err)
	}
	if state := connection.ConnectionState(); state.NegotiatedProtocol != rendezvousDirectALPN {
		t.Fatalf("direct ALPN = %q, want %q", state.NegotiatedProtocol, rendezvousDirectALPN)
	}
	_ = connection.Close()
	if err := <-serverResult; err != nil {
		t.Fatal(err)
	}
}

func TestServerTorrcHasRequiredSingleHopOptions(t *testing.T) {
	root := t.TempDir()
	files := torFiles{
		controlPort: filepath.Join(root, "control-port"),
		dataDir:     filepath.Join(root, "data"),
		geoIP:       filepath.Join(root, "bundle", "data", "geoip"),
		geoIPv6:     filepath.Join(root, "bundle", "data", "geoip6"),
		torrc:       filepath.Join(root, "torrc"),
	}
	if err := writeTorrc(files, "server", 12345); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(files.torrc)
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	for _, option := range []string{
		"SocksPort 0\n",
		"ControlPort auto\n",
		"ControlPortWriteToFile ",
		"CookieAuthentication 1\n",
		"HiddenServiceNonAnonymousMode 1\n",
		"HiddenServiceSingleHopMode 1\n",
		"__OwningControllerProcess 12345\n",
	} {
		if !strings.Contains(text, option) {
			t.Errorf("torrc missing %q:\n%s", option, text)
		}
	}
	assertPrivateMode(t, files.torrc)
}

func TestPercentiles(t *testing.T) {
	median, p95 := percentiles([]time.Duration{
		10 * time.Millisecond,
		50 * time.Millisecond,
		20 * time.Millisecond,
		40 * time.Millisecond,
		30 * time.Millisecond,
	})
	if median != 30*time.Millisecond || p95 != 50*time.Millisecond {
		t.Fatalf("median=%s p95=%s", median, p95)
	}
}

func generatedIdentity(t *testing.T) *identity {
	t.Helper()
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id, err := identityFromPrivate(private)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func localConnectionPair(t *testing.T) (server, client *net.TCPConn) {
	t.Helper()
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.ParseIP("127.0.0.1")})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	accepted := make(chan *net.TCPConn, 1)
	acceptErr := make(chan error, 1)
	go func() {
		connection, err := listener.AcceptTCP()
		if err != nil {
			acceptErr <- err
			return
		}
		accepted <- connection
	}()
	raw, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	connection := raw.(*net.TCPConn)
	select {
	case err := <-acceptErr:
		t.Fatal(err)
	case server := <-accepted:
		return server, connection
	}
	panic("unreachable")
}

func assertPrivateMode(t *testing.T, path string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Fatalf("mode for %s = %04o, want 0600", path, got)
	}
}
