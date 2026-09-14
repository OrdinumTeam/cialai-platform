# Roadmap de execução

Oito fases, cada uma com tarefas numeradas, tamanho relativo, raia de paralelismo, dependências e critérios de aceite. Tamanhos: P até meio dia, M de um a dois dias, G de três a cinco dias. Raias A, B e C podem andar em paralelo dentro da fase depois de cumpridas as dependências. Cada tarefa cita o documento que a detalha.

## Estado em 13/09/2026

Estados refletem apenas o conteúdo integrado nesta linha. `Implementado` exige entrega local e verificação proporcional ao que está disponível. `Preparado` indica código, roteiro ou workflow presente com aceite externo, remoto ou físico ainda pendente. `Pendente` indica trabalho ausente nesta linha ou execução ainda não iniciada. O documento 13 contém a evidência detalhada.

### Fase 0

| Tarefa | Estado | Limite atual |
| --- | --- | --- |
| 0.1 | Implementado | Fundação e arquivos públicos existem |
| 0.2 | Pendente | O commit solicitado no Control depende do usuário |
| 0.3 | Implementado | `ci.yml` roda nos dois repositórios desde 14/09/2026 e ficou verde nos três sistemas no run `34813846975` do público |
| 0.4 | Preparado | Bindings e script existem sem aparelhos e medições |
| 0.5 | Pendente | Transições físicas não foram repetidas nos aparelhos |
| 0.6 | Implementado | Política e expiração passaram em Docker local |
| 0.7 | Pendente | WKWebView nativo não foi exercitado |
| 0.8 | Pendente | WebView Android com AAR não foi exercitado |
| 0.9 | Pendente | TestFlight externo não foi submetido |
| 0.10 | Pendente | Conjunto assinado dos três desktops não foi produzido |
| 0.11 | Pendente | Soak de 24 horas não foi executado |
| 0.12 | Preparado | Resultados existentes estão no documento 12; spikes restantes aguardam evidência |

### Fase 1

| Tarefa | Estado | Limite atual |
| --- | --- | --- |
| 1.1 | Implementado | Scaffold Tauri e duas entradas Vite aprovados |
| 1.2 | Implementado | Rust elegível extraído e testado no macOS |
| 1.3 | Implementado | Interface extraída e checks locais aprovados |
| 1.4 | Implementado | Plataforma, shell e caminhos portáveis integrados |
| 1.5 | Implementado | Página móvel empacotada como recurso |
| 1.6 | Implementado | Raízes e onboarding integrados |
| 1.7 | Implementado | Marca, ícones e regra ANSI integrados |
| 1.8 | Implementado | Preferências do produto integradas |
| 1.9 | Implementado | Pacote de protocolo, esquema e fixtures integrados |
| 1.10 | Implementado | Self test local aprovado no macOS |
| 1.11 | Implementado | Capturas macOS e móveis comparadas com dados fictícios |

### Fase 2

| Tarefa | Estado | Limite atual |
| --- | --- | --- |
| 2.1 | Implementado | Base Go, nó, estado, logs e RPC testados |
| 2.2 | Implementado | Cliente Headscale e interface administrativa testados |
| 2.3 | Implementado | QR, sessões, dispositivos e tokens testados |
| 2.4 | Implementado | Borda, estáticos, pareamento e autenticação testados |
| 2.5 | Implementado | Proxy em loopback e proteções testados |
| 2.6 | Implementado | Sidecar, doctor, versão, pai e trava testados |
| 2.7 | Implementado | Supervisor Rust e eventos testados localmente |
| 2.8 | Implementado | Ponte com segredo, dispositivo e revogação testada |
| 2.9 | Implementado | Assistente, QR, dispositivos e estados integrados na interface |
| 2.10 | Implementado | Receita Headscale e check local aprovados |
| 2.11 | Implementado | Integração Docker verde localmente e em `headscale-integration.yml` no privado e no público em 14/09/2026 |
| 2.12 | Implementado | Cinco sidecars compilados e verificados no `release.yml` da prévia `v0.1.0` em 14/09/2026 |

