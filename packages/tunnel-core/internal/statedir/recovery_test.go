package statedir

import (
	"bytes"
	"fmt"
	"os"
	"testing"
)

func TestAcquireRecoversUnownedPersistentPID(t *testing.T) {
	pid := os.Getpid()
	tests := []struct {
		name    string
		pidFile string
	}{
		{"recycled PID in JSON", fmt.Sprintf(`{"pid":%d,"nonce":"old-boot"}`, pid)},
		{"recycled legacy decimal PID", fmt.Sprintf("%d\n", pid)},
		{"old nonexistent PID", `{"pid":2147483647,"nonce":"previous-process"}`},
		{"persistent metadata after simulated reboot", fmt.Sprintf(`{"pid":%d,"nonce":"previous-boot","mechanism":"os-lock-v1"}`, pid)},
		{"empty file", ""},
		{"partial JSON", `{"pid":`},
		{"corrupt file", "not a PID record\n"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			paths, err := Prepare(t.TempDir())
			if err != nil {
				t.Fatalf("prepare temporary state: %v", err)
			}
			fixtures := map[string][]byte{
				paths.Devices:     []byte("pairing fixture: retain device state\n"),
				paths.IdentityKey: []byte("identity fixture: retain identity state\n"),
			}
			for path, contents := range fixtures {
				if err := paths.WriteAtomic(path, contents); err != nil {
					t.Fatalf("write pairing fixture %s: %v", path, err)
				}
			}
			t.Cleanup(func() {
				for path, want := range fixtures {
					got, err := os.ReadFile(path)
					if err != nil {
						t.Errorf("read pairing fixture after recovery %s: %v", path, err)
						continue
					}
					if !bytes.Equal(got, want) {
						t.Errorf("recovery changed pairing fixture %s: got %q, want %q", path, got, want)
					}
				}
			})
			if err := paths.WriteAtomic(paths.PID, []byte(tt.pidFile)); err != nil {
				t.Fatalf("write unowned persistent PID file: %v", err)
			}

			lock, err := Acquire(paths, pid, func(int) bool { return true })
			if err != nil {
				t.Fatalf("unowned persistent PID file must allow acquisition even when its PID is alive: %v", err)
			}
			if lock == nil {
				t.Fatal("successful acquisition returned no lock")
			}
			t.Cleanup(func() {
				if err := lock.Release(); err != nil {
					t.Errorf("release recovered lock: %v", err)
				}
			})
		})
	}
}
