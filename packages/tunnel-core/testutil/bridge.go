// SPDX-License-Identifier: Apache-2.0

package testutil

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/coder/websocket"
)

// BridgeHeaders records what the desktop bridge would see for one upgrade.
type BridgeHeaders struct {
	ProxySecret   string
	DeviceID      string
	DeviceKey     string
	NodeKey       string
	Transport     string
	Authorization string
	Cookie        string
}

// Bridge is a loopback WebSocket echo standing in for the Rust PTY bridge.
type Bridge struct {
	URL      string
	mu       sync.Mutex
	upgrades []BridgeHeaders
	sockets  map[*websocket.Conn]string
	messages int
}

func StartBridge(t *testing.T) *Bridge {
	t.Helper()
	bridge := &Bridge{sockets: make(map[*websocket.Conn]string)}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		headers := BridgeHeaders{
			ProxySecret:   request.Header.Get("X-Cialai-Proxy-Secret"),
			DeviceID:      request.Header.Get("X-Cialai-Device-Id"),
			DeviceKey:     request.Header.Get("X-Cialai-Device-Key"),
			NodeKey:       request.Header.Get("X-Cialai-Node-Key"),
			Transport:     request.Header.Get("X-Cialai-Transport"),
			Authorization: request.Header.Get("Authorization"),
			Cookie:        request.Header.Get("Cookie"),
		}
		bridge.mu.Lock()
		bridge.upgrades = append(bridge.upgrades, headers)
		bridge.mu.Unlock()
		connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		bridge.mu.Lock()
		bridge.sockets[connection] = headers.DeviceID
		bridge.mu.Unlock()
		defer func() {
			bridge.mu.Lock()
			delete(bridge.sockets, connection)
			bridge.mu.Unlock()
		}()
		connection.SetReadLimit(4 << 20)
		ctx := context.Background()
		for {
			kind, data, err := connection.Read(ctx)
			if err != nil {
				return
			}
			bridge.mu.Lock()
			bridge.messages++
			bridge.mu.Unlock()
			if err := connection.Write(ctx, kind, data); err != nil {
				return
			}
		}
	}))
	t.Cleanup(server.Close)
	bridge.URL = server.URL
	return bridge
}

func (bridge *Bridge) Upgrades() []BridgeHeaders {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return append([]BridgeHeaders(nil), bridge.upgrades...)
}

// Messages counts the messages the bridge read, over every socket.
func (bridge *Bridge) Messages() int {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	return bridge.messages
}

// Sockets counts the open sockets of deviceID.
func (bridge *Bridge) Sockets(deviceID string) int {
	bridge.mu.Lock()
	defer bridge.mu.Unlock()
	count := 0
	for _, owner := range bridge.sockets {
		if owner == deviceID {
			count++
		}
	}
	return count
}

// CloseDevice closes the sockets of deviceID with status, as the bridge does
// with 4401 after a revocation, and returns how many it closed. The close
// handshakes run in the background.
func (bridge *Bridge) CloseDevice(deviceID string, status websocket.StatusCode, reason string) int {
	bridge.mu.Lock()
	var closing []*websocket.Conn
	for connection, owner := range bridge.sockets {
		if owner == deviceID {
			closing = append(closing, connection)
		}
	}
	bridge.mu.Unlock()
	for _, connection := range closing {
		go func() { _ = connection.Close(status, reason) }()
	}
	return len(closing)
}
