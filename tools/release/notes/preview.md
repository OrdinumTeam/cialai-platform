## Cialai {{version}} preview

Cialai Broto arrives as a preview for Windows and Linux. Pair another computer with your Cialai host to run commands, open terminals and transfer files under local permissions. The phone apps are unchanged.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **Brotos in Devices.** Create a pairing code, approve the other computer and choose view-only, confirmation for AI commands or free access.
* **Remote terminals and AI activity.** Follow commands and live output in Cialai. Broto keeps its own Pause and Disconnect controls.
* **CLI, optional skill and MCP.** AI tools can use `cialai broto` and the same host permissions, with file transfers over the authenticated tunnel.
* **Windows reliability.** UTF-8 output, Ctrl C and a native host command that forwards arguments without batch interpretation.
* **Separate host instances.** Each app state selects its own IPC endpoint, with actionable configuration diagnostics.

Broto has its own version, 0.1.0, and release tag `broto-v0.1.0`. Its Windows and Linux installers are separate from the Cialai host installers below. Visit https://cialai.com.br/broto for downloads. There is no macOS Broto installer or supported Windows graphical-session launcher in this preview.

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

The Android and iPhone apps are unchanged in this preview. Get them from Google Play and the App Store; the previous Android APK remains on the website.

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
