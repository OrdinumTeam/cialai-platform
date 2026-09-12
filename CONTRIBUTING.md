# Contributing to Cialai

Cialai is in phase 0. The desktop and mobile products have not been extracted yet.
Start with [the execution handoff](docs/13-progresso-e-handoff.md) and [the roadmap](docs/11-roadmap-de-execucao.md).

## Setup

Use Node 22, npm 10, the Rust toolchain in `rust-toolchain.toml`, and Go 1.26.5.
Go can automatically download the required toolchain when `GOTOOLCHAIN=auto`.

```sh
npm ci
npm test
```

The current checks validate the workspace and ignore rules, format and compile the
empty Rust crate, and vet and compile the Go foundation. UI, protocol and mobile
product suites will be added during extraction. A passing foundation is not product parity.

The Headscale experiment requires a running Docker daemon:

```sh
npm run test:spike:headscale
```

Its containers and node state are temporary. No developer Headscale instance is used.
See [spike instructions](tools/spikes/README.md) for limits and pending hardware checks.

## Changes

Use short branches and area prefixes such as `feat(desktop):` or `docs:`. Include
the observed problem, resulting behavior and relevant validation in each pull request.
Update the handoff with completed tasks and outstanding work. New code uses the
`SPDX-License-Identifier: Apache-2.0` header. Keep identifiers and code comments in English.

Never commit credentials, QR payloads, private project data or generated mobile projects.
The sibling Ordinum Control working tree is a read-only extraction source.

Resumo em português: siga o roadmap, registre o progresso e os testes, preserve a
origem e nunca confunda a fundação com um produto pronto.
