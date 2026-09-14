// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"net"
	"os"
	"os/signal"
	"time"

	"golang.org/x/net/proxy"
)

type contextDialer interface {
	DialContext(context.Context, string, string) (net.Conn, error)
}

type proxyContextDialer struct {
	dialer proxy.Dialer
}

func (dialer proxyContextDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if contextual, ok := dialer.dialer.(proxy.ContextDialer); ok {
		return contextual.DialContext(ctx, network, address)
	}
	type result struct {
		connection net.Conn
		err        error
	}
	resultChannel := make(chan result, 1)
	go func() {
		connection, err := dialer.dialer.Dial(network, address)
		if ctx.Err() != nil {
			if connection != nil {
				_ = connection.Close()
			}
			return
		}
		select {
		case resultChannel <- result{connection: connection, err: err}:
		case <-ctx.Done():
			if connection != nil {
				_ = connection.Close()
			}
		}
	}()
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-resultChannel:
		return result.connection, result.err
	}
}

func runClient(args []string) (returnErr error) {
	flags := flag.NewFlagSet("client", flag.ContinueOnError)
	torPath := flags.String("tor", "", "path to a Tor Expert Bundle executable")
	state := flags.String("state", "", "persistent client Tor state directory")
	socks := flags.String("socks", "", "external Tor SOCKS5 address instead of --tor")
	onion := flags.String("onion", "", "onion service host:port")
	identityPath := flags.String("identity", "", "path to this peer's TLS identity")
	peerKeyText := flags.String("peer-key", "", "pinned server TLS Ed25519 public key")
	connections := flags.Int("connections", 10, "number of fresh TLS connections")
	echoes := flags.Int("echoes", 1, "echoes per connection")
	label := flags.String("label", "unlabeled", "measurement label such as cold or warm")
	timeout := flags.Duration("timeout", 10*time.Minute, "whole run timeout")
	verboseTor := flags.Bool("verbose-tor", false, "show Tor and bine diagnostic logs")
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
	if err := requirePositive("--connections", *connections); err != nil {
		return err
	}
	if err := requirePositive("--echoes", *echoes); err != nil {
		return err
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
	var dialer contextDialer
	var runtime *torRuntime
	bootstrapDuration := time.Duration(0)
	controlReady := time.Duration(0)
	if *torPath != "" {
		bundleRoot, err := torBundleRoot(*torPath)
		if err != nil {
			return err
		}
		files, err := makeTorFiles(*state, bundleRoot, "client")
		if err != nil {
			return err
		}
		runtime, controlReady, err = launchTor(*torPath, files, false, *verboseTor)
		if err != nil {
			return err
		}
		defer func() {
			if err := runtime.close(); err != nil {
				returnErr = errors.Join(returnErr, err)
			}
			_ = writeJSON(os.Stdout, map[string]any{"event": "tor_stopped", "pid": runtime.pid()})
		}()
		bootstrapStarted := time.Now()
		torDialer, err := runtime.instance.Dialer(runContext, nil)
		if err != nil {
			return fmt.Errorf("bootstrap client Tor: %w", err)
		}
		bootstrapDuration = time.Since(bootstrapStarted)
		dialer = torDialer
		if err := writeJSON(os.Stdout, map[string]any{
			"bootstrapMs":    durationMS(bootstrapDuration),
			"controlReadyMs": durationMS(controlReady),
			"event":          "client_tor_ready",
			"pid":            runtime.pid(),
		}); err != nil {
			return err
		}
	} else {
		socksDialer, err := proxy.SOCKS5("tcp", *socks, nil, &net.Dialer{Timeout: 2 * time.Minute})
		if err != nil {
			return fmt.Errorf("create SOCKS dialer: %w", err)
		}
		dialer = proxyContextDialer{dialer: socksDialer}
	}

	if err := writeJSON(os.Stdout, map[string]any{
		"connections":     *connections,
		"echoes":          *echoes,
		"event":           "client_starting",
		"identityCreated": identityCreated,
		"label":           *label,
		"publicKey":       encodePublicKey(id.public),
	}); err != nil {
		return err
	}
	connectSamples := make([]time.Duration, 0, *connections)
	handshakeSamples := make([]time.Duration, 0, *connections)
	echoSamples := make([]time.Duration, 0, *connections**echoes)
	for connectionIndex := 1; connectionIndex <= *connections; connectionIndex++ {
		connectionContext, cancelConnection := context.WithTimeout(runContext, 2*time.Minute)
		dialStarted := time.Now()
		raw, err := dialer.DialContext(connectionContext, "tcp", *onion)
		connectDuration := time.Since(dialStarted)
		if err != nil {
			cancelConnection()
			return fmt.Errorf("connection %d SOCKS dial: %w", connectionIndex, err)
		}
		connection := tls.Client(raw, clientTLSConfig(id, peerKey))
		if deadline, ok := connectionContext.Deadline(); ok {
			_ = connection.SetDeadline(deadline)
		}
		handshakeStarted := time.Now()
		if err := connection.HandshakeContext(connectionContext); err != nil {
			_ = raw.Close()
			cancelConnection()
			return fmt.Errorf("connection %d TLS handshake: %w", connectionIndex, err)
		}
		handshakeDuration := time.Since(handshakeStarted)
		connectionEchoes := make([]time.Duration, 0, *echoes)
		for echoIndex := 1; echoIndex <= *echoes; echoIndex++ {
			duration, err := echoRoundTrip(connection, echoIndex)
			if err != nil {
				_ = connection.Close()
				cancelConnection()
				return fmt.Errorf("connection %d echo %d: %w", connectionIndex, echoIndex, err)
			}
			connectionEchoes = append(connectionEchoes, duration)
			echoSamples = append(echoSamples, duration)
		}
		_ = connection.Close()
		cancelConnection()
		connectSamples = append(connectSamples, connectDuration)
		handshakeSamples = append(handshakeSamples, handshakeDuration)
		echoMedian, echoP95 := percentiles(connectionEchoes)
		if err := writeJSON(os.Stdout, map[string]any{
			"connection":     connectionIndex,
			"echoMedianMs":   durationMS(echoMedian),
			"echoP95Ms":      durationMS(echoP95),
			"event":          "connection",
			"socksDialMs":    durationMS(connectDuration),
			"tlsHandshakeMs": durationMS(handshakeDuration),
		}); err != nil {
			return err
		}
	}
	connectMedian, connectP95 := percentiles(connectSamples)
	handshakeMedian, handshakeP95 := percentiles(handshakeSamples)
	echoMedian, echoP95 := percentiles(echoSamples)
	return writeJSON(os.Stdout, map[string]any{
		"bootstrapMs":          durationMS(bootstrapDuration),
		"connections":          *connections,
		"controlReadyMs":       durationMS(controlReady),
		"echoMedianMs":         durationMS(echoMedian),
		"echoP95Ms":            durationMS(echoP95),
		"event":                "summary",
		"label":                *label,
		"socksDialMedianMs":    durationMS(connectMedian),
		"socksDialP95Ms":       durationMS(connectP95),
		"tlsHandshakeMedianMs": durationMS(handshakeMedian),
		"tlsHandshakeP95Ms":    durationMS(handshakeP95),
	})
}
