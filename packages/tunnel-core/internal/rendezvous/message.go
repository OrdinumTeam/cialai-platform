// SPDX-License-Identifier: Apache-2.0
package rendezvous

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/netip"
	"time"
	"unicode/utf8"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

const (
	// ProtocolVersion is announced in hello; a peer with another version is
	// refused with ErrUnsupportedVersion.
	ProtocolVersion = 1
	// MaxFrameSize bounds the JSON payload of one frame, without the 4-byte
	// length header.
	MaxFrameSize    = 16 << 10
	frameHeaderSize = 4

	// MaxCandidates matches the reach card.
	MaxCandidates = candidates.MaxCardCandidates
	// DefaultCandidateTTL is the validity of a candidate list sent without an
	// explicit TTL. MinCandidateTTL and MaxCandidateTTL bound any TTL.
	DefaultCandidateTTL = 2 * time.Minute
	MinCandidateTTL     = time.Second
	MaxCandidateTTL     = 10 * time.Minute

	maxReasonBytes  = 256
	maxRefusalBytes = 64
	maxRTTMillis    = int64(10 * time.Minute / time.Millisecond)
)

// Reasons a desktop gives when it refuses a punch request.
const (
	RefusedUnsupported  = "unsupported"
	RefusedStale        = "candidates_stale"
	RefusedExpired      = "candidates_expired"
	RefusedNoCandidates = "no_candidates"
	RefusedBusy         = "busy"
)

var (
	// ErrInvalidFrame covers an empty frame, malformed or non-strict JSON and
	// a message whose fields break the protocol rules.
	ErrInvalidFrame  = errors.New("rendezvous frame is invalid")
	ErrFrameTooLarge = errors.New("rendezvous frame exceeds 16 KiB")
	// ErrProtocol is a frame that is valid on its own but not at this point:
	// a message before hello, a second hello, a skipped sequence number, a
	// message the sender role may not send or a request naming a frame that
	// is not a candidate list.
	ErrProtocol = errors.New("rendezvous protocol violation")
	// ErrReplay is a frame whose sequence number is not above the last one,
	// or an answer to a request that was already answered.
	ErrReplay             = errors.New("rendezvous frame repeated")
	ErrPeerMismatch       = errors.New("rendezvous peer does not match the authenticated transport")
	ErrUnsupportedVersion = errors.New("rendezvous protocol version is not supported")
	ErrIdleTimeout        = errors.New("rendezvous peer silent past the idle timeout")
	ErrCandidatesExpired  = errors.New("rendezvous candidates expired")
	ErrPunchRefused       = errors.New("rendezvous punch refused by the peer")
)

type messageType string

const (
	typeHello        messageType = "hello"
	typeCandidates   messageType = "candidates"
	typePunchRequest messageType = "punch_request"
	typePunchAck     messageType = "punch_ack"
	typeReachUpdate  messageType = "reach_update"
	typePathReport   messageType = "path_report"
	typePing         messageType = "ping"
	typePong         messageType = "pong"
)

// senders restricts message types to one role; types not listed may come from
// either side.
var senders = map[messageType]identity.Role{
	typePunchRequest: identity.RolePhone,
	typePunchAck:     identity.RoleDesktop,
	typeReachUpdate:  identity.RoleDesktop,
	typePathReport:   identity.RolePhone,
}

func maySend(kind messageType, sender identity.Role) bool {
	required, restricted := senders[kind]
	return !restricted || required == sender
}

// message is one frame. Exactly the body named by Type is present; ping has
// no body.
type message struct {
	Type messageType `json:"type"`
	Seq  uint64      `json:"seq"`

	Hello        *hello           `json:"hello,omitempty"`
	Candidates   *candidateList   `json:"candidates,omitempty"`
	PunchRequest *punchRequest    `json:"punchRequest,omitempty"`
	PunchAck     *punchAck        `json:"punchAck,omitempty"`
	ReachUpdate  *candidates.Card `json:"reachUpdate,omitempty"`
	PathReport   *PathReport      `json:"pathReport,omitempty"`
	Pong         *pong            `json:"pong,omitempty"`
}

type hello struct {
	Proto int    `json:"proto"`
	Role  string `json:"role"`
	Key   string `json:"key"`
}

