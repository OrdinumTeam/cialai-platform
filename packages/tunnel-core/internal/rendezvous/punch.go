// SPDX-License-Identifier: Apache-2.0
package rendezvous

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

// PunchResult is the outcome of one punch the desktop ran for the phone.
type PunchResult struct {
	// Request is the sequence number of the punch_request.
	Request uint64
	// Candidates are the phone candidates that received opening packets.
	Candidates []netip.AddrPort
	Report     transport.PunchReport
	Duration   time.Duration
	Err        error
}

// Punch runs one coordinated NAT punch from the phone. It needs a fresh local
// list already sent with SendCandidates and waits, within ctx, for a fresh
// list from the desktop. It then asks the desktop to send opening packets to
// the local list and, once the desktop accepts, dials the desktop candidates
// through Config.Puncher, returning the first direct session. The channel
// keeps working whatever the outcome; reporting the chosen path with
// ReportPath is up to the caller.
//
// When ctx has no deadline, Config.PunchTimeout bounds the whole punch. A
// refusal returns an error wrapping ErrPunchRefused with the desktop reason.
func (conn *Conn) Punch(ctx context.Context) (transport.Session, error) {
	if conn.config.Role != identity.RolePhone {
		return nil, fmt.Errorf("%w: only the phone requests a punch", ErrProtocol)
	}
	if conn.config.Puncher == nil {
		return nil, errors.New("rendezvous punch needs a puncher")
	}
	if _, bounded := ctx.Deadline(); !bounded {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, conn.config.PunchTimeout)
		defer cancel()
	}
	local, ok := conn.LocalCandidates()
	if !ok {
		return nil, fmt.Errorf("%w: send fresh local candidates before punching", ErrCandidatesExpired)
	}
	peer, err := conn.waitPeerCandidates(ctx)
	if err != nil {
		return nil, err
	}
	targets := peer.AddrPorts()
	if len(targets) == 0 {
		return nil, fmt.Errorf("desktop announced no candidates: %w", transport.ErrNoCandidates)
	}

	answer := make(chan punchAck, 1)
	err = conn.send(ctx, message{Type: typePunchRequest, PunchRequest: &punchRequest{Candidates: local.Seq}}, func(seq uint64) {
		conn.mu.Lock()
		conn.punches[seq] = answer
		conn.mu.Unlock()
	})
	if err != nil {
		return nil, err
	}
	var ack punchAck
	select {
	case ack = <-answer:
	case <-ctx.Done():
		return nil, fmt.Errorf("wait for punch_ack: %w", ctx.Err())
	case <-conn.done:
		return nil, conn.Err()
	}
	if !ack.Accepted {
		return nil, fmt.Errorf("%w: %s", ErrPunchRefused, ack.Reason)
	}
	session, err := conn.config.Puncher.DialCandidates(ctx, targets, conn.peerPublic)
	if err != nil {
		return nil, fmt.Errorf("dial desktop candidates: %w", err)
	}
	return session, nil
}

// waitPeerCandidates returns the peer list once it is fresh.
func (conn *Conn) waitPeerCandidates(ctx context.Context) (CandidateSet, error) {
	for {
		conn.mu.Lock()
		set, has, changed := conn.peer, conn.hasPeer, conn.peerChanged
		fresh := has && !set.Expired(conn.config.Now())
		conn.mu.Unlock()
		if fresh {
			return set.clone(), nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return CandidateSet{}, fmt.Errorf("%w: no fresh desktop candidates: %w", ErrCandidatesExpired, ctx.Err())
		case <-conn.done:
			return CandidateSet{}, conn.Err()
		}
	}
}

func (conn *Conn) receivePunchAck(body *punchAck) error {
	conn.mu.Lock()
	answer, ok := conn.punches[body.Request]
	delete(conn.punches, body.Request)
	conn.mu.Unlock()
	if !ok {
		return conn.unmatchedAnswer(typePunchAck, body.Request)
	}
	// The channel has room for one answer; a Punch that gave up leaves it
	// unread.
	answer <- *body
	return nil
}

// servePunch answers a punch request on the desktop. Naming a frame that is
// not the latest candidate list, or one that does not exist, is a protocol
// violation; stale, expired or empty lists, a missing puncher and a punch in
// progress are refused without closing the channel.
func (conn *Conn) servePunch(seq uint64, body *punchRequest) error {
	conn.mu.Lock()
	peer, hasPeer := conn.peer, conn.hasPeer
	if body.Candidates >= seq || !hasPeer || body.Candidates > peer.Seq {
		conn.mu.Unlock()
		return fmt.Errorf("%w: punch_request names frame %d, which is not a candidate list", ErrProtocol, body.Candidates)
	}
	reason := ""
	switch {
	case body.Candidates < peer.Seq:
		reason = RefusedStale
	case peer.Expired(conn.config.Now()):
		reason = RefusedExpired
	case len(peer.Candidates) == 0:
		reason = RefusedNoCandidates
	case conn.config.Puncher == nil:
		reason = RefusedUnsupported
	case conn.punching:
		reason = RefusedBusy
	default:
		conn.punching = true
	}
	conn.mu.Unlock()

	if reason != "" {
		conn.config.Logf("rendezvous: refused punch %d from %s: %s", seq, conn.config.PeerKey, reason)
		return conn.reply(message{Type: typePunchAck, PunchAck: &punchAck{Request: seq, Reason: reason}})
	}
	// Opening packets start before the acknowledgement leaves, so the phone
	// dials while the desktop bindings are already opening.
	conn.wait.Add(1)
	go conn.runPunch(seq, peer.AddrPorts())
	return conn.reply(message{Type: typePunchAck, PunchAck: &punchAck{Request: seq, Accepted: true}})
}

func (conn *Conn) runPunch(seq uint64, targets []netip.AddrPort) {
	defer conn.wait.Done()
	ctx, cancel := context.WithTimeout(conn.ctx, conn.config.PunchTimeout)
	defer cancel()
	started := time.Now()
	report, err := conn.config.Puncher.Punch(ctx, targets)
	result := PunchResult{Request: seq, Candidates: targets, Report: report, Duration: time.Since(started), Err: err}
	conn.mu.Lock()
	conn.punching = false
	conn.mu.Unlock()
	if err != nil {
		conn.config.Logf("rendezvous: punch %d for %s failed: %v", seq, conn.config.PeerKey, err)
	}
	if handle := conn.config.Handler.PunchServed; handle != nil {
		handle(result)
	}
}
