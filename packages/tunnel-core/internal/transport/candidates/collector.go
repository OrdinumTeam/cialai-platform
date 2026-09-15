// SPDX-License-Identifier: Apache-2.0
package candidates

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"slices"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

const (
	// DefaultSTUNTimeout bounds one STUN round over every server.
	DefaultSTUNTimeout = 2 * time.Second
	// DefaultMappingRetry is how long the collector waits before asking the
	// gateway again when there is no mapping.
	DefaultMappingRetry = 2 * time.Minute
	// minRenewalWait keeps renewal checks apart when a lease is about to end.
	minRenewalWait = 100 * time.Millisecond
)

// Socket is the UDP socket shared with the QUIC endpoint; *direct.Endpoint
// implements it. The collector installs the non-QUIC packet handler when STUN
// is enabled and removes it on Close.
type Socket interface {
	LocalAddr() net.Addr
	WriteTo(packet []byte, to net.Addr) (int, error)
	HandlePackets(handler func(packet []byte, from net.Addr))
}

// Config describes a collector.
type Config struct {
	// Socket is required; candidates use its local port.
	Socket Socket
	// STUNServers lists "host:port" STUN servers. Empty disables STUN, the
	// only source that reaches a server outside the local network.
	STUNServers []string
	// STUNTimeout bounds a STUN round; zero means DefaultSTUNTimeout.
	STUNTimeout time.Duration
	// PortMapper maps the port on the gateway; nil disables mapping. The
	// collector starts it and closes it on Close.
	PortMapper PortMapper
	// MappingRetry is the wait before trying again without a mapping; zero
	// means DefaultMappingRetry.
	MappingRetry time.Duration
	// Addresses lists the local addresses; nil means InterfaceAddresses.
	Addresses func() ([]netip.Addr, error)
	// OnChange receives every new candidate list, in order and never
	// concurrently. It must not call Close.
	OnChange func(Snapshot)
	// Logf receives diagnostics; nil discards them.
	Logf func(format string, args ...any)
}

// Collector keeps the candidates of one socket current.
type Collector struct {
	socket       Socket
	port         uint16
	localIP      netip.Addr
	addresses    func() ([]netip.Addr, error)
	mapper       PortMapper
	mappingRetry time.Duration
	stun         *stunClient
	onChange     func(Snapshot)
	logf         func(format string, args ...any)

	ctx      context.Context
	cancel   context.CancelFunc
	changes  chan struct{}
	refresh  chan struct{}
	routines sync.WaitGroup

	// publishMu keeps snapshots in the order their sources were read.
	publishMu sync.Mutex

	mu        sync.Mutex
	closed    bool
	epoch     uint64
	mapping   Mapping
	reflexive []Candidate
	current   Snapshot
	renewal   *time.Timer
}

// New validates config and starts collecting: the port mapper begins mapping
// the socket port and a first collection runs in the background.
func New(config Config) (*Collector, error) {
	if config.Socket == nil {
		return nil, errors.New("candidates: socket is required")
	}
	local := addrPortOf(config.Socket.LocalAddr())
	if local.Port() == 0 {
		return nil, errors.New("candidates: socket must be a bound UDP socket")
	}
	for _, server := range config.STUNServers {
		if err := validSTUNServer(server); err != nil {
			return nil, err
		}
	}
	logf := config.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	addresses := config.Addresses
	if addresses == nil {
		addresses = InterfaceAddresses
	}
	ctx, cancel := context.WithCancel(context.Background())
	collector := &Collector{
		socket:       config.Socket,
		port:         local.Port(),
		localIP:      local.Addr(),
		addresses:    addresses,
		mapper:       config.PortMapper,
		mappingRetry: orDefault(config.MappingRetry, DefaultMappingRetry),
		onChange:     config.OnChange,
		logf:         logf,
		ctx:          ctx,
		cancel:       cancel,
		changes:      make(chan struct{}, 1),
		refresh:      make(chan struct{}, 1),
	}
	if len(config.STUNServers) > 0 {
		collector.stun = newSTUNClient(config.Socket, config.STUNServers, orDefault(config.STUNTimeout, DefaultSTUNTimeout), !local.Addr().Is4(), logf)
		config.Socket.HandlePackets(collector.stun.handle)
	}
	collector.routines.Add(2)
	go collector.notifyLoop()
	go collector.refreshLoop()
	if collector.mapper != nil {
		collector.mapper.Start(collector.port, collector.mapperEvent)
	}
	collector.requestRefresh()
	return collector, nil
}

