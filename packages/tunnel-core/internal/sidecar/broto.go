// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"context"
	"encoding/json"
	"errors"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"sort"
	"strings"
	"time"
)

func (r *runtimeState) brotoCommand(ctx context.Context, cmd string, raw json.RawMessage) (any, error) {
	var a struct {
		Name     string          `json:"name"`
		PairID   string          `json:"pairId"`
		Approve  bool            `json:"approve"`
		DeviceID string          `json:"deviceId"`
		Level    string          `json:"level"`
		ID       uint64          `json:"id"`
		Cmd      string          `json:"cmd"`
		Args     json.RawMessage `json:"args"`
		Actor    string          `json:"actor"`
	}
	if len(raw) > 0 {
		if err := decodeArgs(raw, &a); err != nil {
			return nil, err
		}
	}
	if a.Actor != "ai" && a.Actor != "phone" {
		a.Actor = "human"
	}
	registry := r.registry()
	switch cmd {
	case "broto.rename":
		if registry == nil {
			return nil, errors.New("registry unavailable")
		}
		d, ok := registry.Get(a.DeviceID)
		if !ok || d.Kind != identity.RoleBroto || d.Revoked {
			return nil, errors.New("Broto not found")
		}
		err := registry.Rename(a.DeviceID, a.Name)
		if err == nil {
			r.emit("devices.changed", map[string]any{"deviceId": a.DeviceID, "name": a.Name})
		}
		return struct{}{}, err
	case "broto.grant":
		return struct{}{}, r.brotos.Grant(a.DeviceID)
	case "broto.grant.end":
		r.brotos.EndGrant(a.DeviceID)
		return struct{}{}, nil
	case "broto.pair.begin":
		n := r.current()
		if n == nil {
			return nil, errors.New("network unavailable")
		}
		card := n.waitCandidates(ctx, firstCandidatesWait)
		active, err := r.sessions.BeginBroto(pairing.Payload{Desktop: n.currentDesktop(), Onion: n.qrOnion(), Candidates: card.ForQR()})
		if err != nil {
			return nil, err
		}
		return map[string]any{"pairId": active.PairID, "payload": active.Payload, "expiresAt": active.ExpiresAt.Unix()}, nil
	case "broto.pair.pending":
		return r.sessions.PendingBrotos(), nil
	case "broto.pair.decide":
		return struct{}{}, r.sessions.DecideBroto(a.PairID, a.Approve)
	case "broto.requests":
		return r.brotos.Pending(), nil
	case "broto.decide":
		return struct{}{}, r.brotos.Decide(a.ID, a.Approve)
	case "broto.permission.set":
		if registry == nil {
			return nil, errors.New("registry unavailable")
		}
		return struct{}{}, registry.SetBrotoLevel(a.DeviceID, a.Level)
	case "broto.list":
		list := []map[string]any{}
		if registry == nil {
			return list, nil
		}
		devices := registry.List()
		sort.SliceStable(devices, func(i, j int) bool {
			if devices[i].PairedAt.Equal(devices[j].PairedAt) {
				return devices[i].ID < devices[j].ID
			}
			return devices[i].PairedAt.Before(devices[j].PairedAt)
		})
		for _, d := range devices {
			if d.Kind != identity.RoleBroto || d.Revoked {
				continue
			}
			connected, paused := r.brotos.State(d.ID)
			state := "disconnected"
			if connected {
				state = "connected"
			}
			if paused {
				state = "paused"
			}
			level := d.Level
			if level == "" {
				level = "confirm"
			}
			shell := r.brotos.Shell(d.ID)
			if shell == "" {
				shell = "/bin/sh"
				if strings.EqualFold(d.Platform, "windows") {
					shell = "powershell.exe"
				}
			}
			list = append(list, map[string]any{"number": len(list) + 1, "shell": shell, "pairedAt": d.PairedAt, "approvalUntil": r.brotos.ApprovalUntil(d.ID), "id": d.ID, "name": d.Name, "kind": d.Kind, "platform": d.Platform, "connected": connected, "status": state, "state": state, "transport": d.LastTransport, "lastTransport": d.LastTransport, "level": level})
		}
		return list, nil
	case "broto.call":
		if registry == nil {
			return nil, errors.New("registry unavailable")
		}
		d, ok := registry.Get(a.DeviceID)
		if !ok || d.Revoked || d.Kind != identity.RoleBroto {
			return nil, errors.New("Broto not found")
		}
		if a.Actor != "ai" && a.Actor != "phone" {
			a.Actor = "human"
		}
		callCtx, cancel := context.WithTimeout(ctx, 24*time.Hour)
		defer cancel()
		return r.brotos.Call(callCtx, a.DeviceID, a.Cmd, a.Actor, a.Args)
	case "broto.sessions":
		list := []map[string]any{}
		if registry == nil {
			return list, nil
		}
		for _, d := range registry.List() {
			if d.Kind != identity.RoleBroto || d.Revoked || (a.DeviceID != "" && d.ID != a.DeviceID) {
				continue
			}
			connected, _ := r.brotos.State(d.ID)
			if !connected {
				continue
			}
			c, cancel := context.WithTimeout(ctx, 3*time.Second)
			raw, err := r.brotos.Call(c, d.ID, "pty.list", a.Actor, json.RawMessage(`{}`))
			cancel()
			if err != nil {
				continue
			}
			var sessions []map[string]any
			if json.Unmarshal(raw, &sessions) != nil {
				continue
			}
			for _, s := range sessions {
				s["deviceId"] = d.ID
				s["brotoName"] = d.Name
				list = append(list, s)
			}
		}
		return list, nil
	}
	return nil, errors.New("unknown Broto command")
}
