// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"time"

	"github.com/cretz/bine/tor"
	"github.com/cretz/bine/torutil"
)

type synchronizedJSON struct {
	mu sync.Mutex
}

func (writer *synchronizedJSON) write(value any) error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writeJSON(os.Stdout, value)
}

func runServer(args []string) (returnErr error) {
	flags := flag.NewFlagSet("server", flag.ContinueOnError)
	torPath := flags.String("tor", "", "path to the Tor Expert Bundle executable")
	state := flags.String("state", "", "persistent state directory")
	identityPath := flags.String("identity", "", "path to this peer's TLS identity")
	peerKeyText := flags.String("peer-key", "", "pinned client TLS Ed25519 public key")
	onionKeyPath := flags.String("onion-key", "", "persistent ED25519-V3 key (default <state>/onion.key)")
	remotePort := flags.Int("remote-port", 443, "onion service virtual port")
	startupTimeout := flags.Duration("startup-timeout", 5*time.Minute, "bootstrap and publication timeout")
	maxConnections := flags.Int("max-connections", 0, "exit after accepting this many connections (0 keeps serving)")
	verboseTor := flags.Bool("verbose-tor", false, "show Tor and bine diagnostic logs")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *torPath == "" || *state == "" || *identityPath == "" || *peerKeyText == "" {
		return errors.New("--tor, --state, --identity, and --peer-key are required")
	}
	if err := requirePositive("--remote-port", *remotePort); err != nil {
		return err
	}
	if *maxConnections < 0 {
		return errors.New("--max-connections cannot be negative")
	}
	peerKey, err := parsePublicKey(*peerKeyText)
	if err != nil {
		return err
	}
	id, identityCreated, err := loadOrCreateIdentity(*identityPath)
	if err != nil {
		return err
	}
	if *onionKeyPath == "" {
		*onionKeyPath = filepath.Join(*state, "onion.key")
	}
	onionKey, onionKeyCreated, err := loadOrCreateOnionKey(*onionKeyPath)
	if err != nil {
		return err
	}
	bundleRoot, err := torBundleRoot(*torPath)
	if err != nil {
		return err
	}
	files, err := makeTorFiles(*state, bundleRoot, "server")
	if err != nil {
		return err
	}

	rootContext, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	startupContext, cancelStartup := context.WithTimeout(rootContext, *startupTimeout)
	defer cancelStartup()
	events := &synchronizedJSON{}
	if err := events.write(map[string]any{
		"event":           "server_starting",
		"identityCreated": identityCreated,
		"onionKeyCreated": onionKeyCreated,
		"onionKeyPath":    *onionKeyPath,
		"publicKey":       encodePublicKey(id.public),
		"torBundleRoot":   bundleRoot,
		"torrc":           files.torrc,
	}); err != nil {
		return err
	}

	runtime, controlReady, err := launchTor(*torPath, files, true, *verboseTor)
	if err != nil {
		return err
	}
	defer func() {
		if err := runtime.close(); err != nil {
			returnErr = errors.Join(returnErr, err)
		}
		_ = events.write(map[string]any{"event": "tor_stopped", "pid": runtime.pid()})
	}()
	bootstrapStarted := time.Now()
	if err := runtime.instance.EnableNetwork(startupContext, true); err != nil {
		return fmt.Errorf("bootstrap Tor: %w", err)
	}
	bootstrapDuration := time.Since(bootstrapStarted)

	localListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen locally: %w", err)
	}
	defer localListener.Close()
	publishStarted := time.Now()
	service, err := runtime.instance.Listen(startupContext, &tor.ListenConf{
		Key:           onionKey,
		LocalListener: localListener,
		NonAnonymous:  true,
		RemotePorts:   []int{*remotePort},
	})
	if err != nil {
		return fmt.Errorf("publish onion service: %w", err)
	}
	publishDuration := time.Since(publishStarted)
	defer service.Close()
	expectedID := torutil.OnionServiceIDFromPrivateKey(onionKey)
	if service.ID != expectedID {
		return fmt.Errorf("Tor published unexpected service ID %s instead of %s", service.ID, expectedID)
	}
	if err := events.write(map[string]any{
		"address":        service.String(),
		"bootstrapMs":    durationMS(bootstrapDuration),
		"controlReadyMs": durationMS(controlReady),
		"event":          "onion_published",
		"pid":            runtime.pid(),
		"publishMs":      durationMS(publishDuration),
		"tls":            "1.3-mutual-ed25519-pin",
	}); err != nil {
		return err
	}

	serveContext, cancelServe := context.WithCancel(rootContext)
	defer cancelServe()
	go func() {
		<-serveContext.Done()
		_ = localListener.Close()
	}()
	var connections sync.WaitGroup
	accepted := 0
	for *maxConnections == 0 || accepted < *maxConnections {
		connection, err := localListener.Accept()
		if err != nil {
			if serveContext.Err() != nil {
				break
			}
			return fmt.Errorf("accept local onion connection: %w", err)
		}
		accepted++
		sequence := accepted
		connections.Add(1)
		go func() {
			defer connections.Done()
			connectionContext, cancel := context.WithTimeout(serveContext, 2*time.Minute)
			defer cancel()
			err := serveConnection(connectionContext, connection, serverTLSConfig(id, peerKey))
			_ = events.write(map[string]any{
				"connection": sequence,
				"error":      errorText(err),
				"event":      "connection_closed",
			})
		}()
	}
	connections.Wait()
	return nil
}

func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
