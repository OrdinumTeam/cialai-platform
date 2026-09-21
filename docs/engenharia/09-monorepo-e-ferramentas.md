# Monorepo e ferramentas

## Estado em 13/09/2026

| Item | Estado | Situação atual |
| --- | --- | --- |
| Workspaces e toolchains | Implementado | npm, Node, Rust, Go, Expo e versões centrais estão fixados no repositório |
| Desktop, interface, protocolo e túnel | Implementado | Os quatro pacotes existem e passam na suíte local do macOS |
| Aplicativo móvel | Preparado | TypeScript e checks passam; projetos nativos gerados, builds e aparelhos continuam externos |
| Infraestrutura Headscale | Implementado | Receita e integração Docker local existem só como histórico; desde a prévia 0.2.0 a conectividade automática não usa servidor e o produto não depende desta receita |
| Ferramentas de check e self test | Implementado | Checks estruturais, suíte da interface e self test local estão versionados |
| Ferramentas de release e lojas | Preparado | Scripts e guardas existem; credenciais, assinatura e chamadas de publicação não foram executadas |
| Navegador automatizado multiplataforma | Pendente | Não há diretório `tools/browser` nem workflow nightly nesta linha |
| Documentação viva | Implementado | Documentos 01 a 12 têm estado datado e o documento 13 mantém a evidência de execução |

## Estrutura

```
cialai-platform/
  README.md                          apresentação, estado, índice
  LICENSE                            Apache 2.0
  NOTICE                             licenças BSD e MIT das dependências centrais
  CONTRIBUTING.md, CODE_OF_CONDUCT.md, SECURITY.md
  package.json                       workspaces npm e scripts da raiz
  .gitignore
  .github/workflows/                 ci.yml, release.yml, headscale-integration.yml, spike-headscale.yml
  codemagic.yaml                     ios-testflight, ios-archive, android-play
  docs/                              documentação viva, evidências, lojas, revisão e roteiros
  apps/
    desktop/                         Tauri 2, ver 04-desktop.md
    mobile/                          Expo, ver 05-mobile.md
      modules/cialai-tunnel/         módulo nativo do túnel
  packages/
    ui/                              React: estúdio, casca desktop, casca do celular, tokens, fontes
    protocol/                        contrato da ponte e do pareamento, remote.js, native.js, sensitive.js, fixtures
    tunnel-core/                     Go: identidade, transportes direto e Tor, rendezvous, DNS-SD, borda, proxy, pareamento, sidecar, gomobile; modo Headscale inerte até CON-070
  infra/
    headscale/                       histórico fora do produto: docker-compose.yml, config/, bootstrap.sh, README.md
  tools/
    check/                           checks estruturais e guardas da documentação
    selftest/                        selftest-app.js e fixtures
    spikes/                          preparação e execução local dos experimentos
    release/                         updater, checklist, cm-*.sh, APIs das lojas e check do ícone
    windows/                         collect-diagnostics.ps1, coleta de registros e de ambiente no Windows
    build-tunnel-mobile.sh           gera o xcframework e o aar
    build-tunnel.mjs                 gera e verifica os sidecars
    run.mjs                          orquestra checks desktop, túnel e integrações
```

O diretório `tools/browser` continua planejado para a tarefa 5.15. `nightly-e2e.yml` e `tools/selftest/driver.mjs` existem desde a tarefa 5.18, sem execução remota observada. Diretórios gerados como `dist`, `target`, `node_modules`, binários e recursos móveis podem existir no ambiente local e permanecem ignorados pelo Git.

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
| Android SDK e NDK | `compileSdk` 37, exigido pelo `tor-android`, `targetSdk` 36, NDK fixado pelo Expo | Android |
| Expo | SDK 57, `expo-dev-client` | Celular |
| Playwright | 1.63.0 fixado em `tools/browser/package.json` com lockfile próprio | Checks de navegador por `tools/browser/run-browser-checks.mjs`; o Dev Browser do app instala o Chromium por `npx playwright` |
| Docker | qualquer recente | Headscale de integração |
| LibreOffice, `whisper` não | LibreOffice opcional para prévias; nada de Whisper, que era das reuniões | |