### Fase 3

| Tarefa | Estado | Limite atual |
| --- | --- | --- |
| 3.1 | Implementado | XCFramework e AAR gerados no Codemagic e no `mobile-artifacts.yml`, run `34811514866`, em 14/09/2026; anexo a uma release e aparelhos pendentes |
| 3.2 | Implementado | Wrapper Swift compilado e IPA assinado aceito pela Apple em 14/09/2026; iPhone pendente |
| 3.3 | Implementado | Casca Expo e estados passam em Node |
| 3.4 | Implementado | URL, saúde, shell e ganchos passam nos checks locais |
| 3.5 | Implementado | Info.plist conferido no IPA do build 1; criptografia isenta de documentação pela atualização da decisão 014 |
| 3.6 | Implementado | Página móvel reduzida e checks aprovados |
| 3.7 | Implementado | Cento e um casos em quinze suítes aprovados na validação final desta frente |
| 3.8 | Implementado | Build 1 da 0.1.0 processado e em teste interno no TestFlight desde 14/09/2026; TestFlight externo pendente |
| 3.9 | Preparado | Roteiro imprimível existe sem execução em iPhone |
| 3.10 | Pendente | Ensaio externo do App Review não ocorreu |

### Fase 4

| Tarefa | Estado | Limite atual |
| --- | --- | --- |
| 4.1 | Implementado | Wrapper Kotlin compilado com o AAR no Codemagic em 14/09/2026; aparelho pendente |
| 4.2 | Implementado | Configuração foi validada por prebuild e introspecção |
| 4.3 | Implementado | Voltar foi validado pelos checks Node |
| 4.4 | Preparado | Ciclo de vida existe sem suspensão em aparelho |
| 4.5 | Preparado | Política e Secure Store existem sem biometria e Keystore reais |
| 4.6 | Implementado | AAB e APK assinados pela chave de upload; AAB em rascunho na faixa interna desde 14/09/2026 |
| 4.7 | Preparado | Roteiro imprimível existe sem execução em Android |
| 4.8 | Pendente | Relatório do Play depende do AAB enviado |

### Fase 5

| Tarefa | Estado | Limite atual |
| --- | --- | --- |
| 5.1 | Implementado | Contrato e backends verificados no macOS, no Linux e na suíte Rust nativa do Windows na CI em 14/09/2026 |
| 5.2 | Implementado | Backend Linux verificado no Ubuntu 22.04 arm64 em contêiner |
| 5.3 | Implementado | Backend Windows testado na suíte Rust nativa do `windows-2022` em 14/09/2026, com memória por working set antes do Windows 11; máquina Windows física pendente |
| 5.4 | Implementado | PTY verificado no macOS, no Linux e no ConPTY do `windows-2022`; desde 14/09/2026 o Rust responde a pergunta de cursor com que o ConPTY nasce |
| 5.5 | Preparado | Retomada verificada no macOS e Linux; sintaxe PowerShell e cmd testada no Windows da CI, sem retomada real de agente |
| 5.6 | Implementado | Observador verificado no macOS, no Linux e na suíte nativa do Windows na CI em 14/09/2026 |
| 5.7 | Implementado | Arquivos verificados no macOS, no Linux e na suíte nativa do Windows na CI em 14/09/2026; lixeira real do Windows sem teste manual |
| 5.8 | Preparado | Prévia testada no macOS e Linux; WebView2 não exercitado |
| 5.9 | Preparado | Descoberta testada no macOS e Linux; Chromium, WebView2 e LibreOffice reais pendentes fora do macOS |
| 5.10 | Preparado | Diagnóstico e hook testados no macOS e Linux; instalador PowerShell sem execução nativa |
| 5.11 | Preparado | Na main desde `d2678e7`: backends de janela, menu da toolbar e controles do Windows testados no macOS, no Linux em contêiner e por Clippy cruzado do Windows; animação X11 medida sob Xvfb, Wayland e Windows nativo não exercitados |
| 5.12 | Implementado | Contrato único de atalhos testado e conferido no Dev Browser; sem execução nativa Linux ou Windows |
| 5.13 | Implementado | Na main desde `d64207d` e `bfccb08`: casca, fontes, `.mac-switch` e JetBrains Mono conferidos em Chromium nos três sistemas, com a cascata de produção protegida; WebKitGTK e WebView2 reais não exercitados |
| 5.14 | Implementado | Na main desde `b1a4efe`: Terminal, Dev Browser, Janela e caminhos por sistema em testes Rust nos três alvos e conferidos em Chromium nos três idiomas; troca do Mica ao salvar sem execução Windows |
| 5.15 | Implementado | Suíte Rust nativa verde no macOS, no Ubuntu e no `windows-2022` da CI em 14/09/2026; checks de navegador por Playwright no Ubuntu |
| 5.16 | Implementado | `ci.yml` verde nos três sistemas no run `34813846975` de 14/09/2026, com `check:text` e Playwright no Ubuntu; `release.yml` publicou as prévias `v0.1.0` e `v0.1.1` |
| 5.17 | Pendente | Assinaturas e instaladores não foram executados |
| 5.18 | Preparado | `nightly-e2e.yml` rodou no público em 14/09/2026, passou 8 de 8 no Ubuntu e foi desligado às 04:40 para conter minutos; no Windows a janela cresce, o explorador abre e o PowerShell responde, mas a página do WebView2 sem GPU fica lenta e deixa de responder ao WebDriver antes do fim do roteiro |
| 5.19 | Implementado | README e guia 14 registram preparo e evidência por plataforma |

