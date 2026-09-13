# Progresso e passagem de contexto

Atualizado em 13/09/2026. Este é o ponto de entrada para continuar a execução. O escopo e as dependências permanecem em [11-roadmap-de-execucao.md](./11-roadmap-de-execucao.md).

## Regras de continuidade

1. Ler este arquivo antes de executar e atualizar após cada entrega ou impedimento encontrado.
2. Registrar comandos e resultados reais. Não confundir scaffold, código implementado, teste local e aceite de fase.
3. Preservar o working tree do Control. Ele é fonte somente leitura.
4. Não marcar spikes de aparelho, soak ou loja como aprovados por testes unitários.
5. Não iniciar a Fase 1 enquanto o aceite da Fase 0 estiver pendente, salvo mudança expressa de escopo pelo usuário.

## Estado atual

Execução em andamento. A implementação local e os critérios automatizáveis da Fase 1 estão concluídos no macOS; o aceite humano de paridade permanece pendente. A Fase 0 ainda depende de infraestrutura e aparelhos externos.

Handoff da branch `fase-5/rust-multiplataforma`: **Parte Rust pronta para merge**.

| Tarefa | Estado | Evidência e próximo passo |
| --- | --- | --- |
| 0.1 Fundação | Base implementada e validada localmente | Git local em `main`, cinco workspaces, lockfile npm, Apache 2.0, NOTICE, guias, modelos, ignores, crate Rust e módulo Go. E-mail e prazo de segurança ainda precisam de confirmação antes da publicação |
| 0.2 Commit da origem | Pendente do usuário | Control em `c26d98bb9b6851b438918a5e10278799f4442cd7`, com os mesmos oito arquivos alterados descritos no documento 02. Nenhum arquivo da origem foi alterado nesta execução |
| 0.3 CI mínima | Implementada, execução remota pendente | `.github/workflows/ci.yml` para macOS, Linux e Windows. `npm test` passou localmente em macOS arm64. Sem remoto configurado ou push. A consulta GitHub não conseguiu resolver `OrdinumTeam/cialai-platform`, por inexistência ou falta de acesso |
| 0.4 Spike 1 | Preparação parcial | API Go experimental, interfaces Java e Objective-C geradas e script de build. Sem XCFramework, AAR ou execução em aparelhos |
| 0.6 Spike 3 | Aprovado localmente | Headscale 0.29.3 e tsnet 1.102.0; oito verificações finais passaram em 35,830 s, incluindo persistência do módulo móvel no desktop. Workflow remoto preparado |
| 0.5, 0.7 a 0.10 | Pendentes | Sem Xcode em `/Applications`, nenhum Android conectado e SDK não encontrado no caminho padrão. Ensaios móveis, loja e assinatura não executados |
| 0.11 Robustez do proxy | Ensaio local de 30 minutos aprovado; aceite de 24 horas pendente | Oito sockets enviaram 180 rajadas de 50 MiB em quadros de 1 MiB: 9.000 quadros, 9.437.184.000 bytes ecoados e zero desconexões do proxy. RSS foi de 49.299.456 para 62.767.104 bytes, pico de 63.569.920; heap foi de 2.459.656 para 1.673.648 bytes, pico de 2.720.568. Executar as 24 horas antes do aceite do spike |
| 0.12 Decisões dos spikes | Atualizada nesta raia | Decisões 032 a 034 consolidam o build móvel no Codemagic para os spikes 1, 2, 4, 5 e 6, registram o soak curto sem aprovar 24 horas e enumeram as dependências externas ainda sem evidência |
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
| 2.8 Ponte com identidade | Concluída localmente | O supervisor sincroniza a identidade do computador, a lista e os eventos dos dispositivos com `BridgeControl`; o handshake exige id e chave do nó, o `welcome` traz os nomes conhecidos e a revogação fecha com 4401 em menos de 1 s. Clippy sem avisos, 142 testes Rust ativos e `go test -race` passaram |
| 2.9 Interface de rede | Concluída localmente | Assistente do Headscale no onboarding e em Preferências, diálogo Vincular celular com QR de 280 px girando a cada 90 s e aprovação por código, tela Dispositivos com renomear, revogar e diagnóstico, ponto de estado na sidebar e na toolbar. Checks Node, Rust com `tunnel_doctor` e check visível nos temas claro e escuro passaram; o sidecar agora informa `expiresAt` ao encontrar a chave pelo prefixo público do Headscale |
| 2.10 Receita Headscale | Concluída localmente | `infra/headscale` com Compose fixado por digest, modelo do `config.yaml` do documento 06, `policy.json` com `autogroup:self`, `bootstrap.sh` validado e README com guia, diagnóstico e atualização com backup. Check estrutural, `shellcheck`, `configtest` e smoke em contêiner descartável passaram; certificado Let's Encrypt real não foi emitido |
| 2.11 Integração Docker | Concluída localmente | `packages/tunnel-core/integration` dirige o sidecar real pelo protocolo stdio, um celular tsnet com o proxy e o Headscale 0.29.3 em Docker: pareamento, replay recusado na borda e no Headscale, sessão expirada, eco WebSocket de texto, binário e 1 MiB, isolamento entre usuários, revogação em menos de 2 s com remoção do nó e rotação da chave da API. Verde em 26,7 s no macOS; `headscale-integration.yml` sem execução remota |
| 2.12 Sidecars de release | Concluída localmente | `tools/build-tunnel.mjs` compila os cinco triplos com `CGO_ENABLED=0`, grava e confere `SHA256SUMS`; `release.yml` compila, publica como artefato, verifica por alvo e gera rascunho sem assinatura com `tauri-action`; `externalBin` aponta para `binaries/cialai-tunnel`. Cinco binários compilados localmente, suíte raiz verde e build Tauri copiando o sidecar; execução remota do workflow pendente |
| 3.1 API e build gomobile | Código preparado e superfície validada localmente | `packages/tunnel-core/mobile` compõe nó, inspeção e pareamento, perfis, proxy e ciclo de vida sem persistir tokens. `tools/build-tunnel-mobile.sh` tem preflight de Go, Xcode, SDK e NDK e gera hashes SHA 256. Bindings Java e Objective C gerados; XCFramework, AAR e aparelhos continuam pendentes do Codemagic |
| 3.2 Módulo Expo em Swift | Código preparado, build nativo pendente | Módulo local `cialai-tunnel` expõe a API TypeScript, embrulha `Tunnelcore.xcframework` numa fila serial, encaminha eventos e protege o diretório fora do backup. Podspec e manifesto foram validados estruturalmente; compilação Swift aguarda o Codemagic |
| 3.3 Aplicativo Expo | Scaffold implementado e validado estaticamente | Expo 57 e React Native 0.86.3 com estados de pareamento, computadores, shell, offline e ajustes; perfis sem segredos e tokens no Secure Store. `typecheck` e lint passaram; Jest fica para 3.7 e execução nativa permanece pendente |
| 3.4 URL, saúde e rede | Implementado e validado estaticamente | Produção aceita somente `http://127.0.0.1:<porta>/?k=<nonce>`, saúde exige serviço `cialai`, AppState atualiza o foreground e sonda imediatamente, NetInfo notifica mudança de rede. Testes unitários específicos ficam em 3.7 |
| 3.5 Configuração iOS | Implementada e resolvida pelo Expo | Bundle `br.com.ordinum.cialai`, câmera, rede local, Face ID, criptografia não isenta e proteção até o primeiro desbloqueio aparecem no config prebuild. Assinatura e build iOS não foram executados |
| 3.6 Página do celular | Implementada e testada em Node | Composição contém somente Terminais e cabeçalho compacto permanente com nome do computador e estado da ponte. Checks UI passaram com 17 casos de sincronização e 40 demais casos; WebView real continua pendente |
| 3.7 Testes Jest | Concluída localmente | Os casos herdados e as coberturas novas de QR, perfis, URL, saúde, navegação, assinatura e transições somam 101 casos em 15 suítes verdes. Typecheck e lint passaram; aparelhos reais continuam pendentes das tarefas 3.9 e 4.7 |
| 3.8 Distribuição iOS | Preparada localmente, serviços externos pendentes | `ios-testflight` e `ios-archive` compilam o XCFramework com Go 1.26.5 e `gomobile` no runner, validam a casca e preparam assinatura e IPA. Contrato YAML e scripts passaram localmente; app, integração, credenciais, assinatura, archive e upload não foram criados nem executados |
| 3.9 Roteiros em iPhone | Roteiro preparado na frente C, execução pendente | Folha imprimível cobre os treze cenários do documento 06, limites, identificação do ambiente e campos de evidência. Nenhum cenário foi executado ou aprovado |
| 4.1 Módulo Expo em Kotlin | Código preparado, build nativo pendente | Wrapper Kotlin usa uma fila serial, `noBackupFilesDir`, eventos Expo e `tunnelcore.aar` com mínimo Android 26. Manifesto e Gradle foram conferidos estruturalmente; compilação Kotlin aguarda o Codemagic |
| 4.2 Configuração Android | Implementada e introspectada pelo Expo | SDK alvo e compilação 36, mínimo 26, teclado resize, backup desligado e texto claro negado salvo `127.0.0.1`. Permissões finais limitadas a câmera, internet e biometria; prebuild e relatório Play pendentes |
| 4.3 Voltar no Android | Implementado e testado em Node | BackHandler injeta `navigate-back`; página retorna prévia, arquivos, terminal e lista, pedindo a tela Computadores ao chegar na lista. Fluxo bidirecional passou no check UI; aparelho real pendente |
| 4.4 Ciclo de segundo plano | Código preparado e validado estaticamente | Kotlin agenda `Stop` após 120 s, conserva abertura só em memória e executa `StartProfile` e `OpenDesktop` no retorno; React Native mostra Reconectando até saúde verde. Suspensão real pendente |
| 4.5 Biometria e Secure Store | Código preparado, prova Android pendente | Política de sessão herdada usa autenticação local e tokens por desktop usam Secure Store com backup Android desligado. Typecheck, lint e introspecção passaram; biometria e Keystore não foram executados em aparelho |
| 4.6 Distribuição Android | Preparada localmente, serviços externos pendentes | `android-play` compila o AAR com Go 1.26.5 e `gomobile` no runner, gera o projeto Expo, usa assinatura release por `key.properties`, produz o AAB e aponta para a faixa interna. Contrato YAML, plugin e prebuild passaram; app, credenciais, assinatura, AAB e publicação não foram criados nem executados |
| 4.7 Roteiros em Android | Roteiro preparado na frente C, execução pendente | Folha imprimível cobre os treze cenários do documento 06 e quatro verificações específicas do Android, com limites, identificação do ambiente e campos de evidência. Nenhum cenário foi executado ou aprovado |
| 5.1 Fonte de processos | Verificada no macOS e Linux; Windows compilado | `procs/` separa contrato portável, backends nativos e `ProcSource`; `FakeProcs` prova as métricas sem consultar processos reais. `TestChild` passou no macOS e no Ubuntu, enquanto o braço Windows passou no cross check sem execução nativa |
| 5.2 Processos Linux | Concluída e verificada no Ubuntu 22.04 arm64 | Backend usa `sysinfo` 0.36.1 e completa filhos, grupo, estado, PSS e arquivos abertos por `/proc`. Os três testes próprios do backend e o `TestChild` nativo passaram no contêiner da tarefa 5.15 |
| 5.3 Processos Windows | Compilada, execução Windows pendente | Backend usa `sysinfo`, working set privado, Job Object por shell e heurística de folha mais nova. `cargo-xwin check --all-targets` passou para `x86_64-pc-windows-msvc`; nenhum executável Windows ou recurso `.rc` foi executado ou compilado neste host |
| 5.4 PTY por sistema | Verificada no macOS e Linux; execução Windows pendente | `pty/` centraliza spawn, foreground e encerramento; `TestShell` elimina perfis nos testes e o Windows usa Job Object com encerramento gracioso seguido de término forçado após 400 ms. O braço Windows compilou pelo `cargo-xwin`, sem execução nativa |
| 5.5 Retomada por shell | Verificada no macOS e Linux; execução Windows pendente | Comandos de retomada cobrem POSIX, PowerShell e cmd; wrappers `.exe` e `.cmd` são reconhecidos, e a reserva do Codex seleciona rollout por cwd canônico e mtime. Os testes Windows compilaram pelo `cargo-xwin`, sem execução nativa |
| 5.6 Observador de arquivos | Verificada no macOS e Linux; execução Windows pendente | `watch/` mantém contagem de referências e coalescimento comum, usa kqueue no macOS e `notify` 8 no Linux e Windows. Escrita, troca atômica e remoção passaram no macOS e no Ubuntu; o braço Windows compilou, sem execução nativa |
| 5.7 Arquivos portáveis | Verificada no macOS e Linux; execução Windows pendente | Caminhos devolvidos usam barras normais, entradas preservam as duas formas aceitas no Windows, a sujeira é filtrada por sistema e links são recriados somente no Unix. A lixeira passou no macOS e no Ubuntu; o braço Windows compilou, sem execução nativa |
| 5.8 Prévia portável | Testes Rust verificados no macOS e Linux; WebView2 pendente | O handler aceita `preview://` e `http://preview.localhost`, `native.js` escolhe a forma do Windows e `dunce::canonicalize` protege raiz e alvo. O código Windows compilou, mas a forma local ainda não foi aberta no WebView2 |
| 5.9 Browser e Office | Testes Rust verificados no macOS e Linux; execução real pendente | Descoberta e instalador por sistema passaram no macOS e no Ubuntu após tornar o fixture do cache específico ao sistema. Chromium, WebView2 e LibreOffice reais ainda não foram executados no Linux ou Windows |
| 5.10 Diagnóstico e hook | Testes Rust verificados no macOS e Linux; execução Windows pendente | O log usa `app_log_dir`, Unix redireciona stderr por `dup2` e Windows usa `SetStdHandle`; o hook tem instaladores POSIX e PowerShell. Rust passou no Ubuntu e compilou para Windows, mas o instalador PowerShell não foi executado nativamente |
| 5.11 Janela por sistema | Preparada; X11 medido sob Xvfb, Wayland e Windows nativo pendentes | `window/` tem backends macOS, Windows por `SetWindowPos` e Mica a partir do build 22621, e genérico com animação no X11 e salto no Wayland. Windows ganhou controles próprios e Linux e Windows ganharam o botão de menu da toolbar. Onze testes de janela passaram no macOS e no Ubuntu 22.04 em contêiner, Clippy passou nos dois e no alvo MSVC por `cargo-xwin`. No self test da 5.18 sob Xvfb, a janela X11 cresceu de 440 por 320 para 1380 por 880 em 531 ms e 26 quadros; Wayland e Windows nativo não foram exercitados |
| 5.12 Atalhos por sistema | Concluída localmente na main | Rótulos e handlers usam um contrato único no desktop, no Workbench, nos painéis, na paleta, no editor e no xterm. O Dev Browser da porta 64552 confirmou Windows, Linux e macOS detectado sem o parâmetro; não houve execução nativa em Windows ou Linux |
| 5.13 CSS e fontes por sistema | Concluída localmente na main; renderização nativa pendente | `shell.css` aplica tokens e casca com `data-shell="desktop"` em qualquer sistema e deixa só semáforos e suavização de fonte no macOS. `platform.css` define as fontes de cada sistema e a JetBrains Mono empacotada fica como último recurso do terminal no Linux. O Dev Browser confirmou tokens, fontes e layout do estúdio em Windows, Linux e macOS nos dois temas; WebKitGTK e WebView2 reais não foram usados |
| 5.14 Preferências por sistema | Concluída localmente na main; troca nativa do Mica pendente | Terminal mostra shell, argumentos, `LANG` e prefixos do PATH com o padrão de cada sistema e esconde `LANG` no Windows. Dev Browser filtra executáveis no Windows, a seção Janela liga ou desliga o Mica só no Windows e Arquivos do aplicativo mostra os caminhos reais por `app_paths`. Rust passou 18 testes no macOS e no Linux em contêiner e Clippy nos três alvos; o Dev Browser conferiu os três sistemas. O Mica ao salvar não foi executado no Windows |
| 5.15 Testes Rust por sistema | Parte Rust concluída no macOS e Linux; Windows compilado | `TestShell` e `TestChild` exercitam processos e terminais reais por sistema. macOS passou 151 casos e Linux passou 145; dois ensaios externos ficaram ignorados. `cargo-xwin --all-targets` passou; execução Windows permanece pendente |
| 5.16 Matriz de CI | Matriz do `ci.yml` concluída localmente; execução remota pendente | Ubuntu 22.04, Windows 2022 e macOS 14 instalam toolchains, limitam Rust a dois jobs, compilam o sidecar, executam `npm test`, geram bundle sem assinatura e anexam os formatos por sistema. Release, Playwright, check de texto e resultado remoto permanecem pendentes |
| 5.18 Nightly e self test multiplataforma | Preparado; self test Linux verificado em contêiner, execução remota e Windows pendentes | `nightly-e2e.yml` roda diariamente no Ubuntu 22.04 e no Windows 2022 com `tauri-driver` 2.0.6, WebKitWebDriver e Xvfb no Linux e Edge WebDriver da versão do WebView2 no Windows. `tools/selftest/driver.mjs` abre o binário real por WebDriver e anexa relatório, log e capturas. O roteiro ficou portátil por sistema e shell e passou 8 de 8 no macOS por `tauri dev` e no Ubuntu 22.04 arm64 em contêiner, inclusive a frio; nenhum workflow foi disparado |
| 5.19 Guia por plataforma | Concluída localmente | README traz preparação específica de macOS, Ubuntu e Windows; o guia 14 reúne janela, menu, fontes, terminal, processos, atalhos, caminhos, integrações, pacotes e o estado real de verificação |
| 6.1 Dev Browser no Linux | Preparado; imagem Ubuntu validada; testes Linux e Windows pendentes | A imagem Ubuntu 22.04 com Rust 1.98.1, Node 22.23.2 e dependências Tauri foi construída. O runner limita Docker a 6 GiB, usa Cargo com dois jobs, testa descoberta e baixa o Chromium real pelo Playwright. A compilação no contêiner não começou porque o disco caiu abaixo de 5 GiB; Windows permanece pendente |
| 6.2 Prévias Office | Validada no macOS; Linux e Windows pendentes | O LibreOffice real converteu a fixture RTF em PDF válido de 17.799 bytes no macOS. O runner Ubuntu 22.04 está preparado com contêiner efêmero e limite de 6 GiB, mas parou no preflight de disco antes de executar |
| 6.4 `mobile_files` no Windows | Implementada; compilação e execução Windows pendentes | Usa `CreateFileW` com `FILE_FLAG_OPEN_REPARSE_POINT`, recusa reparse points e hard links e confere o caminho final de cada handle dentro da raiz. O check estrutural passou; `cargo-xwin` não está instalado e o disco está abaixo do piso para instalar ou compilar |
| 6.6 Preparação de tradução | Página web do celular migrada; app nativo pendente | `@cialai/i18n` fornece os dicionários em português e inglês com troca observável e fallback. Na integração, o cabeçalho atual da página do celular passou a usar as chaves de conexão e o nome reserva do computador, preservando os textos em português; o seletor de idioma do cabeçalho antigo não foi portado e o idioma segue o navegador ou o valor salvo. O gate cobre `packages/ui/src/mobile`; as telas React Native de `apps/mobile` ainda têm textos literais e ficam fora do gate até a migração |
| 6.8 Documentação viva | Implementada na frente C | Documentos 01 a 12 têm estado datado por item, o roadmap classifica 86 tarefas e o registro cobre as 31 decisões. O índice e as descrições de CI e ferramentas foram atualizados para o que existe nesta linha |
| 7.1 Atualizador | Preparado na frente C, assinatura pendente | Plugins Rust e JavaScript, interface em Preferências, artefatos do updater e endpoint `latest.json` configurados. O workflow exige os dois secrets e falha enquanto a chave pública mantiver o marcador. Nenhum artefato foi assinado ou publicado |
| 7.2 Documentação pública | Implementada na frente C | README em inglês usa três capturas reais com dados fictícios; guias de contribuição e segurança, código de conduta e modelos de issue e PR foram revisados. O contato e o prazo de segurança permanecem marcados para confirmação |
| 7.3 Materiais das lojas | Preparados na frente C, publicação pendente | Políticas de privacidade em inglês e português, respostas propostas para Apple e Google, textos nas duas línguas e plano de capturas por tamanho estão versionados. Auditoria do binário, capturas nativas e preenchimento dos formulários dependem do usuário |
| 7.4 Pacote de revisão | Preparado na frente C, execução pendente | Notas em inglês, roteiro do desktop isolado e roteiro de vídeo de até 90 segundos estão prontos. Máquina, acesso, gravação, TestFlight externo e submissões não foram criados nem executados |
| 7.5 Release da versão 1 | Procedimento preparado na frente C, release pendente | Changelog público, roteiro da candidata e guarda local cobrem os seis gates do documento 10. A guarda final falha com todos os gates pendentes e nenhuma tag, assinatura, publicação ou instalação foi feita |
| 3.10, 4.8, 5.17, 6.3, 6.5, 6.7 e 7.6 | Não iniciadas ou pendentes na main | Assinatura, uso do plano, testes físicos do desktop e publicação da versão 1 continuam pendentes. A autorização para avançar não aprova testes físicos, remotos, de assinatura ou de loja |

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

