# Progresso e passagem de contexto

Atualizado em 12/09/2026. Este é o ponto de entrada para continuar a execução. O escopo e as dependências permanecem em [11-roadmap-de-execucao.md](./11-roadmap-de-execucao.md).

## Regras de continuidade

1. Ler este arquivo antes de executar e atualizar após cada entrega ou impedimento encontrado.
2. Registrar comandos e resultados reais. Não confundir scaffold, código implementado, teste local e aceite de fase.
3. Preservar o working tree do Control. Ele é fonte somente leitura.
4. Não marcar spikes de aparelho, soak ou loja como aprovados por testes unitários.
5. Não iniciar a Fase 1 enquanto o aceite da Fase 0 estiver pendente, salvo mudança expressa de escopo pelo usuário.

## Estado atual

Execução em andamento. A implementação local e os critérios automatizáveis da Fase 1 estão concluídos no macOS; o aceite humano de paridade permanece pendente. A Fase 0 ainda depende de infraestrutura e aparelhos externos.

| Tarefa | Estado | Evidência e próximo passo |
| --- | --- | --- |
| 0.1 Fundação | Base implementada e validada localmente | Git local em `main`, cinco workspaces, lockfile npm, Apache 2.0, NOTICE, guias, modelos, ignores, crate Rust e módulo Go. E-mail e prazo de segurança ainda precisam de confirmação antes da publicação |
| 0.2 Commit da origem | Pendente do usuário | Control em `c26d98bb9b6851b438918a5e10278799f4442cd7`, com os mesmos oito arquivos alterados descritos no documento 02. Nenhum arquivo da origem foi alterado nesta execução |
| 0.3 CI mínima | Implementada, execução remota pendente | `.github/workflows/ci.yml` para macOS, Linux e Windows. `npm test` passou localmente em macOS arm64. Sem remoto configurado ou push. A consulta GitHub não conseguiu resolver `OrdinumTeam/cialai-platform`, por inexistência ou falta de acesso |
| 0.4 Spike 1 | Preparação parcial | API Go experimental, interfaces Java e Objective-C geradas e script de build. Sem XCFramework, AAR ou execução em aparelhos |
| 0.6 Spike 3 | Aprovado localmente | Headscale 0.29.3 e tsnet 1.102.0; oito verificações finais passaram em 35,830 s, incluindo persistência do módulo móvel no desktop. Workflow remoto preparado |
| 0.5, 0.7 a 0.11 | Pendentes | Sem Xcode em `/Applications`, nenhum Android conectado e SDK não encontrado no caminho padrão. Ensaios móveis, loja, assinatura e soak não executados |
| 0.12 Decisões dos spikes | Atualizado parcialmente | Decisões 022 a 026 registram correções, aceite local do spike 3 e estado dos demais |
| 1.1 Scaffold desktop | Concluído localmente | Tauri real, configurações macOS, Windows e Linux, capabilities, duas entradas Vite e ícones provisórios. Build macOS sem bundle aprovado. Configurações Windows e Linux aguardam a matriz remota |
| 1.2 Extração Rust | Concluída localmente | Núcleo macOS extraído sem stack, reuniões e VPN. Clippy sem avisos, 118 testes ativos passaram, dois ensaios externos permaneceram ignorados e o binário Tauri compilou e iniciou |
| 1.3 Extração da interface | Concluída localmente | Estúdio de Terminais e cascas desktop/celular compilam; `check-terminal-sync` 17/17, demais checks UI 32/32, raiz e Tauri verdes. Checks no Chromium visível terminaram em `PASS` nas duas entradas |
| 1.4 Camada multiplataforma | Concluída localmente | Contratos Rust e JavaScript, escolha de shell, locale, prefixo de PATH e caminhos portáteis integrados ao PTY. Suítes, Chromium visível e binário Tauri aprovados no macOS; ramos nativos Windows/Linux aguardam a matriz remota |
| 1.5 Recurso web do celular | Concluída localmente | Bundle móvel isolado, validado e mapeado em `$RESOURCE/mobile`; `MobileSite` fornece o caminho absoluto ao futuro supervisor. Recurso carregou no Chromium e no bootstrap Tauri do macOS |
| 1.6 Raízes e onboarding | Concluída localmente | `projectRoots` governa a descoberta e os arquivos móveis; primeiro uso valida pasta, shell em PTY descartável e abertura da primeira sessão. Rust, UI, build e fluxo visível aprovados no macOS |
| 1.7 Marca Cialai | Implementação concluída localmente | `brand.css` substitui a identidade azul herdada pela paleta rosa, magenta e ameixa em desktop e celular; ANSI, sintaxe, estados e cores de sessão permanecem semânticos. O ícone foi recomposto do símbolo aprovado sobre branco e todos os formatos do Tauri foram regenerados. A conferência em lançadores Windows e Linux continua dependente das respectivas plataformas |
| 1.8 Preferências | Concluída localmente | Aparência, Terminal, Projetos e Dev Browser têm seções próprias, rascunho cancelável, normalização, seletores nativos e persistência do snapshot completo. Contrato Node e fluxo visível em claro e escuro aprovados |
| 1.9 Protocolo compartilhado | Concluída localmente | `@cialai/protocol` contém transporte remoto, adaptador nativo, política sensível fechada por padrão, JSON Schema e sete fixtures. Nove testes Node e um teste consumidor Rust passaram; a UI usa o pacote como fonte única |
| 1.10 Autoteste Tauri | Concluída localmente | O binário macOS executou os oito cenários reais e gravou `selftest.json` com `ok: true`; PTY, arquivos Rust, arraste, caminho, filtro, CSV, preferências e Dev Browser passaram |
| 1.11 Capturas comparativas | Concluída localmente | Desktop claro, escuro e Dev Browser e quatro telas móveis foram comparados lado a lado com o Control somente leitura. Estrutura e estados coincidem; identidade e escopo do fork são as diferenças documentadas |
| 2.1 Fundação do túnel | Concluída localmente | RPC JSON limitado, estado privado e atômico, trava por processo, logger com redação e anel e gerenciador de nó com adaptador `tsnet` estão implementados. `go vet` e `go test -race` passaram |
| 2.2 Cliente Headscale | Concluída localmente | `ControlAdmin` e `HeadscaleDirect` cobrem os treze métodos administrativos, autenticação, CA própria, relógio do servidor, retentativas e erros estáveis. Testes falsos, race detector e o Swagger real da imagem 0.29.3 passaram |
| 2.3 Pareamento e dispositivos | Concluída localmente | Codec estrito do QR, inspeção sem segredos, sessões concorrentes de uso único, bloqueio de tentativas e `devices.json` atômico com tokens somente em hash estão cobertos pelo race detector |
| 2.4 Borda do desktop | Concluída localmente | Site móvel confinado, saúde, pareamento com `WhoIs`, aprovação opcional, Bearer e subprotocolo, cabeçalhos confiáveis e limites de taxa e sockets passaram em testes com race detector |
| 2.5 Proxy móvel | Concluída localmente | Proxy preso a `127.0.0.1`, cookie de nonce, `Origin`, Bearer interno, peer resolvido por discagem, prazo renovável e rotação de token passaram em testes com race detector |
| 2.6 Sidecar executável | Concluída localmente | `serve-stdio`, `doctor` e `version` estão compilados; handshake, comandos, eventos, encerramento pelo pai, trava, log rotativo e ausência de segredos na linha de comando passaram com race detector |
| 2.7 Supervisor Rust | Concluída localmente | Processo filho, protocolo limitado, eventos Tauri, reinício, encerramento, keyring por sistema e segredo efêmero da ponte passaram em 140 testes Rust ativos e no fake sidecar real |
| 2.8 Ponte com identidade | Em andamento, parcial | `bridge/mod.rs` e `bridge/protocol.rs` já têm `BridgeControl`, identidade do dispositivo e do computador no `welcome`, exigência de `x-cialai-node-key` e fechamento por revogação com 4401. O supervisor ainda não chama essa API: Clippy com `-D warnings` falha por código não usado e por `serve` com oito argumentos, e o teste `bridge::tests::proxy_secret_marks_the_connection_as_a_device` falha porque não envia a chave do nó |
| 2.9 a 4.8 | Não iniciadas | A autorização para avançar não aprova os testes físicos, remotos, de assinatura ou de loja pendentes |
| 5.1 Fonte de processos | Concluída localmente no macOS | `procs/` separa contrato portável, backend macOS e `ProcSource`; `FakeProcs` prova as métricas sem consultar processos reais. Linux e Windows continuam apenas preparados para 5.2 e 5.3 |
| 5.2 Processos Linux | Implementada, execução Linux pendente | Backend usa `sysinfo` 0.36.1 e completa filhos, grupo, estado, PSS e arquivos abertos por `/proc`; os testes Linux serão executados no contêiner Ubuntu 22.04 da validação da fase |
| 5.3 a 7.6 | Não iniciadas | O backend Windows, a matriz remota e os testes físicos continuam pendentes |

