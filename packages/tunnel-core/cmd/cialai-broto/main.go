package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoclient"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoinstall"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/brotoupdate"
	"github.com/Cialai/cialai/packages/tunnel-core/internal/transport/candidates"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	flags := flag.NewFlagSet("cialai-broto", flag.ContinueOnError)
	dir := flags.String("state-dir", "", "Diretório privado do Broto")
	tor := flags.String("tor", "", "Executável Tor do pacote")
	stun := flags.String("stun", strings.Join(candidates.DefaultSTUNServers, ","), "Servidores STUN separados por vírgula, vazio desliga")
	updateURL := os.Getenv("CIALAI_BROTO_UPDATE_URL")
	if updateURL == "" {
		updateURL = "https://cialai.com.br/downloads/broto/latest.json"
	}
	updateSource := flags.String("update-url", updateURL, "Metadados assinados da atualização")
	updateKey := flags.String("update-key", os.Getenv("CIALAI_BROTO_UPDATE_PUBLIC_KEY"), "Chave pública Minisign confiável")
	releasesDir := flags.String("releases-dir", os.Getenv("CIALAI_BROTO_RELEASES_DIR"), "Diretório das versões verificadas")
	payload := flags.String("payload", "", "Payload assinado do serviço")
	installKey := flags.String("key", "", "Chave pública independente da instalação")
	installRoot := flags.String("install-root", "", "Pasta privada da instalação")
	currentPointer := flags.String("current-pointer", "", "Ponteiro privado da versão ativa")
	headless := flags.Bool("headless", false, "Iniciar no boot sem sessão gráfica, com consentimento administrativo")
	linger := flags.Bool("linger", false, "Permitir serviço Linux após logout")
	pidOnly := flags.Bool("pid-only", false, "Mostrar somente PID observado no status")
	prepareOnly := flags.Bool("prepare-only", false, "Preparar sem iniciar serviços")
	args := os.Args[1:]
	command := "serve"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		args = args[1:]
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if flags.NArg() > 0 {
		command = flags.Arg(0)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if command == "verificar" {
		_, err := brotoinstall.Verify(ctx, *payload, *installKey)
		return err
	}
	if command == "instalar" {
		result, err := brotoinstall.Install(ctx, brotoinstall.Config{Payload: *payload, PublicKey: *installKey, RootDir: *installRoot, URL: *updateSource, Activate: !*prepareOnly, Headless: *headless, Linger: *linger, StateDir: *dir})
		if err != nil {
			return err
		}
		raw, _ := json.Marshal(result)
		fmt.Println(string(raw))
		return nil
	}
	if command == "atualizar" {
		updateCtx, cancel := context.WithTimeout(ctx, 10*time.Minute)
		defer cancel()
		ctx = updateCtx
		executable, err := os.Executable()
		if err != nil {
			return err
		}
		current := filepath.Dir(executable)
		root := filepath.Dir(current)
		if filepath.Base(root) == "releases" {
			root = filepath.Dir(root)
		}
		if *releasesDir == "" {
			*releasesDir = filepath.Join(root, "releases")
		}
		if *currentPointer == "" {
			candidate := filepath.Join(root, "current-path")
			if _, err := os.Stat(candidate); err == nil {
				*currentPointer = candidate
			}
		}
		if *updateKey == "" {
			return fmt.Errorf("configure a chave pública independente do Broto")
		}
		unlock, err := brotoupdate.LockInstallation(filepath.Dir(*releasesDir))
		if err != nil {
			return err
		}
		defer unlock()

		result, err := brotoupdate.Stage(ctx, brotoupdate.Config{URL: *updateSource, PublicKey: *updateKey, CurrentDir: current, ReleasesDir: *releasesDir, Target: brotoupdate.HostTarget(), CurrentPointer: *currentPointer, StateDir: *dir})
		if err != nil {
			if errors.Is(err, brotoupdate.ErrNoUpdate) {
				fmt.Println(`{"updated":false}`)
				return nil
			}
			return err
		}
		if result.ActivationRequired {
			if err = brotoupdate.Activate(ctx, result); err != nil {
				return err
			}
		}
		result.ActivationRequired = false
		raw, _ := json.Marshal(result)
		fmt.Println(string(raw))
		return nil
	}
	if *tor == "" {
		if exe, err := os.Executable(); err == nil {
			for _, relative := range []string{filepath.Join("tor", "tor", "tor"), filepath.Join("tor", "tor")} {
				candidate := filepath.Join(filepath.Dir(exe), relative)
				if filepath.Ext(exe) == ".exe" {
					candidate += ".exe"
				}
				if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
					*tor = candidate
					break
				}
			}
		}
	}
	serve := func(ctx context.Context) error {
		servers := []string{}
		if *stun != "" {
			servers = strings.Split(*stun, ",")
		}
		client, err := brotoclient.New(ctx, brotoclient.Config{Dir: *dir, TorExecutable: *tor, STUNServers: servers})
		if err != nil {
			return err
		}
		defer client.Close()
		return client.ServeControl(ctx)
	}
	if command == "service" {
		if *installRoot != "" {
			return runService(ctx, func(ctx context.Context) error {
				return brotoupdate.Supervise(ctx, brotoupdate.SupervisorConfig{Root: *installRoot, StateDir: *dir, STUNServers: *stun})
			})
		}
		return runService(ctx, serve)
	}
	if command == "serve" {
		return serve(ctx)
	}
	method := ""
	var params any
	switch command {
	case "parear":
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 16384)
		if !scanner.Scan() {
			return fmt.Errorf("informe o código de pareamento pela entrada padrão")
		}
		method = "broto.connect"
		params = map[string]string{"pairing": scanner.Text()}
	case "status":
		method = "broto.status"
	case "pausar":
		method = "broto.pause"
	case "retomar":
		method = "broto.resume"
	case "encerrar-servico":
		method = "broto.shutdown"
	case "desconectar":
		method = "broto.disconnect"
	default:
		return fmt.Errorf("comando desconhecido")
	}
	result, err := brotoclient.ControlCall(ctx, *dir, method, params)
	if err == nil {
		if *pidOnly {
			if command != "status" {
				return fmt.Errorf("pid-only exige status")
			}
			var status struct {
				PID int `json:"pid"`
			}
			if json.Unmarshal(result, &status) != nil || status.PID < 1 {
				return fmt.Errorf("PID do serviço indisponível")
			}
			fmt.Println(status.PID)
		} else {
			fmt.Println(string(result))
		}
	}
	return err
}
