//go:build windows

// SPDX-License-Identifier: Apache-2.0

package brotoexec

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

const execLauncherFlag = "--cialai-internal-exec-utf8-v1"
const ptyLauncherFlag = "--cialai-internal-pty-utf8-v1"

type launchRequest struct {
	Version int
	Path    string
	Args    []string
	Report  uint64
}
type launchReport struct {
	Started bool
	Failure *Error
}

// These private entry points run in a child of an already-authorized executor.
// They keep its token and job membership. Neither mode elevates, impersonates,
// alters a user profile, nor changes the console of the Broto/service process.
func init() {
	if len(os.Args) < 2 {
		return
	}
	switch os.Args[1] {
	case execLauncherFlag:
		if len(os.Args) != 2 {
			os.Exit(125)
		}
		os.Exit(execLauncher())
	case ptyLauncherFlag:
		if len(os.Args) != 3 {
			os.Exit(125)
		}
		os.Exit(ptyLauncher(os.Args[2]))
	}
}
func configureUTF8Console() error {
	if err := windows.SetConsoleCP(65001); err != nil {
		return err
	}
	return windows.SetConsoleOutputCP(65001)
}
func runCommand(ctx context.Context, cmd *exec.Cmd) error {
	if cmd.Err != nil {
		return cmd.Err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	reportRead, reportWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer reportRead.Close()
	defer reportWrite.Close()
	if err = windows.SetHandleInformation(windows.Handle(reportWrite.Fd()), windows.HANDLE_FLAG_INHERIT, windows.HANDLE_FLAG_INHERIT); err != nil {
		return err
	}
	request, _ := json.Marshal(launchRequest{Version: 1, Path: cmd.Path, Args: cmd.Args, Report: uint64(reportWrite.Fd())})
	helper := exec.CommandContext(ctx, exe, execLauncherFlag)
	helper.Dir = cmd.Dir
	helper.Env = cmd.Env
	helper.Stdin = bytes.NewReader(request)
	helper.Stdout = cmd.Stdout
	helper.Stderr = cmd.Stderr
	helper.WaitDelay = cmd.WaitDelay
	prepareCommand(helper)
	helper.SysProcAttr.CreationFlags = windows.CREATE_NEW_CONSOLE
	helper.SysProcAttr.HideWindow = true
	helper.SysProcAttr.AdditionalInheritedHandles = []syscall.Handle{syscall.Handle(reportWrite.Fd())}
	runErr := helper.Run()
	_ = reportWrite.Close()
	var report launchReport
	if json.NewDecoder(io.LimitReader(reportRead, 4096)).Decode(&report) != nil {
		if runErr != nil {
			return runErr
		}
		return failure("execution_launcher_failed", "O processo auxiliar de execução não respondeu.")
	}
	if report.Failure != nil {
		return report.Failure
	}
	if !report.Started {
		return failure("execution_launcher_failed", "O processo auxiliar não iniciou o programa.")
	}
	return runErr
}
func execLauncher() int {
	var request launchRequest
	if json.NewDecoder(io.LimitReader(os.Stdin, 2<<20)).Decode(&request) != nil || request.Version != 1 || request.Path == "" || len(request.Args) == 0 || request.Report == 0 {
		return 125
	}
	handle := windows.Handle(request.Report)
	kind, err := windows.GetFileType(handle)
	if err != nil || kind != windows.FILE_TYPE_PIPE {
		return 125
	}
	_ = windows.SetHandleInformation(handle, windows.HANDLE_FLAG_INHERIT, 0)
	report := os.NewFile(uintptr(handle), "exec-status")
	if report == nil {
		return 125
	}
	defer report.Close()
	sendFailure := func(err error) int {
		var safe *Error
		if !errors.As(startFailure(err), &safe) {
			safe = &Error{Code: "execution_launcher_failed", Message: "O processo auxiliar não iniciou o programa."}
		}
		_ = json.NewEncoder(report).Encode(launchReport{Failure: safe})
		return 125
	}
	if err = configureUTF8Console(); err != nil {
		return sendFailure(failure("execution_encoding_unavailable", "O console UTF-8 não pôde ser preparado."))
	}
	child := exec.Command(request.Path, request.Args[1:]...)
	child.Args = request.Args
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err = child.Start(); err != nil {
		return sendFailure(err)
	}
	_ = json.NewEncoder(report).Encode(launchReport{Started: true})
	_ = report.Close()
	return processExitCode(child.Wait())
}
func ptyLauncher(shell string) int {
	if err := configureUTF8Console(); err != nil {
		return 125
	}
	// Consume Ctrl C only in the waiting launcher. The shell gets its own
	// default handlers, so cancelling a command does not kill the PTY wrapper.
	callback := windows.NewCallback(func(event uint32) uintptr {
		if event == windows.CTRL_C_EVENT || event == windows.CTRL_BREAK_EVENT {
			return 1
		}
		return 0
	})
	setHandler := windows.NewLazySystemDLL("kernel32.dll").NewProc("SetConsoleCtrlHandler")
	if ok, _, _ := setHandler.Call(callback, 1); ok == 0 {
		return 125
	}
	// The caller can have inherited "ignore Ctrl C" from exec's new process
	// group. That attribute is inherited by its children, unlike handler
	// functions. Clear it before starting the shell so Ctrl C works there too.
	if ok, _, _ := setHandler.Call(0, 0); ok == 0 {
		return 125
	}
	child := exec.Command(shell)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	return processExitCode(child.Run())
}
func processExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exited *exec.ExitError
	if errors.As(err, &exited) {
		return exited.ExitCode()
	}
	return 125
}
