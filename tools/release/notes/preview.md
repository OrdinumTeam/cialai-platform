## Cialai {{version}} preview

This is an early preview of Cialai for macOS, Windows, Linux and Android. It is meant for people who want to try the terminal studio and report problems. Expect rough edges.

**The installers are not signed with an Apple Developer ID or a Windows code signing certificate yet.** Your system will warn you before the first launch. The macOS app carries an ad hoc signature so it can run on Apple silicon, and in app updates are still verified with the Cialai updater key.

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
2. Open Cialai. macOS says it cannot verify the developer. Click Done.
3. Open System Settings, choose Privacy & Security and scroll to Security.
4. Next to the message about Cialai, click Open Anyway and confirm with your password or Touch ID.

If macOS says the app is damaged, run `xattr -dr com.apple.quarantine /Applications/Cialai.app` in Terminal and open it again.

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
