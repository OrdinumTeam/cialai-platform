// SPDX-License-Identifier: Apache-2.0
package brotoclient

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"runtime"
	"strings"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/mdns"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

// Stages of a pairing by QR, as Status.QR reports them.
const (
	// qrStageShowing: the QR is on screen and no host answered yet.
	qrStageShowing = "showing"
	// qrStageDigits: a host answered; the person types the digits the phone
	// shows.
	qrStageDigits = "digits"
	// qrStageApproving: the digits matched; the host waits for the phone.
	qrStageApproving = "approving"
	qrStageFailed    = "failed"
)

// Reasons of a failed pairing by QR.
const (
	qrReasonExpired = "expired"
	qrReasonDenied  = "denied"
	qrReasonDigits  = "digits"
	qrReasonRefused = "refused"
)

// qrDigitAttempts is how many times the person may type the digits.
const qrDigitAttempts = 3

var (
	errQRNotWaiting = errors.New("Este Broto não está esperando os números do celular.")
	errQRDigits     = errors.New("Digite os 4 números mostrados no celular.")
)

// QRStatus is the pairing by QR in Status. Payload is the text of the QR,
// cleared once the pairing failed; Reason is set only then.
type QRStatus struct {
	Payload      string `json:"payload,omitempty"`
	ExpiresAt    string `json:"expiresAt"`
	Stage        string `json:"stage"`
	AttemptsLeft int    `json:"attemptsLeft"`
	Reason       string `json:"reason,omitempty"`
}

// qrTiming paces the search for the host of a pairing by QR and the polls
// that follow.
type qrTiming struct {
	// lookupWindow is one mDNS browse; lookups start every lookupEvery and
	// every lookupSlowEvery after lookupSlowAfter.
	lookupWindow    time.Duration
	lookupEvery     time.Duration
	lookupSlowAfter time.Duration
	lookupSlowEvery time.Duration
	// onionFirst is the delay of the first onion attempt after the QR
	// appears; onionEvery spaces the next ones, each bounded by onionTimeout
	// and preceded by NEWNYM at most once per newnymSpacing.
	onionFirst    time.Duration
	onionEvery    time.Duration
	onionTimeout  time.Duration
	newnymSpacing time.Duration
	// directTimeout bounds one dial of the direct addresses.
	directTimeout time.Duration
	// digitsPoll and approvePoll space the claims after the first answer,
	// before and after the digits matched.
	digitsPoll  time.Duration
	approvePoll time.Duration
}

var defaultQRTiming = qrTiming{
	lookupWindow: 2 * time.Second, lookupEvery: 4 * time.Second, lookupSlowAfter: time.Minute, lookupSlowEvery: 12 * time.Second,
	onionFirst: 15 * time.Second, onionEvery: 15 * time.Second, onionTimeout: 30 * time.Second, newnymSpacing: 10 * time.Second,
	directTimeout: 4 * time.Second, digitsPoll: 5 * time.Second, approvePoll: 2 * time.Second,
}

// qrSeams are the ways a pairing by QR reaches its host; tests replace them.
// The dialers record the host key when pinned is nil and pin it otherwise,
// and return the key of the host they reached.
type qrSeams struct {
	lookup func(ctx context.Context, marker ed25519.PublicKey, window time.Duration) []netip.AddrPort
	direct func(ctx context.Context, addresses []netip.AddrPort, pinned ed25519.PublicKey) (net.Conn, ed25519.PublicKey, error)
	onion  func(ctx context.Context, onion string, pinned ed25519.PublicKey) (net.Conn, ed25519.PublicKey, error)
	newnym func(ctx context.Context) error
	timing qrTiming
}

func (seams *qrSeams) fill(c *Client) {
	if seams.lookup == nil {
		seams.lookup = lookupMarker
	}
	if seams.direct == nil {
		seams.direct = c.dialQRDirect
	}
	if seams.onion == nil {
		seams.onion = c.dialQROnion
	}
	if seams.newnym == nil {
		seams.newnym = c.tor.Newnym
	}
	if seams.timing == (qrTiming{}) {
		seams.timing = defaultQRTiming
	}
}

