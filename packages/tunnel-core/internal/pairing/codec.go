// SPDX-License-Identifier: Apache-2.0
// Package pairing owns the CIALAI2 QR payload, the one-use pairing sessions and
// the devices.json v2 registry keyed by each phone's Ed25519 public key. The QR
// pins the desktop key and always carries the onion address, so a phone can
// reach the desktop from any network once the onion service is published.
package pairing

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha3"
	"encoding/base32"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

const (
	Prefix         = "CIALAI2."
	PayloadVersion = 2
	MaxJSONBytes   = 700
	MaxCandidates  = 6
	legacyPrefix   = "CIALAI1."
)

// Candidate types accepted in the QR: private LAN addresses, global IPv6, the
// port mapped on the gateway and the address reflected by STUN.
const (
	CandidateLAN    = "lan"
	CandidateIPv6   = "ipv6"
	CandidateMapped = "mapped"
	CandidateSTUN   = "stun"
)

const (
	onionVersion      = 0x03
	onionLabelLength  = 56
	onionChecksumSalt = ".onion checksum"
)

var (
	errPayloadTooLarge = errors.New("pairing payload exceeds the QR size limit")
	onionEncoding      = base32.StdEncoding.WithPadding(base32.NoPadding)
	// sharedAddressSpace is RFC 6598, used by carrier NAT and by some hotspot
	// and local networks, so a desktop address there may still be a LAN route.
	sharedAddressSpace = netip.MustParsePrefix("100.64.0.0/10")
)

// Desktop is the desktop identity pinned by the phone: the id must be derived
// from the public key.
type Desktop struct {
	ID        string `json:"id"`
	Name      string `json:"n"`
	PublicKey string `json:"k"`
}

// Candidate is a direct QUIC endpoint of the desktop, listed in priority order.
type Candidate struct {
	Type    string `json:"t"`
	Address string `json:"a"`
}

type Payload struct {
	Version    int         `json:"v"`
	Desktop    Desktop     `json:"d"`
	Onion      string      `json:"o"`
	Candidates []Candidate `json:"c"`
	Secret     string      `json:"s"`
	ExpiresAt  int64       `json:"e"`
	PairID     string      `json:"pid"`
}

type InspectionDesktop struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
}

// Inspection is what the phone shows before pairing. It never carries the
// secret or the pairing id.
type Inspection struct {
	Version    int               `json:"v"`
	Desktop    InspectionDesktop `json:"desktop"`
	Candidates int               `json:"candidates"`
	ExpiresAt  int64             `json:"expiresAt"`
}

func Encode(payload Payload) (string, error) {
	if payload.Candidates == nil {
		payload.Candidates = []Candidate{}
	}
	if err := validatePayload(payload); err != nil {
		return "", err
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return "", wrapError("payload_invalid", "Não foi possível codificar o pareamento.", err)
	}
	if len(raw) > MaxJSONBytes {
		return "", wrapError("payload_invalid", "O código de pareamento excede o tamanho permitido.", errPayloadTooLarge)
	}
	return Prefix + base64.RawURLEncoding.EncodeToString(raw), nil
}

func Decode(text string) (Payload, error) {
	if strings.HasPrefix(text, legacyPrefix) {
		return Payload{}, NewError("payload_version", "Este código é de uma versão anterior do Cialai. Atualize o Cialai no computador.")
	}
	if !strings.HasPrefix(text, Prefix) {
		return Payload{}, NewError("payload_invalid", "Este QR code não é um código de pareamento do Cialai.")
	}
	encoded := strings.TrimPrefix(text, Prefix)
	if encoded == "" || len(encoded) > base64.RawURLEncoding.EncodedLen(MaxJSONBytes) {
		return Payload{}, NewError("payload_invalid", "O código de pareamento tem tamanho inválido.")
	}
	raw, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(raw) > MaxJSONBytes {
		return Payload{}, NewError("payload_invalid", "O código de pareamento está corrompido.")
	}
	var payload Payload
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return Payload{}, wrapError("payload_invalid", "O código de pareamento tem campos inválidos.", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Payload{}, NewError("payload_invalid", "O código de pareamento contém dados adicionais.")
	}
	if err := validatePayload(payload); err != nil {
		return Payload{}, err
	}
	// The desktop always emits the canonical encoding. Re-encoding rejects a
	// missing or null candidate list, case variants of known keys, duplicate
	// keys and any other spelling the lenient standard decoder would accept.
	if canonical, err := json.Marshal(payload); err != nil || payload.Candidates == nil || !bytes.Equal(canonical, raw) {
		return Payload{}, NewError("payload_invalid", "O código de pareamento tem campos inválidos.")
	}
	return payload, nil
}

func Inspect(text string, now time.Time) (Inspection, error) {
	payload, err := Decode(text)
	if err != nil {
		return Inspection{}, err
	}
	if payload.ExpiresAt < now.Add(-60*time.Second).Unix() {
		return Inspection{}, NewError("payload_expired", "Este código expirou. Gere um novo no computador.")
	}
	public, _ := identity.ParsePublicKey(payload.Desktop.PublicKey)
	return Inspection{
		Version: payload.Version,
		Desktop: InspectionDesktop{
			ID: payload.Desktop.ID, Name: payload.Desktop.Name, Fingerprint: identity.Fingerprint(public),
		},
		Candidates: len(payload.Candidates),
		ExpiresAt:  payload.ExpiresAt,
	}, nil
}

