# Monorepo e ferramentas

## Estrutura

```
cialai-platform/
  README.md                          apresentação, estado, índice
  LICENSE                            Apache 2.0
  NOTICE                             licenças BSD e MIT das dependências centrais
  CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md
  package.json                       workspaces npm e scripts da raiz
  .gitignore
  .github/workflows/                 ci.yml, release.yml, headscale-integration.yml, nightly-e2e.yml
  codemagic.yaml                     ios-testflight, ios-archive, android-play
  docs/                              estes documentos, depois documentação viva
  apps/
    desktop/                         Tauri 2, ver 04-desktop.md
    mobile/                          Expo, ver 05-mobile.md
      modules/cialai-tunnel/         módulo nativo do túnel
  packages/
    ui/                              React: estúdio, casca desktop, casca do celular, tokens, fontes
    protocol/                        contrato da ponte e do pareamento, remote.js, native.js, sensitive.js, fixtures
    tunnel-core/                     Go: tsnet, borda, proxy, pareamento, Headscale, sidecar, gomobile
  infra/
    headscale/                       docker-compose.yml, config/, bootstrap.sh, README.md
  tools/
    check/                           check-*.mjs herdados de $CONTROL/frontend/scripts
    browser/                         run-browser-checks.mjs com Playwright e os check-*-browser.js
    selftest/                        selftest-app.js e fixtures
    mac/                             wksnap, winid, winbounds, drive, em Swift
    release/                         cm-*.sh, _stores.py, asc_api.py, play_api.py, check-app-icon.swift
    build-tunnel-mobile.sh           gera o xcframework e o aar
```

## Pacotes

| Pacote | Linguagem | Entrada | Consumidores |
| --- | --- | --- | --- |
| `packages/ui` | React, CSS | `src/desktop/main.jsx`, `src/mobile/main.jsx` | `apps/desktop` empacota as duas entradas pelo Vite; a segunda vira recurso servido pela borda |
| `packages/protocol` | JavaScript, JSON | `remote.js`, `native.js`, `sensitive.js`, `fixtures/*.json`, `schema/*.json` | `packages/ui`, testes Go e Rust leem as fixtures |
| `packages/tunnel-core` | Go | `cmd/cialai-tunnel`, `mobile/` | `apps/desktop` empacota o sidecar; `apps/mobile` consome o xcframework e o aar |
| `apps/desktop` | Rust, HTML | `src-tauri/src/main.rs`, `index.html`, `mobile.html` | Usuários finais |
| `apps/mobile` | TypeScript, Swift, Kotlin | `index.ts`, `App.tsx` | Usuários finais |

O pacote `packages/ui` é um workspace exportado como fonte, resolvido pelo Vite pelo link do workspace, sem etapa de build própria.

## Toolchains e versões

| Ferramenta | Versão | Uso |
| --- | --- | --- |
| Node | 22, fixado por `.nvmrc` e `engines` | Vite, testes Node, Expo, scripts |
| npm | 10, workspaces | Instalação e scripts |
| Vite | 7.3.6, `target: 'safari16'` | Duas entradas do desktop; atualizado após a auditoria da decisão 028 |
| Rust | 1.98.1 fixado em `rust-toolchain.toml`, `rust-version = "1.85"` no crate | Desktop; mínimo real será revisto na extração |
| Tauri CLI | 2.x | `tauri dev`, `tauri build`, `tauri icon` |
| Go | 1.26.5 | Núcleo do túnel; mínimo exigido pelo tsnet 1.102.0, decisão 022 |
| `golang.org/x/mobile` | fixado no `go.mod` | `gomobile bind` |
| Xcode | 16.1 ou mais novo | iOS e macOS |
| Android SDK e NDK | `compileSdk` e `targetSdk` 36, NDK fixado pelo Expo | Android |
| Expo | SDK 57, `expo-dev-client` | Celular |
| Playwright | fixado em `tools/browser` | Checks de navegador e Chromium do Dev Browser |
| Docker | qualquer recente | Headscale de integração |
| LibreOffice, `whisper` não | LibreOffice opcional para prévias; nada de Whisper, que era das reuniões | |

## Scripts da raiz

| Script | Faz |
| --- | --- |
| `npm run dev:desktop` | `tauri dev` em `apps/desktop`, com o Vite servindo `packages/ui` |
| `npm run build:desktop` | `tauri build` no sistema atual, precedido do build do sidecar para o triplo local |
| `npm run build:tunnel` | Compila o sidecar para todos os triplos em `apps/desktop/src-tauri/binaries` |
| `npm run build:tunnel:mobile` | `tools/build-tunnel-mobile.sh` |
| `npm run dev:mobile` | `expo start --dev-client` em `apps/mobile` |
| `npm run prebuild:mobile` | `expo prebuild` das duas plataformas, nunca versionado |
| `npm run test` | `test:ui`, `test:protocol`, `test:desktop`, `test:tunnel`, `test:mobile` |
| `npm run test:ui` | `node --test packages/ui/tests` mais `tools/check/*.mjs` |
| `npm run test:browser` | `tools/browser/run-browser-checks.mjs` |
| `npm run test:desktop` | `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, `cargo test` em `apps/desktop/src-tauri` |
| `npm run test:tunnel` | `go test ./...` em `packages/tunnel-core` |
| `npm run test:tunnel:integration` | `go test -tags integration ./integration` com Docker |
| `npm run test:mobile` | `jest --runInBand`, `tsc --noEmit`, `eslint . --max-warnings 0` em `apps/mobile` |
| `npm run check:text` | Varre `docs`, `packages/ui/src` e `apps/mobile/src` por parênteses e travessões em texto visível |
| `npm run icons` | Gera os ícones das três plataformas e roda `check-app-icon.swift` |

## Como rodar

| Cenário | Passos |
| --- | --- |
| Desktop em desenvolvimento | `npm ci`, `npm run build:tunnel` para o triplo local, `npm run dev:desktop`; o app abre com `?cialai_selftest=1` quando `devUrl` aponta para isso |
| Headscale local | `cd infra/headscale && docker compose up`, com `server_url` em `http://127.0.0.1:8080` só em desenvolvimento; `bootstrap.sh --dev` gera a chave da API |
| Celular em desenvolvimento | `npm run build:tunnel:mobile`, `npm run prebuild:mobile`, `npx expo run:ios --device` ou `npx expo run:android --device`; simuladores não têm UDP confiável para o WireGuard, então rede só em aparelho real |
| Página do celular no desktop | `http://127.0.0.1:1420/mobile.html?bridge=ws://127.0.0.1:3720/pty` com `--dev-open-bridge`, como o protótipo fazia com `?bridge=` em loopback |
| Demo do estúdio | `http://127.0.0.1:1420/?terminais=demo&motion=0#terminais` |

