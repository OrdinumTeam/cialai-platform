// SPDX-License-Identifier: Apache-2.0
package brotoinstall

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
)

type planOptions struct {
	Headless, Linger      bool
	User, Group, StateDir string
}

func headlessMac(root, home, user, group string, state ...string) ([]File, []Command, error) {
	if user == "" || group == "" || user == "root" || strings.ContainsAny(user+group, "\r\n\x00<>&\"'") {
		return nil, nil, errors.New("unprivileged account required for headless service")
	}
	stateDir := filepath.Dir(root)
	if len(state) > 0 && state[0] != "" {
		stateDir = state[0]
	}
	pointer := filepath.Join(root, "current-path")
	active := filepath.Join(root, "active-path")
	runner := filepath.Join(root, "run-service.sh")
	script := strings.NewReplacer("@POINTER@", shell(pointer), "@ACTIVE@", shell(active), "@NEXT@", shell(active+".next"), "@STATE@", shell(stateDir)).Replace(`#!/bin/sh
set -eu
child=''
trap 'if [ -n "$child" ]; then kill -TERM "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi; exit 0' TERM INT
while :; do
 IFS= read -r binary < @POINTER@
 rm -f @ACTIVE@
 "$binary" serve --state-dir @STATE@ & child=$!
 ready=0
 while kill -0 "$child" 2>/dev/null; do
  if [ "$ready" = 0 ]; then
   reported_pid=$("$binary" status --state-dir @STATE@ --pid-only 2>/dev/null || true)
   if [ "$reported_pid" = "$child" ]; then
    printf '%s\n%s\n' "$binary" "$child" > @NEXT@
    mv @NEXT@ @ACTIVE@
    ready=1
   fi
  fi
  sleep 2
  IFS= read -r next < @POINTER@
  if [ "$next" != "$binary" ]; then kill -TERM "$child" 2>/dev/null || true; break; fi
 done
 wait "$child" 2>/dev/null || true
 child=''
 sleep 1
done
`)
	prefix := "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict>"
	identity := "<key>UserName</key><string>" + xml(user) + "</string><key>GroupName</key><string>" + xml(group) + "</string><key>EnvironmentVariables</key><dict><key>HOME</key><string>" + xml(home) + "</string><key>USER</key><string>" + xml(user) + "</string><key>LOGNAME</key><string>" + xml(user) + "</string></dict><key>Umask</key><integer>63</integer>"
	daemon := prefix + identity + "<key>Label</key><string>br.com.ordinum.cialai.broto</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>" + xml(runner) + "</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>\n"
	updater := prefix + identity + "<key>Label</key><string>br.com.ordinum.cialai.broto.update</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>" + xml(filepath.Join(root, "run-update.sh")) + "</string></array><key>RunAtLoad</key><true/><key>StartInterval</key><integer>21600</integer></dict></plist>\n"
	files := []File{{runner, script}, {filepath.Join(root, "headless-mode"), "1\n"}, {filepath.Join(root, "headless-daemon.plist"), daemon}, {filepath.Join(root, "headless-update.plist"), updater}}
	var admin strings.Builder
	admin.WriteString("set -eu; umask 022; ")
	for _, v := range []struct{ name, contents string }{{"br.com.ordinum.cialai.broto.plist", daemon}, {"br.com.ordinum.cialai.broto.update.plist", updater}} {
		target := filepath.Join("/Library/LaunchDaemons", v.name)
		hash := fmt.Sprintf("%x", sha256.Sum256([]byte(v.contents)))
		encoded := base64.StdEncoding.EncodeToString([]byte(v.contents))
		admin.WriteString("if [ -e " + shell(target) + " ]; then test \"$(/usr/bin/shasum -a 256 " + shell(target) + " | /usr/bin/awk '{print $1}')\" = " + shell(hash) + "; else (set -C; printf %s " + shell(encoded) + " | /usr/bin/base64 -D > " + shell(target) + "); fi; /usr/sbin/chown root:wheel " + shell(target) + "; /bin/chmod 0644 " + shell(target) + "; ")
		label := strings.TrimSuffix(v.name, ".plist")
		admin.WriteString("/bin/launchctl print system/" + label + " >/dev/null 2>&1 || /bin/launchctl bootstrap system " + shell(target) + "; ")
	}
	quoted, _ := json.Marshal(admin.String())
	return files, []Command{{"/usr/bin/osascript", []string{"-e", "do shell script " + string(quoted) + " with administrator privileges"}}}, nil
}
