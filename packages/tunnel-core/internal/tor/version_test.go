// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestVersionRunsTheExecutable(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(fakeTorEnv, "1")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	version, err := Version(ctx, executable)
	if err != nil || version != fakeTorVersion {
		t.Fatalf("Version = %q, %v", version, err)
	}
}

func TestVersionRejectsInvalidExecutables(t *testing.T) {
	dir := t.TempDir()
	for name, path := range map[string]string{
		"relative":  "tor",
		"missing":   filepath.Join(dir, "missing"),
		"directory": dir,
	} {
		if _, err := Version(context.Background(), path); err == nil {
			t.Errorf("%s executable was accepted", name)
		}
	}
}
