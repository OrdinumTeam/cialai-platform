## Cialai {{version}} preview

An early preview of Cialai for macOS, Windows, Linux, Android and iOS. Expect rough edges.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **Opening the studio is seven times lighter.** The sidebar, the splash and the first run imported the 4096 px brand master to draw the mark at 20, 52 and 64 px, which was 87% of everything fetched before the first paint. The first paint went from 4601 KB to 615 KB, and nothing changed on screen.
* **A `cialai` command in the terminal.** It is written on first launch and checked on every launch, so it repairs itself when the application moves. On macOS and Linux it lives in `~/.local/bin` and the app never edits a shell file.
* **Dialogs carry their own size.** The width and the height ceiling moved out of styles injected at runtime, and the sections inside a dialog now measure the sheet instead of the window.
* **Collapsing a side column is one button again,** the one in the work area header, which also brings the column back.
* **The application icon has room to breathe,** framed by the solid mass of the head instead of the box its thin tips stretch.
* **The phone Home invites you to the community,** with the Discord and WhatsApp rooms the website publishes.

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
| Android 8 or newer | `Cialai_android_universal.apk` |

On iPhone the preview goes through TestFlight, so there is no file to download.

### Install

**macOS.** Open the DMG, drag Cialai to Applications, then open it and click Open on the first launch.

**Windows.** Run the setup or the MSI. On the SmartScreen warning click More info, then Run anyway.

**Linux.** `sudo apt install ./Cialai_amd64.deb`, `sudo dnf install ./Cialai_x86_64.rpm`, or make the AppImage executable with `chmod +x` and run it. The app updates itself in all three formats.

**Android.** Download the APK on the phone, allow installing unknown apps when Android asks, then open it.

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