## Ambiente observado

Diretório: `/Users/focoamorim/Github Projects/OrdinumTeam/cialai-platform`.

O diretório inicialmente não tinha Git próprio. `git rev-parse --show-toplevel` apontava para o diretório pai `OrdinumTeam`. Inicializar o Git local é a tarefa 0.1 e evita misturar alterações dos outros projetos.

| Ferramenta | Observação inicial |
| --- | --- |
| Node e npm | Node 25.6.0 e npm 11.8.0 globais, diferentes de Node 22 e npm 10 previstos |
| Rust | rustc e cargo 1.98.1 |
| Go | 1.26.3 global, documento prevê 1.24 e requer confirmação de compatibilidade com tsnet |
| Docker | Desktop disponível, Engine 29.4.2 em Linux arm64 |
| Xcode | `xcodebuild -version` falha porque o diretório ativo é CommandLineTools |
| gomobile | Não encontrado no PATH |
| Android | adb disponível, aparelhos e SDK ainda não conferidos |

## Diário

### 12/09/2026, início

Lidos o índice, visão, inventário da origem, roadmap, ferramentas, CI e especificação de rede. Confirmado que só havia README e documentos no destino. Nenhum AGENTS.md aplicável encontrado nos diretórios ancestrais. A primeira entrega será a fundação e as provas de viabilidade possíveis neste ambiente.

### 12/09/2026, fundação validada

Criados `AGENTS.md` com a regra de continuidade, Git local, manifests, lockfiles, arquivos de abertura e workflow. O pacote desktop é só uma biblioteca Rust vazia, não um aplicativo Tauri. UI, protocolo e mobile não possuem suítes de produto ainda. O script da fundação informa isso expressamente.

Comandos concluídos com código 0:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm ci
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm test
npm run check:source
```

Resultados: cinco workspaces, quinze caminhos protegidos, crate Rust com zero testes, módulo Go sem testes de produto e oito hashes da origem conferidos. Node e npm foram usados pelo cache do npm exec, sem substituir as instalações globais. Rust 1.98.1 instalado pelo rustup e Go 1.26.5 baixado automaticamente pelo Go. O `tsnet` planejado exige Go 1.26.5, decisão 022.

Docker baixou `headscale/headscale:0.29.3`, digest `sha256:0e7f1c6e4ce6c2a2a001103ecd3fa645a045adf30ac8a5234fe037b43000cd72`. Nenhum serviço existente foi alterado. O experimento cria e remove seu próprio contêiner temporário.

### 12/09/2026, spike de política e preparação móvel

O teste original de política e expiração passou após duas correções no ambiente de teste: adicionar relé DERP local e usar o IP 127.0.0.1 como hostname compatível com o certificado fixado por SHA-256. O ensaio sem relé não estabeleceu a conexão permitida. A API de expiração funcionou com `disableExpiry` na URL. A tentativa de gravar política em modo arquivo retornou HTTP 500 com mensagem de desativação; o teste confirmou que o conteúdo permaneceu igual.

Preparado o pacote experimental `spikes/mobileprobe` e o script `tools/spikes/build-mobile.mjs`. `gomobile` e `gobind` fixados em `v0.0.0-20260908204917-8b95e45f8d3e`. `go tool gobind -lang=java,objc -outdir=build/spikes/bindings ./spikes/mobileprobe` gerou as interfaces Java e Objective-C com código 0. Isso só verifica a geração das interfaces, não compila XCFramework ou AAR. A pasta gerada foi depois movida para `_bindings`, conforme a correção abaixo.

Tentativas de build móvel pararam corretamente no preflight: iOS sem Xcode completo e Android sem SDK configurado. Não há artefato móvel compilado. A integração ampliada detectou que `Up` pode terminar antes de o mapa de peers chegar. `EchoMillis` agora espera o peer dentro do mesmo prazo de dez segundos; o caso passou, incluindo reabertura sem nova chave e confirmação de que não foi criado um segundo nó.

### 12/09/2026, validação final e limites

A suíte de integração terminou com oito verificações aprovadas em 35,830 s. `go vet -tags=integration ./...` passou após isolar os arquivos gerados de gobind. `go vet` e `go test ./...` percorriam `build/spikes/bindings` apesar do `.gitignore` e tentavam compilar Objective-C sem o cabeçalho de ligação. A correção foi mover os gerados para `build/spikes/_bindings`, pois o Go ignora diretórios iniciados por sublinhado. Nas próximas gerações, use:

```sh
cd packages/tunnel-core
go tool gobind -lang=java,objc -outdir=build/spikes/_bindings ./spikes/mobileprobe
```

Após a correção dos gerados, `npm test` foi executado novamente com Node 22.23.2 e npm 10.9.8 e passou por inteiro. O crate Rust continua com zero testes de produto e o experimento móvel compila como pacote Go. As verificações de integração são executadas separadamente pelo comando do spike.

O teste de integração fecha os nós, o relé e remove o seu contêiner descartável. Confirmado que nenhum contêiner com a etiqueta do spike permaneceu em execução. Nenhum arquivo do Control foi alterado. O comando `gh repo view OrdinumTeam/cialai-platform` não resolveu o repositório com a sessão atual; isso não distingue ausência de falta de acesso.

O checkpoint local usa a mensagem `chore: inicializa fundacao e registra spikes da fase 0`. Consulte `git log -1` para obter seu hash. Não há remoto configurado nem push. Arquivos gerados em `node_modules`, `target` e `packages/tunnel-core/build` permanecem ignorados.

### 12/09/2026, início da Fase 1 autorizado

O usuário autorizou avançar para a próxima etapa mesmo com os ensaios físicos da Fase 0 pendentes. A execução iniciou a tarefa 1.1. Isso altera a ordem operacional, sem transformar preparação ou testes locais em aceite dos spikes.

Criado o aplicativo Tauri real em `apps/desktop`, com identificador `br.com.ordinum.cialai`, duas entradas HTML, Vite servindo apenas em `127.0.0.1:1420`, CSP de produção e desenvolvimento, capability da janela principal e configurações específicas dos três sistemas. macOS usa barra sobreposta e transparência; Windows usa janela sem decoração, sombra e fundo ameixa; Linux mantém as decorações e fundo opaco. Os ícones provisórios foram gerados da imagem de marca `cialai-mantis-v4-1-head.png`; o arquivo de origem tinha conteúdo JPEG apesar da extensão PNG e foi convertido de fato antes da geração.

O Vite 5.4.8 do protótipo retornou duas vulnerabilidades no `npm audit`, uma moderada e uma alta. A fundação foi atualizada para Vite 7.3.6 e plugin React 5.2.0, compatíveis com Node 22.23.2. O build preserva `target: safari16`. Depois da atualização, `npm audit --audit-level=moderate` terminou sem vulnerabilidades.

Validação da tarefa 1.1:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm test
npm exec --workspace @cialai/desktop -- tauri build --debug --no-bundle --ci
```

