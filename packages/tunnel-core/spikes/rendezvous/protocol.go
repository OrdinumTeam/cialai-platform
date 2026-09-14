// SPDX-License-Identifier: Apache-2.0

// Package rendezvous defines the minimal control exchange that upgrades an
// authenticated Tor connection to a mutually authenticated direct QUIC path.
package rendezvous

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"strings"
	"sync"
)

const (
	ProtocolVersion = 1
	maxMessageBytes = 64 * 1024
	maxCandidates   = 32
)

type MessageType string

const (
	MessageClientOffer MessageType = "client_offer"
	MessageServerOffer MessageType = "server_offer"
	MessageDirectReady MessageType = "direct_ready"
	MessageSwitchAck   MessageType = "switch_ack"
	MessageFallback    MessageType = "fallback"
)

type Candidate struct {
	Type     string `json:"type"`
	Address  string `json:"address"`
	Protocol string `json:"protocol,omitempty"`
}

type Offer struct {
	Role       string      `json:"role"`
	PublicKey  string      `json:"publicKey"`
	Candidates []Candidate `json:"candidates"`
}

type Message struct {
	Version   int         `json:"version"`
	Type      MessageType `json:"type"`
	SessionID string      `json:"sessionId"`
	Offer     *Offer      `json:"offer,omitempty"`
	Candidate *Candidate  `json:"candidate,omitempty"`
	Reason    string      `json:"reason,omitempty"`
}

type Control interface {
	Send(context.Context, Message) error
	Receive(context.Context) (Message, error)
}

type JSONControl struct {
	incoming chan controlRead
	writer   io.Writer
	mu       sync.Mutex
}

func NewJSONControl(stream io.ReadWriter) *JSONControl {
	control := &JSONControl{incoming: make(chan controlRead, 1), writer: stream}
	go control.readLoop(bufio.NewReader(stream))
	return control
}

type controlRead struct {
	message Message
	err     error
}

func (control *JSONControl) Send(ctx context.Context, message Message) error {
	if err := validateMessage(message); err != nil {
		return err
	}
	encoded, err := json.Marshal(message)
	if err != nil {
		return fmt.Errorf("encode rendezvous message: %w", err)
	}
	if len(encoded)+1 > maxMessageBytes {
		return errors.New("rendezvous message exceeds 64 KiB")
	}
	control.mu.Lock()
	defer control.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return err
	}
	payload := append(encoded, '\n')
	for len(payload) > 0 {
		written, err := control.writer.Write(payload)
		if err != nil {
			return fmt.Errorf("write rendezvous message: %w", err)
		}
		if written == 0 {
			return fmt.Errorf("write rendezvous message: %w", io.ErrShortWrite)
		}
		payload = payload[written:]
	}
	return nil
}

func (control *JSONControl) Receive(ctx context.Context) (Message, error) {
	select {
	case <-ctx.Done():
		return Message{}, ctx.Err()
	case result, ok := <-control.incoming:
		if !ok {
			return Message{}, io.EOF
		}
		return result.message, result.err
	}
}

func (control *JSONControl) readLoop(reader *bufio.Reader) {
	defer close(control.incoming)
	for {
		line, err := readBoundedLine(reader)
		if err != nil {
			control.incoming <- controlRead{err: err}
			return
		}
		message, err := decodeMessage(line)
		control.incoming <- controlRead{message: message, err: err}
	}
}

func readBoundedLine(reader *bufio.Reader) ([]byte, error) {
	line := make([]byte, 0, 1024)
	for {
		fragment, prefix, err := reader.ReadLine()
		if err != nil {
			return nil, fmt.Errorf("read rendezvous message: %w", err)
		}
		if len(line)+len(fragment)+1 > maxMessageBytes {
			return nil, errors.New("rendezvous message exceeds 64 KiB")
		}
		line = append(line, fragment...)
		if !prefix {
			return line, nil
		}
	}
}

