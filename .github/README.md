<p align="center">
  <img src="assets/cialai-lockup.webp" alt="Cialai" width="340">
</p>

<h3 align="center">An open source terminal studio for your computer and your phone</h3>

<p align="center">
  Every session is a shell in a folder, shown as a card that reports only what was observed.<br>
  A paired phone follows and controls those sessions over an end-to-end encrypted connection<br>
  that comes up on its own, with no server to host.
</p>

<p align="center">
  <img alt="License Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-E23B84">
  <img alt="Status pre-release" src="https://img.shields.io/badge/status-pre--release-3A1B33">
  <img alt="Desktop macOS, Linux and Windows" src="https://img.shields.io/badge/desktop-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows-FF7AB2">
  <img alt="Mobile iOS and Android" src="https://img.shields.io/badge/mobile-iOS%20%C2%B7%20Android-FF7AB2">
</p>

<p align="center">
  <a href="https://cialai.com.br">Website</a> ·
  <a href="#download">Download</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#pairing-and-network">Pairing</a> ·
  <a href="#build-from-source">Build</a> ·
  <a href="#how-connectivity-is-built-and-validated">Method</a> ·
  <a href="#public-networks-and-limits">Networks and limits</a> ·
  <a href="../docs/README.md">Docs</a> ·
  <a href="../SECURITY.md">Security</a>
</p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/desktop-dark.webp">
  <img alt="Cialai desktop studio with the session list, the workspace and the project tree with Git status" src="assets/desktop-light.webp">
</picture>

