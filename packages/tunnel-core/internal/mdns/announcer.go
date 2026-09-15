// SPDX-License-Identifier: Apache-2.0
package mdns

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	pion "github.com/pion/mdns/v2"
	"golang.org/x/net/dns/dnsmessage"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

const (
	// recordTTL is the TTL in seconds of the SRV, TXT and address records,
	// the value pion uses when answering.
	recordTTL = 120
	// pointerTTL is the TTL in seconds of the PTR record, as RFC 6762
	// section 10 recommends and pion answers.
	pointerTTL = 4500
	// announceInterval separates the two announcements of RFC 6762 section 8.3.
	announceInterval = time.Second
	// cacheFlush is the top bit of the record class, RFC 6762 section 10.2.
	cacheFlush = dnsmessage.Class(1 << 15)
)

var (
	// ErrUnsupported is returned on iOS, where discovery is native and the Go
	// core must not open multicast sockets.
	ErrUnsupported = errors.New("mdns: multicast sockets are not used on iOS")
	// ErrClosed is returned by the methods of a closed Announcer.
	ErrClosed = errors.New("mdns: announcer is closed")

	groupIPv4 = &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	groupIPv6 = &net.UDPAddr{IP: net.ParseIP("ff02::fb"), Port: 5353}
)

// Config describes an announcer.
type Config struct {
	// PublicKey is the Ed25519 key of the desktop; the id and the fingerprint
	// of the TXT record and the instance name derive from it.
	PublicKey ed25519.PublicKey
	// Port is the UDP port of the direct QUIC listener.
	Port uint16
	// Interfaces lists the candidate interfaces; nil means every interface
	// except loopback. Only the usable ones are announced on, and a loopback
	// interface listed here is announced with its loopback addresses, for
	// tests on one host.
	Interfaces func() ([]net.Interface, error)
	// Logf receives diagnostics; nil discards them.
	Logf func(format string, args ...any)
}

// Announcer keeps the desktop announced on the local network.
type Announcer struct {
	instance   string
	host       string
	text       []pion.TXTEntry
	records    serviceRecords
	interfaces func() ([]net.Interface, error)
	logf       func(format string, args ...any)

	mu        sync.Mutex
	closed    bool
	port      uint16
	signature string
	active    *responder
}

// Start validates config and announces the desktop on the usable interfaces.
// Without any usable interface the announcer starts idle and a later Refresh
// begins announcing.
func Start(config Config) (*Announcer, error) {
	if runtime.GOOS == "ios" {
		return nil, ErrUnsupported
	}
	id, err := identity.DeriveID(identity.RoleDesktop, config.PublicKey)
	if err != nil {
		return nil, fmt.Errorf("mdns: %w", err)
	}
	if config.Port == 0 {
		return nil, errors.New("mdns: listener port is required")
	}
	fingerprint := identity.Fingerprint(config.PublicKey)
	logf := config.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	interfaces := config.Interfaces
	if interfaces == nil {
		interfaces = nonLoopbackInterfaces
	}
	announcer := &Announcer{
		instance: instanceName(fingerprint),
		host:     hostName(fingerprint),
		text:     txtEntries(id, fingerprint),
		records: serviceRecords{
			service:  ServiceType + "." + domain + ".",
			instance: instanceName(fingerprint) + "." + ServiceType + "." + domain + ".",
			host:     hostName(fingerprint) + ".",
			text:     txtStrings(id, fingerprint),
		},
		interfaces: interfaces,
		logf:       logf,
		port:       config.Port,
	}
	announcer.mu.Lock()
	defer announcer.mu.Unlock()
	if err := announcer.updateLocked(); err != nil {
		return nil, err
	}
	return announcer, nil
}

// Instance returns the DNS-SD instance name, "cialai-<fingerprint>".
func (announcer *Announcer) Instance() string { return announcer.instance }

// Refresh reads the interfaces again and, when an interface or an address
// changed, reopens the responder and announces again. It does nothing when
// nothing changed.
func (announcer *Announcer) Refresh() error {
	announcer.mu.Lock()
	defer announcer.mu.Unlock()
	if announcer.closed {
		return ErrClosed
	}
	return announcer.updateLocked()
}