## Scripts da raiz

| Script | Faz |
| --- | --- |
| `npm run dev:desktop` | `tauri dev` em `apps/desktop`, com o Vite servindo `packages/ui` |
| `npm run build:desktop` | `tauri build` no sistema atual, precedido do build do sidecar para o triplo local |
| `npm run build:tunnel` | Compila os cinco alvos de release por `tools/build-tunnel.mjs`; `--local` é usado pelo workspace desktop para gerar só o alvo atual |
| `npm run test` | Executa guardas de fundação e lançamento, depois interface, protocolo, desktop, túnel e celular |
| `npm run test:ui` | Executa os checks de extração, sincronização, rede, marca, arquivos, casca, plataforma e preferências |
| `npm run test:protocol` | Valida o esquema, as fixtures e o cliente remoto de `packages/protocol` |
| `npm run test:desktop` | Confere estrutura, ícone, extração, onboarding, self test, sidecar e updater; gera sidecar e recurso móvel; executa build Vite, formatação, clippy e testes Rust |
| `npm run test:tunnel` | Confere a receita Headscale, executa `go vet` e `go test -mod=readonly ./...` |
| `npm run test:mobile` | Executa Jest no aplicativo Expo; typecheck e lint têm scripts próprios no workspace e também estão no Codemagic |
| `npm run test:selftest` | Executa o self test local no app real: terminal, arquivos, editor e Dev Browser com dados fictícios em diretório temporário; rede automática pelo sidecar v2 com a identidade e o Tor do app, sem campo preenchido, QR `CIALAI2.` lido do canvas sem gravar o payload e Dispositivos com `diagnostics.run` |
| `npm run test:integration:headscale` | Executa a integração Docker com Headscale quando o ambiente estiver disponível |
| `npm run test:spike:headscale` | Executa o spike local de política e expiração |
| `npm run check:source` | Confere commit e hashes da origem somente leitura no Control |
| `npm run check:public-docs` | Confere README, contribuição, segurança, conduta e modelos públicos |
| `npm run check:store-metadata` | Confere políticas, respostas, limites e plano de capturas das lojas |
| `npm run check:review-pack` | Confere notas de revisão e roteiros de demonstração e vídeo |
| `npm run check:manual-mobile` | Confere as folhas imprimíveis iOS e Android sem aprovar seus resultados |
| `npm run check:release` | Confere a preparação da versão 1; `--release` exige os seis gates verificados |
| `npm run check:living-docs` | Confere estado datado nos documentos 01 a 12 e cobertura das tarefas e decisões |
| `npm run check:release-workflow` | Confere canal de prévia, assinatura opcional, nomes estáveis, `latest.json`, `SHA256SUMS` e publicação do `release.yml` |
| `npm run check:text` | Recusa parênteses e hífen, meia-risca ou travessão como separador no texto visível dos três idiomas, das lojas, das políticas e das notas de release |
| `npm run test:browser` | Sobe o Vite do desktop e roda por Playwright os roteiros do estúdio, da rede e do celular; exige `npm ci --prefix tools/browser` e o Chromium do Playwright. Dois cenários rodam sobre o build de produção, servido por `preview`, porque a ordem dos pedaços do Vite e o modo de inserção do emotion só existem lá |
| `npm run check:dialog-geometry` | Cruza os números de `components/modal-geometry.js` com a folha de produção e confere que nada vence a caixa do papel; roda depois do build |
| `npm run check:performance` | Orçamento de desempenho num computador simulado quatro vezes mais lento, sobre o build de produção. Mede o tempo até o estúdio ficar utilizável, o payload da primeira pintura, as tarefas longas e a taxa de quadros da folha animada, compara com `tools/check/performance-baseline.json` e imprime a variação. Regravar a base é `node tools/check/performance.mjs --registrar` |

