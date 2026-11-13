package brotoclient

import (
	"context"
	"runtime"
	"testing"
	"time"
)

func TestTorProcessWaitCanBeObservedAndClosed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix fixture")
	}
	process, err := (torCreator{executable: "/bin/sh"}).New(context.Background(), "-c", "exit 7")
	if err != nil {
		t.Fatal(err)
	}
	if err = process.Start(); err != nil {
		t.Fatal(err)
	}
	if process.Wait() == nil || process.Wait() == nil {
		t.Fatal("process status not preserved for supervisor and close")
	}
	ctx, cancel := context.WithCancel(context.Background())
	process, err = (torCreator{executable: "/bin/sleep"}).New(ctx, "20")
	if err != nil {
		t.Fatal(err)
	}
	if err = process.Start(); err != nil {
		t.Fatal(err)
	}
	cancel()
	done := make(chan struct{})
	go func() { _ = process.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Tor child outlived owner context")
	}
}