// qrFlow is one pairing by QR. The fields after wake are guarded by
// Client.mu; digits are the ones this Broto computed and never leave it.
type qrFlow struct {
	payload   string
	expiresAt time.Time
	keys      pairing.QRKeys
	secret    []byte
	onion     string
	wake      chan struct{}

	stage    string
	reason   string
	attempts int
	digits   string
}

func (flow *qrFlow) status() *QRStatus {
	status := &QRStatus{
		Payload: flow.payload, ExpiresAt: flow.expiresAt.UTC().Format(time.RFC3339),
		Stage: flow.stage, AttemptsLeft: flow.attempts, Reason: flow.reason,
	}
	if flow.stage == qrStageFailed {
		status.Payload = ""
	}
	return status
}

// qrRoute is how a claim reaches the host: the direct addresses announced
// with the marker, or the temporary onion service.
type qrRoute struct {
	addresses []netip.AddrPort
	onion     string
}

// qrContact is the host that answered the first claim: its key, pinned from
// then on, the route and the nonce the digits cover.
type qrContact struct {
	route   qrRoute
	hostKey ed25519.PublicKey
	nonce   []byte
}

// BeginQR shows a new pairing QR. It stops the current run and forgets the
// saved host: the Broto pairs with the host of the phone that reads the QR.
func (c *Client) BeginQR() (QRStatus, error) {
	qr, err := pairing.NewQR(c.local.PublicKey(), c.name, runtime.GOOS, time.Now().Add(pairing.QRTTL), nil)
	if err != nil {
		return QRStatus{}, err
	}
	payload, err := pairing.EncodeQR(qr)
	if err != nil {
		return QRStatus{}, err
	}
	keys, err := qr.Derive()
	if err != nil {
		return QRStatus{}, err
	}
	secret, err := qr.SecretBytes()
	if err != nil {
		return QRStatus{}, err
	}
	onionKey, err := tor.OnionKeyFromSeed(keys.OnionSeed[:])
	if err != nil {
		return QRStatus{}, err
	}
	flow := &qrFlow{
		payload: payload, expiresAt: time.Unix(qr.ExpiresAt, 0), keys: keys, secret: secret, onion: onionKey.Address(),
		wake: make(chan struct{}, 1), stage: qrStageShowing, attempts: qrDigitAttempts,
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.stopLocked()
	c.host = nil
	if err = saveHost(c.paths, nil); err != nil {
		return QRStatus{}, err
	}
	c.paused = false
	c.qr = flow
	ctx, cancel := context.WithCancel(c.base)
	c.cancel = cancel
	c.generation++
	c.status = Status{State: "waiting", Activity: c.status.Activity}
	go c.runQR(ctx, c.generation, flow)
	return *flow.status(), nil
}

// ConfirmQR checks the digits typed on this Broto, in constant time, against
// the ones it computed for the host it reached. A match lets the host finish
// once the phone approves; the third mismatch ends the pairing.
func (c *Client) ConfirmQR(digits string) (bool, int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	flow := c.qr
	if flow == nil || flow.stage != qrStageDigits {
		return false, 0, errQRNotWaiting
	}
	if len(digits) != 4 || strings.Trim(digits, "0123456789") != "" {
		return false, flow.attempts, errQRDigits
	}
	if subtle.ConstantTimeCompare([]byte(digits), []byte(flow.digits)) == 1 {
		flow.stage = qrStageApproving
		select {
		case flow.wake <- struct{}{}:
		default:
		}
		return true, flow.attempts, nil
	}
	flow.attempts--
	if flow.attempts <= 0 {
		c.failQRLocked(flow, qrReasonDigits)
	}
	return false, flow.attempts, nil
}

// CancelQR ends the pairing by QR, running or failed, and leaves the Broto
// without host. Without a pairing by QR it does nothing.
func (c *Client) CancelQR() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.qr == nil {
		return
	}
	c.stopLocked()
	c.paused = false
	c.status = Status{State: "disconnected", Activity: c.status.Activity}
}