### Fase 6

| Tarefa | Estado | Limite atual |
| --- | --- | --- |
| 6.1 | Preparado | Runner e imagem Ubuntu existem; testes Linux e Windows não rodaram |
| 6.2 | Preparado | Conversão real verificada no macOS; Linux e Windows pendentes |
| 6.3 | Pendente | Uso de plano não foi validado nos três sistemas |
| 6.4 | Implementado | Backend Win32 ligado no Windows desde 14/09/2026 e testado na suíte Rust nativa da CI; leitura pelo celular num Windows real pendente |
| 6.5 | Pendente | Arraste externo continua opcional e sem Linux ou Windows |
| 6.6 | Implementado | Desktop, terminais, página e app do celular, menu, diálogos e mensagens nativas do desktop e metadados nativos do app usam português do Brasil, inglês e espanhol neutro a partir de `@cialai/i18n`; `check:i18n` e `check:native-i18n` rodam no `npm test`; menu nativo, WebView2, WebKitGTK, aparelhos e textos de loja em espanhol não exercitados |
| 6.7 | Pendente | Tokens `--mac-*` permanecem por decisão |
| 6.8 | Implementado | Documentos 01 a 12 foram revistos com estado datado e check automático |

### Fase 7

| Tarefa | Estado | Limite atual |
| --- | --- | --- |
| 7.1 | Implementado | Chave gerada e `latest.json` assinado nas prévias `v0.1.0` e `v0.1.1`; a `v0.1.1` é a primeira atualização oferecida a quem instalou a anterior, sem instalação real conferida |
| 7.2 | Implementado | Documentação pública e modelos foram revistos |
| 7.3 | Preparado | Políticas, formulários propostos, textos e capturas planejadas existem sem publicação |
| 7.4 | Preparado | Notas e roteiros existem sem submissão às lojas |
| 7.5 | Preparado | Prévias `v0.1.0` e `v0.1.1` publicadas em 14/09/2026; seis gates da versão 1 pendentes |
| 7.6 | Pendente | Anúncio e página do projeto não foram produzidos |

As frentes paralelas alteram a ordem de autoria, mas não dispensam dependências de aceite. Em particular, a documentação e os materiais da Fase 7 podem estar preparados enquanto as Fases 5 e 6 e os testes externos continuam pendentes.

