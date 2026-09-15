// SPDX-License-Identifier: Apache-2.0
package candidates

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"tailscale.com/net/stun"
)

const testTimeout = 10 * time.Second

// fakeSocket is a loopback UDP socket that reports a chosen local address, so
// tests can pick the address family while talking to loopback servers.
type fakeSocket struct {
	conn    *net.UDPConn
	local   net.Addr
	handler atomic.Pointer[func([]byte, net.Addr)]
	writes  atomic.Int64
	done    chan struct{}
}

func newFakeSocket(t *testing.T, local string) *fakeSocket {
	t.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	socket := &fakeSocket{conn: conn, local: conn.LocalAddr(), done: make(chan struct{})}
	if local != "" {
		socket.local = net.UDPAddrFromAddrPort(netip.MustParseAddrPort(local))
	}
	go func() {
		defer close(socket.done)
		buffer := make([]byte, 2048)
		for {
			n, from, err := conn.ReadFrom(buffer)
			if err != nil {
				return
			}
			if handler := socket.handler.Load(); handler != nil {
				(*handler)(buffer[:n], from)
			}
		}
	}()
	t.Cleanup(func() {
		_ = conn.Close()
		<-socket.done
	})
	return socket
}

func (socket *fakeSocket) LocalAddr() net.Addr { return socket.local }

func (socket *fakeSocket) WriteTo(packet []byte, to net.Addr) (int, error) {
	socket.writes.Add(1)
	return socket.conn.WriteTo(packet, to)
}

func (socket *fakeSocket) HandlePackets(handler func([]byte, net.Addr)) {
	if handler == nil {
		socket.handler.Store(nil)
		return
	}
	socket.handler.Store(&handler)
}

func (socket *fakeSocket) hasHandler() bool { return socket.handler.Load() != nil }

// stunServer is a fake STUN server on loopback that reflects a fixed address.
type stunServer struct {
	conn      *net.UDPConn
	reflected atomic.Pointer[netip.AddrPort]
	drop      atomic.Int64 // requests to ignore before answering
	silent    atomic.Bool
	spoof     atomic.Pointer[net.UDPConn] // when set, answers come from it
	requests  atomic.Int64
	mu        sync.Mutex
	sources   []netip.AddrPort
	done      chan struct{}
}

func newSTUNServer(t *testing.T, reflected string) *stunServer {
	t.Helper()
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	server := &stunServer{conn: conn, done: make(chan struct{})}
	server.setReflected(reflected)
	go server.serve()
	t.Cleanup(func() {
		_ = conn.Close()
		<-server.done
		if spoof := server.spoof.Load(); spoof != nil {
			_ = spoof.Close()
		}
	})
	return server
}

func (server *stunServer) address() string { return server.conn.LocalAddr().String() }

func (server *stunServer) setReflected(reflected string) {
	address := netip.MustParseAddrPort(reflected)
	server.reflected.Store(&address)
}

func (server *stunServer) serve() {
	defer close(server.done)
	buffer := make([]byte, 2048)
	for {
		n, from, err := server.conn.ReadFromUDP(buffer)
		if err != nil {
			return
		}
		txID, err := stun.ParseBindingRequest(buffer[:n])
		if err != nil {
			continue
		}
		server.requests.Add(1)
		server.mu.Lock()
		server.sources = append(server.sources, from.AddrPort())
		server.mu.Unlock()
		if server.silent.Load() || server.drop.Add(-1) >= 0 {
			continue
		}
		reply := stun.Response(txID, *server.reflected.Load())
		sender := server.conn
		if spoof := server.spoof.Load(); spoof != nil {
			sender = spoof
		}
		_, _ = sender.WriteToUDP(reply, from)
	}
}

func (server *stunServer) seenSources() []netip.AddrPort {
	server.mu.Lock()
	defer server.mu.Unlock()
	return append([]netip.AddrPort(nil), server.sources...)
}

