// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/ed25519"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"

	"github.com/quic-go/quic-go"
)

func runServer(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("server", flag.ContinueOnError)
	listenAddress := flags.String("listen", ":4740", "UDP listen address")
	identityPath := flags.String("identity", "build/spikes/directpath/server.key", "persistent Ed25519 private key")
	peerKeyText := flags.String("peer-key", "", "allowed client Ed25519 public key in base64url")
	offerPath := flags.String("offer", "build/spikes/directpath/server-offer.json", "server offer output path")
	peerOfferPath := flags.String("peer-offer", "", "optional client offer file to watch for hole punching")
	networkTimeout := flags.Duration("network-timeout", 6*time.Second, "candidate and port-mapping collection budget")
	maxConnections := flags.Int("max-connections", 0, "exit after this many accepted connections; zero waits forever")
	includeLoopback := flags.Bool("include-loopback", false, "include loopback as a LAN candidate for local tests")
	var stunServers stringList
	flags.Var(&stunServers, "stun", "STUN server; repeat to try more than one")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *peerKeyText == "" {
		return errors.New("--peer-key is required; run keygen on the client first")
	}
	peerKey, err := parsePublicKey(*peerKeyText)
	if err != nil {
		return err
	}
	id, _, err := loadOrCreateIdentity(*identityPath)
	if err != nil {
		return err
	}
	packetConn, err := net.ListenPacket("udp", *listenAddress)
	if err != nil {
		return fmt.Errorf("listen UDP: %w", err)
	}
	defer packetConn.Close()
	transport := &quic.Transport{Conn: packetConn}
	defer transport.Close()
	mux := newPacketMux(transport, true)
	go mux.run(ctx)
	listener, err := transport.Listen(serverTLSConfig(id, peerKey), quicConfig())
	if err != nil {
		return fmt.Errorf("listen QUIC: %w", err)
	}
	defer listener.Close()

	port, err := udpPort(packetConn.LocalAddr())
	if err != nil {
		return err
	}
	candidates, err := localCandidates(int(port), *includeLoopback)
	if err != nil {
		return err
	}
	networkCtx, cancelNetwork := context.WithTimeout(ctx, *networkTimeout)
	probe, mapping := collectNetwork(networkCtx, mux, port, stunServers)
	cancelNetwork()
	defer mapping.close()
	for _, item := range candidatesFromProbe(probe) {
		candidates = appendCandidate(candidates, item)
	}
	if len(candidates) == 0 {
		return errors.New("no usable candidate found; use --include-loopback only for a same-machine test")
	}
	value := offer{
		Version: offerVersion, Role: "server",
		PublicKey: encodePublicKey(id.public), Fingerprint: fingerprint(id.public),
		Candidates: candidates, Probe: probe, CreatedAt: time.Now().UTC(),
	}
	if err := writeOffer(*offerPath, value); err != nil {
		return err
	}
	if err := writeJSON(os.Stdout, map[string]any{
		"event": "server_ready", "listen": packetConn.LocalAddr().String(),
		"offer": *offerPath, "fingerprint": value.Fingerprint,
		"peerFingerprint": fingerprint(peerKey), "candidates": candidates, "probe": probe,
	}); err != nil {
		return err
	}

	if *peerOfferPath != "" {
		go watchPeerOffer(ctx, mux, *peerOfferPath, peerKey)
	}
	return acceptEchoConnections(ctx, listener, *maxConnections)
}

func watchPeerOffer(ctx context.Context, mux *packetMux, path string, expected ed25519.PublicKey) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		value, err := readOffer(path)
		if err == nil && value.Role == "client" {
			key, keyErr := parsePublicKey(value.PublicKey)
			if keyErr == nil && key.Equal(expected) {
				for range 3 {
					attemptCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
					sent, acknowledged := punchCandidates(attemptCtx, mux, value.Candidates)
					cancel()
					_ = writeJSON(os.Stdout, map[string]any{
						"event": "server_punch", "sent": sent, "acknowledged": acknowledged,
					})
					if acknowledged > 0 {
						return
					}
					select {
					case <-ctx.Done():
						return
					case <-time.After(250 * time.Millisecond):
					}
				}
				return
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func acceptEchoConnections(ctx context.Context, listener *quic.Listener, maximum int) error {
	var handlers sync.WaitGroup
	accepted := 0
	for maximum == 0 || accepted < maximum {
		conn, err := listener.Accept(ctx)
		if err != nil {
			if isExpectedNetworkStop(err) {
				break
			}
			return fmt.Errorf("accept QUIC connection: %w", err)
		}
		accepted++
		_ = writeJSON(os.Stdout, map[string]any{
			"event": "accepted", "remote": conn.RemoteAddr().String(),
			"tls": conn.ConnectionState().TLS.Version,
		})
		handlers.Add(1)
		go func(conn *quic.Conn) {
			defer handlers.Done()
			defer conn.CloseWithError(0, "echo complete")
			stream, err := conn.AcceptStream(ctx)
			if err != nil {
				return
			}
			defer stream.Close()
			_, _ = io.Copy(stream, stream)
		}(conn)
	}
	if maximum > 0 {
		_ = listener.Close()
		handlers.Wait()
	}
	return nil
}