// failQRLocked stops the flow and keeps it in Status with the reason.
func (c *Client) failQRLocked(flow *qrFlow, reason string) {
	flow.stage, flow.reason = qrStageFailed, reason
	if c.cancel != nil {
		c.cancel()
		c.cancel = nil
	}
	c.generation++
	c.status.State = "disconnected"
}

func (c *Client) runQR(ctx context.Context, g uint64, flow *qrFlow) {
	h, reason := c.pairQR(ctx, g, flow)
	c.mu.Lock()
	if c.generation != g || c.qr != flow {
		c.mu.Unlock()
		return
	}
	if h == nil {
		// Without a reason the flow was stopped, by Close for instance.
		if reason != "" {
			c.failQRLocked(flow, reason)
		}
		c.mu.Unlock()
		return
	}
	if err := saveHost(c.paths, h); err != nil {
		c.failQRLocked(flow, qrReasonRefused)
		c.status.Error = "Não foi possível salvar o vínculo com o hospedeiro."
		c.mu.Unlock()
		return
	}
	c.host = h
	c.qr = nil
	c.status.Host = h.Card.Desktop.Name
	c.status.Error = ""
	c.mu.Unlock()
	c.run(ctx, g, h, nil)
}

// pairQR finds the host the phone handed the QR to and claims the pairing
// until it is done. It returns the host to save, or the reason the pairing
// failed; both are empty when the flow was stopped.
func (c *Client) pairQR(ctx context.Context, g uint64, flow *qrFlow) (*savedHost, string) {
	search, cancel := context.WithDeadline(ctx, flow.expiresAt)
	contact, reason := c.findQRHost(search, flow)
	cancel()
	if contact.hostKey == nil {
		return nil, reason
	}
	c.mu.Lock()
	if c.generation != g || c.qr != flow {
		c.mu.Unlock()
		return nil, ""
	}
	flow.stage = qrStageDigits
	flow.digits = pairing.QRDigits(contact.hostKey, c.local.PublicKey(), flow.secret, contact.nonce)
	c.mu.Unlock()
	// The host keeps the session for QRGrace after the expiry of the QR.
	confirm, cancel := context.WithDeadline(ctx, flow.expiresAt.Add(pairing.QRGrace))
	defer cancel()
	return c.confirmQRHost(confirm, g, flow, contact)
}

// findQRHost looks for the host on the local network first, by the marker
// announced for this QR, and through the temporary onion service from
// onionFirst on, with new Tor circuits before each attempt so a descriptor
// that was missing is fetched again. Every claim carries a fresh nonce and
// records the host key until a host answers 202: whoever photographed the QR
// cannot know which nonce the digits will cover.
func (c *Client) findQRHost(ctx context.Context, flow *qrFlow) (qrContact, string) {
	timing := c.qrSeams.timing
	start := time.Now()
	nextLookup, nextOnion := start, start.Add(timing.onionFirst)
	var lastNewnym time.Time
	for ctx.Err() == nil {
		if now := time.Now(); !now.Before(nextLookup) {
			every := timing.lookupEvery
			if now.Sub(start) >= timing.lookupSlowAfter {
				every = timing.lookupSlowEvery
			}
			nextLookup = now.Add(every)
			if addresses := c.qrSeams.lookup(ctx, flow.keys.MarkerKey(), timing.lookupWindow); len(addresses) > 0 {
				if contact, reason, done := c.firstQRClaim(ctx, flow, qrRoute{addresses: addresses}); done {
					return contact, reason
				}
			}
		}
		if now := time.Now(); !now.Before(nextOnion) {
			nextOnion = now.Add(timing.onionEvery)
			if now.Sub(lastNewnym) >= timing.newnymSpacing {
				lastNewnym = now
				signal, cancel := context.WithTimeout(ctx, 10*time.Second)
				_ = c.qrSeams.newnym(signal)
				cancel()
			}
			if contact, reason, done := c.firstQRClaim(ctx, flow, qrRoute{onion: flow.onion}); done {
				return contact, reason
			}
		}
		wait := time.Until(nextLookup)
		if untilOnion := time.Until(nextOnion); untilOnion < wait {
			wait = untilOnion
		}
		if !sleepContext(ctx, wait) {
			break
		}
	}
	return qrContact{}, qrEndReason(ctx)
}

