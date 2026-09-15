// SPDX-License-Identifier: Apache-2.0

package mobile

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pathmgr"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/proxy"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

const (
	// pairDirectBudget bounds the parallel dial of the QR direct candidates.
	pairDirectBudget = 3 * time.Second
	// pairTorRetry spaces the onion dials while the desktop service is not
	// published yet, until the QR expires.
	pairTorRetry = 5 * time.Second
	// pairTorAttempt bounds one onion dial, pinned TLS included.
	pairTorAttempt = 60 * time.Second
	// pairTorGrace is how long pairing waits for the native Tor to hand over
	// its endpoints before reporting that the fallback is unavailable.
	pairTorGrace = 30 * time.Second
	// pairClockSkew tolerates a phone clock ahead of the desktop, as the QR
	// inspection does.
	pairClockSkew = time.Minute
	// pairExchangeTimeout covers POST /pair, including a desktop approval of
	// up to one minute.
	pairExchangeTimeout  = 75 * time.Second
	pairRequestVersion   = 2
	maxPairResponseBytes = 64 << 10
	torProbeTimeout      = 3 * time.Second
)

type inspectionView struct {
	Version    int                       `json:"v"`
	Desktop    pairing.InspectionDesktop `json:"desktop"`
	ExpiresAt  int64                     `json:"expiresAt"`
	Candidates int                       `json:"candidates"`
	Known      bool                      `json:"known"`
}

// InspectPairPayload validates a CIALAI2 QR without returning its secret or
// pairing id, and tells whether the desktop is already paired.
func (tunnel *Tunnel) InspectPairPayload(payload string) (string, error) {
	inspection, err := pairing.Inspect(payload, tunnel.now())
	if err != nil {
		return "", pairingProblem(err)
	}
	tunnel.mu.Lock()
	_, known := tunnel.desktops[inspection.Desktop.ID]
	tunnel.mu.Unlock()
	return marshalJSON(inspectionView{
		Version: inspection.Version, Desktop: inspection.Desktop, ExpiresAt: inspection.ExpiresAt,
		Candidates: inspection.Candidates, Known: known,
	})
}

type pairedDesktopView struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Fingerprint string `json:"fingerprint"`
}

type pairResult struct {
	DesktopID string            `json:"desktopId"`
	DeviceID  string            `json:"deviceId"`
	Token     string            `json:"token"`
	Desktop   pairedDesktopView `json:"desktop"`
	Transport string            `json:"transport"`
}

// Pair reaches the desktop of a CIALAI2 QR, direct candidates first and the
// onion after them, over a TLS session pinned to the QR key, and exchanges the
// one-use secret for a device token returned to native. The reach card of the
// answer is remembered; the token is not.
func (tunnel *Tunnel) Pair(payloadText, deviceName, deviceModel, platform, appVersion string) (string, error) {
	if err := validateDevice(deviceName, deviceModel, platform, appVersion); err != nil {
		return "", err
	}
	payload, err := pairing.Decode(payloadText)
	if err != nil {
		return "", pairingProblem(err)
	}
	expiry := time.Unix(payload.ExpiresAt, 0).Add(pairClockSkew)
	if !tunnel.now().Before(expiry) {
		return "", codedMessage("payload_expired", "Este código expirou. Gere um novo no computador.")
	}
	key, err := identity.ParsePublicKey(payload.Desktop.PublicKey)
	if err != nil {
		return "", codedMessage("payload_invalid", "A identidade do computador no código é inválida.")
	}

	tunnel.pairMu.Lock()
	defer tunnel.pairMu.Unlock()
	base := tunnel.context()
	reachContext, cancel := context.WithDeadline(base, expiry)
	conn, transportName, err := tunnel.reachForPairing(reachContext, payload, key)
	cancel()
	if err != nil {
		tunnel.log(levelInfo, "pairing with "+payload.Desktop.ID+" failed: "+err.Error())
		return "", err
	}
	tunnel.emitPair("confirming", payload.Desktop.ID)
	answer, card, err := tunnel.exchangePair(base, conn, payload, deviceName, deviceModel, platform, appVersion)
	if err != nil {
		tunnel.log(levelInfo, "pairing with "+payload.Desktop.ID+" failed: "+err.Error())
		return "", err
	}

	now := tunnel.now().UTC().Truncate(time.Second)
	desktop := storedDesktop{
		ID: card.Desktop.ID, Name: card.Desktop.Name, PublicKey: card.Desktop.PublicKey,
		Fingerprint: identity.Fingerprint(key), Onion: card.Onion, Candidates: card.Candidates,
		CandidatesIssuedAt: card.IssuedAt, PairedAt: now, LastSeenAt: now, LastTransport: transportName,
	}
	tunnel.opMu.Lock()
	tunnel.mu.Lock()
	if previous, known := tunnel.desktops[desktop.ID]; known {
		desktop.PairedAt = previous.PairedAt
	}
	tunnel.desktops[desktop.ID] = desktop
	var manager *pathmgr.Manager
	var instance *proxy.Proxy
	var proxyID string
	if tunnel.managerID == desktop.ID {
		// A manager of the previous pairing may be revoked or hold an old card.
		manager, instance, proxyID = tunnel.detachLocked()
	}
	tunnel.mu.Unlock()
	tunnel.release(manager, instance, proxyID)
	tunnel.opMu.Unlock()
	if err := tunnel.save(); err != nil {
		return "", err
	}
	tunnel.emit("pair", map[string]any{"state": "completed", "desktopId": desktop.ID, "transport": transportName})
	tunnel.emitState()
	return marshalJSON(pairResult{
		DesktopID: desktop.ID, DeviceID: answer.DeviceID, Token: answer.Token, Transport: transportName,
		Desktop: pairedDesktopView{ID: desktop.ID, Name: desktop.Name, Fingerprint: desktop.Fingerprint},
	})
}

