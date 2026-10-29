// SPDX-License-Identifier: Apache-2.0
package brotoinstall

import (
	"errors"
	"net/url"
	"path/filepath"
	"strings"
)

func shell(v string) string { return "'" + strings.ReplaceAll(v, "'", "'\\''") + "'" }
func xml(v string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", "\"", "&quot;").Replace(v)
}
func unit(v string) string {
	return "\"" + strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%").Replace(v) + "\""
}
func plan(platform, root, binary, key, source, home, owner string, options ...planOptions) ([]File, []Command, error) {
	for _, value := range []string{root, binary, key, source, home, owner} {
		if strings.ContainsAny(value, "\r\n\x00") {
			return nil, nil, errors.New("invalid installation value")
		}
	}
	parsed, e := url.Parse(source)
	if e != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return nil, nil, errors.New("HTTPS update source required")
	}
	opts := planOptions{}
	if len(options) > 0 {
		opts = options[0]
	}
	if opts.StateDir == "" {
		opts.StateDir = filepath.Dir(root)
	}
	pointer := filepath.Join(root, "current-path")
	mode := platform
	if platform != "windows" {
		if opts.Headless {
			mode += "-headless"
		} else if opts.Linger {
			mode += "-linger"
		}
	}
	files := []File{{pointer, binary + "\n"}, {filepath.Join(root, "installation-mode"), mode + "\n"}}
	commands := []Command{}
	if platform == "windows" {
		files = append(files, File{filepath.Join(root, "supervised-mode"), "1\n"})
		script := filepath.Join(root, "run-update.ps1")
		psquote := func(v string) string { return "'" + strings.ReplaceAll(v, "'", "''") + "'" }
		files = append(files, File{script, "$ErrorActionPreference='Stop'\n$binary=(Get-Content -LiteralPath " + psquote(pointer) + " -Raw).Trim()\n& $binary atualizar --state-dir " + psquote(opts.StateDir) + " --update-key " + psquote(key) + " --update-url " + psquote(source) + " --releases-dir " + psquote(filepath.Join(root, "releases")) + " --current-pointer " + psquote(pointer) + "\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\n"}, File{filepath.Join(root, "install-service.ps1"), windowsInstaller})
		powershell, err := platformPowerShell()
		if err != nil {
			return nil, nil, err
		}
		commands = append(commands, Command{powershell, []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", filepath.Join(root, "install-service.ps1"), "-Root", root, "-Binary", binary, "-OwnerSid", owner, "-StateDir", opts.StateDir, "-OwnerHome", home}})
		return files, commands, nil
	}
	runner := filepath.Join(root, "run-update.sh")
	files = append(files, File{runner, "#!/bin/sh\nset -eu\nIFS= read -r binary < " + shell(pointer) + "\nexec \"$binary\" atualizar --state-dir " + shell(opts.StateDir) + " --update-key " + shell(key) + " --update-url " + shell(source) + " --releases-dir " + shell(filepath.Join(root, "releases")) + " --current-pointer " + shell(pointer) + "\n"})
	if platform == "darwin" && opts.Headless {
		extra, cmds, err := headlessMac(root, home, opts.User, opts.Group, opts.StateDir)
		return append(files, extra...), cmds, err
	}
	switch platform {
	case "darwin":
		dir := filepath.Join(home, "Library", "LaunchAgents")
		daemon := filepath.Join(dir, "br.com.ordinum.cialai.broto.plist")
		updater := filepath.Join(dir, "br.com.ordinum.cialai.broto.update.plist")
		prefix := "<?xml version=\"1.0\" encoding=\"UTF-8\"?><!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\"><plist version=\"1.0\"><dict>"
		files = append(files, File{daemon, prefix + "<key>EnvironmentVariables</key><dict><key>HOME</key><string>" + xml(home) + "</string></dict><key>Label</key><string>br.com.ordinum.cialai.broto</string><key>ProgramArguments</key><array><string>" + xml(binary) + "</string><string>serve</string><string>--state-dir</string><string>" + xml(opts.StateDir) + "</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>Umask</key><integer>63</integer></dict></plist>\n"}, File{updater, prefix + "<key>EnvironmentVariables</key><dict><key>HOME</key><string>" + xml(home) + "</string></dict><key>Label</key><string>br.com.ordinum.cialai.broto.update</string><key>ProgramArguments</key><array><string>/bin/sh</string><string>" + xml(runner) + "</string></array><key>StartInterval</key><integer>21600</integer><key>RunAtLoad</key><true/><key>Umask</key><integer>63</integer></dict></plist>\n"})
		commands = append(commands, Command{"launchctl", []string{"bootstrap", "gui/" + platformUID(), daemon}}, Command{"launchctl", []string{"bootstrap", "gui/" + platformUID(), updater}})
	case "linux":
		dir := filepath.Join(home, ".config", "systemd", "user")
		files = append(files, File{filepath.Join(dir, "cialai-broto.service"), "[Unit]\nDescription=Cialai Broto\nAfter=network-online.target\n[Service]\nExecStart=" + unit(binary) + " serve --state-dir " + unit(opts.StateDir) + "\nRestart=on-failure\nRestartSec=5\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n[Install]\nWantedBy=default.target\n"}, File{filepath.Join(dir, "cialai-broto-update.service"), "[Unit]\nDescription=Authenticated Broto update\n[Service]\nType=oneshot\nTimeoutStartSec=11min\nExecStart=/bin/sh " + unit(runner) + "\nUMask=0077\nNoNewPrivileges=true\n"}, File{filepath.Join(dir, "cialai-broto-update.timer"), "[Unit]\nDescription=Periodic Broto update\n[Timer]\nOnBootSec=5m\nOnUnitActiveSec=6h\nRandomizedDelaySec=10m\nPersistent=true\n[Install]\nWantedBy=timers.target\n"})
		if opts.Headless || opts.Linger {
			commands = append(commands, Command{"loginctl", []string{"enable-linger", platformUID()}})
		}
		commands = append(commands, Command{"systemctl", []string{"--user", "daemon-reload"}}, Command{"systemctl", []string{"--user", "enable", "--now", "cialai-broto.service", "cialai-broto-update.timer"}})
	default:
		return nil, nil, errors.New("unsupported installation platform")
	}
	return files, commands, nil
}