// firstQRClaim claims once over route without a pin. done is false when the
// search goes on: the host was not reached or failed in a way worth a retry.
// A 200 here is refused: the person has not checked the digits yet.
func (c *Client) firstQRClaim(ctx context.Context, flow *qrFlow, route qrRoute) (qrContact, string, bool) {
	nonce := make([]byte, pairing.QRNonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return qrContact{}, "", false
	}
	conn, hostKey, err := c.dialQR(ctx, route, nil)
	if err != nil {
		return qrContact{}, "", false
	}
	status, body, err := c.qrExchange(ctx, conn, flow, nonce, false)
	switch {
	case err != nil:
		return qrContact{}, "", false
	case status == http.StatusAccepted:
		return qrContact{route: route, hostKey: hostKey, nonce: nonce}, "", true
	case status == http.StatusOK:
		return qrContact{}, qrReasonRefused, true
	}
	if reason := qrRefusal(status, body); reason != "" {
		return qrContact{}, reason, true
	}
	return qrContact{}, "", false
}

// confirmQRHost polls the host it reached, with its key pinned and the nonce
// of the first answer, so the digits stay the same. confirmed is sent only
// after the digits matched, and only then a 200 is accepted, for the host
// whose key the digits covered.
func (c *Client) confirmQRHost(ctx context.Context, g uint64, flow *qrFlow, contact qrContact) (*savedHost, string) {
	timing := c.qrSeams.timing
	for ctx.Err() == nil {
		stage, running := c.qrStage(g, flow)
		if !running {
			return nil, ""
		}
		confirmed := stage == qrStageApproving
		conn, _, err := c.dialQR(ctx, contact.route, contact.hostKey)
		if err != nil && contact.route.onion == "" {
			// The addresses may have changed: look the marker up again.
			if addresses := c.qrSeams.lookup(ctx, flow.keys.MarkerKey(), timing.lookupWindow); len(addresses) > 0 {
				contact.route.addresses = addresses
				conn, _, err = c.dialQR(ctx, contact.route, contact.hostKey)
			}
		}
		if err == nil {
			status, body, exchangeErr := c.qrExchange(ctx, conn, flow, contact.nonce, confirmed)
			switch {
			case exchangeErr != nil, status == http.StatusAccepted:
			case status == http.StatusOK && confirmed:
				h, err := c.qrHost(body, contact.hostKey)
				if err != nil {
					return nil, qrReasonRefused
				}
				return h, ""
			case status == http.StatusOK:
				return nil, qrReasonRefused
			default:
				if reason := qrRefusal(status, body); reason != "" {
					return nil, reason
				}
			}
		}
		poll := timing.digitsPoll
		if confirmed {
			poll = timing.approvePoll
		}
		select {
		case <-ctx.Done():
		case <-flow.wake:
		case <-time.After(poll):
		}
	}
	return nil, qrEndReason(ctx)
}

func (c *Client) qrStage(g uint64, flow *qrFlow) (string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.generation != g || c.qr != flow {
		return "", false
	}
	return flow.stage, true
}

// dialQR bounds the dial by the timeout of the route; the connection then
// lives on its own.
func (c *Client) dialQR(ctx context.Context, route qrRoute, pinned ed25519.PublicKey) (net.Conn, ed25519.PublicKey, error) {
	timing := c.qrSeams.timing
	if route.onion != "" {
		attempt, cancel := context.WithTimeout(ctx, timing.onionTimeout)
		defer cancel()
		return c.qrSeams.onion(attempt, route.onion, pinned)
	}
	attempt, cancel := context.WithTimeout(ctx, timing.directTimeout)
	defer cancel()
	return c.qrSeams.direct(attempt, route.addresses, pinned)
}

func (c *Client) qrExchange(ctx context.Context, conn net.Conn, flow *qrFlow, nonce []byte, confirmed bool) (int, []byte, error) {
	body, _ := json.Marshal(map[string]any{
		"v": 2, "kind": "broto-qr", "pairId": flow.keys.PairID, "secret": flow.keys.PairSecret,
		"nonce": base64.RawURLEncoding.EncodeToString(nonce), "confirmed": confirmed,
		"device": map[string]string{"name": c.name, "model": runtime.GOARCH, "platform": runtime.GOOS, "app": "broto-1", "publicKey": c.local.PublicKeyString()},
	})
	return exchangePair(ctx, conn, body)
}

