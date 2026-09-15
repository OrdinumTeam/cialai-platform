// SPDX-License-Identifier: Apache-2.0
package mdns

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	pion "github.com/pion/mdns/v2"
	"golang.org/x/net/dns/dnsmessage"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

func testDesktop(t *testing.T) (ed25519.PublicKey, string, string) {
	t.Helper()
	desktop, err := identity.Generate(identity.RoleDesktop, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return desktop.PublicKey(), desktop.ID(), desktop.Fingerprint()
}

func TestFingerprintOfMatchesIdentity(t *testing.T) {
	for range 16 {
		_, id, fingerprint := testDesktop(t)
		if got, ok := fingerprintOf(id); !ok || got != fingerprint {
			t.Fatalf("fingerprintOf(%q) = %q, %v; identity says %q", id, got, ok, fingerprint)
		}
	}
	phone, err := identity.Generate(identity.RolePhone, rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, id, _ := testDesktop(t)
	for _, invalid := range []string{"", "d_", phone.ID(), strings.TrimPrefix(id, "d_"), id + "A", id[:len(id)-1], id + "=", "d_" + strings.Repeat("A", 21) + "B", "d_AAAA\nAAAAAAAAAAAAAAAAAA"} {
		if _, ok := fingerprintOf(invalid); ok {
			t.Errorf("fingerprintOf(%q) accepted an invalid desktop id", invalid)
		}
	}
}

func TestParseTXT(t *testing.T) {
	_, id, fingerprint := testDesktop(t)
	_, otherID, otherFingerprint := testDesktop(t)
	txt := func(pairs ...string) []pion.TXTEntry {
		var entries []pion.TXTEntry
		for _, pair := range pairs {
			if key, value, found := strings.Cut(pair, "="); found {
				entries = append(entries, pion.NewTXTString(key, value))
			} else {
				entries = append(entries, pion.NewTXTFlag(pair))
			}
		}
		return entries
	}
	valid := []struct {
		name    string
		entries []pion.TXTEntry
	}{
		{"announced", txtEntries(id, fingerprint)},
		{"keys ignore case", txt("V=1", "ID="+id, "Fp="+fingerprint)},
		{"unknown keys ignored", txt("v=1", "id="+id, "fp="+fingerprint, "future=yes", "flag")},
		{"first occurrence wins", txt("v=1", "id="+id, "fp="+fingerprint, "id="+otherID, "fp="+otherFingerprint)},
	}
	for _, test := range valid {
		gotID, gotFingerprint, err := parseTXT(test.entries)
		if err != nil || gotID != id || gotFingerprint != fingerprint {
			t.Errorf("%s: parseTXT = %q, %q, %v", test.name, gotID, gotFingerprint, err)
		}
	}
	invalid := []struct {
		name    string
		entries []pion.TXTEntry
	}{
		{"empty", nil},
		{"no version", txt("id="+id, "fp="+fingerprint)},
		{"other version", txt("v=2", "id="+id, "fp="+fingerprint)},
		{"version flag", txt("v", "id="+id, "fp="+fingerprint)},
		{"no id", txt("v=1", "fp="+fingerprint)},
		{"phone id", txt("v=1", "id=dev_"+strings.TrimPrefix(id, "d_"), "fp="+fingerprint)},
		{"malformed id", txt("v=1", "id="+id+"x", "fp="+fingerprint)},
		{"no fingerprint", txt("v=1", "id="+id)},
		{"fingerprint of another key", txt("v=1", "id="+id, "fp="+otherFingerprint)},
		{"uppercase fingerprint", txt("v=1", "id="+id, "fp="+strings.ToUpper(fingerprint))},
		{"fingerprint flag", txt("v=1", "id="+id, "fp")},
	}
	for _, test := range invalid {
		if _, _, err := parseTXT(test.entries); err == nil {
			t.Errorf("%s: parseTXT accepted %v", test.name, test.entries)
		}
	}
}

func TestLANAddress(t *testing.T) {
	accepted := []string{"10.1.2.3", "172.16.0.1", "192.168.1.20", "100.64.0.1", "100.127.255.254", "fd12:3456::1", "fc00::1"}
	refused := []string{"8.8.8.8", "127.0.0.1", "::1", "169.254.1.1", "fe80::1", "2001:db8::1", "224.0.0.251", "ff02::fb", "0.0.0.0", "::", "::ffff:192.168.1.20"}
	for _, text := range accepted {
		if !lanAddress(netip.MustParseAddr(text), false) {
			t.Errorf("lanAddress(%s) = false", text)
		}
	}
	for _, text := range refused {
		if lanAddress(netip.MustParseAddr(text), false) {
			t.Errorf("lanAddress(%s) = true", text)
		}
	}
	if !lanAddress(netip.MustParseAddr("127.0.0.1"), true) || lanAddress(netip.MustParseAddr("::1"), true) {
		t.Error("only IPv4 loopback is accepted on a loopback interface")
	}
	if lanAddress(netip.MustParseAddr("fd00::1%en0"), false) {
		t.Error("an address with a zone is accepted")
	}
}

func TestAnnouncementPacket(t *testing.T) {
	_, id, fingerprint := testDesktop(t)
	set := serviceRecords{
		service:  ServiceType + ".local.",
		instance: instanceName(fingerprint) + "." + ServiceType + ".local.",
		host:     hostName(fingerprint) + ".",
		text:     txtStrings(id, fingerprint),
	}.withPort(4740)
	addresses := []netip.Addr{netip.MustParseAddr("192.168.1.20"), netip.MustParseAddr("fd00::20")}

	for _, goodbye := range []bool{false, true} {
		raw, err := set.packet(addresses, goodbye)
		if err != nil {
			t.Fatal(err)
		}
		var message dnsmessage.Message
		if err := message.Unpack(raw); err != nil {
			t.Fatal(err)
		}
		if !message.Header.Response || !message.Header.Authoritative || len(message.Questions) != 0 || len(message.Answers) != 5 {
			t.Fatalf("goodbye=%v: header %+v with %d questions and %d answers", goodbye, message.Header, len(message.Questions), len(message.Answers))
		}
		for index, answer := range message.Answers {
			wantTTL, wantClass := uint32(recordTTL), dnsmessage.ClassINET|cacheFlush
			if index == 0 {
				wantTTL, wantClass = pointerTTL, dnsmessage.ClassINET
			}
			if goodbye {
				wantTTL, wantClass = 0, dnsmessage.ClassINET
			}
			if answer.Header.TTL != wantTTL || answer.Header.Class != wantClass {
				t.Errorf("goodbye=%v: answer %d %v has TTL %d class %v", goodbye, index, answer.Header.Type, answer.Header.TTL, answer.Header.Class)
			}
		}
		pointer := message.Answers[0].Body.(*dnsmessage.PTRResource)
		service := message.Answers[1].Body.(*dnsmessage.SRVResource)
		text := message.Answers[2].Body.(*dnsmessage.TXTResource)
		a := message.Answers[3].Body.(*dnsmessage.AResource)
		aaaa := message.Answers[4].Body.(*dnsmessage.AAAAResource)
		switch {
		case message.Answers[0].Header.Name.String() != "_cialai._udp.local.":
			t.Errorf("PTR name %s", message.Answers[0].Header.Name)
		case pointer.PTR.String() != "cialai-"+fingerprint+"._cialai._udp.local.":
			t.Errorf("PTR target %s", pointer.PTR)
		case service.Port != 4740 || service.Target.String() != "cialai-"+fingerprint+".local.":
			t.Errorf("SRV %+v", service)
		case strings.Join(text.TXT, " ") != "v=1 id="+id+" fp="+fingerprint:
			t.Errorf("TXT %q", text.TXT)
		case netip.AddrFrom4(a.A) != addresses[0] || netip.AddrFrom16(aaaa.AAAA) != addresses[1]:
			t.Errorf("addresses %v %v", a.A, aaaa.AAAA)
		}
	}
}

func TestUsableInterfaces(t *testing.T) {
	loopback := loopbackInterface(t)
	fakes := []net.Interface{
		{Index: 1 << 20, Name: "down0", MTU: 1500, Flags: net.FlagMulticast},
		{Index: 1<<20 + 1, Name: "utun9", MTU: 1500, Flags: net.FlagUp | net.FlagMulticast | net.FlagPointToPoint},
	}
	usable, err := usableInterfaces(func() ([]net.Interface, error) { return append(fakes, loopback), nil })
	if err != nil {
		t.Fatal(err)
	}
	if len(usable) != 1 || usable[0].iface.Name != loopback.Name {
		t.Fatalf("usable interfaces = %+v", usable)
	}
	for _, address := range usable[0].addresses {
		if !address.IsLoopback() || !address.Is4() {
			t.Errorf("loopback interface announces %s", address)
		}
	}
	if !usable[0].has(netip.Addr.Is4) {
		t.Error("loopback interface has no IPv4 address")
	}

	defaults, err := usableInterfaces(nonLoopbackInterfaces)
	if err != nil {
		t.Fatal(err)
	}
	for _, lan := range defaults {
		if lan.loopback() {
			t.Errorf("default interfaces include loopback %s", lan.iface.Name)
		}
		for _, address := range lan.addresses {
			if !lanAddress(address, false) {
				t.Errorf("%s announces %s", lan.iface.Name, address)
			}
		}
	}
}

func TestPionWarningsAreLimited(t *testing.T) {
	var lines []string
	factory := newLoggerFactory(func(format string, args ...any) {
		lines = append(lines, format)
	})
	logger := factory.NewLogger("mdns")
	logger.Debugf("dropped %d", 1)
	logger.Warnf("failed on interface %d", 1)
	logger.Warnf("failed on interface %d", 2)
	logger.Errorf("other %s", "kind")
	if len(lines) != 2 {
		t.Fatalf("forwarded %d lines, want 2", len(lines))
	}
	factory.last["failed on interface %d"] = time.Now().Add(-warningInterval)
	logger.Warnf("failed on interface %d", 3)
	if len(lines) != 3 {
		t.Fatalf("warning not forwarded again after the interval")
	}
}
