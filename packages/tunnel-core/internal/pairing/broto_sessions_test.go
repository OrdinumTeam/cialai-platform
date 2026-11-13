// SPDX-License-Identifier: Apache-2.0
package pairing

import (
	"testing"
	"time"
)

func TestBrotoApprovalBoundToFirstKey(t *testing.T) {
	now := testNow
	s := NewSessions(func() time.Time { return now }, nil)
	a, err := s.BeginBroto(Payload{Desktop: testDesktop("Host"), Onion: testOnion(testPublicKey(0x22), "443")})
	if err != nil {
		t.Fatal(err)
	}
	p, err := DecodeBroto(a.Payload)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = Decode(a.Payload); err == nil {
		t.Fatal("phone decoder accepts Broto")
	}
	if _, err = s.Consume(a.PairID, p.Secret); err == nil {
		t.Fatal("phone consumed Broto")
	}
	input := testDeviceInput(80)
	called := false
	finish := func() error { called = true; return nil }
	ready, err := s.PollBroto(a.PairID, p.Secret, input, finish)
	if err != nil || ready || called {
		t.Fatal("unapproved execution", err)
	}
	if len(s.PendingBrotos()) != 1 {
		t.Fatal("pending missing")
	}
	if _, err = s.PollBroto(a.PairID, p.Secret, testDeviceInput(81), finish); err == nil {
		t.Fatal("second key claimed code")
	}
	if err = s.DecideBroto(a.PairID, true); err != nil {
		t.Fatal(err)
	}
	ready, err = s.PollBroto(a.PairID, p.Secret, input, finish)
	if err != nil || !ready || !called {
		t.Fatal("approval not applied", err)
	}
	if _, err = s.PollBroto(a.PairID, p.Secret, input, finish); err == nil {
		t.Fatal("replay accepted")
	}
	now = now.Add(11 * time.Minute)
	if len(s.PendingBrotos()) != 0 {
		t.Fatal("expired pending")
	}
}

func TestBrotoDenialAndExpiryNeverRegister(t *testing.T) {
	for _, deny := range []bool{true, false} {
		now := testNow
		s := NewSessions(func() time.Time { return now }, nil)
		active, err := s.BeginBroto(Payload{Desktop: testDesktop("Host"), Onion: testOnion(testPublicKey(0x22), "443")})
		if err != nil {
			t.Fatal(err)
		}
		p, _ := DecodeBroto(active.Payload)
		input := testDeviceInput(81)
		called := false
		finish := func() error { called = true; return nil }
		if _, err = s.PollBroto(active.PairID, p.Secret, input, finish); err != nil {
			t.Fatal(err)
		}
		if deny {
			if err = s.DecideBroto(active.PairID, false); err != nil {
				t.Fatal(err)
			}
		} else {
			now = now.Add(MaxSessionTTL)
		}
		if _, err = s.PollBroto(active.PairID, p.Secret, input, finish); err == nil || called {
			t.Fatal("denied or expired code accepted")
		}
		if len(s.PendingBrotos()) != 0 {
			t.Fatal("dead request remains visible")
		}
	}
}