// reachForPairing returns one connection carrying a single stream to the
// desktop edge: a restricted QUIC session over the QR candidates, dialed in
// parallel within pairDirectBudget, or a pinned TLS connection to the onion,
// dialed again every pairRetry until ctx ends at the QR expiry.
func (tunnel *Tunnel) reachForPairing(ctx context.Context, payload pairing.Payload, key ed25519.PublicKey) (net.Conn, string, error) {
	lan, internet := splitCandidates(payload.Candidates)
	if len(lan)+len(internet) > 0 {
		conn, err := tunnel.dialPairDirect(ctx, payload.Desktop.ID, lan, internet, key)
		switch {
		case err == nil:
			return conn, transport.NameDirect, nil
		case errors.Is(err, transport.ErrPairingInactive):
			return nil, "", codedMessage("pair_inactive", "Este código não está mais ativo no computador. Gere um novo código.")
		case errors.Is(err, transport.ErrRestrictedLimit):
			return nil, "", codedMessage("pair_rate_limited", "Muitas tentativas de pareamento. Gere um novo código e tente novamente.")
		case ctx.Err() != nil:
			return nil, "", tunnel.pairContextProblem(ctx, false)
		}
		tunnel.log(levelDebug, "direct pairing candidates failed: "+err.Error())
	}
	return tunnel.dialPairOnion(ctx, payload, key)
}

func (tunnel *Tunnel) dialPairDirect(ctx context.Context, desktopID string, lan, internet []netip.AddrPort, key ed25519.PublicKey) (net.Conn, error) {
	endpoint, err := tunnel.ensureEndpoint()
	if err != nil {
		return nil, err
	}
	if len(lan) > 0 {
		tunnel.emitPair("lan", desktopID)
	}
	if len(internet) > 0 {
		tunnel.emitPair("direct", desktopID)
	}
	dialContext, cancel := context.WithTimeout(ctx, pairDirectBudget)
	defer cancel()
	session, err := endpoint.DialCandidates(dialContext, append(lan, internet...), key)
	if err != nil {
		return nil, err
	}
	stream, err := session.OpenStream(dialContext)
	if err != nil {
		_ = session.Close()
		return nil, err
	}
	return &pairStream{Stream: stream, session: session}, nil
}

