//go:build windows

package brotoexec

import (
	"bytes"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
	"unicode/utf8"
)

func TestWindowsExecUTF8TextAndNativeChild(t *testing.T) {
	before, _ := windows.GetConsoleOutputCP()
	defer func() {
		after, _ := windows.GetConsoleOutputCP()
		if after != before {
			t.Errorf("executor changed caller console: %d to %d", before, after)
		}
	}()
	for _, script := range []string{`[Console]::Write('ação café 漢字 🙂'); [Console]::Error.Write('operação inválida 漢字 🙂')`, `Write-Output 'ação café 漢字 🙂'; Write-Error 'operação inválida 漢字 🙂'`, `cmd /d /c "echo ação café 漢字 🙂"`} {
		c := windowsConfig()
		var mu sync.Mutex
		streams := map[string]*bytes.Buffer{"stdout": {}, "stderr": {}}
		c.OnExecOutput = func(_ uint64, channel string, p []byte) { mu.Lock(); defer mu.Unlock(); streams[channel].Write(p) }
		e := New(c)
		out := call(t, e, "exec", Args{Command: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-Command", script}, Stream: true}).(map[string]any)
		e.Close()
		for _, channel := range []string{"stdout", "stderr"} {
			got := out[channel].(string)
			if !utf8.ValidString(got) {
				t.Errorf("%s invalid UTF8: %x", channel, []byte(got))
			}
			if strings.Contains(got, "\ufffd") {
				t.Errorf("%s replacement characters: %q", channel, got)
			}
			if streams[channel].String() != got {
				t.Errorf("%s stream differs from summary", channel)
			}
		}
		if strings.Contains(script, "ação") && !strings.Contains(out["stdout"].(string), "ação café 漢字 🙂") {
			t.Errorf("Unicode stdout was lost: %q", out["stdout"])
		}
		if strings.Contains(script, "operação") && !strings.Contains(out["stderr"].(string), "operação inválida 漢字 🙂") {
			t.Errorf("Unicode stderr was lost: %q", out["stderr"])
		}

	}
}
func TestWindowsExecPreservesPowerShellScriptSemantics(t *testing.T) {
	e := New(windowsConfig())
	defer e.Close()
	script := "using namespace System.Text\nparam([string]$value)\n[Console]::Write($value); exit 7"
	path := filepath.Join(t.TempDir(), "script with spaces.ps1")
	if err := os.WriteFile(path, append([]byte{0xef, 0xbb, 0xbf}, []byte(script)...), 0600); err != nil {
		t.Fatal(err)
	}
	out := call(t, e, "exec", Args{Command: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path, "ação & café 漢字 🙂"}}).(map[string]any)
	if out["stdout"] != "ação & café 漢字 🙂" || out["exit_code"] != 7 {
		t.Fatalf("script semantics changed: %v", out)
	}
}
func TestWindowsConPTYUTF8SurvivesByteReads(t *testing.T) {
	terminal, err := startTerminal("powershell.exe", "", 120, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer terminal.Close()
	defer terminal.Kill()
	data := make(chan byte, 4096)
	go func() {
		buf := make([]byte, 1)
		for {
			n, err := terminal.Read(buf)
			if n > 0 {
				data <- buf[0]
			}
			if err != nil {
				close(data)
				return
			}
		}
	}()
	// Generate output from codepoints so an echoed command cannot satisfy it.
	command := "$s=-join ([char[]]@(97,231,227,111,32,99,97,102,233,32,28450,23383)); [Console]::WriteLine('ENCODING_RESULT:'+$s)\r\n"
	if _, err = terminal.Write([]byte(command)); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	deadline := time.After(15 * time.Second)
	for {
		select {
		case b, ok := <-data:
			if !ok {
				t.Fatal("ConPTY ended without marker")
			}
			output.WriteByte(b)
			if strings.Contains(output.String(), "ENCODING_RESULT:ação café 漢字") {
				if !utf8.Valid(output.Bytes()) {
					t.Fatal("ConPTY output not UTF8")
				}
				return
			}
		case <-deadline:
			t.Fatalf("ConPTY UTF8 marker missing: %q", output.String())
		}
	}
}

func TestWindowsLauncherRejectsInvalidPayload(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{`{}`, `{"Version":2,"Path":"cmd.exe","Args":["cmd.exe"],"Report":0}`} {
		cmd := exec.Command(exe, execLauncherFlag)
		cmd.Stdin = strings.NewReader(payload)
		err := cmd.Run()
		if err == nil {
			t.Fatal("invalid helper payload accepted")
		}
		if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 125 {
			t.Fatal("unexpected helper result", err)
		}
	}
}
func TestWindowsUTF8ConsoleCodePage(t *testing.T) {
	e := New(windowsConfig())
	defer e.Close()
	out := call(t, e, "exec", Args{Command: "powershell.exe", Args: []string{"-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding.CodePage; cmd /d /c chcp"}}).(map[string]any)
	if strings.Count(out["stdout"].(string), "65001") != 2 {
		t.Fatal("console code page not inherited")
	}
}

func TestWindowsUTF8ConPTYCtrlCKeepsShell(t *testing.T) {
	e := New(windowsConfig())
	defer e.Close()
	opened := call(t, e, "pty.open", Args{Shell: "powershell.exe", Cols: 120, Rows: 24}).(map[string]any)
	id := opened["id"].(uint32)
	call(t, e, "pty.write", Args{ID: id, Data: []byte("[Console]::WriteLine('WAIT_'+'READY'); Start-Sleep -Seconds 30\r")})
	windowsReadUntil(t, e, id, "WAIT_READY")
	before := call(t, e, "pty.read", Args{ID: id}).(map[string]any)["total_offset"].(uint64)
	call(t, e, "pty.write", Args{ID: id, Data: []byte{3}})
	deadline := time.Now().Add(10 * time.Second)
	for {
		state := call(t, e, "pty.read", Args{ID: id, Offset: before}).(map[string]any)
		if state["exited"] == true {
			t.Fatalf("Ctrl C killed shell: %q", state["data"])
		}
		if strings.Contains(string(state["data"].([]byte)), "PS ") {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("shell did not return to prompt: %q", state["data"])
		}
		time.Sleep(10 * time.Millisecond)
	}
	call(t, e, "pty.write", Args{ID: id, Data: []byte("[Console]::WriteLine('ALIVE_'+'AFTER')\r")})
	windowsReadUntil(t, e, id, "ALIVE_AFTER")
}

func TestWindowsUTF8ConPTYFromNewProcessGroup(t *testing.T) {
	// CREATE_NEW_PROCESS_GROUP gives a console process an inherited ignore-Ctrl-C
	// attribute. Launching the test this way reproduces execution via exec/service
	// independently of the account and the caller's console configuration.
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(exe, "-test.v", "-test.run=^TestWindowsUTF8ConPTYCtrlCKeepsShell$", "-test.timeout=40s")
	child.SysProcAttr = &syscall.SysProcAttr{CreationFlags: windows.CREATE_NEW_PROCESS_GROUP}
	output, err := child.CombinedOutput()
	if err != nil {
		t.Fatalf("PTY inherited the caller's disabled Ctrl C: %v\n%s", err, output)
	}
}
