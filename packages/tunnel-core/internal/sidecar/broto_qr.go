// SPDX-License-Identifier: Apache-2.0
package sidecar

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/logx"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
)

// Onion states of a pairing by QR, as broto.qr.state reports them.
const (
	qrOnionPublishing = "publishing"
	qrOnionReady      = "ready"
	qrOnionOff        = "off"
)

const (
	// qrPoll spaces the checks of the expiry and of the temporary descriptor
	// upload of a pairing by QR.
	qrPoll = time.Second
	// maxQRRequester bounds the device id of the phone that read a QR.
	maxQRRequester = 128
)

// qrLinger keeps the paths of a pairing by QR open for a while after it was
// done or denied, so the next poll of the Broto still reads the answer. It is
// a variable so tests can shorten it.
var qrLinger = 30 * time.Second

// TemporaryOnions publishes the temporary onion services of the pairings by
// QR next to the desktop service and on the same listener; *tor.Desktop
// implements it. A TorService without it pairs Brotos by QR on the local
// network only.
type TemporaryOnions interface {
	AddEphemeral(seed [32]byte) (string, error)
	RemoveEphemeral(address string) error
	EphemeralPublished(address string) bool
}

var _ TemporaryOnions = (*tor.Desktop)(nil)

// qrStateResult is the answer of broto.qr.state. Digits is set only in the
// verify and approved stages.
type qrStateResult struct {
	QRID      string `json:"qrId"`
	Stage     string `json:"stage"`
	Name      string `json:"name"`
	Platform  string `json:"platform"`
	Digits    string `json:"digits,omitempty"`
	ExpiresAt string `json:"expiresAt"`
	Onion     string `json:"onion"`
}

// brotoQRCommand serves broto.qr.*: a paired phone read the QR a Broto shows
// and decides on the pairing. Every call answers at once; the mDNS marker and
// the temporary onion service start in the background and every change of
// the session arrives as broto.qr.changed.
func (runtime *runtimeState) brotoQRCommand(cmd string, raw json.RawMessage) (any, error) {
	switch cmd {
	case "broto.qr.begin":
		return runtime.qrBegin(raw)
	case "broto.qr.state":
		return runtime.qrState(raw)
	case "broto.qr.decide":
		return runtime.qrDecide(raw)
	}
	return nil, errors.New("unknown Broto command")
}

func (runtime *runtimeState) qrBegin(raw json.RawMessage) (any, error) {
	var args struct {
		Payload   string `json:"payload"`
		Requester string `json:"requester"`
	}
	if err := decodeArgs(raw, &args); err != nil || len(args.Requester) > maxQRRequester {
		return nil, invalid("Os argumentos do código do Broto são inválidos.")
	}
	n := runtime.current()
	if n == nil || n.direct == nil {
		return nil, &serviceError{code: "net_not_ready", message: "A rede deste computador ainda não está pronta para parear.", retryable: true}
	}
	view, keys, err := runtime.sessions.BeginQR(args.Payload, n.currentDesktop(), args.Requester)
	if err != nil {
		return nil, err
	}
	n.watchQR(view, keys)
	return map[string]any{"qrId": view.QRID, "name": view.Name, "platform": view.Platform, "expiresAt": qrTime(view.ExpiresAt)}, nil
}