// Snapshot returns the last candidates without touching the network.
func (collector *Collector) Snapshot() Snapshot {
	collector.mu.Lock()
	defer collector.mu.Unlock()
	return cloneSnapshot(collector.current)
}

// Collect reads the interfaces and the mapping again and, when STUN is
// enabled and there is no usable mapping, runs a STUN round bounded by the
// STUN timeout or ctx. The result is also the new Snapshot.
func (collector *Collector) Collect(ctx context.Context) (Snapshot, error) {
	collector.mu.Lock()
	closed, epoch := collector.closed, collector.epoch
	collector.mu.Unlock()
	if closed {
		return Snapshot{}, transport.ErrClosed
	}
	mapping := collector.refreshMapping()
	if collector.stun != nil && !mapping.Valid(time.Now()) {
		// Publish local candidates first so a slow round does not hide them.
		collector.publish()
		reflexive := collector.stun.query(ctx)
		collector.mu.Lock()
		if collector.epoch == epoch {
			collector.reflexive = reflexive
		}
		collector.mu.Unlock()
	}
	snapshot := collector.publish()
	if collector.isClosed() {
		return Snapshot{}, transport.ErrClosed
	}
	return snapshot, nil
}

// NetworkChanged forgets the addresses reflected on the previous network and
// collects again in the background. The port mapper monitor calls it on the
// desktop; the phone calls it when the operating system reports a change.
func (collector *Collector) NetworkChanged() {
	collector.mu.Lock()
	if collector.closed {
		collector.mu.Unlock()
		return
	}
	collector.epoch++
	collector.reflexive = nil
	collector.mu.Unlock()
	collector.requestRefresh()
}

// Close stops the collector, releases the mapping and removes the STUN
// handler from the socket, which stays open.
func (collector *Collector) Close() error {
	collector.mu.Lock()
	if collector.closed {
		collector.mu.Unlock()
		return nil
	}
	collector.closed = true
	if collector.renewal != nil {
		collector.renewal.Stop()
	}
	collector.mu.Unlock()
	collector.cancel()
	var err error
	if collector.mapper != nil {
		err = collector.mapper.Close()
	}
	if collector.stun != nil {
		collector.socket.HandlePackets(nil)
	}
	collector.routines.Wait()
	return err
}

func (collector *Collector) mapperEvent(event MapperEvent) {
	switch event {
	case NetworkChanged:
		collector.NetworkChanged()
	case MappingChanged:
		if collector.isClosed() {
			return
		}
		collector.refreshMapping()
		collector.publish()
	}
}

// refreshMapping asks the mapper for the current lease, which also starts a
// renewal once the lease is past half its life, and schedules the next check.
func (collector *Collector) refreshMapping() Mapping {
	if collector.mapper == nil {
		return Mapping{}
	}
	mapping, ok := collector.mapper.Mapping()
	now := time.Now()
	collector.mu.Lock()
	defer collector.mu.Unlock()
	if collector.closed {
		return Mapping{}
	}
	switch {
	case ok && mapping.Valid(now) && publicEndpoint(mapping.External):
		collector.mapping = mapping
	case ok && mapping.Valid(now):
		// A private external address means a second NAT: not reachable.
		collector.mapping = Mapping{}
	case !collector.mapping.Valid(now):
		collector.mapping = Mapping{}
	}
	wait := collector.mappingRetry
	if collector.mapping.Valid(now) {
		wait = max(collector.mapping.GoodUntil.Sub(now)/2, minRenewalWait)
	}
	if collector.renewal == nil {
		collector.renewal = time.AfterFunc(wait, collector.renewalDue)
	} else {
		collector.renewal.Reset(wait)
	}
	return collector.mapping
}

