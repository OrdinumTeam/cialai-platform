// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

// fakeSOCKS is a SOCKS5 proxy that only resolves the onion names in routes.
type fakeSOCKS struct {
	listener net.Listener
	routes   map[string]string
	silent   bool

	mu       sync.Mutex
	requests []string
}

func startFakeSOCKS(t *testing.T, routes map[string]string, silent bool) *fakeSOCKS {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	proxy := &fakeSOCKS{listener: listener, routes: routes, silent: silent}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go proxy.serve(conn)
		}
	}()
	return proxy
}

func (proxy *fakeSOCKS) seen() []string {
	proxy.mu.Lock()
	defer proxy.mu.Unlock()
	return append([]string(nil), proxy.requests...)
}

func (proxy *fakeSOCKS) serve(conn net.Conn) {
	defer conn.Close()
	if proxy.silent {
		_, _ = io.Copy(io.Discard, conn)
		return
	}
	header := make([]byte, 2)
	if _, err := io.ReadFull(conn, header); err != nil || header[0] != 5 {
		return
	}
	if _, err := io.ReadFull(conn, make([]byte, header[1])); err != nil {
		return
	}
	_, _ = conn.Write([]byte{5, 0})
	request := make([]byte, 5)
	if _, err := io.ReadFull(conn, request); err != nil || request[1] != 1 {
		return
	}
	if request[3] != 3 {
		// Only domain names are acceptable: an IP would mean local DNS.
		_, _ = conn.Write([]byte{5, 8, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	rest := make([]byte, int(request[4])+2)
	if _, err := io.ReadFull(conn, rest); err != nil {
		return
	}
	host := string(rest[:request[4]])
	port := binary.BigEndian.Uint16(rest[request[4]:])
	target := net.JoinHostPort(host, strconv.Itoa(int(port)))
	proxy.mu.Lock()
	proxy.requests = append(proxy.requests, target)
	proxy.mu.Unlock()
	backend, ok := proxy.routes[target]
	var upstream net.Conn
	var err error
	if ok {
		upstream, err = net.Dial("tcp", backend)
	}
	if !ok || err != nil {
		_, _ = conn.Write([]byte{5, 4, 0, 1, 0, 0, 0, 0, 0, 0})
		return
	}
	defer upstream.Close()
	_, _ = conn.Write([]byte{5, 0, 0, 1, 0, 0, 0, 0, 0, 0})
	go func() {
		_, _ = io.Copy(upstream, conn)
		_ = upstream.Close()
	}()
	_, _ = io.Copy(conn, upstream)
}

// startPinnedEchoServer serves mutual TLS with the desktop identity and echoes
// one line, reporting the phone key it saw.
func startPinnedEchoServer(t *testing.T, desktop *identity.Identity) (string, <-chan string) {
	t.Helper()
	config, err := identity.ServerConfig(desktop)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := tls.Listen("tcp", "127.0.0.1:0", config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	peers := make(chan string, 8)
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				server := conn.(*tls.Conn)
				_ = server.SetDeadline(time.Now().Add(5 * time.Second))
				if err := server.Handshake(); err != nil {
					return
				}
				if peer, err := identity.ServerPeer(server.ConnectionState(), nil); err == nil {
					peers <- peer.Key
				}
				_, _ = io.Copy(server, server)
			}()
		}
	}()
	return listener.Addr().String(), peers
}

func TestClientEndpointsValidation(t *testing.T) {
	client := NewClient()
	if _, ok := client.TorEndpoints(); ok {
		t.Fatal("new client has endpoints")
	}
	for name, endpoints := range map[string]Endpoints{
		"missing SOCKS":          {Control: "127.0.0.1:9051"},
		"remote SOCKS":           {SOCKS: "192.0.2.1:9050"},
		"bad control":            {SOCKS: "127.0.0.1:9050", Control: "tor:9051"},
		"cookie without control": {SOCKS: "127.0.0.1:9050", CookiePath: "/tmp/cookie"},
		"relative cookie":        {SOCKS: "127.0.0.1:9050", Control: "127.0.0.1:9051", CookiePath: "cookie"},
	} {
		if err := client.SetTorEndpoints(endpoints); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	valid := Endpoints{SOCKS: "unix:/data/tor/socks", Control: "127.0.0.1:9051", CookiePath: "/data/tor/control_auth_cookie"}
	if err := client.SetTorEndpoints(valid); err != nil {
		t.Fatal(err)
	}
	if got, ok := client.TorEndpoints(); !ok || got != valid {
		t.Fatalf("TorEndpoints = %+v %v", got, ok)
	}
	if err := client.SetTorEndpoints(Endpoints{}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Dial(context.Background(), mustOnion(t)); !errors.Is(err, ErrNoEndpoints) {
		t.Fatalf("Dial after clearing = %v", err)
	}
	if _, err := client.Bootstrap(context.Background()); !errors.Is(err, ErrNoEndpoints) {
		t.Fatalf("Bootstrap after clearing = %v", err)
	}
}

func mustOnion(t *testing.T) string {
	t.Helper()
	key, err := GenerateOnionKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return key.Address()
}

func TestClientDialsOnionByNameWithPinnedTLS(t *testing.T) {
	desktop, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	phone, err := identity.Generate(identity.RolePhone, nil)
	if err != nil {
		t.Fatal(err)
	}
	backend, peers := startPinnedEchoServer(t, desktop)
	onion := mustOnion(t)
	socks := startFakeSOCKS(t, map[string]string{onion + ":443": backend}, false)
	client := NewClient()
	if err := client.SetTorEndpoints(Endpoints{SOCKS: socks.listener.Addr().String()}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	conn, err := client.DialTLS(ctx, onion, phone, desktop.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if state := conn.ConnectionState(); state.Version != tls.VersionTLS13 || state.NegotiatedProtocol != identity.ALPN {
		t.Fatalf("TLS state version %x ALPN %q", state.Version, state.NegotiatedProtocol)
	}
	if _, err := conn.Write([]byte("ping\n")); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, 5)
	if _, err := io.ReadFull(conn, echo); err != nil || !bytes.Equal(echo, []byte("ping\n")) {
		t.Fatalf("echo = %q, %v", echo, err)
	}
	if peer := <-peers; peer != phone.PublicKeyString() {
		t.Fatalf("server saw phone key %s", peer)
	}
	if seen := socks.seen(); len(seen) != 1 || seen[0] != onion+":443" {
		t.Fatalf("SOCKS requests = %q", seen)
	}

	impostor, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.DialTLS(ctx, onion, phone, impostor.PublicKey()); !errors.Is(err, identity.ErrPinMismatch) {
		t.Fatalf("wrong pin err = %v", err)
	}
	if _, err := client.Dial(ctx, mustOnion(t)); err == nil {
		t.Fatal("unpublished onion dialed")
	}
	before := len(socks.seen())
	if _, err := client.Dial(ctx, "example.com"); !errors.Is(err, ErrInvalidOnionAddress) {
		t.Fatalf("clearnet host err = %v", err)
	}
	if len(socks.seen()) != before {
		t.Fatal("an invalid onion reached the SOCKS proxy")
	}
	if _, err := client.DialTLS(ctx, onion, nil, desktop.PublicKey()); err == nil {
		t.Fatal("DialTLS without a local identity succeeded")
	}
}

func TestClientDialHonorsContext(t *testing.T) {
	socks := startFakeSOCKS(t, nil, true)
	client := NewClient()
	if err := client.SetTorEndpoints(Endpoints{SOCKS: socks.listener.Addr().String()}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := client.Dial(ctx, mustOnion(t)); err == nil {
		t.Fatal("dial through a silent proxy succeeded")
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("dial ignored its deadline for %s", elapsed)
	}
}

func TestClientBootstrapThroughControlPort(t *testing.T) {
	_, address, cookie := startFakeTor(t)
	client := NewClient()
	if err := client.SetTorEndpoints(Endpoints{SOCKS: "127.0.0.1:9050"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := client.Bootstrap(ctx); !errors.Is(err, ErrNoControlEndpoint) {
		t.Fatalf("Bootstrap without control = %v", err)
	}
	if err := client.SetTorEndpoints(Endpoints{SOCKS: "127.0.0.1:9050", Control: address, CookiePath: cookie}); err != nil {
		t.Fatal(err)
	}
	status, err := client.Bootstrap(ctx)
	if err != nil || status.Tag != "starting" {
		t.Fatalf("Bootstrap = %+v, %v", status, err)
	}
}

func TestClientEndpointsConcurrentUse(t *testing.T) {
	client := NewClient()
	var wait sync.WaitGroup
	for index := range 8 {
		wait.Go(func() {
			for round := range 200 {
				endpoints := Endpoints{SOCKS: "127.0.0.1:" + strconv.Itoa(9000+index*round%1000+1)}
				if round%3 == 0 {
					endpoints = Endpoints{}
				}
				if err := client.SetTorEndpoints(endpoints); err != nil {
					t.Error(err)
					return
				}
				client.TorEndpoints()
			}
		})
	}
	wait.Wait()
}