### 12/09/2026, ponte com identidade da tarefa 2.8 concluída localmente

`BridgeControl` passou a ser entregue ao supervisor e recebe a identidade do computador ao abrir a borda, a lista completa de `devices.list`, o dispositivo de `pair.completed` e as mudanças de nome ou revogação de `devices.changed`. A revogação local agora é publicada antes das chamadas administrativas opcionais ao Headscale, para não depender da latência de rede. A conexão mantém somente `device_id`; a chave do nó é consumida no handshake para resolver a identidade mostrada no `welcome`. As dependências de `serve` foram agrupadas em `ServeContext`.

O teste `bridge::tests::proxy_secret_marks_the_connection_as_a_device` envia os três cabeçalhos confiáveis, confere as identidades do dispositivo e do computador e exige fechamento WebSocket 4401 em menos de um segundo. Um teste do supervisor cobre a sincronização dos cinco caminhos de identidade e um teste Go cobre o conteúdo dos eventos de renomeação e revogação. Os ciclos vermelhos reproduziram o 403 do cabeçalho ausente, a ausência da interface de sincronização e o evento `devices.changed` sem dados suficientes.

Comandos concluídos com código 0, usando `CARGO_TARGET_DIR="$HOME/.cache/cialai-target"` nos comandos Rust:

```sh
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
go vet ./...
go test -race -mod=readonly ./...
go mod tidy -diff
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm test
git diff --check
```

Resultados: Clippy sem avisos; 142 testes Rust aprovados, zero falhas e os dois ensaios externos já justificados ignorados; race detector verde em todos os pacotes Go com testes; as 17 sincronizações, 38 testes UI, 9 testes de protocolo, checks estruturais, builds Vite e a suíte raiz passaram. Nenhum servidor real foi usado.

### 12/09/2026, interface de rede da tarefa 2.9 concluída localmente

`TunnelContext.jsx` concentra comandos `tunnel_*`, eventos `tunnel://state`, `tunnel://pair` e `tunnel://devices`, restauração da rede salva e um modo de demonstração acionado por `?tunnel=demo`. `tunnel-model.js` guarda as regras puras: normalização da preferência `network` sem chave da API, validação de HTTPS fora do loopback, identidade `d_` compatível com o codec, nome do nó, relógio de 90 s dentro do TTL de 600 s e o estado único mostrado na sidebar e na toolbar.

`NetworkSetup.jsx` percorre Servidor, Usuário, Computador e Concluído, aparece como etapa Rede do onboarding e como seção Rede das Preferências. `PairingDialog.jsx` gera o QR com `qrcode` 1.5.4 em 280 px, cancela a sessão anterior a cada rotação e ao fechar, mostra os dois contadores e o código de quatro dígitos quando a aprovação está ligada. `Devices.jsx` é a segunda rota do desktop, com IP, nome no Headscale, DERP, chave, diagnóstico por `cialai-tunnel doctor` e ações de renomear e revogar, inclusive na rede. O estado vazio de Terminais também oferece Vincular celular. O comando Tauri `tunnel_doctor` executa a CLI do sidecar sem abrir outro nó.

Limite conhecido: `control.configure` do sidecar devolve somente o prefixo da chave da API. A interface mostra a validade quando `apiKey.expiresAt` existir e, até lá, mostra o prefixo protegido.

Validação: `npm run test:ui` com 17 sincronizações e 43 testes Node, incluindo o novo `tunnel-model.test.cjs` e `check-network.mjs`; `cargo fmt --check`, Clippy com `-D warnings` e `cargo test` com 143 aprovados, zero falhas e dois ignorados; checks de onboarding, extração e `git diff --check`. No Dev Browser Panel da sessão atual, `scripts/check-network-browser.js` terminou em `PASS: Cialai network screens and rotating QR in light theme` e `in dark theme`, com rota Dispositivos, QR de 280 px, contador em 1:30, aprovação 4827 e nenhum separador proibido no texto visível. Capturas em `~/.dev-browser/tmp/cialai-2-9-pair-light.png` e `cialai-2-9-pair-dark.png`. Nenhum Headscale real ou celular foi usado.

### 12/09/2026, receita Headscale da tarefa 2.10 concluída localmente

`infra/headscale/docker-compose.yml` sobe `headscale/headscale:0.29.3` fixado pelo digest `sha256:0e7f1c6e4ce6c2a2a001103ecd3fa645a045adf30ac8a5234fe037b43000cd72`, publica 443, 80 e 3478 UDP, monta `config` somente leitura, guarda dados no volume `headscale-data` e mantém o socket em `tmpfs`. A imagem não tem shell nem `curl`, então a verificação de saúde usa `/ko-app/headscale health`, desvio consciente do `/health` citado no documento 06. `config/config.yaml.template` reproduz o modelo do documento com marcadores de domínio e IPv4; `config/policy.json` mantém os comentários, aceitos pelo Headscale.

`bootstrap.sh` normaliza e valida domínio e IPv4, recusa domínios dentro de `cialai.internal`, não sobrescreve `config/config.yaml` sem `--force`, roda `configtest` antes de subir, espera `https://<domínio>/health` por até 300 s e só imprime o comando `apikeys create --expiration 365d`, sem criar chave. O README traz o guia de 10 minutos, a tabela de diagnóstico de DNS, 443, certificado, versão, saúde e STUN, a atualização com backup do volume e as notas de segurança. `tools/check/headscale-infra.mjs` entrou no job `tunnel-check` e protege imagem, portas, modelo, política, bootstrap e texto do README.

Validação: check estrutural e `shellcheck` verdes; `bash -n`; numa cópia temporária, entradas inválidas terminaram com código 1, a geração funcionou, `docker compose config` e `docker compose run headscale configtest` passaram. Um smoke com a mesma configuração, trocando apenas TLS por HTTP local, ficou `running`, respondeu `/health`, `headscale health` pelo socket em `/var/run/headscale` e `headscale version` pelo PATH, carregou a política e iniciou o relé DERP e o STUN. Contêiner, rede, volume e cópia temporária foram removidos. A emissão real do certificado, DNS e portas públicas dependem de um servidor com domínio e não foram exercitadas.

### 12/09/2026, sidecars de release da tarefa 2.12 concluídos localmente

`tools/build-tunnel.mjs` é a fonte única dos cinco triplos: `aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu` e `x86_64-pc-windows-msvc`. Compila `./cmd/cialai-tunnel` com `CGO_ENABLED=0`, `-trimpath` e `-ldflags=-s -w` em `apps/desktop/src-tauri/binaries`, já ignorado pelo Git, grava `SHA256SUMS` e verifica um alvo com `--verify`. `--local` usa o host do `rustc`. `npm run build:tunnel` compila todos; `npm run sidecar` do desktop compila só o local e agora precede `tauri dev` e `tauri build`.

`tauri.conf.json` ganhou `externalBin: ["binaries/cialai-tunnel"]`. Um ensaio controlado provou a consequência: sem o binário do host, `cargo check` falha com ``resource path `binaries/cialai-tunnel-aarch64-apple-darwin` doesn't exist``; com o binário, passa. Por isso o job `desktop-check` compila o sidecar local antes do Cargo. Quem rodar Cargo diretamente, inclusive a frente da Fase 5 depois do merge, precisa executar `npm run sidecar --workspace @cialai/desktop` antes.

`.github/workflows/release.yml` roda em tags `v*` e manualmente. O job `sidecars` testa o núcleo, compila os cinco alvos e publica o artefato; o job `desktop` baixa, verifica o SHA-256 do alvo e roda `tauri-action` em macOS 14, macOS 13, Ubuntu 22.04 e Windows 2022, gerando release em rascunho. Assinatura, notarização e updater ficaram fora de propósito, para as tarefas 5.17 e 7.1. `tools/check/release-sidecar.mjs` amarra triplos, workflow, `externalBin`, nome procurado pelo supervisor e scripts do desktop.

Validação: os cinco binários foram compilados em 2 min e o `file` confirmou Mach-O arm64 e x86_64, ELF estático x86-64 e aarch64 e PE32+; os cinco checksums conferiram e um hash adulterado terminou em `Checksum mismatch` com código 1; o YAML foi lido por Ruby com os jobs `sidecars` e `desktop`. `npm test` completo terminou com código 0, incluindo 143 testes Rust aprovados, zero falhas e dois ignorados, Go, UI, protocolo e a receita Headscale. `tauri build --debug --no-bundle --ci` terminou com código 0 e copiou `target/debug/cialai-tunnel` idêntico ao binário do triplo; `cialai-tunnel version` respondeu. O workflow não foi executado no GitHub.

### 12/09/2026, integração Docker da tarefa 2.11 concluída localmente

`packages/tunnel-core/testutil` ganhou, sob a tag `integration`, o Headscale 0.29.3 descartável no loopback com relé DERP local de certificado fixado, como no spike 3, e uma ponte WebSocket falsa que registra os cabeçalhos recebidos. `packages/tunnel-core/integration/integration_test.go` executa `sidecar.Serve` em processo pelo mesmo protocolo stdio do supervisor: `control.configure`, `node.up`, `edge.serve` e `pair.begin`. O celular é um `node.Manager` tsnet real que lê o payload, entra na rede com a chave do QR, espera o computador nos peers e chama `/api/health` e `/pair` pelo túnel.

O teste prova que o mesmo QR recebe `pair_consumed` na borda e que a chave de entrada consumida não coloca outro nó na rede; que uma sessão de 1 s recebe `pair_expired`; que o proxy local recusa quem não tem o cookie, troca o nonce por cookie `HttpOnly` e leva quadros de texto, binários e de 1 MiB até a ponte e de volta; que a ponte recebe segredo, id do dispositivo e chave do nó, sem `Authorization` nem cookie; que Bob não vê nem alcança o computador de Alice; que `devices.revoke` com `network` fecha o socket em menos de 2 s, emite `devices.changed` e apaga o nó no Headscale; e que `control.apikey.rotate` com `expireOld` invalida a chave anterior e o sidecar segue operando com a nova.

Para o QR aceitar o controle HTTP do loopback, `sidecar.Options` ganhou `AllowLoopbackHTTP`, repassado a `pairing.NewSessions`. O padrão continua falso e a CLI não expõe a opção; só desenvolvimento e esta suíte a usam, conforme o documento 06. O caminho TLS com `caFile` permanece coberto pelos testes unitários do cliente Headscale, não por esta integração. Headscale parado por 60 s, aprovação por código e rotação de token de 30 dias também ficaram fora do cenário de ponta a ponta.

