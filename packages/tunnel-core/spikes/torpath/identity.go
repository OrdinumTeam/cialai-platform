// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const alpn = "cialai-torpath/1"

type identity struct {
	private ed25519.PrivateKey
	public  ed25519.PublicKey
	cert    tls.Certificate
}

func runKeygen(args []string) error {
	flags := flag.NewFlagSet("keygen", flag.ContinueOnError)
	path := flags.String("identity", "", "path to the persistent private key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *path == "" {
		return errors.New("--identity is required")
	}
	id, created, err := loadOrCreateIdentity(*path)
	if err != nil {
		return err
	}
	return writeJSON(os.Stdout, map[string]any{
		"created":      created,
		"event":        "identity",
		"fingerprint":  fingerprint(id.public),
		"identityPath": *path,
		"publicKey":    encodePublicKey(id.public),
	})
}

func loadOrCreateIdentity(path string) (*identity, bool, error) {
	if path == "" {
		return nil, false, errors.New("identity path is required")
	}
	raw, err := os.ReadFile(path)
	if err == nil {
		if err := checkPrivatePermissions(path); err != nil {
			return nil, false, err
		}
		seed, decodeErr := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(raw)))
		if decodeErr != nil || len(seed) != ed25519.SeedSize {
			return nil, false, errors.New("identity file is corrupt")
		}
		id, buildErr := identityFromPrivate(ed25519.NewKeyFromSeed(seed))
		return id, false, buildErr
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, false, fmt.Errorf("read identity: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, false, fmt.Errorf("create identity directory: %w", err)
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, false, fmt.Errorf("generate identity: %w", err)
	}
	encoded := []byte(base64.RawURLEncoding.EncodeToString(private.Seed()) + "\n")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return loadOrCreateIdentity(path)
	}
	if err != nil {
		return nil, false, fmt.Errorf("create identity: %w", err)
	}
	if _, err := file.Write(encoded); err != nil {
		_ = file.Close()
		return nil, false, fmt.Errorf("write identity: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return nil, false, fmt.Errorf("sync identity: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, false, fmt.Errorf("close identity: %w", err)
	}
	id, err := identityFromPrivate(private)
	return id, true, err
}

func checkPrivatePermissions(path string) error {
	if runtime.GOOS == "windows" {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("stat private file: %w", err)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("private file permissions must be 0600, got %04o", info.Mode().Perm())
	}
	return nil
}

func identityFromPrivate(private ed25519.PrivateKey) (*identity, error) {
	if len(private) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid Ed25519 private key")
	}
	public, ok := private.Public().(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("invalid Ed25519 public key")
	}
	cert, err := selfSignedCertificate(private, public)
	if err != nil {
		return nil, err
	}
	return &identity{private: private, public: public, cert: cert}, nil
}

func selfSignedCertificate(private ed25519.PrivateKey, public ed25519.PublicKey) (tls.Certificate, error) {
	digest := sha256.Sum256(public)
	serial := new(big.Int).SetBytes(digest[:20])
	serial.SetBit(serial, 159, 0)
	now := time.Now()
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "cialai-torpath-" + fingerprint(public)},
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

func serverTLSConfig(id *identity, peer ed25519.PublicKey) *tls.Config {
	return &tls.Config{
		MinVersion:             tls.VersionTLS13,
		Certificates:           []tls.Certificate{id.cert},
		ClientAuth:             tls.RequireAnyClientCert,
		NextProtos:             []string{alpn},
		SessionTicketsDisabled: true,
		VerifyConnection:       pinnedVerifier(peer, time.Now),
	}
}

func clientTLSConfig(id *identity, peer ed25519.PublicKey) *tls.Config {
	return &tls.Config{
		MinVersion:             tls.VersionTLS13,
		Certificates:           []tls.Certificate{id.cert},
		NextProtos:             []string{alpn},
		ServerName:             "cialai-torpath",
		InsecureSkipVerify:     true, // Replaced by the Ed25519 pin below.
		SessionTicketsDisabled: true,
		VerifyConnection:       pinnedVerifier(peer, time.Now),
	}
}

func pinnedVerifier(expected ed25519.PublicKey, now func() time.Time) func(tls.ConnectionState) error {
	return pinnedVerifierForALPN(expected, alpn, now)
}

func pinnedVerifierForALPN(expected ed25519.PublicKey, expectedALPN string, now func() time.Time) func(tls.ConnectionState) error {
	want := append(ed25519.PublicKey(nil), expected...)
	return func(state tls.ConnectionState) error {
		if state.Version != tls.VersionTLS13 {
			return errors.New("peer did not negotiate TLS 1.3")
		}
		if state.NegotiatedProtocol != expectedALPN {
			return errors.New("peer negotiated the wrong ALPN")
		}
		if len(state.PeerCertificates) != 1 {
			return errors.New("peer must present exactly one certificate")
		}
		cert := state.PeerCertificates[0]
		public, ok := cert.PublicKey.(ed25519.PublicKey)
		if !ok || len(public) != ed25519.PublicKeySize {
			return errors.New("peer certificate is not Ed25519")
		}
		if !bytes.Equal(public, want) {
			return errors.New("peer Ed25519 key does not match the pin")
		}
		at := now()
		if at.Before(cert.NotBefore) || at.After(cert.NotAfter) {
			return errors.New("peer certificate is outside its validity window")
		}
		if err := cert.CheckSignature(cert.SignatureAlgorithm, cert.RawTBSCertificate, cert.Signature); err != nil {
			return errors.New("peer certificate is not self-signed by the pinned key")
		}
		return nil
	}
}

func parsePublicKey(text string) (ed25519.PublicKey, error) {
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(text))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, errors.New("peer key must be a base64url Ed25519 public key")
	}
	return ed25519.PublicKey(raw), nil
}

func encodePublicKey(public ed25519.PublicKey) string {
	return base64.RawURLEncoding.EncodeToString(public)
}

func fingerprint(public ed25519.PublicKey) string {
	digest := sha256.Sum256(public)
	return fmt.Sprintf("%x", digest[:8])
}
