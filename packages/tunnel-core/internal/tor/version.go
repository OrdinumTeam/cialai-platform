// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Version runs the bundled tor with --version, the same way the desktop
// supervisor starts it, and returns the first output line. The doctor uses it
// to show that the packaged binary, its libraries and its signature load on
// this system.
func Version(ctx context.Context, executable string) (string, error) {
	if !filepath.IsAbs(executable) {
		return "", errors.New("tor executable path must be absolute")
	}
	if info, err := os.Stat(executable); err != nil {
		return "", fmt.Errorf("tor executable: %w", err)
	} else if !info.Mode().IsRegular() {
		return "", errors.New("tor executable is not a regular file")
	}
	command := exec.CommandContext(ctx, executable, "--version")
	command.Dir = filepath.Dir(executable)
	command.WaitDelay = waitDelay
	hideWindow(command)
	output, err := command.Output()
	if err != nil {
		return "", fmt.Errorf("run tor --version: %w", err)
	}
	line, _, _ := bufio.NewReader(bytes.NewReader(output)).ReadLine()
	version := strings.TrimSpace(string(line))
	if !strings.HasPrefix(version, "Tor version ") {
		return "", errors.New("tor --version printed an unexpected banner")
	}
	return version, nil
}
