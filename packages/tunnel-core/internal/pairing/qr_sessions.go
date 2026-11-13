// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"bytes"
	"crypto/ed25519"
	"crypto/subtle"
	"encoding/base64"
	"strings"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

// Stages of a pairing by QR, as broto.qr.state reports them.
const (
	// QRStageWaiting: the Broto has not claimed the session yet.
	QRStageWaiting = "waiting"
	// QRStageVerify: the Broto claimed it and the phone has not decided.
	QRStageVerify = "verify"
	// QRStageApproved: the phone approved and the Broto has not confirmed.
	QRStageApproved = "approved"
	QRStageDone     = "done"
	QRStageDenied   = "denied"
	QRStageExpired  = "expired"
)

// QRSession is the host view of a pairing by QR. QRID is the pairing id
// derived from the QR secret. Digits is set only in verify and approved.
type QRSession struct {
	QRID      string    `json:"qrId"`
	Stage     string    `json:"stage"`
	Name      string    `json:"name"`
	Platform  string    `json:"platform"`
	Digits    string    `json:"digits"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// qrSession is the part of a session opened by BeginQR. The session secret is
// the pair secret derived from the QR, so PairingActive, the constant-time
// check and the lockout cover it as any other session.
type qrSession struct {
	brotoKey  string
	name      string
	platform  string
	secret    []byte
	hostKey   ed25519.PublicKey
	requester string
	// nonce is the one of the last claim; the digits and the confirmation of
	// the Broto belong to it.
	nonce     []byte
	digits    string
	confirmed bool
	approved  bool
	denied    bool
	done      bool
}

// OnQRChange registers the function told about every change of stage or
// digits of a QR session. It runs outside the session lock and must return
// quickly; expiry is not reported, callers time it from ExpiresAt.
func (s *Sessions) OnQRChange(notify func(qrID string)) {
	s.mu.Lock()
	s.onQRChange = notify
	s.mu.Unlock()
}

// BeginQR opens the host session of a QR scanned by a paired phone. requester
// is the phone that scanned it; when set, only that phone may decide. desktop
// is the identity whose key the host presents over TLS, part of the digits.
// A QR opens one session only, even after it ended, and at most
// MaxLiveQRSessions run at once.
func (s *Sessions) BeginQR(payload string, desktop Desktop, requester string) (QRSession, QRKeys, error) {
	qr, err := DecodeQR(strings.TrimSpace(payload))
	if err != nil {
		return QRSession{}, QRKeys{}, err
	}
	hostKey, err := identity.ParsePublicKey(desktop.PublicKey)
	if err != nil {
		return QRSession{}, QRKeys{}, wrapError("pair_internal", "A identidade deste computador é inválida.", err)
	}
	secret, err := qr.SecretBytes()
	if err != nil {
		return QRSession{}, QRKeys{}, err
	}
	keys, err := DeriveQR(secret)
	if err != nil {
		return QRSession{}, QRKeys{}, err
	}
	pairSecret, err := base64.RawURLEncoding.DecodeString(keys.PairSecret)
	if err != nil {
		return QRSession{}, QRKeys{}, wrapError("pair_internal", "Não foi possível abrir o pareamento do Broto.", err)
	}
	expiresAt := time.Unix(qr.ExpiresAt, 0).UTC().Add(QRGrace)
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.pruneLocked(now)
	switch {
	case !now.Before(expiresAt):
		return QRSession{}, QRKeys{}, NewError("qr_expired", "Este código do Broto expirou. Mostre um código novo no Broto.")
	case expiresAt.After(now.Add(QRTTL + 2*QRGrace)):
		return QRSession{}, QRKeys{}, NewError("qr_invalid", "A validade do código do Broto é inválida. Confira o relógio do Broto.")
	}
	if _, exists := s.items[keys.PairID]; exists {
		return QRSession{}, QRKeys{}, NewError("qr_used", "Este código do Broto já foi lido. Mostre um código novo no Broto.")
	}
	if s.liveQRLocked(now) >= MaxLiveQRSessions {
		return QRSession{}, QRKeys{}, NewError("qr_busy", "Já existem pareamentos de Broto em andamento. Conclua um deles antes.")
	}
	current := &session{
		secret: pairSecret, expiresAt: expiresAt, desktop: desktop,
		qr: &qrSession{brotoKey: qr.Key, name: qr.Name, platform: qr.Platform, secret: secret, hostKey: hostKey, requester: requester},
	}
	s.items[keys.PairID] = current
	return qrView(keys.PairID, current, now), keys, nil
}

func (s *Sessions) liveQRLocked(now time.Time) int {
	live := 0
	for _, current := range s.items {
		if current.qr != nil && !current.consumed && now.Before(current.expiresAt) && current.failures < MaxSecretFailures {
			live++
		}
	}
	return live
}

// QRState returns the view of a QR session, ended ones included until they
// are pruned.
func (s *Sessions) QRState(qrID string) (QRSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current := s.items[qrID]
	if current == nil || current.qr == nil {
		return QRSession{}, NewError("qr_unknown", "Este pareamento de Broto não existe.")
	}
	return qrView(qrID, current, s.now()), nil
}

// DecideQR applies the decision of the phone and returns the new stage. The
// phone approves only after the Broto claimed the session; it may deny until
// the pairing ends. When BeginQR recorded a requester, only it may decide.
func (s *Sessions) DecideQR(qrID string, approve bool, requester string) (string, error) {
	s.mu.Lock()
	current := s.items[qrID]
	if current == nil || current.qr == nil || (current.qr.requester != "" && current.qr.requester != requester) {
		s.mu.Unlock()
		return "", NewError("qr_unknown", "Este pareamento de Broto não existe.")
	}
	now := s.now()
	stage := qrStage(current, now)
	switch {
	case approve && stage == QRStageVerify:
		current.qr.approved = true
	case !approve && (stage == QRStageWaiting || stage == QRStageVerify || stage == QRStageApproved):
		current.qr.denied = true
		current.consumed = true
	default:
		s.mu.Unlock()
		return "", NewError("qr_not_ready", "Este pareamento de Broto não aceita esta decisão agora.")
	}
	stage = qrStage(current, now)
	notify := s.onQRChange
	s.mu.Unlock()
	if notify != nil {
		notify(qrID)
	}
	return stage, nil
}

// ClaimQR serves POST /pair of kind broto-qr. Only the key of the QR claims
// the session. A new nonce starts the check again: it changes the digits and
// clears the confirmation of the Broto, while the decision of the phone stays;
// confirmed counts only with the current nonce. finish runs once, under the
// session lock, only after the phone approved and the Broto confirmed, with
// the device named as the phone saw it in the QR.
func (s *Sessions) ClaimQR(pairID, secret, nonce string, confirmed bool, input DeviceInput, finish func(DeviceInput) error) (bool, error) {
	input.Kind = identity.RoleBroto
	s.mu.Lock()
	current, err := s.checkQRLocked(pairID, secret)
	if err != nil {
		s.mu.Unlock()
		return false, err
	}
	claim := current.qr
	if input.DeviceKey != claim.brotoKey {
		s.mu.Unlock()
		return false, NewError("pair_claimed", "Este código pertence a outro Broto.")
	}
	presented, nonceErr := base64.RawURLEncoding.DecodeString(nonce)
	if nonceErr != nil || !validRawURLBytes(nonce, QRNonceSize) {
		s.mu.Unlock()
		return false, NewError("pair_invalid", "A confirmação do Broto é inválida.")
	}
	input.Name, input.Platform = claim.name, claim.platform
	if _, err := validateDeviceInput(input); err != nil {
		s.mu.Unlock()
		return false, wrapError("pair_invalid", "Os dados do Broto são inválidos.", err)
	}
	changed := false
	if claim.nonce == nil || !bytes.Equal(presented, claim.nonce) {
		brotoKey, _ := identity.ParsePublicKey(claim.brotoKey)
		claim.nonce = presented
		claim.digits = QRDigits(claim.hostKey, brotoKey, claim.secret, presented)
		claim.confirmed = false
		changed = true
	} else if confirmed {
		claim.confirmed = true
	}
	ready := claim.approved && claim.confirmed
	if ready {
		if err := finish(input); err != nil {
			notify := s.onQRChange
			s.mu.Unlock()
			if changed && notify != nil {
				notify(pairID)
			}
			return false, err
		}
		claim.done = true
		current.consumed = true
		changed = true
	}
	notify := s.onQRChange
	s.mu.Unlock()
	if changed && notify != nil {
		notify(pairID)
	}
	return ready, nil
}

// checkQRLocked authenticates a claim with the derived pair secret before it
// reveals anything about the session.
func (s *Sessions) checkQRLocked(pairID, encodedSecret string) (*session, error) {
	presented, decodeErr := base64.RawURLEncoding.DecodeString(encodedSecret)
	current, exists := s.items[pairID]
	if !exists {
		return nil, NewError("pair_unknown", "Este código do Broto não está ativo no computador.")
	}
	if current.qr == nil {
		return nil, NewError("pair_invalid", "Este pareamento não é de um código de Broto.")
	}
	if current.failures >= MaxSecretFailures || decodeErr != nil || len(presented) != len(current.secret) || subtle.ConstantTimeCompare(presented, current.secret) != 1 {
		if current.failures < MaxSecretFailures {
			current.failures++
		}
		return nil, NewError("pair_invalid", "O segredo do código do Broto não confere.")
	}
	switch {
	case current.qr.denied:
		return nil, NewError("pair_denied", "O pareamento do Broto foi recusado no celular.")
	case current.consumed:
		return nil, NewError("pair_invalid", "Este código do Broto já foi usado.")
	case !s.now().Before(current.expiresAt):
		return nil, NewError("pair_expired", "Este código do Broto expirou.")
	}
	return current, nil
}

func qrStage(current *session, now time.Time) string {
	claim := current.qr
	switch {
	case claim.done:
		return QRStageDone
	case claim.denied:
		return QRStageDenied
	case !now.Before(current.expiresAt):
		return QRStageExpired
	case claim.approved:
		return QRStageApproved
	case claim.nonce != nil:
		return QRStageVerify
	default:
		return QRStageWaiting
	}
}

func qrView(qrID string, current *session, now time.Time) QRSession {
	view := QRSession{
		QRID: qrID, Stage: qrStage(current, now), Name: current.qr.name, Platform: current.qr.platform,
		ExpiresAt: current.expiresAt,
	}
	if view.Stage == QRStageVerify || view.Stage == QRStageApproved {
		view.Digits = current.qr.digits
	}
	return view
}
