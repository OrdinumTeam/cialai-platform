// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/spikes/rendezvous"
	"github.com/cretz/bine/tor"
	"github.com/cretz/bine/torutil"
	"golang.org/x/net/proxy"
)

const rendezvousDirectALPN = "cialai-rendezvous-direct/1"

type rendezvousStringList []string

func (values *rendezvousStringList) String() string { return strings.Join(*values, ",") }

func (values *rendezvousStringList) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return errors.New("value cannot be empty")
	}
	*values = append(*values, value)
	return nil
}

func runRendezvousClient(args []string) (returnErr error) {
	flags := flag.NewFlagSet("rendezvous-client", flag.ContinueOnError)
	torPath := flags.String("tor", "", "path to a Tor Expert Bundle executable")
	state := flags.String("state", "", "persistent client Tor state directory")
	socks := flags.String("socks", "", "external Tor SOCKS5 address instead of --tor")
	onion := flags.String("onion", "", "onion service host:port")
	identityPath := flags.String("identity", "", "path to this peer's TLS identity")
	peerKeyText := flags.String("peer-key", "", "pinned server TLS Ed25519 public key")
	udpListen := flags.String("udp-listen", ":0", "shared UDP address for candidates, punch, and QUIC")
	networkTimeout := flags.Duration("network-timeout", 6*time.Second, "candidate and mapping collection budget")
	timeout := flags.Duration("timeout", 3*time.Minute, "whole rendezvous budget")
	includeLoopback := flags.Bool("include-loopback", false, "include loopback only for a same-machine smoke")
	verboseTor := flags.Bool("verbose-tor", false, "show Tor and bine diagnostic logs")
	var stunServers rendezvousStringList
	flags.Var(&stunServers, "stun", "STUN server; repeat to try more than one")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *onion == "" || *identityPath == "" || *peerKeyText == "" {
		return errors.New("--onion, --identity, and --peer-key are required")
	}
	if (*torPath == "") == (*socks == "") {
		return errors.New("provide exactly one of --tor or --socks")
	}
	if *torPath != "" && *state == "" {
		return errors.New("--state is required with --tor")
	}
	if _, _, err := net.SplitHostPort(*onion); err != nil {
		return fmt.Errorf("--onion must be host:port: %w", err)
	}
	peerKey, err := parsePublicKey(*peerKeyText)
	if err != nil {
		return err
	}
	id, identityCreated, err := loadOrCreateIdentity(*identityPath)
	if err != nil {
		return err
	}
	signalContext, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	runContext, cancel := context.WithTimeout(signalContext, *timeout)
	defer cancel()
	dialer, runtime, controlReady, bootstrapDuration, err := rendezvousDialer(
		runContext, *torPath, *state, *socks, *verboseTor,
	)
	if err != nil {
		return err
	}
	if runtime != nil {
		defer func() {
			if err := runtime.close(); err != nil {
				returnErr = errors.Join(returnErr, err)
			}
			_ = writeJSON(os.Stdout, map[string]any{"event": "tor_stopped", "pid": runtime.pid()})
		}()
	}
	if err := writeJSON(os.Stdout, map[string]any{
		"bootstrapMs": durationMS(bootstrapDuration), "controlReadyMs": durationMS(controlReady),
		"event": "rendezvous_client_starting", "identityCreated": identityCreated,
		"publicKey": encodePublicKey(id.public),
	}); err != nil {
		return err
	}
	raw, err := dialer.DialContext(runContext, "tcp", *onion)
	if err != nil {
		return fmt.Errorf("rendezvous SOCKS dial: %w", err)
	}
	controlConnection := tls.Client(raw, clientTLSConfig(id, peerKey))
	defer controlConnection.Close()
	control, err := rendezvous.NewTLSControl(runContext, controlConnection)
	if err != nil {
		return err
	}
	packetConnection, err := net.ListenPacket("udp", *udpListen)
	if err != nil {
		return fmt.Errorf("listen rendezvous UDP: %w", err)
	}
	direct, err := rendezvous.NewQUICDirectTransport(runContext, rendezvous.QUICDirectConfig{
		PacketConn: packetConnection, PublicKey: encodePublicKey(id.public),
		ClientTLS: directClientTLSConfig(id, peerKey), STUNServers: stunServers,
		IncludeLoopback: *includeLoopback, CollectionTimeout: *networkTimeout,
	})
	if err != nil {
		_ = packetConnection.Close()
		return err
	}
	defer direct.Close()
	outcome, err := rendezvous.Client(runContext, control, direct, control.PeerPublicKey)
	if err != nil {
		return err
	}
	if outcome.Connection != nil {
		defer outcome.Connection.Close()
	}
	return writeJSON(os.Stdout, map[string]any{
		"event": "rendezvous_measurement", "measurement": outcome.Measurement,
		"probe": direct.Probe(), "role": "client",
	})
}

