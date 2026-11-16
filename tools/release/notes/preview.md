## Cialai {{version}} preview

Search, the app menu and the window buttons now share the same toolbar on macOS, Windows and Linux. On Linux, the graph no longer keeps refreshing on its own.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **Window buttons in the toolbar.** Close, minimize and the third button sit after search and the app menu, on every system. On a Mac they keep the red, yellow and green colors and the green one toggles full screen; on Windows and Linux the middle button maximizes and restores. On narrow windows search turns into an icon.
* **Linux window without the system title bar.** The toolbar draws the buttons and the window can be resized from its eight edges and corners. If the interface fails to load, the system frame comes back so the window can still be moved and closed.
* **Graph refresh on Linux.** Reading the folders to build the graph was reported as a change and started another scan, so the Refreshing notice blinked without end. Reads are now ignored, while creating, writing, renaming and removing files still refresh the graph.

The toolbar was checked in Chromium on the production build for the three systems, with the window bridge simulated; the native window behavior was not tested on each system before release. The graph fix was checked on Linux with 125 reads in 45 seconds and no false change.

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
