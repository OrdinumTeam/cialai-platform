// SPDX-License-Identifier: Apache-2.0
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/logx"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/sidecar"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/statedir"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	ps "github.com/mitchellh/go-ps"
)

type streams struct {
	in  io.Reader
	out io.Writer
	err io.Writer
}

func main() {
	os.Exit(run(os.Args[1:], streams{in: os.Stdin, out: os.Stdout, err: os.Stderr}, processAlive))
}

func run(args []string, stdio streams, alive func(int) bool) int {
	if len(args) == 0 {
		_, _ = fmt.Fprintln(stdio.err, "uso: cialai-tunnel <serve-stdio|doctor|version>")
		return 2
	}
	switch args[0] {
	case "version":
		if len(args) != 1 {
			return 2
		}
		_, _ = fmt.Fprintf(stdio.out, "cialai-tunnel %s\ntailscale %s\n", sidecar.Version, sidecar.TailscaleVersion)
		return 0
	case "doctor":
		return runDoctor(args[1:], stdio)
	case "serve-stdio":
		return runServe(args[1:], stdio, alive)
	default:
		_, _ = fmt.Fprintln(stdio.err, "comando desconhecido")
		return 2
	}
}

func runServe(args []string, stdio streams, alive func(int) bool) int {
	flags := flag.NewFlagSet("serve-stdio", flag.ContinueOnError)
	flags.SetOutput(stdio.err)
	stateDir := flags.String("state-dir", "", "diretório de estado")
	parentPID := flags.Int("parent-pid", 0, "PID do processo pai")
	level := flags.String("log-level", "info", "nível info ou debug")
	logFile := flags.String("log-file", "", "arquivo de log")
	torBin := flags.String("tor-bin", "", "executável do Tor embutido")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *stateDir == "" || *parentPID <= 0 || alive == nil || !alive(*parentPID) {
		return 2
	}
	if *torBin != "" && !filepath.IsAbs(*torBin) {
		_, _ = fmt.Fprintln(stdio.err, "o caminho do Tor precisa ser absoluto")
		return 2
	}
	paths, err := statedir.Prepare(*stateDir)
	if err != nil {
		_, _ = fmt.Fprintln(stdio.err, "não foi possível preparar o diretório de estado")
		return 2
	}
	lock, err := statedir.Acquire(paths, os.Getpid(), alive)
	if err != nil {
		_, _ = fmt.Fprintln(stdio.err, "o núcleo do túnel já está em execução")
		return 2
	}
	defer lock.Release()
	path := *logFile
	if path == "" {
		path = paths.Log
	}
	if !filepath.IsAbs(path) {
		_, _ = fmt.Fprintln(stdio.err, "o caminho do log precisa ser absoluto")
		return 2
	}
	rotating, err := logx.NewRotatingFile(path, 2<<20, 5)
	if err != nil {
		_, _ = fmt.Fprintln(stdio.err, "não foi possível abrir o log do túnel")
		return 2
	}
	defer rotating.Close()
	logger := logx.New(io.MultiWriter(stdio.err, rotating), 500)
	if err := logger.SetLevel(*level); err != nil {
		_, _ = fmt.Fprintln(stdio.err, "o nível de log precisa ser info ou debug")
		return 2
	}
	return sidecar.Serve(context.Background(), sidecar.Options{
		Paths: paths, Input: stdio.in, Output: stdio.out, Logger: logger,
		ParentPID: *parentPID, Alive: alive, HandshakeTimeout: 5 * time.Second,
		TorExecutable: *torBin,
	})
}

func runDoctor(args []string, stdio streams) int {
	flags := flag.NewFlagSet("doctor", flag.ContinueOnError)
	flags.SetOutput(stdio.err)
	stateDir := flags.String("state-dir", "", "diretório de estado")
	controlURL := flags.String("control-url", "", "URL do Headscale")
	torBin := flags.String("tor-bin", "", "executável do Tor embutido")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || *stateDir == "" {
		return 2
	}
	paths, err := statedir.Prepare(*stateDir)
	result := map[string]any{"version": sidecar.Version, "stateDir": *stateDir, "checks": map[string]any{}}
	checks := result["checks"].(map[string]any)
	if err != nil {
		checks["state"] = map[string]any{"ok": false, "message": "O diretório de estado não está disponível."}
		result["ok"] = false
		_ = json.NewEncoder(stdio.out).Encode(result)
		return 1
	}
	checks["state"] = map[string]any{"ok": true, "path": paths.Root}
	result["ok"] = true
	if *controlURL != "" {
		check, checkErr := checkControl(*controlURL)
		checks["control"] = check
		if checkErr != nil {
			result["ok"] = false
		}
	}
	if *torBin != "" {
		check, checkErr := checkTor(*torBin)
		checks["tor"] = check
		if checkErr != nil {
			result["ok"] = false
		}
	}
	_ = json.NewEncoder(stdio.out).Encode(result)
	if result["ok"] == false {
		return 1
	}
	return 0
}

func checkControl(raw string) (map[string]any, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return map[string]any{"ok": false, "message": "A URL do Headscale é inválida."}, errors.New("invalid control URL")
	}
	if parsed.Scheme == "http" {
		ip := net.ParseIP(parsed.Hostname())
		if ip == nil || !ip.IsLoopback() {
			return map[string]any{"ok": false, "message": "O Headscale precisa usar HTTPS fora do computador."}, errors.New("insecure control URL")
		}
	}
	client := &http.Client{Timeout: 5 * time.Second}
	request, _ := http.NewRequest(http.MethodGet, strings.TrimRight(parsed.String(), "/")+"/health", nil)
	response, err := client.Do(request)
	if err != nil {
		return map[string]any{"ok": false, "message": "O servidor Headscale não respondeu."}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return map[string]any{"ok": false, "message": "A saúde do Headscale respondeu com HTTP " + strconv.Itoa(response.StatusCode) + "."}, errors.New("unhealthy control server")
	}
	return map[string]any{"ok": true, "host": parsed.Hostname()}, nil
}

// checkTor runs the bundled tor with --version, which proves that the
// installer placed the binary and its libraries where the supervisor looks.
func checkTor(executable string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	version, err := tor.Version(ctx, executable)
	if err != nil {
		return map[string]any{"ok": false, "message": "O Tor embutido não foi encontrado ou não abriu."}, err
	}
	return map[string]any{"ok": true, "version": version}, nil
}

func processAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	process, err := ps.FindProcess(pid)
	return err == nil && process != nil
}
