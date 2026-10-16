## Cialai {{version}} preview

A desktop stability preview of Cialai for macOS, Windows and Linux. This delivery does not publish new Android or iOS apps; the existing Android 0.2.12 APK remains on the website mirror.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **Tunnel recovery after reboot.** A process-lifetime operating system lock replaces PID existence as proof of ownership. Stale metadata is recovered without deleting pairing keys or devices.
* **Recovery without restarting the app.** Generation-aware RPCs, bounded writes and retry cooldowns avoid duplicate sidecars and permanent reconnecting states. A responsive shutdown no longer waits for its own mutex.
* **The correct saved conversation.** Codex and Claude Code resumes validate the exact session identifier, profile, working directory, CLI and supported arguments. Concurrent resumes are deduplicated and coordinated; `--last` is never substituted for a known identifier.
* **Recoverable agent startup errors.** Bounded observation handles late transient failures. Manual retry preserves history and the identifier. Shared daemons are not restarted, and `--no-daemon` is not imposed globally. Windows compatibility probes collect their own descendants on timeout.
* **One text paste per action.** Native paste and asynchronous clipboard reads share one owner. Text wins over image in mixed clipboard formats; Unicode, multiline and bracketed paste are preserved. Ctrl+C without selection still interrupts.
* **Less redundant work and retained resources.** Metrics consumers share a short process sample; disposing WebGL pauses its cursor timer before releasing the terminal.

The original production Codex `draining` cause is not claimed to be proven. Native CI passed on macOS, Linux and Windows, and AppImage smoke passed on Ubuntu and Arch. Physical clipboard and WebView acceptance remains separate from automated tests. Technical evidence and measured limits: https://github.com/OrdinumTeam/cialai-platform/blob/main/docs/engenharia/auditoria-estabilidade-2026-10.md

Earlier versions are listed at https://github.com/OrdinumTeam/cialai-platform/tree/main/docs/releases

### Which file to download

| Platform | File |
| --- | --- |
| macOS on Apple silicon | `Cialai_aarch64.dmg` |
| macOS on Intel | `Cialai_x64.dmg` |
| Windows 10 and 11 | `Cialai_x64-setup.exe` or `Cialai_x64.msi` |
| Debian, Ubuntu and derivatives | `Cialai_amd64.deb` |
| Fedora, openSUSE and derivatives | `Cialai_x86_64.rpm` |
| Other Linux distributions | `Cialai_amd64.AppImage` |

The existing Android APK and store links remain available at https://cialai.com.br/downloads/. This release does not replace mobile apps.

### Install

**macOS.** Open the DMG, drag Cialai to Applications, then open it and click Open on the first launch.

**Windows.** Run the setup or the MSI. On the SmartScreen warning click More info, then Run anyway.

**Linux.** `sudo apt install ./Cialai_amd64.deb`, `sudo dnf install ./Cialai_x86_64.rpm`, or make the AppImage executable with `chmod +x` and run it. The app updates itself in all three formats.

**macOS and Linux in one line.** `curl -fsSL https://cialai.com.br/install.sh | bash`

### Verify your download

`SHA256SUMS` lists the checksum of every file here.

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Use `sha256sum` instead of `shasum -a 256` on Linux.

### Public networks and limits

Cialai runs no server of its own, and neither does Ordinum. The connection uses the Tor network as meeting point and backup, optional STUN servers from Cloudflare and Google, and DNS-SD on your local network.

The computer must be on with Cialai open. A network that blocks both Tor and UDP leaves the phone without a path, and the backup through Tor is slower than a direct connection.

### Report a problem

Open an issue at https://github.com/OrdinumTeam/cialai-platform/issues with your system, the file you installed and what happened.
