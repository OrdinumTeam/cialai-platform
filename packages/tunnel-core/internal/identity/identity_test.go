// SPDX-License-Identifier: Apache-2.0
package identity

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeRegistry map[string]string

func (registry fakeRegistry) RegisteredKey(key string) (string, bool) {
	id, ok := registry[key]
	return id, ok
}

func mustGenerate(t *testing.T, role Role) *Identity {
	t.Helper()
	identity, err := Generate(role, nil)
	if err != nil {
		t.Fatal(err)
	}
	return identity
}

func TestDeriveIDIsStableAndPrefixedByRole(t *testing.T) {
	seed := bytes.Repeat([]byte{7}, ed25519.SeedSize)
	desktop, err := FromSeed(RoleDesktop, seed)
	if err != nil {
		t.Fatal(err)
	}
	again, err := FromSeed(RoleDesktop, seed)
	if err != nil {
		t.Fatal(err)
	}
	phone, err := FromSeed(RolePhone, seed)
	if err != nil {
		t.Fatal(err)
	}
	if desktop.ID() != again.ID() || !strings.HasPrefix(desktop.ID(), "d_") || len(desktop.ID()) != len("d_")+22 {
		t.Fatalf("unexpected desktop id %q", desktop.ID())
	}
	if !strings.HasPrefix(phone.ID(), "dev_") || strings.TrimPrefix(phone.ID(), "dev_") != strings.TrimPrefix(desktop.ID(), "d_") {
		t.Fatalf("unexpected phone id %q", phone.ID())
	}
	parsed, err := ParsePublicKey(desktop.PublicKeyString())
	if err != nil || !bytes.Equal(parsed, desktop.PublicKey()) {
		t.Fatalf("public key round trip failed: %v", err)
	}
	if _, err := ParsePublicKey(desktop.PublicKeyString() + "="); err == nil {
		t.Fatal("padded public key was accepted")
	}
	if _, err := FromSeed(Role("server"), seed); err == nil {
		t.Fatal("unknown role was accepted")
	}
	if len(desktop.Fingerprint()) != 16 {
		t.Fatalf("unexpected fingerprint %q", desktop.Fingerprint())
	}
}

func TestOpenPersistsPrivateKeyAndPublicRecord(t *testing.T) {
	dir := t.TempDir()
	clock := time.Date(2026, 9, 14, 12, 0, 0, 0, time.UTC)
	first, record, created, err := Open(Options{Role: RoleDesktop, Dir: dir, Name: "MacBook", Now: func() time.Time { return clock }})
	if err != nil || !created {
		t.Fatalf("first open: created=%v err=%v", created, err)
	}
	if record.Version != RecordVersion || record.ID != first.ID() || record.PublicKey != first.PublicKeyString() || !record.CreatedAt.Equal(clock) {
		t.Fatalf("unexpected record %#v", record)
	}
	keyInfo, err := os.Stat(filepath.Join(dir, KeyFileName))
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && keyInfo.Mode().Perm() != 0o600 {
		t.Fatalf("identity.key mode %04o", keyInfo.Mode().Perm())
	}
	recordData, err := os.ReadFile(filepath.Join(dir, RecordFileName))
	if err != nil {
		t.Fatal(err)
	}
	keyData, _ := os.ReadFile(filepath.Join(dir, KeyFileName))
	if bytes.Contains(recordData, bytes.TrimSpace(keyData)) || bytes.Contains(bytes.ToLower(recordData), []byte("private")) || bytes.Contains(bytes.ToLower(recordData), []byte("seed")) {
		t.Fatalf("identity.json leaks secret material: %s", recordData)
	}
	second, reopened, created, err := Open(Options{Role: RoleDesktop, Dir: dir, Now: func() time.Time { return clock.Add(time.Hour) }})
	if err != nil || created {
		t.Fatalf("second open: created=%v err=%v", created, err)
	}
	if second.ID() != first.ID() || !reopened.CreatedAt.Equal(clock) || reopened.Name != "MacBook" {
		t.Fatalf("identity was not reloaded: %#v", reopened)
	}
}

