// SPDX-License-Identifier: Apache-2.0
package rendezvous

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strings"
	"testing"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

func TestEveryMessageTypeRoundTrips(t *testing.T) {
	keys := newKeys(t)
	card := testCard(t, keys.desktop, lan("192.168.1.10:4740"))
	for _, msg := range []message{
		keys.hello(identity.RolePhone),
		{Type: typeCandidates, Candidates: &candidateList{TTLMillis: 60_000, Candidates: []pairing.Candidate{
			lan("192.168.1.20:50000"), {Type: pairing.CandidateSTUN, Address: "203.0.113.20:50000"},
		}}},
		{Type: typeCandidates, Candidates: &candidateList{TTLMillis: 1_000, Candidates: []pairing.Candidate{}}},
		{Type: typePunchRequest, PunchRequest: &punchRequest{Candidates: 2}},
		{Type: typePunchAck, PunchAck: &punchAck{Request: 3, Accepted: true}},
		{Type: typePunchAck, PunchAck: &punchAck{Request: 3, Reason: RefusedExpired}},
		{Type: typeReachUpdate, ReachUpdate: &card},
		{Type: typePathReport, PathReport: &PathReport{Path: transport.NameDirect, Address: "[2001:db8::1]:4740", RTTMillis: 12}},
		{Type: typePathReport, PathReport: &PathReport{Path: transport.NameTor, Reason: "UDP bloqueado na rede"}},
		{Type: typePing},
		{Type: typePong, Pong: &pong{Ping: 7}},
	} {
		t.Run(string(msg.Type), func(t *testing.T) {
			msg.Seq = 9
			payload, err := encodeMessage(msg)
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := decodeMessage(payload)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(decoded, msg) {
				t.Fatalf("decoded %+v, want %+v", decoded, msg)
			}
		})
	}
}

