//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package brotoexec

import (
	"context"
	"os"
	"os/exec"
	"sync"
	"syscall"

	"github.com/creack/pty"
	ps "github.com/mitchellh/go-ps"
)

func privileged() bool { return os.Geteuid() == 0 }
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return killTree(cmd.Process.Pid) }
}

type unixTerminal struct {
	fdMu sync.Mutex
	file *os.File
	cmd  *exec.Cmd
	once sync.Once
	code int
	err  error
}

func startTerminal(shell, dir string, cols, rows int) (terminal, error) {
	if shell == "" {
		shell = "/bin/sh"
	}
	cmd := exec.Command(shell)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		return nil, err
	}
	return &unixTerminal{file: f, cmd: cmd}, nil
}
func (t *unixTerminal) Read(p []byte) (int, error)  { return t.file.Read(p) }
func (t *unixTerminal) Write(p []byte) (int, error) { return t.file.Write(p) }
func (t *unixTerminal) Resize(cols, rows int) error {
	t.fdMu.Lock()
	defer t.fdMu.Unlock()
	return pty.Setsize(t.file, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
}
func (t *unixTerminal) Kill() error {
	err := killTree(t.cmd.Process.Pid)
	if err == syscall.ESRCH {
		return nil
	}
	return err
}

func killTree(pid int) error {
	// Shell job control can place children in a different process group.
	processes, _ := ps.Processes()
	var descendants func(int)
	descendants = func(parent int) {
		for _, p := range processes {
			if p.PPid() == parent {
				descendants(p.Pid())
				_ = syscall.Kill(p.Pid(), syscall.SIGKILL)
			}
		}
	}
	descendants(pid)
	err := syscall.Kill(-pid, syscall.SIGKILL)
	if err == syscall.ESRCH {
		return nil
	}
	return err
}
func (t *unixTerminal) Wait() (int, error) {
	t.once.Do(func() { t.err = t.cmd.Wait(); t.code = t.cmd.ProcessState.ExitCode() })
	return t.code, t.err
}
func (t *unixTerminal) Close() error { t.fdMu.Lock(); defer t.fdMu.Unlock(); return t.file.Close() }

func runCommand(_ context.Context, cmd *exec.Cmd) error { return cmd.Run() }