O build móvel continua disponível pelo arquivo `tools/build-tunnel-mobile.sh`, sem atalho na raiz. Desenvolvimento Expo e prebuild são executados no workspace `@cialai/mobile`. `test:browser` e `check:text` existem desde 14/09/2026; `check:dialog-geometry` e `check:performance` desde 21/09/2026; o atalho `icons` do planejamento original continua como `npm run icon --workspace @cialai/desktop`.

## Como rodar

| Cenário | Passos |
| --- | --- |
| Desktop em desenvolvimento | `npm ci`, `npm run build:tunnel` para o triplo local, `npm run dev:desktop`; o app abre com `?cialai_selftest=1` quando `devUrl` aponta para isso |
| Headscale local, histórico | `cd infra/headscale && docker compose up`, com `server_url` em `http://127.0.0.1:8080` só em desenvolvimento; `bootstrap.sh --dev` gera a chave da API. O desktop e o celular não usam desde a prévia 0.2.0; serve só ao modo inerte até CON-070 |
| Celular em desenvolvimento | `bash tools/build-tunnel-mobile.sh`, depois `npm exec --workspace @cialai/mobile -- expo prebuild` e `npm exec --workspace @cialai/mobile -- expo run:ios --device` ou `expo run:android --device`; simuladores não têm UDP confiável para o caminho direto, então rede só em aparelho real |
| Página do celular no desktop | `http://127.0.0.1:1420/mobile.html?bridge=ws://127.0.0.1:3720/pty` com `--dev-open-bridge`, como o protótipo fazia com `?bridge=` em loopback |
| Demo do estúdio | `http://127.0.0.1:1420/?terminais=demo&motion=0#terminais` |

## Testes por pacote

| Pacote | Suítes | Origem |
| --- | --- | --- |
| `packages/ui` | `terminal-restore`, `terminal-reattach`, `terminal-replay-silence`, `terminal-activity-state`, `terminal-ime-input`, `windows-paths`, `mobile-terminal-touch`, `mobile-terminal-route`, `mobile-keyboard-viewport` em Node; `check-file-kinds`, `check-panels`, `check-terminal-sync`, `check-phone-terminal`, `check-phone-workbench`, `check-session-card`, `check-phone-composer`, `check-phone-session-menu`, `check-new-session-popover`, `check-agent-profiles`, `check-docgraph`, `check-submit-text`, `check-mobile-shell`, `check-platform`, `check-preferences`, `check-brand`; `check-studio-browser`, `check-explorer-drop-browser`, `check-terminal-drop-browser` por Playwright | `$CONTROL/backend/node/tests`, `$CONTROL/frontend/scripts` |
| `packages/protocol` | Validação das fixtures contra o esquema; `remote.js` com 4401 sem retentativa e URL por `location.host` | Novo, mais `check-mobile.mjs` |
| `apps/desktop` | A suíte Rust elegível do Control sem falhas e com ignores justificados, mais `TestShell` e `TestChild` por sistema, ponte com segredo da borda, supervisor do sidecar, `resume` por sabor, `files` por sistema, `watch` por backend, `journal` no Windows; `selftest-app.js` por `tauri-driver` no Linux e no Windows e por `tauri dev` no macOS | `$CONTROL/macos/src-tauri`, `$CONTROL/frontend/scripts/selftest-app.js` |
| `packages/tunnel-core` | Unitários de `identity`, `transport`, `tor`, `rendezvous`, `mdns`, `pathmgr`, `pairing`, `sidecar`, `proxy` e `edge`, com testes em processo contra a rede Tor real; os pacotes do modo Headscale seguem inertes e a integração com Headscale em Docker ficou histórica, sem compilar desde o sidecar v2 | Novo |
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

`README.md` com o que é, capturas, instalação por sistema, pareamento, conectividade automática sem servidor, estado e licença; `CONTRIBUTING.md` com como rodar, testar, convenções e o processo de PR; `CODE_OF_CONDUCT.md` no padrão Contributor Covenant; `SECURITY.md` com o e-mail de contato para vulnerabilidades e o prazo de resposta; modelos de issue para bug, pedido e pergunta; modelo de PR com a lista de verificação de testes e texto.