func TestDecodeRejectsInvalidPayloads(t *testing.T) {
	keys := newKeys(t)
	key := keys.phone.PublicKeyString()
	card := testCard(t, keys.desktop)
	card.Version = 2
	badCard, err := json.Marshal(card)
	if err != nil {
		t.Fatal(err)
	}
	many := make([]string, MaxCandidates+1)
	for index := range many {
		many[index] = fmt.Sprintf(`{"t":"lan","a":"192.168.1.%d:4740"}`, index+1)
	}
	for name, payload := range map[string]string{
		"not json":                 `ping`,
		"null":                     `null`,
		"unknown field":            `{"type":"ping","seq":1,"extra":true}`,
		"unknown nested field":     `{"type":"pong","seq":1,"pong":{"ping":1,"extra":2}}`,
		"trailing data":            `{"type":"ping","seq":1}{}`,
		"seq zero":                 `{"type":"ping","seq":0}`,
		"seq missing":              `{"type":"ping"}`,
		"seq negative":             `{"type":"ping","seq":-1}`,
		"seq fraction":             `{"type":"ping","seq":1.5}`,
		"unknown type":             `{"type":"wave","seq":1}`,
		"missing body":             `{"type":"candidates","seq":1}`,
		"body of another type":     `{"type":"ping","seq":1,"pong":{"ping":1}}`,
		"two bodies":               `{"type":"pong","seq":1,"pong":{"ping":1},"punchRequest":{"candidates":1}}`,
		"hello unknown role":       `{"type":"hello","seq":1,"hello":{"proto":1,"role":"tablet","key":"` + key + `"}}`,
		"hello key not canonical":  `{"type":"hello","seq":1,"hello":{"proto":1,"role":"phone","key":"` + key + `="}}`,
		"hello version zero":       `{"type":"hello","seq":1,"hello":{"proto":0,"role":"phone","key":"` + key + `"}}`,
		"candidates TTL too short": `{"type":"candidates","seq":1,"candidates":{"ttlMs":999,"list":[]}}`,
		"candidates TTL too long":  `{"type":"candidates","seq":1,"candidates":{"ttlMs":600001,"list":[]}}`,
		"candidates null list":     `{"type":"candidates","seq":1,"candidates":{"ttlMs":60000,"list":null}}`,
		"candidate public as lan":  `{"type":"candidates","seq":1,"candidates":{"ttlMs":60000,"list":[{"t":"lan","a":"8.8.8.8:4740"}]}}`,
		"candidate repeated":       `{"type":"candidates","seq":1,"candidates":{"ttlMs":60000,"list":[{"t":"lan","a":"192.168.1.2:1"},{"t":"lan","a":"192.168.1.2:1"}]}}`,
		"too many candidates":      `{"type":"candidates","seq":1,"candidates":{"ttlMs":60000,"list":[` + strings.Join(many, ",") + `]}}`,
		"punch request frame zero": `{"type":"punch_request","seq":1,"punchRequest":{"candidates":0}}`,
		"ack accepted with reason": `{"type":"punch_ack","seq":1,"punchAck":{"request":1,"accepted":true,"reason":"busy"}}`,
		"ack refused silently":     `{"type":"punch_ack","seq":1,"punchAck":{"request":1,"accepted":false}}`,
		"ack reason not a code":    `{"type":"punch_ack","seq":1,"punchAck":{"request":1,"reason":"Busy!"}}`,
		"ack request zero":         `{"type":"punch_ack","seq":1,"punchAck":{"request":0,"accepted":true}}`,
		"reach card invalid":       `{"type":"reach_update","seq":1,"reachUpdate":` + string(badCard) + `}`,
		"direct path no address":   `{"type":"path_report","seq":1,"pathReport":{"path":"direct"}}`,
		"direct path bad address":  `{"type":"path_report","seq":1,"pathReport":{"path":"direct","address":"desktop.local:4740"}}`,
		"tor path with address":    `{"type":"path_report","seq":1,"pathReport":{"path":"tor","address":"192.168.1.2:4740"}}`,
		"unknown path":             `{"type":"path_report","seq":1,"pathReport":{"path":"relay"}}`,
		"negative RTT":             `{"type":"path_report","seq":1,"pathReport":{"path":"tor","rttMs":-1}}`,
		"reason too long":          `{"type":"path_report","seq":1,"pathReport":{"path":"tor","reason":"` + strings.Repeat("x", maxReasonBytes+1) + `"}}`,
		"pong frame zero":          `{"type":"pong","seq":1,"pong":{"ping":0}}`,
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := decodeMessage([]byte(payload)); !errors.Is(err, ErrInvalidFrame) {
				t.Fatalf("decode error = %v, want ErrInvalidFrame", err)
			}
		})
	}
}

func TestReadFrameChecksTheLengthFirst(t *testing.T) {
	buffer := make([]byte, MaxFrameSize)
	padded := paddedPing(1, MaxFrameSize)
	raw, err := readFrame(bytes.NewReader(appendFrame(nil, padded)), buffer)
	if err != nil {
		t.Fatal(err)
	}
	if msg, err := decodeMessage(raw); err != nil || msg.Type != typePing {
		t.Fatalf("16 KiB frame decoded as %+v, %v", msg, err)
	}

	// Only the header is available: an oversized frame must be refused
	// without waiting for its payload.
	header := binary.BigEndian.AppendUint32(nil, MaxFrameSize+1)
	if _, err := readFrame(bytes.NewReader(header), buffer); !errors.Is(err, ErrFrameTooLarge) {
		t.Fatalf("oversized frame error = %v", err)
	}
	if _, err := readFrame(bytes.NewReader(binary.BigEndian.AppendUint32(nil, 0)), buffer); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("empty frame error = %v", err)
	}
	truncated := appendFrame(nil, []byte(`{"type":"ping","seq":1}`))
	if _, err := readFrame(bytes.NewReader(truncated[:len(truncated)-1]), buffer); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Fatalf("truncated frame error = %v", err)
	}
	if _, err := readFrame(bytes.NewReader(nil), buffer); !errors.Is(err, io.EOF) {
		t.Fatalf("clean end error = %v", err)
	}
}

// paddedPing is a valid ping payload padded with JSON whitespace to size.
func paddedPing(seq uint64, size int) []byte {
	payload := fmt.Appendf(nil, `{"type":"ping","seq":%d}`, seq)
	return append(payload, bytes.Repeat([]byte(" "), size-len(payload))...)
}
