// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"path/filepath"
	"strconv"
	"sync"

	"golang.org/x/net/proxy"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

var (
	ErrNoEndpoints       = errors.New("tor endpoints are not set")
	ErrNoControlEndpoint = errors.New("tor control endpoint is not set")
)

// Endpoints are the local listeners of a Tor this package does not run: the
// in-process Tor of the phone apps, handed over by the native side. Each
// address is a loopback "host:port" or "unix:/absolute/path".
type Endpoints struct {
	SOCKS string
	// Control and CookiePath are optional; they only serve bootstrap status.
	Control    string
	CookiePath string
}

func (endpoints Endpoints) validate() error {
	if _, _, err := splitEndpoint(endpoints.SOCKS); err != nil {
		return fmt.Errorf("tor SOCKS endpoint: %w", err)
	}
	if endpoints.Control != "" {
		if _, _, err := splitEndpoint(endpoints.Control); err != nil {
			return fmt.Errorf("tor control endpoint: %w", err)
		}
	}
	if endpoints.CookiePath != "" {
		if endpoints.Control == "" {
			return errors.New("tor cookie path needs a control endpoint")
		}
		if !filepath.IsAbs(endpoints.CookiePath) {
			return errors.New("tor cookie path must be absolute")
		}
	}
	return nil
}

// Client dials onion services through a Tor SOCKS5 listener. It is safe for
// concurrent use; endpoints can change while Tor restarts.
type Client struct {
	mu        sync.RWMutex
	endpoints Endpoints
}

func NewClient() *Client { return &Client{} }

// SetTorEndpoints replaces the endpoints. The zero Endpoints clears them, for
// when the native Tor stops.
func (client *Client) SetTorEndpoints(endpoints Endpoints) error {
	if endpoints != (Endpoints{}) {
		if err := endpoints.validate(); err != nil {
			return err
		}
	}
	client.mu.Lock()
	client.endpoints = endpoints
	client.mu.Unlock()
	return nil
}

// TorEndpoints returns the current endpoints and whether any are set.
func (client *Client) TorEndpoints() (Endpoints, bool) {
	client.mu.RLock()
	defer client.mu.RUnlock()
	return client.endpoints, client.endpoints.SOCKS != ""
}

// Dial opens a stream to <onion>:443. The host name goes to Tor unresolved,
// so no DNS query leaves the device.
func (client *Client) Dial(ctx context.Context, onion string) (net.Conn, error) {
	host, _, err := ParseOnionAddress(onion)
	if err != nil {
		return nil, err
	}
	endpoints, ok := client.TorEndpoints()
	if !ok {
		return nil, ErrNoEndpoints
	}
	network, address, err := splitEndpoint(endpoints.SOCKS)
	if err != nil {
		return nil, err
	}
	socks, err := proxy.SOCKS5(network, address, nil, nil)
	if err != nil {
		return nil, fmt.Errorf("tor SOCKS dialer: %w", err)
	}
	dialer, ok := socks.(proxy.ContextDialer)
	if !ok {
		return nil, errors.New("tor SOCKS dialer does not support contexts")
	}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(OnionPort)))
	if err != nil {
		return nil, fmt.Errorf("dial %s through tor: %w", host, err)
	}
	return conn, nil
}

// DialTLS dials the onion and completes mutual TLS 1.3 with local's
// certificate, accepting only the pinned desktop key.
func (client *Client) DialTLS(ctx context.Context, onion string, local *identity.Identity, pinned ed25519.PublicKey) (*tls.Conn, error) {
	config, err := identity.ClientConfig(local, pinned)
	if err != nil {
		return nil, err
	}
	return client.dialTLS(ctx, onion, config)
}

// DialControlTLS is DialTLS for a connection dedicated to the rendezvous
// control channel: it negotiates identity.ControlALPN, so the onion listener
// of the desktop hands it to the control channel instead of the edge.
func (client *Client) DialControlTLS(ctx context.Context, onion string, local *identity.Identity, pinned ed25519.PublicKey) (*tls.Conn, error) {
	config, err := identity.ControlClientConfig(local, pinned)
	if err != nil {
		return nil, err
	}
	return client.dialTLS(ctx, onion, config)
}

func (client *Client) dialTLS(ctx context.Context, onion string, config *tls.Config) (*tls.Conn, error) {
	raw, err := client.Dial(ctx, onion)
	if err != nil {
		return nil, err
	}
	conn := tls.Client(raw, config)
	if err := conn.HandshakeContext(ctx); err != nil {
		_ = raw.Close()
		return nil, fmt.Errorf("tls over tor: %w", err)
	}
	return conn, nil
}

// Bootstrap asks the control port for Tor's bootstrap progress. It never takes
// ownership, so closing the connection leaves the native Tor running.
func (client *Client) Bootstrap(ctx context.Context) (Bootstrap, error) {
	endpoints, ok := client.TorEndpoints()
	if !ok {
		return Bootstrap{}, ErrNoEndpoints
	}
	if endpoints.Control == "" {
		return Bootstrap{}, ErrNoControlEndpoint
	}
	control, err := dialControl(ctx, endpoints.Control)
	if err != nil {
		return Bootstrap{}, err
	}
	defer control.Close()
	if err := control.authenticate(ctx, endpoints.CookiePath); err != nil {
		return Bootstrap{}, fmt.Errorf("tor control authentication: %w", err)
	}
	return control.bootstrap(ctx)
}