func runRendezvousServer(args []string) (returnErr error) {
	flags := flag.NewFlagSet("rendezvous-server", flag.ContinueOnError)
	torPath := flags.String("tor", "", "path to a Tor Expert Bundle executable")
	state := flags.String("state", "", "persistent server Tor state directory")
	identityPath := flags.String("identity", "", "path to this peer's TLS identity")
	peerKeyText := flags.String("peer-key", "", "pinned client TLS Ed25519 public key")
	onionKeyPath := flags.String("onion-key", "", "persistent ED25519-V3 key (default <state>/onion.key)")
	remotePort := flags.Int("remote-port", 443, "onion service virtual port")
	udpListen := flags.String("udp-listen", ":4740", "shared UDP address for candidates, punch, and QUIC")
	networkTimeout := flags.Duration("network-timeout", 6*time.Second, "candidate and mapping collection budget")
	startupTimeout := flags.Duration("startup-timeout", 5*time.Minute, "Tor bootstrap and publication timeout")
	timeout := flags.Duration("timeout", 10*time.Minute, "whole server rendezvous budget")
	includeLoopback := flags.Bool("include-loopback", false, "include loopback only for a same-machine smoke")
	verboseTor := flags.Bool("verbose-tor", false, "show Tor and bine diagnostic logs")
	var stunServers rendezvousStringList
	flags.Var(&stunServers, "stun", "STUN server; repeat to try more than one")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *torPath == "" || *state == "" || *identityPath == "" || *peerKeyText == "" {
		return errors.New("--tor, --state, --identity, and --peer-key are required")
	}
	if err := requirePositive("--remote-port", *remotePort); err != nil {
		return err
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
	signalContext, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	runContext, cancel := context.WithTimeout(signalContext, *timeout)
	defer cancel()
	startupContext, cancelStartup := context.WithTimeout(runContext, *startupTimeout)
	defer cancelStartup()
	events := &synchronizedJSON{}
	if err := events.write(map[string]any{
		"event": "rendezvous_server_starting", "identityCreated": identityCreated,
		"onionKeyCreated": onionKeyCreated, "publicKey": encodePublicKey(id.public),
		"torBundleRoot": bundleRoot, "torrc": files.torrc,
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
		return fmt.Errorf("listen for onion rendezvous: %w", err)
	}
	defer localListener.Close()
	publishStarted := time.Now()
	service, err := runtime.instance.Listen(startupContext, &tor.ListenConf{
		Key: onionKey, LocalListener: localListener, NonAnonymous: true, RemotePorts: []int{*remotePort},
	})
	if err != nil {
		return fmt.Errorf("publish rendezvous onion service: %w", err)
	}
	defer service.Close()
	if expected := torutil.OnionServiceIDFromPrivateKey(onionKey); service.ID != expected {
		return fmt.Errorf("Tor published unexpected service ID %s instead of %s", service.ID, expected)
	}
	packetConnection, err := net.ListenPacket("udp", *udpListen)
	if err != nil {
		return fmt.Errorf("listen rendezvous UDP: %w", err)
	}
	direct, err := rendezvous.NewQUICDirectTransport(runContext, rendezvous.QUICDirectConfig{
		PacketConn: packetConnection, PublicKey: encodePublicKey(id.public),
		ServerTLS: directServerTLSConfig(id, peerKey), STUNServers: stunServers,
		IncludeLoopback: *includeLoopback, CollectionTimeout: *networkTimeout,
	})
	if err != nil {
		_ = packetConnection.Close()
		return err
	}
	defer direct.Close()
	if err := events.write(map[string]any{
		"address": service.String(), "bootstrapMs": durationMS(bootstrapDuration),
		"controlReadyMs": durationMS(controlReady), "event": "rendezvous_onion_published",
		"pid": runtime.pid(), "publishMs": durationMS(time.Since(publishStarted)),
	}); err != nil {
		return err
	}
	raw, err := acceptContext(runContext, localListener)
	if err != nil {
		return err
	}
	controlConnection := tls.Server(raw, serverTLSConfig(id, peerKey))
	defer controlConnection.Close()
	control, err := rendezvous.NewTLSControl(runContext, controlConnection)
	if err != nil {
		return err
	}
	outcome, err := rendezvous.Server(runContext, control, direct, control.PeerPublicKey)
	if err != nil {
		return err
	}
	if outcome.Connection != nil {
		defer outcome.Connection.Close()
	}
	return events.write(map[string]any{
		"event": "rendezvous_measurement", "measurement": outcome.Measurement,
		"probe": direct.Probe(), "role": "server",
	})
}

func rendezvousDialer(ctx context.Context, torPath, state, socks string, verbose bool) (
	contextDialer, *torRuntime, time.Duration, time.Duration, error,
) {
	if torPath == "" {
		socksDialer, err := proxy.SOCKS5("tcp", socks, nil, &net.Dialer{Timeout: 2 * time.Minute})
		if err != nil {
			return nil, nil, 0, 0, fmt.Errorf("create SOCKS dialer: %w", err)
		}
		return proxyContextDialer{dialer: socksDialer}, nil, 0, 0, nil
	}
	bundleRoot, err := torBundleRoot(torPath)
	if err != nil {
		return nil, nil, 0, 0, err
	}
	files, err := makeTorFiles(state, bundleRoot, "client")
	if err != nil {
		return nil, nil, 0, 0, err
	}
	runtime, controlReady, err := launchTor(torPath, files, false, verbose)
	if err != nil {
		return nil, nil, 0, 0, err
	}
	started := time.Now()
	dialer, err := runtime.instance.Dialer(ctx, nil)
	if err != nil {
		_ = runtime.close()
		return nil, nil, 0, 0, fmt.Errorf("bootstrap client Tor: %w", err)
	}
	return dialer, runtime, controlReady, time.Since(started), nil
}

func directClientTLSConfig(id *identity, peerKey ed25519.PublicKey) *tls.Config {
	config := clientTLSConfig(id, peerKey)
	config.NextProtos = []string{rendezvousDirectALPN}
	config.ServerName = "cialai-rendezvous-direct"
	config.VerifyConnection = pinnedVerifierForALPN(peerKey, rendezvousDirectALPN, time.Now)
	return config
}

func directServerTLSConfig(id *identity, peerKey ed25519.PublicKey) *tls.Config {
	config := serverTLSConfig(id, peerKey)
	config.NextProtos = []string{rendezvousDirectALPN}
	config.VerifyConnection = pinnedVerifierForALPN(peerKey, rendezvousDirectALPN, time.Now)
	return config
}

func acceptContext(ctx context.Context, listener net.Listener) (net.Conn, error) {
	type result struct {
		connection net.Conn
		err        error
	}
	results := make(chan result, 1)
	go func() {
		connection, err := listener.Accept()
		results <- result{connection: connection, err: err}
	}()
	select {
	case <-ctx.Done():
		_ = listener.Close()
		return nil, ctx.Err()
	case result := <-results:
		if result.err != nil {
			return nil, fmt.Errorf("accept onion rendezvous: %w", result.err)
		}
		return result.connection, nil
	}
}
