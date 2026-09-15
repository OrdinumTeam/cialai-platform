## Cialai {{version}} preview

This is an early preview of Cialai for macOS, Windows, Linux and Android. It is meant for people who want to try the terminal studio and report problems. Expect rough edges.

**The macOS app is signed with the Ordinum Developer ID and notarized by Apple.** It opens like any other app downloaded from the internet. **The Windows installers are not signed with a code signing certificate yet**, so Windows will warn you before the first launch. In app updates are verified with the Cialai updater key on every system.

### What is new

Your phone now reaches your computer with no server to set up. When Cialai opens, the computer prepares a direct encrypted connection and an embedded Tor onion service as backup. The phone tries the local network first, then a direct connection over the internet, then the backup through Tor, and moves to a direct connection when the network allows. The Devices screen and the phone show a **Direct** or **Backup** badge for each connection.

### Pair your phone again

Phones paired with a 0.1.x preview are not carried over. After updating the desktop and the Android app:

1. Open Cialai on the computer and choose Pair phone.
2. Scan the QR code with the Cialai app on the phone. The code changes every 90 seconds and expires after 10 minutes.
3. If approval is enabled, check the code on the computer and click Authorize.

On the same network the phone connects right away. From another network it waits until the backup connection is ready.

### Public networks used

Cialai runs no server of its own, and neither does Ordinum. The connection uses only these public networks:

| Network | Purpose |
| --- | --- |
| Tor network | Meeting point and backup connection |
| STUN servers from Cloudflare and Google | Optional, finds the public address for the direct connection |
| DNS-SD on your local network | Lets the phone find the computer nearby |

### Known limits

* The computer must be on with Cialai open.
* Networks that block both Tor and UDP leave the phone without a connection.
* The backup through Tor is slower than a direct connection.
* This preview passed automated tests, including tests against the real Tor network. Checks on real phones and networks are still pending.

### Which file to download

| Platform | File |
| --- | --- |
| macOS on Apple silicon | `Cialai_aarch64.dmg` |
| macOS on Intel | `Cialai_x64.dmg` |
| Windows 10 and 11 | `Cialai_x64-setup.exe` or `Cialai_x64.msi` |
| Linux, any distribution | `Cialai_amd64.AppImage` |
| Debian and Ubuntu | `Cialai_amd64.deb` |
| Fedora and openSUSE | `Cialai_x86_64.rpm` |
| Android 8 or newer | `Cialai_android_universal.apk` |

iOS is coming soon through TestFlight.

### Open the app on macOS

1. Open the DMG and drag Cialai to Applications.
2. Open Cialai. On the first launch macOS reminds you that the app was downloaded from the internet. Click Open.

### Install on Windows

1. Run the setup or the MSI installer.
2. If Microsoft Defender SmartScreen shows Windows protected your PC, click More info.
3. Click Run anyway.

### Install on Linux

Make the AppImage executable with `chmod +x Cialai_amd64.AppImage` and run it, or install the DEB or RPM package with your package manager.

### Install on Android

1. Download the APK on the phone.
2. Allow your browser or file manager to install unknown apps when Android asks.
3. Open the APK and confirm the installation.

### Verify your download

`SHA256SUMS` lists the checksum of every file in this release.

```sh
shasum -a 256 -c SHA256SUMS --ignore-missing
```

Use `sha256sum` instead of `shasum -a 256` on Linux.

### Report a problem

Open an issue at https://github.com/Cialai/cialai/issues with your system, the file you installed and what happened.