Validação: `go mod tidy` tornou `github.com/coder/websocket` dependência direta e `go mod tidy -diff` ficou limpo; `gofmt`, `go vet ./...`, `go vet -tags=integration ./integration ./testutil`, `go test -race` do sidecar e `go test ./...` passaram. `go test -tags=integration -count=1 ./integration` terminou com `--- PASS: TestDesktopPairsPhoneThroughHeadscale (26.72s)` e nenhum contêiner com o rótulo da suíte permaneceu. `npm run test:integration:headscale` e `.github/workflows/headscale-integration.yml` repetem os mesmos comandos; o workflow não foi executado no GitHub.

### 12/09/2026, API gomobile da tarefa 3.1 preparada

Criado `packages/tunnel-core/mobile` com a superfície do documento 06. O pacote valida o QR sem devolver segredos, cria ou retoma um perfil `tsnet`, espera o peer pela chave do nó, troca a prova de uso único no endpoint `/pair`, abre somente o proxy de loopback já existente e serializa mudanças de perfil. O estado Go persiste apenas URL, identidade e metadados de desktops; chaves de entrada, segredos do QR e tokens de dispositivo não entram no arquivo. Nenhum arquivo de `internal/` foi alterado.

`tools/build-tunnel-mobile.sh` fixa o contrato de saída `Tunnelcore.xcframework.zip` e `tunnelcore.aar`, executa preflight explícito de Go 1.26.5, Xcode, SDK, NDK e gera SHA 256. O script não foi usado para compilar os artefatos neste Mac porque o build pertence ao runner `mac_mini_m2` do Codemagic. Isso não foi registrado como impedimento e não prova XCFramework, AAR ou execução em aparelho.

Comandos concluídos com código 0:

```sh
cd packages/tunnel-core
go vet ./...
go test -race -mod=readonly ./...
bash -n ../../tools/build-tunnel-mobile.sh
mkdir -p build/spikes/_bindings
go tool gobind -lang=java,objc -outdir=build/spikes/_bindings ./mobile
```

O race detector aprovou todos os pacotes, inclusive os três casos novos de `mobile`. `gobind` gerou as interfaces Java e Objective C com todos os métodos documentados. Os gerados ficaram sob `build/`, ignorados pelo Git.

### 12/09/2026, módulo Swift da tarefa 3.2 preparado

Criado o módulo Expo local `cialai-tunnel` com manifesto de autolinking, contrato TypeScript e implementação Swift. O wrapper cria um único `MobileTunnel`, serializa chamadas bloqueantes fora do JavaScript, traduz os JSONs do Go em objetos Expo e encaminha os cinco tipos de evento. O diretório de estado usa `Application Support`, é excluído de backup e recebe `NSFileProtectionCompleteUntilFirstUserAuthentication`.

O podspec declara iOS 16.4 e `Tunnelcore.xcframework` como `vendored_frameworks`. O framework não foi gerado nem versionado; o Codemagic deverá colocá lo no diretório do módulo antes do prebuild. `ruby -c apps/mobile/modules/cialai-tunnel/ios/CialaiTunnel.podspec`, a leitura dos dois JSONs pelo Node, `git diff --check` e a conferência dos seletores gerados por `gobind` terminaram com código 0. Não houve compilação Swift, build Xcode nem execução em aparelho.

### 12/09/2026, módulo Kotlin da tarefa 4.1 preparado

Adicionada a implementação Android do módulo `cialai-tunnel`. Ela usa `noBackupFilesDir`, uma fila serial para todas as chamadas bloqueantes, converte JSON do Go para valores Expo e preserva os códigos estáveis ao rejeitar Promises. O Gradle fixa `minSdkVersion 26`, declara o AAR local e reutiliza as versões padrão do Expo Modules Core. O AAR e o XCFramework foram acrescentados ao ignore explícito.

`xmllint --noout` no manifesto, conferência dos métodos contra as classes Java geradas por `gobind`, leitura do Gradle e `git diff --check` terminaram com código 0. Não houve `expo prebuild`, compilação Kotlin, AAR real nem execução Android local; essas provas pertencem ao runner do Codemagic e aos roteiros em aparelho.

### 12/09/2026, scaffold Expo da tarefa 3.3 implementado

`apps/mobile` agora usa Expo 57, React Native 0.86.3 e dev client. A máquina de estados cobre carregamento, pareamento, computadores, shell, offline e ajustes. `Pair` desliga a leitura depois do primeiro QR, permite colar o texto, inspeciona antes de confirmar e mostra progresso. A lista troca perfis, abre computadores e oferece renomear ou esquecer. O shell preserva WebView, biometria, downloads, abertura externa e guarda de origem do Control, com `__CIALAI_SHELL__`, nome do computador e estado do túnel.

`profiles.json` guarda somente perfis e metadados. Cada token usa `expo-secure-store` sob `cialai.device.<desktopId>` com `WHEN_UNLOCKED_THIS_DEVICE_ONLY`; a rotação recebida pelo evento nativo substitui o valor seguro. Esquecer um perfil apaga seus tokens e solicita a remoção do estado Go. Textos visíveis novos não usam parênteses nem traços como separadores.

Comandos concluídos com código 0:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm install
npm run lint --workspace @cialai/mobile
npm run typecheck --workspace @cialai/mobile
git diff --check
```

O primeiro `npm install` recusou a versão inexistente `expo-camera ~57.0.7`; o mapa `bundledNativeModules.json` do Expo 57 corrigiu câmera para 57.0.4, NetInfo para 12.0.1, build properties para 57.0.17 e dev client para 57.0.18. A instalação final terminou com código 0. `npm audit --omit=dev --audit-level=moderate` encontrou onze ocorrências transitivas do aviso de `uuid` abaixo de 11.1.1 pela ferramenta `xcode` dos config plugins do Expo. O único reparo sugerido força downgrade incompatível de `expo-sharing`; ele não foi aplicado. Jest ainda não foi criado nem executado nesta tarefa.

### 12/09/2026, rede da tarefa 3.4 integrada

`validateControlUrl` agora recusa qualquer origem de produção que não seja `http://127.0.0.1` com porta explícita, raiz e um único nonce `k` de 32 bytes em base64url. Toda URL devolvida por `OpenDesktop` passa por essa validação antes da saúde ou da WebView. A lista de origens da WebView contém somente a origem local exata e a saúde aceita apenas `status: ok` com `service: cialai`.

O observador global de `AppState` chama `NotifyForeground`, preserva o bloqueio biométrico e executa uma sondagem imediata ao voltar com o shell aberto. NetInfo calcula alcance conservador e chama `NotifyNetworkChange`. `npm run typecheck --workspace @cialai/mobile`, `npm run lint --workspace @cialai/mobile` e `git diff --check` terminaram com código 0. As transições serão cobertas por Jest em 3.7; troca real de rede e suspensão continuam pendentes dos aparelhos.

### 12/09/2026, configuração iOS da tarefa 3.5 preparada

`app.config.ts` define Cialai, esquema `cialai`, bundle `br.com.ordinum.cialai`, iOS 16.4 herdado do podspec, câmera, rede local e Face ID. `usesNonExemptEncryption` está verdadeiro e o entitlement de proteção padrão usa `NSFileProtectionCompleteUntilFirstUserAuthentication`; o módulo Swift também exclui seu estado do backup em runtime. O ícone aponta para o PNG opaco de 1024 pixels já aprovado e versionado em `apps/desktop/design`, sem duplicar o binário.

`npm run typecheck --workspace @cialai/mobile`, `npm run lint --workspace @cialai/mobile` e `npm exec --workspace @cialai/mobile -- expo config --type public --json` terminaram com código 0. A variante `--type prebuild` confirmou bundle, criptografia não isenta e proteção de dados. Nenhum projeto Xcode, assinatura, archive ou aparelho foi usado.

### 12/09/2026, página do celular da tarefa 3.6 concluída localmente

`MobileApp` monta somente `VIEW_COMPONENTS.terminais`; `TabBar` e `MoreSheet` foram removidos. O cabeçalho compacto permanece visível com o nome recebido no `welcome` ou pela casca nativa e traduz conectado, conectando, removido, incompatível e desconectado. O bootstrap da WebView agora inclui `desktopName` em `__CIALAI_SHELL__`.

Adicionado `check-mobile-shell.mjs` para renderizar o cabeçalho e impedir a volta das abas. `npm run test:ui` terminou com código 0: sincronização 17 de 17 e demais checks Node 40 de 40. `npm run typecheck --workspace @cialai/mobile` e lint também passaram antes da entrega. Isso prova composição e contratos locais, não carregamento em WKWebView ou WebView Android.

### 12/09/2026, retorno Android da tarefa 4.3 implementado

No Android, o `BackHandler` da casca injeta `{type: navigate-back}` na página. `PhoneWorkbench` usa a mesma transição do botão visível para voltar de prévia a arquivos, de arquivos a terminal e de terminal à lista. Quando já está na lista, a página devolve a mensagem à casca e o app abre Computadores. Mensagens com campos extras são recusadas.

O novo caso bidirecional de `check-mobile-shell.mjs` passou. A suíte UI terminou com 17 casos de sincronização e 41 demais casos; typecheck e lint do app também passaram. O botão físico e o histórico real da WebView não foram executados em Android.

### 12/09/2026, segurança Android da tarefa 4.2 preparada

O plugin `with-loopback-network-security.cjs` escreve uma política com texto claro negado na base e uma única exceção sem subdomínios para `127.0.0.1`. Ele liga o arquivo no manifesto, mantém `usesCleartextTraffic` falso e desliga backup. O config usa teclado `resize`, `compileSdkVersion` e `targetSdkVersion` 36 e mínimo 26. Permissões herdadas de armazenamento e impressão digital legada foram bloqueadas, restando câmera, internet e biometria.

Typecheck e lint passaram. `expo config --type prebuild` confirmou as três permissões finais e `expo config --type introspect` confirmou os três atributos do manifesto e SDKs 36, 36 e 26. O XML exportado pelo plugin foi conferido pela execução Node. Nenhum projeto Gradle, WebView real ou relatório de pré lançamento foi executado.

### 12/09/2026, ciclo Android da tarefa 4.4 preparado

O wrapper Kotlin mantém o núcleo por 120 segundos após perder o primeiro plano e então chama `Stop`. Perfil ativo, desktop, porta preferida e token permanecem somente em memória. Ao voltar, a fila nativa emite reconectando, executa `StartProfile`, abre um novo proxy com `OpenDesktop` e entrega a nova URL à casca; falhas retornam apenas código estável. Fechamento, troca e esquecimento limpam essa abertura.

A casca mede o tempo fora, mostra a tela Reconectando depois do limite e só retorna ao shell quando a URL reaberta passa pela validação local e pela saúde. Também foi corrigido o uso do terceiro argumento de `OpenDesktop`: a porta remota do desktop não é mais confundida com a porta preferida do proxy local. Typecheck, lint, `git diff --check` e a conferência estrutural do prazo, `Stop`, `StartProfile` e `OpenDesktop` terminaram com código 0. Suspensão real por dez minutos e reconexão em dois a quatro segundos continuam pendentes de Android físico.

### 12/09/2026, proteção Android da tarefa 4.5 preparada

O mesmo `BiometricSession` do Control governa iOS e Android por `expo-local-authentication`: sessão após abertura ou cinco minutos fora e autorização por ação sempre nova. Tokens continuam separados por desktop em `expo-secure-store`; o plugin agora recebe `configureAndroidBackup: false`, além de `allowBackup` falso no manifesto e estado Go em `noBackupFilesDir`.

Typecheck, lint e `expo config --type introspect` terminaram com código 0 e mantiveram biometria permitida, backup falso e armazenamento externo bloqueado. Os testes unitários herdados serão executados em 3.7. Nenhuma impressão digital, reconhecimento facial, fallback por código ou inspeção do Android Keystore ocorreu neste Mac, portanto 4.5 permanece preparada e não verificada em aparelho.

### 12/09/2026, Jest da tarefa 3.7 concluído localmente

Os 65 casos da casca do Control foram preservados e ampliados para QR, armazenamento de perfis sem tokens, URL de loopback, saúde `cialai`, telas, máquina de estados, primeiro e segundo plano e alcance de rede. A lista ampla do WebView agora deixa toda navegação chegar à guarda da aplicação, que continua aceitando somente a origem local exata ou links HTTPS seguros. Erros desconhecidos do QR não devolvem a mensagem nativa e não podem expor o payload.

Com Node 22.23.2 e npm 10.9.8, `npm run typecheck`, `npm run lint` e `npm test` em `apps/mobile` terminaram com código 0. Jest aprovou 99 casos em 14 suítes, sem snapshots. `git diff --check` também passou. Nenhum módulo nativo foi compilado e nenhum aparelho foi usado nesta tarefa.

### 12/09/2026, distribuição iOS da tarefa 3.8 preparada

Criados `ios-testflight` e `ios-archive` sem disparo automático. Ambos usam `mac_mini_m2`, Node 22.23.2, npm 10.9.8, Xcode atual e CocoaPods padrão. O runner instala Go 1.26.5 com o checksum do índice oficial, executa `tools/build-tunnel-mobile.sh ios`, valida o SHA 256, coloca o XCFramework no módulo Expo, roda as validações da casca, faz o prebuild e prepara assinatura e IPA. O primeiro workflow publica somente pela integração `Cialai ASC API Key`, sem solicitar TestFlight externo ou revisão da loja; o segundo conserva o IPA como artefato.

Os atalhos locais de Codemagic e App Store foram espelhados dos modelos somente leitura, com a proteção nova que não envia o token da API a storage externo depois de redirecionamento. `bash -n`, análise sintática dos dois arquivos Python, três testes Node do YAML, quatro casos do próximo número de build, quatro casos de download e o verificador Swift do ícone terminaram com código 0. Nenhum build Codemagic, assinatura, archive, upload ou alteração no App Store Connect foi executado.

### 12/09/2026, distribuição Android da tarefa 4.6 preparada

Adicionado `android-play` no mesmo runner macOS, com NDK 28.2, Java 17 e Go 1.26.5. O workflow compila o AAR com `gomobile`, confere seu SHA 256, executa as validações móveis, gera o projeto Android e grava keystore e `key.properties` somente no runner com umask privado. Um plugin idempotente liga esse arquivo à assinatura release do Gradle, e `PROJECT_BUILD_NUMBER` governa o `versionCode`. A publicação está configurada para a faixa interna com o grupo `google_play`.

O prebuild Android local terminou com código 0 e confirmou o bloco de assinatura, sem criar `key.properties`. Typecheck e lint passaram; Jest aprovou 101 casos em 15 suítes. Os quatro testes Node do YAML, os testes de número e download, `bash -n`, a análise sintática dos três arquivos Python e `git diff --check` também passaram. Nenhum segredo de projeto de referência foi aberto ou copiado. Nenhum build no Codemagic, AAB assinado, upload ou alteração no Google Play foi executado.

Parte celular pronta para merge.

Próximas ações do usuário:

1. Criar o repositório `OrdinumTeam/cialai-platform` no GitHub e fazer o push depois de integrar os commits locais.
2. Criar o app no Codemagic apontando para esse repositório e reconhecer o `codemagic.yaml` da raiz.
3. Criar os apps com o identificador `br.com.ordinum.cialai` no App Store Connect e no Google Play.
4. Configurar a integração `Cialai ASC API Key`, os grupos `appstore_credentials`, `android_credentials` e `google_play` e as variáveis simples documentadas.
5. Só então disparar `ios-archive`, `ios-testflight` e `android-play`, conferir os artefatos e avançar para os roteiros em aparelhos e lojas.

### 12/09/2026, integração da Fase 2 e dos aplicativos na main

`fase-2/tunel` entrou por merge sem conflitos no commit `ade22a6`; a árvore resultante é idêntica à de `e8e1257`, já validada na frente. `mobile/apps` entrou em seguida a partir de `6b2a67e`, com três conflitos esperados: este documento manteve as linhas e o diário das duas frentes e passou a 2.8 para concluída; `packages/ui/package.json` roda `check-network.mjs` e `check-mobile-shell.mjs` e conserva `qrcode`; `package-lock.json` partiu do lado móvel e foi regenerado por `npm install` com Node 22.23.2 e npm 10.9.8.

