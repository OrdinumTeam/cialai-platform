// SPDX-License-Identifier: Apache-2.0
package rendezvous

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/pairing"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

func TestChannelDeliversTypedMessagesInOrder(t *testing.T) {
	keys := newKeys(t)
	var mu sync.Mutex
	var events []string
	record := func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, fmt.Sprintf(format, args...))
	}
	reports := make(chan PathReport, 1)
	phone, desktop := connPair(t, keys, func(config *Config) {
		config.Handler = Handler{
			Candidates: func(set CandidateSet) {
				record("candidates seq=%d %s", set.Seq, set.Candidates[0].Address)
			},
			ReachUpdate: func(card candidates.Card) { record("reach %s", card.Candidates[0].Address) },
		}
	}, func(config *Config) {
		config.Handler.PathReport = func(report PathReport) { reports <- report }
	})
	if phone.PeerKey() != keys.desktop.PublicKeyString() || desktop.PeerKey() != keys.phone.PublicKeyString() {
		t.Fatal("peer keys were not taken from the sessions")
	}
	ctx := testContext(t)

	for index := range 3 {
		if _, err := desktop.SendCandidates(ctx, []pairing.Candidate{lan(fmt.Sprintf("192.168.1.%d:4740", 10+index))}, 0); err != nil {
			t.Fatal(err)
		}
	}
	if err := desktop.SendReachUpdate(ctx, testCard(t, keys.desktop, lan("192.168.1.20:4740"))); err != nil {
		t.Fatal(err)
	}
	// The pong leaves after the phone handled every earlier frame.
	if rtt, err := desktop.Ping(ctx); err != nil || rtt <= 0 {
		t.Fatalf("ping = %v, %v", rtt, err)
	}
	mu.Lock()
	got := slices.Clone(events)
	mu.Unlock()
	want := []string{
		"candidates seq=2 192.168.1.10:4740", "candidates seq=3 192.168.1.11:4740",
		"candidates seq=4 192.168.1.12:4740", "reach 192.168.1.20:4740",
	}
	if !slices.Equal(got, want) {
		t.Fatalf("phone saw %q, want %q", got, want)
	}
	if set, ok := phone.PeerCandidates(); !ok || set.Seq != 4 {
		t.Fatalf("phone peer candidates = %+v, %v", set, ok)
	}
	if set, ok := desktop.LocalCandidates(); !ok || set.Seq != 4 || set.Candidates[0].Address != "192.168.1.12:4740" {
		t.Fatalf("desktop local candidates = %+v, %v", set, ok)
	}

	report := PathReport{Path: transport.NameDirect, Address: "192.168.1.20:4740", RTTMillis: 3}
	if err := phone.ReportPath(ctx, report); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-reports:
		if got != report {
			t.Fatalf("desktop got %+v, want %+v", got, report)
		}
	case <-time.After(testTimeout):
		t.Fatal("path report not delivered")
	}
}

func TestLocalRoleAndCardChecksDoNotCloseTheChannel(t *testing.T) {
	keys := newKeys(t)
	phone, desktop := connPair(t, keys, nil, nil)
	ctx := testContext(t)
	if err := desktop.ReportPath(ctx, PathReport{Path: transport.NameTor}); !errors.Is(err, ErrProtocol) {
		t.Fatalf("desktop path report error = %v", err)
	}
	if err := phone.SendReachUpdate(ctx, testCard(t, keys.desktop)); !errors.Is(err, ErrPeerMismatch) {
		t.Fatalf("phone reach update error = %v", err)
	}
	if _, err := desktop.Punch(ctx); !errors.Is(err, ErrProtocol) {
		t.Fatalf("desktop punch error = %v", err)
	}
	if err := phone.ReportPath(ctx, PathReport{Path: transport.NameDirect}); !errors.Is(err, ErrInvalidFrame) {
		t.Fatalf("invalid path report error = %v", err)
	}
	if _, err := phone.SendCandidates(ctx, nil, time.Hour); err == nil {
		t.Fatal("candidate TTL above the maximum was accepted")
	}
	for _, conn := range []*Conn{phone, desktop} {
		if _, err := conn.Ping(ctx); err != nil {
			t.Fatalf("%s channel broke: %v", conn.Role(), err)
		}
	}
}

