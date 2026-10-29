//go:build windows

// SPDX-License-Identifier: Apache-2.0
package brotohostipc

import (
	"context"
	"crypto/sha256"
	"fmt"
	winio "github.com/tailscale/go-winio"
	"golang.org/x/sys/windows"
	"net"
	"strings"
)

func platformPath(path string) string {
	return fmt.Sprintf(`\\.\pipe\cialai-broto-host-%x`, sha256.Sum256([]byte(strings.ToLower(path))))
}
func listen(path string) (net.Listener, error) {
	token, e := windows.OpenCurrentProcessToken()
	if e != nil {
		return nil, e
	}
	defer token.Close()
	user, e := token.GetTokenUser()
	if e != nil {
		return nil, e
	}
	return winio.ListenPipe(path, &winio.PipeConfig{SecurityDescriptor: "D:P(A;;GA;;;" + user.User.Sid.String() + ")", InputBufferSize: 65536, OutputBufferSize: 65536})
}
func dial(ctx context.Context, path string) (net.Conn, error) {
	return winio.DialPipeContext(ctx, path)
}