Validação na main integrada: `npm install` terminou com código 0; `npm test` da raiz terminou com código 0, incluindo 143 testes Rust aprovados, zero falhas e dois ignorados, a suíte UI, o protocolo, a receita Headscale, o sidecar de release e 101 casos Jest em 15 suítes do aplicativo; `go vet ./...` e `go test -race -mod=readonly ./...` passaram em todo o `tunnel-core`, inclusive `mobile`; typecheck e lint de `apps/mobile` e `git diff --check` terminaram com código 0. O primeiro lote de validação foi interrompido pelo sistema por falta de memória durante o lint, com a máquina de 16 GiB dividida com a compilação da frente da Fase 5; o lint foi repetido isoladamente e passou.

`fase-5/rust-multiplataforma` ainda não entrou: a frente tem seis commits e alterações sem commit e não registrou que está pronta para merge.

Percentual estimado pelo peso das tarefas, com os aplicativos compilados e testados em aparelho só no Codemagic:

| Fase | Situação na main | Percentual |
| --- | --- | --- |
| 0 Fundação e spikes | Base, CI local e spike 3; demais spikes absorvidos pelas Fases 3 e 4 ou pendentes de assinatura e soak | 47% |
| 1 Desktop macOS | Implementação e evidência local completas; aceite humano pendente | 97% |
| 2 Túnel e pareamento | Implementação e evidência local completas; CI remota e aceite manual com Headscale real pendentes | 95% |
| 3 iOS | Código de 3.1 a 3.8 pronto; builds nativos, roteiros em iPhone e revisão pendentes | 70% |
| 4 Android | Código de 4.1 a 4.6 pronto; build, roteiros em aparelho e relatório do Play pendentes | 57% |
| 5 Linux e Windows | Em andamento fora da main | 0% na main |
| 6 Todas as plataformas | 6.8 concluída na frente C fora da main; validações das outras plataformas pendentes | 0% na main |
| 7 Lançamento | 7.1 a 7.5 implementadas ou preparadas na frente C fora da main; gates externos pendentes | 0% na main |
| Total | Soma ponderada | cerca de 48%, ou 57% quando a frente da Fase 5 entrar com o que já tem |

### 13/09/2026, integração das Fases 5, 6 e 7 na main

A main passou a conter todas as branches locais. `fase-5/rust-multiplataforma` entrou no commit `1d60cdf`, `fase-6/portabilidade` no `6a1e879` e `fase-7/lancamento` no merge seguinte. Não houve push, tag, release nem build remoto.

Na Fase 6, `MobileHeader.jsx` e `MobileApp.jsx` adotaram as chaves de conexão e o nome reserva do computador sobre o cabeçalho atual da página do celular. `check-mobile-i18n.mjs` cobre somente `packages/ui/src/mobile`, porque as telas React Native ainda têm textos literais. Sem `document`, o locale inicial é português, o que torna `check-mobile-shell.mjs` independente do idioma do sistema.

Na Fase 7, `package.json` uniu os checks das duas linhas numa só cadeia de `npm test`. `Cargo.toml` manteve `dunce` junto dos plugins `updater` e `process`, e `Cargo.lock` partiu da main e recebeu somente os crates novos resolvidos pelo Cargo. O README em inglês ganhou a seção Platform setup com macOS, Linux e Windows. `platform-docs.mjs` passou a exigir a frase em inglês sobre a verificação Windows. Documento 10 e roadmap receberam os estados reais das tarefas 5.1 a 6.6, e o índice deixou de dizer que a Fase 5 não estava integrada.

A primeira execução completa revelou `workspace::procs::macos::tests::lists_children_and_descendants` falhando só na suíte paralela: o teste escolhia o primeiro `sleep` da árvore do processo de testes e podia pegar o de outro teste. Isolado, passou cinco vezes. Ele passou a procurar o `sleep` entre os filhos do próprio `sh` e continua exigindo que esse pid esteja entre os descendentes.

Validação na main integrada, com Node 22.23.2, npm 10.9.8, `CARGO_TARGET_DIR=~/.cache/cialai-target` e Cargo com dois jobs: `npm install` adicionou os dois pacotes JavaScript do updater; `npm test` da raiz terminou com código 0, com todos os checks de fundação, CI, plataforma, documentação pública, lojas, revisão, roteiros, release e documentação viva, 3 casos de i18n, 17 de sincronização, 56 da interface, 9 do protocolo, 155 testes Rust aprovados com 2 ignorados, todos os pacotes Go e 101 casos Jest em 15 suítes. `go test -race -mod=readonly ./...` passou nos 13 pacotes do `tunnel-core`; typecheck e lint de `apps/mobile` e `cargo fmt --check` terminaram com código 0. Nada disso representa execução remota, Linux visível, Windows nativo, aparelho ou assinatura.

Percentual estimado pelo peso das tarefas, com os aplicativos compilados e testados em aparelho só no Codemagic:

| Fase | Situação na main | Percentual |
| --- | --- | --- |
| 0 Fundação e spikes | Base, CI local e spike 3; demais spikes absorvidos pelas Fases 3 e 4 ou pendentes de assinatura e soak | 47% |
| 1 Desktop macOS | Implementação e evidência local completas; aceite humano pendente | 97% |
| 2 Túnel e pareamento | Implementação e evidência local completas, validade da chave incluída; CI remota e Headscale real pendentes | 96% |
| 3 iOS | Código de 3.1 a 3.8 e roteiro 3.9 prontos; builds nativos, execução em iPhone e revisão pendentes | 73% |
| 4 Android | Código de 4.1 a 4.6 e roteiro 4.7 prontos; build, execução em aparelho e relatório do Play pendentes | 62% |
| 5 Linux e Windows | 3 tarefas implementadas e 11 preparadas; 5.11, 5.13, 5.14, 5.17 e 5.18 pendentes, Windows sem execução nativa | 60% |
| 6 Todas as plataformas | 6.8 implementada; 6.1, 6.2, 6.4 e 6.6 preparadas; 6.3, 6.5 e 6.7 pendentes | 45% |
| 7 Lançamento | 7.2 implementada; 7.1, 7.3, 7.4 e 7.5 preparadas; chave, contas, lojas e 7.6 pendentes | 50% |
| Total | Soma ponderada | cerca de 67% |

### 13/09/2026, prefixo e validade da chave da API corrigidos

O prefixo público de uma chave Headscale 0.29 agora respeita os doze caracteres fixos mesmo quando o trecho base64url contém hífen. O cliente administrativo lista os metadados públicos das chaves e `control.configure` devolve `expiresAt` quando encontra o prefixo correspondente, sem expor o segredo. O Rust usa a mesma regra de prefixo ao guardar credenciais.

`go vet ./internal/control ./internal/headscale ./internal/sidecar`, `go test -race -mod=readonly ./internal/control ./internal/headscale ./internal/sidecar`, `go vet -tags=integration ./integration` e `go test -race -tags=integration -count=1 ./integration` terminaram com código 0. A integração Headscale passou em 46,824 s. Antes do Rust foi executado `npm run sidecar --workspace @cialai/desktop`; depois, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -j 2 tunnel::credentials` aprovou três testes, sem falhas. A correção está no commit `842491a` e não representa execução remota de CI.

### 13/09/2026, atalhos por sistema da tarefa 5.12 concluídos localmente

`lib/keys.js` passou a concentrar a leitura, o rótulo e a correspondência exata dos atalhos. CommandPalette, Workbench, SessionsPane, ExplorerPane, WorkArea, BrowserPane, Toolbar e o menu usam esse contrato. Fora do macOS, os atalhos do aplicativo ganham Shift dentro do terminal; copiar e colar aceitam Ctrl Shift C, Ctrl Shift V, Ctrl Insert e Shift Insert; Ctrl Shift Backspace apaga a linha; o explorador aceita Delete e Ctrl Shift Backspace. O editor aceita Mod Shift Backspace. No macOS, os mesmos comandos e glifos anteriores foram preservados.

Os testes começaram falhando pela ausência do módulo puro de ações do terminal e depois aprovaram oito casos em `keys.test.cjs`. O preview do navegador também revelou `networkIsConfigured` recebendo `null`; o caso regressivo em `tunnel-model.test.cjs` falhou com `TypeError` antes da correção e passou depois que o normalizador aceitou ausência de configuração.

O cache do Playwright estava vazio e a preferência do VS Code apontava para a revisão removida 1228. Como o disco tinha 4,2 GiB livres, abaixo do piso operacional, `npm run sidecar --workspace @cialai/desktop` foi executado e `CARGO_BUILD_JOBS=2 cargo clean --manifest-path apps/desktop/src-tauri/Cargo.toml` removeu somente artefatos gerados do `target` da main. Com 8,2 GiB livres, `PLAYWRIGHT_BROWSERS_PATH="$HOME/Library/Caches/ms-playwright" npx --yes playwright install chromium` instalou Chrome for Testing e Chrome Headless Shell 153.0.8010.12, revisão 1243. A preferência `devBrowserPanel.chromiumPath` foi atualizada para esse executável e os dois binários responderam à consulta de versão.

No Dev Browser Panel indicado pelo usuário, porta 64552, a URL exata `?platform=windows` renderizou com `data-platform="windows"` e sem exceções. As demos Windows e Linux exibiram rótulos Ctrl Shift. No terminal Windows, Ctrl F não abriu a busca do aplicativo e Ctrl Shift F abriu. A demo sem `platform` detectou macOS e mostrou ⌘, ⇧, ⌃ e ⌥, inclusive na paleta aberta por ⌘K. As capturas temporárias ficaram em `~/.dev-browser/tmp/cialai-5-12-windows-palette.png`, `cialai-5-12-linux-demo.png`, `cialai-5-12-macos-demo.png` e `cialai-5-12-macos-palette.png`.

`npm run test:ui` terminou com código 0, com 17 casos de sincronização e 54 testes Node. `npm run build:ui --workspace @cialai/desktop` terminou com código 0, gerou as duas entradas e validou o recurso móvel com 130 assets. `git diff --check` também passou. O override de plataforma só é aceito fora do Tauri. Essa evidência não representa compilação ou execução nativa em Windows ou Linux.

### 13/09/2026, janela por sistema da tarefa 5.11

`window.rs` virou `window/mod.rs`, com a coreografia comum de abertura e um backend por sistema escolhido por `cfg`. `macos.rs` conserva `setFrame_display` e a vibrancy de sidebar sem mudança de comportamento. `windows.rs` move a janela sem moldura com um `SetWindowPos` por quadro, em pixels físicos, com `SWP_NOZORDER` e `SWP_NOACTIVATE`; o quadro vem de `outer_position` e `outer_size` e a área útil, de `work_area`. O Mica só é aplicado com `backdrop` automático a partir do build 22621, lido por `RtlGetVersion`, e a falha fica apenas registrada. `generic.rs` anima posição e tamanho interno no X11; no Wayland nativo, detectado por `WAYLAND_DISPLAY` sem `GDK_BACKEND` iniciado por `x11`, a abertura fica onde o compositor decidir e a janela salta direto ao tamanho final. A geometria passou a receber a origem do eixo vertical, porque o AppKit conta de baixo e Windows e X11 contam do topo. `window-vibrancy` ficou restrito a macOS e Windows, sem mudança no `Cargo.lock`.

Na interface, `window-chrome.js` define por sistema a menubar nativa, o botão de menu, os controles próprios, os semáforos e a guarda do Escape. O Windows ganhou `WindowControls.jsx` com minimizar, maximizar ou restaurar e fechar por `windowControls` de `native.js`; a capability `window-controls.json` concede somente `allow-minimize` e `allow-toggle-maximize` na plataforma Windows. Linux e Windows ganharam o botão de menu da toolbar com as ações da menubar do macOS e os rótulos do contrato da 5.12. O espaçador dos semáforos e a reserva de 82 px da toolbar ficaram sob `data-platform="macos"`; o novo `platform.css` alinha a marca ao centro da toolbar e desenha os controles do Windows.

Os testes vieram primeiro. `tools/check/desktop-window.mjs` falhou em `window/mod.rs` ausente, e os cinco testes Rust novos não compilaram por falta de `Origin`, `logical_rect`, `physical_rect`, `is_wayland_session` e `mica_supported`. Depois da implementação os dois passaram. A guarda entrou no `npm test` como `check:window`.

Comandos concluídos com código 0:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm run sidecar --workspace @cialai/desktop
node tools/check/desktop-window.mjs
CARGO_TARGET_DIR=~/.cache/cialai-target cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --lib -j 2 window::
CARGO_TARGET_DIR=~/.cache/cialai-target cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -j 2 -- -D warnings
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
PATH="$SCRATCHPAD/xwin-shim:$PATH" CIALAI_SKIP_WINDOWS_RESOURCES=1 CARGO_TARGET_DIR=~/.cache/cialai-target cargo-xwin clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets --locked -j 2 -- -D warnings
node tools/build-tunnel.mjs --target aarch64-unknown-linux-gnu
docker build --memory 6g --tag cialai-linux-desktop:agente-a - < tools/docker/linux-desktop.Dockerfile
docker run --rm --memory 6g --memory-swap 6g --cpus 2 -v "$PWD:/workspace" -v cialai-a-linux-target:/target -v cialai-a-cargo-registry:/root/.cargo/registry -e CARGO_TARGET_DIR=/target -e CARGO_BUILD_JOBS=2 -e CARGO_INCREMENTAL=0 -e CARGO_PROFILE_DEV_DEBUG=0 -e CARGO_PROFILE_TEST_DEBUG=0 cialai-linux-desktop:agente-a bash -lc 'rustup component add clippy rustfmt; cd /workspace/apps/desktop/src-tauri; cargo test --locked --lib -j 2 window::; cargo clippy --locked --all-targets -j 2 -- -D warnings'
npm run test:ui
npm run build:ui --workspace @cialai/desktop
git diff --check
```

Resultados: onze testes de janela passaram no macOS arm64 e os mesmos onze passaram no Ubuntu 22.04 arm64 em contêiner com 6 GiB, em 4 min 22 s de compilação; o Clippy do Linux levou 1 min 26 s. O Clippy com `-D warnings` passou no macOS, no Linux e no alvo `x86_64-pc-windows-msvc`, e o arquivo de dependências confirmou `window/windows.rs` nessa checagem. O `cargo-xwin` passou a exigir `llvm-lib` para o `ring`, que entrou com o atualizador depois da 5.15 e não existe neste Mac; como o Clippy não liga binários, um shim temporário no scratchpad só criou os arquivos estáticos pedidos, e nada no repositório depende dele. A imagem foi construída sem enviar o repositório como contexto. A suíte UI passou 17 casos de sincronização e 56 testes Node, e o build Vite validou o recurso móvel com 130 assets.

No Dev Browser Panel da porta 64556, lida de `.dev-browser-panel/port` desta sessão, abas novas não receberam renderizador, então o ensaio reutilizou uma aba parada que apontava para um Vite 1420 desligado e serviu a interface num Vite próprio na porta 1431. Em 1440 por 960, `?platform=windows&terminais=demo` mostrou os três controles com 46 por 52 px encostados na borda direita, o botão de menu com catorze ações e rótulos Ctrl Shift, a marca a 16 px do topo e o espaçador com altura zero. `?platform=linux` mostrou o menu sem controles próprios. Sem o parâmetro, o macOS manteve o espaçador de 52 px e não mostrou menu nem controles. Não houve exceções nem overflow horizontal. As capturas ficaram em `~/.dev-browser/tmp/cialai-5-11-windows-window.png`, `cialai-5-11-windows-menu.png`, `cialai-5-11-linux-window.png`, `cialai-5-11-linux-menu.png` e `cialai-5-11-macos-window.png`. Elas também mostram que Linux e Windows ainda não recebem os tokens de `macos.css`, trabalho da 5.13.

