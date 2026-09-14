# Cialai

Cialai is an open source terminal studio for desktop and mobile. It keeps shells, files, Git context, previews and coding agent sessions together, then lets you reach the same terminal history from a paired phone through infrastructure you control.

> Cialai is preparing its first public release. Source code and local automated checks are available today. Signed installers, native mobile builds and store listings have not been published yet.

## A terminal workspace that travels with you

![Cialai desktop in dark mode](./docs/evidence/task-1.11/cialai-desktop-dark.png)

The desktop studio runs the real shell inside your project folder. Session cards show activity, resource use and agent state. The workspace combines the terminal with project files, previews and a controlled Chromium browser.

| Phone sessions | Phone files |
| --- | --- |
| ![Cialai phone session list](./docs/evidence/task-1.11/cialai-mobile-list.png) | ![Cialai phone file browser](./docs/evidence/task-1.11/cialai-mobile-files.png) |

These captures use fictional projects and the reproducible demo mode. The complete visual evidence set is in [docs/evidence/task-1.11](./docs/evidence/task-1.11/README.md).

## Highlights

- Run and organize terminal sessions from macOS, Linux and Windows.
- Keep terminal history available after the desktop app closes.
- Resume supported Claude Code and Codex sessions in the same project folder.
- Browse and edit project files, inspect Git changes and open local previews.
- Use the built in Dev Browser for web development workflows.
- Pair iOS and Android devices with a short lived QR code.
- Coordinate private device connectivity with your own Headscale server.
- Keep project contents and credentials out of Cialai hosted services because there are none.

## Project status

| Area | Status |
| --- | --- |
| Desktop studio | Implemented and verified locally on macOS |
| Headscale integration | Implemented with local Docker integration coverage |
| iOS and Android | Source prepared and JavaScript tests passing, native builds and real device checks pending |
| Linux and Windows | Rust suite verified on Ubuntu 22.04, Windows cross checked only, native CI evidence pending |
| Signed releases and stores | Pending certificates, accounts, external review and publication |

Prepared code is not the same as verified distribution. See the [execution handoff](./docs/13-progresso-e-handoff.md) for exact evidence and remaining external work.

## Run the desktop app from source

You need Node 22, npm 10, Go 1.26.5, the Rust toolchain declared by the repository and the native prerequisites for Tauri 2 on your system.

```sh
npm ci
npm run dev:desktop
```

The development command builds the local `cialai-tunnel` sidecar before starting Tauri. No private Headscale instance or project data is bundled with the repository.

Run the automated suites with:

```sh
npm test
```

Detailed setup, test and contribution guidance is in [CONTRIBUTING.md](./CONTRIBUTING.md).

## Platform setup

All platforms use Git, Node 22, npm 10, Rust 1.98.1 and Go 1.26.5. Build the local `cialai-tunnel` sidecar before calling Cargo directly; `npm run dev:desktop` already does it. Rust builds in this repository are limited to two jobs.

```sh
npm ci
npm run sidecar --workspace @cialai/desktop
npm test
```

### macOS

Requires macOS 13 or newer and the Xcode command line tools. Local bundles use `app` and `dmg`. Developer ID signing and notarization are not part of the local flow.

```sh
xcode-select --install
CARGO_BUILD_JOBS=2 npm run dev:desktop
```

### Linux

The reference build is Ubuntu 22.04 with WebKitGTK 4.1. Install the Tauri dependencies first. Planned packages are `deb`, `rpm` and `AppImage`.

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev libssl-dev zsh
CARGO_BUILD_JOBS=2 npm run dev:desktop
```

### Windows

Requires Windows 10 21H2 or newer, the WebView2 Runtime and Visual Studio Build Tools with Desktop development with C++. PowerShell 7 is preferred; Windows PowerShell and `cmd.exe` remain supported fallbacks. Planned packages are `nsis` and `msi`.

```powershell
npm ci
$env:CARGO_BUILD_JOBS = "2"
npm run dev:desktop
```

Windows runs the native Rust suite, the Go core tests, Jest and an unsigned bundle on GitHub Actions. A physical Windows machine, WebView2 with a GPU, installing the packages and code signing have not been exercised. Behavior differences between systems are documented in [docs/14-diferencas-por-plataforma.md](./docs/14-diferencas-por-plataforma.md).

## Connect your own Headscale server

The desktop setup assistant accepts a Headscale server you operate. A reproducible deployment recipe, security defaults and diagnostics live in [infra/headscale](./infra/headscale/README.md).

After the desktop joins your network, choose **Link phone**, scan the short lived QR code in the mobile app and confirm the pairing code when approval is enabled. Real device validation remains required before the first mobile release.

## Repository map

```text
apps/desktop          Tauri desktop application
apps/mobile           Expo application and native tunnel modules
packages/ui           Shared React terminal studio
packages/protocol     Desktop and phone bridge protocol
packages/tunnel-core  Go networking core and desktop sidecar
infra/headscale       Self hosted coordination recipe
tools                 Checks, builds, browser tests and release helpers
docs                  Architecture, decisions, evidence and handoff
```

Start with the [documentation index](./docs/README.md) for the architecture and decisions.

## Privacy and security

Cialai does not provide an account, analytics service or hosted relay. Project contents stay on devices you control and terminal traffic uses end to end encrypted links between paired devices. Operating a Headscale server still carries administrative responsibility. Read [SECURITY.md](./SECURITY.md) before reporting a vulnerability. Legal documents for the first release live in `docs/legal`.

## License

Licensed under Apache License 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