func validatePayload(payload Payload) error {
	if payload.Version != PayloadVersion {
		return NewError("payload_version", "Atualize o Cialai neste celular para usar este código.")
	}
	if !validDesktop(payload.Desktop) {
		return NewError("payload_invalid", "A identidade do computador no código é inválida.")
	}
	if payload.Onion == "" {
		return NewError("payload_invalid", "O código de pareamento não traz o endereço de reserva do computador.")
	}
	if !validOnion(payload.Onion) {
		return NewError("payload_invalid", "O endereço de reserva do computador no código é inválido.")
	}
	if err := validateCandidates(payload.Candidates); err != nil {
		return err
	}
	if !validRawURLBytes(payload.Secret, 32) || !validEncodedID(payload.PairID, "p_", 8) || payload.ExpiresAt <= 0 {
		return NewError("payload_invalid", "A sessão do código de pareamento é inválida.")
	}
	return nil
}

func validDesktop(desktop Desktop) bool {
	if !validEncodedID(desktop.ID, "d_", 16) || !validName(desktop.Name, 48) {
		return false
	}
	public, err := identity.ParsePublicKey(desktop.PublicKey)
	if err != nil {
		return false
	}
	derived, err := identity.DeriveID(identity.RoleDesktop, public)
	return err == nil && derived == desktop.ID
}

func validateCandidates(candidates []Candidate) error {
	if len(candidates) > MaxCandidates {
		return NewError("payload_invalid", "O código de pareamento traz endereços diretos demais.")
	}
	seen := make(map[string]bool, len(candidates))
	for _, candidate := range candidates {
		if !validCandidate(candidate) || seen[candidate.Address] {
			return NewError("payload_invalid", "Um endereço direto do computador no código é inválido.")
		}
		seen[candidate.Address] = true
	}
	return nil
}

func validCandidate(candidate Candidate) bool {
	endpoint, err := netip.ParseAddrPort(candidate.Address)
	if err != nil || endpoint.String() != candidate.Address || endpoint.Port() == 0 {
		return false
	}
	address := endpoint.Addr()
	if address.Zone() != "" || address.Is4In6() || address.IsUnspecified() || address.IsMulticast() || address.IsLinkLocalUnicast() {
		return false
	}
	public := address.IsGlobalUnicast() && !address.IsPrivate()
	switch candidate.Type {
	case CandidateLAN:
		return address.IsPrivate() || address.IsLoopback() || sharedAddressSpace.Contains(address)
	case CandidateIPv6:
		return address.Is6() && public
	case CandidateMapped, CandidateSTUN:
		return public
	default:
		return false
	}
}

// validOnion accepts only "<56 lowercase base32>.onion:<port>" for a v3 onion
// service whose checksum and version byte match the embedded key.
func validOnion(value string) bool {
	host, portText, err := net.SplitHostPort(value)
	if err != nil || !validPort(portText) {
		return false
	}
	label, found := strings.CutSuffix(host, ".onion")
	if !found || len(label) != onionLabelLength || label != strings.ToLower(label) {
		return false
	}
	decoded, err := onionEncoding.DecodeString(strings.ToUpper(label))
	if err != nil || len(decoded) != ed25519.PublicKeySize+3 || decoded[len(decoded)-1] != onionVersion {
		return false
	}
	checksum := onionChecksum(decoded[:ed25519.PublicKeySize])
	return bytes.Equal(decoded[ed25519.PublicKeySize:ed25519.PublicKeySize+2], checksum[:2])
}

func onionChecksum(public []byte) [32]byte {
	material := make([]byte, 0, len(onionChecksumSalt)+len(public)+1)
	material = append(material, onionChecksumSalt...)
	material = append(material, public...)
	material = append(material, onionVersion)
	return sha3.Sum256(material)
}

func validPort(text string) bool {
	port, err := strconv.Atoi(text)
	return err == nil && port >= 1 && port <= 65535 && strconv.Itoa(port) == text
}

func validName(value string, maximum int) bool {
	return value != "" && utf8.ValidString(value) && utf8.RuneCountInString(value) <= maximum && !hasControl(value)
}

func hasControl(value string) bool {
	for _, character := range value {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}

func validEncodedID(value, prefix string, bytesCount int) bool {
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	return validRawURLBytes(strings.TrimPrefix(value, prefix), bytesCount)
}

func validRawURLBytes(value string, size int) bool {
	if value == "" || strings.Contains(value, "=") {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	return err == nil && len(decoded) == size && base64.RawURLEncoding.EncodeToString(decoded) == value
}

func randomEncoded(reader io.Reader, prefix string, size int) (string, error) {
	buffer := make([]byte, size)
	if _, err := io.ReadFull(reader, buffer); err != nil {
		return "", fmt.Errorf("create random pairing value: %w", err)
	}
	return prefix + base64.RawURLEncoding.EncodeToString(buffer), nil
}