## Fase 0: fundação e spikes

Objetivo: monorepo pronto, toolchains fixadas, CI mínima nos três sistemas e as oito incertezas de rede resolvidas com critérios numéricos antes de qualquer código de produto.

| Tarefa | Tamanho | Depende | Documento |
| --- | --- | --- | --- |
| 0.1 Inicializar o repositório: `git init`, workspaces npm, `LICENSE` Apache 2.0, `NOTICE`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `.gitignore`, modelos de issue e PR, pacotes vazios com `package.json`, `Cargo.toml` e `go.mod` | M | | 09 |
| 0.2 Fora do monorepo: o usuário faz commit das oito mudanças pendentes no Control, para a origem da extração ser rastreável | P | | 02 |
| 0.3 `ci.yml` mínimo rodando nos três sistemas com os pacotes vazios | P | 0.1 | 10 |
| 0.4 Spike 1: `gomobile` com `tsnet` em iPhone e Android reais contra Headscale em Docker | G | 0.1 | 06 |
| 0.5 Spike 2: transições de rede e suspensão | M | 0.4 | 06 |
| 0.6 Spike 3: política e expiração no Headscale 0.29.3 com dois usuários | M | 0.1 | 06 |
| 0.7 Spike 4: WKWebView com proxy em loopback carregando o bundle do protótipo | M | 0.4 | 06 |
| 0.8 Spike 5: WebView do Android com o AAR e o plugin de segurança de rede | M | 0.4 | 06 |
| 0.9 Spike 6: ensaio do App Review por TestFlight externo com o texto final | M | 0.7 | 06 |
| 0.10 Spike 7: empacotamento com o sidecar nos três sistemas, assinatura e notarização | M | 0.1 | 06, 10 |
| 0.11 Spike 8: robustez do proxy com soak de 24 h | M | 0.7 | 06 |
| 0.12 Registrar em `12-decisoes.md` o resultado de cada spike e as consequências | P | 0.4 a 0.11 | 12 |

Aceite: CI verde nos três sistemas; cada spike com resultado registrado e, em caso de falha, a alternativa da tabela do documento 06 escolhida; orçamento dos certificados de assinatura aprovado.

## Fase 1: desktop macOS com paridade

Objetivo: o estúdio completo rodando no macOS a partir do monorepo, idêntico ao Control exceto pela marca, com todas as suítes herdadas verdes e sem Node, Python, reuniões, VPN e launcher.

| Tarefa | Tamanho | Depende | Raia | Documento |
| --- | --- | --- | --- | --- |
| 1.1 Scaffold de `apps/desktop`: `tauri.conf.json` com os arquivos por sistema, capabilities, ícones provisórios, `vite.config.js` com as entradas `index.html` e `mobile.html` | M | 0 | | 04 |
| 1.2 Mover o Rust sem `stack.rs`, `meetings/`, `vpn/`; renomear identificadores e textos; `prefs.rs` novo; ponte reduzida a `pty`; `commands.rs` sem os comandos removidos; suíte elegível sem falhas e ignores justificados no macOS | G | 1.1 | A | 02, 04 |
| 1.3 Mover o frontend para `packages/ui` conforme a tabela de extração; apagar `AppContext`, `lib/api.js`, `lib/query*.js`, `StackGate`, reuniões, views de negócio; `DesktopApp` e `main` novos; chaves `cialai_*` com migração; checks Node e de navegador verdes | G | 1.1 | B | 04 |
| 1.4 Módulo `platform/` com `PlatformInfo`, `ShellSpec`, `ShellFlavor`, `to_portable`, `default_lang`, `path_prefix`; `TerminalInfo.shellFlavor`; `lib/platform.js` | M | 1.2, 1.3 | | 04 |
| 1.5 Bundle da página do celular como recurso do Tauri, caminho exposto ao supervisor | P | 1.3 | B | 06 |
| 1.6 Preferência `projectRoots` substituindo `repos.rs`; `mobile_files::root` lendo a lista; onboarding com boas-vindas, pastas, shell e pronto | M | 1.4 | A | 04 |
| 1.7 Marca Cialai: `brand.css`, acento, gradiente da sidebar, splash, ícone, regra do azul no tema do terminal | M | 1.3 | C | 08 |
| 1.8 Preferências com Aparência, Terminal, Projetos e Dev Browser | P | 1.6 | C | 04 |
| 1.9 `packages/protocol` com `remote.js`, `native.js`, `sensitive.js`, esquema e fixtures | P | 1.3 | B | 07 |
| 1.10 `selftest-app.js` rodando por `tauri dev` com `?cialai_selftest=1` | P | 1.2, 1.3 | | 09 |
| 1.11 Capturas da demo em claro e escuro comparadas com o Control | P | 1.7 | | 08 |

