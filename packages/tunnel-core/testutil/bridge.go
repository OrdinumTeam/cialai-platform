// SPDX-License-Identifier: Apache-2.0
//go:build integration

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
	NodeKey       string
	Authorization string
	Cookie        string
}

// Bridge is a loopback WebSocket echo standing in for the Rust PTY bridge.
type Bridge struct {
	URL      string
	mu       sync.Mutex
	upgrades []BridgeHeaders
}

func StartBridge(t *testing.T) *Bridge {
	t.Helper()
	bridge := &Bridge{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		bridge.mu.Lock()
		bridge.upgrades = append(bridge.upgrades, BridgeHeaders{
			ProxySecret:   request.Header.Get("X-Cialai-Proxy-Secret"),
			DeviceID:      request.Header.Get("X-Cialai-Device-Id"),
			NodeKey:       request.Header.Get("X-Cialai-Node-Key"),
			Authorization: request.Header.Get("Authorization"),
			Cookie:        request.Header.Get("Cookie"),
		})
		bridge.mu.Unlock()
		connection, err := websocket.Accept(response, request, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer connection.CloseNow()
		connection.SetReadLimit(4 << 20)
		ctx := context.Background()
		for {
			kind, data, err := connection.Read(ctx)
			if err != nil {
				return
			}
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