func TestOpenReplacesVersionOneRecordButKeepsKey(t *testing.T) {
	dir := t.TempDir()
	first, _, _, err := Open(Options{Role: RoleDesktop, Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	legacy := `{"id":"d_old","name":"Antigo","userId":"1","controlUrl":"https://headscale.example"}`
	if err := os.WriteFile(filepath.Join(dir, RecordFileName), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	second, record, _, err := Open(Options{Role: RoleDesktop, Dir: dir, Name: "Novo"})
	if err != nil || second.ID() != first.ID() || record.Version != RecordVersion || record.ID != first.ID() {
		t.Fatalf("v1 record was not replaced: %#v %v", record, err)
	}
	data, _ := os.ReadFile(filepath.Join(dir, RecordFileName))
	var decoded map[string]any
	if err := json.Unmarshal(data, &decoded); err != nil || decoded["controlUrl"] != nil {
		t.Fatalf("legacy fields survived: %s", data)
	}
}

func TestOpenRejectsCorruptOrExposedKeys(t *testing.T) {
	cases := map[string]func(t *testing.T, path string){
		"garbage": func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("not base64 !!!\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"short seed": func(t *testing.T, path string) {
			if err := os.WriteFile(path, []byte("AAAA\n"), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"oversized": func(t *testing.T, path string) {
			if err := os.WriteFile(path, bytes.Repeat([]byte("A"), maxKeyBytes*2), 0o600); err != nil {
				t.Fatal(err)
			}
		},
		"empty": func(t *testing.T, path string) {
			if err := os.WriteFile(path, nil, 0o600); err != nil {
				t.Fatal(err)
			}
		},
	}
	for name, prepare := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, KeyFileName)
			prepare(t, path)
			before, _ := os.ReadFile(path)
			if _, _, _, err := Open(Options{Role: RoleDesktop, Dir: dir}); !errors.Is(err, ErrCorrupt) {
				t.Fatalf("expected ErrCorrupt, got %v", err)
			}
			after, _ := os.ReadFile(path)
			if !bytes.Equal(before, after) {
				t.Fatal("corrupt key was overwritten")
			}
		})
	}
	if runtime.GOOS == "windows" {
		return
	}
	t.Run("world readable", func(t *testing.T) {
		dir := t.TempDir()
		if _, _, _, err := Open(Options{Role: RoleDesktop, Dir: dir}); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Join(dir, KeyFileName), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := Open(Options{Role: RoleDesktop, Dir: dir}); !errors.Is(err, ErrPermissions) {
			t.Fatalf("expected ErrPermissions, got %v", err)
		}
	})
	t.Run("symlink", func(t *testing.T) {
		dir := t.TempDir()
		target := filepath.Join(t.TempDir(), "elsewhere.key")
		if _, _, _, err := Open(Options{Role: RoleDesktop, Dir: filepath.Dir(target)}); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(filepath.Dir(target), KeyFileName), filepath.Join(dir, KeyFileName)); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := Open(Options{Role: RoleDesktop, Dir: dir}); !errors.Is(err, ErrCorrupt) {
			t.Fatalf("expected symlink rejection, got %v", err)
		}
	})
	if _, _, _, err := Open(Options{Role: RoleDesktop, Dir: "relative"}); err == nil {
		t.Fatal("relative directory was accepted")
	}
}

func TestConcurrentOpenAgreesOnOneKey(t *testing.T) {
	dir := t.TempDir()
	const openers = 12
	ids := make([]string, openers)
	errs := make([]error, openers)
	var wait sync.WaitGroup
	for index := range openers {
		wait.Add(1)
		go func() {
			defer wait.Done()
			identity, _, _, err := Open(Options{Role: RolePhone, Dir: dir})
			errs[index] = err
			if identity != nil {
				ids[index] = identity.ID()
			}
		}()
	}
	wait.Wait()
	for index := range openers {
		if errs[index] != nil || ids[index] != ids[0] {
			t.Fatalf("opener %d: id=%q err=%v first=%q", index, ids[index], errs[index], ids[0])
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".cialai-identity-") {
			t.Fatalf("temporary file left behind: %s", entry.Name())
		}
	}
}

type handshakeResult struct {
	state tls.ConnectionState
	err   error
}

func handshake(t *testing.T, client, server *tls.Config) (handshakeResult, handshakeResult) {
	t.Helper()
	// Loopback TCP instead of net.Pipe: alerts must not block on an unread pipe.
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	clientConn, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	serverConn, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	results := make(chan handshakeResult, 1)
	go func() {
		connection := tls.Server(serverConn, server)
		err := connection.HandshakeContext(ctx)
		if err == nil {
			// TLS 1.3 servers finish before reading the client Finished; wait for it.
			buffer := make([]byte, 1)
			_, err = connection.Read(buffer)
		}
		results <- handshakeResult{state: connection.ConnectionState(), err: err}
		_ = connection.Close()
	}()
	connection := tls.Client(clientConn, client)
	err = connection.HandshakeContext(ctx)
	if err == nil {
		_, err = connection.Write([]byte{1})
	}
	clientResult := handshakeResult{state: connection.ConnectionState(), err: err}
	_ = connection.Close()
	serverResult := <-results
	return clientResult, serverResult
}