Nenhuma janela nativa Linux ou Windows foi aberta. X11, Wayland, Mica, `SetWindowPos`, as bordas de redimensionamento e os controles do Windows continuam dependentes de execução nos sistemas correspondentes.

### 13/09/2026, CSS e fontes por sistema da tarefa 5.13

A camada visual deixou de depender de `data-platform="macos"`. `shell.css` nasceu de `macos.css` por transformação mecânica: todos os seletores da casca passaram a valer em `:is([data-shell="desktop"],[data-platform="macos"])`, o que aplica tokens, casca, componentes e estúdio em Linux e Windows e mantém o mesmo resultado na fixture do celular, que marca a plataforma macOS. Ficaram restritos ao macOS somente o espaçador dos semáforos, a reserva de 82 px da toolbar e `-webkit-font-smoothing`. `Terminais.css` recebeu a mesma troca nos nove seletores. `macos.css` virou apenas `@import './shell.css'`, porque a página do celular pertence a outra frente e ainda importa esse caminho; a entrada desktop importa `shell.css` e depois `platform.css`.

`platform.css` define `--mac-font` e `--mac-font-mono` por sistema com as pilhas do documento 04: San Francisco e SF Mono no macOS, Segoe UI Variable e Cascadia no Windows e fonte do sistema com JetBrains Mono, Fira Code, DejaVu e Noto no Linux. A JetBrains Mono 2.304, com Regular e Bold em WOFF2 e a licença OFL, veio do arquivo oficial `JetBrainsMono-2.304.zip` da release do GitHub, SHA-256 `6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf`, e está em `packages/ui/src/fonts` como `Cialai JetBrains Mono`, último recurso antes do genérico no terminal Linux. O tema MUI passou a usar `var(--mac-font)`. O atributo `switch`, exclusivo do WebKit do macOS, deu lugar ao interruptor `.mac-switch` desenhado em CSS sobre um checkbox, sem uso ainda nesta tarefa.

`tools/check/platform-css.mjs` foi escrito antes e falhou com `shell.css ausente`. Depois da implementação passou, cobrindo o escopo dos seletores, os três seletores restritos ao macOS, o import de compatibilidade, as pilhas exatas por sistema, os arquivos WOFF2 e a licença, `.mac-switch` e o tema MUI. A guarda entrou no `npm test` como `check:platform-css`; `check:window` passou a ler `shell.css`.

Comandos concluídos com código 0:

```sh
curl -fsSL -o jbm.zip https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip
shasum -a 256 jbm.zip
node tools/check/platform-css.mjs
node tools/check/desktop-window.mjs
npm run test:ui
npm run build:ui --workspace @cialai/desktop
git diff --check
```

Resultados: a suíte UI passou 17 casos de sincronização e 56 testes Node. O build Vite gerou `JetBrainsMono-Regular` com 92,16 kB e `JetBrainsMono-Bold` com 94,59 kB, manteve os 434 seletores ampliados no CSS minificado da entrada desktop e do recurso móvel e validou o recurso móvel com 130 assets.

No Dev Browser Panel da porta 64556, com o mesmo Vite na porta 1431 e a demo de terminais em 1440 por 960, Windows, Linux e macOS foram conferidos nos temas claro e escuro. Os três sistemas receberam `--mac-bg` do tema, o padding de 52 px da área do estúdio e as mesmas posições das colunas de sessões, trabalho e arquivos. As fontes computadas foram as pilhas de cada sistema; no Linux as duas faces da `Cialai JetBrains Mono` carregaram, o que prova o caminho do arquivo empacotado. Um `.mac-switch` de prova mediu 32 por 18 px, sem aparência nativa e com o acento do tema. Não houve exceções nem overflow. Na entrada `mobile.html` em 393 por 852, a página continuou sem tokens sem o atributo de plataforma, como antes, e recebeu fundo, fonte e suavização ao marcar a plataforma macOS como a fixture faz. As capturas ficaram em `~/.dev-browser/tmp/cialai-5-13-windows-light.png`, `cialai-5-13-windows-dark.png`, `cialai-5-13-linux-light.png`, `cialai-5-13-linux-dark.png`, `cialai-5-13-macos-light.png` e `cialai-5-13-macos-dark.png`.

A conferência usou Chromium com a plataforma simulada. A renderização em WebKitGTK e WebView2, a disponibilidade real de Segoe UI Variable, Cascadia e das fontes Linux e o `:has()` de `Terminais.css`, que exige WebKitGTK 2.40, continuam dependentes dos sistemas correspondentes.

### 13/09/2026, preferências por sistema da tarefa 5.14

Preferências passou a mudar opções, textos e caminhos conforme o sistema. `preferences-model.js` ganhou `platformPreferenceHints`, que devolve para macOS, Linux e Windows o exemplo de shell, a explicação do padrão aplicado pelo Rust, os argumentos conforme o sabor POSIX, PowerShell ou cmd, o exemplo e a explicação dos prefixos do PATH, o exemplo do Chromium, os filtros do seletor de arquivo, o rótulo do gerenciador de arquivos e os caminhos de preferências, dados e registros. No Windows o campo `LANG` some, porque o Rust não define essa variável lá, e o seletor do Chromium aceita somente executáveis. A seção Janela aparece só no Windows, com o `.mac-switch` da 5.13 para ligar o Mica com fundo automático ou deixá-lo sólido. A seção Arquivos do aplicativo mostra os caminhos reais devolvidos pelo comando novo `app_paths`, com o botão Mostrar no Finder, no Explorer ou em Arquivos; fora do app ela mostra os locais documentados do sistema.

No Rust, `WindowPreferences::backdrop` aceita somente `auto` e `solid` e trata o resto como automático, com a mesma normalização no modelo JavaScript. `set_preferences` reaplica o fundo na janela principal quando ele muda, e `window::apply_backdrop` chama `apply_mica` ou `clear_mica` no Windows a partir do build 22621 e não faz nada no macOS e no Linux. `AppPaths` usa `app_config_dir`, `app_data_dir` e `app_log_dir` em barras portáveis.

Os testes vieram primeiro. `tools/check/platform-preferences.mjs` falhou na ausência de `BACKDROPS`, e os três testes Rust novos não compilaram por falta de `BACKDROP_AUTO`, `BACKDROP_SOLID`, `WindowPreferences::backdrop`, `wants_mica` e `AppPaths`. Depois da implementação os dois passaram. A guarda entrou no `npm test` como `check:platform-preferences`.

Comandos concluídos com código 0:

```sh
node tools/check/platform-preferences.mjs
node tools/check/platform-css.mjs
node tools/check/desktop-window.mjs
npm run test:ui
CARGO_TARGET_DIR=~/.cache/cialai-target cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --lib -j 2 -- window:: prefs:: app_path
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
CARGO_TARGET_DIR=~/.cache/cialai-target cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -j 2 -- -D warnings
PATH="$SCRATCHPAD/xwin-shim:$PATH" CIALAI_SKIP_WINDOWS_RESOURCES=1 CARGO_TARGET_DIR=~/.cache/cialai-target cargo-xwin clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets --locked -j 2 -- -D warnings
docker run --rm --memory 6g --memory-swap 6g --cpus 2 -v "$PWD:/workspace" -v cialai-a-linux-target:/target -v cialai-a-cargo-registry:/root/.cargo/registry -e CARGO_TARGET_DIR=/target -e CARGO_BUILD_JOBS=2 -e CARGO_INCREMENTAL=0 -e CARGO_PROFILE_DEV_DEBUG=0 -e CARGO_PROFILE_TEST_DEBUG=0 cialai-linux-desktop:agente-a bash -lc 'cd /workspace/apps/desktop/src-tauri; cargo test --locked --lib -j 2 -- window:: prefs:: app_path; cargo clippy --locked --all-targets -j 2 -- -D warnings'
git diff --check
```

Resultados: dezoito testes Rust passaram no macOS arm64 e os mesmos dezoito no Ubuntu 22.04 arm64 em contêiner, entre janela, preferências e caminhos do aplicativo. O Clippy com `-D warnings` passou no macOS, no Linux e no alvo `x86_64-pc-windows-msvc`, com os artefatos do crate atualizados nos dois alvos locais. A suíte UI passou 17 casos de sincronização e 56 testes Node.

No Dev Browser Panel da porta 64556, com o Vite na porta 1431, as Preferências abertas pela toolbar mostraram no Windows as seções Aparência, Terminal, Projetos, Rede, Dev Browser, Janela, Arquivos do aplicativo e Atualizações, com `pwsh.exe`, `-NoLogo`, `C:\Tools\bin`, o Chrome em Program Files, nenhum campo `LANG` e os caminhos em `%APPDATA%` e `%LOCALAPPDATA%`. O interruptor do Mica começou ligado, mudou para desligado com um clique e habilitou Salvar alterações. Linux mostrou `/bin/bash`, `-l`, `C.UTF-8`, `~/.local/bin`, `/usr/bin/chromium` e os caminhos XDG, sem a seção Janela. macOS mostrou `/bin/zsh`, `-l`, `pt_BR.UTF-8`, `/opt/homebrew/bin`, o Chromium em Aplicativos e os caminhos em Library, também sem a seção Janela. O texto visível não teve parênteses nem traços como separadores e não houve exceções. As capturas ficaram em `~/.dev-browser/tmp/cialai-5-14-windows-preferences.png`, `cialai-5-14-linux-preferences.png` e `cialai-5-14-macos-preferences.png`.

O comando `app_paths`, o botão de revelar e a troca do Mica ao salvar não foram executados no aplicativo nativo de Linux ou Windows; no navegador eles mostram os locais documentados.

### 13/09/2026, ordem do CSS no build de produção após as tarefas 5.11 e 5.13

A primeira captura real do WebKitGTK, feita pelo self test Linux da tarefa 5.18, mostrou a sidebar e o acento no azul herdado do Control. O Vite dev não reproduzia o problema. No build de produção, o CSS importado pelas duas entradas HTML vai para um chunk carregado antes do `main.css`: `styles.css` e `brand.css` ficavam nesse chunk, enquanto `shell.css` e `platform.css`, agora exclusivos da entrada desktop, ficavam em `main.css`. Com a mesma especificidade, os tokens da casca venciam a marca. O import estático de `Terminais.css` pelo botão de menu da 5.11 também antecipava essa folha em relação à casca. Os três sistemas eram afetados, inclusive o macOS.

A entrada desktop passou a importar somente `packages/ui/src/desktop/desktop.css`, que importa base, casca, sistema, marca e estúdio nessa ordem. A página do celular não mudou. `tools/check/css-cascade.mjs` lê o `dist` na ordem dos links do `index.html` e exige que a última definição de `--mac-accent` e `--mac-sidebar-bg` seja a da marca nos temas claro e escuro e que a regra do estúdio sobre `.mac-content` venha depois da casca. Ela entrou no `npm test` como `check:css-cascade`, logo depois de `test:desktop`, que gera o `dist`. `check:platform-css` e `check:window` passaram a conferir `desktop.css`.

A checagem foi escrita antes da correção e falhou no `dist` existente com `--mac-accent` efetivo `#1a4fa0`. Depois dela passou. `npm run build:ui --workspace @cialai/desktop` gerou `Terminais.css` e `main.css` como as duas folhas da entrada desktop e validou o recurso móvel com 130 assets. O `dist` servido em `127.0.0.1:1432` e aberto no Dev Browser Panel da porta 64556 mostrou acento `#E23B84`, sidebar do rosa claro ao branco, a fonte de cada sistema e o padding de 52 px do estúdio em Linux, Windows e macOS, sem exceções. No binário Linux, a captura seguinte do self test já trouxe a identidade rosa. As capturas estão em `~/.dev-browser/tmp/cialai-css-order-prod-linux.png`, `cialai-css-order-prod-windows.png` e `cialai-css-order-prod-macos.png`.

Comandos concluídos com código 0 depois da correção:

```sh
node tools/check/platform-css.mjs
node tools/check/desktop-window.mjs
npm run build:ui --workspace @cialai/desktop
node tools/check/css-cascade.mjs
git diff --check
```

### 13/09/2026, nightly e self test multiplataforma da tarefa 5.18

`.github/workflows/nightly-e2e.yml` roda todo dia às 05:17 UTC e por disparo manual, sem push, PR ou secrets. A matriz `ubuntu-22.04` e `windows-2022` instala as dependências do desktop, `webkit2gtk-driver` e `xvfb` no Linux, Node, npm 10.9.8, Rust 1.98.1 e Go, executa `npm ci`, instala `tauri-driver` 2.0.6 e, no Windows, baixa o Edge WebDriver da versão exata do WebView2 lida no registro. Depois compila o sidecar e o app de depuração sem bundle, roda o self test, sob Xvfb no Linux, e anexa as evidências mesmo quando falha. O macOS continua no `npm run test:selftest` por `tauri dev`, porque o `tauri-driver` não tem driver para WKWebView.

`tools/selftest/driver.mjs` usa só módulos nativos do Node: sobe o `tauri-driver`, cria a sessão WebDriver com `tauri:options`, navega para a mesma origem do app com `?cialai_selftest=1`, espera `selftest.json` em `app_log_dir` ou lê o resultado pela página e copia relatório, `app.log`, log do driver e capturas a cada 3 s. `tools/selftest/common.mjs` concentra caminho do relatório por sistema, binário de depuração, URL, capacidades e argumentos. Os dois runners escolhem uma porta livre para `CIALAI_BRIDGE_PORT`, porque a porta padrão 3720 estava ocupada pelo Ordinum Control aberto na máquina, e recusam um `CARGO_TARGET_DIR` fora de uma pasta chamada `target`, onde o Tauri não encontra os recursos e o app aborta no setup. Os dois casos apareceram nas primeiras execuções reais.

`tools/selftest/portable.js` e `selftest-app.js` tornaram o roteiro portátil. O PTY usa `printf`, `Write-Output` ou `echo` conforme o sabor, sem digitar o marcador literal, espera o primeiro texto do shell e repete o comando até três vezes, porque o bash às vezes descartou a digitação feita antes de ler a linha. O caminho arrastado é conferido pela citação de `shellQuote` do shell da sessão, e a sujeira filtrada muda por sistema. O arraste passou a conferir o destaque do próprio alvo: o terminal marca `is-dropping`, e o roteiro original procurava `is-drop`, passando só quando o destaque da árvore aparecia no caminho do mouse. O alvo é o terminal da sessão do teste. O relatório passou a trazer sistema e sabor do shell.

`tools/check/nightly-e2e.mjs`, no estilo de `ci-matrix.mjs`, foi escrito antes e falhou pela ausência do workflow. Ele confere gatilhos, permissões, matriz, dependências, versões fixadas, ordem dos passos, evidências e ausência de secrets, e testa os auxiliares puros do runner e do roteiro. Cada ajuste nascido das execuções reais ganhou antes a asserção correspondente. A guarda entrou no `npm test` como `check:nightly`, e `test:selftest:driver` chama o runner novo.

Comandos concluídos com código 0:

```sh
node tools/check/nightly-e2e.mjs
node tools/check/selftest.mjs
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/nightly-e2e.yml")'
CARGO_TARGET_DIR=~/.cache/cialai-target/target CARGO_BUILD_JOBS=2 CARGO_PROFILE_DEV_DEBUG=0 npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm run test:selftest
npm run build:ui --workspace @cialai/desktop
node tools/build-tunnel.mjs --target aarch64-unknown-linux-gnu
docker run -d --name cialai-a-linux-e2e --memory 6g --memory-swap 6g --cpus 2 --shm-size 1g -v "$PWD:/workspace" -v cialai-a-linux-target:/target -v cialai-a-cargo-registry:/root/.cargo/registry -e CARGO_TARGET_DIR=/target -e CARGO_BUILD_JOBS=2 -e CARGO_INCREMENTAL=0 -e CARGO_PROFILE_DEV_DEBUG=0 cialai-linux-desktop:agente-a sleep infinity
docker exec cialai-a-linux-e2e bash -lc 'apt-get install -y --no-install-recommends webkit2gtk-driver xvfb xauth dbus dbus-x11 fonts-dejavu-core'
docker exec cialai-a-linux-e2e bash -lc 'cargo install tauri-driver --locked --version 2.0.6 --root /target/tools'
docker exec cialai-a-linux-e2e bash -lc 'cd /workspace/apps/desktop/src-tauri && cargo build --locked -j 2 --features tauri/custom-protocol'
docker exec cialai-a-linux-e2e bash -lc 'cd /tmp && npx --yes playwright@1.63.0 install --with-deps chromium'
docker exec cialai-a-linux-e2e bash -lc 'cd /workspace && dbus-run-session -- xvfb-run -a -s "-screen 0 1920x1080x24" node tools/selftest/driver.mjs --app /target/debug/cialai-desktop --driver /target/tools/bin/tauri-driver --artifacts /workspace/target/selftest-linux-coldfinal --timeout 300'
docker rm -f cialai-a-linux-e2e
git diff --check
```

