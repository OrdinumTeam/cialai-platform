// SPDX-License-Identifier: Apache-2.0
package direct

import (
	"bytes"
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

func TestOpeningPacketsAreNonQUICAndSymmetric(t *testing.T) {
	nonce := [16]byte{1, 2, 3}
	request := openingPacket(openingRequest, nonce)
	answer := openingPacket(openingAnswer, nonce)
	if len(request) != openingPacketSize || len(answer) != len(request) {
		t.Fatalf("opening packets must share one size: %d and %d", len(request), len(answer))
	}
	if request[0]&0xc0 != 0 {
		t.Fatal("opening packet would be read as QUIC")
	}
	if kind, parsed, ok := parseOpening(request); !ok || kind != openingRequest || parsed != nonce {
		t.Fatal("request did not round trip")
	}
	for _, invalid := range [][]byte{request[:24], append(bytes.Clone(request), 0), append([]byte{0x40}, request[1:]...)} {
		if _, _, ok := parseOpening(invalid); ok {
			t.Fatalf("invalid opening packet accepted: %x", invalid)
		}
	}
	bad := bytes.Clone(request)
	bad[openingMagicLength] = 0x7f
	if _, _, ok := parseOpening(bad); ok {
		t.Fatal("unknown opening kind accepted")
	}
}

func TestPunchAndDialCandidatesShareTheListenerSocket(t *testing.T) {
	h := newHarness(t, ListenConfig{})
	phone := mustIdentity(t, identity.RolePhone)
	h.registry.register(phone)
	client := newTestEndpoint(t, phone)

	unreachable := closedUDPAddr(t)
	serverAddr := addrPort(t, h.listener.Addr())
	ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
	defer cancel()

	var puncher transport.Puncher = client
	report, err := puncher.Punch(ctx, []netip.AddrPort{unreachable, serverAddr, serverAddr, {}})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Acknowledged) != 1 || report.Acknowledged[0] != serverAddr || report.Sent < 2 {
		t.Fatalf("unexpected punch report %+v", report)
	}
	back, err := h.server.Punch(ctx, []netip.AddrPort{addrPort(t, client.LocalAddr())})
	if err != nil || len(back.Acknowledged) != 1 {
		t.Fatalf("desktop punch towards the phone: %+v %v", back, err)
	}
	if _, err := client.Punch(ctx, nil); !errors.Is(err, transport.ErrNoCandidates) {
		t.Fatalf("empty punch: %v", err)
	}

	session, err := puncher.DialCandidates(ctx, []netip.AddrPort{unreachable, serverAddr}, h.desktop.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	serveEcho(h.accept(t))
	if err := echoPayload(openStream(t, session), 1024); err != nil {
		t.Fatal(err)
	}
	if _, err := client.DialCandidates(ctx, nil, h.desktop.PublicKey()); !errors.Is(err, transport.ErrNoCandidates) {
		t.Fatalf("empty dial: %v", err)
	}
}

func TestOtherNonQUICPacketsReachTheHandler(t *testing.T) {
	desktop := newTestEndpoint(t, mustIdentity(t, identity.RoleDesktop))
	phone := newTestEndpoint(t, mustIdentity(t, identity.RolePhone))
	received := make(chan []byte, 1)
	phone.HandlePackets(func(packet []byte, from net.Addr) {
		if from.String() == desktop.LocalAddr().String() {
			received <- bytes.Clone(packet)
		}
	})
	probe := []byte{0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42}
	deadline := time.After(testTimeout)
	for {
		if _, err := desktop.WriteTo(probe, phone.LocalAddr()); err != nil {
			t.Fatal(err)
		}
		select {
		case packet := <-received:
			if !bytes.Equal(packet, probe) {
				t.Fatalf("handler got %x", packet)
			}
			return
		case <-time.After(50 * time.Millisecond):
		case <-deadline:
			t.Fatal("packet handler was not called")
		}
	}
}

func addrPort(t *testing.T, address net.Addr) netip.AddrPort {
	t.Helper()
	parsed, err := netip.ParseAddrPort(address.String())
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

func closedUDPAddr(t *testing.T) netip.AddrPort {
	t.Helper()
	packetConn := listenUDP(t)
	address := addrPort(t, packetConn.LocalAddr())
	_ = packetConn.Close()
	return address
}