Aceite: `cargo test` sem falhas e com cada ignore justificado, usando a contagem real registrada no handoff; `check-terminal-sync.mjs` com 17 casos; checks de navegador terminando em `PASS`; self test com todos os itens; capturas idênticas exceto pela marca; um usuário do Control abre o Cialai e não percebe diferença de comportamento.

## Fase 2: túnel e pareamento

Objetivo: o desktop entra num Headscale auto hospedado, mostra o QR, aceita pareamentos e serve a página do celular pela borda, com a ponte exigindo o segredo da borda.

| Tarefa | Tamanho | Depende | Raia | Documento |
| --- | --- | --- | --- | --- |
| 2.1 `packages/tunnel-core`: layout, `internal/rpc`, `internal/node`, `internal/statedir`, `internal/logx` com redação | M | 0 | A | 06 |
| 2.2 `internal/headscale` e `internal/control` com `ControlAdmin` e `HeadscaleDirect`; testes contra servidor falso; caminhos conferidos no `/swagger` do 0.29.3 | M | 2.1 | A | 06 |
| 2.3 `internal/pairing`: codec do QR, sessões, registro `devices.json`, tokens e hashes | M | 2.1 | B | 06 |
| 2.4 `internal/edge`: estáticos com as regras de `mobile-site.js`, `/api/health`, `/pair`, autenticação por Bearer e `WhoIs`, proxy reverso com os cabeçalhos `X-Cialai-*`, limites | G | 2.2, 2.3 | A | 06 |
| 2.5 `internal/proxy`: loopback, nonce, cookie, `Origin`, Bearer, prazos, `X-Cialai-Token-Next` | M | 2.1 | B | 06 |
| 2.6 `cmd/cialai-tunnel` com `serve-stdio`, `doctor`, `version`, `--parent-pid`, trava | P | 2.4 | A | 06 |
| 2.7 Supervisor Rust em `tunnel/`, eventos `tunnel://*`, chave da API no `keyring`, segredo da borda por abertura | M | 1.2, 2.6 | | 04, 06 |
| 2.8 Ponte: `BridgeConfig { proxy_secret, dev_open }`, `device_id` na conexão, `welcome` estendido, fechamento por revogação, testes | P | 1.2 | | 07 |
| 2.9 Interface: assistente do Headscale no onboarding e nas preferências, diálogo Vincular celular com rotação de 90 s, tela Dispositivos, ponto de estado na sidebar e na toolbar | M | 2.7 | C | 04 |
| 2.10 `infra/headscale`: compose, `config.yaml`, `policy.json`, `bootstrap.sh`, README de 10 minutos | M | 0.6 | C | 06 |
| 2.11 Teste de integração em Docker e `headscale-integration.yml` | M | 2.4, 2.5, 2.10 | | 06, 10 |
| 2.12 Build do sidecar para os cinco triplos em `release.yml` e `externalBin` | P | 2.6 | | 10 |