O self test real do macOS, pelo binário de `tauri dev` com o roteiro final, passou os oito itens em 4,7 s com zsh. No Ubuntu 22.04 arm64 em contêiner, com WebKitGTK 2.50.4, `tauri-driver` 2.0.6, WebKitWebDriver, Xvfb, bash e o Chromium 1243 do Playwright, o binário compilado com os assets embutidos abriu por WebDriver em `tauri://localhost`. A primeira execução, antes dos ajustes, aprovou seis itens e falhou PTY e caminho no terminal; a seguinte aprovou os oito. A captura revelou a ordem do CSS de produção descrita na entrada anterior. Depois da espera pelo terminal, uma repetição ainda falhou o PTY por digitação descartada; com as tentativas, três de cinco execuções passaram, uma delas na segunda tentativa, e duas falharam só na conferência do arraste, embora a captura mostrasse o caminho inserido. Com o destaque do próprio alvo, cinco execuções seguidas passaram os oito itens em cerca de 4,5 s cada, com sessões desconectadas acumuladas das rodadas anteriores. Por fim, um contêiner novo, sem dados do app nem cache de fontes, passou os oito itens na partida a frio, com 14,7 s de roteiro e 16,3 s no total. Nesse app a janela X11 cresceu de 440 por 320 para 1380 por 880 em 531 ms e 26 quadros pelo backend genérico da 5.11. O relatório, o `app.log`, o log do driver e quatro capturas da rodada final ficaram em `target/selftest-linux-coldfinal`, pasta ignorada pelo Git. O contêiner foi removido.

Nenhum workflow foi disparado e nada foi executado no Windows. A instalação do Edge WebDriver, o WebView2, o ConPTY com PowerShell e o roteiro nos runners do GitHub continuam dependentes da primeira execução remota; o PowerShell do workflow nem pôde ser analisado localmente, porque `pwsh` não existe neste Mac.

### 13/09/2026, espanhol no pacote compartilhado da tarefa 6.6

`@cialai/i18n` passou a declarar português do Brasil, inglês e espanhol. Variantes regionais de inglês e espanhol são normalizadas para o dicionário base e qualquer valor não reconhecido continua usando português do Brasil. O dicionário espanhol recebeu as mesmas 20 chaves existentes, com texto neutro e sem traduzir Cialai.

O teste foi escrito primeiro e falhou pela ausência de `es`. Depois da implementação, `npm run test:i18n` com Node 22.23.2 e npm 10.9.8 aprovou os três casos, incluindo paridade, normalização, troca observável e fallback fechado. `git diff --check` também passou nos arquivos do pacote.

### 12/09/2026, fonte de processos da tarefa 5.1

`workspace/procs.rs` foi dividido em `procs/mod.rs` e `procs/macos.rs`. O contrato portável usa `ProcInfo`, `ProcState`, `Usage`, `ProcSource` e `SystemProcs`; a política de limites da árvore e a identificação de agentes ficaram compartilhadas. `TerminalManager::metrics` usa a trait e o diretório pessoal já resolvido pelo Tauri. `FakeProcs` cobre árvore, duas amostras de CPU, memória, cwd e perfil do agente sem depender da tabela de processos real.

Com `CARGO_TARGET_DIR=~/.cache/cialai-target`, os testes direcionados `workspace::procs::tests::detects_agents_on_posix_and_windows_command_lines` e `workspace::terminal::tests::metrics_use_the_injected_process_source` passaram, um caso em cada execução. `cargo fmt --check` e `git diff --check` passaram. `cargo clippy --locked --all-targets -- -D warnings` chegou ao crate e falhou somente nos seis diagnósticos já registrados de `bridge/` da tarefa 2.8 parcial; não houve aviso fora de `bridge/`. Os arquivos Linux e Windows ainda eram stubs declarados nessa etapa e não contavam como backend implementado.

### 12/09/2026, backend de processos Linux da tarefa 5.2

O stub Linux foi substituído por um snapshot compartilhado de `sysinfo` 0.36.1. `/proc/<pid>/task/*/children` fornece filhos quando legível, com fallback para o mapa de pais do snapshot; `/proc/<pid>/stat` preserva grupo e estados `T` e `t`; `smaps_rollup` fornece PSS com fallback para RSS; `cwd`, argv, ambiente permitido, executável e tempo acumulado de CPU vêm do mesmo snapshot; e `fd/*` fornece os arquivos abertos. O nome prefere o basename do executável ao `comm` truncado.

No macOS, `cargo test --locked --lib workspace::procs` passou 10 casos e o teste de métricas com `FakeProcs` passou isoladamente. O Clippy com `-D warnings` voltou a apontar somente os seis diagnósticos conhecidos de `bridge/`, sem aviso no código da Fase 5. A execução real do backend ficou para o contêiner Ubuntu 22.04 da tarefa 5.15.

### 12/09/2026, backend de processos Windows da tarefa 5.3

O backend Windows usa o mesmo snapshot `sysinfo` para pais, CPU acumulada, cwd, argv, ambiente permitido, executável, início e estado. A memória prefere `PROCESS_MEMORY_COUNTERS_EX2::PrivateWorkingSetSize` e cai para o working set do `sysinfo`. A árvore une descendentes por ppid aos ids do Job Object; o primeiro plano estimado é a folha viva mais nova e nunca informa processo parado.

`platform/win_job.rs` cria um Job Object anônimo com `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, atribui o shell assim que o ConPTY nasce, mantém um registro fraco por pid e expõe membros e término da árvore. No macOS, os 10 testes de `procs` e o caso de métricas por `FakeProcs` continuaram verdes, sem alteração dos avisos conhecidos de `bridge/`. A compilação cruzada posterior está registrada na tarefa 5.15; execução nativa Windows permanece pendente.

### 12/09/2026, PTY portável da tarefa 5.4

O spawn, a descoberta do processo em primeiro plano e o encerramento saíram de `terminal.rs` para `workspace/pty/{mod,unix,windows}.rs`. No Unix, o encerramento forçado usa `SIGKILL`; no Windows, cada ConPTY conserva o Job Object criado na 5.3 e a segunda etapa termina a árvore inteira depois dos 400 ms de graça. `TestShell` seleciona `/bin/sh` sem perfil no Unix e `%COMSPEC% /Q` no Windows, com comandos portáveis de saída e carga de CPU. As métricas atualizam `ProcSource` antes de estimar a folha em primeiro plano no Windows.

No macOS, `cargo fmt --check` e `git diff --check` passaram. Os filtros `workspace::pty`, `spawns_a_shell_streams_output_and_reports_exit`, `kill_ends_the_session` e `metrics_use_the_injected_process_source` passaram, um caso em cada execução. `cargo clippy --all-targets -- -D warnings` falhou exclusivamente nos seis diagnósticos conhecidos de `bridge/`; não houve aviso fora dessa pasta. Antes dessa validação, o preflight chegou a 4,6 GiB livres e a compilação iniciada na mesma sequência foi interrompida; `cargo clean --manifest-path apps/desktop/src-tauri/Cargo.toml -p cialai-desktop` removeu 3,1 GiB de artefatos recompiláveis do alvo compartilhado e restaurou 6,3 GiB. A validação registrada começou com 6,0 GiB livres.

### 12/09/2026, retomada por sabor de shell da tarefa 5.5

`resume_command` agora recebe `ShellFlavor`: POSIX preserva `cd` e variáveis prefixadas; PowerShell usa `Set-Location -LiteralPath` e `$env:`; cmd usa `cd /d` e `set "CHAVE=valor"`. No cmd essas variáveis intencionalmente permanecem no ambiente do shell depois que o agente encerra. `program_args` normaliza nomes sem distinguir caixa e reconhece `node.exe` e executáveis `.cmd`. O fallback necessário no Windows percorre no máximo 4096 entradas sob `<CODEX_HOME>/sessions`, ignora links, exige `session_meta` na primeira linha, cwd canônico igual e mtime não anterior ao processo, então escolhe o rollout mais recente; duas instâncias do Codex na mesma pasta permanecem uma ambiguidade documentada.

`packages/ui/src/terminals/files.js::shellQuote(path, flavor)`, que já tinha os três braços preparados, passou a também citar valores iniciados por `=` de modo coerente com o Rust. O teste Node `check-platform.mjs` passou 3/3 com Node 22.23.2. No macOS, `cargo test ... workspace::resume` passou 11/11 e `cargo fmt --check` e `git diff --check` passaram; o Clippy completo voltou a falhar somente nos seis diagnósticos conhecidos de `bridge/`, sem aviso desta tarefa. Dois preflights ficaram poucos MiB abaixo de 5 GiB depois das compilações; nenhuma compilação grande foi iniciada nessas condições. Duas limpezas limitadas ao pacote `cialai-desktop` removeram respectivamente 1,5 e 1,7 GiB de artefatos recompiláveis antes de retomar com mais de 6 GiB. PowerShell e cmd foram verificados como strings em testes portáveis, não executados no Windows.

### 12/09/2026, observador de arquivos multiplataforma da tarefa 5.6

O contrato de `workspace::watch` foi movido para um módulo comum com contagem de referências, coalescimento de 80 ms e limite de rajada de 400 ms. O backend macOS conserva kqueue e reabre o caminho depois de troca atômica. Linux e Windows usam `notify` 8, com inotify por caminho não recursivo no Linux e observação da pasta pai filtrada pelo nome no Windows.

Com 11 GiB livres e `CARGO_TARGET_DIR=~/.cache/cialai-target`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib workspace::watch` passou 2/2 no macOS, cobrindo escrita, troca atômica, remoção, coalescimento e referências. `cargo clippy --locked --all-targets -- -D warnings` chegou ao crate e falhou somente nos seis diagnósticos já registrados em `bridge/`; não houve aviso em `workspace/watch`. `cargo fmt` e `git diff --check` passaram. A tarefa 5.15 validou o backend `notify` no Ubuntu e compilou o braço Windows.

### 12/09/2026, arquivos portáveis da tarefa 5.7

Todos os caminhos estruturados devolvidos por `workspace::files` passam por `platform::to_portable`, inclusive listagem, estatística, leitura, escrita, imagem e busca. A tabela de sujeira distingue macOS, Linux e Windows; Linux acrescenta `.directory` e `.Trash-*`, enquanto Windows filtra os quatro artefatos de sistema previstos. A cópia recria links simbólicos somente no Unix. A lixeira continua nativa pelo `NSFileManager` no macOS e usa `trash` 5 no Linux e Windows, sempre devolvendo o erro `trash` sem exclusão definitiva quando o sistema recusa.

Com 11 GiB livres e `CARGO_TARGET_DIR=~/.cache/cialai-target`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib workspace::files` passou 9/9 no macOS, incluindo a lixeira real e a preservação do arquivo se ela recusasse. `node packages/ui/scripts/check-platform.mjs`, executado com Node 22.23.2 e npm 10.9.8, passou 3/3 para separadores e citações dos três shells. `cargo fmt --check` e `git diff --check` passaram. O Clippy completo falhou apenas nos seis diagnósticos conhecidos de `bridge/`. A lixeira Linux passou depois na 5.15; Windows continua sem execução.

### 12/09/2026, prévia portável da tarefa 5.8

`PreviewRoots` e o alvo servido usam `dunce::canonicalize`. O handler extrai o token tanto de `preview://<token>/<caminho>` quanto de `http://preview.localhost/<token>/<caminho>`, rejeita outras origens e conserva a verificação de contenção depois da canonização. `native.js::previewAddress` escolhe a segunda forma somente no Windows e mantém o protocolo próprio no macOS e Linux.

Com 9,9 GiB livres e `CARGO_TARGET_DIR=~/.cache/cialai-target`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --lib workspace::preview` passou 2/2. O teste serve HTML e CSS pelas duas formas, recusa caminho externo e token desconhecido e confere a decodificação percentual. `node packages/ui/scripts/check-platform.mjs` com Node 22.23.2 e npm 10.9.8 passou 4/4, incluindo as três URLs por sistema. `cargo fmt`, `git diff --check` e o código da tarefa no Clippy passaram; o Clippy completo parou somente nos seis erros conhecidos de `bridge/`. A URL Windows ainda não foi exercitada em WebView2 real.

### 12/09/2026, browser e Office portáveis da tarefa 5.9

`platform` passou a concentrar o cache do Playwright, a consulta de processo vivo, a configuração de processo auxiliar e o encerramento de reserva. O browser procura os layouts headless e completos do Playwright para macOS, Linux e Windows, depois Chrome, Chromium ou Edge instalados. O instalador usa zsh no macOS, o shell do usuário no Linux e `cmd.exe` com `npx.cmd` no Windows. No Windows, Chromium e instalador recebem `CREATE_NO_WINDOW` e Job Object. A origem local `http://tauri.localhost` entrou na lista estrita.

O LibreOffice agora é descoberto em Homebrew e aplicativos no macOS, PATH, `/usr`, `/opt` e Snap no Linux, e Program Files ou PATH no Windows. A URL do perfil emite `file:///C:/...` corretamente, o PATH usa o separador nativo, `HOME` só é definido no Unix e o processo recebe `CREATE_NO_WINDOW` no Windows. As mensagens de instalação não recomendam Homebrew fora do macOS.

Com 11 GiB livres e `CARGO_TARGET_DIR=~/.cache/cialai-target`, `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --lib workspace::browser` passou 13 casos e manteve apenas o download real ignorado. O filtro `workspace::office` passou 5 casos e manteve só a conversão real ignorada. Os testes incluem layouts artificiais Linux e Windows, URLs do Windows, instalação simulada, prazo e origens. `cargo fmt --check` e `git diff --check` passaram. O Clippy completo falhou apenas nos seis erros conhecidos de `bridge/`, sem aviso novo. Browser, instalador e LibreOffice ainda não foram executados no Linux ou Windows.

### 13/09/2026, diagnóstico e hook portáveis da tarefa 5.10

O diagnóstico resolve `app.log` pela pasta de logs do Tauri. Fora de um terminal, Unix redireciona stderr com `dup2` e Windows usa `SetStdHandle`; o hook de panic e as linhas de ciclo de vida permanecem comuns. `workspace/mobile_files.rs` inteiro ficou restrito ao Unix e os dois comandos devolvem indisponibilidade explícita no Windows até a implementação Win32 da tarefa 6.4.

O hook do Claude agora fica em `scripts/claude-statusline.py`, publica por perfil na pasta de dados própria de cada sistema, faz troca atômica e usa `fcntl` ou `msvcrt` para exclusão mútua. Os instaladores `.sh` e `.ps1` preservam uma `statusLine` própria sem `--force`, criam backup antes da alteração e oferecem `--dry-run`. O PowerShell conserva no hook o launcher realmente encontrado, inclusive `py -3` quando `python` não existe. A interface indica o instalador `.ps1` no Windows e o `.sh` no macOS e Linux. O primeiro teste detectou que uma janela `five_hour` sem `window_minutes` era ordenada depois da semana; a ordenação passou a reconhecer as durações canônicas sem mudar o rótulo Sessão.

