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
	s.writeBrotoPaired(w, session, device, token)
}

// writeBrotoPaired answers a finished Broto pairing, by code or by QR: it
// promotes the session and returns the token with the desktop identity and
// the reach card.
func (s *Server) writeBrotoPaired(w http.ResponseWriter, session transport.Session, device pairing.Device, token string) {
	if listener := s.currentListener(); listener != nil {
		listener.Promote(session.PeerKey())
	}
	desktop := s.desktop()
	reach := s.config.Reach()
	reach.PublicKey = desktop.PublicKey
	json.NewEncoder(w).Encode(map[string]any{"deviceId": device.ID, "token": token, "desktop": map[string]string{"id": desktop.ID, "name": desktop.Name, "publicKey": desktop.PublicKey}, "reach": reach})
	s.emit("devices.changed", map[string]any{"deviceId": device.ID})
}

// serveBrotoQRPair answers the claims of a Broto pairing by QR. servePair
// already tied device.publicKey to the TLS key; the session accepts only the
// key of the QR. The token comes once the phone approved and the Broto
// confirmed the digits of its current nonce; until then a valid claim is a
// poll and gets 202 without spending the pairing quota.
func (s *Server) serveBrotoQRPair(w http.ResponseWriter, session transport.Session, input pairRequest, charge time.Time) {
	data := pairing.DeviceInput{Kind: identity.RoleBroto, Name: input.Device.Name, Model: input.Device.Model, Platform: input.Device.Platform, App: input.Device.App, DeviceKey: session.PeerKey(), Transport: session.Transport(), RemoteAddr: sessionRemoteAddr(session)}
	var device pairing.Device
	var token string
	var saveErr error
	ready, err := s.config.Sessions.ClaimQR(input.PairID, input.Secret, input.Nonce, input.Confirmed, data, func(final pairing.DeviceInput) error {
		device, token, saveErr = s.config.Devices.Pair(final)
		return saveErr
	})
	if saveErr != nil {
		s.writeProblem(w, http.StatusInternalServerError, "pair_internal", "Não foi possível salvar o Broto pareado.")
		return
	}
	if err != nil {
		code := pairing.Code(err)
		if code == "" {
			code = "pair_invalid"
		}
		s.writeProblem(w, http.StatusForbidden, code, err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if !ready {
		s.releasePairCharge(pairOrigin(session), charge)
		w.WriteHeader(http.StatusAccepted)
		json.NewEncoder(w).Encode(map[string]any{"state": "waiting"})
		return
	}
	s.writeBrotoPaired(w, session, device, token)
}
