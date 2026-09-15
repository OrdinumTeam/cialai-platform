// SPDX-License-Identifier: Apache-2.0
package mdns

import (
	"bytes"
	"cmp"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	pion "github.com/pion/mdns/v2"
	"golang.org/x/net/dns/dnsmessage"
	"golang.org/x/net/ipv4"
)

const browseTime = 1500 * time.Millisecond

func loopbackInterface(t *testing.T) net.Interface {
	t.Helper()
	interfaces, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	for _, iface := range interfaces {
		if iface.Flags&net.FlagLoopback != 0 && iface.Flags&net.FlagUp != 0 {
			return iface
		}
	}
	t.Skip("no loopback interface")
	return net.Interface{}
}

func only(iface net.Interface) func() ([]net.Interface, error) {
	return func() ([]net.Interface, error) { return []net.Interface{iface}, nil }
}

// requireLoopbackMulticast returns the loopback interface after checking that
// this environment binds the mDNS port and delivers multicast over loopback;
// the network tests are skipped otherwise.
func requireLoopbackMulticast(t *testing.T) net.Interface {
	t.Helper()
	iface := loopbackInterface(t)
	conn, err := net.ListenUDP("udp4", groupIPv4)
	if err != nil {
		t.Skipf("mDNS port unavailable: %v", err)
	}
	defer conn.Close()
	receiver := ipv4.NewPacketConn(conn)
	if err := receiver.JoinGroup(&iface, groupIPv4); err != nil {
		t.Skipf("cannot join the mDNS group on %s: %v", iface.Name, err)
	}
	senderConn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer senderConn.Close()
	sender := ipv4.NewPacketConn(senderConn)
	marker := make([]byte, 16)
	_, _ = rand.Read(marker)
	if err := sender.SetMulticastInterface(&iface); err != nil {
		t.Skipf("cannot send multicast on %s: %v", iface.Name, err)
	}
	_ = sender.SetMulticastLoopback(true)
	if _, err := sender.WriteTo(marker, nil, groupIPv4); err != nil {
		t.Skipf("cannot send multicast on %s: %v", iface.Name, err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	buffer := make([]byte, 9000)
	for {
		n, _, err := conn.ReadFrom(buffer)
		if err != nil {
			t.Skipf("multicast over %s is not delivered: %v", iface.Name, err)
		}
		if bytes.Equal(buffer[:n], marker) {
			return iface
		}
	}
}

// captureResponses records the multicast mDNS responses on iface.
type capturedResponses struct {
	mu        sync.Mutex
	responses []dnsmessage.Message
}

func captureResponses(t *testing.T, iface net.Interface) *capturedResponses {
	t.Helper()
	conn, err := net.ListenUDP("udp4", groupIPv4)
	if err != nil {
		t.Fatal(err)
	}
	if err := ipv4.NewPacketConn(conn).JoinGroup(&iface, groupIPv4); err != nil {
		t.Fatal(err)
	}
	captured := &capturedResponses{}
	done := make(chan struct{})
	go func() {
		defer close(done)
		buffer := make([]byte, 9000)
		for {
			n, _, err := conn.ReadFrom(buffer)
			if err != nil {
				return
			}
			var message dnsmessage.Message
			if message.Unpack(buffer[:n]) == nil && message.Header.Response {
				captured.mu.Lock()
				captured.responses = append(captured.responses, message)
				captured.mu.Unlock()
			}
		}
	}()
	t.Cleanup(func() {
		_ = conn.Close()
		<-done
	})
	return captured
}

// announcements counts the captured responses that carry a PTR to instance
// with the given TTL.
func (captured *capturedResponses) announcements(instance string, ttl uint32) int {
	captured.mu.Lock()
	defer captured.mu.Unlock()
	count := 0
	for _, message := range captured.responses {
		for _, answer := range message.Answers {
			pointer, ok := answer.Body.(*dnsmessage.PTRResource)
			if ok && pointer.PTR.String() == instance && answer.Header.TTL == ttl {
				count++
			}
		}
	}
	return count
}

func (captured *capturedResponses) waitFor(t *testing.T, instance string, ttl uint32, count int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for captured.announcements(instance, ttl) < count {
		if time.Now().After(deadline) {
			t.Fatalf("captured %d responses with PTR %s TTL %d, want %d", captured.announcements(instance, ttl), instance, ttl, count)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func browseLoopback(t *testing.T, iface net.Interface) []Found {
	t.Helper()
	found, err := browse(context.Background(), browseTime, only(iface))
	if err != nil {
		t.Fatal(err)
	}
	return found
}

func logTo(t *testing.T) func(string, ...any) {
	return func(format string, args ...any) { t.Logf(format, args...) }
}

func TestStartValidatesConfig(t *testing.T) {
	public, _, _ := testDesktop(t)
	if _, err := Start(Config{PublicKey: public[:31], Port: 4740}); err == nil {
		t.Error("Start accepted a short public key")
	}
	if _, err := Start(Config{PublicKey: public}); err == nil {
		t.Error("Start accepted a zero port")
	}
	if _, err := browse(context.Background(), 0, nonLoopbackInterfaces); err == nil {
		t.Error("Browse accepted a zero timeout")
	}
	none := func() ([]net.Interface, error) { return nil, nil }
	if _, err := browse(context.Background(), time.Millisecond, none); !errors.Is(err, ErrNoInterfaces) {
		t.Errorf("Browse without interfaces: %v", err)
	}
	failing := func() ([]net.Interface, error) { return nil, errors.New("boom") }
	if _, err := Start(Config{PublicKey: public, Port: 4740, Interfaces: failing}); err == nil {
		t.Error("Start ignored an interface listing error")
	}
}

func TestAnnounceBrowseAndGoodbyeOnLoopback(t *testing.T) {
	iface := requireLoopbackMulticast(t)
	public, id, fingerprint := testDesktop(t)
	captured := captureResponses(t, iface)

	announcer, err := Start(Config{PublicKey: public, Port: 4740, Interfaces: only(iface), Logf: logTo(t)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = announcer.Close() })
	if announcer.Instance() != "cialai-"+fingerprint {
		t.Fatalf("instance %q", announcer.Instance())
	}
	fqdn := announcer.Instance() + "._cialai._udp.local."
	captured.waitFor(t, fqdn, pointerTTL, 2)

	found := browseLoopback(t, iface)
	want := []Found{{ID: id, Fingerprint: fingerprint, Addrs: []netip.AddrPort{netip.MustParseAddrPort("127.0.0.1:4740")}}}
	if !equalFound(found, want) {
		t.Fatalf("Browse = %+v, want %+v", found, want)
	}

	if err := announcer.SetPort(4741); err != nil {
		t.Fatal(err)
	}
	captured.waitFor(t, fqdn, pointerTTL, 4)
	found = browseLoopback(t, iface)
	want[0].Addrs = []netip.AddrPort{netip.MustParseAddrPort("127.0.0.1:4741")}
	if !equalFound(found, want) {
		t.Fatalf("Browse after SetPort = %+v, want %+v", found, want)
	}

	if err := announcer.Close(); err != nil {
		t.Fatal(err)
	}
	captured.waitFor(t, fqdn, 0, 1)
	if err := announcer.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
	if err := announcer.Refresh(); !errors.Is(err, ErrClosed) {
		t.Errorf("Refresh after Close: %v", err)
	}
	if err := announcer.SetPort(4742); !errors.Is(err, ErrClosed) {
		t.Errorf("SetPort after Close: %v", err)
	}
	if found := browseLoopback(t, iface); len(found) != 0 {
		t.Fatalf("Browse after Close = %+v", found)
	}
}

func TestRefreshStartsAnnouncingWhenAnInterfaceAppears(t *testing.T) {
	iface := requireLoopbackMulticast(t)
	public, id, fingerprint := testDesktop(t)
	captured := captureResponses(t, iface)
	var available atomic.Bool
	interfaces := func() ([]net.Interface, error) {
		if !available.Load() {
			return nil, nil
		}
		return []net.Interface{iface}, nil
	}
	announcer, err := Start(Config{PublicKey: public, Port: 4750, Interfaces: interfaces, Logf: logTo(t)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = announcer.Close() })
	if announcer.active != nil {
		t.Fatal("announcer is active without interfaces")
	}
	if err := announcer.Refresh(); err != nil || announcer.active != nil {
		t.Fatalf("Refresh without interfaces: %v, active %v", err, announcer.active != nil)
	}

	available.Store(true)
	if err := announcer.Refresh(); err != nil {
		t.Fatal(err)
	}
	active := announcer.active
	if active == nil {
		t.Fatal("Refresh did not start the responder")
	}
	if err := announcer.Refresh(); err != nil || announcer.active != active {
		t.Fatalf("Refresh without changes reopened the responder: %v", err)
	}
	if err := announcer.SetPort(4750); err != nil || announcer.active != active {
		t.Fatalf("SetPort with the same port reopened the responder: %v", err)
	}
	found := browseLoopback(t, iface)
	if len(found) != 1 || found[0].ID != id {
		t.Fatalf("Browse = %+v", found)
	}

	available.Store(false)
	if err := announcer.Refresh(); err != nil || announcer.active != nil {
		t.Fatalf("Refresh after the interface left: %v, active %v", err, announcer.active != nil)
	}
	captured.waitFor(t, instanceName(fingerprint)+"._cialai._udp.local.", 0, 1)
}

func TestBrowseIgnoresInvalidAnnouncements(t *testing.T) {
	iface := requireLoopbackMulticast(t)
	public, id, fingerprint := testDesktop(t)
	_, otherID, otherFingerprint := testDesktop(t)
	announcer, err := Start(Config{PublicKey: public, Port: 4760, Interfaces: only(iface), Logf: logTo(t)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = announcer.Close() })

	interfaces, err := usableInterfaces(only(iface))
	if err != nil {
		t.Fatal(err)
	}
	invalid := map[string][]pion.TXTEntry{
		"cialai-version":     {pion.NewTXTString("v", "2"), pion.NewTXTString("id", otherID), pion.NewTXTString("fp", otherFingerprint)},
		"cialai-fingerprint": {pion.NewTXTString("v", "1"), pion.NewTXTString("id", otherID), pion.NewTXTString("fp", fingerprint)},
		"cialai-id":          {pion.NewTXTString("v", "1"), pion.NewTXTString("id", "d_short"), pion.NewTXTString("fp", otherFingerprint)},
		"cialai-empty":       nil,
	}
	for name, text := range invalid {
		service := pion.ServiceInstance{Instance: name, Service: ServiceType, Domain: domain, Port: 4761, Text: text}
		records := serviceRecords{
			service:  ServiceType + ".local.",
			instance: name + "." + ServiceType + ".local.",
			host:     name + ".local.",
			text:     []string{""},
		}.withPort(4761)
		responder, err := openResponder(service, name+".local", records, interfaces, logTo(t))
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = responder.close(true) })
	}

	found := browseLoopback(t, iface)
	want := []Found{{ID: id, Fingerprint: fingerprint, Addrs: []netip.AddrPort{netip.MustParseAddrPort("127.0.0.1:4760")}}}
	if !equalFound(found, want) {
		t.Fatalf("Browse = %+v, want %+v", found, want)
	}
}

func TestResultsLimits(t *testing.T) {
	event := func(id, fingerprint string, address string, port uint16) pion.ServiceEvent {
		return pion.ServiceEvent{
			Instance: pion.ServiceInstance{Port: port, Text: txtEntries(id, fingerprint)},
			Addr:     netip.MustParseAddr(address),
		}
	}
	collected := newResults(false)
	_, id, fingerprint := testDesktop(t)
	collected.add(event(id, fingerprint, "8.8.8.8", 4740))
	collected.add(event(id, fingerprint, "127.0.0.1", 4740))
	collected.add(event(id, fingerprint, "fe80::1%en0", 4740))
	collected.add(event(id, fingerprint, "192.168.9.9", 0))
	collected.add(pion.ServiceEvent{Instance: pion.ServiceInstance{Port: 4740}, Addr: netip.MustParseAddr("192.168.9.9")})
	if list := collected.list(); len(list) != 0 {
		t.Fatalf("kept invalid events: %+v", list)
	}

	for index := range maxFound + 4 {
		_, id, fingerprint := testDesktop(t)
		for port := range MaxReported + 2 {
			collected.add(event(id, fingerprint, fmt.Sprintf("192.168.%d.1", index), uint16(4750-port)))
		}
		collected.add(event(id, fingerprint, fmt.Sprintf("192.168.%d.1", index), 4750))
	}
	list := collected.list()
	if len(list) != maxFound {
		t.Fatalf("kept %d desktops, want %d", len(list), maxFound)
	}
	for _, desktop := range list {
		if len(desktop.Addrs) != MaxReported || !slices.IsSortedFunc(desktop.Addrs, netip.AddrPort.Compare) {
			t.Fatalf("desktop %s kept addresses %v", desktop.ID, desktop.Addrs)
		}
	}
	if !slices.IsSortedFunc(list, func(a, b Found) int { return cmp.Compare(a.ID, b.ID) }) {
		t.Error("desktops are not ordered by id")
	}
}

func equalFound(got, want []Found) bool {
	return slices.EqualFunc(got, want, func(a, b Found) bool {
		return a.ID == b.ID && a.Fingerprint == b.Fingerprint && slices.Equal(a.Addrs, b.Addrs)
	})
}