Aceite: integração em Docker verde no CI; no macOS, o desktop registra no Headscale de teste, mostra o QR, um celular simulado pelo `testutil` pareia, a página carregada por `mobile.html` em loopback com `--dev-open-bridge` conecta com `auth: "device"`, a revogação fecha em menos de 1 s.

## Fase 3: iOS

Objetivo: o app iOS pareia pelo QR, abre a página pelo proxy e passa nos roteiros manuais, com build interno no TestFlight.

| Tarefa | Tamanho | Depende | Documento |
| --- | --- | --- | --- |
| 3.1 `mobile-artifacts.yml` e `tools/build-tunnel-mobile.sh` gerando o xcframework com SHA-256 | M | 2.6 | 10 |
| 3.2 Módulo Expo `cialai-tunnel` em Swift com a API do documento 05 e o podspec com `vendored_frameworks` | M | 3.1 | 05 |
| 3.3 Scaffold de `apps/mobile` a partir de `ios/app`: máquina de estados nova, `Pair`, confirmação, `Desktops`, `Shell`, `Offline`, `Ajustes`, loja de perfis, tokens no Secure Store | G | 3.2 | 05 |
| 3.4 `config/url.ts` aceitando a URL do proxy, `health.ts` com serviço `cialai`, `__CIALAI_SHELL__`, NetInfo e `AppState` chamando o módulo | P | 3.3 | 05 |
| 3.5 `app.config.ts`: bundle, câmera, rede local, Face ID, `usesNonExemptEncryption` conforme a decisão 014, proteção de dados, exclusão de backup | P | 3.3 | 05 |
| 3.6 Página do celular em `packages/ui/src/mobile` com só Terminais e o cabeçalho com nome do desktop e estado | P | 1.3 | 05 |
| 3.7 Jest: os 65 casos herdados mais QR, perfis, URL, saúde, transições | M | 3.3 | 05 |
| 3.8 `codemagic.yaml` com `ios-testflight` e `ios-archive`; app no App Store Connect e no Codemagic; integração `Cialai ASC API Key`; grupo `appstore_credentials` | M | 3.5 | 10 |
| 3.9 Roteiros manuais do documento 06 num iPhone real | M | 3.4, 2.9 | 06 |
| 3.10 Ensaio do App Review por TestFlight externo, se o spike 6 não tiver sido feito com o app final | P | 3.8 | 06 |

Aceite: todos os roteiros manuais aprovados no iPhone; build interno instalado pelo grupo Ordinum Team; ícone conferido por `check-app-icon.swift`.

## Fase 4: Android

| Tarefa | Tamanho | Depende | Documento |
| --- | --- | --- | --- |
| 4.1 Módulo Kotlin do `cialai-tunnel` consumindo o `.aar`; `mobile-artifacts.yml` gerando o AAR | M | 3.2 | 05 |
| 4.2 Plugin de configuração do `network_security_config.xml` só para `127.0.0.1`; `expo-build-properties` com `targetSdk` 36; `softwareKeyboardLayoutMode resize`; `allowBackup` desligado; permissões `CAMERA`, `USE_BIOMETRIC` | P | 4.1 | 05 |
| 4.3 Botão voltar por `BackHandler` e mensagem `navigate-back` na página | P | 3.6 | 05 |
| 4.4 Ciclo de segundo plano: 2 minutos e `Stop`, `StartProfile` e `OpenDesktop` ao voltar com tela de reconexão | P | 4.1 | 05 |
| 4.5 Biometria e Secure Store conferidos no Android | P | 4.1 | 05 |
| 4.6 `android-play` no `codemagic.yaml`, app no Play, conta de serviço, grupos `android_credentials` e `google_play`, faixa interna | M | 4.2 | 10 |
| 4.7 Roteiros manuais num Android real | M | 4.4 | 06 |
| 4.8 Relatório de pré-lançamento do Play sem aviso de texto claro além do loopback | P | 4.6 | 05 |

Aceite: roteiros aprovados no Android; build na faixa interna; relatório limpo.

## Fase 5: Linux e Windows