// SetPort announces a new listener port.
func (announcer *Announcer) SetPort(port uint16) error {
	if port == 0 {
		return errors.New("mdns: listener port is required")
	}
	announcer.mu.Lock()
	defer announcer.mu.Unlock()
	if announcer.closed {
		return ErrClosed
	}
	announcer.port = port
	return announcer.updateLocked()
}

// Close sends a goodbye so browsers drop the instance and closes the sockets.
// Calling it again does nothing.
func (announcer *Announcer) Close() error {
	announcer.mu.Lock()
	defer announcer.mu.Unlock()
	if announcer.closed {
		return nil
	}
	announcer.closed = true
	active := announcer.active
	announcer.active = nil
	if active == nil {
		return nil
	}
	return active.close(true)
}

// updateLocked reopens the responder when the port or the usable interfaces
// differ from the ones being announced.
func (announcer *Announcer) updateLocked() error {
	selected, err := usableInterfaces(announcer.interfaces)
	if err != nil {
		return fmt.Errorf("mdns: list interfaces: %w", err)
	}
	signature := signatureOf(announcer.port, selected)
	if signature == announcer.signature {
		return nil
	}
	if announcer.active != nil {
		// A new responder announces the same instance with cache-flush, so
		// the goodbye is sent only when the announcer goes idle; it is best
		// effort, because the interfaces may already be gone.
		if err := announcer.active.close(len(selected) == 0); err != nil {
			announcer.logf("mdns: close responder: %v", err)
		}
		announcer.active = nil
	}
	announcer.signature = ""
	if len(selected) == 0 {
		announcer.signature = signature
		announcer.logf("mdns: no local network interface to announce on")
		return nil
	}
	service := pion.ServiceInstance{
		Instance: announcer.instance,
		Service:  ServiceType,
		Domain:   domain,
		Port:     announcer.port,
		Text:     announcer.text,
	}
	active, err := openResponder(service, announcer.host, announcer.records.withPort(announcer.port), selected, announcer.logf)
	if err != nil {
		return err
	}
	announcer.active = active
	announcer.signature = signature
	announcer.logf("mdns: announcing %s on port %d over %s", announcer.instance, announcer.port, interfaceNames(selected))
	return nil
}

// lanInterface is an interface used by the responder with the addresses it
// announces there.
type lanInterface struct {
	iface     net.Interface
	addresses []netip.Addr
}

func (lan lanInterface) loopback() bool { return lan.iface.Flags&net.FlagLoopback != 0 }

func (lan lanInterface) has(family func(netip.Addr) bool) bool {
	for _, address := range lan.addresses {
		if family(address) {
			return true
		}
	}
	return false
}

func nonLoopbackInterfaces() ([]net.Interface, error) {
	all, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	interfaces := all[:0]
	for _, iface := range all {
		if iface.Flags&net.FlagLoopback == 0 {
			interfaces = append(interfaces, iface)
		}
	}
	return interfaces, nil
}

// usableInterfaces keeps the interfaces that are up, support multicast (or
// are loopback), are not point-to-point tunnels and have a LAN address.
func usableInterfaces(list func() ([]net.Interface, error)) ([]lanInterface, error) {
	interfaces, err := list()
	if err != nil {
		return nil, err
	}
	var usable []lanInterface
	for _, iface := range interfaces {
		loopback := iface.Flags&net.FlagLoopback != 0
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagPointToPoint != 0 || (!loopback && iface.Flags&net.FlagMulticast == 0) {
			continue
		}
		raw, err := iface.Addrs()
		if err != nil {
			continue
		}
		var addresses []netip.Addr
		for _, item := range raw {
			var ip net.IP
			switch value := item.(type) {
			case *net.IPNet:
				ip = value.IP
			case *net.IPAddr:
				ip = value.IP
			}
			address, ok := netip.AddrFromSlice(ip)
			if ok && lanAddress(address.Unmap(), loopback) {
				addresses = append(addresses, address.Unmap())
			}
		}
		if len(addresses) > 0 {
			usable = append(usable, lanInterface{iface: iface, addresses: addresses})
		}
	}
	return usable, nil
}

