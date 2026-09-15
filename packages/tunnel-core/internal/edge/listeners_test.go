// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/direct"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/onion"
)

// streamClient speaks HTTP/1.1 by hand over one transport stream, so every
// request, the WebSocket upgrade included, provably uses the same session.
// net/http would dial a second connection for the upgrade.
type streamClient struct {
	conn   net.Conn
	reader *bufio.Reader
}

func newStreamClient(t *testing.T, conn net.Conn) *streamClient {
	t.Helper()
	t.Cleanup(func() { _ = conn.Close() })
	return &streamClient{conn: conn, reader: bufio.NewReader(conn)}
}

func (client *streamClient) do(t *testing.T, method, path string, body []byte, headers map[string]string) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequest(method, "http://edge"+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	_ = client.conn.SetDeadline(time.Now().Add(testTimeout))
	if err := request.Write(client.conn); err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	response, err := http.ReadResponse(client.reader, request)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	if response.StatusCode == http.StatusSwitchingProtocols {
		return response, nil
	}
	defer response.Body.Close()
	data, _ := io.ReadAll(response.Body)
	return response, data
}

type upgradedStream struct {
	io.Reader
	io.Writer
}

func listenUDP(t *testing.T) net.PacketConn {
	t.Helper()
	packetConn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	return packetConn
}

// The real direct QUIC listener and the onion TLS listener, joined by
// transport.MultiListener, run the whole pairing on loopback: restricted
// session, POST /pair, promotion and /pty on the same session.
func TestEdgeServesRealDirectAndOnionListenersThroughOneAcceptPoint(t *testing.T) {
	bridgeURL, _ := newBridge(t)
	h := prepareEdge(t, bridgeURL)
	endpoint, err := direct.New(direct.Config{PacketConn: listenUDP(t), Identity: h.desktop})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = endpoint.Close() })
	directListener, err := endpoint.Listen(direct.ListenConfig{Registry: h.config.Devices, Pairing: h.config.Sessions})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	onionListener, err := onion.Listen(raw, h.desktop, onion.ListenConfig{Registry: h.config.Devices, Pairing: h.config.Sessions})
	if err != nil {
		t.Fatal(err)
	}
	h.start(t, transport.NewMultiListener(directListener, onionListener))

	for _, name := range []string{transport.NameDirect, transport.NameTor} {
		t.Run(name, func(t *testing.T) {
			phoneIdentity := mustIdentity(t, identity.RolePhone)
			key := phoneIdentity.PublicKeyString()
			pairID, secret := h.beginPairing(t)
			ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
			defer cancel()

			var stream net.Conn
			if name == transport.NameDirect {
				phoneEndpoint, err := direct.New(direct.Config{PacketConn: listenUDP(t), Identity: phoneIdentity})
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = phoneEndpoint.Close() })
				session, err := phoneEndpoint.Dial(ctx, directListener.Addr().String(), h.desktop.PublicKey())
				if err != nil {
					t.Fatal(err)
				}
				if stream, err = session.OpenStream(ctx); err != nil {
					t.Fatal(err)
				}
			} else {
				config, err := identity.ClientConfig(phoneIdentity, h.desktop.PublicKey())
				if err != nil {
					t.Fatal(err)
				}
				if stream, err = (&tls.Dialer{Config: config}).DialContext(ctx, "tcp", onionListener.Addr().String()); err != nil {
					t.Fatal(err)
				}
			}
			phone := newStreamClient(t, stream)

			response, body := phone.do(t, http.MethodGet, "/api/health", nil, nil)
			expectProblem(t, response, body, http.StatusUnauthorized, "pair_required")
			response, body = phone.do(t, http.MethodGet, "/pty", nil, upgradeHeaders(""))
			expectProblem(t, response, body, http.StatusUnauthorized, "pair_required")

			response, body = phone.do(t, http.MethodPost, "/pair", pairBody(pairID, secret, key), nil)
			if response.StatusCode != http.StatusOK {
				t.Fatalf("pair over %s failed: HTTP %d %s", name, response.StatusCode, body)
			}
			var result struct {
				DeviceID string `json:"deviceId"`
				Token    string `json:"token"`
			}
			if err := json.Unmarshal(body, &result); err != nil {
				t.Fatal(err)
			}
			if device, _ := h.config.Devices.Get(result.DeviceID); device.DeviceKey != key || device.LastTransport != name {
				t.Fatalf("device not recorded from the %s session: %#v", name, device)
			}

			if response, body := phone.do(t, http.MethodGet, "/api/health", nil, nil); response.StatusCode != http.StatusOK {
				t.Fatalf("promoted %s session did not reach health: HTTP %d %s", name, response.StatusCode, body)
			}
			response, body = phone.do(t, http.MethodGet, "/pty", nil, upgradeHeaders(result.Token))
			if response.StatusCode != http.StatusSwitchingProtocols {
				t.Fatalf("promoted %s session could not open /pty: HTTP %d %s", name, response.StatusCode, body)
			}
			expectEcho(t, upgradedStream{Reader: phone.reader, Writer: stream})
			h.events.wait(t, "session.opened", func(data any) bool {
				fields := data.(map[string]string)
				return fields["deviceId"] == result.DeviceID && fields["transport"] == name
			})
		})
	}
}