func TestSendCandidatesKeepsUsableOnes(t *testing.T) {
	keys := newKeys(t)
	received := make(chan CandidateSet, 1)
	_, desktop := connPair(t, keys, func(config *Config) {
		config.Handler.Candidates = func(set CandidateSet) { received <- set }
	}, nil)
	list := []pairing.Candidate{lan("192.168.1.10:4740"), lan("8.8.8.8:4740"), lan("192.168.1.10:4740")}
	for index := range MaxCandidates {
		list = append(list, lan(fmt.Sprintf("10.0.0.%d:4740", index+1)))
	}
	sent, err := desktop.SendCandidates(testContext(t), list, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(sent.Candidates) != MaxCandidates || sent.Candidates[0].Address != "192.168.1.10:4740" || sent.Candidates[1].Address != "10.0.0.1:4740" {
		t.Fatalf("sent %v", sent.Candidates)
	}
	if !sent.ExpiresAt.Equal(sent.At.Add(DefaultCandidateTTL)) {
		t.Fatalf("sent expiry %s after %s", sent.ExpiresAt, sent.At)
	}
	select {
	case got := <-received:
		if !slices.Equal(got.Candidates, sent.Candidates) || got.Seq != sent.Seq {
			t.Fatalf("phone got %+v, desktop sent %+v", got, sent)
		}
	case <-time.After(testTimeout):
		t.Fatal("candidates not delivered")
	}
}

func TestConcurrentSendsKeepTheSequence(t *testing.T) {
	keys := newKeys(t)
	var delivered atomic.Int64
	phone, desktop := connPair(t, keys, func(config *Config) {
		config.Handler.Candidates = func(CandidateSet) { delivered.Add(1) }
	}, nil)
	ctx := testContext(t)
	const senders, perSender = 8, 10
	var wait sync.WaitGroup
	errs := make(chan error, senders*perSender+senders)
	for sender := range senders {
		wait.Go(func() {
			for index := range perSender {
				address := fmt.Sprintf("192.168.%d.%d:4740", sender+1, index+1)
				if _, err := desktop.SendCandidates(ctx, []pairing.Candidate{lan(address)}, 0); err != nil {
					errs <- err
				}
			}
		})
		wait.Go(func() {
			if _, err := phone.Ping(ctx); err != nil {
				errs <- err
			}
		})
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	if _, err := desktop.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	if got := delivered.Load(); got != senders*perSender {
		t.Fatalf("phone handled %d lists, want %d", got, senders*perSender)
	}
	if phone.Err() != nil || desktop.Err() != nil {
		t.Fatalf("channels failed: phone %v, desktop %v", phone.Err(), desktop.Err())
	}
}

func TestEstablishRefusesAStreamOfAnotherSession(t *testing.T) {
	keys := newKeys(t)
	near, far := net.Pipe()
	defer far.Close()
	stream := pipeStream{Conn: near, session: newFakeSession(generate(t, identity.RoleDesktop).PublicKeyString())}
	_, err := Establish(testContext(t), stream, keys.config(identity.RolePhone))
	if !errors.Is(err, ErrPeerMismatch) {
		t.Fatalf("Establish error = %v", err)
	}
	if _, err := near.Write([]byte{0}); !errors.Is(err, io.ErrClosedPipe) {
		t.Fatalf("write on the refused stream = %v, want it closed", err)
	}
}

func TestEstablishValidatesConfig(t *testing.T) {
	keys := newKeys(t)
	for name, change := range map[string]func(*Config){
		"unknown role":    func(config *Config) { config.Role = "tablet" },
		"bad local key":   func(config *Config) { config.LocalKey = "abc" },
		"missing peerKey": func(config *Config) { config.PeerKey = "" },
	} {
		t.Run(name, func(t *testing.T) {
			near, far := net.Pipe()
			defer far.Close()
			config := keys.config(identity.RolePhone)
			change(&config)
			if conn, err := Establish(testContext(t), near, config); err == nil {
				_ = conn.Close()
				t.Fatal("invalid config accepted")
			}
		})
	}
}

func TestHelloMismatchesAreRefused(t *testing.T) {
	keys := newKeys(t)
	stranger := generate(t, identity.RoleDesktop).PublicKeyString()
	for name, test := range map[string]struct {
		hello message
		want  error
	}{
		"key of another desktop": {
			hello: message{Type: typeHello, Hello: &hello{Proto: ProtocolVersion, Role: string(identity.RoleDesktop), Key: stranger}},
			want:  ErrPeerMismatch,
		},
		"same role as the phone": {
			hello: message{Type: typeHello, Hello: &hello{Proto: ProtocolVersion, Role: string(identity.RolePhone), Key: keys.desktop.PublicKeyString()}},
			want:  ErrPeerMismatch,
		},
		"newer protocol": {
			hello: message{Type: typeHello, Hello: &hello{Proto: ProtocolVersion + 1, Role: string(identity.RoleDesktop), Key: keys.desktop.PublicKeyString()}},
			want:  ErrUnsupportedVersion,
		},
		"ping before hello": {hello: message{Type: typePing}, want: ErrProtocol},
		"invalid hello key": {
			hello: message{Type: typeHello, Hello: &hello{Proto: ProtocolVersion, Role: string(identity.RoleDesktop), Key: "abc"}},
			want:  ErrInvalidFrame,
		},
	} {
		t.Run(name, func(t *testing.T) {
			peer, results := establishRaw(t, keys, identity.RolePhone, nil)
			peer.expect(typeHello)
			_ = peer.send(test.hello)
			if result := waitEstablish(t, results); !errors.Is(result.err, test.want) {
				t.Fatalf("Establish error = %v, want %v", result.err, test.want)
			}
		})
	}
}

func TestHelloWaitIsBounded(t *testing.T) {
	keys := newKeys(t)
	peer, results := establishRaw(t, keys, identity.RoleDesktop, func(config *Config) {
		config.HelloTimeout = 50 * time.Millisecond
	})
	peer.expect(typeHello)
	if result := waitEstablish(t, results); !errors.Is(result.err, context.DeadlineExceeded) {
		t.Fatalf("Establish error = %v, want a deadline", result.err)
	}

	near, far := net.Pipe()
	newRawPeer(t, far, true)
	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(20*time.Millisecond, cancel)
	if _, err := Establish(ctx, near, keys.config(identity.RolePhone)); !errors.Is(err, context.Canceled) {
		t.Fatalf("Establish error = %v, want cancellation", err)
	}
}

func TestCloseEndsBothSides(t *testing.T) {
	keys := newKeys(t)
	phone, desktop := connPair(t, keys, nil, nil)
	if err := phone.Close(); err != nil {
		t.Fatal(err)
	}
	if !errors.Is(phone.Err(), transport.ErrClosed) {
		t.Fatalf("phone error = %v", phone.Err())
	}
	waitClosed(t, desktop, transport.ErrClosed)
	ctx := testContext(t)
	if _, err := phone.SendCandidates(ctx, nil, 0); !errors.Is(err, transport.ErrClosed) {
		t.Fatalf("send after close = %v", err)
	}
	if _, err := desktop.Ping(ctx); !errors.Is(err, transport.ErrClosed) {
		t.Fatalf("ping after peer close = %v", err)
	}
	if _, err := phone.Punch(ctx); err == nil {
		t.Fatal("punch after close succeeded")
	}
}

func TestKeepaliveHoldsAQuietChannel(t *testing.T) {
	keys := newKeys(t)
	fast := func(config *Config) {
		config.PingInterval = 10 * time.Millisecond
		config.IdleTimeout = 100 * time.Millisecond
	}
	phone, desktop := connPair(t, keys, fast, fast)
	time.Sleep(300 * time.Millisecond)
	if phone.Err() != nil || desktop.Err() != nil {
		t.Fatalf("keepalive failed: phone %v, desktop %v", phone.Err(), desktop.Err())
	}
}

func TestIdleTimeoutClosesASilentPeer(t *testing.T) {
	keys := newKeys(t)
	for name, setup := range map[string]func(*Config){
		"pings unanswered": func(config *Config) {
			config.PingInterval = 10 * time.Millisecond
			config.IdleTimeout = 60 * time.Millisecond
		},
		"idle limit without pings": func(config *Config) {
			config.PingInterval = -1
			config.IdleTimeout = 60 * time.Millisecond
		},
	} {
		t.Run(name, func(t *testing.T) {
			// The idle time counts from the hello, so it cannot end before
			// the setup started.
			started := time.Now()
			conn, peer := connWithRaw(t, keys, identity.RolePhone, setup)
			waitClosed(t, conn, ErrIdleTimeout)
			if elapsed := time.Since(started); elapsed < 60*time.Millisecond {
				t.Fatalf("closed after %s, before the idle timeout", elapsed)
			}
			if name == "pings unanswered" {
				peer.expect(typePing)
			}
		})
	}
}

func TestPeerThatDoesNotReadAnswersIsDropped(t *testing.T) {
	keys := newKeys(t)
	near, far := net.Pipe()
	peer := newRawPeer(t, far, false)
	results := make(chan establishResult, 1)
	go func() {
		conn, err := Establish(testContext(t), near, keys.config(identity.RoleDesktop))
		results <- establishResult{conn: conn, err: err}
	}()
	// The desktop hello is never read, so its writer stays blocked while the
	// pongs pile up.
	peer.mustSend(keys.hello(identity.RolePhone))
	result := waitEstablish(t, results)
	if result.err != nil {
		t.Fatal(result.err)
	}
	for range replyBacklog + 2 {
		if err := peer.send(message{Type: typePing}); err != nil {
			break
		}
	}
	waitClosed(t, result.conn, ErrProtocol)
}
