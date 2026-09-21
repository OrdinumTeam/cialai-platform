## Cialai {{version}} preview

An early preview of Cialai for macOS, Windows, Linux, Android and iOS. Expect rough edges.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **A new application icon,** in the same drawing as the sibling Ordinum applications: the brand gradient filling the whole frame, from magenta orchid at the top to hot pink at the bottom, with the symbol in white on it. The file is a full square with no rounded corners drawn in it, because current macOS applies the system mask itself.
* **The same icon on iPhone and on Android.** On Android the adaptive foreground is the white symbol over the brand magenta, instead of the white background that made it disappear.
* **The brand mark was redrawn,** and it reaches every place that showed the previous one: the sidebar, the splash and the first run of the studio, the website favicons, the iPhone shortcut and the marks on the pages.
* **Dialogs position themselves.** In the installed 0.2.7 the pairing sheet could appear at the bottom corner of the window with no scrim and no centring. The fixed layer, the centring and the scrim now come from the application stylesheet, not from styles injected at runtime.
* **Release announcements are one block per highlight,** instead of a wall of text.

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
