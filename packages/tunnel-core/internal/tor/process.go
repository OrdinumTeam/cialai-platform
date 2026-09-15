// SPDX-License-Identifier: Apache-2.0
package tor

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/cretz/bine/process"
)

// waitDelay bounds Wait after a kill when an inherited pipe stays open.
const waitDelay = 2 * time.Second

var ErrShutdownTimeout = errors.New("tor did not exit after SHUTDOWN and was killed")

// execCreator implements bine's process.Creator for the bundled binary. On
// Windows the child gets no console window.
type execCreator struct {
	path   string
	output io.Writer
	env    []string
}

func (creator execCreator) New(ctx context.Context, args ...string) (process.Process, error) {
	command := exec.CommandContext(ctx, creator.path, args...)
	command.Dir = filepath.Dir(creator.path)
	command.Stdout = creator.output
	command.Stderr = creator.output
	command.WaitDelay = waitDelay
	if len(creator.env) > 0 {
		command.Env = append(os.Environ(), creator.env...)
	}
	if runtime.GOOS == "linux" {
		environ := command.Env
		if environ == nil {
			environ = os.Environ()
		}
		command.Env = withLibraryDir(environ, command.Dir)
	}
	hideWindow(command)
	return &execProcess{command: command}, nil
}

// withLibraryDir puts dir first in LD_LIBRARY_PATH. The Linux Expert Bundle
// ships libevent, libssl and libcrypto next to a tor binary without RUNPATH,
// and the .deb and .rpm install it unchanged, so without this tor exits 127.
func withLibraryDir(environ []string, dir string) []string {
	const key = "LD_LIBRARY_PATH="
	value := dir
	result := make([]string, 0, len(environ)+1)
	for _, entry := range environ {
		if !strings.HasPrefix(entry, key) {
			result = append(result, entry)
			continue
		}
		if rest := strings.TrimPrefix(entry, key); rest != "" {
			value = dir + ":" + rest
		}
	}
	return append(result, key+value)
}

type execProcess struct {
	command *exec.Cmd
}

func (child *execProcess) Start() error { return child.command.Start() }
func (child *execProcess) Wait() error  { return child.command.Wait() }

func (*execProcess) EmbeddedControlConn() (net.Conn, error) {
	return nil, process.ErrControlConnUnsupported
}

func (child *execProcess) pid() int {
	if child.command.Process == nil {
		return 0
	}
	return child.command.Process.Pid
}

// launchSpec describes one Tor child. Every file lives under dir, which the
// caller keeps private.
type launchSpec struct {
	creator     process.Creator
	executable  string
	dir         string
	role        torRole
	ownerPID    int
	controlWait time.Duration
}

// instance is a running Tor child with an authenticated control connection
// that owns it: Tor exits when that connection closes (TAKEOWNERSHIP) or when
// the owner pid disappears (__OwningControllerProcess).
type instance struct {
	process process.Process
	pid     int
	kill    context.CancelFunc
	exited  chan struct{}
	control *controlConn
	cookie  string

	waitMu  sync.Mutex
	waitErr error
}

