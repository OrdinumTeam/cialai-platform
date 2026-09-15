// SPDX-License-Identifier: Apache-2.0
package rendezvous

import (
	"context"
	"encoding/binary"
	"errors"
	"testing"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
)

// rawStep writes one frame from the raw peer.
type rawStep func(t *testing.T, keys testKeys, peer *rawPeer)

func sendNext(msg message) rawStep {
	return func(_ *testing.T, _ testKeys, peer *rawPeer) { _ = peer.send(msg) }
}

func sendWithSeq(seq uint64, msg message) rawStep {
	return func(_ *testing.T, _ testKeys, peer *rawPeer) {
		msg.Seq = seq
		_ = peer.sendAs(msg)
	}
}

func candidatesMessage(list ...pairing.Candidate) message {
	if list == nil {
		list = []pairing.Candidate{}
	}
	return message{Type: typeCandidates, Candidates: &candidateList{TTLMillis: 60_000, Candidates: list}}
}

func TestOutOfOrderAndRepeatedFramesCloseTheChannel(t *testing.T) {
	ping := message{Type: typePing}
	for name, test := range map[string]struct {
		role  identity.Role
		steps []rawStep
		want  error
	}{
		"repeated sequence number": {
			role:  identity.RolePhone,
			steps: []rawStep{sendWithSeq(2, ping), sendWithSeq(2, ping)},
			want:  ErrReplay,
		},
		"older sequence number": {
			role:  identity.RoleDesktop,
			steps: []rawStep{sendWithSeq(2, ping), sendWithSeq(3, ping), sendWithSeq(2, ping)},
			want:  ErrReplay,
		},
		"replayed hello": {
			role: identity.RolePhone,
			steps: []rawStep{func(_ *testing.T, keys testKeys, peer *rawPeer) {
				msg := keys.hello(identity.RoleDesktop)
				msg.Seq = 1
				_ = peer.sendAs(msg)
			}},
			want: ErrReplay,
		},
		"skipped sequence number": {
			role:  identity.RolePhone,
			steps: []rawStep{sendWithSeq(3, ping)},
			want:  ErrProtocol,
		},
		"second hello": {
			role:  identity.RoleDesktop,
			steps: []rawStep{func(_ *testing.T, keys testKeys, peer *rawPeer) { _ = peer.send(keys.hello(identity.RolePhone)) }},
			want:  ErrProtocol,
		},
		"punch request from the desktop": {
			role:  identity.RolePhone,
			steps: []rawStep{sendNext(candidatesMessage()), sendNext(message{Type: typePunchRequest, PunchRequest: &punchRequest{Candidates: 2}})},
			want:  ErrProtocol,
		},
		"reach update from the phone": {
			role: identity.RoleDesktop,
			steps: []rawStep{func(t *testing.T, keys testKeys, peer *rawPeer) {
				card := testCard(t, keys.desktop)
				_ = peer.send(message{Type: typeReachUpdate, ReachUpdate: &card})
			}},
			want: ErrProtocol,
		},
		"path report from the desktop": {
			role:  identity.RolePhone,
			steps: []rawStep{sendNext(message{Type: typePathReport, PathReport: &PathReport{Path: transport.NameTor}})},
			want:  ErrProtocol,
		},
		"punch ack from the phone": {
			role:  identity.RoleDesktop,
			steps: []rawStep{sendNext(message{Type: typePunchAck, PunchAck: &punchAck{Request: 1, Accepted: true}})},
			want:  ErrProtocol,
		},
		"punch request before candidates": {
			role:  identity.RoleDesktop,
			steps: []rawStep{sendNext(ping), sendNext(message{Type: typePunchRequest, PunchRequest: &punchRequest{Candidates: 2}})},
			want:  ErrProtocol,
		},
		"punch request naming a later frame": {
			role: identity.RoleDesktop,
			steps: []rawStep{
				sendNext(candidatesMessage(lan("192.168.1.20:50000"))),
				sendNext(message{Type: typePunchRequest, PunchRequest: &punchRequest{Candidates: 3}}),
			},
			want: ErrProtocol,
		},
		"punch ack for a frame never sent": {
			role:  identity.RolePhone,
			steps: []rawStep{sendNext(message{Type: typePunchAck, PunchAck: &punchAck{Request: 50, Accepted: true}})},
			want:  ErrProtocol,
		},
		"punch ack for a frame that is not a request": {
			role:  identity.RolePhone,
			steps: []rawStep{sendNext(message{Type: typePunchAck, PunchAck: &punchAck{Request: 1, Accepted: true}})},
			want:  ErrReplay,
		},
		"pong for a frame never sent": {
			role:  identity.RoleDesktop,
			steps: []rawStep{sendNext(message{Type: typePong, Pong: &pong{Ping: 9}})},
			want:  ErrProtocol,
		},
		"reach card of another desktop": {
			role: identity.RolePhone,
			steps: []rawStep{func(t *testing.T, _ testKeys, peer *rawPeer) {
				card := testCard(t, generate(t, identity.RoleDesktop))
				_ = peer.send(message{Type: typeReachUpdate, ReachUpdate: &card})
			}},
			want: ErrPeerMismatch,
		},
	} {
		t.Run(name, func(t *testing.T) {
			keys := newKeys(t)
			conn, peer := connWithRaw(t, keys, test.role, nil)
			for _, step := range test.steps {
				step(t, keys, peer)
			}
			waitClosed(t, conn, test.want)
		})
	}
}

