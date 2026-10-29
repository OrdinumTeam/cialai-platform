// SPDX-License-Identifier: Apache-2.0
package edge

import (
	"bufio"
	"encoding/json"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"net"
	"net/http"
	"time"
)

type bufferedBrotoConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c *bufferedBrotoConn) Read(b []byte) (int, error) { return c.reader.Read(b) }
func (s *Server) serveBrotoPair(w http.ResponseWriter, r *http.Request, session transport.Session, input pairRequest, charge time.Time) {
	data := pairing.DeviceInput{Kind: identity.RoleBroto, Name: input.Device.Name, Model: input.Device.Model, Platform: input.Device.Platform, App: input.Device.App, DeviceKey: session.PeerKey(), Transport: session.Transport(), RemoteAddr: sessionRemoteAddr(session)}
	var device pairing.Device
	var token string
	ready, err := s.config.Sessions.PollBroto(input.PairID, input.Secret, data, func() error { var err error; device, token, err = s.config.Devices.Pair(data); return err })
	if err != nil {
		s.writeProblem(w, 403, pairing.Code(err), err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if !ready {
		s.releasePairCharge(pairOrigin(session), charge)
		w.WriteHeader(202)
		json.NewEncoder(w).Encode(map[string]any{"state": "waiting"})
		return
	}
	if listener := s.currentListener(); listener != nil {
		listener.Promote(session.PeerKey())
	}
	desktop := s.desktop()
	reach := s.config.Reach()
	reach.PublicKey = desktop.PublicKey
	json.NewEncoder(w).Encode(map[string]any{"deviceId": device.ID, "token": token, "desktop": map[string]string{"id": desktop.ID, "name": desktop.Name, "publicKey": desktop.PublicKey}, "reach": reach})
	s.emit("devices.changed", map[string]any{"deviceId": device.ID})
}
