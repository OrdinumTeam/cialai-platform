package brotorpc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

type eventSinkKey struct{}

func WithEventSink(ctx context.Context, sink func(string, json.RawMessage)) context.Context {
	return context.WithValue(ctx, eventSinkKey{}, sink)
}
func emitContext(ctx context.Context, event string, data any) {
	if sink, ok := ctx.Value(eventSinkKey{}).(func(string, json.RawMessage)); ok {
		raw, _ := json.Marshal(data)
		sink(event, raw)
	}
}
func (h *Hub) changed() {
	if h.Event != nil {
		h.Event("broto.requests.changed", map[string]any{})
	}
}
func (h *Hub) Shell(id string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if p := h.peers[id]; p != nil {
		return p.shell
	}
	return ""
}
func (h *Hub) ApprovalUntil(id string) string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if t := h.grants[id]; time.Now().Before(t) {
		return t.UTC().Format(time.RFC3339)
	}
	return ""
}
func (h *Hub) Grant(id string) error {
	if h.Level != nil && h.Level(id) == "read" {
		return errors.New("Broto is read only")
	}
	h.mu.Lock()
	if h.peers[id] == nil {
		h.mu.Unlock()
		return errors.New("Broto offline")
	}
	until := time.Now().Add(15 * time.Minute)
	h.grants[id] = until
	for _, a := range h.pending {
		if a.DeviceID == id {
			select {
			case a.answer <- true:
			default:
			}
		}
	}
	h.mu.Unlock()
	if h.Event != nil {
		h.Event("broto.grant.changed", map[string]any{"deviceId": id, "approvalUntil": until.UTC().Format(time.RFC3339)})
	}
	h.changed()
	time.AfterFunc(time.Until(until), func() {
		h.mu.Lock()
		same := h.grants[id].Equal(until)
		h.mu.Unlock()
		if same {
			h.EndGrant(id)
		}
	})
	return nil
}
func (h *Hub) EndGrant(id string) {
	h.mu.Lock()
	delete(h.grants, id)
	h.mu.Unlock()
	if h.Event != nil {
		h.Event("broto.grant.changed", map[string]any{"deviceId": id, "approvalUntil": ""})
	}
}

func (h *Hub) clearTransfers(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key := range h.transfers {
		if strings.HasPrefix(key, id+"\x00") {
			delete(h.transfers, key)
		}
	}
}
