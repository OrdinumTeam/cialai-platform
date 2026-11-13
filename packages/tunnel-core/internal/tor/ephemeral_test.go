// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"bytes"
	"context"
	"errors"
	"io"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

func ephemeralSeed(fill byte) [32]byte {
	var seed [32]byte
	for index := range seed {
		seed[index] = fill
	}
	return seed
}

func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// addOnions returns the service ids of the ADD_ONION commands a fake tor
// received, in order.
func addOnions(t *testing.T, tor *fakeTor) []string {
	t.Helper()
	var ids []string
	for _, command := range tor.received() {
		if rest, ok := strings.CutPrefix(command, "ADD_ONION "); ok {
			id, err := fakeServiceID(rest)
			if err != nil {
				t.Fatal(err)
			}
			ids = append(ids, id)
		}
	}
	return ids
}

func TestDesktopAddsAndRemovesTemporaryServices(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{})
	config := fakeDesktopConfig(t, creator, &stateLog{})
	desktop := startTestDesktop(t, config)
	waitDesktop(t, desktop, published)
	tor := creator.waitInstance(t, 0)
	seed := ephemeralSeed(7)
	key, err := OnionKeyFromSeed(seed[:])
	if err != nil {
		t.Fatal(err)
	}
	address, err := desktop.AddEphemeral(seed)
	if err != nil || address != key.Address() {
		t.Fatalf("AddEphemeral = %q, %v", address, err)
	}
	eventually(t, "the temporary descriptor upload", func() bool { return desktop.EphemeralPublished(address) })
	if !desktop.EphemeralPublished(address+":443") || !desktop.State().Published {
		t.Fatal("the port form or the desktop service lost its state")
	}
	if ids := addOnions(t, tor); !slices.Equal(ids, []string{desktop.key.ServiceID(), key.ServiceID()}) {
		t.Fatalf("ADD_ONION ids = %q", ids)
	}
	commands := tor.received()
	last := ""
	for _, command := range commands {
		if strings.HasPrefix(command, "ADD_ONION ") {
			last = command
		}
	}
	if want := " Flags=NonAnonymous Port=443," + desktop.Listener().Addr().String(); !strings.HasSuffix(last, want) {
		t.Fatalf("temporary ADD_ONION = %q, want suffix %q", last, want)
	}
	if again, err := desktop.AddEphemeral(seed); err != nil || again != address || len(addOnions(t, tor)) != 2 {
		t.Fatalf("adding twice = %q, %v", again, err)
	}

	if err := desktop.RemoveEphemeral(address + ":443"); err != nil {
		t.Fatal(err)
	}
	if !slices.Contains(tor.received(), "DEL_ONION "+key.ServiceID()) || desktop.EphemeralPublished(address) {
		t.Fatal("the temporary service was not withdrawn")
	}
	before := len(tor.received())
	if err := desktop.RemoveEphemeral(address); err != nil || len(tor.received()) != before {
		t.Fatalf("removing twice = %v", err)
	}
	if err := desktop.RemoveEphemeral("example.com"); err == nil {
		t.Fatal("removed a host that is not an onion")
	}
	own, _, err := LoadOrCreateOnionKey(filepath.Join(config.Dir, "onion.key"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := desktop.AddEphemeral([32]byte(own.seed)); err == nil {
		t.Fatal("the desktop key was accepted as a temporary service")
	}
	if !desktop.State().Published {
		t.Fatal("temporary services disturbed the desktop service")
	}
}

func TestDesktopAddsTemporaryServicesAgainAfterARestart(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{})
	desktop := startTestDesktop(t, fakeDesktopConfig(t, creator, &stateLog{}))
	waitDesktop(t, desktop, published)
	seed := ephemeralSeed(8)
	address, err := desktop.AddEphemeral(seed)
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "the first upload", func() bool { return desktop.EphemeralPublished(address) })
	creator.waitInstance(t, 0).crash()
	waitDesktop(t, desktop, func(state State) bool { return state.Restarts == 1 && state.Published })
	eventually(t, "the upload after the restart", func() bool { return desktop.EphemeralPublished(address) })
	second := creator.waitInstance(t, 1)
	key, _ := OnionKeyFromSeed(seed[:])
	if ids := addOnions(t, second); !slices.Equal(ids, []string{desktop.key.ServiceID(), key.ServiceID()}) {
		t.Fatalf("ADD_ONION ids after the restart = %q", ids)
	}
	commands := second.received()
	added := slices.IndexFunc(commands, func(command string) bool {
		rest, ok := strings.CutPrefix(command, "ADD_ONION ")
		id, _ := fakeServiceID(rest)
		return ok && id == key.ServiceID()
	})
	if added < 0 || added > slices.Index(commands, "SETCONF DisableNetwork=0") {
		t.Fatalf("the temporary service was not added before the network was enabled: %q", commands)
	}
	if err := desktop.RemoveEphemeral(address); err != nil || !slices.Contains(second.received(), "DEL_ONION "+key.ServiceID()) {
		t.Fatalf("removal after the restart = %v", err)
	}
}

