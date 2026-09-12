// SPDX-License-Identifier: Apache-2.0
package node

import (
	"context"
	"errors"
	"reflect"
	"testing"
)

func TestPrepareTSNetLoginOnlyForcesExplicitRequests(t *testing.T) {
	var calls []string
	start := func() error { calls = append(calls, "start"); return nil }
	login := func(context.Context) error { calls = append(calls, "login"); return nil }
	if err := prepareTSNetLogin(context.Background(), false, start, login); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 0 {
		t.Fatalf("ordinary startup forced login: %v", calls)
	}
	if err := prepareTSNetLogin(context.Background(), true, start, login); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(calls, []string{"start", "login"}) {
		t.Fatalf("force login order is wrong: %v", calls)
	}
}

func TestPrepareTSNetLoginStopsAfterStartFailure(t *testing.T) {
	want := errors.New("start failed")
	loginCalled := false
	err := prepareTSNetLogin(context.Background(), true, func() error { return want }, func(context.Context) error {
		loginCalled = true
		return nil
	})
	if !errors.Is(err, want) || loginCalled {
		t.Fatalf("unexpected force login result: %v login=%v", err, loginCalled)
	}
}
