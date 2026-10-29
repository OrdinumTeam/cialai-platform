package brotoclient

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/Cialai/cialai/packages/tunnel-core/internal/tor"
	"github.com/cretz/bine/process"
	binetor "github.com/cretz/bine/tor"
)

type torCreator struct{ executable string }
type torProcess struct {
	cmd  *exec.Cmd
	done chan struct{}
	err  error
}

func (c torCreator) New(ctx context.Context, args ...string) (process.Process, error) {
	cmd := exec.CommandContext(ctx, c.executable, args...)
	cmd.Dir = filepath.Dir(c.executable)
	cmd.WaitDelay = time.Second
	prepareTor(cmd)
	if runtime.GOOS == "linux" {
		libraryPath := filepath.Dir(c.executable)
		if inherited := os.Getenv("LD_LIBRARY_PATH"); inherited != "" {
			libraryPath += ":" + inherited
		}
		cmd.Env = append(os.Environ(), "LD_LIBRARY_PATH="+libraryPath)
	}
	return &torProcess{cmd: cmd, done: make(chan struct{})}, nil
}
func (p *torProcess) Start() error {
	if err := p.cmd.Start(); err != nil {
		p.err = err
		close(p.done)
		return err
	}
	go func() { p.err = p.cmd.Wait(); close(p.done) }()
	return nil
}
func (p *torProcess) Wait() error { <-p.done; return p.err }
func (p *torProcess) EmbeddedControlConn() (net.Conn, error) {
	return nil, process.ErrControlConnUnsupported
}
func startTor(ctx context.Context, executable, dir string, client *tor.Client) (func() error, error) {
	if !filepath.IsAbs(executable) {
		var err error
		executable, err = exec.LookPath(executable)
		if err != nil {
			return nil, err
		}
		executable, err = filepath.Abs(executable)
		if err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chmod(dir, 0700); err != nil {
		return nil, err
	}
	runctx, cancel := context.WithCancel(ctx)
	launch := func() (*binetor.Tor, error) { return launchTor(runctx, executable, dir, client) }
	instance, err := launch()
	if err != nil {
		cancel()
		return nil, err
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			process := instance.Process.(*torProcess)
			select {
			case <-runctx.Done():
				_ = instance.Close()
				return
			case <-process.done:
				_ = instance.Close()
			}
			delay := time.Second
			for {
				select {
				case <-runctx.Done():
					return
				case <-time.After(delay):
				}
				next, err := launch()
				if err == nil {
					instance = next
					break
				}
				if delay < 30*time.Second {
					delay *= 2
					if delay > 30*time.Second {
						delay = 30 * time.Second
					}
				}
			}
		}
	}()
	return func() error { cancel(); <-done; return nil }, nil
}
func launchTor(ctx context.Context, executable, dir string, client *tor.Client) (*binetor.Tor, error) {
	instance, err := binetor.Start(ctx, &binetor.StartConf{ProcessCreator: torCreator{executable}, DataDir: dir, EnableNetwork: true, ExtraArgs: []string{"--ClientOnly", "1", "--AvoidDiskWrites", "1", "--__OwningControllerProcess", strconv.Itoa(os.Getpid())}})
	if err != nil {
		return nil, err
	}
	info, err := instance.Control.GetInfo("net/listeners/socks")
	if err != nil {
		_ = instance.Close()
		return nil, err
	}
	if len(info) == 0 {
		_ = instance.Close()
		return nil, errors.New("Tor did not open a SOCKS listener")
	}
	socks := strings.Trim(info[0].Val, "\"")
	err = client.SetTorEndpoints(tor.Endpoints{SOCKS: socks, Control: "127.0.0.1:" + strconv.Itoa(instance.ControlPort), CookiePath: filepath.Join(dir, "control_auth_cookie")})
	if err != nil {
		_ = instance.Close()
		return nil, err
	}
	return instance, nil
}