Ambos terminaram com código 0. O primeiro comando validou os arquivos esperados, as duas entradas Vite, as três configurações, capabilities, ícones, bundle web, Clippy e testes Rust. O segundo gerou o executável macOS de depuração em `apps/desktop/src-tauri/target/debug/cialai-desktop`. O diretório `target` é ignorado. Nenhum instalador, assinatura, notarização ou execução Windows e Linux foi produzida.

O executável gerado também foi iniciado diretamente e permaneceu ativo por mais de cinco segundos, sem erro no stderr, até a interrupção manual com Ctrl C. Esse smoke test confirma o ciclo básico do processo; a janela não foi inspecionada visualmente e o placeholder não representa o estúdio final.

### 12/09/2026, núcleo Rust da tarefa 1.2 extraído

Copiados do working tree preservado do Control os módulos `workspace/`, `bridge/`, `commands.rs`, `diagnostics.rs`, `lifecycle.rs`, `prefs.rs` e `window.rs`. `stack.rs`, `meetings/` e `vpn/` não foram copiados. O `lib.rs` agora registra somente PTYs, arquivos, Git, observação, journal e retomada, uso do plano, previews, Office, Dev Browser, preferências, janela e ponte. Na saída, Chromiums são encerrados antes dos terminais. Não há Node ou Python no processo.

Removidos do handler Tauri, do despacho remoto e dos eventos todos os comandos de stack, reuniões e VPN. A allowlist remota ficou limitada ao contrato de terminais e leituras associadas; o `welcome` anuncia apenas `capabilities: ["pty"]`. A configuração da ponte lê `CIALAI_BRIDGE_PORT`, exige o segredo efêmero do proxy antes do upgrade e só abre sem ele com `--dev-open-bridge`; o dispositivo é associado à conexão. A entrega ao sidecar, a revogação e os campos completos do `welcome` continuam na tarefa 2.8.

`prefs.rs` foi substituído pelo esquema com Aparência, Terminal, Projetos, Dev Browser, Janela e Rede. Chave da API não é persistida. Alterar as preferências atualiza o caminho do Chromium no gerenciador vivo. A integração efetiva de `projectRoots` e a escolha do shell continuam nas tarefas 1.6 e 1.4, respectivamente. Textos, identificador do `TERM_PROGRAM`, classe de arraste, log e raízes provisórias deixaram de usar a marca do Control.

A contagem de 137 casos do planejamento estava desatualizada. A origem atual declara 142 casos: 138 no `HEAD` e quatro nas mudanças preservadas. Os 28 casos de stack, reuniões e VPN não pertencem ao Cialai; o recorte elegível trouxe 114. Seis testes dos novos contratos de preferências e autenticação da ponte elevaram o crate a 120 casos compilados. Resultado real: 118 passaram, zero falharam e dois ficaram ignorados (`installs_the_real_playwright_chromium`, que baixa um Chromium, e `converts_rtf_to_pdf_with_soffice`, integração opt-in com LibreOffice). A decisão 030 substitui a contagem congelada por suíte elegível sem falhas e ignores justificados.

Validação da tarefa 1.2:

```sh
npm run check:source
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm test
npm exec --workspace @cialai/desktop -- tauri build --debug --no-bundle --ci
apps/desktop/src-tauri/target/debug/cialai-desktop
```

Os cinco primeiros comandos terminaram com código 0. O último iniciou o app, registrou `Cialai 0.1.0 iniciado` e permaneceu ativo por cinco segundos até Ctrl C. A janela não foi inspecionada visualmente e ainda contém o placeholder; isso não valida paridade da interface. Nenhum instalador, assinatura, notarização, Windows ou Linux foi testado. `tools/check/desktop-extraction.mjs` passou a impedir o retorno dos três subsistemas removidos e a conferir o novo esquema e a redução da ponte. O `ordinum-control` continuou com exatamente as oito alterações inventariadas, sem modificação desta execução.

### 12/09/2026, interface da tarefa 1.3 concluída localmente

Extraído para `packages/ui` o estúdio de Terminais com runtime, sessões, restauração, arquivos, Git, editor, previews, Dev Browser, composição desktop e composição de celular. O registry contém somente `terminais`. `DesktopApp`, `main.jsx`, menu, toolbar, paleta, preferências e `ContentArea` foram recompostos sem `AppContext`, API Node, queries, StackGate, stack, reuniões ou VPN. A allowlist JavaScript da ponte móvel ficou igual ao recorte PTY de leitura e interação aceito pelo Rust. A página do celular mostra apenas Terminais; pareamento e produto móvel continuam nas fases próprias.

As chaves novas são `cialai_terminals`, `cialai_terminals_phone`, `cialai_terminals_layout`, `cialai_terminals_phone_route`, `cialai_theme`, `cialai_sidebar`, `cialai_view` e `cialai_groups_closed`; shell e selftest usam os prefixos Cialai. Terminais, layout e tema leem uma única vez a chave `oc_*` quando a nova está vazia e então gravam a chave nova. O check estrutural `tools/check/ui-extraction.mjs` impede o retorno dos módulos removidos e confere registry, nomes e migrações.

O `check-terminal-sync.mjs` preserva 17 casos reais: os 14 casos de terminal foram portados e os três casos de VPN removidos foram substituídos por migração desktop, migração do armazenamento do celular e precedência da chave Cialai. Todos os 17 passaram. Outros 32 casos passaram para tipos de arquivo, ownership e rota do terminal no celular, renderização sem PTY, viewport do teclado, gesto/inércia e restauração. `npm test` da raiz terminou com código 0; no Rust foram 118 aprovados e os mesmos dois ensaios externos ignorados. `npm audit --audit-level=moderate` terminou sem vulnerabilidades.

O SheetJS `xlsx@0.18.5` do npm falhou na auditoria com dois avisos altos e sem correção naquele registry. Foi substituído pelo tarball oficial `xlsx@0.20.3`; `esbuild@0.21.5`, usado pelo teste isolado do runtime, também foi atualizado para 0.28.2 após a auditoria apontar o servidor de desenvolvimento antigo. A decisão 031 registra o desvio. As fixtures Office copiadas da origem foram removidas antes do commit porque continham nomes de clientes; o demo restante usa apenas dados fictícios do Cialai.

O build Tauri macOS sem bundle terminou com código 0 e gerou `apps/desktop/src-tauri/target/debug/cialai-desktop`. O executável iniciou, registrou `Cialai 0.1.0 iniciado`, cresceu a janela de 440×321 para 1380×880 em 533 ms e ficou ativo até Ctrl C. Isso verifica processo, carregamento do frontend e coreografia básica da janela, mas não substitui inspeção visual.

