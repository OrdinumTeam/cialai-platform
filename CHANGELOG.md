# Changelog

All notable changes to Cialai will be documented in this file.

The format follows Keep a Changelog, and the project intends to use Semantic Versioning after its first public release.

## Unreleased

### Added

* A cross platform Tauri desktop application for project workspaces, terminal sessions, files, previews, Git tools and local integrations
* A Go tunnel sidecar that pairs desktops and mobile devices and connects them directly or through an embedded Tor onion service, with no server to host
* Expo shells for iOS and Android with QR pairing, protected local profiles and biometric session locking
* Signed update support prepared for desktop releases
* Automated checks for the desktop, shared interface, tunnel protocol, mobile shell and release documentation

### Security

* Pairing credentials remain outside the browser interface and are stored by platform protected storage
* The mobile proxy accepts loopback traffic only and uses a short lived opening secret
* Release publication is blocked until the updater public key and signing secrets are configured

### Release status

Version 1.0.0 has not been published. Signed installers, native mobile archives, physical device testing, store review and the external release gates remain pending.

## 0.2.0 preview

Preview dated 2026-09-15 for macOS, Windows, Linux and Android. It replaces the Headscale setup with automatic connectivity.

### Changed

* The phone reaches the computer with no server run by you, by Ordinum or by the project. When Cialai opens, the computer brings its connectivity up by itself: Ed25519 identity keys, a direct QUIC connection on UDP port 4740 or a free port with mutual TLS 1.3 and the desktop key pinned in the QR code, port mapping through UPnP, NAT-PMP or PCP when the router allows, optional STUN through public Cloudflare and Google servers, a DNS-SD `_cialai._udp` announcement on the local network and an embedded single hop Tor onion service as meeting point and backup
* The phone tries the local network, then the direct path over the internet, then the backup through Tor. From the backup it keeps trying to move to a direct path with a NAT punch coordinated over the control channel. The Devices screen and the phone show Direct and Backup badges
* The desktop bundles the Tor Expert Bundle 15.0.22 with tor 0.4.9.12; Android uses tor-android and iOS uses Tor.framework
* The Headscale setup assistant gave way to the Phone access panel on the Devices screen, with advanced diagnostics that list the public networks in use

### Pairing

* `CIALAI2.` pairing codes always carry the onion address and up to six direct candidates in under 700 bytes. The QR code rotates every 90 seconds and expires after 600 seconds
* A phone that is not paired yet only reaches the pairing request. Approval by code on the computer stays optional
* Each phone gets its own `cdt1` token, rotated every 30 days. Revoking a phone closes its sessions on both paths and the bridge closes its sockets with code 4401

### Upgrade notes

* Pairings from 0.1.x previews do not carry over. Pair each phone again after updating
* A Headscale API key saved by an earlier version is no longer used and can be deleted in the advanced diagnostics of the Devices screen
* The Headscale mode stays in the repository as inert code until device validation, and `infra/headscale` is kept only as history

### Public networks used

* The Tor network, optional STUN servers from Cloudflare and Google, and DNS-SD on the local network

### Known limits

* The computer must be on with Cialai open
* Networks that block both Tor and UDP leave the phone without a path
* The backup through Tor is slower than a direct connection
* Validation covers automated suites and in process tests against the real Tor network. The physical checklist on real phones and networks is still pending

## 0.1.1 preview

Released on 2026-09-14 for macOS, Windows and Linux. The Android APK in this release is the same 0.1.0 build.

### Fixed

* On Windows the window grows past the splash size, new terminals no longer stay blank while the console waits for a cursor position reply, terminal memory is measured before Windows 11 and the phone can read project files through the Win32 backend
* The mobile site served by the desktop uses fixed content types instead of the types in the Windows registry
* Side columns that a narrow window collapsed open again from their button, shortcut and command palette entry

## 0.1.0 preview

Released on 2026-09-14 as the first public preview for macOS, Windows, Linux and Android, without Apple or Microsoft code signing.