> [!WARNING]
> Cialai is experimental and has no supported production release yet. Preview installers are available on [cialai.com.br](https://cialai.com.br/#baixar); store apps are not published. See [Status](#status) for what is verified today and what is only prepared.

## Why Cialai

Cialai is built for people who keep several projects and several coding agents running at the same time. It started as the terminal studio inside Ordinum Control, an internal Ordinum tool, and is being extracted into a standalone product with the same behavior.

| Principle | What it means in practice |
| --- | --- |
| Observed, never inferred | Card state comes from the foreground process group, bytes received, exit codes and signals the program emits. The studio never claims an agent is thinking |
| The computer leads, the phone follows | A phone on a bad radio link is detached from the stream. It never blocks a shell on the computer |
| Only paired keys get in | Beyond loopback, the computer accepts only mutual TLS 1.3 sessions. A key that is not paired reaches nothing but the pairing request |
| One interface | The phone loads the same UI bundle the desktop ships. There is no second UI to maintain |
| What was recorded comes back | Raw history, terminal size, agent conversation, name, color, order and tabs survive closing or crashing the app |

## What it does

**On the computer**

* Sessions as cards with foreground command, running time, attention markers for bell, long job finished and shell exit, and CPU and memory summed across the whole process tree.
* Switching cards never interrupts anything. Process, scrollback, typed input and open tabs stay where they were.
* Claude Code and Codex are recognized from the command line, with plan usage, model and profile on the card, and conversations resume after the app restarts.
* Editor, project tree with Git markers, document previews and a Dev Browser per session, a Chromium instance the session's agents can drive through CDP.

**On the phone**

* The same cards and the same studio UI, served by your computer.
* Live output, typing and closing sessions, with a key row for Esc, Tab, Shift Tab, Ctrl C, arrows, Enter, Ctrl D, Ctrl L and Paste.
* Read-only project files, capped at 200 entries per folder and 128 KiB of UTF-8 text per preview, with hidden files, credential names, keys and symlinks blocked.
* Biometric checks when the app opens, after five minutes in background and before sensitive actions such as spawning or killing a shell.
* A **Direct** or **Backup** badge that shows which path carries the connection.

<table>
  <tr>
    <td align="center" width="33%"><img src="assets/mobile-list.webp" alt="Phone session list with five cards in different states" width="240"><br><sub>Sessions</sub></td>
    <td align="center" width="33%"><img src="assets/mobile-terminal.webp" alt="Phone terminal view with the extra key row" width="240"><br><sub>Terminal and key row</sub></td>
    <td align="center" width="33%"><img src="assets/mobile-files.webp" alt="Phone read-only file tree for a session" width="240"><br><sub>Read-only files</sub></td>
  </tr>
</table>

<sub>Screenshots come from the UI demo fixture. Outside the native shell xterm does not paint, so terminal panes appear empty in these captures.</sub>

## Download

Preview builds for every platform are on [cialai.com.br](https://cialai.com.br/#baixar). File names carry no version, so each link always points to the latest preview.

| Platform | File | Notes |
| --- | --- | --- |
| macOS on Apple silicon | [`Cialai_aarch64.dmg`](https://cialai.com.br/downloads/Cialai_aarch64.dmg) | Signed with the Ordinum Developer ID; the app and the disk image are notarized by Apple |
| macOS on Intel | [`Cialai_x64.dmg`](https://cialai.com.br/downloads/Cialai_x64.dmg) | Same signature and notarization |
| Windows 10 and 11 | [`Cialai_x64-setup.exe`](https://cialai.com.br/downloads/Cialai_x64-setup.exe) or [`Cialai_x64.msi`](https://cialai.com.br/downloads/Cialai_x64.msi) | Not code signed yet; SmartScreen asks for confirmation on the first launch |
| Debian, Ubuntu and derivatives | [`Cialai_amd64.deb`](https://cialai.com.br/downloads/Cialai_amd64.deb) | Recommended on these systems: uses the WebKitGTK of the system. `sudo apt install ./Cialai_amd64.deb` |
| Fedora, openSUSE and derivatives | [`Cialai_x86_64.rpm`](https://cialai.com.br/downloads/Cialai_x86_64.rpm) | Recommended on these systems. `sudo dnf install ./Cialai_x86_64.rpm` |
| Other Linux distributions | [`Cialai_amd64.AppImage`](https://cialai.com.br/downloads/Cialai_amd64.AppImage) | Portable build for x64 |
| Android 8 or newer | [`Cialai_android_universal.apk`](https://cialai.com.br/downloads/Cialai_android_universal.apk) | Signed APK for arm64 and x86_64 |
| iPhone | TestFlight | Internal testing group only for now |

Checksums are in [`SHA256SUMS.txt`](https://cialai.com.br/downloads/SHA256SUMS.txt). Desktop updates are signed with the Cialai updater key and verified by the app before installing, in every format above.

## Architecture

```mermaid
flowchart TB
  subgraph desktop["Desktop app, Tauri 2"]
    ui["React studio<br/>packages/ui"]
    core["Rust core<br/>PTY, processes, journal,<br/>files, Git, watcher"]
    bridge["Bridge WebSocket<br/>127.0.0.1:3720"]
    sidecar["cialai-tunnel sidecar<br/>Go, Ed25519 identity"]
    edge["Tunnel edge<br/>phone page, /pair, /pty"]
    direct["Direct listener<br/>QUIC on UDP 4740"]
    onion["Embedded tor<br/>single hop onion service"]
    ui <-->|Tauri IPC| core
    core --- bridge
    core <-->|stdio JSON lines| sidecar
    sidecar --- direct
    sidecar --- onion
    direct --> edge
    onion --> edge
    edge -->|proxy secret| bridge
  end

  subgraph public["Public networks"]
    tor["Tor network"]
    stun["STUN, optional<br/>Cloudflare and Google"]
  end

  router["Home router<br/>UPnP, NAT-PMP or PCP"]

  subgraph phone["Phone app, Expo"]
    webview["WebView<br/>same UI bundle"]
    proxy["Loopback proxy<br/>127.0.0.1:47400"]
    gocore["Go tunnel core<br/>gomobile, path manager"]
    torclient["Tor client<br/>tor-android or Tor.framework"]
    webview --> proxy
    proxy -->|device token| gocore
    gocore --- torclient
  end

  gocore <-->|Direct: QUIC, mutual TLS 1.3| direct
  torclient <-->|Backup: mutual TLS 1.3 inside Tor| tor
  tor <--> onion
  sidecar -.->|port mapping| router
  sidecar -.->|reflected address| stun
  sidecar -.->|DNS-SD _cialai._udp on the local network| gocore
```

No server run by you, by Ordinum or by the project takes part. The computer brings its connectivity up when the app opens. The direct path links the two devices; the backup crosses public Tor relays with the content still under mutual TLS 1.3, and the phone upgrades from the backup to a direct connection when the network allows.

### Components

| Path | Stack | Responsibility |
| --- | --- | --- |
| `apps/desktop` | Tauri 2.11, Rust, `portable-pty`, `tokio-tungstenite`, `sysinfo`, `notify`, `keyring`, Tor Expert Bundle 15.0.22 with tor 0.4.9.12 | Window, PTY, process metrics, journal and resume, files, Git, previews, Dev Browser, bridge, sidecar supervisor and the bundled `tor` resource that the sidecar starts |
| `packages/ui` | React 18, xterm.js 6, CodeMirror 6 | Studio, desktop shell and phone shell sharing one codebase |
| `packages/protocol` | JavaScript, JSON Schema, fixtures | Bridge and pairing contract shared by the Go, Rust and JavaScript tests |
| `packages/tunnel-core` | Go 1.26.5, `quic-go`, `bine`, `pion/mdns`, the Tailscale port mapper | Ed25519 identity, direct QUIC transport, Tor controller and onion listener, rendezvous and NAT punch, DNS-SD, tunnel edge, phone path manager and proxy, pairing, desktop sidecar and gomobile bindings. The former Headscale mode stays in the tree, inert, until device validation |
| `packages/i18n` | JavaScript | Shared translation keys |
| `apps/mobile` | Expo 57, React Native 0.86, Swift and Kotlin native module, tor-android on Android and Tor.framework on iOS | WebView shell, QR scanner, paired computers, connection badges, biometrics, loopback proxy through the Go core |
| `infra/headscale` | Docker Compose, Headscale 0.29.3 | Historical recipe from the 0.1.x previews, no longer part of the product path |
| `tools` | Node, Swift, Playwright | Checks, captures, self test, tunnel builds and release helpers |

### Processes and ports

| Process | Listens on | Accepts |
| --- | --- | --- |
| Rust bridge | `127.0.0.1:3720`, configurable with `CIALAI_BRIDGE_PORT`; when the default port is taken it opens on a free loopback port and hands that port to the sidecar | Only the tunnel edge presenting `X-Cialai-Proxy-Secret`; anything else gets 403 |
| Direct listener | UDP `4740` on every interface, or a free port when it is taken | QUIC sessions with mutual TLS 1.3. A key that is not paired gets a restricted session that only reaches `POST /pair` while a pairing code is active |
| Onion service | Single hop onion service of the embedded `tor`, with `SocksPort 0` on the desktop | The same mutual TLS sessions through the Tor network, plus the control channel for registered keys |
| Tunnel edge | No socket of its own; serves the streams of both transports | Paired phones; serves the phone page, `/api/health`, `/pair` and the `/pty` upgrade |
| Phone proxy | `127.0.0.1:47400`, fallback `47401` to `47409` | Only the app's own WebView, proven by a nonce cookie; injects the device Bearer token |
| Dev Browser | `127.0.0.1` on a random port per session | The desktop WebView over CDP; refused from the phone |
| DNS-SD | Multicast DNS on the local network | Announces `_cialai._udp` under a name derived from the key fingerprint, never the computer name |

### Terminal output path

The PTY reader hands batches of up to 64 KiB, coalesced over 4 ms, to a pump that fans them out to every subscriber of the session: the desktop WebView through a Tauri `Channel`, and each remote connection through the bridge. Each session keeps its last 256 KiB in a ring buffer with an absolute byte counter, and the same bytes are appended to the session journal on disk.

Backpressure is explicit. The desktop WebView acknowledges consumed bytes with `pty_ack`; above 512 KiB pending the pump stops and the shell blocks, like a terminal nobody reads. A remote subscriber that stays above its high water mark for 3 s receives `detached` with reason `lagged` and is dropped, while the desktop keeps going. The phone reattaches with `pty_attach` and gets a replay from its last offset.

## Pairing and network

```mermaid
sequenceDiagram
  autonumber
  participant P as Phone
  participant D as Desktop
  participant T as Tor network
  D->>D: on launch bring up the key, the direct listener,<br/>port mapping, DNS-SD and the onion service
  D->>D: show a CIALAI2 QR with the desktop key, the onion address,<br/>up to six candidates and a one-time secret, under 700 bytes<br/>rotates every 90 s, expires after 600 s
  P->>P: scan, validate the payload and pin the desktop key
  alt same network or reachable address
    P->>D: QUIC with mutual TLS 1.3 on a candidate
  else another network
    P->>T: mutual TLS 1.3 to the onion address
    T->>D: deliver through the onion service
  end
  Note over D: unknown phone key, restricted session<br/>only POST /pair is reachable
  P->>D: POST /pair with the secret and the phone details
  opt approval enabled
    D->>D: the person checks the code and authorizes
  end
  D-->>P: cdt1 device token and reach card
  P->>D: WebSocket upgrade on /pty, proxy injects the token
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/devices-dark.webp">
  <img alt="Devices screen with the phone access panel, the direct and backup connection states and paired phones with Direct and Backup badges" src="assets/devices-light.webp">
</picture>

<sub>Demo mode capture with fictional devices. No real pairing payload is shown.</sub>

| Topic | Design |
| --- | --- |
| Identity | One Ed25519 key per computer and per phone. The phone pins the desktop key from the QR and every session proves both keys over mutual TLS 1.3 |
| Direct path | QUIC over UDP, with candidates from the local network, global IPv6, a port mapped by UPnP, NAT-PMP or PCP and an optional STUN reflected address |
| Backup path | The same mutual TLS inside the Tor network, through a single hop onion service on the desktop. The onion address derives from a persisted key, so it is always in the QR |
| Path choice | Local network first, then direct over the internet, then the backup through Tor. On the backup the phone tries a NAT punch coordinated over the control channel and moves to direct when it succeeds |
| Pairing entry | A key that is not paired only reaches `POST /pair`, only while a pairing code is active |
| Approval | Optional. The desktop and the phone show the same four digit code, derived from the pairing id and the phone key, so a second phone that photographed the QR shows a different code |
| Rate limits | 5 pairing attempts per minute; a pairing code is locked after 10 wrong secrets |
| Tokens | One `cdt1` token per phone per desktop, rotated every 30 days with 24 h of overlap |
| Revocation | The Devices screen revokes a phone; its sessions close on both transports and the bridge closes its sockets with code 4401 |
| Restart | The sidecar restarts with the same identity and onion keys, so paired phones and their tokens stay valid |
| Upgrade from 0.1.x | Pairings made with the Headscale previews do not carry over. Pair the phone again |

### Bridge protocol

| Aspect | Contract |
| --- | --- |
| Transport | WebSocket; JSON text frames `hello`, `welcome`, `call`, `result`, `event`, `channel`; binary frames carry PTY output as a big endian `u32` channel id followed by bytes |
| Handshake | Loopback `Origin`, per-launch 256-bit proxy secret, device id, device key and transport headers, and `hello` within 5 s |
| Close codes | `4400` invalid hello, `4401` invalid or revoked credential, `4426` incompatible version |
| Limits | 1 MiB frames, 8 connections, 16 concurrent calls, 64 queued outbound frames, ping every 20 s |
| Remote commands | `pty_list`, `pty_metrics`, `ai_usage`, `pty_attach`, `pty_ack`, `pty_write`, `pty_spawn`, `pty_kill`, `pty_view_claim`, `pty_view_renew`, `pty_view_release`, `pty_files_list`, `pty_file_read`, `list_repo_dirs` |
| Refused remotely | `fs_*`, `git_*`, `browser_*` |
| Versioning | `version: 1` plus a `features` array such as `terminal-mobile-v1`, which grants the phone PTY width for 15 s, renewed every 5 s |

Full specifications: [bridge protocol](../docs/07-protocolo-da-ponte.md) and [network and pairing](../docs/06-rede-headscale-e-pareamento.md).

## How connectivity is built and validated

The automatic connectivity follows a written plan with nine phases. Every task has an objective, dependencies, a completion criterion and an evidence field, and a task is only checked when its evidence is recorded: commands, runs, measurements or the device used.

| Phase | Goal | State on 15 September 2026 |
| --- | --- | --- |
| 0 Analysis and decision | Study both code bases, compare Iroh, libp2p, WebRTC, HyperDHT, Headscale and Tor, and choose the architecture | Done |
| 1 Small real proof | Direct QUIC, embedded Tor and NAT punch spikes, gomobile compatibility | Spikes and bindings done; binding sizes fell by 55 percent; measurements on two computers and real phones pending |
| 2 Go transport core | Identity, direct QUIC, candidates, Tor controller, rendezvous, path manager, edge, pairing, proxy, sidecar and mobile API | Done, 13 of 13 tasks, including the NAT lab |
| 3 Desktop | Bundled Tor, cascade shutdown, automatic start, phone access panel, keep awake and self test | Built and tested; clean installs on the three systems and a 20 minute keep awake session pending |
| 4 Phone | Native Tor on iOS and Android, local discovery, v2 store, screens and lifecycle | Built; Android paired end to end on the emulator, iOS compiled for the simulator and shipped to TestFlight; real phones pending |
| 5 Security and continuity | Pairing protections, revocation on both paths, single execution across path changes and token rotation | Done except the optional onion client authorization |
| 6 Headscale removal | Delete the former mode and rewrite the living documentation | Waits for the real device phase |
| 7 Real devices | 15 scenarios on real phones, routers, mobile networks, CGNAT and a 24 hour soak | Checklist ready in [docs/testes/roteiro-conectividade.md](../docs/testes/roteiro-conectividade.md); runs pending |
| 8 Publication | Preview with the new connectivity and public documentation | Preview 0.2.0 published before the real device approvals; this page is part of it |

Three kinds of validation are kept apart, and no simulated test approves a physical scenario:

| Kind | Proves | Where |
| --- | --- | --- |
| Automated unit | Contracts, rejections, state machines and the protocol | `go test -race`, `cargo test`, Jest and Node tests |
| Automated simulated | Cone and symmetric NAT, blocked UDP, the Tor backup, revocation and restarts | `tools/net-lab` in Docker with eight scenarios, also in the `net-lab.yml` workflow |
| Physical | Real networks, carriers, routers, suspension, battery and store review | The connectivity checklist, filled on real devices |

The plan sets these targets for the physical runs. They are goals, not measurements yet:

| Metric | Target |
| --- | --- |
| Page ready on the same network | 2 s in 9 of 10 openings |
| Page ready over a direct internet path | 3 s in 9 of 10 openings |
| Page ready over the Tor backup, Tor already running | 6 s in 9 of 10 openings |
| Reconnection after switching from Wi-Fi to mobile data | 10 s in 10 of 10 |
| Key echo latency, median | 60 ms on the local network, 150 ms direct over the internet, 400 ms on the backup |
| Revocation | Sockets closed within 1 s, the phone shows removed within 5 s |
| Desktop at rest | Sidecar and `tor` under 150 MB of RSS together and under 1 percent CPU |
| Soak | 24 hours with no disconnection caused by the proxy |

## Security model

* The page never sees a credential. The phone proxy and the tunnel edge authenticate on both sides, and the bridge only accepts the edge.
* Every session, direct or through Tor, uses mutual TLS 1.3 with Ed25519 keys. The desktop accepts only registered keys, apart from the restricted pairing entry.
* Secrets never travel through argv or environment variables, and logs mask keys, device tokens, secrets and QR payloads.
* The onion service is single hop and does not hide where the computer is. It exists to be reachable from another network, not to provide anonymity.
* Out of scope: terminal output is visible on paired phones; Tor relays and the optional STUN servers can observe network metadata, never terminal content; a sleeping computer or a closed app is unreachable.

Please report vulnerabilities privately as described in [SECURITY.md](../SECURITY.md) and never test against devices or computers you do not own.

## Status

Snapshot of 15 September 2026. The live record with commands and results is [docs/13-progresso-e-handoff.md](../docs/13-progresso-e-handoff.md).

| Area | Verified | Pending |
| --- | --- | --- |
| Desktop on macOS | Rust core with 214 tests; self test with 11 scenarios in the app binary, including the automatic network and the QR read back from the screen; preview 0.2.0 signed and notarized | Human parity review against the prototype |
| Desktop on Linux | Rust suite on Ubuntu in a container and on GitHub Actions; process metrics checked against `/proc`; the AppImage fix for recent distributions validated on Ubuntu 24.04 and Arch with Mesa 26 | Visible WebKitGTK run on a physical machine |
| Desktop on Windows | GitHub Actions runs the native Rust suite, the Go core tests, Jest and an unsigned bundle on Windows 2022 | Physical machine, WebView2 with a GPU, IME and code signing |
| Automatic connectivity | Automated suites, in process tests against the real Tor network, the Docker NAT lab and an Android release build paired on the emulator with a real desktop sidecar over the direct path and the Tor backup | The connectivity checklist on real phones, computers and networks |
| iOS and Android | Native Tor and the v2 module on both; TestFlight build of 0.2.0 in internal testing; Android APK published | Real phones, the Play internal track and store review |
| CI and releases | CI green on Ubuntu, macOS and Windows; preview 0.2.0 published with installers, the Android APK, `SHA256SUMS` and a signed updater manifest; 0.2.1 with Linux and interface fixes in preparation | Windows code signing, store review and version 1.0.0 |

## Build from source

### Requirements

| Tool | Version |
| --- | --- |
| Node | 22, with npm 10 |
| Rust | 1.98.1, pinned in `rust-toolchain.toml` with clippy and rustfmt |
| Go | 1.26.5; with `GOTOOLCHAIN=auto` Go fetches it for you |
| Docker | Not needed for connectivity; only for the legacy Headscale integration test |

| System | Prerequisites |
| --- | --- |
| macOS | macOS 13 or newer and the Xcode command line tools |
| Linux | Ubuntu 22.04 is the reference, with WebKitGTK 4.1 and the Tauri system packages below |
| Windows | Windows 10 21H2 or newer, WebView2 Runtime and Visual Studio Build Tools with Desktop development with C++; PowerShell 7 preferred |

On Ubuntu:

```sh
sudo apt-get update
sudo apt-get install -y --no-install-recommends libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev libssl-dev zsh
```

### Run

```sh
npm ci
npm run sidecar --workspace @cialai/desktop
npm test
CARGO_BUILD_JOBS=2 npm run dev:desktop
```

On Windows PowerShell:

```powershell
npm ci
npm run sidecar --workspace @cialai/desktop
$env:CARGO_BUILD_JOBS = "2"
npm run dev:desktop
```

Rebuild the sidecar before calling Cargo directly or starting the app. The sidecar step also stages the pinned Tor Expert Bundle after checking its SHA-256; a target without a Tor bundle builds without the backup connection. Rust builds in this repository are capped at two jobs. Desktop packages are `dmg` and `app` on macOS, `deb`, `rpm` and `AppImage` on Linux, and `nsis` and `msi` on Windows; on Linux the release fixes the AppImage after bundling so it runs with the graphics stack of recent distributions. Platform specific behavior is documented in [docs/14-diferencas-por-plataforma.md](https://github.com/Cialai/cialai/blob/main/docs/14-diferencas-por-plataforma.md).

### Tests and checks

| Command | Runs |
| --- | --- |
| `npm test` | Every suite below plus workspace, CI matrix and platform docs guards |
| `npm run test:desktop` | UI build, `cargo fmt`, `clippy` with warnings as errors and `cargo test` |
| `npm run test:tunnel` | Historical Headscale recipe check, `go vet` and `go test` for the tunnel core; the tests against the public Tor network run only with `CIALAI_TOR_BIN`, as described in CONTRIBUTING |
| `npm run test:ui`, `test:protocol`, `test:i18n`, `test:mobile` | Package suites, with Jest on mobile |
| `npm run test:selftest` | 11 scenarios inside the macOS app binary, including the automatic network and the pairing QR |
| `npm run test:browser` | Headless Chromium checks of the desktop studio, the network screens and the phone terminal, including fast IME typing |
| `npm run test:netlab` | The Docker NAT lab: local network, cone to cone, symmetric NAT to the backup, blocked UDP, revocation, sidecar and Tor restarts and pairing protections |
| `npm run test:integration:headscale` | Legacy Headscale mode, manual only and no longer built by the v2 sidecar, kept until that mode is removed |
| `npm run build:tunnel` | Sidecars for 5 target triples with `SHA256SUMS` |

## Public networks and limits

Cialai runs no server of its own. The advanced diagnostics on the Devices screen list what the computer uses:

| Network | Why |
| --- | --- |
| Tor network | Meeting point and backup connection when the phone is on another network |
| STUN servers from Cloudflare and Google | Optional. Find the public address of the computer for the direct connection |
| DNS-SD on the local network | Lets a phone on the same network find the computer without waiting for Tor |

Limits of this preview:

* The computer must be on, awake and running Cialai.
* A network that blocks both Tor and UDP leaves the phone without a path.
* The backup through Tor is slower than a direct connection.
* Pairings from the 0.1.x previews do not migrate; pair the phone again.
* The physical checklist on real phones and networks is still pending.

## Repository layout

```text
apps/desktop          Tauri 2 and Rust
apps/mobile           Expo for iOS and Android, native tunnel module
packages/ui           React studio, desktop and phone shells
packages/protocol     Bridge and pairing contract
packages/tunnel-core  Go identity, QUIC and Tor transports, edge, proxy and pairing
packages/i18n         Shared translations
infra/headscale       Historical Headscale recipe, no longer used by the product
tools                 Checks, captures, self test and release helpers
docs                  Planning and living documentation
brand                 Cialai identity
```

## Documentation

Design documents are written in Portuguese. Code identifiers and comments are in English.

| Document | Covers |
| --- | --- |
| [01 Vision and scope](../docs/01-visao-e-escopo.md) | Product, audience, what is in and out |
| [03 Architecture](../docs/03-arquitetura.md) | Target design, components, ports, flows and rejected alternatives |
| [04 Desktop](../docs/04-desktop.md) | Rust core, per OS matrix, window, shortcuts and onboarding |
| [05 Mobile](../docs/05-mobile.md) | Expo shell, native tunnel module, QR scanner and stores |
| [06 Network and pairing](../docs/06-rede-headscale-e-pareamento.md) | Automatic connectivity, tunnel core, edge, proxy, pairing and threats; Headscale sections are historical |
| [07 Bridge protocol](../docs/07-protocolo-da-ponte.md) | WebSocket contract between the phone page and the desktop |
| [09 Monorepo and tooling](../docs/09-monorepo-e-ferramentas.md) | Layout, toolchains, scripts and conventions |
| [10 CI/CD and distribution](../docs/10-ci-cd-e-distribuicao.md) | GitHub Actions, Codemagic, signing and releases |
| [11 Roadmap](../docs/11-roadmap-de-execucao.md) | Phases, tasks and acceptance criteria |
| [12 Decisions](../docs/12-decisoes.md) | Decision log with context and consequences |

The full reading order is in [docs/README.md](../docs/README.md).

## Contributing

Issues, discussions and pull requests are welcome. Read [CONTRIBUTING.md](../CONTRIBUTING.md) and the [code of conduct](../CODE_OF_CONDUCT.md) first.

* Keep branches short and prefix commits with the area, such as `feat(desktop):` or `docs:`.
* Describe the observed problem, the resulting behavior and how you validated it.
* New files carry `SPDX-License-Identifier: Apache-2.0`.
* Never commit credentials, QR payloads, private data or generated mobile projects.

## License

Cialai is licensed under the [Apache License 2.0](../LICENSE); third party notices are in [NOTICE](../NOTICE). The Cialai name, the orchid mantis symbol and the visual identity are trademarks of Ordinum and are not covered by the license, so modified distributions should use their own name and identity.

<p align="center">
  <sub>Maintained by <a href="https://www.ordinum.com.br">Ordinum</a> in Uberlândia, Brazil</sub>
</p>