O roteiro `packages/ui/scripts/check-studio-browser.js` foi executado pelo Dev Browser Panel visível. O desktop em 1440×960 terminou com `PASS: Cialai desktop shell, terminal demo, palette, temporary file and sidebar`: marca Cialai, um item no registry, cinco renderizadores xterm, paleta reduzida, arquivo temporário, sidebar recolhida e restaurada e zero overflow. A entrada `mobile.html` em 393×852 terminou com `PASS: Cialai phone terminal list, single pane and responsive viewport`: abriu uma sessão em painel único, sem tabbar de produtos e sem overflow.

O primeiro ensaio visual também expôs que as URLs externas dos scripts em `index.html` e `mobile.html` eram resolvidas no bundle, mas não pelo servidor Vite: `/packages/ui/...` recebia o fallback HTML e deixava `#root` vazio. Foram criadas as entradas locais `apps/desktop/src/desktop.jsx` e `mobile.jsx`, e o check do scaffold agora protege esses caminhos. O roteiro passou a aguardar a hidratação do modo demo e a renderização React da aba temporária. Depois das correções, `npm test`, `npm audit --audit-level=moderate` e `tauri build --debug --no-bundle --ci` terminaram com código 0. As capturas foram inspecionadas em `~/.dev-browser/tmp/cialai-task-1-3-desktop.png` e `cialai-task-1-3-phone.png`; são evidência local temporária, não as capturas comparativas da tarefa 1.11.

### 12/09/2026, camada multiplataforma da tarefa 1.4 concluída localmente

Criado `platform/` no Rust com `PlatformInfo`, `ShellSpec`, `ShellFlavor`, `to_portable`, `default_lang`, `path_prefix` e composição do PATH. A preferência explícita de shell prevalece; sem ela, Unix consulta `SHELL`, a entrada do usuário e por fim `/bin/bash`, enquanto Windows procura PowerShell 7, Windows PowerShell e `COMSPEC`. Shells POSIX conhecidos recebem `-l`, PowerShell recebe `-NoLogo` e `cmd` não recebe argumento implícito. Locale e prefixo de PATH respeitam preferências; os padrões só acrescentam diretórios existentes. `PrefsState` agora é um snapshot compartilhado, portanto novos PTYs leem as preferências vivas.

O comando Tauri `app_platform` expõe sistema, home em barras portáteis, gerenciador de arquivos, separador e sabor de shell. `TerminalInfo` inclui `shellFlavor`, e o runtime conserva esse valor para cotar caminhos como POSIX, PowerShell ou cmd. `lib/platform.js` inicializa o contrato antes do React e fornece uma reserva determinística apenas para o navegador de desenvolvimento. Os helpers JavaScript aceitam barras Unix e Windows, inclusive prefixos de dispositivo e UNC. Cinco testes Rust e três testes JavaScript novos cobrem os contratos.

O `npm test` da raiz terminou com código 0: sincronização 17/17, demais testes JavaScript 35/35 e Rust 123 aprovados, zero falhas e os mesmos dois ensaios externos ignorados. `npm audit --audit-level=moderate` permaneceu sem vulnerabilidades. No Dev Browser Panel visível, desktop 1440×960 terminou em `PASS: Cialai desktop shell, terminal demo, palette, temporary file and sidebar`, com `data-platform=macos`, cinco xterms e zero overflow; celular 393×852 terminou em `PASS: Cialai phone terminal list, single pane and responsive viewport`, também sem overflow.

`tauri build --debug --no-bundle --ci` gerou novamente o executável macOS. No smoke test ele registrou o início e expandiu a janela de 440×321 para 1380×880 em 528 ms e 24 quadros, permanecendo ativo até Ctrl C. Isso verifica o bootstrap nativo e o carregamento da interface no macOS. Os ramos de descoberta de shell e PATH para Windows e Linux estão implementados, mas não foram compilados nem executados nativamente; dependem da matriz remota e não estão aceitos por esta evidência.

### 12/09/2026, recurso web do celular da tarefa 1.5 concluído localmente

O Vite ganhou um build `mobile-resource` isolado, com `mobile.html` como única entrada, gravado em `src-tauri/resources/mobile`. O check da geração exige o documento, todos os assets diretamente referenciados, pelo menos JavaScript e CSS e a ausência de `index.html`. O resultado atual tem 133 arquivos e 3,9 MiB; os arquivos gerados são ignorados e reconstruídos tanto no build normal quanto antes de `tauri dev`.

`tauri.conf.json` mapeia `resources/mobile/` para `$RESOURCE/mobile/`. O novo `tunnel::MobileSite` resolve esse diretório pelo `PathResolver` do Tauri, exige `mobile.html`, canonicaliza o caminho e é registrado como estado durante o bootstrap. Assim, o futuro supervisor poderá enviar um `staticDir` absoluto em `edge.serve`, sem tentar ler o `frontendDist` embutido. O sidecar, a borda, o proxy e o aplicativo móvel nativo continuam inexistentes nesta tarefa.

O `npm test` da raiz terminou com código 0: o check do recurso passou, o Rust compilou 127 casos, 125 passaram, zero falharam e dois ensaios externos permaneceram ignorados. `tauri build --debug --no-bundle --ci` copiou o recurso para `target/debug/mobile/mobile.html`. O executável iniciou com a validação obrigatória de `MobileSite`, cresceu a janela em 524 ms e permaneceu ativo até Ctrl C. Por fim, o próprio diretório de recurso foi servido localmente e aberto no Dev Browser Panel em 393×852: a entrada carregou seu script e três folhas de estilo, hidratou a lista com cinco sessões de demonstração e teve zero overflow horizontal. Isso aprova o artefato web local no macOS, não os spikes WKWebView/Android, pareamento, rede ou lojas.

### 12/09/2026, raízes e onboarding da tarefa 1.6 concluídos localmente

As raízes provisórias foram removidas de `workspace/repos.rs` e `workspace/mobile_files.rs`. A descoberta usa a preferência viva `projectRoots`, normaliza caminhos, expande a pasta pessoal, remove duplicatas e bloqueia travessias e links simbólicos fora das raízes. A ponte móvel lê o mesmo snapshot de `PrefsState`, portanto alterar a preferência muda a permissão sem reiniciar o aplicativo.

O primeiro uso ganhou quatro etapas: boas-vindas, escolha de pastas existentes, confirmação do shell e resumo. `detect_project_roots` somente confere as candidatas documentadas; `app_shell` expõe o shell efetivo; `shell_probe` abre um PTY descartável na pasta selecionada e o encerra depois da leitura inicial. Ao concluir, o frontend grava as preferências, registra a conclusão local e abre a primeira sessão na raiz principal. O modo de navegador `?onboarding=1` permite repetir o fluxo sem alterar a regra do primeiro uso.

O check `tools/check/onboarding.mjs` passou, assim como os testes Rust de raízes e arquivos móveis. No Dev Browser Panel, as quatro etapas foram percorridas em 1440 por 960 nos modos claro e escuro, sem overflow. O ensaio de shell do navegador é uma demonstração; a criação real do PTY também foi exercitada posteriormente pelo autoteste Tauri da tarefa 1.10.

### 12/09/2026, identidade cromática Cialai aplicada à tarefa 1.7

Criado `packages/ui/src/desktop/brand.css` como camada final de identidade para as entradas desktop e celular. Os tokens herdados de marca agora usam magenta `#E23B84`, rosa quente `#FF7AB2`, rosa claro `#FFD6E6`, ameixa `#3A1B33` e branco. A sidebar clara vai de rosa claro a branco, com texto ameixa; a escura vai de ameixa ao canvas escuro. Botões, foco, seleção, progresso e destaques usam a mesma família rosa. A camada preserva azuis somente quando eles representam informação, sintaxe, ANSI ou uma escolha de cor da sessão.

