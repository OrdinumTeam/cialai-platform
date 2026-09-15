// SPDX-License-Identifier: Apache-2.0
//go:build netlab

package main

import (
	"bufio"
	"errors"
	"flag"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The relay is the simulated Tor network of the laboratory. Like Tor, both
// ends only connect outbound to it, so NAT and blocked UDP on either side do
// not matter:
//
//   - an onion service connects to the service port and sends
//     "PUBLISH <service id>"; the connection stays open as its control
//     channel and the service is unpublished when it closes;
//   - a phone connects to the SOCKS5 port and asks for "<id>.onion"; the relay
//     sends "STREAM <n>" on the control channel of that service, which opens a
//     new connection with "ATTACH <id> <n>", and splices both.
//
// An onion without a published service answers "host unreachable", as Tor
// does while the descriptor is not available. The relay never sees the
// payload in clear: phone and desktop run the pinned TLS end to end.
type relay struct {
	logger *log.Logger

	mu       sync.Mutex
	services map[string]*publishedService
	pending  map[string]pendingStream
	next     uint64
}

// pendingStream waits for the ATTACH of one stream. The channel is buffered
// and only closed after the entry left the map, so ATTACH never sends on a
// closed channel.
type pendingStream struct {
	service *publishedService
	attach  chan attachment
}

type publishedService struct {
	conn    net.Conn
	writeMu sync.Mutex
}

type attachment struct {
	conn   net.Conn
	reader *bufio.Reader
}

const (
	relayAttachTimeout = 10 * time.Second
	relayLineTimeout   = 10 * time.Second
)

func runRelay(args []string) int {
	flags := flag.NewFlagSet("relay", flag.ContinueOnError)
	socksAddr := flags.String("socks", ":9050", "entrada SOCKS5 dos celulares")
	serviceAddr := flags.String("service", ":9051", "porta dos serviços onion")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	server := &relay{
		logger:   log.New(os.Stderr, "relay: ", log.LstdFlags|log.Lmicroseconds),
		services: map[string]*publishedService{},
		pending:  map[string]pendingStream{},
	}
	socks, err := net.Listen("tcp", *socksAddr)
	if err != nil {
		server.logger.Print(err)
		return 1
	}
	services, err := net.Listen("tcp", *serviceAddr)
	if err != nil {
		server.logger.Print(err)
		return 1
	}
	server.logger.Printf("SOCKS em %s, serviços em %s", socks.Addr(), services.Addr())
	go server.accept(services, server.serveService)
	server.accept(socks, server.serveSOCKS)
	return 1
}

func (server *relay) accept(listener net.Listener, handle func(net.Conn)) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			server.logger.Print(err)
			return
		}
		go handle(conn)
	}
}

func (server *relay) serveService(conn net.Conn) {
	reader := bufio.NewReader(conn)
	_ = conn.SetReadDeadline(time.Now().Add(relayLineTimeout))
	line, err := reader.ReadString('\n')
	_ = conn.SetReadDeadline(time.Time{})
	if err != nil {
		_ = conn.Close()
		return
	}
	fields := strings.Fields(line)
	switch {
	case len(fields) == 2 && fields[0] == "PUBLISH" && validServiceID(fields[1]):
		server.publish(fields[1], conn, reader)
	case len(fields) == 3 && fields[0] == "ATTACH":
		server.mu.Lock()
		waiter, found := server.pending[fields[1]+" "+fields[2]]
		delete(server.pending, fields[1]+" "+fields[2])
		server.mu.Unlock()
		if !found {
			_ = conn.Close()
			return
		}
		waiter.attach <- attachment{conn: conn, reader: reader}
	default:
		_ = conn.Close()
	}
}

func (server *relay) publish(id string, conn net.Conn, reader *bufio.Reader) {
	service := &publishedService{conn: conn}
	server.mu.Lock()
	previous := server.services[id]
	server.services[id] = service
	server.mu.Unlock()
	if previous != nil {
		_ = previous.conn.Close()
	}
	if err := service.send("OK"); err != nil {
		server.unpublish(id, service)
		return
	}
	server.logger.Printf("publicado %s.onion a partir de %s", id, conn.RemoteAddr())
	// The service sends nothing more; the read only notices the end.
	_, _ = io.Copy(io.Discard, reader)
	server.unpublish(id, service)
}

// unpublish removes service and fails the streams waiting for it at once, as
// the circuits of a Tor process that ended fail.
func (server *relay) unpublish(id string, service *publishedService) {
	server.mu.Lock()
	current := server.services[id] == service
	if current {
		delete(server.services, id)
	}
	for key, waiter := range server.pending {
		if waiter.service == service {
			delete(server.pending, key)
			close(waiter.attach)
		}
	}
	server.mu.Unlock()
	_ = service.conn.Close()
	if current {
		server.logger.Printf("retirado %s.onion", id)
	}
}