func signatureOf(port uint16, interfaces []lanInterface) string {
	var builder strings.Builder
	builder.WriteString(strconv.Itoa(int(port)))
	for _, lan := range interfaces {
		fmt.Fprintf(&builder, "|%d,%s,%d", lan.iface.Index, lan.iface.Name, lan.iface.MTU)
		for _, address := range lan.addresses {
			builder.WriteString("," + address.String())
		}
	}
	return builder.String()
}

func interfaceNames(interfaces []lanInterface) string {
	names := make([]string, 0, len(interfaces))
	for _, lan := range interfaces {
		names = append(names, lan.iface.Name)
	}
	return strings.Join(names, ",")
}

// responder is one pion server over the interfaces of one moment, plus the
// announcements pion does not send.
type responder struct {
	conn       *pion.Conn
	v4         *ipv4.PacketConn
	v6         *ipv6.PacketConn
	records    serviceRecords
	interfaces []lanInterface
	logf       func(format string, args ...any)
	stop       chan struct{}
	done       chan struct{}
}

func openResponder(service pion.ServiceInstance, host string, records serviceRecords, interfaces []lanInterface, logf func(string, ...any)) (*responder, error) {
	v4, v6, err := listenMulticast(interfaces)
	if err != nil {
		return nil, err
	}
	loopback := false
	selected := make([]net.Interface, 0, len(interfaces))
	for _, lan := range interfaces {
		loopback = loopback || lan.loopback()
		selected = append(selected, lan.iface)
	}
	conn, err := pion.NewServer(v4, v6,
		pion.WithName("cialai"),
		pion.WithLocalNames(host),
		pion.WithService(service),
		pion.WithInterfaces(selected...),
		pion.WithIncludeLoopback(loopback),
		pion.WithResponseTTL(recordTTL),
		pion.WithCacheRefresh(false),
		pion.WithLoggerFactory(newLoggerFactory(logf)),
	)
	if err != nil {
		closePacketConns(v4, v6)
		return nil, fmt.Errorf("mdns: start responder: %w", err)
	}
	active := &responder{
		conn:       conn,
		v4:         v4,
		v6:         v6,
		records:    records,
		interfaces: interfaces,
		logf:       logf,
		stop:       make(chan struct{}),
		done:       make(chan struct{}),
	}
	go active.announce()
	return active, nil
}

// listenMulticast opens the mDNS sockets on port 5353. IPv4 is required; IPv6
// is opened only when an interface has an IPv6 LAN address and its failure is
// not fatal.
func listenMulticast(interfaces []lanInterface) (*ipv4.PacketConn, *ipv6.PacketConn, error) {
	// Listening on the group makes Go bind the wildcard address with the
	// address reuse options, so the system responder keeps working.
	conn4, err := net.ListenUDP("udp4", groupIPv4)
	if err != nil {
		return nil, nil, fmt.Errorf("mdns: listen on %s: %w", groupIPv4, err)
	}
	var v6 *ipv6.PacketConn
	for _, lan := range interfaces {
		if lan.has(netip.Addr.Is6) {
			if conn6, err := net.ListenUDP("udp6", groupIPv6); err == nil {
				v6 = ipv6.NewPacketConn(conn6)
			}
			break
		}
	}
	return ipv4.NewPacketConn(conn4), v6, nil
}

func closePacketConns(v4 *ipv4.PacketConn, v6 *ipv6.PacketConn) {
	if v4 != nil {
		_ = v4.Close()
	}
	if v6 != nil {
		_ = v6.Close()
	}
}

func (active *responder) announce() {
	defer close(active.done)
	active.send(false)
	timer := time.NewTimer(announceInterval)
	defer timer.Stop()
	select {
	case <-timer.C:
		active.send(false)
	case <-active.stop:
	}
}