## Testes por pacote

| Pacote | Suítes | Origem |
| --- | --- | --- |
| `packages/ui` | `terminal-restore`, `mobile-terminal-touch`, `mobile-terminal-route`, `mobile-keyboard-viewport` em Node; `check-file-kinds`, `check-terminal-sync` com 17 casos, `check-phone-terminal`, `check-phone-workbench`, `check-mobile` com 14 casos, `check-mobile-readonly-ui`; `check-studio-browser`, `check-explorer-drop-browser`, `check-terminal-drop-browser` por Playwright | `$CONTROL/backend/node/tests`, `$CONTROL/frontend/scripts` |
| `packages/protocol` | Validação das fixtures contra o esquema; `remote.js` com 4401 sem retentativa e URL por `location.host` | Novo, mais `check-mobile.mjs` |
| `apps/desktop` | A suíte Rust elegível do Control sem falhas e com ignores justificados, mais `TestShell` e `TestChild` por sistema, ponte com segredo da borda, supervisor do sidecar, `resume` por sabor, `files` por sistema, `watch` por backend, `journal` no Windows; `selftest-app.js` por `tauri-driver` no Linux e no Windows e por `tauri dev` no macOS | `$CONTROL/macos/src-tauri`, `$CONTROL/frontend/scripts/selftest-app.js` |
| `packages/tunnel-core` | Unitários de `pairing`, `headscale`, `rpc`, `proxy`, `edge`, `node`; integração com Headscale em Docker | Novo |
| `apps/mobile` | Os 65 casos do Control mais QR, perfis, URL do proxy, saúde, transições, `navigate-back` | `$CONTROL/ios/app` |
| `tools/release` | `cm-build-number.test.sh`, `cm-download.test.sh`, `cm-config.test.cjs` | `$CONTROL/scripts` |

## Convenções

| Tema | Regra |
| --- | --- |
| Commits | Prefixo por área como no Control: `feat(desktop): …`, `fix(mobile): …`, `docs: …`, `chore(release): …`; mensagens em português na equipe, inglês aceito de contribuidores externos |
| Branches | `main` protegida; trabalho em branches curtas com PR; CI verde obrigatório; releases por tag `v<semver>` |
| Versões | Uma versão semântica para o desktop, uma para o celular; o protocolo da ponte tem `version` própria; o sidecar reporta a sua |
| Texto | Regras do documento 08 em interface, documentos e textos de loja |
| Idioma | Código, identificadores e comentários em inglês; documentação de planejamento em português; README público e CONTRIBUTING em inglês com resumo em português |
| Segredos | Nunca na árvore; só `.env.example` com nomes; valores em Codemagic, GitHub Secrets, keychain local e no repositório privado `ordinum-credentials` por referência; `.gitignore` com `.env`, `.env.*`, `secrets/`, `*.p8`, `*.pem`, `*.jks`, `*.keystore`, `*-service-account.json`, `android/key.properties`, e cada regra em linha própria sem comentário ao lado, porque o Advoris ficou três meses com `secrets/` desprotegido por um comentário na mesma linha |
| Gerados | `apps/mobile/ios`, `apps/mobile/android`, `.expo`, `apps/desktop/src-tauri/target`, `apps/desktop/src-tauri/binaries`, `packages/tunnel-core/build`, `dist`, `node_modules` nunca entram no Git |
| Licença | Cabeçalho curto `SPDX-License-Identifier: Apache-2.0` nos arquivos novos; arquivos vindos do Control mantêm a autoria da Ordinum sob a mesma licença; `NOTICE` lista `tailscale.com` e Headscale em BSD 3, xterm.js, CodeMirror, Tauri, React, Expo e JetBrains Mono |
| Documentação viva | Ao fim de cada fase, os documentos desta pasta são atualizados para descrever o que existe, não o que se planejava; um `CHANGELOG.md` por release |

## Arquivos de abertura do repositório

`README.md` com o que é, capturas, instalação por sistema, pareamento, auto hospedagem do Headscale, estado e licença; `CONTRIBUTING.md` com como rodar, testar, convenções e o processo de PR; `CODE_OF_CONDUCT.md` no padrão Contributor Covenant; `SECURITY.md` com o e-mail de contato para vulnerabilidades e o prazo de resposta; modelos de issue para bug, pedido e pergunta; modelo de PR com a lista de verificação de testes e texto.
