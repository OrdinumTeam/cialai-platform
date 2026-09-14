// SPDX-License-Identifier: Apache-2.0

package rendezvous

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
)

// TLSControl adapts the mutually authenticated TLS stream carried by the
// onion service to the rendezvous Control protocol. PeerPublicKey is obtained
// from the certificate accepted by TLS, rather than from an offer message.
type TLSControl struct {
	*JSONControl
	PeerPublicKey string
}

func NewTLSControl(ctx context.Context, connection *tls.Conn) (*TLSControl, error) {
	if connection == nil {
		return nil, errors.New("TLS connection is required")
	}
	if err := connection.HandshakeContext(ctx); err != nil {
		return nil, fmt.Errorf("rendezvous TLS handshake: %w", err)
	}
	state := connection.ConnectionState()
	if state.Version != tls.VersionTLS13 {
		return nil, fmt.Errorf("rendezvous requires TLS 1.3, got 0x%04x", state.Version)
	}
	if len(state.PeerCertificates) != 1 {
		return nil, fmt.Errorf("rendezvous requires exactly one peer certificate, got %d", len(state.PeerCertificates))
	}
	public, ok := state.PeerCertificates[0].PublicKey.(ed25519.PublicKey)
	if !ok || len(public) != ed25519.PublicKeySize {
		return nil, errors.New("rendezvous peer certificate is not Ed25519")
	}
	encoded := base64.RawURLEncoding.EncodeToString(public)
	if err := validatePublicKey(encoded); err != nil {
		return nil, fmt.Errorf("rendezvous peer certificate key: %w", err)
	}
	return &TLSControl{JSONControl: NewJSONControl(connection), PeerPublicKey: encoded}, nil
}
