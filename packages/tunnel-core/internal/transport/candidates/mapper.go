// SPDX-License-Identifier: Apache-2.0
package candidates

import (
	"context"
	"net/netip"
	"time"
)

// Mapping is a UDP port mapping on the gateway.
type Mapping struct {
	// Protocol is "pcp", "pmp" or "upnp".
	Protocol  string
	External  netip.AddrPort
	GoodUntil time.Time
}

// Valid reports whether the mapping exists and its lease has not ended.
func (mapping Mapping) Valid(now time.Time) bool {
	return mapping.External.IsValid() && now.Before(mapping.GoodUntil)
}

// Services lists the port mapping protocols the gateway answered.
type Services struct {
	PCP  bool
	PMP  bool
	UPnP bool
}

// MapperEvent is what a PortMapper reports to the collector.
type MapperEvent int

const (
	// MappingChanged means a mapping was obtained or renewed.
	MappingChanged MapperEvent = iota + 1
	// NetworkChanged means the interfaces or the gateway changed; the mapper
	// already dropped a mapping that belonged to another gateway.
	NetworkChanged
)

// PortMapper maps the UDP port of the shared socket on the gateway. The
// portmap subpackage implements it with tailscale.com/net/portmapper; it lives
// apart so the phone, which needs STUN and the reach card but no mapping, does
// not link the port mapper and its dependencies.
type PortMapper interface {
	// Start begins mapping port. notify may run on any goroutine.
	Start(port uint16, notify func(MapperEvent))
	// Mapping returns the current valid mapping. When there is none, or the
	// lease is due for renewal, it starts obtaining one in the background and
	// reports it later with MappingChanged.
	Mapping() (Mapping, bool)
	// Probe reports which mapping protocols the gateway answers.
	Probe(ctx context.Context) (Services, error)
	// Close releases the mapping and stops reporting events.
	Close() error
}