// renewalDue runs at half of the remaining lease, or at the retry interval
// when there is no mapping. Losing the mapping triggers a collection so STUN
// can take its place.
func (collector *Collector) renewalDue() {
	collector.mu.Lock()
	closed, hadMapping := collector.closed, collector.mapping.External.IsValid()
	collector.mu.Unlock()
	if closed {
		return
	}
	mapping := collector.refreshMapping()
	if hadMapping && !mapping.External.IsValid() {
		collector.logf("candidates: gateway mapping expired without renewal")
		collector.requestRefresh()
		return
	}
	collector.publish()
}

// publish rebuilds the snapshot and notifies when the candidate list changed.
func (collector *Collector) publish() Snapshot {
	collector.publishMu.Lock()
	defer collector.publishMu.Unlock()
	addresses, err := collector.addresses()
	if err != nil {
		collector.logf("candidates: list local addresses: %v", err)
	}
	addresses = collector.boundAddresses(addresses)
	now := time.Now()
	collector.mu.Lock()
	defer collector.mu.Unlock()
	mapping := collector.mapping
	if !mapping.Valid(now) {
		mapping = Mapping{}
	}
	snapshot := Snapshot{
		Port:        collector.port,
		Candidates:  buildCandidates(collector.port, addresses, mapping, collector.reflexive),
		Mapping:     mapping,
		CollectedAt: now,
	}
	changed := collector.current.CollectedAt.IsZero() || !slices.Equal(snapshot.Candidates, collector.current.Candidates)
	collector.current = snapshot
	if changed && !collector.closed {
		select {
		case collector.changes <- struct{}{}:
		default:
		}
	}
	return cloneSnapshot(snapshot)
}

// boundAddresses keeps the addresses the socket can answer from: IPv4 only
// for an IPv4 wildcard socket and the bound address for a specific one. It
// never modifies the slice returned by the address source.
func (collector *Collector) boundAddresses(addresses []netip.Addr) []netip.Addr {
	switch {
	case collector.localIP.IsUnspecified() && collector.localIP.Is6():
		return addresses
	case collector.localIP.IsUnspecified():
		return slices.DeleteFunc(slices.Clone(addresses), func(address netip.Addr) bool { return !address.Unmap().Is4() })
	default:
		return slices.DeleteFunc(slices.Clone(addresses), func(address netip.Addr) bool { return address.Unmap() != collector.localIP })
	}
}

func (collector *Collector) notifyLoop() {
	defer collector.routines.Done()
	for {
		select {
		case <-collector.changes:
			if collector.onChange != nil && !collector.isClosed() {
				collector.onChange(collector.Snapshot())
			}
		case <-collector.ctx.Done():
			return
		}
	}
}

// refreshLoop coalesces background collections requested by events.
func (collector *Collector) refreshLoop() {
	defer collector.routines.Done()
	for {
		select {
		case <-collector.refresh:
			_, _ = collector.Collect(collector.ctx)
		case <-collector.ctx.Done():
			return
		}
	}
}

func (collector *Collector) requestRefresh() {
	select {
	case collector.refresh <- struct{}{}:
	default:
	}
}

func (collector *Collector) isClosed() bool {
	collector.mu.Lock()
	defer collector.mu.Unlock()
	return collector.closed
}

func cloneSnapshot(snapshot Snapshot) Snapshot {
	snapshot.Candidates = slices.Clone(snapshot.Candidates)
	return snapshot
}

func orDefault(value, fallback time.Duration) time.Duration {
	if value > 0 {
		return value
	}
	return fallback
}