func decodeMessage(raw []byte) (Message, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var message Message
	if err := decoder.Decode(&message); err != nil {
		return Message{}, fmt.Errorf("decode rendezvous message: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return Message{}, errors.New("rendezvous message contains trailing JSON")
	}
	if err := validateMessage(message); err != nil {
		return Message{}, err
	}
	return message, nil
}

func NewSessionID() (string, error) {
	raw := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, raw); err != nil {
		return "", fmt.Errorf("generate session ID: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func validateMessage(message Message) error {
	if message.Version != ProtocolVersion {
		return fmt.Errorf("unsupported rendezvous version %d", message.Version)
	}
	if err := validateSessionID(message.SessionID); err != nil {
		return err
	}
	switch message.Type {
	case MessageClientOffer:
		if message.Offer == nil || message.Offer.Role != "client" {
			return errors.New("client_offer requires a client offer")
		}
		if message.Candidate != nil || message.Reason != "" {
			return errors.New("client_offer has fields from another message type")
		}
		return validateOffer(*message.Offer)
	case MessageServerOffer:
		if message.Offer == nil || message.Offer.Role != "server" {
			return errors.New("server_offer requires a server offer")
		}
		if message.Candidate != nil || message.Reason != "" {
			return errors.New("server_offer has fields from another message type")
		}
		return validateOffer(*message.Offer)
	case MessageDirectReady, MessageSwitchAck:
		if message.Offer != nil || message.Candidate == nil || message.Reason != "" {
			return fmt.Errorf("%s requires only a candidate", message.Type)
		}
		return validateCandidate(*message.Candidate)
	case MessageFallback:
		if message.Offer != nil || message.Candidate != nil || strings.TrimSpace(message.Reason) == "" {
			return errors.New("fallback requires only a reason")
		}
		if len(message.Reason) > 1024 {
			return errors.New("fallback reason is too long")
		}
		return nil
	default:
		return fmt.Errorf("unsupported rendezvous message type %q", message.Type)
	}
}

func validateSessionID(value string) error {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != value {
		return errors.New("sessionId must be a canonical base64url 32-byte value")
	}
	return nil
}

func validateOffer(offer Offer) error {
	if offer.Role != "client" && offer.Role != "server" {
		return errors.New("offer role must be client or server")
	}
	if err := validatePublicKey(offer.PublicKey); err != nil {
		return err
	}
	if len(offer.Candidates) == 0 || len(offer.Candidates) > maxCandidates {
		return fmt.Errorf("offer must contain between 1 and %d candidates", maxCandidates)
	}
	seen := make(map[string]bool, len(offer.Candidates))
	for _, candidate := range offer.Candidates {
		if err := validateCandidate(candidate); err != nil {
			return err
		}
		if seen[candidate.Address] {
			return fmt.Errorf("duplicate candidate %q", candidate.Address)
		}
		seen[candidate.Address] = true
	}
	return nil
}

func validateCandidate(candidate Candidate) error {
	switch candidate.Type {
	case "lan", "ipv6", "mapped", "stun":
	default:
		return fmt.Errorf("unsupported candidate type %q", candidate.Type)
	}
	address, err := netip.ParseAddrPort(candidate.Address)
	if err != nil || !address.Addr().IsValid() || address.Port() == 0 {
		return fmt.Errorf("invalid candidate address %q", candidate.Address)
	}
	if len(candidate.Protocol) > 256 {
		return errors.New("candidate protocol is too long")
	}
	return nil
}

func validatePublicKey(value string) error {
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || len(raw) != 32 || base64.RawURLEncoding.EncodeToString(raw) != value {
		return errors.New("publicKey must be a canonical base64url Ed25519 key")
	}
	return nil
}

func samePublicKey(left, right string) bool {
	leftRaw, leftErr := base64.RawURLEncoding.DecodeString(left)
	rightRaw, rightErr := base64.RawURLEncoding.DecodeString(right)
	return leftErr == nil && rightErr == nil && len(leftRaw) == 32 && len(rightRaw) == 32 &&
		subtle.ConstantTimeCompare(leftRaw, rightRaw) == 1
}
