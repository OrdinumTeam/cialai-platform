// SPDX-License-Identifier: Apache-2.0
package identity

import (
	"bytes"
	"crypto/ed25519"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
)

// ServerName is sent in SNI by clients; it carries no trust, the pin does.
const ServerName = "cialai"

var (
	ErrPinMismatch = errors.New("peer Ed25519 key does not match the pin")
	ErrPeerInvalid = errors.New("peer certificate is not a single Ed25519 certificate")
)

// KeyRegistry tells the desktop whether a phone key belongs to a paired device.
type KeyRegistry interface {
	RegisteredKey(publicKey string) (deviceID string, ok bool)
}

// Peer is the authenticated remote end of a mutual TLS session.
type Peer struct {
	PublicKey  ed25519.PublicKey
	Key        string
	DeviceID   string
	Registered bool
}

// ClientConfig is used by phones: it presents the phone certificate and
// accepts only the desktop key pinned from the QR or the reach card.
func ClientConfig(local *Identity, pinned ed25519.PublicKey) (*tls.Config, error) {
	if local == nil || len(pinned) != ed25519.PublicKeySize {
		return nil, errors.New("local identity and pinned desktop key are required")
	}
	want := append(ed25519.PublicKey(nil), pinned...)
	config := baseConfig(local)
	config.ServerName = ServerName
	config.InsecureSkipVerify = true // Replaced by the Ed25519 pin in VerifyConnection.
	config.VerifyConnection = func(state tls.ConnectionState) error {
		public, err := peerKey(state)
		if err != nil {
			return err
		}
		if !bytes.Equal(public, want) {
			return ErrPinMismatch
		}
		return nil
	}
	return config, nil
}

// ServerConfig is used by desktops. It requires a client certificate but does
// not reject unknown keys during the handshake: the transport reads the peer
// with ServerPeer and applies the restricted pairing entry itself.
func ServerConfig(local *Identity) (*tls.Config, error) {
	if local == nil {
		return nil, errors.New("local identity is required")
	}
	config := baseConfig(local)
	config.ClientAuth = tls.RequireAnyClientCert
	config.VerifyConnection = func(state tls.ConnectionState) error {
		_, err := peerKey(state)
		return err
	}
	return config, nil
}

// ServerPeer returns the phone key accepted by the handshake, marked as
// registered when the registry knows it.
func ServerPeer(state tls.ConnectionState, registry KeyRegistry) (Peer, error) {
	public, err := peerKey(state)
	if err != nil {
		return Peer{}, err
	}
	peer := Peer{PublicKey: public, Key: EncodePublicKey(public)}
	if registry != nil {
		peer.DeviceID, peer.Registered = registry.RegisteredKey(peer.Key)
	}
	return peer, nil
}

// PeerPublicKey extracts the verified Ed25519 key from any finished handshake.
func PeerPublicKey(state tls.ConnectionState) (ed25519.PublicKey, error) {
	return peerKey(state)
}

func baseConfig(local *Identity) *tls.Config {
	return &tls.Config{
		MinVersion:             tls.VersionTLS13,
		MaxVersion:             tls.VersionTLS13,
		Certificates:           []tls.Certificate{local.certificate},
		NextProtos:             []string{ALPN},
		SessionTicketsDisabled: true,
		// No ClientSessionCache: no resumption and therefore no 0-RTT.
	}
}

// peerKey checks the negotiated parameters and the certificate shape. The
// validity window is deliberately ignored: TLS already proved possession of the
// private key, and trust comes from the pin or the registry, not from dates.
func peerKey(state tls.ConnectionState) (ed25519.PublicKey, error) {
	if state.Version != tls.VersionTLS13 {
		return nil, fmt.Errorf("peer negotiated TLS 0x%04x instead of 1.3", state.Version)
	}
	if state.NegotiatedProtocol != ALPN {
		return nil, fmt.Errorf("peer negotiated ALPN %q instead of %q", state.NegotiatedProtocol, ALPN)
	}
	if len(state.PeerCertificates) != 1 {
		return nil, ErrPeerInvalid
	}
	certificate := state.PeerCertificates[0]
	public, ok := certificate.PublicKey.(ed25519.PublicKey)
	if !ok || len(public) != ed25519.PublicKeySize || certificate.SignatureAlgorithm != x509.PureEd25519 {
		return nil, ErrPeerInvalid
	}
	if err := certificate.CheckSignature(certificate.SignatureAlgorithm, certificate.RawTBSCertificate, certificate.Signature); err != nil {
		return nil, ErrPeerInvalid
	}
	return append(ed25519.PublicKey(nil), public...), nil
}