func (runtime *runtimeState) qrState(raw json.RawMessage) (any, error) {
	var args struct {
		QRID string `json:"qrId"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.QRID == "" {
		return nil, invalid("Informe o pareamento de Broto.")
	}
	view, err := runtime.sessions.QRState(args.QRID)
	if err != nil {
		return nil, err
	}
	onion := qrOnionOff
	if n := runtime.current(); n != nil {
		onion = n.temporaryOnion(view.QRID)
	}
	return qrStateResult{
		QRID: view.QRID, Stage: view.Stage, Name: view.Name, Platform: view.Platform,
		Digits: view.Digits, ExpiresAt: qrTime(view.ExpiresAt), Onion: onion,
	}, nil
}

// qrDecide requires approve: a missing decision is not taken as a denial.
func (runtime *runtimeState) qrDecide(raw json.RawMessage) (any, error) {
	var args struct {
		QRID      string `json:"qrId"`
		Approve   *bool  `json:"approve"`
		Requester string `json:"requester"`
	}
	if err := decodeArgs(raw, &args); err != nil || args.QRID == "" || args.Approve == nil {
		return nil, invalid("Informe o pareamento de Broto e a decisão.")
	}
	stage, err := runtime.sessions.DecideQR(args.QRID, *args.Approve, args.Requester)
	if err != nil {
		return nil, err
	}
	return map[string]any{"stage": stage}, nil
}

func qrTime(at time.Time) string { return at.UTC().Format(time.RFC3339) }

// qrChanged is told by the sessions about every change of stage or digits:
// the UI reads the new state and the network ends the paths of a session
// that is over.
func (runtime *runtimeState) qrChanged(qrID string) {
	runtime.emitQRChanged(qrID)
	if n := runtime.current(); n != nil {
		n.wakeQR(qrID)
	}
}

// emitQRChanged sends broto.qr.changed with the stage the session has now.
// It is serialized, so the last event of a session carries its last stage.
func (runtime *runtimeState) emitQRChanged(qrID string) {
	runtime.qrMu.Lock()
	defer runtime.qrMu.Unlock()
	view, err := runtime.sessions.QRState(qrID)
	if err != nil {
		return
	}
	runtime.emit("broto.qr.changed", map[string]any{"qrId": qrID, "stage": view.Stage})
}

// qrWatch is the network side of one pairing by QR: the mDNS marker and the
// temporary onion service by which the Broto finds this desktop. The fields
// after wake are guarded by network.mu.
type qrWatch struct {
	id   string
	keys pairing.QRKeys
	wake chan struct{}

	marker  Announcer
	address string
	onion   string
}

// watchQR opens the paths of a QR session in the background and closes them
// when the session expires, some time after it was done or denied, or when
// the network stops.
func (n *network) watchQR(view pairing.QRSession, keys pairing.QRKeys) {
	temporary, _ := n.tor.(TemporaryOnions)
	watch := &qrWatch{id: view.QRID, keys: keys, wake: make(chan struct{}, 1), onion: qrOnionOff}
	if temporary != nil {
		watch.onion = qrOnionPublishing
	}
	n.mu.Lock()
	if n.stopped || n.qrs[watch.id] != nil {
		n.mu.Unlock()
		return
	}
	n.qrs[watch.id] = watch
	n.qrWG.Add(1)
	n.mu.Unlock()
	go n.runQR(watch, temporary)
}

func (n *network) wakeQR(qrID string) {
	n.mu.Lock()
	watch := n.qrs[qrID]
	n.mu.Unlock()
	if watch == nil {
		return
	}
	select {
	case watch.wake <- struct{}{}:
	default:
	}
}

// temporaryOnion is the onion state of a QR session: off without Tor, when
// Tor refused the service or once the paths closed.
func (n *network) temporaryOnion(qrID string) string {
	n.mu.Lock()
	defer n.mu.Unlock()
	if watch := n.qrs[qrID]; watch != nil {
		return watch.onion
	}
	return qrOnionOff
}

func (n *network) runQR(watch *qrWatch, temporary TemporaryOnions) {
	defer n.qrWG.Done()
	defer n.closeQRPaths(watch, temporary)
	n.openQRPaths(watch, temporary)
	ticker := time.NewTicker(qrPoll)
	defer ticker.Stop()
	linger := time.NewTimer(qrLinger)
	linger.Stop()
	defer linger.Stop()
	ending := false
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-linger.C:
			return
		case <-watch.wake:
		case <-ticker.C:
		}
		if ending {
			continue
		}
		view, err := n.config.sessions.QRState(watch.id)
		switch {
		case err != nil:
			return
		case view.Stage == pairing.QRStageExpired:
			// The sessions do not report expiry; the watch does.
			n.config.onQRChanged(watch.id)
			return
		case view.Stage == pairing.QRStageDone || view.Stage == pairing.QRStageDenied:
			ending = true
			linger.Reset(qrLinger)
		default:
			n.pollQROnion(watch, temporary)
		}
	}
}

// openQRPaths announces the marker on the local network with the port of the
// direct listener and adds the temporary onion service. A failure of either
// leaves the other path; it is logged without the key or the address, which
// derive from the QR secret.
func (n *network) openQRPaths(watch *qrWatch, temporary TemporaryOnions) {
	if factory := n.config.seams.NewAnnouncer; factory != nil {
		marker, err := factory(AnnouncerConfig{PublicKey: watch.keys.MarkerKey(), Port: uint16(n.port), Logf: n.config.logger.Logf("debug")})
		if err != nil {
			n.config.logger.Warn("broto pairing marker not announced", logx.Fields{"error": err.Error()})
		} else {
			n.mu.Lock()
			watch.marker = marker
			n.mu.Unlock()
		}
	}
	if temporary == nil {
		return
	}
	address, err := temporary.AddEphemeral(watch.keys.OnionSeed)
	n.mu.Lock()
	watch.address = address
	if err != nil {
		watch.onion = qrOnionOff
	}
	n.mu.Unlock()
	if err != nil {
		n.config.logger.Warn("temporary onion service not added", logx.Fields{"error": err.Error()})
		n.config.onQRChanged(watch.id)
	}
}

// pollQROnion follows the descriptor upload of the temporary service, which
// a Tor restart starts again, and tells the UI when it changes.
func (n *network) pollQROnion(watch *qrWatch, temporary TemporaryOnions) {
	n.mu.Lock()
	address, current := watch.address, watch.onion
	n.mu.Unlock()
	if temporary == nil || address == "" || current == qrOnionOff {
		return
	}
	next := qrOnionPublishing
	if temporary.EphemeralPublished(address) {
		next = qrOnionReady
	}
	if next == current {
		return
	}
	n.mu.Lock()
	watch.onion = next
	n.mu.Unlock()
	n.config.onQRChanged(watch.id)
}

func (n *network) closeQRPaths(watch *qrWatch, temporary TemporaryOnions) {
	n.mu.Lock()
	delete(n.qrs, watch.id)
	marker, address := watch.marker, watch.address
	watch.marker, watch.address, watch.onion = nil, "", qrOnionOff
	n.mu.Unlock()
	if marker != nil {
		if err := marker.Close(); err != nil {
			n.config.logger.Warn("broto pairing marker not withdrawn", logx.Fields{"error": err.Error()})
		}
	}
	if temporary != nil && address != "" {
		if err := temporary.RemoveEphemeral(address); err != nil {
			n.config.logger.Warn("temporary onion service not removed", logx.Fields{"error": err.Error()})
		}
	}
}

// qrMarkers lists the marker announcers of the running pairings by QR.
func (n *network) qrMarkers() []Announcer {
	n.mu.Lock()
	defer n.mu.Unlock()
	markers := make([]Announcer, 0, len(n.qrs))
	for _, watch := range n.qrs {
		if watch.marker != nil {
			markers = append(markers, watch.marker)
		}
	}
	return markers
}