func (tunnel *Tunnel) dialPairOnion(ctx context.Context, payload pairing.Payload, key ed25519.PublicKey) (net.Conn, string, error) {
	host, _, err := net.SplitHostPort(payload.Onion)
	if err != nil {
		return nil, "", codedMessage("payload_invalid", "O endereço de reserva do computador no código é inválido.")
	}
	tunnel.emitPair("tor", payload.Desktop.ID)
	started := tunnel.now()
	torSeen := false
	for {
		tunnel.probeTor(ctx)
		attempt, cancel := context.WithTimeout(ctx, pairTorAttempt)
		conn, err := tunnel.tor.DialTLS(attempt, host, tunnel.local, key)
		cancel()
		if err == nil {
			tunnel.setTor(pathmgr.TorStatus{State: pathmgr.TorReady, Progress: 100})
			return conn, transport.NameTor, nil
		}
		if ctx.Err() != nil {
			return nil, "", tunnel.pairContextProblem(ctx, torSeen)
		}
		if errors.Is(err, tor.ErrNoEndpoints) {
			if !torSeen && tunnel.now().Sub(started) >= tunnel.pairTorGrace {
				return nil, "", codedMessage(pathmgr.CodeReserveUnavailable, "A conexão de reserva está indisponível e o computador não respondeu pela rede local.")
			}
		} else {
			torSeen = true
		}
		tunnel.log(levelDebug, "onion pairing dial failed: "+err.Error())
		if !sleepContext(ctx, tunnel.pairRetry) {
			return nil, "", tunnel.pairContextProblem(ctx, torSeen)
		}
	}
}

// probeTor reports the bootstrap progress of the native Tor while pairing.
func (tunnel *Tunnel) probeTor(ctx context.Context) {
	probe, cancel := context.WithTimeout(ctx, torProbeTimeout)
	defer cancel()
	progress, err := tunnel.tor.Bootstrap(probe)
	switch {
	case errors.Is(err, tor.ErrNoEndpoints):
		tunnel.setTor(pathmgr.TorStatus{State: pathmgr.TorDisabled})
	case err != nil:
	case progress.Progress < 100:
		tunnel.setTor(pathmgr.TorStatus{State: pathmgr.TorBootstrapping, Progress: progress.Progress})
	default:
		tunnel.setTor(pathmgr.TorStatus{State: pathmgr.TorReady, Progress: 100})
	}
}

func (tunnel *Tunnel) pairContextProblem(ctx context.Context, torSeen bool) error {
	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		return codedMessage("stopped", "O pareamento foi interrompido.")
	case torSeen:
		return codedMessage(pathmgr.CodeNoPath, "O computador não respondeu antes de o código expirar. Gere um novo código.")
	default:
		return codedMessage(pathmgr.CodeReserveUnavailable, "A conexão de reserva está indisponível e o código expirou. Gere um novo código.")
	}
}

type pairAnswer struct {
	DeviceID string `json:"deviceId"`
	Token    string `json:"token"`
	Desktop  struct {
		ID        string `json:"id"`
		Name      string `json:"name"`
		PublicKey string `json:"publicKey"`
	} `json:"desktop"`
	Reach struct {
		Onion      string              `json:"onion"`
		PublicKey  string              `json:"publicKey"`
		Candidates []pairing.Candidate `json:"candidates"`
	} `json:"reach"`
	IssuedAt string `json:"issuedAt"`
}

