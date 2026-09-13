# Contributing to Cialai

Thank you for helping build Cialai. The project is preparing its first public release, so every contribution must distinguish implemented code, local verification and external validation.

Resumo em português: use as versões fixadas, trabalhe em uma branch curta, rode os testes relevantes, atualize o handoff e nunca inclua segredos ou conteúdo de projetos.

## Before you start

Read the [execution handoff](docs/13-progresso-e-handoff.md) first. The [roadmap](docs/11-roadmap-de-execucao.md) records task dependencies and acceptance criteria. Existing local changes belong to their author and must be preserved.

Use these toolchains:

- Node 22 and npm 10
- Rust from `rust-toolchain.toml`
- Go 1.26.5
- Docker for Headscale integration tests
- Xcode and the Android SDK only for native mobile work

Install dependencies with the locked versions:

```sh
npm ci
```

## Development

Start the desktop application with:

```sh
npm run dev:desktop
```

Start the Expo development server with:

```sh
npm run dev:mobile
```

Expo Go is not supported because the mobile app includes a native Go tunnel module. A development client and the platform toolchain are required.

If you run Cargo directly, build the local sidecar first and limit parallel Rust jobs on machines with constrained memory:

```sh
npm run sidecar --workspace @cialai/desktop
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -j 2
```

## Tests

Run the complete local suite with:

```sh
npm test
```

Useful focused commands:

| Area | Command |
| --- | --- |
| Shared interface | `npm run test:ui` |
| Desktop Rust | `npm run test:desktop` |
| Bridge protocol | `npm run test:protocol` |
| Go networking core | `npm run test:tunnel` |
| Mobile JavaScript | `npm run test:mobile` |
| Headscale integration | `npm run test:integration:headscale` |
| macOS application self test | `npm run test:selftest` |

Hardware tests, remote CI, code signing, notarization and store review require evidence from the real environment. A local unit test cannot mark those steps complete.

## Changes and commits

- Create a short branch from the current `main`.
- Keep each commit focused on one roadmap task.
- Use a conventional area prefix such as `feat(desktop):`, `fix(mobile):`, `docs(release):` or `test(network):`.
- Keep code, identifiers and code comments in English.
- Add `SPDX-License-Identifier: Apache-2.0` to new source files.
- Update `docs/13-progresso-e-handoff.md` after each delivery, relevant test or blocker.
- Preserve the sibling Ordinum Control repository as a read only source.

Visible interface copy must not use parentheses or dash characters as separators. Use labels, subtitles, rows or separate sentences. Syntax and normal spelling remain unchanged.

## Pull requests

Explain the observed problem, the resulting behavior and the exact validation performed. Mark tests that still need hardware or an external service. Include sanitized screenshots for visible changes.

Before requesting review, confirm that:

- Relevant automated checks pass.
- Generated outputs and credentials are absent.
- QR payloads, tokens, user state and private project contents are absent.
- Documentation describes what exists now.
- External checks are still marked pending unless their evidence is attached.

## Security

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md) and remove secrets or private project data from all evidence.
