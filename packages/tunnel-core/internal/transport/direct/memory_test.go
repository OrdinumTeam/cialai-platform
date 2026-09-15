// SPDX-License-Identifier: Apache-2.0
package direct

import (
	"context"
	"runtime"
	"testing"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/identity"
)

// BenchmarkSessionMemory keeps b.N registered sessions alive, each after one
// echoed stream, and reports the retained heap and goroutines per session
// pair: both the dialing and the accepting end live in this process.
// Run with: go test -run '^$' -bench SessionMemory -benchtime 200x
func BenchmarkSessionMemory(b *testing.B) {
	h := newHarness(b, ListenConfig{})
	phone := mustIdentity(b, identity.RolePhone)
	h.registry.register(phone)
	client := newTestEndpoint(b, phone)
	address := h.listener.Addr().String()
	desktopKey := h.desktop.PublicKey()

	runtime.GC()
	var before runtime.MemStats
	runtime.ReadMemStats(&before)
	goroutines := runtime.NumGoroutine()
	kept := make([]*Session, 0, 2*b.N)
	b.ResetTimer()
	for range b.N {
		ctx, cancel := context.WithTimeout(context.Background(), testTimeout)
		dialed, err := client.Dial(ctx, address, desktopKey)
		cancel()
		if err != nil {
			b.Fatal(err)
		}
		accepted := h.accept(b)
		serveEcho(accepted)
		conn := openStream(b, dialed)
		if err := echoPayload(conn, 1024); err != nil {
			b.Fatal(err)
		}
		_ = conn.Close()
		kept = append(kept, dialed.(*Session), accepted)
	}
	b.StopTimer()
	time.Sleep(100 * time.Millisecond) // Let finished stream goroutines exit.
	runtime.GC()
	var after runtime.MemStats
	runtime.ReadMemStats(&after)
	b.ReportMetric(float64(int64(after.HeapInuse)-int64(before.HeapInuse))/float64(b.N), "heap-B/pair")
	b.ReportMetric(float64(runtime.NumGoroutine()-goroutines)/float64(b.N), "goroutines/pair")
	runtime.KeepAlive(kept)
}