Objetivo: o desktop com paridade de comportamento nos dois sistemas, com as diferenças documentadas, testes por sistema e instaladores. Caminho crítico: 5.1, depois 5.2 e 5.3 em raias, depois 5.15, 5.16 e 5.17.

| Tarefa | Tamanho | Depende | Raia | Documento |
| --- | --- | --- | --- | --- |
| 5.1 `procs/` dividido com a trait `ProcSource` e `FakeProcs` testando `metrics` | M | 1.4 | | 04 |
| 5.2 `procs/linux.rs` sobre `sysinfo` com filhos, parado e arquivos abertos por `/proc` | M | 5.1 | A | 04 |
| 5.3 `procs/windows.rs` sobre `sysinfo`, `platform/win_job.rs`, heurística de primeiro plano | G | 5.1 | B | 04 |
| 5.4 `pty/` extraído: shell por sistema, kill em dois passos no Windows, testes com `TestShell` | M | 1.4 | A e B | 04 |
| 5.5 `resume.rs` por sabor de shell e reserva do Codex por cwd e mtime; `files.js::shellQuote(flavor)` | M | 1.4 | A | 04 |
| 5.6 `watch/` com backend `notify` e o coalescedor compartilhado | M | 1.2 | A | 04 |
| 5.7 `files.rs`: `trash`, tabela de sujeira, barras normais, links só Unix | P | 1.4 | A | 04 |
| 5.8 `preview.rs` com a forma do Windows, `native.js::previewUrl`, `dunce` | P | 1.4 | B | 04 |
| 5.9 `browser.rs` e `office.rs`: tabelas de descoberta, instalador por sistema, `CREATE_NO_WINDOW`, `allowed_origin` | M | 1.4 | B | 04 |
| 5.10 `diagnostics.rs` por sistema, `mobile_files` sob `cfg(unix)`, hook da linha de estado em `.sh` e `.ps1` | P | 1.4 | A | 04 |
| 5.11 Janela: arquivos de configuração por sistema, `window/windows.rs` com `SetWindowPos` e Mica, `window/generic.rs` para X11 e Wayland, controles próprios no Windows, guarda do Escape só no macOS | M | 1.3 | C | 04 |
| 5.12 `lib/keys.js` e reescrita dos atalhos no Workbench, painéis, paleta e toolbar; instalador de atalhos no DOM fora do macOS; Ctrl Shift C e V | M | 1.3 | C | 04 |
| 5.13 CSS: `shell.css` e `platform.css`, fontes por sistema, `.mac-switch`, JetBrains Mono empacotada | M | 1.3 | C | 04, 08 |
| 5.14 Preferências com Terminal por sistema e Janela no Windows | P | 1.8, 5.11 | C | 04 |
| 5.15 Testes: `TestShell` e `TestChild`, variantes por sistema, `tools/browser/run-browser-checks.mjs` por Playwright | M | 5.2 a 5.9 | | 09 |
| 5.16 `ci.yml` com a matriz completa, artefatos, `release.yml` com `tauri-action` | M | 5.15 | | 10 |
| 5.17 Assinatura Developer ID e notarização, Authenticode, deb, rpm e AppImage em Ubuntu 22.04 | M | 5.16, 0.10 | | 10 |
| 5.18 `selftest-app.js` por `tauri-driver` no Linux e no Windows em `nightly-e2e.yml` | M | 5.15 | | 09 |
| 5.19 Documento de diferenças por plataforma, README por sistema | P | 5.15 | | 04 |

Aceite: `cargo test` verde nos três sistemas; self test verde nos três; instalação limpa até celular pareado em cada sistema em até 3 minutos; matriz manual de IME com fcitx5, ibus e IME do Windows registrada.

## Fase 6: estúdio completo em todas as plataformas