func (service *publishedService) send(line string) error {
	service.writeMu.Lock()
	defer service.writeMu.Unlock()
	_ = service.conn.SetWriteDeadline(time.Now().Add(relayLineTimeout))
	_, err := io.WriteString(service.conn, line+"\n")
	return err
}

func (server *relay) serveSOCKS(client net.Conn) {
	reader := bufio.NewReader(client)
	_ = client.SetDeadline(time.Now().Add(relayLineTimeout))
	host, err := readSOCKSConnect(reader, client)
	if err != nil {
		_ = client.Close()
		return
	}
	id, isOnion := strings.CutSuffix(host, ".onion")
	server.mu.Lock()
	service := server.services[id]
	server.next++
	key := id + " " + strconv.FormatUint(server.next, 10)
	waiter := pendingStream{service: service, attach: make(chan attachment, 1)}
	if service != nil {
		server.pending[key] = waiter
	}
	server.mu.Unlock()
	if !isOnion || service == nil {
		server.logger.Printf("SOCKS de %s para %s: serviço não publicado", client.RemoteAddr(), host)
		_ = writeSOCKSReply(client, socksHostUnreachable)
		_ = client.Close()
		return
	}
	if err := service.send("STREAM " + key[len(id)+1:]); err != nil {
		server.dropPending(key)
		_ = writeSOCKSReply(client, socksHostUnreachable)
		_ = client.Close()
		return
	}
	timer := time.NewTimer(relayAttachTimeout)
	defer timer.Stop()
	select {
	case attached, ok := <-waiter.attach:
		if !ok {
			server.logger.Printf("SOCKS de %s para %s: o serviço saiu antes do stream", client.RemoteAddr(), host)
			_ = writeSOCKSReply(client, socksHostUnreachable)
			_ = client.Close()
			return
		}
		_ = client.SetDeadline(time.Time{})
		if err := writeSOCKSReply(client, socksSucceeded); err != nil {
			_ = client.Close()
			_ = attached.conn.Close()
			return
		}
		splice(client, reader, attachedConn(attached))
	case <-timer.C:
		server.dropPending(key)
		_ = writeSOCKSReply(client, socksHostUnreachable)
		_ = client.Close()
	}
}

func (server *relay) dropPending(key string) {
	server.mu.Lock()
	delete(server.pending, key)
	server.mu.Unlock()
}

// attachedConn reads the bytes the relay already buffered after ATTACH first.
func attachedConn(attached attachment) net.Conn {
	return &bufferedConn{Conn: attached.conn, reader: attached.reader}
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (conn *bufferedConn) Read(data []byte) (int, error) { return conn.reader.Read(data) }

func (conn *bufferedConn) CloseWrite() error {
	if half, ok := conn.Conn.(interface{ CloseWrite() error }); ok {
		return half.CloseWrite()
	}
	return conn.Conn.Close()
}

const (
	socksVersion         = 0x05
	socksConnect         = 0x01
	socksDomain          = 0x03
	socksSucceeded       = 0x00
	socksHostUnreachable = 0x04
	socksUnsupported     = 0x07
)

// readSOCKSConnect runs the no-authentication greeting and reads a CONNECT to a
// domain name, as tor.Client sends it.
func readSOCKSConnect(reader *bufio.Reader, client net.Conn) (string, error) {
	header := make([]byte, 2)
	if _, err := io.ReadFull(reader, header); err != nil || header[0] != socksVersion {
		return "", errors.New("not a SOCKS5 greeting")
	}
	if _, err := io.ReadFull(reader, make([]byte, header[1])); err != nil {
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
		_ = writeSOCKSReply(client, socksUnsupported)
		return "", errors.New("only CONNECT to a domain name is supported")
	}
	length, err := reader.ReadByte()
	if err != nil {
		return "", err
	}
	name := make([]byte, int(length)+2)
	if _, err := io.ReadFull(reader, name); err != nil {
		return "", err
	}
	return string(name[:length]), nil
}

func writeSOCKSReply(client net.Conn, status byte) error {
	_, err := client.Write([]byte{socksVersion, status, 0x00, 0x01, 0, 0, 0, 0, 0, 0})
	return err
}

func validServiceID(id string) bool {
	if len(id) != 56 {
		return false
	}
	for _, character := range id {
		if (character < 'a' || character > 'z') && (character < '2' || character > '7') {
			return false
		}
	}
	return true
}
