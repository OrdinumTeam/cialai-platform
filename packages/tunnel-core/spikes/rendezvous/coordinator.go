// SPDX-License-Identifier: Apache-2.0

package rendezvous

import (
	"context"
	"errors"
	"fmt"
	"time"
)

const (
	PathDirect = "direct"
	PathTor    = "tor"
)

type PunchReport struct {
	Acknowledged int `json:"acknowledged"`
	Sent         int `json:"sent"`
}

type DirectConnection interface {
	Candidate() Candidate
	Close() error
}

// DirectTransport owns one UDP socket. Offer, Punch, Dial, and Accept must all
// use that same socket so a reflected client address describes the QUIC path.
type DirectTransport interface {
	Offer(context.Context, string) (Offer, error)
	Punch(context.Context, []Candidate) (PunchReport, error)
	Dial(context.Context, []Candidate) (DirectConnection, error)
	Accept(context.Context) (DirectConnection, error)
}

type Measurement struct {
	Candidate        *Candidate  `json:"candidate,omitempty"`
	ConfirmedAfterMS float64     `json:"confirmedAfterMs"`
	Failure          string      `json:"failure,omitempty"`
	OfferAfterMS     float64     `json:"offerAfterMs"`
	Path             string      `json:"path"`
	Punch            PunchReport `json:"punch"`
	PunchFailure     string      `json:"punchFailure,omitempty"`
	SessionID        string      `json:"sessionId"`
}

type Outcome struct {
	Connection  DirectConnection
	Measurement Measurement
}

func Client(ctx context.Context, control Control, direct DirectTransport, expectedServerKey string) (Outcome, error) {
	if err := validatePublicKey(expectedServerKey); err != nil {
		return Outcome{}, fmt.Errorf("expected server key: %w", err)
	}
	started := time.Now()
	sessionID, err := NewSessionID()
	if err != nil {
		return Outcome{}, err
	}
	localOffer, err := direct.Offer(ctx, "client")
	if err != nil {
		return Outcome{}, fmt.Errorf("collect client offer: %w", err)
	}
	if err := validateOffer(localOffer); err != nil || localOffer.Role != "client" {
		if err != nil {
			return Outcome{}, fmt.Errorf("invalid local client offer: %w", err)
		}
		return Outcome{}, errors.New("local client offer has the wrong role")
	}
	if err := control.Send(ctx, Message{
		Version: ProtocolVersion, Type: MessageClientOffer, SessionID: sessionID, Offer: &localOffer,
	}); err != nil {
		return Outcome{}, fmt.Errorf("send client offer: %w", err)
	}
	serverMessage, err := control.Receive(ctx)
	if err != nil {
		return Outcome{}, fmt.Errorf("receive server offer: %w", err)
	}
	if serverMessage.SessionID != sessionID {
		return Outcome{}, errors.New("response to client offer has the wrong session ID")
	}
	if serverMessage.Type == MessageFallback {
		elapsed := time.Since(started)
		return torOutcome(sessionID, elapsed, elapsed, serverMessage.Reason, PunchReport{}), nil
	}
	if serverMessage.Type != MessageServerOffer || serverMessage.Offer == nil {
		return Outcome{}, errors.New("unexpected response to client offer")
	}
	if !samePublicKey(serverMessage.Offer.PublicKey, expectedServerKey) {
		return Outcome{}, errors.New("server offer key does not match the authenticated Tor peer")
	}
	offerAfter := time.Since(started)
	punch, punchErr := direct.Punch(ctx, serverMessage.Offer.Candidates)
	connection, dialErr := direct.Dial(ctx, serverMessage.Offer.Candidates)
	if dialErr != nil {
		reason := "direct dial failed: " + dialErr.Error()
		if punchErr != nil {
			reason = "direct punch failed: " + punchErr.Error() + "; " + reason
		}
		if err := sendFallback(ctx, control, sessionID, reason); err != nil {
			return Outcome{}, err
		}
		outcome := torOutcome(sessionID, offerAfter, time.Since(started), reason, punch)
		return outcome, nil
	}
	candidate := connection.Candidate()
	if err := validateCandidate(candidate); err != nil {
		_ = connection.Close()
		return Outcome{}, fmt.Errorf("direct connection returned invalid candidate: %w", err)
	}
	if err := control.Send(ctx, Message{
		Version: ProtocolVersion, Type: MessageDirectReady, SessionID: sessionID, Candidate: &candidate,
	}); err != nil {
		_ = connection.Close()
		return Outcome{}, fmt.Errorf("confirm direct path: %w", err)
	}
	acknowledgement, err := control.Receive(ctx)
	if err != nil {
		_ = connection.Close()
		return Outcome{}, fmt.Errorf("receive switch acknowledgement: %w", err)
	}
	if acknowledgement.Type == MessageFallback && acknowledgement.SessionID == sessionID {
		_ = connection.Close()
		return torOutcome(sessionID, offerAfter, time.Since(started), acknowledgement.Reason, punch), nil
	}
	if acknowledgement.Type != MessageSwitchAck || acknowledgement.SessionID != sessionID || acknowledgement.Candidate == nil {
		_ = connection.Close()
		return Outcome{}, errors.New("unexpected direct switch acknowledgement")
	}
	if *acknowledgement.Candidate != candidate {
		_ = connection.Close()
		return Outcome{}, errors.New("server acknowledged a different direct candidate")
	}
	punchFailure := ""
	if punchErr != nil {
		punchFailure = punchErr.Error()
	}
	return Outcome{
		Connection: connection,
		Measurement: Measurement{
			Candidate: &candidate, ConfirmedAfterMS: durationMS(time.Since(started)), OfferAfterMS: durationMS(offerAfter),
			Path: PathDirect, Punch: punch, PunchFailure: punchFailure, SessionID: sessionID,
		},
	}, nil
}