type candidateList struct {
	TTLMillis  int64               `json:"ttlMs"`
	Candidates []pairing.Candidate `json:"list"`
}

// punchRequest names the sequence number of the candidate list to punch.
type punchRequest struct {
	Candidates uint64 `json:"candidates"`
}

// punchAck answers the punch request whose sequence number is Request.
type punchAck struct {
	Request  uint64 `json:"request"`
	Accepted bool   `json:"accepted"`
	Reason   string `json:"reason,omitempty"`
}

// pong answers the ping whose sequence number is Ping.
type pong struct {
	Ping uint64 `json:"ping"`
}

// PathReport is the path the phone uses to reach the desktop.
type PathReport struct {
	// Path is transport.NameDirect or transport.NameTor.
	Path string `json:"path"`
	// Address is the direct endpoint in use; it is required on the direct
	// path and absent on Tor.
	Address string `json:"address,omitempty"`
	// RTTMillis is the round trip measured on the path, zero when unknown.
	RTTMillis int64 `json:"rttMs,omitempty"`
	// Reason tells why the direct path is not in use, for diagnostics only.
	Reason string `json:"reason,omitempty"`
}

// encodeMessage validates msg and returns its JSON payload.
func encodeMessage(msg message) ([]byte, error) {
	if err := validateMessage(msg); err != nil {
		return nil, err
	}
	payload, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidFrame, err)
	}
	if len(payload) > MaxFrameSize {
		return nil, fmt.Errorf("%w: %s payload has %d bytes", ErrFrameTooLarge, msg.Type, len(payload))
	}
	return payload, nil
}

// checkEncodable reports whether msg fits in a frame with any sequence number.
func checkEncodable(msg message) error {
	msg.Seq = math.MaxUint64
	_, err := encodeMessage(msg)
	return err
}

func appendFrame(frame, payload []byte) []byte {
	frame = binary.BigEndian.AppendUint32(frame, uint32(len(payload)))
	return append(frame, payload...)
}

// readFrame reads one frame into buffer, which must hold MaxFrameSize bytes.
// The length is checked before the payload is read. A stream that ends before
// the first header byte returns io.EOF; one that ends inside a frame returns
// io.ErrUnexpectedEOF.
func readFrame(reader io.Reader, buffer []byte) ([]byte, error) {
	var header [frameHeaderSize]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint32(header[:])
	switch {
	case size == 0:
		return nil, fmt.Errorf("%w: empty frame", ErrInvalidFrame)
	case size > MaxFrameSize:
		return nil, fmt.Errorf("%w: header announces %d bytes", ErrFrameTooLarge, size)
	}
	if _, err := io.ReadFull(reader, buffer[:size]); err != nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		return nil, err
	}
	return buffer[:size], nil
}

// decodeMessage parses a payload strictly: no unknown fields, no trailing
// data and every field valid.
func decodeMessage(raw []byte) (message, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var msg message
	if err := decoder.Decode(&msg); err != nil {
		return message{}, fmt.Errorf("%w: %w", ErrInvalidFrame, err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return message{}, fmt.Errorf("%w: trailing data", ErrInvalidFrame)
	}
	if err := validateMessage(msg); err != nil {
		return message{}, err
	}
	return msg, nil
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalidFrame, fmt.Sprintf(format, args...))
}

func validateMessage(msg message) error {
	if msg.Seq == 0 {
		return invalid("seq must start at 1")
	}
	bodies := 0
	for _, present := range []bool{
		msg.Hello != nil, msg.Candidates != nil, msg.PunchRequest != nil, msg.PunchAck != nil,
		msg.ReachUpdate != nil, msg.PathReport != nil, msg.Pong != nil,
	} {
		if present {
			bodies++
		}
	}
	var body bool
	var err error
	switch msg.Type {
	case typeHello:
		body = msg.Hello != nil
		if body {
			err = msg.Hello.validate()
		}
	case typeCandidates:
		body = msg.Candidates != nil
		if body {
			err = msg.Candidates.validate()
		}
	case typePunchRequest:
		body = msg.PunchRequest != nil
		if body && msg.PunchRequest.Candidates == 0 {
			err = invalid("punch_request must name a candidates frame")
		}
	case typePunchAck:
		body = msg.PunchAck != nil
		if body {
			err = msg.PunchAck.validate()
		}
	case typeReachUpdate:
		body = msg.ReachUpdate != nil
		if body {
			if cardErr := msg.ReachUpdate.Validate(); cardErr != nil {
				err = fmt.Errorf("%w: %w", ErrInvalidFrame, cardErr)
			}
		}
	case typePathReport:
		body = msg.PathReport != nil
		if body {
			err = msg.PathReport.validate()
		}
	case typePing:
		if bodies != 0 {
			return invalid("ping carries no body")
		}
		return nil
	case typePong:
		body = msg.Pong != nil
		if body && msg.Pong.Ping == 0 {
			err = invalid("pong must name a ping frame")
		}
	default:
		return invalid("unknown message type %q", msg.Type)
	}
	if !body || bodies != 1 {
		return invalid("%s must carry only its own body", msg.Type)
	}
	return err
}

