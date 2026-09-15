// SPDX-License-Identifier: Apache-2.0
package pathmgr

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"net"
	"net/netip"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

// Kind names a path as the phone API reports it.
type Kind string

const (
	// KindNone is reported when no path reaches the desktop.
	KindNone   Kind = "none"
	KindLAN    Kind = "lan"
	KindDirect Kind = "direct"
	KindTor    Kind = "tor"
)

// EventPathChanged names the path event in the sidecar and phone protocols.
const EventPathChanged = "path.changed"

// Reasons carried by PathEvent. A path event with KindNone carries the error
// code instead, such as CodeNoPath.
const (
	ReasonConnect        = "connect"
	ReasonPathFailed     = "path_failed"
	ReasonNetworkChanged = "network_changed"
	ReasonForeground     = "foreground"
	ReasonRetry          = "retry"
	ReasonUpgrade        = "upgrade"
	ReasonPunch          = "punch"
)

// Tor states reported by TorStatus.
const (
	TorUnknown       = "unknown"
	TorDisabled      = "disabled"
	TorBootstrapping = "bootstrapping"
	TorReady         = "ready"
	TorFailed        = "failed"
)

// State is the connection state of the manager.
type State string

const (
	StateIdle       State = "idle"
	StateConnecting State = "connecting"
	StateConnected  State = "connected"
	StateOffline    State = "offline"
)

// Path is the active path. The zero Path, with an empty Transport, means none.
type Path struct {
	DesktopID string `json:"desktopId"`
	Transport string `json:"transport"`
	Kind      Kind   `json:"path"`
	// Address is the desktop endpoint of a direct path, empty over Tor.
	Address string    `json:"address,omitempty"`
	Since   time.Time `json:"since"`
}

// PathEvent is the payload of EventPathChanged.
type PathEvent struct {
	DesktopID string `json:"desktopId"`
	Transport string `json:"transport"`
	Path      Kind   `json:"path"`
	Reason    string `json:"reason"`
}

// TorStatus is the fallback state seen by the manager, with the bootstrap
// progress from 0 to 100.
type TorStatus struct {
	State    string `json:"state"`
	Progress int    `json:"progress"`
}

// Result is what Connect returns once a path is active.
type Result struct {
	DesktopID     string `json:"desktopId"`
	Transport     string `json:"transport"`
	Path          Kind   `json:"path"`
	ElapsedMillis int64  `json:"elapsedMs"`
}

// Status is a snapshot of the manager.
type Status struct {
	State  State     `json:"state"`
	Active *Path     `json:"active,omitempty"`
	Tor    TorStatus `json:"tor"`
	// Error is the code of the last failure while no path is active.
	Error string `json:"error,omitempty"`
}

// Desktop is the desktop the manager reaches, taken from the reach card.
type Desktop struct {
	ID        string
	PublicKey ed25519.PublicKey
	// Onion is the onion host name without the port, as tor.Client dials it.
	Onion string
}

// DirectDialer dials direct QUIC candidates pinned to the desktop key and
// keeps the first session; *direct.Endpoint implements it.
type DirectDialer interface {
	DialCandidates(ctx context.Context, candidates []netip.AddrPort, peerKey ed25519.PublicKey) (transport.Session, error)
}

// Migrator is implemented by direct sessions that move to a new socket after a
// network change, such as *direct.Session. On success the session owns
// packetConn; on failure the caller closes it.
type Migrator interface {
	Migrate(ctx context.Context, packetConn net.PacketConn) error
}

// TorDialer reaches the onion service through the Tor of the phone;
// *tor.Client implements it.
type TorDialer interface {
	// Bootstrap reports the bootstrap progress. tor.ErrNoEndpoints means Tor
	// is not running and tor.ErrNoControlEndpoint that progress is unknown.
	Bootstrap(ctx context.Context) (tor.Bootstrap, error)
	// DialTLS opens one mutual TLS connection to the onion pinned to the
	// desktop key. Every edge stream over the fallback is one connection.
	DialTLS(ctx context.Context, onion string, local *identity.Identity, pinned ed25519.PublicKey) (*tls.Conn, error)
}

// Puncher runs step 4: a NAT punch coordinated over the fallback that returns a
// direct session. RendezvousPuncher implements it; pion ICE can replace it.
type Puncher interface {
	Punch(ctx context.Context, desktop Desktop) (transport.Session, error)
}

// Dialer is what the proxy consumes: every call opens one stream to the
// desktop edge over the active path.
type Dialer interface {
	DialContext(ctx context.Context, network, address string) (net.Conn, error)
}

var _ TorDialer = (*tor.Client)(nil)