| Tarefa | Tamanho | Depende | Documento |
| --- | --- | --- | --- |
| 6.1 Dev Browser validado no Linux e no Windows, incluindo a instalação automática do Chromium | M | 5.9 | 04 |
| 6.2 Prévias de Office com LibreOffice nos três sistemas | P | 5.9 | 04 |
| 6.3 Uso do plano dos agentes nos três sistemas com o hook instalado por `.sh` e `.ps1` | M | 5.10 | 04 |
| 6.4 `mobile_files` no Windows com `FILE_FLAG_OPEN_REPARSE_POINT` | M | 5.3 | 04 |
| 6.5 Arraste para fora no Windows por OLE `DoDragDrop` com `CF_HDROP` e no Linux por `gtk_drag_begin`; opcional | G | 5.11 | 04 |
| 6.6 Interface em três idiomas: português do Brasil como padrão e fallback, inglês e espanhol neutro | M | 1.3 | 08 |
| 6.7 Renomear `--mac-*` para `--ui-*`; opcional | P | 5.13 | 04 |
| 6.8 Documentos desta pasta reescritos como documentação viva do que existe | P | tudo | 09 |

Aceite: os cinco estados da demo, editor, explorador, Git, prévias, Dev Browser e uso do plano conferidos nos três sistemas; celular acompanhando cada um.

## Fase 7: lançamento

| Tarefa | Tamanho | Depende | Documento |
| --- | --- | --- | --- |
| 7.1 `tauri-plugin-updater` com chave própria e `latest.json` nas releases | M | 5.17 | 10 |
| 7.2 README público em inglês com capturas, CONTRIBUTING, SECURITY, modelos | M | 6.8 | 09 |
| 7.3 Política de privacidade publicada, questionário da App Store, Data safety, capturas por tamanho, textos em inglês e português | M | 3, 4 | 10 |
| 7.4 Submissão à App Store com notas de revisão, desktop de demonstração e vídeo; Play em produção | M | 7.3 | 10 |
| 7.5 Release `v1.0.0` do desktop pelos seis instaladores, sidecars e artefatos móveis | M | 7.1 | 10 |
| 7.6 Anúncio e página do projeto; opcional | P | 7.5 | |

Aceite: lista de verificação de release do documento 10 cumprida; os critérios de sucesso do documento 01 medidos e registrados.

## Dependências entre fases

```
0 ─► 1 ─► 2 ─► 3 ─► 4
     │    │
     │    └────────► 5 ─► 6 ─► 7
     └─────────────► 5
```

A Fase 5 pode começar assim que a Fase 1 fecha, em paralelo com a Fase 2; as Fases 3 e 4 dependem da 2; a Fase 6 depende da 5 e a 7 de todas.

## Riscos por fase

| Fase | Risco principal | Sinal de alerta | Resposta |
| --- | --- | --- | --- |
| 0 | Spike 1 ou 6 falha | Go inviável no iOS ou Apple exigindo NetworkExtension | Plano B do documento 06; sidecar mantido; decisão registrada |
| 1 | Extração deixa dependências escondidas do Control | Testes de `check-terminal-sync` ou self test quebrando por módulo ausente | Tabela de extração do documento 04 como lista de conferência; nada de reescrita, só mover |
| 2 | Caminhos da API do Headscale diferentes dos previstos | Erros `control_protocol` na integração | Conferir no `/swagger` do 0.29.3 e ajustar o cliente, não o desenho |
| 3 | Revisão da Apple | Rejeição citando VPN | Texto e notas; ensaio externo; plano B |
| 4 | Texto claro e ciclo de vida do Android | Aviso no pré-lançamento; reconexão lenta | Plugin de segurança de rede; ajuste dos 2 minutos |
| 5 | ConPTY e leitura de processos no Windows | Histórico embaralhado; cards sem agente | Replay na largura atual; reserva por cwd e mtime |
| 6 | Dev Browser e LibreOffice em ambientes variados | Instalação do Chromium falhando | Instruções manuais na aba, como hoje |
| 7 | Certificados e prazos das lojas | Notarização recusada; revisão longa | Orçar na Fase 0; ensaio na Fase 3 |