func (body *hello) validate() error {
	if body.Proto < 1 {
		return invalid("hello protocol version must be positive")
	}
	if role := identity.Role(body.Role); role != identity.RolePhone && role != identity.RoleDesktop {
		return invalid("hello role %q is unknown", body.Role)
	}
	if _, err := identity.ParsePublicKey(body.Key); err != nil {
		return invalid("hello key: %v", err)
	}
	return nil
}

func (body *candidateList) validate() error {
	ttl := time.Duration(body.TTLMillis) * time.Millisecond
	if body.TTLMillis < int64(MinCandidateTTL/time.Millisecond) || body.TTLMillis > int64(MaxCandidateTTL/time.Millisecond) {
		return invalid("candidate TTL %s is outside [%s, %s]", ttl, MinCandidateTTL, MaxCandidateTTL)
	}
	if body.Candidates == nil || len(body.Candidates) > MaxCandidates {
		return invalid("candidate list must have between 0 and %d entries", MaxCandidates)
	}
	seen := make(map[string]bool, len(body.Candidates))
	for _, candidate := range body.Candidates {
		if !pairing.ValidCandidate(candidate) || seen[candidate.Address] {
			return invalid("candidate %q is invalid or repeated", candidate.Address)
		}
		seen[candidate.Address] = true
	}
	return nil
}

func (body *punchAck) validate() error {
	if body.Request == 0 {
		return invalid("punch_ack must name a punch_request frame")
	}
	if body.Accepted {
		if body.Reason != "" {
			return invalid("accepted punch_ack carries no reason")
		}
		return nil
	}
	if !validRefusal(body.Reason) {
		return invalid("punch_ack refusal reason %q is invalid", body.Reason)
	}
	return nil
}

// validRefusal accepts short snake_case codes, so a newer peer may add codes.
func validRefusal(reason string) bool {
	if reason == "" || len(reason) > maxRefusalBytes {
		return false
	}
	for _, char := range []byte(reason) {
		if (char < 'a' || char > 'z') && char != '_' {
			return false
		}
	}
	return true
}

func (report *PathReport) validate() error {
	switch report.Path {
	case transport.NameDirect:
		address, err := netip.ParseAddrPort(report.Address)
		if err != nil || address.Port() == 0 || address.String() != report.Address {
			return invalid("direct path_report needs a canonical address, got %q", report.Address)
		}
	case transport.NameTor:
		if report.Address != "" {
			return invalid("tor path_report carries no address")
		}
	default:
		return invalid("path %q is unknown", report.Path)
	}
	if report.RTTMillis < 0 || report.RTTMillis > maxRTTMillis {
		return invalid("path RTT %d ms is out of range", report.RTTMillis)
	}
	if len(report.Reason) > maxReasonBytes || !utf8.ValidString(report.Reason) {
		return invalid("path reason must be UTF-8 up to %d bytes", maxReasonBytes)
	}
	return nil
}

// usableCandidates keeps the valid, distinct candidates in priority order, up
// to MaxCandidates, as the reach card does. It never returns nil.
func usableCandidates(list []pairing.Candidate) []pairing.Candidate {
	usable := make([]pairing.Candidate, 0, min(len(list), MaxCandidates))
	seen := make(map[string]bool, len(list))
	for _, candidate := range list {
		if len(usable) == MaxCandidates {
			break
		}
		if pairing.ValidCandidate(candidate) && !seen[candidate.Address] {
			seen[candidate.Address] = true
			usable = append(usable, candidate)
		}
	}
	return usable
}