func TestMutualTLSAcceptsPinnedDesktopAndMarksRegistration(t *testing.T) {
	desktop := mustGenerate(t, RoleDesktop)
	phone := mustGenerate(t, RolePhone)
	clientConfig, err := ClientConfig(phone, desktop.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	serverConfig, err := ServerConfig(desktop)
	if err != nil {
		t.Fatal(err)
	}
	if !clientConfig.SessionTicketsDisabled || clientConfig.ClientSessionCache != nil || !serverConfig.SessionTicketsDisabled || clientConfig.MinVersion != tls.VersionTLS13 {
		t.Fatal("resumption or pre-1.3 TLS is enabled")
	}
	clientResult, serverResult := handshake(t, clientConfig, serverConfig)
	if clientResult.err != nil || serverResult.err != nil {
		t.Fatalf("handshake failed: client=%v server=%v", clientResult.err, serverResult.err)
	}
	if clientResult.state.NegotiatedProtocol != ALPN || clientResult.state.DidResume {
		t.Fatalf("unexpected client state %#v", clientResult.state)
	}
	unknown, err := ServerPeer(serverResult.state, fakeRegistry{})
	if err != nil || unknown.Registered || unknown.Key != phone.PublicKeyString() || unknown.DeviceID != "" {
		t.Fatalf("unknown phone must be accepted as unregistered: %#v %v", unknown, err)
	}
	known, err := ServerPeer(serverResult.state, fakeRegistry{phone.PublicKeyString(): "dev_registered"})
	if err != nil || !known.Registered || known.DeviceID != "dev_registered" {
		t.Fatalf("registered phone was not marked: %#v %v", known, err)
	}
	desktopKey, err := PeerPublicKey(clientResult.state)
	if err != nil || !bytes.Equal(desktopKey, desktop.PublicKey()) {
		t.Fatalf("client did not see the desktop key: %v", err)
	}
}

func TestPhoneRejectsWrongDesktopKey(t *testing.T) {
	desktop := mustGenerate(t, RoleDesktop)
	impostor := mustGenerate(t, RoleDesktop)
	phone := mustGenerate(t, RolePhone)
	clientConfig, _ := ClientConfig(phone, desktop.PublicKey())
	serverConfig, _ := ServerConfig(impostor)
	clientResult, serverResult := handshake(t, clientConfig, serverConfig)
	if !errors.Is(clientResult.err, ErrPinMismatch) {
		t.Fatalf("expected pin mismatch, got %v", clientResult.err)
	}
	if serverResult.err == nil {
		t.Fatal("server completed a handshake the phone rejected")
	}
}

func TestPinIgnoresExpiredCertificate(t *testing.T) {
	seed := bytes.Repeat([]byte{3}, ed25519.SeedSize)
	expired, err := fromSeedAt(RoleDesktop, seed, time.Now().AddDate(-20, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if time.Now().Before(expired.Certificate().Leaf.NotAfter) {
		t.Fatal("test certificate is not expired")
	}
	phone := mustGenerate(t, RolePhone)
	clientConfig, _ := ClientConfig(phone, expired.PublicKey())
	serverConfig, _ := ServerConfig(expired)
	clientResult, serverResult := handshake(t, clientConfig, serverConfig)
	if clientResult.err != nil || serverResult.err != nil {
		t.Fatalf("expired certificate with the pinned key was rejected: client=%v server=%v", clientResult.err, serverResult.err)
	}
}

func TestDesktopRejectsClientsWithoutEd25519Certificate(t *testing.T) {
	desktop := mustGenerate(t, RoleDesktop)
	serverConfig, _ := ServerConfig(desktop)

	noCertificate := &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, NextProtos: []string{ALPN}}
	_, serverResult := handshake(t, noCertificate, serverConfig)
	if serverResult.err == nil {
		t.Fatal("client without certificate was accepted")
	}

	ecdsaKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "ecdsa"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &ecdsaKey.PublicKey, ecdsaKey)
	if err != nil {
		t.Fatal(err)
	}
	ecdsaClient := &tls.Config{
		MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, NextProtos: []string{ALPN},
		Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: ecdsaKey}},
	}
	_, serverResult = handshake(t, ecdsaClient, serverConfig)
	if !errors.Is(serverResult.err, ErrPeerInvalid) {
		t.Fatalf("expected ErrPeerInvalid for ECDSA client, got %v", serverResult.err)
	}

	phone := mustGenerate(t, RolePhone)
	wrongALPN, _ := ClientConfig(phone, desktop.PublicKey())
	wrongALPN.NextProtos = []string{"cialai/0"}
	clientResult, _ := handshake(t, wrongALPN, serverConfig)
	if clientResult.err == nil {
		t.Fatal("client with a different ALPN completed the handshake")
	}
}

func TestConfigsRequireInputs(t *testing.T) {
	phone := mustGenerate(t, RolePhone)
	if _, err := ClientConfig(phone, nil); err == nil {
		t.Fatal("client config without pin was accepted")
	}
	if _, err := ClientConfig(nil, phone.PublicKey()); err == nil {
		t.Fatal("client config without identity was accepted")
	}
	if _, err := ServerConfig(nil); err == nil {
		t.Fatal("server config without identity was accepted")
	}
	if _, err := ServerPeer(tls.ConnectionState{Version: tls.VersionTLS12, NegotiatedProtocol: ALPN}, nil); err == nil {
		t.Fatal("TLS 1.2 state was accepted")
	}
}
