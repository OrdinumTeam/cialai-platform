## Cialai {{version}} preview

This is an early preview of Cialai for macOS, Windows, Linux and Android. It is meant for people who want to try the terminal studio and report problems. Expect rough edges.

**The macOS app is signed with the Ordinum Developer ID and notarized by Apple.** It opens like any other app downloaded from the internet. **The Windows installers are not signed with a code signing certificate yet**, so Windows will warn you before the first launch. In app updates are verified with the Cialai updater key on every system.

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
