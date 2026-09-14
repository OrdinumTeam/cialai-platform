// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const offerVersion = 1

type candidate struct {
	Type     string `json:"type"`
	Address  string `json:"address"`
	Protocol string `json:"protocol,omitempty"`
}

type protocolProbe struct {
	PCP  bool `json:"pcp"`
	PMP  bool `json:"natPmp"`
	UPnP bool `json:"upnp"`
}

type stunProbe struct {
	Server        string `json:"server"`
	ReflexiveAddr string `json:"reflexiveAddress,omitempty"`
	RTTMillis     int64  `json:"rttMillis,omitempty"`
	Error         string `json:"error,omitempty"`
}

type networkProbe struct {
	Protocols    protocolProbe `json:"mappingProtocols"`
	Mapping      string        `json:"mappingAddress,omitempty"`
	MappingType  string        `json:"mappingType,omitempty"`
	MappingError string        `json:"mappingError,omitempty"`
	STUN         []stunProbe   `json:"stun,omitempty"`
	CollectionMS int64         `json:"collectionMillis"`
}

type offer struct {
	Version     int          `json:"version"`
	Role        string       `json:"role"`
	PublicKey   string       `json:"publicKey"`
	Fingerprint string       `json:"fingerprint"`
	Candidates  []candidate  `json:"candidates"`
	Probe       networkProbe `json:"probe"`
	CreatedAt   time.Time    `json:"createdAt"`
}

func localCandidates(port int, includeLoopback bool) ([]candidate, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, fmt.Errorf("list interfaces: %w", err)
	}
	seen := make(map[string]bool)
	var result []candidate
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, raw := range addrs {
			prefix, err := netip.ParsePrefix(raw.String())
			if err != nil {
				continue
			}
			ip := prefix.Addr().Unmap()
			if !ip.IsValid() || ip.IsUnspecified() || ip.IsMulticast() || ip.IsLinkLocalUnicast() {
				continue
			}
			if ip.IsLoopback() && !includeLoopback {
				continue
			}
			kind := ""
			switch {
			case ip.Is4() && (ip.IsPrivate() || ip.IsLoopback()):
				kind = "lan"
			case ip.Is6() && ip.IsGlobalUnicast() && !ip.IsPrivate():
				kind = "ipv6"
			}
			if kind == "" {
				continue
			}
			address := netip.AddrPortFrom(ip, uint16(port)).String()
			if !seen[address] {
				seen[address] = true
				result = append(result, candidate{Type: kind, Address: address})
			}
		}
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Type != result[j].Type {
			return result[i].Type < result[j].Type
		}
		return result[i].Address < result[j].Address
	})
	return result, nil
}

func appendCandidate(candidates []candidate, item candidate) []candidate {
	for _, existing := range candidates {
		if existing.Address == item.Address {
			return candidates
		}
	}
	return append(candidates, item)
}

func writeOffer(path string, value offer) error {
	if path == "" {
		return errors.New("offer path is required")
	}
	if err := validateOffer(value); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create offer directory: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".directpath-offer-*")
	if err != nil {
		return fmt.Errorf("create temporary offer: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("protect offer: %w", err)
	}
	encoder := json.NewEncoder(temporary)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(value); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("encode offer: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return fmt.Errorf("sync offer: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close offer: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("publish offer: %w", err)
	}
	return nil
}

func readOffer(path string) (offer, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return offer{}, fmt.Errorf("read offer: %w", err)
	}
	if len(raw) > 64*1024 {
		return offer{}, errors.New("offer exceeds 64 KiB")
	}
	var value offer
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&value); err != nil {
		return offer{}, fmt.Errorf("decode offer: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return offer{}, errors.New("offer contains trailing JSON")
	}
	if err := validateOffer(value); err != nil {
		return offer{}, err
	}
	return value, nil
}

func validateOffer(value offer) error {
	if value.Version != offerVersion {
		return fmt.Errorf("unsupported offer version %d", value.Version)
	}
	if value.Role != "server" && value.Role != "client" {
		return errors.New("offer role must be server or client")
	}
	public, err := parsePublicKey(value.PublicKey)
	if err != nil {
		return err
	}
	if value.Fingerprint != fingerprint(public) {
		return errors.New("offer fingerprint does not match its public key")
	}
	if len(value.Candidates) == 0 || len(value.Candidates) > 32 {
		return errors.New("offer must contain between one and 32 candidates")
	}
	for _, item := range value.Candidates {
		switch item.Type {
		case "lan", "ipv6", "mapped", "stun":
		default:
			return fmt.Errorf("unsupported candidate type %q", item.Type)
		}
		parsed, err := netip.ParseAddrPort(item.Address)
		if err != nil || !parsed.Addr().IsValid() || parsed.Port() == 0 {
			return fmt.Errorf("invalid candidate address %q", item.Address)
		}
	}
	return nil
}

type stringList []string

func (s *stringList) String() string { return strings.Join(*s, ",") }

func (s *stringList) Set(value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return errors.New("value cannot be empty")
	}
	*s = append(*s, value)
	return nil
}
