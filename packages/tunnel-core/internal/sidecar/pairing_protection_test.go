// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
)

// The pairing protections of CON-060 that live in the stdio protocol, run
// through Serve over the direct QUIC listener and the onion listener of the
// fake Tor seam: the 90 s rotation with pair.cancel and pair.begin, the four
// digit approval answered with pair.deny and pair.approve, and the expiry of
// the QR. The desktop sees each refusal as pair.failed on stdout. The rest of
// the protections are covered with the pairing clock in internal/edge.

type begunPairing struct {
	PairID    string `json:"pairId"`
	Payload   string `json:"payload"`
	ExpiresAt int64  `json:"expiresAt"`
	Rotate    int    `json:"rotateAfterSeconds"`
	decoded   pairing.Payload
}

func (h *harness) begin(t *testing.T, ttlSeconds int) begunPairing {
	t.Helper()
	var begun begunPairing
	h.call(t, "pair.begin", map[string]any{"ttlSeconds": ttlSeconds}, &begun)
	decoded, err := pairing.Decode(begun.Payload)
	if err != nil {
		t.Fatal(err)
	}
	begun.decoded = decoded
	return begun
}

// pairingDialer opens one stream from a phone to the desktop over a transport.
type pairingDialer func(t *testing.T, phone *identity.Identity) net.Conn