// close stops the announcements, sends the goodbye when asked and closes the
// sockets.
func (active *responder) close(goodbye bool) error {
	close(active.stop)
	<-active.done
	if goodbye {
		active.send(true)
	}
	return active.conn.Close()
}

// send writes the announcement, or the goodbye, to the multicast group of each
// interface with the addresses of that interface. The socket is shared with
// pion, which also selects the interface before writing, so the interface is
// set on the packet as well where the platform supports it.
func (active *responder) send(goodbye bool) {
	for _, lan := range active.interfaces {
		packet, err := active.records.packet(lan.addresses, goodbye)
		if err != nil {
			active.logf("mdns: build announcement: %v", err)
			return
		}
		iface := lan.iface
		if lan.has(netip.Addr.Is4) {
			err := active.v4.SetMulticastInterface(&iface)
			if err == nil {
				_, err = active.v4.WriteTo(packet, &ipv4.ControlMessage{IfIndex: iface.Index}, groupIPv4)
			}
			if err != nil {
				active.logf("mdns: announce on %s over IPv4: %v", iface.Name, err)
			}
		}
		if active.v6 != nil && lan.has(netip.Addr.Is6) {
			err := active.v6.SetMulticastInterface(&iface)
			if err == nil {
				_, err = active.v6.WriteTo(packet, &ipv6.ControlMessage{IfIndex: iface.Index}, groupIPv6)
			}
			if err != nil {
				active.logf("mdns: announce on %s over IPv6: %v", iface.Name, err)
			}
		}
	}
}

// serviceRecords holds the fully qualified names of the service.
type serviceRecords struct {
	service  string
	instance string
	host     string
	text     []string
	port     uint16
}

func (set serviceRecords) withPort(port uint16) serviceRecords {
	set.port = port
	return set
}

// packet builds an unsolicited response with the PTR, SRV, TXT and address
// records. Announcements set the cache-flush bit on the unique records; a
// goodbye sends every record with TTL zero and without it.
func (set serviceRecords) packet(addresses []netip.Addr, goodbye bool) ([]byte, error) {
	service, err := dnsmessage.NewName(set.service)
	if err != nil {
		return nil, err
	}
	instance, err := dnsmessage.NewName(set.instance)
	if err != nil {
		return nil, err
	}
	host, err := dnsmessage.NewName(set.host)
	if err != nil {
		return nil, err
	}
	shortTTL, longTTL, unique := uint32(recordTTL), uint32(pointerTTL), dnsmessage.ClassINET|cacheFlush
	if goodbye {
		shortTTL, longTTL, unique = 0, 0, dnsmessage.ClassINET
	}
	header := func(name dnsmessage.Name, kind dnsmessage.Type, class dnsmessage.Class, ttl uint32) dnsmessage.ResourceHeader {
		return dnsmessage.ResourceHeader{Name: name, Type: kind, Class: class, TTL: ttl}
	}
	answers := []dnsmessage.Resource{
		{Header: header(service, dnsmessage.TypePTR, dnsmessage.ClassINET, longTTL), Body: &dnsmessage.PTRResource{PTR: instance}},
		{Header: header(instance, dnsmessage.TypeSRV, unique, shortTTL), Body: &dnsmessage.SRVResource{Port: set.port, Target: host}},
		{Header: header(instance, dnsmessage.TypeTXT, unique, shortTTL), Body: &dnsmessage.TXTResource{TXT: set.text}},
	}
	for _, address := range addresses {
		if address.Is4() {
			answers = append(answers, dnsmessage.Resource{Header: header(host, dnsmessage.TypeA, unique, shortTTL), Body: &dnsmessage.AResource{A: address.As4()}})
		} else {
			answers = append(answers, dnsmessage.Resource{Header: header(host, dnsmessage.TypeAAAA, unique, shortTTL), Body: &dnsmessage.AAAAResource{AAAA: address.As16()}})
		}
	}
	message := dnsmessage.Message{Header: dnsmessage.Header{Response: true, Authoritative: true}, Answers: answers}
	return message.Pack()
}
