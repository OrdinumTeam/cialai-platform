// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"crypto/tls"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"time"

	"github.com/quic-go/quic-go"
)

type dialResult struct {
	conn      *quic.Conn
	candidate candidate
	duration  time.Duration
	err       error
}

type latencyStats struct {
	Count    int     `json:"count"`
	MinMS    float64 `json:"minMillis"`
	MedianMS float64 `json:"medianMillis"`
	P95MS    float64 `json:"p95Millis"`
	MaxMS    float64 `json:"maxMillis"`
	MeanMS   float64 `json:"meanMillis"`
}

func runClient(ctx context.Context, args []string) error {
	flags := flag.NewFlagSet("client", flag.ContinueOnError)
	offerPath := flags.String("offer", "", "server offer JSON path")
	identityPath := flags.String("identity", "build/spikes/directpath/client.key", "persistent Ed25519 private key")
	listenAddress := flags.String("listen", ":0", "local UDP address")
	clientOfferPath := flags.String("write-offer", "", "optional client offer path for server-side punching")
	networkTimeout := flags.Duration("network-timeout", 6*time.Second, "candidate and port-mapping collection budget")
	connectAfter := flags.Duration("connect-after", 0, "delay after writing the client offer for manual transfer")
	dialTimeout := flags.Duration("dial-timeout", 10*time.Second, "total QUIC dialing budget")
	count := flags.Int("count", 10, "number of echo RTT samples")
	payloadBytes := flags.Int("payload-bytes", 32, "bytes per echo sample")
	includeLoopback := flags.Bool("include-loopback", false, "include loopback in a written client offer")
	var stunServers stringList
	flags.Var(&stunServers, "stun", "STUN server; repeat to try more than one")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *offerPath == "" {
		return errors.New("--offer is required")
	}
	if *count < 1 || *count > 1000 || *payloadBytes < 8 || *payloadBytes > 1024*1024 {
		return errors.New("count must be 1..1000 and payload-bytes must be 8..1048576")
	}
	serverOffer, err := readOffer(*offerPath)
	if err != nil {
		return err
	}
	if serverOffer.Role != "server" {
		return errors.New("--offer must point to a server offer")
	}
	serverKey, err := parsePublicKey(serverOffer.PublicKey)
	if err != nil {
		return err
	}
	id, _, err := loadOrCreateIdentity(*identityPath)
	if err != nil {
		return err
	}
	packetConn, err := net.ListenPacket("udp", *listenAddress)
	if err != nil {
		return fmt.Errorf("listen client UDP: %w", err)
	}
	defer packetConn.Close()
	transport := &quic.Transport{Conn: packetConn}
	defer transport.Close()
	mux := newPacketMux(transport, true)
	go mux.run(ctx)

	if *clientOfferPath != "" {
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
			return errors.New("no usable client candidate found")
		}
		value := offer{
			Version: offerVersion, Role: "client",
			PublicKey: encodePublicKey(id.public), Fingerprint: fingerprint(id.public),
			Candidates: candidates, Probe: probe, CreatedAt: time.Now().UTC(),
		}
		if err := writeOffer(*clientOfferPath, value); err != nil {
			return err
		}
		if err := writeJSON(os.Stdout, map[string]any{
			"event": "client_offer_ready", "offer": *clientOfferPath,
			"fingerprint": value.Fingerprint, "candidates": candidates, "probe": probe,
		}); err != nil {
			return err
		}
	}

	punchCtx, cancelPunch := context.WithTimeout(ctx, 3*time.Second)
	sent, acknowledged := punchCandidates(punchCtx, mux, serverOffer.Candidates)
	cancelPunch()
	_ = writeJSON(os.Stdout, map[string]any{
		"event": "client_punch", "sent": sent, "acknowledged": acknowledged,
	})
	if *connectAfter > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(*connectAfter):
		}
	}

	dialCtx, cancelDial := context.WithTimeout(ctx, *dialTimeout)
	conn, selected, handshake, err := dialCandidates(dialCtx, transport, clientTLSConfig(id, serverKey), serverOffer.Candidates)
	cancelDial()
	if err != nil {
		return err
	}
	defer conn.CloseWithError(0, "measurement complete")
	latencies, err := measureEcho(ctx, conn, *count, *payloadBytes)
	if err != nil {
		return err
	}
	return writeJSON(os.Stdout, map[string]any{
		"event": "measurement", "candidate": selected,
		"handshakeMillis": float64(handshake.Microseconds()) / 1000,
		"rtt":             summarizeLatencies(latencies),
		"localAddress":    conn.LocalAddr().String(), "remoteAddress": conn.RemoteAddr().String(),
		"serverFingerprint": serverOffer.Fingerprint, "clientFingerprint": fingerprint(id.public),
		"quicVersion": conn.ConnectionState().Version.String(),
	})
}