`theme.macos.js` usa o acento Cialai nos controles MUI e mantém azul no papel semântico de informação. `terminals/theme.js` fixa `blue` e `brightBlue` nos valores ANSI documentados, sem derivá-los do acento. Marcações do editor seguem o magenta. Sidebar, splash e onboarding passaram a consumir diretamente o símbolo transparente aprovado em `brand/logo/cialai-mantis-v4-1-head-4k.png`; isso eliminou o quadrado opaco da imagem provisória no modo escuro.

O desenvolvimento seguiu vermelho e verde. `check-brand.mjs` falhou primeiro porque os controles ainda eram azuis e o ANSI seguia o acento; depois passou nos dois contratos. O check visível ganhou conferência do acento renderizado, do gradiente da sidebar e da transparência do símbolo. Ele terminou em `PASS` no desktop claro, desktop escuro e celular claro. As capturas finais do onboarding foram inspecionadas em `~/.dev-browser/tmp/cialai-brand-final-onboarding-light.png` e `cialai-brand-final-onboarding-dark.png`.

Com Node 22.23.2 e npm 10.9.8, `npm test` terminou com código 0. A sincronização manteve 17 casos aprovados; os demais testes Node somaram 37 aprovados, incluindo os dois contratos novos de marca. O Rust compilou 130 casos: 128 passaram, zero falharam e os mesmos dois ensaios externos ficaram ignorados. O build Vite das duas entradas e o recurso móvel também terminaram com código 0. O aviso existente de chunks acima de 500 kB permanece informativo.

### 12/09/2026, ícone aprovado conclui a implementação da tarefa 1.7

O símbolo transparente aprovado em `brand/logo/cialai-mantis-v4-1-head-4k.png` foi composto sem reinterpretação sobre fundo branco opaco em `apps/desktop/design/app-icon-1024.png`. O script `icon` do desktop agora usa essa fonte e o Tauri regenerou ICNS, ICO, PNG, tamanhos Appx e os conjuntos iOS e Android. `tools/check/desktop-icon.mjs` falhou primeiro sem a nova fonte e depois aprovou dimensão, ausência de alfa, fundo branco e presença das famílias rosa e ameixa. A fonte e o PNG de 32 px foram inspecionados diretamente. A aparência no Dock, barra de tarefas e lançadores dos outros sistemas ainda exige execução nas plataformas correspondentes.

### 12/09/2026, Preferências da tarefa 1.8 concluídas localmente

`Preferences.jsx` deixou de agrupar tudo em Terminal e agora apresenta as quatro áreas do roadmap. O formulário trabalha sobre um rascunho único: Cancelar restaura inclusive a prévia do tema e Salvar envia o snapshot completo ao Rust. Terminal expõe shell, argumentos, idioma e prefixos do PATH; Projetos usa o seletor nativo para incluir raízes e impede a remoção da última; Dev Browser aceita digitação, seletor nativo de arquivo e volta à descoberta automática. `preferences-model.js` normaliza opcionais, espaços, duplicatas e campos antigos sem mutar o valor carregado.

O novo contrato começou falhando pela ausência do modelo e terminou em `PASS`. `npm run test:ui` aprovou os 17 casos de sincronização e 38 testes Node no total. No Dev Browser Panel da sessão do projeto, a janela de 1380 por 880 mostrou Aparência, Terminal, Projetos e Dev Browser nos temas claro e escuro; não houve texto usando os separadores proibidos. Alterar o tema habilitou Salvar e Cancelar restaurou tema e armazenamento. Capturas em `~/.dev-browser/tmp/cialai-task-1-8-preferences-light.png` e `cialai-task-1-8-preferences-dark.png`.

### 12/09/2026, pacote de protocolo da tarefa 1.9 concluído localmente

`packages/protocol` agora é a fonte do cliente WebSocket, do adaptador que unifica Tauri e remoto e da política de comandos sensíveis. A UI mantém entradas finas de compatibilidade e importa o workspace. O handshake envia `cialai-ios`, versão e versão do app; o estado retém autenticação, dispositivo e computador; chamadas em andamento falham e nunca são repetidas; 4401 vira removido e 4426 incompatível, ambos sem reconexão. A URL padrão vem do host servido e loopback só conecta com endereço explícito.

O JSON Schema de versão 1 cobre hello, welcome, call, resultados, evento e canal. Sete fixtures fictícias, sem dados reais, representam todos os quadros de texto. O ciclo vermelho começou com os três módulos e o esquema ausentes. Depois, `npm run test:protocol` aprovou nove casos sobre esquema, framing, canais binários, reconexão, revogação, incompatibilidade, delegação nativa e autorização. `npm run test:ui` manteve 38 casos verdes e o build Vite das duas entradas terminou com código 0. O teste Rust `bridge::protocol::tests::shared_json_fixtures_match_the_rust_wire_types` leu diretamente as fixtures de hello e call e passou.

### 12/09/2026, autoteste Tauri da tarefa 1.10 concluído localmente

Criado `tools/selftest/selftest-app.js`, carregado somente quando a URL contém `cialai_selftest=1`. A configuração `tauri.selftest.conf.json` inicia esse modo pelo `tauri dev`; `app_selftest_paths` fornece uma raiz exclusiva no cache do aplicativo e o destino do relatório nos logs do Cialai. O roteiro não usa projetos do usuário e remove a sessão que abriu ao terminar.

`npm run test:selftest` compilou e abriu o binário macOS real. O relatório terminou com `ok: true` em 3,101 s e aprovou os oito itens: PTY real, arquivos pela ponte Rust, arraste entre pastas, inserção de caminho no terminal, filtro de metadados do sistema, editor de CSV, preferências e shell e Dev Browser. O Chromium respondeu em uma porta efêmera. O runner encerrou seu grupo de processos depois de ler o relatório.

O contrato estrutural `tools/check/selftest.mjs`, o teste Rust do isolamento dos caminhos e o build Vite com o chunk dinâmico do autoteste também passaram. Essa evidência cobre a execução macOS local da tarefa 1.10; não representa Linux, Windows, aparelho móvel, assinatura ou CI remota.

### 12/09/2026, capturas comparativas da tarefa 1.11 concluídas localmente

Gerados pares do Control e do Cialai para desktop claro, desktop escuro e Dev Browser em 1380 por 880, além de lista, terminal e arquivos em 393 por 852 e prévia em 852 por 393. O índice e os catorze PNGs estão em `docs/evidence/task-1.11`. A inspeção lado a lado confirmou a mesma geometria e os mesmos estados do estúdio. As diferenças são a identidade azul ou rosa, nomes fictícios, terminologia multiplataforma e a ausência intencional dos produtos retirados do fork.

O Control foi servido de sua árvore existente com cache Vite em `/tmp` e bootstrap vazio em memória. Nenhum backend ou dado real foi usado. Depois das capturas, `npm run check:source` confirmou novamente o commit `c26d98bb9b6851b438918a5e10278799f4442cd7` e exatamente os oito arquivos modificados já inventariados na origem.

A fixture móvel equivalente foi adicionada ao Cialai. `npm run test:visual:phone --workspace @cialai/ui` aprovou lista, terminal, arquivos, prévia e retorno, sem overflow e com o acento escuro `#FF7AB2`. O roteiro correspondente do Control também passou os cinco estados. A suíte completa, executada com Node 22.23.2 e npm 10.9.8, terminou com código 0: sincronização 17 de 17, demais testes Node 38 de 38, protocolo 9 de 9 e Rust 130 aprovados, zero falhas e dois ensaios externos ignorados. `npm audit --audit-level=moderate` encontrou zero vulnerabilidades e `git diff --check` passou.