func directDialer(port int, pinned ed25519.PublicKey) pairingDialer {
	return func(t *testing.T, phone *identity.Identity) net.Conn {
		t.Helper()
		socket, err := net.ListenPacket("udp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		endpoint, err := direct.New(direct.Config{PacketConn: socket, Identity: phone})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = endpoint.Close() })
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		session, err := endpoint.Dial(ctx, net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), pinned)
		if err != nil {
			t.Fatal(err)
		}
		stream, err := session.OpenStream(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return stream
	}
}

func onionDialer(listener net.Listener, pinned ed25519.PublicKey) pairingDialer {
	return func(t *testing.T, phone *identity.Identity) net.Conn {
		t.Helper()
		config, err := identity.ClientConfig(phone, pinned)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		defer cancel()
		conn, err := (&tls.Dialer{Config: config}).DialContext(ctx, "tcp", listener.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		return conn
	}
}

// requestPair sends POST /pair v2 for payload on conn and returns the status
// and the problem code.
func requestPair(t *testing.T, conn net.Conn, payload pairing.Payload, phone *identity.Identity) (int, string) {
	t.Helper()
	status, code := requestPairAsync(conn, payload, phone)
	if status == 0 {
		t.Fatalf("POST /pair: %s", code)
	}
	return status, code
}

// waitPairFailed waits for pair.failed of pairID with code on transport.
func (h *harness) waitPairFailed(t *testing.T, from int, pairID, code, name string) {
	t.Helper()
	h.waitEvent(t, "pair.failed", from, testTimeout, func(data json.RawMessage) bool {
		var event map[string]string
		return json.Unmarshal(data, &event) == nil && event["pairId"] == pairID && event["code"] == code && event["transport"] == name
	})
}

func TestPairingRotationApprovalAndExpiryThroughTheSidecar(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan *fakeTor, 1)
	h := startHarness(t, harnessOptions{
		torExecutable: executable,
		startTor: func(config tor.DesktopConfig) (TorService, error) {
			fake, err := startFakeTor(config)
			if err == nil {
				started <- fake
			}
			return fake, err
		},
	})
	status := h.start(t, map[string]any{"stun": []string{}, "requireApproval": true})
	fake := <-started
	pinned, err := identity.ParsePublicKey(status.Desktop.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	dialers := map[string]pairingDialer{
		transport.NameDirect: directDialer(status.Direct.Port, pinned),
		transport.NameTor:    onionDialer(fake.Listener(), pinned),
	}

	for _, name := range []string{transport.NameDirect, transport.NameTor} {
		dial := dialers[name]
		t.Run(name+"/QR rotated after 90 s", func(t *testing.T) {
			rotated := h.begin(t, 600)
			if rotated.Rotate != 90 || rotated.ExpiresAt <= time.Now().Unix() {
				t.Fatalf("pair.begin: %+v", rotated)
			}
			// The dialog rotates: pair.cancel of the shown QR, then pair.begin.
			h.call(t, "pair.cancel", map[string]any{"pairId": rotated.PairID}, nil)
			current := h.begin(t, 600)
			defer h.request("pair.cancel", map[string]any{"pairId": current.PairID}, testTimeout)
			phone := mustPhone(t)
			from := h.eventCount()
			if status, code := requestPair(t, dial(t, phone), rotated.decoded, phone); status != http.StatusNotFound || code != "pair_unknown" {
				t.Fatalf("rotated QR: HTTP %d %s", status, code)
			}
			h.waitPairFailed(t, from, rotated.PairID, "pair_unknown", name)
		})

		t.Run(name+"/approval by code", func(t *testing.T) {
			shown := h.begin(t, 600)
			phone := mustPhone(t)
			for _, approve := range []bool{false, true} {
				from := h.eventCount()
				conn := dial(t, phone)
				answered := make(chan [2]any, 1)
				go func() {
					status, code := requestPairAsync(conn, shown.decoded, phone)
					answered <- [2]any{status, code}
				}()
				data, _ := h.waitEvent(t, "pair.requested", from, testTimeout, func(data json.RawMessage) bool {
					var event struct {
						PairID    string `json:"pairId"`
						Transport string `json:"transport"`
					}
					return json.Unmarshal(data, &event) == nil && event.PairID == shown.PairID && event.Transport == name
				})
				var requested struct {
					Code        string `json:"code"`
					Fingerprint string `json:"fingerprint"`
					Device      struct {
						PublicKey string `json:"publicKey"`
					} `json:"device"`
				}
				if err := json.Unmarshal(data, &requested); err != nil || len(requested.Code) != 4 || requested.Fingerprint != phone.Fingerprint() || requested.Device.PublicKey != phone.PublicKeyString() {
					t.Fatalf("pair.requested: %s", data)
				}
				if _, err := strconv.Atoi(requested.Code); err != nil {
					t.Fatalf("approval code %q is not four digits", requested.Code)
				}
				command := "pair.deny"
				if approve {
					command = "pair.approve"
				}
				h.call(t, command, map[string]any{"pairId": shown.PairID}, nil)
				var result [2]any
				select {
				case result = <-answered:
				case <-time.After(testTimeout):
					t.Fatal("the phone got no answer after " + command)
				}
				if !approve {
					if result[0] != http.StatusForbidden || result[1] != "pair_denied" {
						t.Fatalf("denied approval answered %v", result)
					}
					h.waitPairFailed(t, from, shown.PairID, "pair_denied", name)
					continue
				}
				if result[0] != http.StatusOK {
					t.Fatalf("approved pairing answered %v", result)
				}
				h.waitEvent(t, "pair.completed", from, testTimeout, func(data json.RawMessage) bool {
					var event struct {
						PairID    string `json:"pairId"`
						Transport string `json:"transport"`
					}
					return json.Unmarshal(data, &event) == nil && event.PairID == shown.PairID && event.Transport == name
				})
			}
		})

		t.Run(name+"/expired QR", func(t *testing.T) {
			short := h.begin(t, 1)
			expired := time.Now().Add(1100 * time.Millisecond)
			// Another QR keeps a pairing active, so the expired one reaches
			// the edge instead of being refused by the transport.
			shown := h.begin(t, 600)
			defer h.request("pair.cancel", map[string]any{"pairId": shown.PairID}, testTimeout)
			time.Sleep(time.Until(expired))
			phone := mustPhone(t)
			from := h.eventCount()
			if status, code := requestPair(t, dial(t, phone), short.decoded, phone); status != http.StatusGone || code != "pair_expired" {
				t.Fatalf("expired QR: HTTP %d %s", status, code)
			}
			h.waitPairFailed(t, from, short.PairID, "pair_expired", name)
		})
	}
}

// requestPairAsync can run in a goroutine: it reports a transport failure as
// the status 0 with the error text instead of failing the test.
func requestPairAsync(conn net.Conn, payload pairing.Payload, phone *identity.Identity) (int, string) {
	body, _ := json.Marshal(map[string]any{
		"v": 2, "pairId": payload.PairID, "secret": payload.Secret,
		"device": map[string]string{"name": "Pixel de Teste", "model": "Pixel 9", "platform": "android", "app": "1.0.0", "publicKey": phone.PublicKeyString()},
	})
	request, err := http.NewRequest(http.MethodPost, "http://cialai/pair", bytes.NewReader(body))
	if err != nil {
		return 0, err.Error()
	}
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	if err := request.Write(conn); err != nil {
		return 0, err.Error()
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), request)
	if err != nil {
		return 0, err.Error()
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	var problem struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	_ = json.Unmarshal(data, &problem)
	return response.StatusCode, problem.Error.Code
}

func mustPhone(t *testing.T) *identity.Identity {
	t.Helper()
	phone, err := identity.Generate(identity.RolePhone, nil)
	if err != nil {
		t.Fatal(err)
	}
	return phone
}
