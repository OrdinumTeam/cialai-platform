// SPDX-License-Identifier: Apache-2.0
package brotoclient

import (
	"context"
	"crypto/rand"
	"net"
	"net/netip"
	"os"
	"slices"
	"sync"
	"testing"
	"time"

	"golang.org/x/net/dns/dnsmessage"
	"golang.org/x/net/ipv4"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/mdns"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
)

// liveMDNSEnv opts in to TestBrotoQRFindsTheMarkerOnTheLAN, which sends mDNS
// on the network interfaces of this machine.
const liveMDNSEnv = "CIALAI_MDNS_LIVE"

// TestBrotoQRFindsTheMarkerOnTheLAN announces the marker of a QR the way the
// sidecar does, on every usable interface, and finds it with the Broto's
// lookup over real multicast, at the Broto's pace. Closing the announcer must
// send the goodbye that withdraws it.
func TestBrotoQRFindsTheMarkerOnTheLAN(t *testing.T) {
	if os.Getenv(liveMDNSEnv) != "1" {
		t.Skip(liveMDNSEnv + "=1 is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	secret := make([]byte, pairing.QRSecretSize)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	keys, err := pairing.DeriveQR(secret)
	if err != nil {
		t.Fatal(err)
	}
	// The marker carries the port of the host's direct QUIC listener.
	listener, err := net.ListenUDP("udp", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := uint16(listener.LocalAddr().(*net.UDPAddr).Port)
	goodbyes := captureGoodbyes(t)

	// As announceLocal in cmd/cialai-tunnel, which the sidecar starts for
	// each QR: every interface except loopback.
	announcer, err := mdns.Start(mdns.Config{PublicKey: keys.MarkerKey(), Port: port, Logf: t.Logf})
	if err != nil {
		t.Fatalf("start the marker: %v", err)
	}
	t.Cleanup(func() { _ = announcer.Close() })
	instance := announcer.Instance() + "." + mdns.ServiceType + ".local."

	timing := defaultQRTiming
	var addresses []netip.AddrPort
	for lookup := 1; lookup <= 3 && len(addresses) == 0; lookup++ {
		started := time.Now()
		addresses = lookupMarker(ctx, keys.MarkerKey(), timing.lookupWindow)
		t.Logf("lookup %d took %s: %v", lookup, time.Since(started).Round(time.Millisecond), addresses)
		if len(addresses) == 0 {
			time.Sleep(time.Until(started.Add(timing.lookupEvery)))
		}
	}
	if len(addresses) == 0 {
		// lookupMarker drops errors; Browse reports them.
		found, err := mdns.Browse(ctx, timing.lookupWindow)
		t.Fatalf("the Broto's lookup never found the marker; Browse returns %+v, %v", found, err)
	}
	if !slices.ContainsFunc(addresses, func(address netip.AddrPort) bool { return address.Port() == port }) {
		t.Fatalf("the marker announces %v, want port %d", addresses, port)
	}

	closing := time.Now()
	if err := announcer.Close(); err != nil {
		t.Fatalf("close the marker: %v", err)
	}
	for len(goodbyes.from(instance)) == 0 {
		if time.Since(closing) > 5*time.Second {
			t.Fatalf("no goodbye for %s within 5s of Close", instance)
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Logf("goodbye from %v within %s of Close", goodbyes.from(instance), time.Since(closing).Round(time.Millisecond))
	if after := lookupMarker(ctx, keys.MarkerKey(), timing.lookupWindow); len(after) != 0 {
		t.Fatalf("the lookup still finds the closed marker at %v", after)
	}
}

// goodbyeCapture records, by instance, the senders of the mDNS goodbyes that
// reach this machine: responses whose PTR records have TTL 0.
type goodbyeCapture struct {
	mu       sync.Mutex
	goodbyes map[string][]string
}

func captureGoodbyes(t *testing.T) *goodbyeCapture {
	t.Helper()
	group := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	conn, err := net.ListenUDP("udp4", group)
	if err != nil {
		t.Fatalf("listen on the mDNS port: %v", err)
	}
	packets := ipv4.NewPacketConn(conn)
	interfaces, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	var joined []string
	for _, iface := range interfaces {
		usable := iface.Flags&net.FlagUp != 0 && iface.Flags&net.FlagMulticast != 0 && iface.Flags&net.FlagLoopback == 0
		if usable && packets.JoinGroup(&iface, group) == nil {
			joined = append(joined, iface.Name)
		}
	}
	if len(joined) == 0 {
		_ = conn.Close()
		t.Fatal("no interface joined the mDNS group")
	}
	t.Logf("capturing mDNS goodbyes on %v", joined)
	capture := &goodbyeCapture{goodbyes: map[string][]string{}}
	done := make(chan struct{})
	go func() {
		defer close(done)
		buffer := make([]byte, 9000)
		for {
			n, sender, err := conn.ReadFrom(buffer)
			if err != nil {
				return
			}
			var message dnsmessage.Message
			if message.Unpack(buffer[:n]) != nil || !message.Header.Response {
				continue
			}
			for _, answer := range message.Answers {
				if pointer, ok := answer.Body.(*dnsmessage.PTRResource); ok && answer.Header.TTL == 0 {
					capture.mu.Lock()
					capture.goodbyes[pointer.PTR.String()] = append(capture.goodbyes[pointer.PTR.String()], sender.String())
					capture.mu.Unlock()
				}
			}
		}
	}()
	t.Cleanup(func() {
		_ = conn.Close()
		<-done
	})
	return capture
}

func (capture *goodbyeCapture) from(instance string) []string {
	capture.mu.Lock()
	defer capture.mu.Unlock()
	return slices.Clone(capture.goodbyes[instance])
}
