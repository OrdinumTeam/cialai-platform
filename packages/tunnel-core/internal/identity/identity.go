// SPDX-License-Identifier: Apache-2.0
// Package identity owns the per-device Ed25519 key, the id derived from it,
// the self-signed certificate and the mutual TLS 1.3 configuration shared by
// every transport. The public key is the identity: certificates are only a
// carrier, so their validity window is ignored in favor of the pinned key.
package identity

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"math/big"
	"time"
)

// ALPN is negotiated by every Cialai transport, direct QUIC and TLS over Tor.
const ALPN = "cialai/1"

// ControlALPN marks a TLS connection over Tor dedicated to the rendezvous
// control channel. The onion listener offers it beside ALPN and hands those
// connections to the control channel instead of the edge; direct QUIC never
// offers it, because a QUIC session carries its control stream inside.
const ControlALPN = "cialai-control/1"

// Role selects the id prefix: desktops use d_ and phones use dev_, matching the
// identifiers already accepted by the pairing registry.
type Role string

const (
	RoleDesktop Role = "desktop"
	RolePhone   Role = "phone"
)

const idBytes = 16

var (
	ErrCorrupt     = errors.New("identity key file is corrupt")
	ErrPermissions = errors.New("identity key file must be private (0600)")
)

// Identity is a loaded device key. The private key never leaves the package
// except through the TLS certificate handed to crypto/tls.
type Identity struct {
	role        Role
	private     ed25519.PrivateKey
	public      ed25519.PublicKey
	id          string
	certificate tls.Certificate
}

func (role Role) prefix() (string, error) {
	switch role {
	case RoleDesktop:
		return "d_", nil
	case RolePhone:
		return "dev_", nil
	default:
		return "", fmt.Errorf("unknown identity role %q", role)
	}
}

// Generate creates a fresh identity from the given entropy source.
func Generate(role Role, random io.Reader) (*Identity, error) {
	if random == nil {
		random = rand.Reader
	}
	seed := make([]byte, ed25519.SeedSize)
	if _, err := io.ReadFull(random, seed); err != nil {
		return nil, fmt.Errorf("generate identity seed: %w", err)
	}
	return FromSeed(role, seed)
}

// FromSeed rebuilds an identity from its 32-byte Ed25519 seed.
func FromSeed(role Role, seed []byte) (*Identity, error) {
	return fromSeedAt(role, seed, time.Now())
}

func fromSeedAt(role Role, seed []byte, now time.Time) (*Identity, error) {
	if _, err := role.prefix(); err != nil {
		return nil, err
	}
	if len(seed) != ed25519.SeedSize {
		return nil, ErrCorrupt
	}
	private := ed25519.NewKeyFromSeed(seed)
	public := private.Public().(ed25519.PublicKey)
	id, err := DeriveID(role, public)
	if err != nil {
		return nil, err
	}
	certificate, err := selfSigned(private, public, id, now)
	if err != nil {
		return nil, err
	}
	return &Identity{role: role, private: private, public: public, id: id, certificate: certificate}, nil
}

// DeriveID returns the prefix followed by the base64url of the first 16 bytes
// of SHA-256 over the public key.
func DeriveID(role Role, public ed25519.PublicKey) (string, error) {
	prefix, err := role.prefix()
	if err != nil {
		return "", err
	}
	if len(public) != ed25519.PublicKeySize {
		return "", errors.New("Ed25519 public key is required")
	}
	digest := sha256.Sum256(public)
	return prefix + base64.RawURLEncoding.EncodeToString(digest[:idBytes]), nil
}

func (identity *Identity) Role() Role { return identity.role }
func (identity *Identity) ID() string { return identity.id }
func (identity *Identity) PublicKey() ed25519.PublicKey {
	return append(ed25519.PublicKey(nil), identity.public...)
}
func (identity *Identity) PublicKeyString() string { return EncodePublicKey(identity.public) }
func (identity *Identity) Fingerprint() string     { return Fingerprint(identity.public) }

// Certificate returns the self-signed certificate carrying the public key.
func (identity *Identity) Certificate() tls.Certificate { return identity.certificate }

func (identity *Identity) seed() []byte { return identity.private.Seed() }

// EncodePublicKey is the canonical text form used by QR payloads, registries and logs.
func EncodePublicKey(public ed25519.PublicKey) string {
	return base64.RawURLEncoding.EncodeToString(public)
}

// ParsePublicKey accepts only the canonical unpadded base64url encoding.
func ParsePublicKey(text string) (ed25519.PublicKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(text)
	if err != nil || len(raw) != ed25519.PublicKeySize || base64.RawURLEncoding.EncodeToString(raw) != text {
		return nil, errors.New("public key must be a canonical base64url Ed25519 key")
	}
	return ed25519.PublicKey(raw), nil
}

// Fingerprint is the short hexadecimal form shown to people for confirmation.
func Fingerprint(public ed25519.PublicKey) string {
	digest := sha256.Sum256(public)
	return hex.EncodeToString(digest[:8])
}

func selfSigned(private ed25519.PrivateKey, public ed25519.PublicKey, id string, now time.Time) (tls.Certificate, error) {
	serialBytes := make([]byte, 16)
	if _, err := rand.Read(serialBytes); err != nil {
		return tls.Certificate{}, fmt.Errorf("certificate serial: %w", err)
	}
	template := &x509.Certificate{
		SerialNumber: new(big.Int).SetBytes(serialBytes),
		Subject:      pkix.Name{CommonName: "cialai " + id},
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.AddDate(10, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, public, private)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("create certificate: %w", err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		return tls.Certificate{}, fmt.Errorf("parse certificate: %w", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: private, Leaf: leaf}, nil
}