Comandos concluídos com código 0:

```sh
python3 scripts/test-claude-statusline.py
sh -n scripts/install-claude-statusline.sh
node --test packages/ui/scripts/tests/claude-hook-help.test.cjs
npm test --workspace @cialai/ui
npm run sidecar --workspace @cialai/desktop
cargo --config build.jobs=2 fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
CARGO_TARGET_DIR=~/.cache/cialai-target cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -j 2 workspace::ai
git diff --check
```

Os seis testes Python, o caso Node do instalador, os 17 testes de sincronização e os 40 testes Node da UI passaram. A compilação Rust no macOS levou quatro minutos e os seis testes de `workspace::ai` passaram; permaneceram somente cinco avisos conhecidos de `bridge/` da tarefa 2.8 parcial. O branch da Fase 5 nasceu antes do script `sidecar`; por isso o comando obrigatório foi executado na `main` imediatamente antes de cada invocação Cargo sobre o manifesto deste worktree. Uma limpeza Cargo do alvo compartilhado removeu 5,7 GiB de artefatos recompiláveis quando o disco chegou a 4,7 GiB livres; a compilação só começou depois de recuperar 8,8 GiB. Não houve compilação nem execução Linux ou Windows nesta tarefa.

### 13/09/2026, parte Rust dos testes multiplataforma da tarefa 5.15

`TestShell` oferece escrita, saída e carga de CPU próprias para POSIX, PowerShell e cmd. Os testes de terminal deixaram de depender de `/tmp`, `zsh -f`, `printf`, `yes` e caminhos POSIX fixos. `TestChild` abre o próprio binário de testes como processo real e prova filhos, descendentes, pai, uso, cwd, ambiente permitido e redação de segredo pelo backend nativo. O supervisor usa um sidecar falso `.sh` no Unix e `.cmd` no Windows. Links dos testes de arquivos ficam restritos ao Unix.

O journal omite no ConPTY as sequências de saída sincronizada e teclado estendido não aceitas, e abre o log Windows com compartilhamento de leitura, escrita e exclusão para permitir a troca atômica durante a compactação. O snapshot de retomada recebe a pasta pessoal já resolvida pelo aplicativo em vez de depender de `HOME`. O teste do instalador do browser passou a criar o layout Playwright próprio do Unix em execução; a primeira suíte Linux encontrou o caminho macOS fixo e forneceu o teste vermelho desta correção.

No macOS, a suíte de biblioteca passou 151 casos, manteve dois ensaios externos ignorados e filtrou somente `bridge::tests::proxy_secret_marks_the_connection_as_a_device`, que ainda estava parcial na base dessa branch. Depois da correção do fixture do browser, o caso alterado passou isoladamente. O Clippy final com `-D warnings` passou em todos os alvos depois de suprimir somente `dead_code` e `clippy::too_many_arguments`, débitos então atribuídos à ponte parcial.

No Windows, `cargo-xwin` 0.23.1 e o alvo `x86_64-pc-windows-msvc` foram instalados. Uma tentativa sem desvio chegou à compilação de recursos do Tauri e parou porque `llvm-rc` não existe no macOS. O modo explícito `CIALAI_SKIP_WINDOWS_RESOURCES=1` pula apenas o build script de recursos quando o alvo contém `windows`; com ele, `cargo-xwin check --all-targets` terminou com código 0 em 3 min 58 s e os cinco avisos da ponte parcial. Isso prova compilação cruzada do código e dos testes, não execução Windows, WebView2, ConPTY nem recursos `.rc`. `macOSPrivateApi` foi movido para a configuração base porque o verificador de manifesto do Tauri exige coerência com o recurso Cargo global. O cache descartável de 1,1 GiB do SDK do `cargo-xwin` foi removido depois da prova e pode ser baixado novamente.

No Linux, o comando final usou Ubuntu 22.04 arm64, Rust 1.98.1, dois CPUs, `--memory 6g`, `--memory-swap 6g` e `--rm`. A primeira reconstrução foi interrompida quando o disco caiu a 4,9 GiB e o contêiner saiu com 137. Uma montagem somente leitura provou que o Tauri gera esquemas ao lado do manifesto; a cópia isolada apenas do crate perdeu as fixtures compartilhadas. A montagem completa encontrou um erro real no fixture Playwright, com 144 casos aprovados e um reprovado. Depois da correção, a suíte terminou com 145 aprovados, zero reprovados, dois ignorados e um filtrado. `procs` Linux, `TestChild`, `TestShell`, terminal, arquivos, lixeira, retomada, watch, browser e o sidecar falso foram executados. O contêiner foi removido e o `linux-schema.json` ignorado, criado somente pelo build, também foi removido.

Comandos concluídos com código 0:

```sh
npm run sidecar --workspace @cialai/desktop
CARGO_TARGET_DIR=~/.cache/cialai-target cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --lib -j 2 -- --skip bridge::tests::proxy_secret_marks_the_connection_as_a_device
CIALAI_SKIP_WINDOWS_RESOURCES=1 CARGO_TARGET_DIR=~/.cache/cialai-target cargo-xwin check --manifest-path apps/desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --all-targets --locked -j 2
docker run --rm --name cialai-rust-linux-fase5 --memory 6g --memory-swap 6g --cpus 2 --tmpfs /var/lib/apt/lists:rw,size=128m --tmpfs /var/cache/apt:rw,size=512m -v '/Users/focoamorim/Github Projects/OrdinumTeam/cialai-lane-b:/workspace' ubuntu:22.04 bash -lc 'apt-get update; apt-get install -y --no-install-recommends ca-certificates curl build-essential pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf libxdo-dev libssl-dev zsh; curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain 1.98.1 --profile minimal; source /root/.cargo/env; CARGO_TARGET_DIR=/tmp/cialai-target CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0 cargo test --manifest-path /workspace/apps/desktop/src-tauri/Cargo.toml --locked --lib -j 2 -- --skip bridge::tests::proxy_secret_marks_the_connection_as_a_device'
CARGO_TARGET_DIR=~/.cache/cialai-target cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --lib -j 2 workspace::browser::tests::install_reports_progress_and_leaves_the_binary
cargo --config build.jobs=2 fmt --manifest-path apps/desktop/src-tauri/Cargo.toml
CARGO_TARGET_DIR=~/.cache/cialai-target cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --locked --all-targets -j 2 -- -A dead_code -A clippy::too_many_arguments -D warnings
git diff --check
```

A parte Playwright de `tools/browser/run-browser-checks.mjs` não pertenceu a esta entrega Rust. A execução Windows nativa e a matriz remota continuam pendentes.

### 13/09/2026, matriz local de CI da tarefa 5.16

O job `desktop` de `.github/workflows/ci.yml` usa a matriz `ubuntu-22.04`, `windows-2022` e `macos-14`, com falha rápida desativada e prazo de 60 minutos. Rust 1.98.1 recebe rustfmt e Clippy, Go segue o `go.mod` e Node segue `.nvmrc` com npm 10.9.8. Ubuntu instala as dependências Tauri e WebKitGTK previstas no documento 10. `CARGO_BUILD_JOBS=2` mantém o limite das compilações Rust também nos runners.

Depois de `npm ci`, cada sistema compila seu sidecar antes de `npm test`. Somente com a suíte verde o workflow chama o build Tauri sem credenciais. `actions/upload-artifact@v4` exige pelo menos um arquivo e cobre dmg, AppImage, deb, rpm, nsis e msi sob nomes distintos por sistema e arquitetura. Não há referência a `secrets` nesse workflow de push e PR.

`tools/check/ci-matrix.mjs` fixa localmente os três runners, as oito dependências Linux, toolchains, ordem sidecar, suíte e bundle, limite de jobs e seis grupos de artefatos. A guarda foi adicionada a `npm test`. O teste foi escrito antes da mudança e falhou inicialmente em `libwebkit2gtk-4.1-dev`, então passou com a matriz nova. O parser YAML do Ruby também aceitou o arquivo.

Comandos concluídos com código 0:

```sh
node tools/check/ci-matrix.mjs
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/ci.yml"); puts "PASS yaml"'
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm run check:ci
git diff --check
```

Nenhuma execução remota foi iniciada e nenhum artefato foi publicado. A parte `release.yml` da tarefa 5.16 não estava no escopo desta entrega da matriz e segue pendente. Os passos Playwright e `check:text` serão ligados depois que seus scripts existirem; até lá o workflow executa apenas comandos reais do repositório.

### 13/09/2026, documentação por sistema da tarefa 5.19

O README deixou de descrever crates vazios e passou a trazer preparação comum e instruções próprias para macOS, Ubuntu 22.04 e Windows. O novo documento `14-diferencas-por-plataforma.md` consolida diferenças de janela, menu, fontes, shell, processos, atalhos, caminhos, Dev Browser, LibreOffice e empacotamento. O índice aponta para essa referência.

A tabela de evidências separa execução nativa, teste em contêiner e cross check. Windows continua explicitamente sem execução nativa, recursos do bundle, WebView2, ConPTY, instaladores ou assinatura validados. Linux visível, CI remota e instaladores também não foram promovidos a aprovados.

`tools/check/platform-docs.mjs` foi escrito primeiro e falhou porque o guia ainda não existia. Depois da documentação, a guarda passou cobrindo as três seções de preparo, os comandos comuns, o índice e os principais contratos por sistema.