// fakeMapper stands in for the gateway. With renew set, a Mapping call past
// half of the lease extends it in the background, as the real mapper does.
type fakeMapper struct {
	lifetime time.Duration
	renew    bool
	external netip.AddrPort
	protocol string

	mu          sync.Mutex
	notify      func(MapperEvent)
	current     Mapping
	obtained    time.Time
	calls       int
	renewals    int
	lateRenewal bool
	pending     bool
	closed      bool
	renewing    sync.WaitGroup
}

func (mapper *fakeMapper) Start(port uint16, notify func(MapperEvent)) {
	mapper.mu.Lock()
	defer mapper.mu.Unlock()
	mapper.notify = notify
	if mapper.external.IsValid() {
		mapper.grantLocked(time.Now())
	}
}

func (mapper *fakeMapper) grantLocked(now time.Time) {
	mapper.obtained = now
	mapper.current = Mapping{Protocol: mapper.protocol, External: mapper.external, GoodUntil: now.Add(mapper.lifetime)}
}

func (mapper *fakeMapper) Mapping() (Mapping, bool) {
	mapper.mu.Lock()
	defer mapper.mu.Unlock()
	mapper.calls++
	now := time.Now()
	if mapper.closed || !mapper.current.Valid(now) {
		return Mapping{}, false
	}
	if mapper.renew && !mapper.pending && now.After(mapper.obtained.Add(mapper.lifetime/2)) {
		mapper.renewals++
		mapper.pending = true
		mapper.renewing.Go(func() {
			mapper.mu.Lock()
			mapper.pending = false
			if mapper.closed {
				mapper.mu.Unlock()
				return
			}
			renewedAt := time.Now()
			mapper.lateRenewal = mapper.lateRenewal || !renewedAt.Before(mapper.current.GoodUntil)
			mapper.grantLocked(renewedAt)
			notify := mapper.notify
			mapper.mu.Unlock()
			notify(MappingChanged)
		})
	}
	return mapper.current, true
}

func (mapper *fakeMapper) Probe(context.Context) (Services, error) {
	return Services{}, errors.New("fake mapper does not probe")
}

func (mapper *fakeMapper) Close() error {
	mapper.mu.Lock()
	mapper.closed = true
	mapper.mu.Unlock()
	mapper.renewing.Wait()
	return nil
}

func (mapper *fakeMapper) stats() (calls, renewals int, late bool) {
	mapper.mu.Lock()
	defer mapper.mu.Unlock()
	return mapper.calls, mapper.renewals, mapper.lateRenewal
}

// changeRecorder collects the snapshots delivered to OnChange.
type changeRecorder struct {
	snapshots chan Snapshot
}

func newChangeRecorder() *changeRecorder {
	return &changeRecorder{snapshots: make(chan Snapshot, 64)}
}

func (recorder *changeRecorder) onChange(snapshot Snapshot) {
	select {
	case recorder.snapshots <- snapshot:
	default:
	}
}

// waitFor returns the first delivered snapshot that satisfies match.
func (recorder *changeRecorder) waitFor(t *testing.T, what string, match func(Snapshot) bool) Snapshot {
	t.Helper()
	deadline := time.After(testTimeout)
	for {
		select {
		case snapshot := <-recorder.snapshots:
			if match(snapshot) {
				return snapshot
			}
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func staticAddresses(values ...string) func() ([]netip.Addr, error) {
	addresses := make([]netip.Addr, 0, len(values))
	for _, value := range values {
		addresses = append(addresses, netip.MustParseAddr(value))
	}
	return func() ([]netip.Addr, error) { return addresses, nil }
}

func newTestCollector(t *testing.T, config Config) *Collector {
	t.Helper()
	collector, err := New(config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = collector.Close() })
	return collector
}

func hasCandidate(snapshot Snapshot, kind, address string) bool {
	for _, candidate := range snapshot.Candidates {
		if candidate.Type == kind && candidate.Address.String() == address {
			return true
		}
	}
	return false
}

func countType(snapshot Snapshot, kind string) int {
	count := 0
	for _, candidate := range snapshot.Candidates {
		if candidate.Type == kind {
			count++
		}
	}
	return count
}