func launch(ctx context.Context, spec launchSpec) (*instance, error) {
	dataDir := filepath.Join(spec.dir, "data")
	portFile := filepath.Join(spec.dir, "control-port")
	torrcPath := filepath.Join(spec.dir, "torrc")
	defaultsPath := filepath.Join(spec.dir, "torrc-defaults")
	cookie := filepath.Join(dataDir, "control_auth_cookie")
	for _, dir := range []string{spec.dir, dataDir} {
		if err := privateDirectory(dir); err != nil {
			return nil, err
		}
	}
	if err := os.Remove(portFile); err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, fmt.Errorf("remove stale control port file: %w", err)
	}
	geoIP, geoIPv6 := bundleGeoIP(spec.executable)
	contents, err := renderTorrc(torrcOptions{
		role:            spec.role,
		dataDir:         dataDir,
		controlPortFile: portFile,
		cookieFile:      cookie,
		ownerPID:        spec.ownerPID,
		geoIP:           geoIP,
		geoIPv6:         geoIPv6,
	})
	if err != nil {
		return nil, err
	}
	if err := replaceFile(torrcPath, contents); err != nil {
		return nil, fmt.Errorf("write torrc: %w", err)
	}
	// An empty defaults file keeps a system torrc-defaults out of the child.
	if err := replaceFile(defaultsPath, nil); err != nil {
		return nil, fmt.Errorf("write torrc-defaults: %w", err)
	}

	processContext, kill := context.WithCancel(context.Background())
	child, err := spec.creator.New(processContext, "-f", torrcPath, "--defaults-torrc", defaultsPath)
	if err != nil {
		kill()
		return nil, fmt.Errorf("create tor process: %w", err)
	}
	if err := child.Start(); err != nil {
		kill()
		return nil, fmt.Errorf("start tor: %w", err)
	}
	running := &instance{process: child, kill: kill, exited: make(chan struct{}), cookie: cookie}
	if identified, ok := child.(interface{ pid() int }); ok {
		running.pid = identified.pid()
	}
	go func() {
		err := child.Wait()
		running.waitMu.Lock()
		running.waitErr = err
		running.waitMu.Unlock()
		close(running.exited)
	}()

	controlWait := spec.controlWait
	if controlWait <= 0 {
		controlWait = defaultControlWait
	}
	address, err := waitControlPort(ctx, portFile, running.exited, controlWait)
	if err == nil {
		running.control, err = dialControl(ctx, address)
	}
	if err == nil {
		err = running.control.authenticate(ctx, cookie)
	}
	if err == nil {
		_, err = running.control.do(ctx, "TAKEOWNERSHIP")
	}
	if err != nil {
		running.forceStop()
		return nil, fmt.Errorf("connect to tor: %w", errors.Join(err, running.exitError()))
	}
	return running, nil
}

func replaceFile(path string, data []byte) error {
	temporary, err := writePrivateTemporary(filepath.Dir(path), ".cialai-torrc-*", data)
	if err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

// waitControlPort polls the file written by ControlPortWriteToFile. The file
// is removed before launch, so any content belongs to this child.
func waitControlPort(ctx context.Context, path string, exited <-chan struct{}, limit time.Duration) (string, error) {
	timer := time.NewTimer(limit)
	defer timer.Stop()
	ticker := time.NewTicker(25 * time.Millisecond)
	defer ticker.Stop()
	for {
		if contents, err := os.ReadFile(path); err == nil {
			if address, ok := parseControlPortFile(string(contents)); ok {
				return address, nil
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-exited:
			return "", errors.New("tor exited before opening its control port")
		case <-timer.C:
			return "", fmt.Errorf("tor did not open its control port within %s", limit)
		case <-ticker.C:
		}
	}
}

func parseControlPortFile(contents string) (string, bool) {
	for line := range strings.Lines(contents) {
		address, ok := strings.CutPrefix(strings.TrimSpace(line), "PORT=")
		if !ok {
			continue
		}
		if network, _, err := splitEndpoint(address); err == nil && network == "tcp" {
			return address, true
		}
	}
	return "", false
}

func (running *instance) hasExited() bool {
	select {
	case <-running.exited:
		return true
	default:
		return false
	}
}

func (running *instance) exitError() error {
	if !running.hasExited() {
		return nil
	}
	running.waitMu.Lock()
	defer running.waitMu.Unlock()
	if running.waitErr == nil {
		return errors.New("tor exited")
	}
	return fmt.Errorf("tor exited: %w", running.waitErr)
}

// stop asks Tor to exit with SIGNAL SHUTDOWN and kills it when it is still
// running after grace. It always returns with the child reaped.
func (running *instance) stop(grace time.Duration) error {
	if running.hasExited() {
		running.closeControl()
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), grace)
	defer cancel()
	if running.control != nil {
		// A missing reply is fine: Tor may close the connection as it exits.
		_, _ = running.control.do(ctx, "SIGNAL SHUTDOWN")
	}
	select {
	case <-running.exited:
		running.closeControl()
		return nil
	case <-ctx.Done():
	}
	running.forceStop()
	return ErrShutdownTimeout
}

func (running *instance) forceStop() {
	running.kill()
	<-running.exited
	running.closeControl()
}

func (running *instance) closeControl() {
	if running.control != nil {
		_ = running.control.Close()
	}
}

// Compile-time proof that the creator fits bine's contract.
var _ process.Creator = execCreator{}
