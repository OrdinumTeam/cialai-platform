//go:build windows

package brotoexec

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"unsafe"

	"github.com/UserExistsError/conpty"
	"golang.org/x/sys/windows"
)

// riskyServicePrivileges are granted to every SCM service. The Broto never
// impersonates a client, and a shell started for the host would otherwise
// inherit SeImpersonatePrivilege, a known path from a service account to SYSTEM.
var riskyServicePrivileges = []string{"SeImpersonatePrivilege", "SeCreateGlobalPrivilege"}

var dropPrivileges sync.Once

// privileged reports a process that must not take remote orders: one running
// as an administrator with its full token, as a built-in service account, or
// still holding a service privilege after trying to remove it. IsElevated is
// not the test, because Windows reports every service token as elevated, and
// the Broto service under a standard account could never run a command.
func privileged() bool {
	dropPrivileges.Do(dropServicePrivileges)
	return privilegedToken(windows.GetCurrentProcessToken())
}

// dropServicePrivileges removes the service privileges from this process, so
// every shell and command it starts inherits a token without them.
func dropServicePrivileges() {
	var token windows.Token
	if windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token) != nil {
		return
	}
	defer token.Close()
	for _, name := range riskyServicePrivileges {
		var luid windows.LUID
		if windows.LookupPrivilegeValue(nil, windows.StringToUTF16Ptr(name), &luid) != nil {
			continue
		}
		state := windows.Tokenprivileges{PrivilegeCount: 1, Privileges: [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: windows.SE_PRIVILEGE_REMOVED}}}
		_ = windows.AdjustTokenPrivileges(token, false, &state, 0, nil, nil)
	}
}

func holdsPrivilege(token windows.Token, name string) bool {
	var luid windows.LUID
	if windows.LookupPrivilegeValue(nil, windows.StringToUTF16Ptr(name), &luid) != nil {
		return true
	}
	var size uint32
	_ = windows.GetTokenInformation(token, windows.TokenPrivileges, nil, 0, &size)
	if size == 0 {
		return true
	}
	buffer := make([]byte, size)
	if windows.GetTokenInformation(token, windows.TokenPrivileges, &buffer[0], size, &size) != nil {
		return true
	}
	for _, privilege := range (*windows.Tokenprivileges)(unsafe.Pointer(&buffer[0])).AllPrivileges() {
		if privilege.Luid == luid {
			return true
		}
	}
	return false
}

func privilegedToken(token windows.Token) bool {
	for _, name := range riskyServicePrivileges {
		if holdsPrivilege(token, name) {
			return true
		}
	}
	user, err := token.GetTokenUser()
	if err != nil {
		return true
	}
	for _, kind := range []windows.WELL_KNOWN_SID_TYPE{windows.WinLocalSystemSid, windows.WinLocalServiceSid, windows.WinNetworkServiceSid} {
		if sid, err := windows.CreateWellKnownSid(kind); err != nil || user.User.Sid.Equals(sid) {
			return true
		}
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return true
	}
	groups, err := token.GetTokenGroups()
	if err != nil {
		return true
	}
	// A UAC-filtered administrator keeps the group only for deny checks.
	for _, group := range groups.AllGroups() {
		if group.Sid.Equals(admins) && group.Attributes&windows.SE_GROUP_ENABLED != 0 {
			return true
		}
	}
	return false
}
func prepareCommand(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	cmd.Cancel = func() error { return killWindowsTree(cmd.Process.Pid) }
}

type windowsTerminal struct {
	console   *conpty.ConPty
	done      chan struct{}
	code      uint32
	err       error
	closeOnce sync.Once
	dsr       int
}

func startTerminal(shell, dir string, cols, rows int) (terminal, error) {
	if shell == "" {
		shell = "cmd.exe"
	}
	shellPath, err := exec.LookPath(shell)
	if err != nil {
		return nil, err
	}
	shell = shellPath
	exe, err := os.Executable()
	if err != nil {
		return nil, err
	}
	c, err := conpty.Start(syscall.EscapeArg(exe)+" "+ptyLauncherFlag+" "+syscall.EscapeArg(shell), conpty.ConPtyWorkDir(dir), conpty.ConPtyDimensions(cols, rows))
	if err != nil {
		return nil, err
	}
	t := &windowsTerminal{console: c, done: make(chan struct{})}
	go func() { t.code, t.err = c.Wait(context.Background()); _ = t.Close(); close(t.done) }()
	return t, nil
}
func (t *windowsTerminal) Read(p []byte) (int, error) {
	n, err := t.console.Read(p)
	query := []byte("\x1b[6n")
	for _, b := range p[:n] {
		if b == query[t.dsr] {
			t.dsr++
			if t.dsr == len(query) {
				_, _ = t.console.Write([]byte("\x1b[1;1R"))
				t.dsr = 0
			}
		} else {
			t.dsr = 0
			if b == query[0] {
				t.dsr = 1
			}
		}
	}
	return n, err
}
func (t *windowsTerminal) Write(p []byte) (int, error) { return t.console.Write(p) }
func (t *windowsTerminal) Resize(cols, rows int) error { return t.console.Resize(cols, rows) }
func (t *windowsTerminal) Kill() error {
	return killWindowsTree(t.console.Pid())
}
func killWindowsTree(pid int) error {
	// taskkill /T includes child processes created by interactive shells.
	if err := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "taskkill.exe"), "/PID", strconv.Itoa(pid), "/T", "/F").Run(); err == nil {
		return nil
	}
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(h)
	return windows.TerminateProcess(h, 1)
}
func (t *windowsTerminal) Wait() (int, error) { <-t.done; return int(t.code), t.err }

// Close runs while the reader continues draining, avoiding the pre-24H2
// ClosePseudoConsole deadlock. The reader must remain active until EOF.
func (t *windowsTerminal) Close() error {
	var err error
	t.closeOnce.Do(func() { err = t.console.Close() })
	return err
}
