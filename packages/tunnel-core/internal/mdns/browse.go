// SPDX-License-Identifier: Apache-2.0
package mdns

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"runtime"
	"slices"
	"sync"
	"time"

	pion "github.com/pion/mdns/v2"
)

// maxFound caps the desktops one Browse keeps, so a flood of announcements
// cannot grow the result without bound.
const maxFound = 32

// ErrNoInterfaces is returned by Browse when no interface can carry mDNS.
var ErrNoInterfaces = errors.New("mdns: no local network interface to browse on")

// Found is a desktop discovered on the local network.
type Found struct {
	ID          string
	Fingerprint string
	// Addrs are the LAN addresses with the SRV port, at most MaxReported,
	// in address order.
	Addrs []netip.AddrPort
}

// Browse asks for ServiceType on every usable interface during timeout, or
// until ctx ends, and returns the desktops whose TXT record is valid, ordered
// by id. Instances with an invalid TXT, a zero port or an address outside the
// LAN ranges are ignored.
func Browse(ctx context.Context, timeout time.Duration) ([]Found, error) {
	return browse(ctx, timeout, nonLoopbackInterfaces)
}

func browse(ctx context.Context, timeout time.Duration, list func() ([]net.Interface, error)) ([]Found, error) {
	if runtime.GOOS == "ios" {
		return nil, ErrUnsupported
	}
	if timeout <= 0 {
		return nil, errors.New("mdns: browse timeout must be positive")
	}
	interfaces, err := usableInterfaces(list)
	if err != nil {
		return nil, fmt.Errorf("mdns: list interfaces: %w", err)
	}
	if len(interfaces) == 0 {
		return nil, ErrNoInterfaces
	}
	v4, v6, err := listenMulticast(interfaces)
	if err != nil {
		return nil, err
	}
	loopback := false
	selected := make([]net.Interface, 0, len(interfaces))
	for _, lan := range interfaces {
		loopback = loopback || lan.loopback()
		selected = append(selected, lan.iface)
	}
	conn, err := pion.NewServer(v4, v6,
		pion.WithName("cialai-browse"),
		pion.WithInterfaces(selected...),
		pion.WithIncludeLoopback(loopback),
		pion.WithCacheRefresh(false),
		pion.WithLoggerFactory(newLoggerFactory(func(string, ...any) {})),
	)
	if err != nil {
		closePacketConns(v4, v6)
		return nil, fmt.Errorf("mdns: start browser: %w", err)
	}

	results := newResults(loopback)
	conn.OnServiceDiscovered(results.add)
	browseCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	if err := conn.Browse(browseCtx, ServiceType); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("mdns: browse: %w", err)
	}
	<-browseCtx.Done()
	// Close waits for the read loops, so no event arrives after it returns.
	if err := conn.Close(); err != nil {
		return nil, fmt.Errorf("mdns: close browser: %w", err)
	}
	return results.list(), nil
}

// results gathers the discovered desktops by id.
type results struct {
	loopback bool

	mu    sync.Mutex
	found map[string]*Found
}

func newResults(loopback bool) *results {
	return &results{loopback: loopback, found: make(map[string]*Found)}
}

func (collected *results) add(event pion.ServiceEvent) {
	id, fingerprint, err := parseTXT(event.Instance.Text)
	if err != nil || event.Instance.Port == 0 {
		return
	}
	address := event.Addr.WithZone("").Unmap()
	if !lanAddress(address, collected.loopback) {
		return
	}
	endpoint := netip.AddrPortFrom(address, event.Instance.Port)

	collected.mu.Lock()
	defer collected.mu.Unlock()
	desktop, known := collected.found[id]
	if !known {
		if len(collected.found) == maxFound {
			return
		}
		desktop = &Found{ID: id, Fingerprint: fingerprint}
		collected.found[id] = desktop
	}
	if len(desktop.Addrs) < MaxReported && !slices.Contains(desktop.Addrs, endpoint) {
		desktop.Addrs = append(desktop.Addrs, endpoint)
	}
}

func (collected *results) list() []Found {
	collected.mu.Lock()
	defer collected.mu.Unlock()
	list := make([]Found, 0, len(collected.found))
	for _, desktop := range collected.found {
		addresses := slices.Clone(desktop.Addrs)
		slices.SortFunc(addresses, netip.AddrPort.Compare)
		list = append(list, Found{ID: desktop.ID, Fingerprint: desktop.Fingerprint, Addrs: addresses})
	}
	slices.SortFunc(list, func(a, b Found) int { return cmp.Compare(a.ID, b.ID) })
	return list
}