Com isso, todas as tarefas da Fase 1 têm implementação e evidência local no macOS. O critério subjetivo de um usuário do Control não perceber diferença de comportamento exige aceite humano e não foi convertido em aprovação automática.

### 12/09/2026, fundação do túnel da tarefa 2.1 concluída localmente

O módulo Go deixou de ser apenas uma reserva. `internal/rpc` implementa requisições estritas, respostas, eventos RFC 3339, escrita concorrente por linha e teto de 256 KiB. `internal/statedir` cria caminhos privados, impede escrita fora da raiz, troca arquivos atomicamente e usa PID mais nonce para não liberar a trava de outro processo. `internal/logx` escreve JSON, mantém o anel limitado e redige campos sensíveis, chaves Headscale e Tailscale, chaves de nó, tokens de dispositivo e payloads de QR. `internal/node` controla subir, consultar, reconectar e encerrar um nó, indexa peers pela chave e delega a uma implementação real de `tsnet` 1.102.0.

Os testes foram escritos antes da implementação e falharam pela ausência dos quatro pacotes. Depois da implementação, dois casos de segurança adicionais também começaram vermelhos e comprovaram a correção: HTTP fora de loopback passou a ser recusado e `cdt1` ou `CIALAI1` deixaram de aparecer em logs. `go vet ./...` e `go test -race -mod=readonly ./...` terminaram com código 0. Isso valida contratos locais e concorrência; nenhum nó de produção ou aparelho foi conectado nesta tarefa.

### 12/09/2026, cliente Headscale da tarefa 2.2 concluído localmente

`internal/control` agora define a fronteira administrativa e erros com códigos estáveis. `internal/headscale` implementa saúde e descoberta de versão, usuários, chaves de pré-autenticação, nós e rotação de chave da API contra a REST 0.29. O cliente exige HTTPS fora de loopback, aceita uma CA adicional, usa Bearer, limita respostas a 1 MiB, respeita o prazo HTTP de 15 s, conserva a diferença do cabeçalho `Date` e retenta falhas transitórias em 1, 2 e 4 s. O assistente passa a recusar versões anteriores a 0.29.

Os testes começaram vermelhos para o pacote ausente e, depois, para a descoberta e validação da versão. A suíte contra `httptest` conferiu métodos, caminhos, query, corpos, autenticação, uint64 em string, datas, fallback de saúde, erros sem vazamento de corpo, TLS, relógio e retentativas. `go vet ./...` e `go test -race -mod=readonly ./...` passaram.

A imagem local fixada `headscale/headscale:0.29.3`, digest `sha256:0e7f1c6e4ce6c2a2a001103ecd3fa645a045adf30ac8a5234fe037b43000cd72`, foi iniciada isoladamente. O teste novo leu `/swagger/v1/openapiv2.json` e comprovou todos os endpoints usados pelo cliente; `/version` devolveu `v0.29.3`. O spike completo continuou verde em 35,04 s. A documentação corrente do Headscale já aponta para a API nova em `/api/v1/docs`, portanto esta evidência fica deliberadamente presa à versão 0.29.3 da v1.

### 12/09/2026, pareamento e registro da tarefa 2.3 concluídos localmente

`internal/pairing` implementa o quadro `CIALAI1` com base64url sem padding e decodificação JSON estrita. Versão, URL segura, usuário, chave opcional, ids, nome do computador, chave do nó, IPv4, porta, segredo de 32 bytes, validade, campos desconhecidos e teto de 700 bytes são validados. A inspeção destinada ao aplicativo móvel informa somente metadados e nunca devolve a chave de entrada nem o segredo.

As sessões geram segredo e id com entropia criptográfica, expiram pelo relógio injetado, separam verificação de consumo para permitir `WhoIs` e aprovação, aceitam exatamente um consumidor concorrente e bloqueiam o `pairId` depois de dez segredos errados. O registro `devices.json` usa a escrita atômica e privada de `statedir`, mantém apenas SHA 256 dos tokens, reaproveita o id ao parear novamente a mesma chave de nó, invalida o token anterior imediatamente nesse fluxo, conserva 24 horas de sobreposição na rotação regular, agenda rotação em 30 dias e remove revogados depois de 30 dias.

Os testes começaram vermelhos com o pacote ausente. Depois da implementação, `go vet ./...` e `go test -race -mod=readonly ./...` terminaram com código 0, incluindo consumo simultâneo por vinte goroutines, corrupção de estado, persistência, reabertura, revogação e janelas dos hashes. Esta tarefa não pareou um aparelho real.

### 12/09/2026, borda do desktop da tarefa 2.4 concluída localmente

`internal/edge` serve `mobile.html` e os assets somente dentro da raiz real, recusa dotfiles, travessia, barras invertidas, bytes nulos, diretórios e links simbólicos externos, aplica a CSP prevista, `nosniff`, `no-store` no documento e cache imutável nos assets. `/api/health` identifica o serviço e o desktop sem dados sensíveis.

`POST /pair` tem corpo limitado e JSON estrito, cinco tentativas por minuto por IP, bloqueio próprio da sessão, `WhoIs` obrigatório para chave do nó e usuário, aprovação opcional com prazo de um minuto, consumo atômico, persistência do dispositivo e expiração assíncrona da chave de entrada. Upgrades aceitam Bearer ou o subprotocolo do plano B, removem credenciais e qualquer `X-Cialai-*` externo e injetam somente os três cabeçalhos confiáveis antes da ponte em loopback. São permitidos dois sockets por dispositivo e oito no total; conexões reais ficam rastreáveis para revogação. Um upgrade bem sucedido também entrega a rotação de trinta dias em `X-Cialai-Token-Next`, com a janela anterior de 24 horas.

O adaptador `tsnet` ganhou `WhoIs` e prefere o IPv4 do nó identificado. Os testes começaram vermelhos com o pacote de borda ausente. `go vet ./...`, `go test -race -mod=readonly ./...` e `git diff --check` passaram. Os testes cobrem o site, o link simbólico de fuga, saúde, pareamento, expiração, replay, limite de taxa, identidade divergente, cabeçalhos da ponte, token ausente, rotação e limites de sockets. O proxy de loopback do celular e o eco WebSocket de integração pertencem às tarefas 2.5 e 2.11.

### 12/09/2026, proxy móvel da tarefa 2.5 concluído localmente

`internal/proxy` abre somente em `127.0.0.1`, tenta a porta preferida e a faixa 47400 a 47409 antes de usar uma porta efêmera com aviso. Cada abertura gera um nonce de 32 bytes; a primeira URL o troca uma única vez por `cialai_k` com `HttpOnly`, `SameSite=Strict` e caminho raiz. Requisições seguintes sem o cookie recebem 403. O valor da query, o cookie, `Authorization` e cabeçalhos `X-Cialai-*` locais nunca atravessam o túnel.

O transporte resolve o peer novamente por chave de nó a cada discagem, prefere IPv4, reescreve o host para `cialai-desktop`, injeta o Bearer atual e renova um prazo de leitura de 60 s em toda leitura. Upgrades aceitam `Origin` ausente ou exatamente igual à origem do proxy. `X-Cialai-Token-Next` é validado, entregue ao armazenamento nativo por callback e removido da resposta antes de a página vê lo; `Set-Cookie` remoto também é descartado para proteger o cookie local.

