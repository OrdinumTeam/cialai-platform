//go:build windows

package brotoclient

import (
	"context"
	"github.com/tailscale/go-winio"
	"golang.org/x/sys/windows"
	"net"
	"os"
	"os/exec"
	"os/user"
	"strings"
	"syscall"
)

func platformAddress(dir string) string {
	u, err := user.Current()
	name := os.Getenv("USERNAME")
	if name == "" && err == nil {
		name = u.Username
		if index := strings.LastIndexAny(name, `\\/`); index >= 0 {
			name = name[index+1:]
		}
	}
	if name == "" {
		name = "user"
	}
	name = strings.NewReplacer("\\", "_", "/", "_", " ", "_").Replace(name)
	return `\\.\pipe\cialai-broto-` + name
}
func listenControl(address string) (net.Listener, error) {
	token := windows.GetCurrentProcessToken()
	owner, err := token.GetTokenUser()
	if err != nil {
		return nil, err
	}
	return winio.ListenPipe(address, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + owner.User.Sid.String() + ")", MessageMode: false, InputBufferSize: 16384, OutputBufferSize: 16384})
}
func dialControl(ctx context.Context, address string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, address)
}
func prepareTor(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