func TestDesktopRegistersTemporaryServicesAddedBeforeTorRuns(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{})
	desktop := startTestDesktop(t, fakeDesktopConfig(t, creator, &stateLog{}))
	seed := ephemeralSeed(9)
	address, err := desktop.AddEphemeral(seed)
	if err != nil {
		t.Fatal(err)
	}
	waitDesktop(t, desktop, published)
	eventually(t, "the temporary descriptor upload", func() bool { return desktop.EphemeralPublished(address) })
	key, _ := OnionKeyFromSeed(seed[:])
	ids := addOnions(t, creator.waitInstance(t, 0))
	if len(ids) != 2 || ids[0] != desktop.key.ServiceID() || ids[1] != key.ServiceID() {
		t.Fatalf("ADD_ONION ids = %q", ids)
	}
	if err := desktop.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := desktop.AddEphemeral(ephemeralSeed(10)); !errors.Is(err, ErrDesktopClosed) {
		t.Fatalf("AddEphemeral after Close = %v", err)
	}
}

func TestDesktopReportsTemporaryServicesWithoutUploadAsUnpublished(t *testing.T) {
	creator := newFakeCreator(fakeBehavior{noUpload: true})
	desktop := startTestDesktop(t, fakeDesktopConfig(t, creator, &stateLog{}))
	waitDesktop(t, desktop, func(state State) bool { return state.Bootstrap.Progress == 100 })
	address, err := desktop.AddEphemeral(ephemeralSeed(11))
	if err != nil {
		t.Fatal(err)
	}
	eventually(t, "the ADD_ONION of the temporary service", func() bool { return len(addOnions(t, creator.waitInstance(t, 0))) == 2 })
	time.Sleep(50 * time.Millisecond)
	if desktop.EphemeralPublished(address) {
		t.Fatal("a service without descriptor upload is reported published")
	}
}

func TestClientNewnymSignalsThroughTheControlPort(t *testing.T) {
	fake, address, cookie := startFakeTor(t)
	client := NewClient()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := client.Newnym(ctx); !errors.Is(err, ErrNoEndpoints) {
		t.Fatalf("Newnym without endpoints = %v", err)
	}
	if err := client.SetTorEndpoints(Endpoints{SOCKS: "127.0.0.1:9050"}); err != nil {
		t.Fatal(err)
	}
	if err := client.Newnym(ctx); !errors.Is(err, ErrNoControlEndpoint) {
		t.Fatalf("Newnym without control = %v", err)
	}
	if err := client.SetTorEndpoints(Endpoints{SOCKS: "127.0.0.1:9050", Control: address, CookiePath: cookie}); err != nil {
		t.Fatal(err)
	}
	if err := client.Newnym(ctx); err != nil {
		t.Fatal(err)
	}
	commands := fake.received()
	if !slices.Contains(commands, "SIGNAL NEWNYM") || slices.Contains(commands, "TAKEOWNERSHIP") {
		t.Fatalf("commands = %q", commands)
	}
	if fake.hasExited() {
		t.Fatal("NEWNYM stopped the Tor it does not own")
	}
}

func TestClientRecordsTheKeyOfAnOnionHost(t *testing.T) {
	desktop, err := identity.Generate(identity.RoleDesktop, nil)
	if err != nil {
		t.Fatal(err)
	}
	broto, err := identity.Generate(identity.RoleBroto, nil)
	if err != nil {
		t.Fatal(err)
	}
	backend, peers := startPinnedEchoServer(t, desktop)
	onion := mustOnion(t)
	socks := startFakeSOCKS(t, map[string]string{onion + ":443": backend}, false)
	client := NewClient()
	if err := client.SetTorEndpoints(Endpoints{SOCKS: socks.listener.Addr().String()}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, key, err := client.DialTLSRecord(ctx, onion, broto)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if !bytes.Equal(key, desktop.PublicKey()) {
		t.Fatal("the recorded key is not the key of the host")
	}
	if _, err := conn.Write([]byte("ping\n")); err != nil {
		t.Fatal(err)
	}
	echo := make([]byte, 5)
	if _, err := io.ReadFull(conn, echo); err != nil || string(echo) != "ping\n" {
		t.Fatalf("echo = %q, %v", echo, err)
	}
	if peer := <-peers; peer != broto.PublicKeyString() {
		t.Fatalf("server saw key %s", peer)
	}
	if _, _, err := client.DialTLSRecord(ctx, mustOnion(t), broto); err == nil {
		t.Fatal("unpublished onion dialed")
	}
	if _, _, err := client.DialTLSRecord(ctx, onion, nil); err == nil {
		t.Fatal("DialTLSRecord without a local identity succeeded")
	}
}
