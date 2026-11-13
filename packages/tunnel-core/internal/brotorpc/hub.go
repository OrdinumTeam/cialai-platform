// SPDX-License-Identifier: Apache-2.0
package brotorpc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Peer struct {
	conn    net.Conn
	writeMu sync.Mutex
	mu      sync.Mutex
	calls   map[uint64]chan Message
	sinks   map[uint64]func(string, json.RawMessage)
	slots   chan struct{}
	shell   string
	next    atomic.Uint64
	done    chan struct{}
	paused  bool
}
type Approval struct {
	Summary  string `json:"summary"`
	ID       uint64 `json:"id"`
	DeviceID string `json:"deviceId"`
	Cmd      string `json:"cmd"`
	Actor    string `json:"actor"`
	answer   chan bool
}
type Audit struct {
	TS       time.Time `json:"ts"`
	DeviceID string    `json:"deviceId"`
	Cmd      string    `json:"cmd"`
	Actor    string    `json:"actor"`
	OK       bool      `json:"ok"`
}
type Hub struct {
	mu         sync.Mutex
	peers      map[string]*Peer
	pending    map[uint64]*Approval
	next       uint64
	Level      func(string) string
	Audit      func(Audit)
	Disconnect func(string)
	Event      func(string, any)
	grants     map[string]time.Time
	transfers  map[string]time.Time
}