func TestRepeatedPongClosesTheChannel(t *testing.T) {
	keys := newKeys(t)
	conn, peer := connWithRaw(t, keys, identity.RolePhone, nil)
	answered := make(chan error, 1)
	go func() {
		_, err := conn.Ping(testContext(t))
		answered <- err
	}()
	ping := peer.expect(typePing)
	peer.mustSend(message{Type: typePong, Pong: &pong{Ping: ping.Seq}})
	if err := <-answered; err != nil {
		t.Fatal(err)
	}
	_ = peer.send(message{Type: typePong, Pong: &pong{Ping: ping.Seq}})
	waitClosed(t, conn, ErrReplay)
}

func TestLateAckIsDroppedButARepeatedOneCloses(t *testing.T) {
	keys := newKeys(t)
	nat := newFakeNAT()
	puncher := &fakePuncher{nat: nat}
	conn, peer := connWithRaw(t, keys, identity.RolePhone, func(config *Config) { config.Puncher = puncher })
	ctx := testContext(t)
	if _, err := conn.SendCandidates(ctx, []pairing.Candidate{lan("192.168.1.20:50000")}, 0); err != nil {
		t.Fatal(err)
	}
	peer.expect(typeCandidates)
	peer.mustSend(candidatesMessage(lan("192.168.1.10:4740")))

	punchContext, cancel := context.WithCancel(ctx)
	punched := make(chan error, 1)
	go func() {
		_, err := conn.Punch(punchContext)
		punched <- err
	}()
	request := peer.expect(typePunchRequest)
	if request.PunchRequest.Candidates != 2 {
		t.Fatalf("punch request names frame %d, want the candidates frame 2", request.PunchRequest.Candidates)
	}
	cancel()
	if err := <-punched; !errors.Is(err, context.Canceled) {
		t.Fatalf("Punch error = %v, want cancellation", err)
	}

	peer.mustSend(message{Type: typePunchAck, PunchAck: &punchAck{Request: request.Seq, Accepted: true}})
	peer.mustSend(message{Type: typePing})
	if pong := peer.expect(typePong); pong.Pong.Ping != peer.seq {
		t.Fatalf("pong answers frame %d, want %d", pong.Pong.Ping, peer.seq)
	}
	if conn.Err() != nil {
		t.Fatalf("late ack closed the channel: %v", conn.Err())
	}
	if _, dialed := puncher.calls(); len(dialed) != 0 {
		t.Fatalf("abandoned punch dialed %v", dialed)
	}

	_ = peer.send(message{Type: typePunchAck, PunchAck: &punchAck{Request: request.Seq, Accepted: true}})
	waitClosed(t, conn, ErrReplay)
}

func TestInvalidFramesCloseTheChannel(t *testing.T) {
	for name, test := range map[string]struct {
		frame []byte
		want  error
	}{
		"header above 16 KiB": {frame: binary.BigEndian.AppendUint32(nil, MaxFrameSize+1), want: ErrFrameTooLarge},
		"huge header":         {frame: binary.BigEndian.AppendUint32(nil, 1<<31), want: ErrFrameTooLarge},
		"empty frame":         {frame: binary.BigEndian.AppendUint32(nil, 0), want: ErrInvalidFrame},
		"malformed json":      {frame: appendFrame(nil, []byte(`{"type":"ping","seq":2`)), want: ErrInvalidFrame},
		"unknown field":       {frame: appendFrame(nil, []byte(`{"type":"ping","seq":2,"x":1}`)), want: ErrInvalidFrame},
		"unknown type":        {frame: appendFrame(nil, []byte(`{"type":"bye","seq":2}`)), want: ErrInvalidFrame},
		"truncated frame":     {frame: appendFrame(nil, []byte(`{"type":"ping","seq":2}`))[:10], want: transport.ErrClosed},
	} {
		t.Run(name, func(t *testing.T) {
			keys := newKeys(t)
			conn, peer := connWithRaw(t, keys, identity.RoleDesktop, nil)
			_ = peer.writeRaw(test.frame)
			if test.want == transport.ErrClosed {
				_ = peer.conn.Close()
			}
			waitClosed(t, conn, test.want)
		})
	}
}

func TestFrameOfExactly16KiBIsAccepted(t *testing.T) {
	keys := newKeys(t)
	conn, peer := connWithRaw(t, keys, identity.RoleDesktop, nil)
	peer.seq++
	if err := peer.writeRaw(appendFrame(nil, paddedPing(peer.seq, MaxFrameSize))); err != nil {
		t.Fatal(err)
	}
	if pong := peer.expect(typePong); pong.Pong.Ping != peer.seq {
		t.Fatalf("pong answers frame %d, want %d", pong.Pong.Ping, peer.seq)
	}
	if conn.Err() != nil {
		t.Fatal(conn.Err())
	}
}
