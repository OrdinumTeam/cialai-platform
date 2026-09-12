// SPDX-License-Identifier: Apache-2.0

// Package mobileprobe is the phase 0 gomobile experiment, not the product API.
// Call blocking methods from a native background queue. Obtain real device RSS,
// package-size deltas and network-transition timings from the native test host.
package mobileprobe

import (
	"context"
	"errors"
	"io"
	"net"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"

	"tailscale.com/tsnet"
)

// Node owns exactly one experimental tsnet instance. Native code must call Close
// before opening the same state directory again. Credentials are never returned.
type Node struct {
	server          *tsnet.Server
	connectedMillis int64
	closeOnce       sync.Once
	closeErr        error
}

// Version identifies the experiment independently from the future product API.
func Version() string { return "cialai-spike-1/tsnet-1.102.0" }

// Open joins a test Headscale using a preauth key supplied directly by native
// code. It accepts HTTP only on loopback; real phones should use HTTPS + DERP.
// Reuse stateDir across cold launches to test persisted node identity.
func Open(stateDir, controlURL, authKey, hostname string) (*Node, error) {
	u, err := url.Parse(controlURL)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return nil, errors.New("invalid control URL")
	}
	ip := net.ParseIP(u.Hostname())
	if u.Scheme != "https" && !(u.Scheme == "http" && ip != nil && ip.IsLoopback()) {
		return nil, errors.New("control URL must use HTTPS outside loopback")
	}
	if !filepath.IsAbs(stateDir) || hostname == "" {
		return nil, errors.New("absolute state directory and hostname required")
	}
	if err := os.MkdirAll(stateDir, 0700); err != nil {
		return nil, errors.New("cannot create node state directory")
	}
	s := &tsnet.Server{Dir: stateDir, ControlURL: controlURL, AuthKey: authKey, Hostname: hostname,
		Logf: func(string, ...any) {}, UserLogf: func(string, ...any) {}}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	started := time.Now()
	if _, err := s.Up(ctx); err != nil {
		_ = s.Close()
		return nil, errors.New("tsnet enrollment failed; check test server and preauth key")
	}
	return &Node{server: s, connectedMillis: time.Since(started).Milliseconds()}, nil
}

// ConnectedMillis is the measured duration of Up, not a claim about UI readiness.
func (n *Node) ConnectedMillis() int64 {
	if n == nil {
		return 0
	}
	return n.connectedMillis
}

// EchoMillis dials an explicit tailnet IPv4/IPv6 address and checks a fixed echo.
// The test desktop must expose a TCP echo listener on port 4740 inside tsnet.
func (n *Node) EchoMillis(tailnetIP string) (int64, error) {
	if n == nil || n.server == nil {
		return 0, errors.New("node not initialized")
	}
	ip, err := netip.ParseAddr(tailnetIP)
	if err != nil || !(netip.MustParsePrefix("100.64.0.0/10").Contains(ip) || netip.MustParsePrefix("fd7a:115c:a1e0::/48").Contains(ip)) {
		return 0, errors.New("tailnet IP required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	started := time.Now()
	// Up can complete before the first peer map arrives. Wait within the same
	// ten-second budget so a missing route is not mistaken for a dial failure.
	lc, err := n.server.LocalClient()
	if err != nil {
		return 0, errors.New("node local client unavailable")
	}
	for {
		status, err := lc.Status(ctx)
		if err != nil {
			return 0, errors.New("node status unavailable")
		}
		found := false
		for _, peer := range status.Peer {
			for _, addr := range peer.TailscaleIPs {
				if addr == ip {
					found = true
				}
			}
		}
		if found {
			break
		}
		select {
		case <-ctx.Done():
			return 0, errors.New("desktop peer did not appear within ten seconds")
		case <-time.After(50 * time.Millisecond):
		}
	}
	conn, err := n.server.Dial(ctx, "tcp", net.JoinHostPort(ip.String(), "4740"))
	if err != nil {
		return 0, errors.New("tailnet dial failed")
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	_ = conn.SetDeadline(deadline)
	message := "cialai-mobile-spike"
	if _, err := io.WriteString(conn, message); err != nil {
		return 0, errors.New("echo write failed")
	}
	buf := make([]byte, len(message))
	if _, err := io.ReadFull(conn, buf); err != nil {
		return 0, errors.New("echo read failed")
	}
	if string(buf) != message {
		return 0, errors.New("echo mismatch")
	}
	return time.Since(started).Milliseconds(), nil
}

// Close releases the node. It is safe to call again after a lifecycle transition.
func (n *Node) Close() error {
	if n == nil || n.server == nil {
		return nil
	}
	n.closeOnce.Do(func() { n.closeErr = n.server.Close() })
	return n.closeErr
}