func Server(ctx context.Context, control Control, direct DirectTransport, expectedClientKey string) (Outcome, error) {
	if err := validatePublicKey(expectedClientKey); err != nil {
		return Outcome{}, fmt.Errorf("expected client key: %w", err)
	}
	started := time.Now()
	clientMessage, err := control.Receive(ctx)
	if err != nil {
		return Outcome{}, fmt.Errorf("receive client offer: %w", err)
	}
	if clientMessage.Type != MessageClientOffer || clientMessage.Offer == nil {
		return Outcome{}, errors.New("first rendezvous message must be client_offer")
	}
	if !samePublicKey(clientMessage.Offer.PublicKey, expectedClientKey) {
		return Outcome{}, errors.New("client offer key does not match the authenticated Tor peer")
	}
	localOffer, err := direct.Offer(ctx, "server")
	if err != nil {
		_ = sendFallback(ctx, control, clientMessage.SessionID, "collect server offer: "+err.Error())
		return Outcome{}, fmt.Errorf("collect server offer: %w", err)
	}
	if err := validateOffer(localOffer); err != nil || localOffer.Role != "server" {
		if err != nil {
			return Outcome{}, fmt.Errorf("invalid local server offer: %w", err)
		}
		return Outcome{}, errors.New("local server offer has the wrong role")
	}
	if err := control.Send(ctx, Message{
		Version: ProtocolVersion, Type: MessageServerOffer, SessionID: clientMessage.SessionID, Offer: &localOffer,
	}); err != nil {
		return Outcome{}, fmt.Errorf("send server offer: %w", err)
	}
	offerAfter := time.Since(started)
	operationContext, cancel := context.WithCancel(ctx)
	defer cancel()
	type punchResult struct {
		report PunchReport
		err    error
	}
	punchChannel := make(chan punchResult, 1)
	acceptChannel := make(chan struct {
		connection DirectConnection
		err        error
	}, 1)
	messageChannel := make(chan struct {
		message Message
		err     error
	}, 1)
	go func() {
		report, err := direct.Punch(operationContext, clientMessage.Offer.Candidates)
		punchChannel <- punchResult{report: report, err: err}
	}()
	go func() {
		connection, err := direct.Accept(operationContext)
		acceptChannel <- struct {
			connection DirectConnection
			err        error
		}{connection: connection, err: err}
	}()
	go func() {
		message, err := control.Receive(operationContext)
		messageChannel <- struct {
			message Message
			err     error
		}{message: message, err: err}
	}()

	var connection DirectConnection
	var confirmation *Message
	for connection == nil || confirmation == nil {
		select {
		case <-ctx.Done():
			if connection != nil {
				_ = connection.Close()
			}
			return Outcome{}, ctx.Err()
		case accepted := <-acceptChannel:
			acceptChannel = nil
			if accepted.err != nil {
				reason := "direct accept failed: " + accepted.err.Error()
				_ = sendFallback(ctx, control, clientMessage.SessionID, reason)
				return torOutcome(clientMessage.SessionID, offerAfter, time.Since(started), reason, PunchReport{}), nil
			}
			connection = accepted.connection
		case received := <-messageChannel:
			messageChannel = nil
			if received.err != nil {
				if connection != nil {
					_ = connection.Close()
				}
				return Outcome{}, fmt.Errorf("receive direct confirmation: %w", received.err)
			}
			if received.message.SessionID != clientMessage.SessionID {
				if connection != nil {
					_ = connection.Close()
				}
				return Outcome{}, errors.New("direct confirmation has the wrong session ID")
			}
			if received.message.Type == MessageFallback {
				if connection != nil {
					_ = connection.Close()
				}
				return torOutcome(clientMessage.SessionID, offerAfter, time.Since(started), received.message.Reason, PunchReport{}), nil
			}
			if received.message.Type != MessageDirectReady || received.message.Candidate == nil {
				if connection != nil {
					_ = connection.Close()
				}
				return Outcome{}, errors.New("expected direct_ready or fallback")
			}
			if !containsCandidate(localOffer.Candidates, *received.message.Candidate) {
				if connection != nil {
					_ = connection.Close()
				}
				return Outcome{}, errors.New("client confirmed a candidate that the server did not offer")
			}
			confirmation = &received.message
		}
	}

	cancel()
	punch := PunchReport{}
	punchFailure := ""
	select {
	case punched := <-punchChannel:
		punch = punched.report
		if punched.err != nil {
			punchFailure = punched.err.Error()
		}
	case <-time.After(250 * time.Millisecond):
	}
	serverCandidate := connection.Candidate()
	if err := validateCandidate(serverCandidate); err != nil {
		_ = connection.Close()
		return Outcome{}, fmt.Errorf("accepted connection returned invalid candidate: %w", err)
	}
	if err := control.Send(ctx, Message{
		Version: ProtocolVersion, Type: MessageSwitchAck, SessionID: clientMessage.SessionID,
		Candidate: confirmation.Candidate,
	}); err != nil {
		_ = connection.Close()
		return Outcome{}, fmt.Errorf("acknowledge direct switch: %w", err)
	}
	return Outcome{
		Connection: connection,
		Measurement: Measurement{
			Candidate: &serverCandidate, ConfirmedAfterMS: durationMS(time.Since(started)), OfferAfterMS: durationMS(offerAfter),
			Path: PathDirect, Punch: punch, PunchFailure: punchFailure, SessionID: clientMessage.SessionID,
		},
	}, nil
}

func sendFallback(ctx context.Context, control Control, sessionID, reason string) error {
	if len(reason) > 1024 {
		reason = reason[:1024]
	}
	if err := control.Send(ctx, Message{
		Version: ProtocolVersion, Type: MessageFallback, SessionID: sessionID, Reason: reason,
	}); err != nil {
		return fmt.Errorf("send Tor fallback: %w", err)
	}
	return nil
}

func torOutcome(sessionID string, offerAfter, confirmedAfter time.Duration, reason string, punch PunchReport) Outcome {
	return Outcome{Measurement: Measurement{
		ConfirmedAfterMS: durationMS(confirmedAfter), Failure: reason, OfferAfterMS: durationMS(offerAfter),
		Path: PathTor, Punch: punch, SessionID: sessionID,
	}}
}

func containsCandidate(candidates []Candidate, expected Candidate) bool {
	for _, candidate := range candidates {
		if candidate == expected {
			return true
		}
	}
	return false
}

func durationMS(duration time.Duration) float64 {
	return float64(duration.Microseconds()) / 1000
}
