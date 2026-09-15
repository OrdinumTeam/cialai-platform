// SPDX-License-Identifier: Apache-2.0
// Package portmap maps the UDP port of the desktop on the gateway by PCP,
// NAT-PMP or UPnP with tailscale.com/net/portmapper, and reports mappings and
// network changes to the candidates collector.
package portmap

import (
	"context"
	"fmt"
	"net/netip"
	"sync"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
	"tailscale.com/net/netmon"
	"tailscale.com/net/portmapper"
	"tailscale.com/net/portmapper/portmappertype"
	"tailscale.com/types/logger"
	"tailscale.com/util/eventbus"
)

// Mapper implements candidates.PortMapper.
type Mapper struct {
	bus        *eventbus.Bus
	monitor    *netmon.Monitor
	client     *portmapper.Client
	subClient  *eventbus.Client
	subscriber *eventbus.Subscriber[portmappertype.Mapping]
	gateway    func() (gateway, self netip.Addr, ok bool)
	done       chan struct{}

	mu         sync.Mutex
	started    bool
	closed     bool
	last       candidates.Mapping
	gatewayIP  netip.Addr
	selfIP     netip.Addr
	unregister func()
}

var _ candidates.PortMapper = (*Mapper)(nil)

// New creates the mapper for the UDP port of the shared socket, with its own
// network monitor, which also reports network changes. logf may be nil.
//
// The port is set here, not only in Start, because changing it discards what
// a Probe learned while keeping the probe time; for five seconds the client
// would then skip PCP and NAT-PMP and try UPnP alone.
func New(port uint16, logf func(format string, args ...any)) (*Mapper, error) {
	return newMapper(port, logf, nil)
}

// newMapper lets tests replace the gateway lookup.
func newMapper(port uint16, logf func(format string, args ...any), gateway func() (netip.Addr, netip.Addr, bool)) (*Mapper, error) {
	log := logger.Logf(logger.Discard)
	if logf != nil {
		log = logf
	}
	bus := eventbus.New()
	monitor, err := netmon.New(bus, logger.Discard)
	if err != nil {
		bus.Close()
		return nil, fmt.Errorf("start network monitor: %w", err)
	}
	if gateway == nil {
		gateway = monitor.GatewayAndSelfIP
	}
	subClient := bus.Client("cialai-candidates")
	client := portmapper.NewClient(portmapper.Config{EventBus: bus, Logf: log, NetMon: monitor})
	client.SetGatewayLookupFunc(gateway)
	client.SetLocalPort(port)
	return &Mapper{
		bus:        bus,
		monitor:    monitor,
		client:     client,
		subClient:  subClient,
		subscriber: eventbus.Subscribe[portmappertype.Mapping](subClient),
		gateway:    gateway,
		done:       make(chan struct{}),
	}, nil
}

// Start maps port, normally the one given to New, and starts the network
// monitor.
func (mapper *Mapper) Start(port uint16, notify func(candidates.MapperEvent)) {
	mapper.mu.Lock()
	if mapper.started || mapper.closed {
		mapper.mu.Unlock()
		return
	}
	mapper.started = true
	mapper.gatewayIP, mapper.selfIP, _ = mapper.gateway()
	mapper.unregister = mapper.monitor.RegisterChangeCallback(func(delta *netmon.ChangeDelta) {
		if mapper.networkChanged(delta) {
			notify(candidates.NetworkChanged)
		}
	})
	mapper.mu.Unlock()
	mapper.client.SetLocalPort(port)
	mapper.monitor.Start()
	go mapper.receive(notify)
}

func (mapper *Mapper) receive(notify func(candidates.MapperEvent)) {
	defer close(mapper.done)
	for {
		select {
		case event := <-mapper.subscriber.Events():
			mapper.mu.Lock()
			mapper.last = candidates.Mapping{Protocol: event.Type, External: event.External, GoodUntil: event.GoodUntil}
			mapper.mu.Unlock()
			notify(candidates.MappingChanged)
		case <-mapper.subscriber.Done():
			return
		}
	}
}

// networkChanged drops the mapping when the gateway, the local address or the
// wall clock jumped, as after sleep, since the old lease may be gone.
func (mapper *Mapper) networkChanged(delta *netmon.ChangeDelta) bool {
	if delta.IsInitialState {
		return false
	}
	gatewayIP, selfIP, _ := mapper.gateway()
	mapper.mu.Lock()
	moved := gatewayIP != mapper.gatewayIP || selfIP != mapper.selfIP || delta.TimeJumped()
	mapper.gatewayIP, mapper.selfIP = gatewayIP, selfIP
	if moved {
		mapper.last = candidates.Mapping{}
	}
	closed := mapper.closed
	mapper.mu.Unlock()
	if closed {
		return false
	}
	if moved {
		mapper.client.NoteNetworkDown()
	}
	return moved || delta.InterfaceIPsChanged || delta.DefaultInterfaceChanged
}

// Mapping returns the lease reported by the last mapping event while the
// client still holds that mapping; the client renews it past half its life.
func (mapper *Mapper) Mapping() (candidates.Mapping, bool) {
	mapper.mu.Lock()
	closed := mapper.closed
	mapper.mu.Unlock()
	if closed {
		return candidates.Mapping{}, false
	}
	external, ok := mapper.client.GetCachedMappingOrStartCreatingOne()
	if !ok {
		return candidates.Mapping{}, false
	}
	mapper.mu.Lock()
	defer mapper.mu.Unlock()
	// The event carries the lease; until it arrives the mapping is not known.
	if mapper.last.External != external || !mapper.last.Valid(time.Now()) {
		return candidates.Mapping{}, false
	}
	return mapper.last, true
}

// Probe reports which mapping protocols the gateway answers.
func (mapper *Mapper) Probe(ctx context.Context) (candidates.Services, error) {
	result, err := mapper.client.Probe(ctx)
	return candidates.Services{PCP: result.PCP, PMP: result.PMP, UPnP: result.UPnP}, err
}

// Close releases the mapping on the gateway and stops the monitor.
func (mapper *Mapper) Close() error {
	mapper.mu.Lock()
	if mapper.closed {
		mapper.mu.Unlock()
		return nil
	}
	mapper.closed = true
	started := mapper.started
	unregister := mapper.unregister
	mapper.mu.Unlock()
	if unregister != nil {
		unregister()
	}
	err := mapper.client.Close()
	mapper.subscriber.Close()
	if started {
		<-mapper.done
	}
	mapper.subClient.Close()
	_ = mapper.monitor.Close()
	mapper.bus.Close()
	return err
}