Comandos concluídos com código 0:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm run check:platform-docs
git diff --check
```

Com isso, a parte Rust da branch `fase-5/rust-multiplataforma`, formada pelas tarefas 5.10, parte Rust da 5.15, matriz da 5.16 e 5.19, ficou pronta para merge.

### 13/09/2026, soak local do proxy da tarefa 0.11

Criada em `packages/tunnel-core/soak` uma suíte Go opt-in com duração e intervalo configuráveis. Ela sobe o proxy real sobre loopback, mantém oito WebSockets, usa quadros binários de 1 MiB em rajadas agregadas de 50 MiB, confere o eco byte a byte e registra RSS, heap, goroutines, conexões da borda e desconexões observadas pelo cliente do proxy. `go test -mod=readonly ./soak` e `go vet -tags=soak ./soak` passaram. Um smoke posterior de 2 segundos também passou com a versão final da contagem por socket.

Execução real concluída com código 0:

```sh
CIALAI_SOAK_DURATION=30m CIALAI_SOAK_BURST_INTERVAL=10s \
CIALAI_SOAK_REPORT="$PWD/build/soak/proxy-soak-30m.json" \
go test -tags=soak -count=1 -run '^TestProxySoak$' -timeout=35m -v ./soak
```

O teste durou 1.800,064 segundos. Depois de uma rajada de aquecimento, foram 180 rajadas medidas, 9.000 quadros e 9.437.184.000 bytes enviados e ecoados. Houve oito conexões aceitas, zero desconexões atribuídas ao proxy e zero erros inesperados no backend. O RSS começou em 49.299.456 bytes, terminou em 62.767.104, atingiu 63.569.920 e cresceu 13.467.648. O heap começou em 2.459.656 bytes, terminou em 1.673.648, atingiu 2.720.568 e não apresentou crescimento final. O relatório completo local está no caminho ignorado `packages/tunnel-core/build/soak/proxy-soak-30m.json`. O soak de 24 horas não foi executado e continua obrigatório para aceitar o spike 8.

### 13/09/2026, runner Linux do Dev Browser da tarefa 6.1

Adicionados `tools/docker/linux-desktop.Dockerfile` e `tools/test-linux-browser.sh`. A imagem fixa Ubuntu 22.04, Rust 1.98.1 e Node 22.23.2, instala as bibliotecas de compilação do Tauri e aceita `amd64` e `arm64`. O runner usa `docker build --memory 6g`, `docker run --rm --memory 6g`, `CARGO_TARGET_DIR=/root/.cache/cialai-target-d` e Cargo com `-j 2`. Ele executa os testes de `workspace::browser`, incluindo a descoberta Linux simulada, e depois o teste ignorado que baixa e descobre um Chromium real pelo Playwright. O teste simulado do instalador também passou a criar o layout correto no Linux.

A imagem foi construída de verdade em Docker Desktop arm64. A construção reduziu o espaço livre do host de 8,6 GiB para 1,4 GiB; antes de iniciar Cargo, a imagem e o cache criados nesta raia foram removidos e o reclaim do Docker elevou o espaço para 5,2 GiB. O espaço voltou a 4,2 GiB por atividade externa. O preflight incorporado ao runner então terminou com código 2 e `Espaço livre abaixo de 5 GiB`, sem iniciar uma compilação grande. Assim, nenhum teste Rust ou download real do Playwright rodou no Linux e nada foi validado no Windows.

Antes de qualquer comando Cargo desta raia, `npm run sidecar --workspace @cialai/desktop` foi executado com Node 22.23.2 e npm 10.9.8. O sidecar arm64 do macOS foi criado com 19,9 MiB e SHA-256 `3ed3418600f789d9749c567d840dc21f5aa66d3de50f5c393e1b57206714c3f1`. `cargo fmt`, sem compilação, e `git diff --check` passaram. O código está preparado; o comportamento Linux e Windows não está verificado.

### 13/09/2026, conversão Office da tarefa 6.2

Adicionados uma fixture RTF mínima e `tools/test-office-conversion.sh`. No macOS, o script descobre `soffice`, converte em diretório temporário e exige conteúdo não vazio com assinatura `%PDF`. A execução real com `/opt/homebrew/bin/soffice` terminou com código 0 e produziu PDF de 17.799 bytes; o temporário foi removido pelo próprio runner.

No Linux, o mesmo script prepara um contêiner efêmero Ubuntu 22.04, instala `libreoffice-writer`, converte a fixture e valida a assinatura. O comando usa `docker run --rm --memory 6g`. A tentativa terminou no preflight com código 2 e `Espaço livre abaixo de 5 GiB`, portanto nenhum contêiner foi criado e a conversão Linux não foi executada. LibreOffice no Windows não foi executado. O runner e `sh -n` estão aprovados; só o comportamento macOS foi verificado.

### 13/09/2026, `mobile_files` Windows da tarefa 6.4

O código comum de `workspace/mobile_files.rs` ficou restrito a Unix e o novo backend `workspace/mobile_files/windows.rs` implementa as mesmas operações de lista e leitura. Cada raiz, cwd e alvo é aberto por `CreateFileW` com `FILE_FLAG_OPEN_REPARSE_POINT` e `FILE_FLAG_BACKUP_SEMANTICS`; atributos vindos do handle recusam reparse points, `GetFinalPathNameByHandleW` prova a contenção depois da resolução e `GetFileInformationByHandle` recusa arquivos com mais de um hard link. Permanecem os limites de 200 entradas, 128 KiB, texto válido e nomes ou conteúdos sensíveis.

`node tools/check/mobile-files-windows.mjs` passou e confirmou o feature do `windows-sys`, as APIs, flags, contenção final, proteção de hard links e ausência do stub indisponível. `cargo fmt` e `git diff --check` passaram. `cargo-xwin` não foi encontrado no PATH; como o host tinha somente 4,2 GiB livres, sua instalação e a compilação Windows não foram iniciadas. O backend está implementado, mas não foi compilado nem executado no Windows.

### 13/09/2026, preparação de tradução da tarefa 6.6

Criado o workspace puro `@cialai/i18n`, com normalização de locale, português do Brasil como fallback seguro, inglês como segundo idioma, interpolação fechada quando falta chave ou valor e assinatura observável para React. Os dois dicionários têm as mesmas 20 chaves. `packages/ui/src/mobile` passou a resolver por chave todos os textos visíveis de cabeçalho, conexão, aparência, navegação, estado somente leitura e abertura externa. O botão de idioma no cabeçalho alterna entre português e inglês, persiste em `localStorage` e atualiza o atributo `lang` do documento.

`apps/mobile/src/i18n.ts` expõe a mesma instância, locale detectado, troca, assinatura e tradução ao aplicativo nativo. Esta branch nasceu de `fase-5/rust-multiplataforma`, onde `apps/mobile` continha somente o manifesto; as telas React Native mantidas pela frente A não estão disponíveis para edição sem trazer trabalho de outra raia. Por isso o adaptador está pronto, mas a substituição dos textos dessas telas deve acontecer na integração da frente A. A migração do desktop continua explicitamente para depois dessa integração.

`packages/ui/scripts/check-mobile-i18n.mjs` percorre somente `packages/ui/src/mobile` e `apps/mobile`, exige paridade dos dicionários, valida chaves literais e rejeita texto JSX, propriedades acessíveis e mensagens nativas literais. Assim, as telas React Native ainda ausentes falharão no gate quando entrarem até adotarem as chaves. `npm run test:i18n` passou 3 casos, o gate passou com 20 chaves em dois idiomas e `npm run test:ui` passou os 39 casos, os 17 casos de sincronização e os checks estáticos existentes. `npm audit` informou zero vulnerabilidades.

### 13/09/2026, decisões da tarefa 0.12 e passagem da Parte B

As decisões 032 a 034 consolidam o Codemagic como ambiente de build, assinatura e distribuição para absorver os spikes móveis 1, 2, 4, 5 e 6 sem confundir pipeline verde com teste físico. Também preservam o soak de 24 horas como critério de aceite apesar do resultado verde de 30 minutos e listam as contas, credenciais, aparelhos, redes e runners ainda externos.

Esta raia não alterou `main`, não fez push e não editou outros worktrees. A integração deve preservar como pendentes o Linux do Dev Browser e Office, toda validação Windows, os aparelhos, as lojas e o soak de 24 horas. Como as telas React Native da frente A não existiam na base Rust, a frente A deve aplicar nelas as chaves de `@cialai/i18n` ao integrar; o gate novo acusa os textos restantes. A tradução do desktop fica para depois da integração da frente A.

Parte B pronta para merge

### 13/09/2026, atualizador da tarefa 7.1 preparado na frente C

Adicionados `tauri-plugin-updater` 2.11.0 e `tauri-plugin-process` 2.3.1 ao desktop e os pacotes JavaScript correspondentes à interface. Preferências mostra a versão atual, busca sob demanda, disponibilidade, progresso da transferência, instalação assinada e reinício. `tauri.conf.json` cria os artefatos do updater e aponta para `latest.json` na release mais recente do GitHub. O workflow recebe `TAURI_SIGNING_PRIVATE_KEY` e `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` somente pelos secrets.

A chave pública continua com o marcador `REPLACE_WITH_TAURI_UPDATER_PUBLIC_KEY`. `tools/release/check-updater.mjs` aprovou o contrato local e, com `--release`, falhou de propósito nesse marcador antes de qualquer build. O comando para gerar o par fora do repositório e a configuração dos secrets estão em `tools/release/README.md`.

Comandos concluídos com código 0:

```sh
node tools/release/check-updater.mjs
npm run test:ui
npm run sidecar --workspace @cialai/desktop
npm run build:mobile-resource --workspace @cialai/desktop
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --locked -j 2
git diff --check
```

Resultados: 17 casos de sincronização e 46 checks de UI passaram; o recurso móvel teve 130 assets validados; o sidecar local foi recompilado; o crate com os plugins novos compilou. A release do GitHub, a assinatura, o download de `latest.json` e a instalação de uma atualização não foram executados e continuam dependentes do usuário e da infraestrutura externa.

### 13/09/2026, documentação pública da tarefa 7.2 concluída na frente C

O README público foi reescrito em inglês com descrição, recursos, estado honesto por plataforma, execução a partir do código, Headscale próprio, mapa do repositório, privacidade, segurança e licença. Foram inspecionadas as capturas reais e fictícias da tarefa 1.11. O README usa desktop escuro, lista móvel e arquivos móveis, que continuam atuais para o estúdio mostrado. A nova interface do updater fica em Preferências e não altera esses três estados.

`CONTRIBUTING.md` agora descreve toolchains, desenvolvimento, testes, Cargo com sidecar, commits, PRs, segurança e a distinção entre código preparado e evidência externa. `SECURITY.md` mantém contato, prazo de confirmação e versões suportadas marcados como `TO BE CONFIRMED BEFORE PUBLICATION`. `CODE_OF_CONDUCT.md` foi alinhado ao Contributor Covenant 2.1 com o contato também pendente. Os três modelos de issue e o modelo de PR passaram a pedir ambiente, evidência sanitizada e classificação dos testes.

A skill `dev-browser-panel` orientou a tentativa de captura. Não havia porta local desta lane, e a porta global pertencia a outro workspace; nenhum navegador alheio foi controlado. Como o conteúdo principal não mudou desde a evidência versionada, as imagens existentes foram inspecionadas diretamente e reutilizadas. `npm run check:public-docs` terminou com código 0 e confirmou idioma, links, imagens com conteúdo real, marcadores de contato e modelos. `git diff --check` também passou. Nenhum dado privado foi aberto ou copiado.

### 13/09/2026, materiais das lojas da tarefa 7.3 preparados na frente C

Criadas políticas de privacidade em português e inglês em `docs/legal`. Elas descrevem processamento local, conexão entre aparelhos, responsabilidade da operação do Headscale, atualização manual pelo GitHub Releases, armazenamento, exclusão, permissões e contato ainda a confirmar. Os documentos distinguem dados que transitam a pedido da pessoa de coleta pela Ordinum.

`docs/stores/app-store-privacy.md` propõe a resposta sem coleta do questionário da Apple. `docs/stores/google-play-data-safety.md` propõe ausência de coleta e compartilhamento para o AAB atual. As duas propostas exigem nova auditoria dos SDKs e do binário enviado. As orientações oficiais da Apple e do Google foram consultadas e ligadas nos documentos. Nenhuma resposta foi publicada.

Os textos de loja seguem a separação do Advoris entre versão curta e longa. Há conteúdo em `pt-BR` e inglês para nome, subtítulo, promoção, descrição, novidades e campos dependentes do usuário. O check mediu 67 e 63 caracteres nas descrições breves, 1373 e 1282 nas descrições longas e 363 e 350 nas notas curtas. Todos ficam dentro dos limites registrados. O plano de capturas lista seis telas prioritárias e matrizes para iPhone, telefone Android, tablets e arte gráfica, todas pendentes do build nativo real e da interface em inglês.

Comandos concluídos com código 0:

```sh
npm run check:store-metadata
git diff --check
```

O check confirmou políticas bilíngues, marcadores de contato, respostas propostas, ausência do termo de risco nos textos de loja, limites de caracteres e tamanhos de captura. Nenhuma loja, conta, formulário, captura nativa ou política pública foi alterada.

### 13/09/2026, pacote de revisão da tarefa 7.4 preparado na frente C

`docs/review/app-review-notes-en.md` contém texto copiável em inglês com propósito, ausência de conta, conexão cifrada, passos de acesso, permissões, declaração de criptografia e campos que o usuário precisa preencher apenas no App Store Connect. O arquivo não contém o termo que o documento 10 proíbe nas notas de revisão.

`desktop-demo-runbook.md` define computador e usuário do sistema dedicados, projeto inteiramente fictício, candidato assinado, Headscale exclusivo, ensaio externo, disponibilidade diária e limpeza. Nenhuma credencial ou endereço de acesso entrou no repositório. `pairing-video-script.md` organiza em até 90 segundos o vínculo, a confirmação, o histórico, um comando, um arquivo e a revogação, com conferência quadro a quadro e registro da evidência.

Comandos concluídos com código 0:

```sh
npm run check:review-pack
rg -ni '\bvpn\b' docs/review
git diff --check
```

O primeiro comando aprovou os três documentos e seus campos obrigatórios. A busca não encontrou ocorrências e terminou sem saída, como esperado. A máquina de demonstração, o acesso remoto, a gravação, o TestFlight externo, o App Review e a produção do Play continuam pendentes do usuário. Nada foi publicado ou enviado.

### 13/09/2026, roteiro imprimível da tarefa 3.9 preparado na frente C

Criado `docs/testes/roteiro-3.9-ios.md` para uma execução por combinação de iPhone, iOS, build móvel, desktop e Headscale. A folha mantém em branco identificação, tempos, resultado, evidência, defeitos e assinaturas. Os treze cenários do documento 06 aparecem com os limites originais: modo avião, atraso, revogação, reinícios, troca de rede, segundo plano, relé, Headscale fora do ar, desvio do relógio, multiplicidade, foto do QR e permissões.

`npm run check:manual-mobile` terminou com código 0 e confirmou os treze blocos, nove limites numéricos, treze campos de resultado e o estado pendente. `git diff --check` passou. Nenhum iPhone, build interno, rede móvel, relé ou servidor externo foi usado; a tarefa 3.9 continua sem aceite físico.

### 13/09/2026, roteiro imprimível da tarefa 4.7 preparado na frente C

Criado `docs/testes/roteiro-4.7-android.md` para uma execução por combinação de aparelho Android, versão do sistema, build móvel, desktop e Headscale. A folha reproduz os treze cenários do documento 06 e acrescenta navegação pelo botão Voltar, retorno após mais de 120 segundos em segundo plano, biometria e armazenamento protegido.

`npm run check:manual-mobile` terminou com código 0 e confirmou trinta blocos pendentes nos dois roteiros, sendo dezessete do Android, seus limites numéricos e campos de resultado. `git diff --check` passou. Nenhum aparelho, AAB, rede móvel, suspensão, biometria ou servidor externo foi usado; a tarefa 4.7 continua sem aceite físico.

### 13/09/2026, procedimento da tarefa 7.5 preparado na frente C

Criado `CHANGELOG.md` em inglês com o estado não publicado da primeira versão. `docs/release-v1.md` transforma os seis itens do documento 10 em etapas de congelamento, testes, assinatura, tag, conferência de artefatos, instalação limpa, distribuição interna, submissão e recuo. As responsabilidades por chaves, contas, aparelhos, contato, capturas e aprovação estão marcadas como dependências do usuário.

`tools/release/check-release.mjs` valida a presença dos seis gates, dos seis formatos desktop, dos cinco sidecars, do atualizador e dos dois artefatos móveis. `npm run check:release` terminou com código 0 e informou seis gates documentados e seis pendentes. A execução com `--release` falhou como esperado antes de consultar versões e tag, porque nenhum gate tem evidência verificada. `git diff --check` passou. Nenhuma versão foi alterada, tag criada, chave gerada, ação remota disparada, release publicada, instalação feita ou loja acessada; a tarefa 7.5 permanece preparada, sem aceite de lançamento.

### 13/09/2026, documentação viva da tarefa 6.8 implementada na frente C

Os documentos 01 a 12 agora começam com um quadro `Estado em 13/09/2026`. Cada componente, critério, workflow, tarefa e decisão foi classificado como `Implementado`, `Preparado` ou `Pendente`, sempre pelo conteúdo desta linha. O roadmap contém estado individual para 86 tarefas e o registro contém estado individual para as 31 decisões. `docs/README.md`, a árvore real, os scripts existentes e a descrição dos workflows foram atualizados; planos ausentes como `nightly-e2e.yml`, `mobile-artifacts.yml` e as ferramentas de navegador permanecem identificados como pendentes.

`npm run check:living-docs` terminou com código 0 e confirmou os doze quadros datados, os cinco critérios de sucesso, as 86 tarefas e as 31 decisões. `git diff --check` passou. A revisão documental não aprova CI remota, Linux, Windows, builds nativos, aparelhos, assinatura, lojas ou soak.

A validação final usou Node 22.23.2 e npm 10.9.8. `npm test` da raiz terminou com código 0: todos os checks de fundação e lançamento passaram; `check-terminal-sync.mjs` aprovou 17 casos; a suíte restante da interface aprovou 46; o protocolo aprovou 9; os dois builds Vite concluíram e o recurso móvel validou 130 assets; Rust aprovou 143 testes, com 2 ensaios externos ignorados; todos os pacotes Go terminaram verdes; Jest aprovou 101 testes em 15 suítes. A guarda comum da release informou seis gates documentados e seis pendentes. Nenhum teste remoto, físico, de assinatura, publicação, loja ou soak foi executado.

A frente partiu de `ba1b828`. Durante a execução, a main avançou para `842491a` com uma correção do túnel e recebeu alterações não commitadas da frente de integração. `git merge-tree` não encontrou conflito entre as árvores commitadas de `main` e `fase-7/lancamento`; mudanças ainda não commitadas não entram nessa prova e precisam ser preservadas pela integração final.

Parte C pronta para merge

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
| `packages/ui/src/lib/keys.js`, `terminals/shortcut-actions.js` | Rótulos, combinações por sistema e ações puras dos atalhos da tarefa 5.12 |
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
| `packages/ui/src/desktop/TunnelContext.jsx`, `tunnel-model.js`, `views.js` | Estado da rede, comandos e eventos do túnel e rotas do desktop da tarefa 2.9 |
| `packages/ui/src/desktop/NetworkSetup.jsx`, `PairingDialog.jsx`, `Devices.jsx` | Assistente do Headscale, QR rotativo e gestão de dispositivos |
| `packages/ui/scripts/check-network.mjs`, `check-network-browser.js`, `tests/tunnel-model.test.cjs` | Contratos Node e check visível das telas de rede, com `?tunnel=demo&network-check=1` |
| `infra/headscale/`, `tools/check/headscale-infra.mjs` | Receita auto hospedada da tarefa 2.10 e guarda estrutural |
| `tools/build-tunnel.mjs`, `.github/workflows/release.yml`, `tools/check/release-sidecar.mjs` | Sidecar por triplo, checksums, release em rascunho e guarda da tarefa 2.12 |
| `packages/tunnel-core/integration/`, `testutil/`, `.github/workflows/headscale-integration.yml` | Fluxo de ponta a ponta com Headscale em Docker da tarefa 2.11 |
| `tools/spikes/build-mobile.mjs` | Preflight e build experimental iOS ou Android |
| `tools/spikes/README.md` | Escopo, comandos e medições pendentes dos spikes |
| `docs/evidence/control-source.json` | Commit base e hashes da origem |

## Comandos de continuidade

Na raiz, com as versões globais atuais, use o cache do npm exec:

```sh
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm ci
npm exec --yes --package=node@22.23.2 --package=npm@10.9.8 -- npm test
npm run test:spike:headscale
npm run test:integration:headscale
npm run check:source
```

`npm run dev:desktop` e `npm run build:desktop` agora também compilam o sidecar do host e geram e validam o recurso móvel da tarefa 1.5. Antes de rodar `cargo` diretamente, execute `npm run sidecar --workspace @cialai/desktop`; `npm run build:tunnel` compila os cinco alvos de release. `npm run test:selftest` executa os oito cenários no binário macOS. A página `mobile.html` existe como artefato web, mas o aplicativo móvel nativo ainda não existe. Os demais scripts futuros do documento 09 continuam sendo planejamento.

## Próxima ação

1. Resolver o destino e acesso ao repositório GitHub para executar a matriz de CI. Ainda não houve publicação, push ou alteração nas lojas.
2. Confirmar um contato de segurança e o prazo de resposta antes de anunciar uma política pública completa.
3. O usuário deve fazer o commit das oito alterações do Control conforme 0.2. Depois atualizar o inventário conscientemente, sem apagar mudanças da origem.
4. Disponibilizar Xcode completo, SDK e NDK Android e aparelhos reais. Compilar os bindings experimentais e criar os hosts nativos de teste do spike 1, ainda inexistentes.
5. Executar spikes 1 e 2, depois 4 e 5, com as medições do documento 06. Preparar revisão externa e assinatura com as contas e certificados corretos. O soak de 24 horas continua obrigatório.
6. Conferir o ícone aprovado no Dock, na barra de tarefas e nos lançadores quando os builds de cada plataforma forem executados.
7. Fase 2 com implementação e evidência local completas. Pendências reais: executar `headscale-integration.yml` e `release.yml` no GitHub, cumprir o aceite manual no macOS com um Headscale real. A validade da chave já é devolvida por `control.configure` desde o commit `842491a`.