// qrHost validates the final answer against the pinned host key: the desktop
// key, the key of the reach card and the desktop id all belong to it.
func (c *Client) qrHost(raw []byte, hostKey ed25519.PublicKey) (*savedHost, error) {
	key := identity.EncodePublicKey(hostKey)
	id, err := identity.DeriveID(identity.RoleDesktop, hostKey)
	if err != nil {
		return nil, err
	}
	var answer pairAnswer
	if json.Unmarshal(raw, &answer) != nil || answer.DeviceID != c.local.ID() || !strings.HasPrefix(answer.Token, "cbt1."+c.local.ID()+".") ||
		answer.Desktop.PublicKey != key || answer.Reach.PublicKey != key || answer.Desktop.ID != id {
		return nil, errors.New("invalid pairing reply")
	}
	card, err := candidates.NewCard(pairing.Desktop{ID: id, Name: answer.Desktop.Name, PublicKey: key}, answer.Reach.Onion, answer.Reach.Candidates, time.Now(), 0)
	if err != nil {
		return nil, err
	}
	return &savedHost{Card: card, Token: answer.Token, DeviceID: answer.DeviceID}, nil
}

// qrRefusal maps an answer that ends the pairing to its reason; it is empty
// for the answers worth a retry, such as 429 and 5xx.
func qrRefusal(status int, body []byte) string {
	switch {
	case status == http.StatusForbidden:
		var problem struct {
			Error struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &problem)
		switch problem.Error.Code {
		case "pair_denied":
			return qrReasonDenied
		case "pair_expired":
			return qrReasonExpired
		}
		return qrReasonRefused
	case status >= 400 && status < 500 && status != http.StatusTooManyRequests:
		return qrReasonRefused
	}
	return ""
}

// qrEndReason is expired when the deadline ended the flow and empty when it
// was stopped.
func qrEndReason(ctx context.Context) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return qrReasonExpired
	}
	return ""
}

func sleepContext(ctx context.Context, wait time.Duration) bool {
	if wait <= 0 {
		return ctx.Err() == nil
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

// lookupMarker browses the local network for one window and returns the
// addresses announced with the marker key of the QR. Failures are silent: the
// onion service remains.
func lookupMarker(ctx context.Context, marker ed25519.PublicKey, window time.Duration) []netip.AddrPort {
	id, err := identity.DeriveID(identity.RoleDesktop, marker)
	if err != nil {
		return nil
	}
	found, err := mdns.Browse(ctx, window)
	if err != nil {
		return nil
	}
	for _, desktop := range found {
		if desktop.ID == id {
			return desktop.Addrs
		}
	}
	return nil
}

func (c *Client) dialQRDirect(ctx context.Context, addresses []netip.AddrPort, pinned ed25519.PublicKey) (net.Conn, ed25519.PublicKey, error) {
	var session transport.Session
	var err error
	hostKey := pinned
	if pinned == nil {
		session, hostKey, err = c.endpoint.DialCandidatesRecord(ctx, addresses)
	} else {
		session, err = c.endpoint.DialCandidates(ctx, addresses, pinned)
	}
	if err != nil {
		return nil, nil, err
	}
	stream, err := session.OpenStream(ctx)
	if err != nil {
		_ = session.Close()
		return nil, nil, err
	}
	return &pairConn{stream, session}, hostKey, nil
}

func (c *Client) dialQROnion(ctx context.Context, onion string, pinned ed25519.PublicKey) (net.Conn, ed25519.PublicKey, error) {
	if pinned == nil {
		conn, hostKey, err := c.tor.DialTLSRecord(ctx, onion, c.local)
		if err != nil {
			return nil, nil, err
		}
		return conn, hostKey, nil
	}
	conn, err := c.tor.DialTLS(ctx, onion, c.local, pinned)
	if err != nil {
		return nil, nil, err
	}
	return conn, pinned, nil
}
