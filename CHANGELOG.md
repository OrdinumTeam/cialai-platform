# Changelog

All notable changes to Cialai will be documented in this file.

The format follows Keep a Changelog, and the project intends to use Semantic Versioning after its first public release.

## Unreleased

### Added

* A cross platform Tauri desktop application for project workspaces, terminal sessions, files, previews, Git tools and local integrations
* A Go tunnel sidecar for pairing desktops and mobile devices through a user managed Headscale server
* Expo shells for iOS and Android with QR pairing, protected local profiles and biometric session locking
* Signed update support prepared for desktop releases
* Automated checks for the desktop, shared interface, tunnel protocol, mobile shell and release documentation

### Security

* Pairing credentials remain outside the browser interface and are stored by platform protected storage
* The mobile proxy accepts loopback traffic only and uses a short lived opening secret
* Release publication is blocked until the updater public key and signing secrets are configured

### Release status

Version 1.0.0 has not been published. Signed installers, native mobile archives, physical device testing, store review and the external release gates remain pending.

## 0.1.1 preview

Released on 2026-09-14 for macOS, Windows and Linux. The Android APK in this release is the same 0.1.0 build.

### Fixed

* On Windows the window grows past the splash size, new terminals no longer stay blank while the console waits for a cursor position reply, terminal memory is measured before Windows 11 and the phone can read project files through the Win32 backend
* The mobile site served by the desktop uses fixed content types instead of the types in the Windows registry
* Side columns that a narrow window collapsed open again from their button, shortcut and command palette entry
* Terminals use the DOM renderer when WebGL runs in software, as on machines without a GPU

## 0.1.0 preview

Released on 2026-09-14 as the first public preview for macOS, Windows, Linux and Android, without Apple or Microsoft code signing.
