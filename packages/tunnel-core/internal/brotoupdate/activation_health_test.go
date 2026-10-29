//go:build !windows

package brotoupdate

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"
)

func TestUnixActivationCommitsOnlyAfterHealth(t *testing.T) {
	healthy := false
	committedCandidate := false
	starts, stops := 0, 0
	ops := unixActivationOps{stop: func(context.Context) error { stops++; return nil }, start: func(context.Context) error { starts++; healthy = true; return nil }, write: func(data []byte) error { committedCandidate = bytes.Equal(data, []byte("next")); return nil }, probe: func(ctx context.Context, binary, state string) (int, error) {
		if state != "custom-state" {
			t.Fatal("health lost the configured state directory")
		}
		if healthy {
			return 22, nil
		}
		return 11, nil
	}}
	if e := activateUnixTransition(context.Background(), Result{PreviousBinary: "old", NextBinary: "next", StateDir: "custom-state"}, []byte("old"), []byte("next"), ops); e != nil {
		t.Fatal(e)
	}
	if !committedCandidate || starts != 1 || stops != 1 {
		t.Fatal("unexpected activation steps")
	}
}
func TestUnixActivationRestoresServiceWhenCandidateIsUnhealthy(t *testing.T) {
	descriptor := "old"
	starts, stops := 0, 0
	ops := unixActivationOps{stop: func(context.Context) error { stops++; return nil }, start: func(context.Context) error { starts++; return nil }, write: func(data []byte) error { descriptor = string(data); return nil }, probe: func(ctx context.Context, binary, state string) (int, error) {
		if binary == "next" {
			return 0, errors.New("candidate crashed")
		}
		if starts > 1 {
			return 33, nil
		}
		return 11, nil
	}}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if e := activateUnixTransition(ctx, Result{PreviousBinary: "old", NextBinary: "next"}, []byte("old"), []byte("next"), ops); e == nil {
		t.Fatal("unhealthy service accepted")
	}
	if descriptor != "old" || starts != 2 || stops != 2 {
		t.Fatal("candidate was not stopped and old service restored")
	}
}
