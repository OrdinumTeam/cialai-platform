// SPDX-License-Identifier: Apache-2.0
// Package commandlauncher is the native Windows command, without batch parsing.
package commandlauncher

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

const Marker = "cialai-command-native-v3"

type Config struct {
	Marker   string `json:"marker"`
	Launcher string `json:"launcher"`
	Sidecar  string `json:"sidecar"`
}

func Run(ctx context.Context, executable string, args []string, in io.Reader, out, stderr io.Writer) int {
	file, err := os.Open(filepath.Join(filepath.Dir(executable), "cialai-command.json"))
	if err != nil {
		fmt.Fprintln(stderr, Marker+": abra o Cialai para reparar o comando.")
		return 120
	}
	defer file.Close()
	var config Config
	decoder := json.NewDecoder(io.LimitReader(file, 65536))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&config) != nil || config.Marker != Marker || !filepath.IsAbs(config.Launcher) || !filepath.IsAbs(config.Sidecar) {
		fmt.Fprintln(stderr, Marker+": configuração local inválida; abra o Cialai para reparar o comando.")
		return 120
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return 120
	}
	if len(args) == 0 {
		if err := launchDesktop(config.Launcher); err != nil {
			fmt.Fprintln(stderr, "Não foi possível abrir o Cialai.")
			return 120
		}
		return 0
	}
	if args[0] != "broto" {
		fmt.Fprintln(stderr, "uso: cialai [broto <ação>]")
		return 125
	}
	// Arguments go straight to CreateProcess/exec, without cmd, PowerShell,
	// string concatenation, percent expansion or another shell parse.
	command := exec.CommandContext(ctx, config.Sidecar, args...)
	command.Stdin, command.Stdout, command.Stderr = in, out, stderr
	hideCommand(command)
	if err = command.Run(); err == nil {
		return 0
	}
	if exited, ok := err.(*exec.ExitError); ok {
		return exited.ExitCode()
	}
	fmt.Fprintln(stderr, "O comando do Cialai não está disponível; abra o aplicativo para reparar.")
	return 120
}
