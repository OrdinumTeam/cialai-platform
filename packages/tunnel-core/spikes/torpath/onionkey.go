// SPDX-License-Identifier: Apache-2.0

package main

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/cretz/bine/torutil"
	tored25519 "github.com/cretz/bine/torutil/ed25519"
)

func runOnionKeygen(args []string) error {
	flags := flag.NewFlagSet("onion-keygen", flag.ContinueOnError)
	path := flags.String("key", "", "path to the persistent ED25519-V3 private key")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *path == "" {
		return errors.New("--key is required")
	}
	key, created, err := loadOrCreateOnionKey(*path)
	if err != nil {
		return err
	}
	return writeJSON(os.Stdout, map[string]any{
		"address": torutil.OnionServiceIDFromPrivateKey(key) + ".onion",
		"created": created,
		"event":   "onion_identity",
		"keyPath": *path,
	})
}

func loadOrCreateOnionKey(path string) (tored25519.KeyPair, bool, error) {
	if path == "" {
		return nil, false, errors.New("onion key path is required")
	}
	raw, err := os.ReadFile(path)
	if err == nil {
		if err := checkPrivatePermissions(path); err != nil {
			return nil, false, err
		}
		decoded, decodeErr := base64.RawURLEncoding.DecodeString(strings.TrimSpace(string(raw)))
		if decodeErr != nil || len(decoded) != tored25519.PrivateKeySize {
			return nil, false, errors.New("onion key file is corrupt")
		}
		return tored25519.PrivateKey(decoded).KeyPair(), false, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, false, fmt.Errorf("read onion key: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, false, fmt.Errorf("create onion key directory: %w", err)
	}
	key, err := tored25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, false, fmt.Errorf("generate onion key: %w", err)
	}
	encoded := []byte(base64.RawURLEncoding.EncodeToString(key.PrivateKey()) + "\n")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if errors.Is(err, os.ErrExist) {
		return loadOrCreateOnionKey(path)
	}
	if err != nil {
		return nil, false, fmt.Errorf("create onion key: %w", err)
	}
	if _, err := file.Write(encoded); err != nil {
		_ = file.Close()
		return nil, false, fmt.Errorf("write onion key: %w", err)
	}
	if err := file.Sync(); err != nil {
		_ = file.Close()
		return nil, false, fmt.Errorf("sync onion key: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, false, fmt.Errorf("close onion key: %w", err)
	}
	return key, true, nil
}
