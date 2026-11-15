## Cialai {{version}} preview

Reopening Cialai brings each terminal back to the Claude Code or Codex conversation it was running, on macOS, Windows and Linux, even with several terminals in the same folder. On a Mac, Cialai now asks for the local network permission, so a Broto connected by QR finds the computer in seconds on the same network instead of waiting for Tor.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **Resume in the right terminal.** On a Mac opened from the Dock, resuming Claude was refused before the command was typed, because the CLI lived outside the path the app searched. Cialai now looks for `claude` and `codex` in the same path they ran with. Codex served by its shared background process, which did not say which conversation belonged to which terminal, now announces its id when Cialai quits, and each terminal keeps its own.
* **Resume on Windows too.** The resume command was never sent on Windows, because the app waited for a prompt signal that Windows does not have. The default Claude account resumes without switching its configuration folder, and automatic terminal replies no longer cancel the resume.
* **Broto by QR in seconds on the same network.** Since macOS 15, without the local network permission, the Cialai announcement never left the Mac and a Broto could only find the computer through Tor, which took minutes or never finished. The Mac now asks for the permission on first use, warns when it was denied and shows in the diagnostics where to allow it. Checked with a Broto on Windows 11 with the firewall on: it found the computer in two seconds.
* **Interrupt label.** The interrupt button of the phone terminal bar is now named Interromper Ctrl+C.

On a Mac, accept the prompt to find devices on your local network when the new version opens. If it was denied before, turn on Cialai in System Settings, Privacy and Security, Local Network. The resume of Claude and Codex and the Broto pairing were checked on macOS with test command line tools and on a Windows 11 virtual machine; the CI ran the tests on the three systems.

Broto has its own version, 0.2.1, and release tag `broto-v0.2.1`. Its Windows and Linux installers are separate from the Cialai host installers below. Visit https://cialai.com.br/broto for downloads. Connecting a Broto by QR needs Cialai 0.6.0 on the computer and on the phone and Broto 0.2.0.

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

The phone apps are unchanged in this preview. `Cialai_android_universal.apk` on the website stays at 0.7.0, and the iPhone app stays on build 21, on TestFlight and in App Store review.

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