func NewHub() *Hub {
	return &Hub{grants: map[string]time.Time{}, transfers: map[string]time.Time{}, peers: map[string]*Peer{}, pending: map[uint64]*Approval{}}
}
func (h *Hub) Attach(id string, c net.Conn) {
	p := &Peer{slots: make(chan struct{}, 16), sinks: map[uint64]func(string, json.RawMessage){}, conn: c, calls: map[uint64]chan Message{}, done: make(chan struct{})}
	// Negotiate before making a peer visible to callers. A key alone is not
	// evidence that the peer implements this version of the execution protocol.
	c.SetDeadline(time.Now().Add(10 * time.Second))
	if Write(c, Message{ID: 1, Cmd: "hello", Args: json.RawMessage(`{"version":1}`)}) != nil {
		c.Close()
		return
	}
	for {
		m, err := Read(c)
		if err != nil {
			c.Close()
			return
		}
		if m.Event == "paused" {
			var v struct {
				Paused bool `json:"paused"`
			}
			json.Unmarshal(m.Data, &v)
			p.paused = v.Paused
			continue
		}
		var result struct {
			Version int    `json:"version"`
			Shell   string `json:"shell"`
		}
		if m.ID != 1 || !m.OK || json.Unmarshal(m.Result, &result) != nil || result.Version != 1 {
			c.Close()
			return
		}
		p.shell = result.Shell
		break
	}
	p.next.Store(1)
	c.SetDeadline(time.Time{})
	h.mu.Lock()
	old := h.peers[id]
	h.peers[id] = p
	h.mu.Unlock()
	if old != nil {
		old.conn.Close()
	}
	defer func() {
		c.Close()
		close(p.done)
		h.mu.Lock()
		if h.peers[id] == p {
			for key := range h.transfers {
				if strings.HasPrefix(key, id+"\x00") {
					delete(h.transfers, key)
				}
			}
			delete(h.grants, id)
			delete(h.peers, id)
		}
		h.mu.Unlock()
	}()
	for {
		m, e := Read(c)
		if e != nil {
			return
		}
		if m.Event == "paused" {
			var v struct {
				Paused bool `json:"paused"`
			}
			if json.Unmarshal(m.Data, &v) == nil {
				p.mu.Lock()
				p.paused = v.Paused
				p.mu.Unlock()
				if v.Paused {
					h.clearTransfers(id)
				}
			}
			continue
		}
		if m.Event == "exec.output" {
			var v map[string]json.RawMessage
			if json.Unmarshal(m.Data, &v) == nil {
				var callID uint64
				json.Unmarshal(v["callId"], &callID)
				v["deviceId"], _ = json.Marshal(id)
				raw, _ := json.Marshal(v)
				p.mu.Lock()
				sink := p.sinks[callID]
				p.mu.Unlock()
				if sink != nil {
					sink("broto.exec.output", raw)
				}
			}
			continue
		}
		if m.Event == "disconnected" {
			if h.Disconnect != nil {
				h.Disconnect(id)
			}
			// A QUIC write only queues data. Acknowledge receipt before the
			// client closes its transport, otherwise revocation can be lost.
			p.writeMu.Lock()
			_ = c.SetWriteDeadline(time.Now().Add(time.Second))
			_ = Write(c, Message{Event: "disconnected.ack"})
			p.writeMu.Unlock()
			return
		}
		if m.ID != 0 {
			p.mu.Lock()
			ch := p.calls[m.ID]
			p.mu.Unlock()
			if ch != nil {
				select {
				case ch <- m:
				default:
				}
			}
		}
	}
}
func (h *Hub) State(id string) (bool, bool) {
	h.mu.Lock()
	p := h.peers[id]
	h.mu.Unlock()
	if p == nil {
		return false, false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return true, p.paused
}
func (h *Hub) Close() {
	h.mu.Lock()
	clear(h.grants)
	clear(h.transfers)
	defer h.mu.Unlock()
	for _, p := range h.peers {
		p.conn.Close()
	}
}
func (h *Hub) Pending() []Approval {
	h.mu.Lock()
	defer h.mu.Unlock()
	v := []Approval{}
	for _, p := range h.pending {
		v = append(v, *p)
	}
	sort.Slice(v, func(i, j int) bool { return v[i].ID < v[j].ID })
	return v
}
func (h *Hub) Decide(id uint64, yes bool) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	p := h.pending[id]
	if p == nil {
		return errors.New("approval not found")
	}
	select {
	case p.answer <- yes:
		return nil
	default:
		return errors.New("already decided")
	}
}
func (h *Hub) Call(ctx context.Context, id, cmd, actor string, args json.RawMessage) (result json.RawMessage, err error) {
	defer func() {
		if h.Audit != nil {
			h.Audit(Audit{TS: time.Now().UTC(), DeviceID: id, Cmd: cmd, Actor: actor, OK: err == nil})
		}
	}()
	read := cmd == "hello" || cmd == "pty.list" || cmd == "pty.read" || cmd == "files.list" || cmd == "files.stat"
	cancel := cmd == "exec.cancel" || cmd == "files.cancel"
	// The person at the host or on the phone acts directly: the click or the
	// keystroke is the decision. The confirm level holds what the AI asks for,
	// and resizing a terminal changes nothing on the machine.
	approval := actor == "ai" && cmd != "pty.resize" && !cancel
	switch cmd {
	case "files.list", "files.stat", "files.get", "files.put", "files.cancel", "exec.cancel", "hello", "exec", "pty.open", "pty.write", "pty.resize", "pty.kill", "pty.list", "pty.read":
	default:
		return nil, errors.New("unsupported Broto command")
	}
	h.mu.Lock()
	p := h.peers[id]
	h.mu.Unlock()
	if p == nil {
		return nil, errors.New("Broto offline")
	}
	p.mu.Lock()
	paused := p.paused
	p.mu.Unlock()
	if paused && !read && !cancel {
		return nil, errors.New("Broto paused")
	}
	fileKey := ""
	level := "confirm"
	if h.Level != nil {
		level = h.Level(id)
	}
	if !read && !cancel {
		if level == "read" {
			return nil, errors.New("Broto is read only")
		}
		h.mu.Lock()
		grant := time.Now().Before(h.grants[id])
		h.mu.Unlock()
		var file struct {
			Path       string `json:"path"`
			TransferID string `json:"transfer_id"`
			Final      bool   `json:"final"`
			Size       int64  `json:"size"`
			Overwrite  bool   `json:"overwrite"`
		}

		if (cmd == "files.get" || cmd == "files.put") && json.Unmarshal(args, &file) == nil && file.TransferID != "" {
			fileKey = id + "\x00" + actor + "\x00" + cmd + "\x00" + file.Path + "\x00" + file.TransferID + fmt.Sprintf("\x00%d:%t", file.Size, file.Overwrite)
			h.mu.Lock()
			grant = grant || time.Now().Before(h.transfers[fileKey])
			h.mu.Unlock()
		}
		if level != "free" && approval && !grant {
			var preview map[string]json.RawMessage
			if json.Unmarshal(args, &preview) != nil {
				return nil, errors.New("invalid command arguments")
			}
			// Environment values can carry credentials. They are never sent to
			// the approval list or audit log; the program and arguments are shown.
			delete(preview, "env")
			if cmd == "files.put" || cmd == "files.get" {
				delete(preview, "data")
				delete(preview, "sha256")
				delete(preview, "chunk_sha256")
				direction := "to_broto"
				if cmd == "files.get" {
					direction = "from_broto"
					var path string
					json.Unmarshal(preview["path"], &path)
					statArgs, _ := json.Marshal(map[string]string{"path": path})
					stat, err := p.call(ctx, id, "files.stat", actor, statArgs, nil)
					if err != nil {
						return nil, err
					}
					var info map[string]json.RawMessage
					json.Unmarshal(stat, &info)
					preview["size"] = info["size"]
				}
				preview["direction"], _ = json.Marshal(direction)
			}
			var original struct {
				Env map[string]string `json:"env"`
			}
			if json.Unmarshal(args, &original) == nil && len(original.Env) > 0 {
				keys := make([]string, 0, len(original.Env))
				for key := range original.Env {
					keys = append(keys, key)
				}
				sort.Strings(keys)
				preview["environmentKeys"], _ = json.Marshal(keys)
			}
			if cmd == "pty.write" {
				var encoded string
				if json.Unmarshal(preview["data"], &encoded) == nil {
					if data, err := base64.StdEncoding.DecodeString(encoded); err == nil {
						delete(preview, "data")
						preview["text"], _ = json.Marshal(string(data))
					}
				}
			}
			shown, _ := json.Marshal(preview)
			if len(shown) > 32*1024 {
				return nil, errors.New("command preview too large")
			}
			h.mu.Lock()
			h.next++
			a := &Approval{ID: h.next, DeviceID: id, Cmd: cmd, Actor: actor, Summary: string(shown), answer: make(chan bool, 1)}
			h.pending[a.ID] = a
			h.mu.Unlock()
			if cmd == "exec" {
				var v map[string]any
				json.Unmarshal(args, &v)
				queued := map[string]any{"deviceId": id, "command": v["command"], "args": v["args"]}
				if h.Event != nil {
					h.Event("broto.exec.queued", queued)
				}
				emitContext(ctx, "broto.exec.queued", queued)
			}
			h.changed()
			emitContext(ctx, "broto.approval.waiting", map[string]any{"deviceId": id, "id": a.ID})
			defer func() { h.mu.Lock(); delete(h.pending, a.ID); h.mu.Unlock(); h.changed() }()
			timer := time.NewTimer(10 * time.Minute)
			defer timer.Stop()
			select {
			case yes := <-a.answer:
				h.mu.Lock()
				delete(h.pending, a.ID)
				h.mu.Unlock()
				h.changed()
				if !yes {
					return nil, errors.New("command declined")
				}
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-p.done:
				return nil, errors.New("Broto disconnected")
			case <-timer.C:
				return nil, errors.New("approval expired")
			}
		}
		if fileKey != "" {
			h.mu.Lock()
			for k, expiry := range h.transfers {
				if time.Now().After(expiry) {
					delete(h.transfers, k)
				}
			}
			h.transfers[fileKey] = time.Now().Add(15 * time.Minute)
			h.mu.Unlock()
			if file.Final {
				defer func() { h.mu.Lock(); delete(h.transfers, fileKey); h.mu.Unlock() }()
			}
		}
		if h.Level != nil && h.Level(id) == "read" {
			return nil, errors.New("Broto is read only")
		}
	}
	p.mu.Lock()
	paused = p.paused
	p.mu.Unlock()
	if paused && !read && !cancel {
		return nil, errors.New("Broto paused")
	}
	if cmd == "files.cancel" {
		var a struct {
			Path       string `json:"path"`
			TransferID string `json:"transfer_id"`
		}
		if json.Unmarshal(args, &a) == nil {
			h.mu.Lock()
			for _, verb := range []string{"files.get", "files.put"} {
				prefix := id + "\x00" + actor + "\x00" + verb + "\x00" + a.Path + "\x00" + a.TransferID + "\x00"
				for key := range h.transfers {
					if strings.HasPrefix(key, prefix) {
						delete(h.transfers, key)
					}
				}
			}
			h.mu.Unlock()
		}
	}
	result, err = p.call(ctx, id, cmd, actor, args, h.Event)
	if fileKey != "" {
		var state struct {
			EOF      bool `json:"eof"`
			Complete bool `json:"complete"`
		}
		json.Unmarshal(result, &state)
		if err != nil || state.EOF || state.Complete {
			h.mu.Lock()
			delete(h.transfers, fileKey)
			h.mu.Unlock()
		}
	}
	return result, err
}
func (p *Peer) call(ctx context.Context, deviceID, cmd, actor string, args json.RawMessage, event func(string, any)) (result json.RawMessage, callErr error) {
	if cmd != "exec.cancel" && cmd != "files.cancel" {
		select {
		case p.slots <- struct{}{}:
			defer func() { <-p.slots }()
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-p.done:
			return nil, errors.New("Broto disconnected")
		}
	}
	id := p.next.Add(1)
	started := time.Now()
	deliveries := []*eventDelivery{}
	if cmd == "exec" {
		if actor == "ai" && event != nil {
			deliveries = append(deliveries, newEventDelivery(func(name string, raw json.RawMessage) {
				var data map[string]any
				json.Unmarshal(raw, &data)
				event(name, data)
			}))
		}
		if sink, ok := ctx.Value(eventSinkKey{}).(func(string, json.RawMessage)); ok {
			deliveries = append(deliveries, newEventDelivery(sink))
		}
	}
	emit := func(name string, value any) {
		raw, _ := json.Marshal(value)
		for _, d := range deliveries {
			d.push(deliveryItem{name: name, data: raw})
		}
	}
	cancelRemote := func() {
		raw, _ := json.Marshal(map[string]any{"call_id": id})
		p.writeMu.Lock()
		defer p.writeMu.Unlock()
		p.conn.SetWriteDeadline(time.Now().Add(time.Second))
		_ = Write(p.conn, Message{ID: p.next.Add(1), Cmd: "exec.cancel", Actor: actor, Args: raw})
		p.conn.SetWriteDeadline(time.Time{})
	}
	if cmd == "exec" {
		var argsValue map[string]any
		json.Unmarshal(args, &argsValue)
		emit("broto.exec.started", map[string]any{"deviceId": deviceID, "callId": id, "command": argsValue["command"], "args": argsValue["args"]})
		defer func() {
			if callErr == nil {
				for _, d := range deliveries {
					if err := d.flush(ctx); err != nil {
						callErr = err
						result = nil
						cancelRemote()
						break
					}
				}
			}
			v := map[string]any{}
			json.Unmarshal(result, &v)
			v["deviceId"] = deviceID
			v["callId"] = id
			v["duration_ms"] = time.Since(started).Milliseconds()
			if callErr != nil {
				v["error"] = callErr.Error()
			}
			raw, _ := json.Marshal(v)
			for _, d := range deliveries {
				d.finish("broto.exec.finished", raw, callErr != nil)
			}
			if callErr == nil {
				for _, d := range deliveries {
					select {
					case <-d.done:
					case <-ctx.Done():
						callErr = ctx.Err()
						result = nil
					}
				}
			}
		}()
	}
	failed := make(chan struct{}, 1)
	stopWatch := make(chan struct{})
	defer close(stopWatch)
	for _, d := range deliveries {
		go func(d *eventDelivery) {
			select {
			case <-d.failure:
				select {
				case failed <- struct{}{}:
				default:
				}
			case <-stopWatch:
			}
		}(d)
	}
	ch := make(chan Message, 1)
	p.mu.Lock()
	p.calls[id] = ch
	p.sinks[id] = func(name string, raw json.RawMessage) {
		for _, d := range deliveries {
			d.push(deliveryItem{name: name, data: raw})
		}
	}

	p.mu.Unlock()
	defer func() { p.mu.Lock(); delete(p.calls, id); delete(p.sinks, id); p.mu.Unlock() }()
	p.writeMu.Lock()
	p.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	err := Write(p.conn, Message{ID: id, Cmd: cmd, Actor: actor, Args: args})
	p.conn.SetWriteDeadline(time.Time{})
	p.writeMu.Unlock()
	if err != nil {
		return nil, err
	}
	select {
	case m := <-ch:
		if !m.OK {
			return nil, errors.New(m.Error)
		}
		return m.Result, nil
	case <-failed:
		cancelRemote()
		return nil, errOutputBackpressure
	case <-ctx.Done():
		if cmd == "exec" {
			cancelRemote()
		}
		return nil, ctx.Err()

	case <-p.done:
		return nil, errors.New("Broto disconnected")
	}
}
