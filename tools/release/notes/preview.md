## Cialai {{version}} preview

On Android the phone now stays connected to the computer while the app is in the background, so session alerts keep arriving until you close the app or tap Disconnect. Every alert shows the session icon in white on the session color, and the phone terminal bar has a fixed order with each name shown on hold. The phone apps are updated too.

**macOS is signed with the Ordinum Developer ID and notarized by Apple.** **The Windows installers are not signed with a code signing certificate yet**, so SmartScreen warns you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

* **Alerts with the app in the background, on Android.** With a computer open, the app keeps the direct connection through a system service with a pinned notification that names the computer and offers Disconnect. The core used to stop two minutes after the app left the screen. Removing the app from recents also ends the connection.
* **Session icon on alerts.** Attention and session ended alerts show the session icon, the same as its card, in white on the session color. On Android it is the large icon, with the terminal as the small icon and the session color. On iPhone it comes as the alert thumbnail, because iOS keeps the app icon.
* **Fixed terminal bar.** Chat, Esc, Paste, Special keyboard, Quick commands, Interrupt and Enter. Chat has a neutral background, Interrupt is red and Enter takes the session color. Holding a button shows its name without running it; with a mouse the name shows on hover.
* **A tap opens the session.** Tapping an alert drawn by Android opens its session, also when the tap launches the app.

The background connection and the alerts drawn by Android were not proven on a real phone before release; the bar, the long press and the drawing of the session icon were checked in Chromium and WebKit. The background connection and the Android alerts need the phone app at 0.7.0, and the new bar and the session icon arrive with the computer at 0.7.0, because the terminal page comes from it.

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

The Android and iPhone apps are updated in this preview. `Cialai_android_universal.apk` is attached here and mirrored on the website, and the iPhone build is on TestFlight and in App Store review.

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
