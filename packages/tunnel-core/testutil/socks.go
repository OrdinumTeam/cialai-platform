// SPDX-License-Identifier: Apache-2.0

package testutil

import (
	"bufio"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
)

// SOCKS is a minimal SOCKS5 server standing in for the Tor client of the
// phone: it connects onion host names to loopback listeners. An onion without
// a route, or every onion while refusing, answers "host unreachable", as Tor
// does for a service that is not published.
type SOCKS struct {
	listener net.Listener
	dials    atomic.Int32
	refused  atomic.Int32
	refuse   atomic.Bool

	mu     sync.Mutex
	routes map[string]string
	conns  map[net.Conn]struct{}
	closed bool
}

const (
	socksVersion         = 0x05
	socksConnect         = 0x01
	socksDomain          = 0x03
	socksSucceeded       = 0x00
	socksHostUnreachable = 0x04
	socksUnsupported     = 0x07
)

func StartSOCKS(t *testing.T) *SOCKS {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &SOCKS{listener: listener, routes: make(map[string]string), conns: make(map[net.Conn]struct{})}
	go server.serve()
	t.Cleanup(server.Close)
	return server
}

// Addr is the loopback address of the SOCKS listener.
func (server *SOCKS) Addr() string { return server.listener.Addr().String() }

// Route sends connections for host, an onion name without port, to target.
func (server *SOCKS) Route(host, target string) {
	server.mu.Lock()
	server.routes[host] = target
	server.mu.Unlock()
}

// SetRefuse makes every connection fail as if no onion were published.
func (server *SOCKS) SetRefuse(refuse bool) { server.refuse.Store(refuse) }

// Dials counts the CONNECT requests and Refused those answered with an error.
func (server *SOCKS) Dials() int   { return int(server.dials.Load()) }
func (server *SOCKS) Refused() int { return int(server.refused.Load()) }

// Close stops accepting and closes every relayed connection.
func (server *SOCKS) Close() {
	server.mu.Lock()
	server.closed = true
	conns := make([]net.Conn, 0, len(server.conns))
	for conn := range server.conns {
		conns = append(conns, conn)
	}
	server.mu.Unlock()
	_ = server.listener.Close()
	for _, conn := range conns {
		_ = conn.Close()
	}
}

func (server *SOCKS) track(conn net.Conn) bool {
	server.mu.Lock()
	defer server.mu.Unlock()
	if server.closed {
		return false
	}
	server.conns[conn] = struct{}{}
	return true
}

func (server *SOCKS) untrack(conn net.Conn) {
	server.mu.Lock()
	delete(server.conns, conn)
	server.mu.Unlock()
}

func (server *SOCKS) serve() {
	for {
		conn, err := server.listener.Accept()
		if err != nil {
			return
		}
		if !server.track(conn) {
			_ = conn.Close()
			return
		}
		go server.relay(conn)
	}
}

func (server *SOCKS) relay(client net.Conn) {
	defer server.untrack(client)
	defer client.Close()
	reader := bufio.NewReader(client)
	host, err := readConnect(reader, client)
	if err != nil {
		return
	}
	server.dials.Add(1)
	server.mu.Lock()
	target, routed := server.routes[host]
	server.mu.Unlock()
	if !routed || server.refuse.Load() {
		server.refused.Add(1)
		_ = writeReply(client, socksHostUnreachable)
		return
	}
	upstream, err := net.Dial("tcp", target)
	if err != nil {
		server.refused.Add(1)
		_ = writeReply(client, socksHostUnreachable)
		return
	}
	if !server.track(upstream) {
		_ = upstream.Close()
		return
	}
	defer server.untrack(upstream)
	defer upstream.Close()
	if err := writeReply(client, socksSucceeded); err != nil {
		return
	}
	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(upstream, reader); _ = closeWrite(upstream); done <- struct{}{} }()
	go func() { _, _ = io.Copy(client, upstream); _ = closeWrite(client); done <- struct{}{} }()
	<-done
	<-done
}

// readConnect runs the no-authentication greeting and reads a CONNECT to a
// domain name, returning the host.
func readConnect(reader *bufio.Reader, client net.Conn) (string, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(reader, header); err != nil || header[0] != socksVersion {
		return "", errors.New("not a SOCKS5 greeting")
	}
	methods := make([]byte, header[1])
	if _, err := io.ReadFull(reader, methods); err != nil {
		return "", err
	}
	if _, err := client.Write([]byte{socksVersion, 0x00}); err != nil {
		return "", err
	}
	request := make([]byte, 4)
	if _, err := io.ReadFull(reader, request); err != nil || request[0] != socksVersion {
		return "", errors.New("not a SOCKS5 request")
	}
	if request[1] != socksConnect || request[3] != socksDomain {
		_ = writeReply(client, socksUnsupported)
		return "", errors.New("only CONNECT to a domain name is supported")
	}
	length, err := reader.ReadByte()
	if err != nil {
		return "", err
	}
	// The domain is followed by the two port bytes, which every route ignores.
	name := make([]byte, int(length)+2)
	if _, err := io.ReadFull(reader, name); err != nil {
		return "", err
	}
	return string(name[:length]), nil
}

func writeReply(client net.Conn, status byte) error {
	_, err := client.Write([]byte{socksVersion, status, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	return err
}

func closeWrite(conn net.Conn) error {
	if half, ok := conn.(interface{ CloseWrite() error }); ok {
		return half.CloseWrite()
	}
	return conn.Close()
}