// exchangePair sends POST /pair over conn and returns the answer with the reach
// card it carries. conn is closed before it returns.
func (tunnel *Tunnel) exchangePair(ctx context.Context, conn net.Conn, payload pairing.Payload, name, model, platform, appVersion string) (pairAnswer, candidates.Card, error) {
	defer conn.Close()
	body, err := json.Marshal(map[string]any{
		"v": pairRequestVersion, "pairId": payload.PairID, "secret": payload.Secret,
		"device": map[string]string{"name": name, "model": model, "platform": platform, "app": appVersion, "publicKey": tunnel.local.PublicKeyString()},
	})
	if err != nil {
		return pairAnswer{}, candidates.Card{}, coded("pair_internal", err)
	}
	var used atomic.Bool
	client := &http.Client{Transport: &http.Transport{
		Proxy: nil, DisableKeepAlives: true,
		DialContext: func(context.Context, string, string) (net.Conn, error) {
			if !used.CompareAndSwap(false, true) {
				return nil, errors.New("the pairing connection carries a single request")
			}
			return conn, nil
		},
	}}
	defer client.CloseIdleConnections()
	requestContext, cancel := context.WithTimeout(ctx, pairExchangeTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, "http://"+proxy.DesktopHost+"/pair", bytes.NewReader(body))
	if err != nil {
		return pairAnswer{}, candidates.Card{}, coded("pair_internal", err)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.Do(request)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return pairAnswer{}, candidates.Card{}, codedMessage("stopped", "O pareamento foi interrompido.")
		}
		return pairAnswer{}, candidates.Card{}, codedMessage(pathmgr.CodeNoPath, "A conexão com o computador caiu durante o pareamento. Tente de novo.")
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, maxPairResponseBytes+1))
	if err != nil || len(raw) > maxPairResponseBytes {
		return pairAnswer{}, candidates.Card{}, invalidPairAnswer()
	}
	if response.StatusCode != http.StatusOK {
		var problem struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &problem) == nil && validCode(problem.Error.Code) {
			return pairAnswer{}, candidates.Card{}, codedMessage(problem.Error.Code, problem.Error.Message)
		}
		return pairAnswer{}, candidates.Card{}, codedMessage("pair_failed", "O computador recusou o pareamento.")
	}
	var answer pairAnswer
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&answer); err != nil {
		return pairAnswer{}, candidates.Card{}, invalidPairAnswer()
	}
	if answer.DeviceID != tunnel.local.ID() || !strings.HasPrefix(answer.Token, "cdt1."+answer.DeviceID+".") || strings.Count(answer.Token, ".") != 2 ||
		answer.Desktop.ID != payload.Desktop.ID || answer.Desktop.PublicKey != payload.Desktop.PublicKey || answer.Reach.PublicKey != payload.Desktop.PublicKey {
		return pairAnswer{}, candidates.Card{}, invalidPairAnswer()
	}
	card, err := candidates.NewCard(
		pairing.Desktop{ID: answer.Desktop.ID, Name: answer.Desktop.Name, PublicKey: answer.Desktop.PublicKey},
		answer.Reach.Onion, answer.Reach.Candidates, tunnel.now(), 0,
	)
	if err != nil {
		return pairAnswer{}, candidates.Card{}, invalidPairAnswer()
	}
	return answer, card, nil
}

func invalidPairAnswer() error {
	return codedMessage("pair_invalid_response", "O computador devolveu uma resposta de pareamento inválida.")
}

// validCode accepts the snake case codes of the edge, so a problem body can
// not smuggle a message into the code position.
func validCode(code string) bool {
	if code == "" || len(code) > 48 {
		return false
	}
	for _, character := range code {
		if (character < 'a' || character > 'z') && (character < '0' || character > '9') && character != '_' {
			return false
		}
	}
	return true
}

// pairStream is the single stream of a restricted pairing session; closing it
// ends the session.
type pairStream struct {
	transport.Stream
	session   transport.Session
	closeOnce sync.Once
}

func (stream *pairStream) Close() error {
	var err error
	stream.closeOnce.Do(func() {
		err = stream.Stream.Close()
		_ = stream.session.Close()
	})
	return err
}

func splitCandidates(list []pairing.Candidate) (lan, internet []netip.AddrPort) {
	for _, candidate := range list {
		address, err := netip.ParseAddrPort(candidate.Address)
		if err != nil {
			continue
		}
		if candidate.Type == pairing.CandidateLAN {
			lan = append(lan, address)
		} else {
			internet = append(internet, address)
		}
	}
	return lan, internet
}

func (tunnel *Tunnel) emitPair(state, desktopID string) {
	tunnel.emit("pair", map[string]string{"state": state, "desktopId": desktopID})
}

func sleepContext(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func validateDevice(name, model, platform, appVersion string) error {
	if strings.TrimSpace(name) == "" || len([]rune(name)) > 48 || strings.TrimSpace(model) == "" || len([]rune(model)) > 64 || strings.TrimSpace(appVersion) == "" || len([]rune(appVersion)) > 32 {
		return codedMessage("device_invalid", "A identificação deste aparelho é inválida.")
	}
	if platform != "ios" && platform != "android" {
		return codedMessage("device_invalid", "A plataforma deste aparelho é inválida.")
	}
	return nil
}

func pairingProblem(err error) error {
	if code := pairing.Code(err); code != "" {
		return codedMessage(code, err.Error())
	}
	return coded("payload_invalid", err)
}