Os testes começaram vermelhos com o pacote ausente. `go vet ./...`, `go test -race -mod=readonly ./...` e `git diff --check` passaram. Foram cobertos o consumo único do nonce, cookie, 403, injeção e remoção de credenciais, nova resolução de IP, `Origin`, rotação, renovação do prazo e vínculo real de um listener IPv4 de loopback. O teste integrado com WebSocket e 1 MiB continua reservado a 2.11.

### 12/09/2026, executável e protocolo stdio da tarefa 2.6 concluídos localmente

`cmd/cialai-tunnel` fornece `serve-stdio`, `doctor` e `version`. O processo exige diretório de estado absoluto, pai vivo e trava exclusiva, mantém log JSON privado com cinco rotações de 2 MiB e encerra quando o pai desaparece. Nenhuma chave, token ou segredo é aceito pela linha de comando. O protocolo envia o evento inicial, exige `hello` em até cinco segundos, rejeita ids repetidos, permite respostas fora de ordem e cancela operações em andamento durante `shutdown`.

`internal/sidecar` compõe os comandos documentados de controle, nó, borda, pareamento e dispositivos. `forceLogin` usa a API local do `tsnet` sem variável de ambiente global e sem apagar estado. A rotação solicitada de token é entregue no próximo upgrade autenticado; logout, renomeação, revogação local e também na rede e fila de aprovação com código de quatro dígitos estão ligados. O log passou a recusar links simbólicos e confirma o arquivo aberto antes de alterar permissões.

Os testes começaram vermelhos para `forceLogin`, link simbólico e cancelamento de chamada pendente. `go vet ./...`, `go test -race -mod=readonly ./...`, `go mod tidy -diff` e `git diff --check` terminaram com código 0. `CGO_ENABLED=0 go build -trimpath ./cmd/cialai-tunnel`, o binário real `version` e `doctor` também passaram. Foi necessário executar `cargo clean` no `target` gerado do Tauri, removendo 11,7 GiB recompiláveis depois que o primeiro build Go parou por falta de espaço. Nenhum código-fonte nem arquivo do Control foi removido ou alterado.

### 12/09/2026, supervisor Rust da tarefa 2.7 concluído localmente

`tunnel/supervisor.rs` inicia o sidecar ao primeiro comando, valida binário absoluto e regular, negocia o `hello` em cinco segundos e limita chamadas a trinta segundos. Respostas podem chegar fora de ordem, quadros acima de 256 KiB ou inválidos encerram o processo, operações pendentes falham juntas numa queda e o reinício usa 1, 2, 4, 8, 16 e depois 30 segundos, com dez tentativas no máximo. A saída do app envia `shutdown`, espera até cinco segundos e então mata apenas o filho se necessário. Eventos do sidecar chegam ao webview em `tunnel://state`, `tunnel://pair` e `tunnel://devices`.

A chave da API fica no `keyring` 3.6.3 com Keychain, Secret Service ou Credential Manager e não entra nas preferências. O fallback Linux é um arquivo privado `0600`, com evento de aviso; status expõe só presença e prefixo. Configuração e rotação usam comandos Tauri dedicados, retiram a nova chave antes de responder ao JavaScript e tentam expirar o prefixo antigo. A chamada genérica recusa chaves de API e de entrada. O supervisor substitui qualquer `staticDir`, `bridgeUrl` ou `proxySecret` enviado pela página e usa caminho validado, loopback e um segredo aleatório novo de 256 bits em cada abertura do app. A ponte agora reserva a porta antes da tarefa assíncrona para que a borda receba um endpoint realmente aberto.

O sidecar também passou a criar uma chave de entrada descartável de dez minutos quando `node.up` não recebe uma. Isso fecha o primeiro cadastro do desktop sem expor o segredo ao JavaScript; a chave é expirada após a tentativa. Os novos testes começaram vermelhos para protocolo ausente, armazenamento privado, chamada pendente, injeção da borda e chave de entrada ausente. `cargo test --locked` aprovou 140 testes, com dois ensaios externos ignorados; `cargo clippy --locked --all-targets -- -D warnings`, `go vet ./...`, `go test -race -mod=readonly ./...`, `go mod tidy -diff`, `git diff --check` e `npm run check:source` passaram. O fake sidecar foi executado como processo real no teste do supervisor. Nenhum servidor ou aparelho real foi usado.

### 12/09/2026, checkpoint em commits e estado parcial da 2.8

O trabalho de 1.6 a 2.7 estava todo fora de commit. Foi gravado no `main` local em um commit por tarefa, na ordem 1.7, 1.6, 1.8, 1.9, 1.10, 1.11 e 2.1 a 2.7; consulte `git log`. A marca veio antes do onboarding porque `Onboarding.jsx` importa o símbolo de `brand/logo`. Arquivos tocados por várias tarefas foram divididos por trecho, e cada commit intermediário teve o conteúdo conferido por marcadores. Só a árvore final foi compilada e testada. O commit da 2.7 inclui o início da 2.8 descrito na tabela, porque `lib.rs` depende do novo retorno de `bridge::start`.

O binário `packages/tunnel-core/cialai-tunnel`, de 30 MiB, gerado por `go build ./cmd/cialai-tunnel`, estava fora do `.gitignore` e passou a ser ignorado. O check `tools/check/desktop-extraction.mjs` exigia o texto literal `app.manage(mobile_site)` e parava o `npm test` antes do Rust e do Go; agora aceita o `clone()` da 2.7 e confere que o supervisor recebe o `mobile_site`.

Resultado real depois da correção, com Node 22.23.2 e npm 10.9.8: fundação, UI 17 e 38, protocolo 9, scaffold, ícone, extração, onboarding, autoteste estrutural, build Vite e recurso móvel passaram. `cargo clippy -D warnings` falhou pelos avisos da 2.8 parcial. `cargo test --locked` terminou com 140 aprovados, 1 falha e 2 ignorados. `go vet ./...` e `go test -race -mod=readonly ./...` passaram nos dez pacotes com testes. Não houve push.

### 12/09/2026, fonte de processos da tarefa 5.1

`workspace/procs.rs` foi dividido em `procs/mod.rs` e `procs/macos.rs`. O contrato portável usa `ProcInfo`, `ProcState`, `Usage`, `ProcSource` e `SystemProcs`; a política de limites da árvore e a identificação de agentes ficaram compartilhadas. `TerminalManager::metrics` usa a trait e o diretório pessoal já resolvido pelo Tauri. `FakeProcs` cobre árvore, duas amostras de CPU, memória, cwd e perfil do agente sem depender da tabela de processos real.

Com `CARGO_TARGET_DIR=~/.cache/cialai-target`, os testes direcionados `workspace::procs::tests::detects_agents_on_posix_and_windows_command_lines` e `workspace::terminal::tests::metrics_use_the_injected_process_source` passaram, um caso em cada execução. `cargo fmt --check` e `git diff --check` passaram. `cargo clippy --locked --all-targets -- -D warnings` chegou ao crate e falhou somente nos seis diagnósticos já registrados de `bridge/` da tarefa 2.8 parcial; não houve aviso fora de `bridge/`. Os arquivos Linux e Windows ainda são stubs declarados e não contam como backend implementado.

### 12/09/2026, backend de processos Linux da tarefa 5.2

O stub Linux foi substituído por um snapshot compartilhado de `sysinfo` 0.36.1. `/proc/<pid>/task/*/children` fornece filhos quando legível, com fallback para o mapa de pais do snapshot; `/proc/<pid>/stat` preserva grupo e estados `T` e `t`; `smaps_rollup` fornece PSS com fallback para RSS; `cwd`, argv, ambiente permitido, executável e tempo acumulado de CPU vêm do mesmo snapshot; e `fd/*` fornece os arquivos abertos. O nome prefere o basename do executável ao `comm` truncado.

