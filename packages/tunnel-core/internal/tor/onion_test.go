// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"bytes"
	"encoding/base64"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/cretz/bine/torutil"
	tored25519 "github.com/cretz/bine/torutil/ed25519"
)

func TestServiceIDMatchesIndependentDerivation(t *testing.T) {
	for range 16 {
		key, err := GenerateOnionKey(nil)
		if err != nil {
			t.Fatal(err)
		}
		want := torutil.OnionServiceIDFromPublicKey(tored25519.FromCryptoPublicKey(key.PublicKey()))
		if key.ServiceID() != want || len(key.ServiceID()) != serviceIDLength {
			t.Fatalf("service id = %s, bine derives %s", key.ServiceID(), want)
		}
		if key.Address() != want+".onion" {
			t.Fatalf("address = %s", key.Address())
		}
		// The ADD_ONION blob is Tor's expanded secret key; it must lead to the
		// same public key through bine's scalar multiplication.
		blob, err := base64.StdEncoding.DecodeString(key.torBlob())
		if err != nil || len(blob) != tored25519.PrivateKeySize {
			t.Fatalf("blob length %d, err %v", len(blob), err)
		}
		if got := tored25519.PrivateKey(blob).PublicKey(); !bytes.Equal(got, key.PublicKey()) {
			t.Fatal("expanded ADD_ONION key does not match the public key")
		}
	}
}

func TestServiceIDKnownVector(t *testing.T) {
	// Public key of the all-zero seed, checked against bine and rend-spec-v3.
	key, err := OnionKeyFromSeed(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	want := torutil.OnionServiceIDFromV3PublicKey(tored25519.FromCryptoPublicKey(key.PublicKey()))
	if key.ServiceID() != want {
		t.Fatalf("service id = %s, want %s", key.ServiceID(), want)
	}
	if !strings.HasSuffix(key.ServiceID(), "d") {
		t.Fatalf("v3 service id must end with the version character d: %s", key.ServiceID())
	}
}

func TestParseOnionAddress(t *testing.T) {
	key, err := GenerateOnionKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	address, public, err := ParseOnionAddress(strings.ToUpper(key.Address()))
	if err != nil || address != key.Address() || !bytes.Equal(public, key.PublicKey()) {
		t.Fatalf("ParseOnionAddress = %q, %v", address, err)
	}
	id := []byte(key.ServiceID())
	corruptChecksum := bytes.Clone(id)
	corruptChecksum[53] = map[bool]byte{true: 'a', false: 'b'}[corruptChecksum[53] != 'a']
	wrongVersion, _ := serviceIDEncoding.DecodeString(strings.ToUpper(key.ServiceID()))
	wrongVersion[34] = 0x02
	for _, bad := range []string{
		"",
		key.ServiceID(),
		key.ServiceID()[:55] + ".onion",
		string(corruptChecksum) + ".onion",
		strings.ToLower(serviceIDEncoding.EncodeToString(wrongVersion)) + ".onion",
		key.Address() + ":443",
		"expyuzz4wqqyqhjn.onion",
	} {
		if _, _, err := ParseOnionAddress(bad); !errors.Is(err, ErrInvalidOnionAddress) {
			t.Errorf("ParseOnionAddress(%q) err = %v", bad, err)
		}
	}
}

func TestLoadOrCreateOnionKeyPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tor", "onion.key")
	first, created, err := LoadOrCreateOnionKey(path, nil)
	if err != nil || !created {
		t.Fatalf("first load created=%v err=%v", created, err)
	}
	second, created, err := LoadOrCreateOnionKey(path, nil)
	if err != nil || created {
		t.Fatalf("second load created=%v err=%v", created, err)
	}
	if first.Address() != second.Address() {
		t.Fatalf("address changed from %s to %s", first.Address(), second.Address())
	}
	if runtime.GOOS != "windows" {
		for target, want := range map[string]os.FileMode{path: 0o600, filepath.Dir(path): 0o700} {
			info, err := os.Stat(target)
			if err != nil || info.Mode().Perm() != want {
				t.Fatalf("%s mode = %v, want %04o (err %v)", target, info.Mode().Perm(), want, err)
			}
		}
	}
	if _, _, err := LoadOrCreateOnionKey("relative/onion.key", nil); err == nil {
		t.Fatal("relative key path was accepted")
	}
}

func TestLoadOrCreateOnionKeyNeverReplacesBadKeys(t *testing.T) {
	dir := t.TempDir()
	corrupt := filepath.Join(dir, "corrupt.key")
	if err := os.WriteFile(corrupt, []byte("not base64 !!\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := LoadOrCreateOnionKey(corrupt, nil); !errors.Is(err, ErrOnionKeyCorrupt) {
		t.Fatalf("corrupt key err = %v", err)
	}
	if data, _ := os.ReadFile(corrupt); string(data) != "not base64 !!\n" {
		t.Fatal("corrupt key was replaced")
	}
	if runtime.GOOS != "windows" {
		key, _ := GenerateOnionKey(nil)
		open := filepath.Join(dir, "open.key")
		if err := os.WriteFile(open, []byte(base64.RawURLEncoding.EncodeToString(key.seed)), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, _, err := LoadOrCreateOnionKey(open, nil); !errors.Is(err, ErrOnionKeyPermissions) {
			t.Fatalf("world readable key err = %v", err)
		}
		link := filepath.Join(dir, "link.key")
		if err := os.Symlink(corrupt, link); err != nil {
			t.Fatal(err)
		}
		if _, _, err := LoadOrCreateOnionKey(link, nil); !errors.Is(err, ErrOnionKeyCorrupt) {
			t.Fatalf("symlinked key err = %v", err)
		}
	}
}

func TestLoadOrCreateOnionKeyConcurrentCreatorsAgree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tor", "onion.key")
	const workers = 8
	addresses := make([]string, workers)
	errs := make([]error, workers)
	var wait sync.WaitGroup
	for index := range workers {
		wait.Go(func() {
			key, _, err := LoadOrCreateOnionKey(path, nil)
			errs[index] = err
			if key != nil {
				addresses[index] = key.Address()
			}
		})
	}
	wait.Wait()
	for index := range workers {
		if errs[index] != nil || addresses[index] != addresses[0] {
			t.Fatalf("worker %d address %s err %v, want %s", index, addresses[index], errs[index], addresses[0])
		}
	}
}