func dialCandidates(ctx context.Context, transport *quic.Transport, tlsConfig *tls.Config, candidates []candidate) (*quic.Conn, candidate, time.Duration, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	results := make(chan dialResult, len(candidates))
	for _, item := range candidates {
		item := item
		go func() {
			remote, err := net.ResolveUDPAddr("udp", item.Address)
			if err != nil {
				results <- dialResult{candidate: item, err: err}
				return
			}
			started := time.Now()
			conn, err := transport.Dial(ctx, remote, tlsConfig.Clone(), quicConfig())
			results <- dialResult{conn: conn, candidate: item, duration: time.Since(started), err: err}
		}()
	}
	var failures []error
	for range candidates {
		result := <-results
		if result.err == nil {
			cancel()
			return result.conn, result.candidate, result.duration, nil
		}
		failures = append(failures, fmt.Errorf("%s %s: %w", result.candidate.Type, result.candidate.Address, result.err))
	}
	return nil, candidate{}, 0, errors.Join(failures...)
}

func measureEcho(ctx context.Context, conn *quic.Conn, count, payloadSize int) ([]time.Duration, error) {
	stream, err := conn.OpenStreamSync(ctx)
	if err != nil {
		return nil, fmt.Errorf("open echo stream: %w", err)
	}
	defer stream.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = stream.SetDeadline(deadline)
	} else {
		_ = stream.SetDeadline(time.Now().Add(30 * time.Second))
	}
	payload := make([]byte, payloadSize)
	received := make([]byte, payloadSize)
	latencies := make([]time.Duration, 0, count)
	for index := range count {
		for offset := range payload {
			payload[offset] = byte(index + offset)
		}
		started := time.Now()
		if _, err := stream.Write(payload); err != nil {
			return nil, fmt.Errorf("write echo sample %d: %w", index, err)
		}
		if _, err := io.ReadFull(stream, received); err != nil {
			return nil, fmt.Errorf("read echo sample %d: %w", index, err)
		}
		if string(received) != string(payload) {
			return nil, fmt.Errorf("echo sample %d differs", index)
		}
		latencies = append(latencies, time.Since(started))
	}
	return latencies, nil
}

func summarizeLatencies(values []time.Duration) latencyStats {
	sorted := append([]time.Duration(nil), values...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i] < sorted[j] })
	if len(sorted) == 0 {
		return latencyStats{}
	}
	var total time.Duration
	for _, value := range sorted {
		total += value
	}
	toMS := func(value time.Duration) float64 { return float64(value.Microseconds()) / 1000 }
	p95Index := (95*len(sorted)+99)/100 - 1
	return latencyStats{
		Count: len(sorted), MinMS: toMS(sorted[0]), MedianMS: toMS(sorted[len(sorted)/2]),
		P95MS: toMS(sorted[p95Index]), MaxMS: toMS(sorted[len(sorted)-1]),
		MeanMS: toMS(total / time.Duration(len(sorted))),
	}
}