No macOS, `cargo test --locked --lib workspace::procs` passou 10 casos e o teste de métricas com `FakeProcs` passou isoladamente. O Clippy com `-D warnings` voltou a apontar somente os seis diagnósticos conhecidos de `bridge/`, sem aviso no código da Fase 5. A execução real do backend e dos três testes condicionais a Linux foi deliberadamente deixada pendente para o contêiner Ubuntu 22.04 exigido na validação; até lá a tarefa está implementada, não verificada no Linux.

## Arquivos para retomar

| Arquivo | Uso |
| --- | --- |
| `package.json`, `tools/run.mjs` | Comandos reais existentes nesta etapa, incluindo build do scaffold desktop |
| `apps/desktop/vite.config.js` | Build das entradas desktop e celular |
| `apps/desktop/src-tauri/tauri*.conf.json` | Configuração comum e diferenças por sistema |
| `tools/check/desktop-scaffold.mjs` | Validação rápida das três configurações e arquivos esperados |
| `tools/check/desktop-extraction.mjs` | Guarda da extração Rust, produtos removidos, preferências e ponte PTY |
| `apps/desktop/src-tauri/src/lib.rs`, `commands.rs`, `prefs.rs` | Composição do núcleo extraído e comandos locais |
| `apps/desktop/src-tauri/src/platform/mod.rs` | Contratos de sistema, shell, locale e PATH da tarefa 1.4 |
| `apps/desktop/src-tauri/src/tunnel/mod.rs` | `MobileSite`, caminho absoluto que o futuro supervisor usará como `staticDir` |
| `apps/desktop/src-tauri/resources/README.md` | Origem e regra do bundle móvel gerado e não versionado |
| `apps/desktop/src-tauri/src/workspace/`, `bridge/` | Estúdio nativo e transporte remoto reduzido |
| `packages/ui/src/lib/platform.js`, `terminals/files.js` | Snapshot da plataforma e caminhos/cotação de shell no frontend |
| `packages/ui/src/terminals/`, `views/Terminais.jsx` | Runtime e interface extraídos do estúdio |
| `packages/ui/src/desktop/`, `mobile/` | Composições Cialai para as duas entradas Vite |
| `packages/ui/src/desktop/brand.css`, `brand/` | Paleta aplicada e fonte canônica dos símbolos da marca Cialai |
| `packages/ui/scripts/check-brand.mjs` | Contratos de cor dos controles e separação do azul ANSI |
| `packages/ui/src/desktop/Preferences.jsx`, `preferences-model.js` | Quatro áreas de preferências, rascunho e normalização da tarefa 1.8 |
| `packages/ui/scripts/check-preferences.mjs` | Contrato de campos, seletores e snapshot normalizado |
| `apps/desktop/design/app-icon-1024.png`, `tools/check/desktop-icon.mjs` | Fonte opaca aprovada e validação do ícone do desktop |
| `packages/protocol/` | Transporte, adaptador, política, esquema, fixtures e testes da tarefa 1.9 |
| `tools/selftest/`, `apps/desktop/src-tauri/tauri.selftest.conf.json` | Runner e roteiro funcional do binário macOS da tarefa 1.10 |
| `tools/check/selftest.mjs` | Contrato estrutural e isolamento do autoteste |
| `docs/evidence/task-1.11/` | Índice e catorze capturas comparativas do desktop e celular |
| `packages/ui/scripts/phone-terminal-fixture.mjs`, `check-phone-terminal-visual.mjs` | Fixture fictícia e cinco estados móveis reproduzíveis da tarefa 1.11 |
| `packages/ui/scripts/check-terminal-sync.mjs` | Dezessete casos de sincronização e migração |
| `packages/ui/scripts/check-studio-browser.js` | Check visível aprovado nas entradas desktop e celular |
| `tools/check/mobile-resource.mjs` | Integridade e isolamento do recurso móvel gerado |
| `tools/check/ui-extraction.mjs` | Guarda contra módulos do Control e chaves antigas fora das migrações |
| `.github/workflows/ci.yml` | Matriz mínima, sem execução remota registrada |
| `.github/workflows/spike-headscale.yml` | Integração do spike no Linux, sem execução remota registrada |
| `packages/tunnel-core/spikes/headscale/headscale_test.go` | Experimento Docker reproduzível, sem usar servidor do usuário |
| `packages/tunnel-core/spikes/mobileprobe/probe.go` | API experimental Go para o primeiro ensaio móvel |
| `packages/tunnel-core/internal/rpc/`, `internal/statedir/`, `internal/logx/`, `internal/node/` | Fundação de produção da tarefa 2.1 e testes sem rede |
| `packages/tunnel-core/internal/control/`, `internal/headscale/` | Fronteira administrativa e cliente REST 0.29 da tarefa 2.2, com testes falsos |
| `packages/tunnel-core/internal/pairing/` | Codec, sessões de uso único e registro de dispositivos da tarefa 2.3 |
| `packages/tunnel-core/internal/edge/` | Site móvel, pareamento autenticado e proxy da ponte da tarefa 2.4 |
| `packages/tunnel-core/internal/proxy/` | Proxy local do WebView e transporte pelo nó da tarefa 2.5 |
| `packages/tunnel-core/cmd/cialai-tunnel/`, `internal/sidecar/` | CLI, protocolo stdio e composição dos serviços da tarefa 2.6 |
| `apps/desktop/src-tauri/src/tunnel/{protocol,credentials,supervisor}.rs` | Supervisor, keyring, framing e eventos Tauri da tarefa 2.7 |
| `tools/spikes/build-mobile.mjs` | Preflight e build experimental iOS ou Android |
| `tools/spikes/README.md` | Escopo, comandos e medições pendentes dos spikes |
| `docs/evidence/control-source.json` | Commit base e hashes da origem |

## Comandos de continuidade

Na raiz, com as versões globais atuais, use o cache do npm exec:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm ci
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm test
npm run test:spike:headscale
npm run check:source
```

`npm run dev:desktop` e `npm run build:desktop` agora também geram e validam o recurso móvel da tarefa 1.5. `npm run test:selftest` executa os oito cenários no binário macOS. A página `mobile.html` existe como artefato web, mas o aplicativo móvel nativo ainda não existe. Os demais scripts futuros do documento 09 continuam sendo planejamento.

## Próxima ação

1. Resolver o destino e acesso ao repositório GitHub para executar a matriz de CI. Ainda não houve publicação, push ou alteração nas lojas.
2. Confirmar um contato de segurança e o prazo de resposta antes de anunciar uma política pública completa.
3. O usuário deve fazer o commit das oito alterações do Control conforme 0.2. Depois atualizar o inventário conscientemente, sem apagar mudanças da origem.
4. Disponibilizar Xcode completo, SDK e NDK Android e aparelhos reais. Compilar os bindings experimentais e criar os hosts nativos de teste do spike 1, ainda inexistentes.
5. Executar spikes 1 e 2, depois 4 e 5, com as medições do documento 06. Preparar revisão externa e assinatura com as contas e certificados corretos. O soak de 24 horas continua obrigatório.
6. Conferir o ícone aprovado no Dock, na barra de tarefas e nos lançadores quando os builds de cada plataforma forem executados.
7. Concluir 2.8: ligar os eventos `tunnel://devices` e o estado do nó do supervisor a `BridgeControl`, usar ou remover `node_key` da conexão, agrupar os argumentos de `serve`, atualizar o teste da borda para enviar `x-cialai-node-key` e provar o fechamento por revogação com 4401 em menos de um segundo. Clippy e `cargo test` precisam voltar a passar.
