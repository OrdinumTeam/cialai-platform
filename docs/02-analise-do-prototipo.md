# Análise do protótipo

Inventário técnico do estúdio de terminais do Ordinum Control, em `$CONTROL`, conferido em 12/09/2026. É o contrato do que o Cialai preserva. Cada peça cita o arquivo de origem para a execução abrir o lugar certo.

## Estado em 13/09/2026

| Item do inventário | Estado | Situação atual |
| --- | --- | --- |
| Proveniência do Control | Implementado | Commit base e hashes dos oito arquivos modificados estão em `docs/evidence/control-source.json`; o Control permaneceu somente leitura |
| Extração do Rust elegível | Implementado | Código de terminal, arquivos, Git, prévias, Dev Browser, ponte e ciclo de vida está no crate Cialai e passa localmente no macOS |
| Extração da interface | Implementado | Estúdio, cascas desktop e celular e componentes compartilhados estão em `packages/ui` com checks locais |
| Remoção das áreas de negócio | Implementado | Stack, reuniões, VPN, backend Node, Python e views de negócio não fazem parte do produto |
| Adaptações de identidade e dados | Implementado | Identificadores, chaves locais, marca, preferências e diretórios Cialai substituem os do Control |
| Adaptações nativas móveis | Preparado | Swift, Kotlin e ligação gomobile estão versionados; compilação e execução nativas não foram comprovadas |
| Adaptações Linux e Windows | Pendente | O contrato permanece neste documento, mas a frente correspondente ainda não está integrada nesta linha |
| Aceite humano de paridade | Pendente | Capturas macOS existem; abertura por usuário do Control e validação nas outras plataformas não foram registradas |

As tabelas abaixo continuam sendo o contrato técnico de origem. Verbos como preservar, adaptar e construir descrevem a decisão de extração; a tabela acima registra o que de fato foi integrado nesta linha.

## Estado do repositório de origem

| Item | Valor |
| --- | --- |
| Branch | `main`; existe também `build/ios-codemagic` com a casca Expo e o CI |
| Working tree | Oito arquivos modificados sem commit: `docs/application/macos-app.md`, `docs/application/terminais.md`, `frontend/src/terminals/browser/runtime.js`, `frontend/src/terminals/runtime.js`, `frontend/src/terminals/ui/BrowserPane.jsx`, `macos/src-tauri/src/prefs.rs`, `macos/src-tauri/src/workspace/browser.rs`, `macos/src-tauri/src/workspace/office.rs` |
| Regra | A extração parte do working tree. Recomenda-se que o usuário faça commit dessas mudanças no Control antes da Fase 1, para a origem de cada arquivo ser rastreável |
| Versões | tauri 2.11.5, tauri-runtime-wry 2.11.4, wry 0.55.1, tao 0.35.3, portable-pty 0.9.0, window-vibrancy 0.8.0, objc2 0.6.4, tokio-tungstenite 0.30.0, plugins dialog 2.7.3, fs 2.5.2, opener 2.5.5, window-state 2.4.1; React 18.3, xterm 6, CodeMirror 6, Vite 5 com `target: 'safari16'`; Expo 57.0.7, React Native 0.86.3, react-native-webview 13.16.1 |

## Correção de premissa

O estúdio não tem backend Node. PTY, inspeção de processos, arquivos, Git, observador, uso do plano, LibreOffice e Dev Browser vivem em Rust dentro do app Tauri, em `macos/src-tauri/src/workspace/`. O `backend/node` só contém quatro arquivos de teste que importam módulos JavaScript puros de `frontend/src/terminals/`. O único transporte de rede é a ponte WebSocket em Rust, em `macos/src-tauri/src/bridge/`, usada pelo iPhone. O Node em `127.0.0.1:3710` serve a página do celular e as seções de negócio; no Cialai essa função passa para a borda do sidecar.

## Mapa de módulos e destino

Destinos: preservar significa copiar com renomeações; adaptar significa mudanças por sistema ou por remoção de dependências do Control; construir significa código novo.

### Rust em `macos/src-tauri/src`

| Arquivo | Linhas | Função | Destino |
| --- | --- | --- | --- |
| `workspace/terminal.rs` | 1578 | Sessões PTY por `portable-pty`, quatro threads por sessão, lotes, marca d'água, múltiplos assinantes com anel de 256 KiB e replay, concessão de largura, kill, métricas, ambiente do shell | Preservar; adaptar spawn por `ShellSpec`, Job Object no Windows, kill e primeiro plano delegados a `pty/`, `HOME` pelo Tauri |
| `workspace/procs.rs` | 718 | Árvore de processos, CPU e memória por `proc_pid_rusage`, cwd por vnode, arquivos abertos, argv e ambiente por `KERN_PROCARGS2`, detecção de 15 agentes, perfis, cache por pid e início | Preservar como backend macOS verbatim; construir backends Linux e Windows |
| `workspace/journal.rs` | 484 | `<tag>.log` com histórico bruto até 2 MiB compactado para 1 MiB, `<tag>.json` com metadados e agente, marca de shell reaberto, `TERMINAL_RESET` | Preservar; só os caminhos mudam |
| `workspace/resume.rs` | 515 | Detecção da conversa de Claude Code e Codex, listas fechadas de opções, comando de retomada citado | Preservar; adaptar por sabor de shell e reserva do Codex sem arquivos abertos |
| `workspace/files.rs` | 846 | Listar, stat, ler texto, imagem e bytes, gravar com conflito por mtime, criar, renomear, copiar, Lixeira, índice de busca, filtro de sujeira | Preservar; adaptar Lixeira por `trash`, links simbólicos só Unix, barras normais |
| `workspace/git.rs` | 298 | `git status --porcelain=v2 --branch -z` e diff limitado a 1 MiB | Preservar; resolver o binário por `which` |
| `workspace/watch.rs` | 333 | Observador kqueue com debounce de 80 ms, junção de 400 ms, evento `fs://change` | Preservar o coalescedor; construir backend `notify` |
| `workspace/mobile_files.rs` | 368 | Leitura restrita para o celular: raiz derivada da sessão, `openat` sem seguir links, 200 itens, 128 KiB, bloqueio de segredos | Preservar em Unix; Windows fica para a Fase 6 |
| `workspace/ai.rs` | 600 | Uso do plano por perfil de Claude Code e Codex, cache de 2 s, varredura a cada 15 s, validade de 6 h | Preservar; caminhos pelo Tauri |
| `workspace/browser.rs` | 1006 | Chromium headless por sessão por CDP, arquivos de porta, instalação pelo Playwright, órfãos | Preservar; adaptar descoberta de binários e processos por sistema |
| `workspace/office.rs` | 379 | `soffice` headless para PDF, cache de 512 MiB, uma conversão por vez, 2 min | Preservar; adaptar descoberta e `file_url` |
| `workspace/preview.rs` | 181 | Esquema `preview://<token>/caminho` servindo a raiz do projeto | Preservar; aceitar a forma `http://preview.localhost/` do Windows |
| `workspace/dragout.rs` | 296 | Arraste para fora pelo AppKit, evento `drag-out://end` | Preservar só no macOS; stub nos demais até a Fase 6 |
| `workspace/repos.rs` e `workspace/mod.rs` | 175 | Raízes `Github Projects/OrdinumTeam` e `OrdinumCustomers`, shell padrão `/bin/zsh` | Adaptar: raízes viram preferência; shell por sistema |
| `bridge/mod.rs`, `protocol.rs`, `dispatch.rs`, `events.rs` | 1190 | Servidor WebSocket, handshake, lista permitida, despacho ordenado, eventos | Preservar; reduzir a `pty`, exigir o segredo da borda, `welcome` estendido |
| `commands.rs` | 472 | Registro dos comandos Tauri | Preservar as seções de terminais, arquivos, Git, Dev Browser e preview |
| `lib.rs` | 234 | Plugins, estado gerenciado, esquema `preview`, ordem de encerramento | Adaptar: sem stack, reuniões e VPN; supervisor do sidecar |
| `window.rs` | 489 | Splash de 440 por 320 crescendo até 1380 por 880 em 520 ms, vibrancy, foco do webview | Adaptar por sistema |
| `lifecycle.rs` | 60 | Confirmação de saída com terminais vivos | Preservar |
| `prefs.rs` | 128 | `preferences.json` | Adaptar o esquema |
| `diagnostics.rs` | 63 | Redirecionamento de stderr para log | Adaptar por sistema |
| `stack.rs`, `meetings/*`, `vpn/*` | 4990 | Launcher dos backends, reuniões, VPN | Fora |

### Frontend em `frontend/src`

| Arquivo | Linhas | Função | Destino |
| --- | --- | --- | --- |
| `terminals/runtime.js` | 2036 | Loja de sessões no módulo, instâncias do xterm, métricas, atenção, persistência, replay, retomada, sincronização com a ponte, demo | Preservar; renomear chaves, propagar `shellFlavor`, home pela plataforma |
| `terminals/editor.js` | 663 | Abas CodeMirror 6, salvar com conflito, recarga, prévias | Preservar |
| `terminals/files.js` | 237 | Ponte de arquivos, Git e Office, utilidades de caminho, citação para o shell | Adaptar `shellQuote` por sabor e `shortPath` pelo home |
| `terminals/kinds.js` | 68 | Classificação por extensão | Preservar |
| `terminals/layout.js` | 93 | Larguras, recolhimento, proporção do editor, fonte | Preservar; renomear chave |
| `terminals/theme.js` | 76 | Tema do xterm pelos tokens | Adaptar a regra do azul |
| `terminals/drag.js` | 178 | Arraste por ponteiro, porque o HTML5 não chega à página dentro do wry | Preservar |
| `terminals/viewport.js` | 98 | Cliente da concessão de largura | Preservar |
| `terminals/restore.js`, `replay.js`, `hooks.js`, `motion.js`, `touch-scroll.js`, `phone-navigation.js` | 278 | Retomada, dedupe de replay, assinaturas de eventos, movimento, toque, rota do telefone | Preservar; renomear chave da rota |
| `terminals/ui/Workbench.jsx` | 644 | Composição do estúdio, paleta, atalhos, diálogos | Adaptar atalhos e nomes por plataforma |
| `terminals/ui/SessionsPane.jsx`, `SessionCard.jsx`, `WorkArea.jsx`, `EditorPane.jsx`, `ExplorerPane.jsx`, `BrowserPane.jsx`, `Splitter.jsx`, `Menu.jsx`, `NewSessionPopover.jsx`, `QuickOpen.jsx`, `dialogs.jsx`, `PhoneWorkbench.jsx`, `PhoneFiles.jsx` | 2810 | Painéis e componentes | Preservar; dicas de atalho e nome do gerenciador por plataforma |
| `terminals/browser/*.js` | 1198 | Cliente CDP, sessão, screencast, entrada, controlador | Preservar |
| `views/Terminais.jsx` e `Terminais.css` | 554 | Entrada da seção e todo o CSS do estúdio | Preservar |
| `desktop/*` | 2255 | Casca macOS: `DesktopApp`, `Sidebar`, `Toolbar`, `CommandPalette`, `Preferences`, `Splash`, `appearance`, `theme.macos`, `menu`, `shell-bridge`, `palette-registry`, `macos.css` | Adaptar: sem stack e reuniões, menu nativo só no macOS, controles de janela |
| `mobile/*` | 227 | Casca do telefone: `MobileApp`, `MobileHeader`, `TabBar`, `MoreSheet`, `links`, `keyboard-viewport`, `mobile.css`, `main.jsx` | Preservar; só a aba Terminais e Dispositivos |
| `lib/native.js`, `remote.js`, `sensitive.js`, `shell.js`, `downloads.js`, `helpers.js`, `organization-colors.js`, `useViewRoute.js` | 900 | IPC do Tauri e da ponte, biometria na página, casca do telefone, cores, rota | Preservar; `native.js` ganha tabela por plataforma |
| `components/ui.jsx`, `ContentArea.jsx`, `styles.css` | 1151 | Toast, modal, estados, base de CSS | Preservar; podar regras mortas depois |
| `views/registry.js` | | Registro das seções | Adaptar: só `terminais` |
| Demais views, `AppContext.jsx`, `lib/api.js`, `lib/query*.js`, `lib/meetings.js`, `lib/vpn.js`, `map/`, `recorder/`, `data/` | | Seções de negócio | Fora |

### Casca do celular em `ios/app`

| Arquivo | Função | Destino |
| --- | --- | --- |
| `App.tsx` | Máquina de estados `loading`, `connect`, `shell`, `offline`; bootstrap do endereço; bloqueio biométrico por `AppState` | Preservar; `connect` vira pareamento e escolha de desktop |
| `src/screens/Connect.tsx` | Endereço HTTPS digitado, validação, teste de saúde | Substituir por leitor de QR e lista de desktops |
| `src/screens/Shell.tsx` | WebView com guarda de navegação, injeção de `window.__ORDINUM_SHELL__`, sondagem de saúde a cada 10 s, recarga se o processo morrer | Preservar; URL do proxy, nome global `__CIALAI_SHELL__` |
| `src/screens/Offline.tsx` | Retentativas em 2, 4, 8 e 16 s, tentar agora, alterar endereço | Preservar |
| `src/auth/biometrics.ts` | Nível Sessão com 5 min em segundo plano, nível Por ação, fila de prompts, época | Preservar |
| `src/bridge/messages.ts`, `downloads.ts`, `share-download.ts` | Mensagens `auth`, `download` e `open-external`, limites de tamanho, MIME permitidos | Preservar; nomes globais |
| `src/config/url.ts`, `storage.ts`, `env.ts`, `webview.ts` | Validação de URL `.ts.net`, Keychain, ambiente | Adaptar: aceitar `http://127.0.0.1:<porta>/?k=` em produção |
| `src/network/health.ts`, `request-gate.ts` | Saúde com prazo de 5 s e serviço `workplace` | Adaptar: serviço `cialai` |
| `app.config.ts` | Nome, bundle, Face ID, `usesNonExemptEncryption: false`, só iOS | Adaptar: bundle, Android, câmera, conformidade verdadeira |

## Contrato de comportamento

### Sessões e cards

Uma sessão é um `/bin/zsh -l` numa pasta, aberto na hora em que é criada, mesmo sem ser exibida. O card mostra, nesta ordem: o nome da pasta com o caminho completo ao passar o mouse; o subtítulo, se houver; o que está rodando com o tempo decorrido; o estado; um sinal de atenção quando houver; CPU e memória. Não há prévia da saída. Fonte: `docs/application/terminais.md:73-128`.

Personalização pelo menu do card: renomear, subtítulo, cor, fixar no topo, mover para cima e para baixo, abrir o Dev Browser, copiar caminho, abrir a pasta no gerenciador, nova sessão no mesmo diretório, trocar pasta, reiniciar o terminal, encerrar a sessão. Duplo clique no nome renomeia no lugar. Reordenação por arraste dentro do grupo, fixadas ou não, por `terminals/drag.js`: soltar na metade de cima põe antes, na metade de baixo depois, abaixo do último vai ao fim. ⌥↑ e ⌥↓ movem pelo teclado. Com a busca ativa o arraste é desligado. Encerrar com processo em primeiro plano ou arquivo não salvo pede confirmação com o nome do processo; shell parado encerra na hora.

Estados, todos derivados do observado, em `runtime.js:944-960`:

| Código | Rótulo | Tom | Condição |
| --- | --- | --- | --- |
| `starting` | Abrindo shell | busy | `pty_spawn` ainda não respondeu |
| `error` | Falha ao abrir | bad | Pasta inexistente ou PTY não abriu |
| `disconnected` | Sessão desconectada | muted | O app reabriu e o backend não tem mais o processo |
| `exited` | Processo finalizado | muted | Shell terminou com código 0 |
| `failed` | Encerrado com código N ou Encerrado por SINAL | bad | Shell terminou com código diferente de zero |
| `stopped` | Processo parado | warn | Primeiro plano em `SSTOP` |
| `streaming` | Recebendo saída | busy | Bytes nos últimos 1500 ms com processo em primeiro plano |
| `busy` | Processo em execução | busy | Grupo em primeiro plano diferente do shell |
| `running` | Shell aberto | ok | Sem amostra de métricas ainda |
| `idle` | Pronto para comando | ok | Primeiro plano é o próprio shell |

As barras de atividade só animam com um processo em primeiro plano além do shell ou enquanto o shell abre. Com o shell em prompt o card mostra um ponto parado.

### Atenção

Três fontes, em `runtime.js:492-500`, `1024-1031` e `596-597`, mantidas no card até a sessão ser consultada e sem trocar o foco:

1. Sino do terminal e notificações por OSC 9 e OSC 777, registradas por `term.parser.registerOscHandler`; ignoradas durante o replay.
2. Fim de um job que durou 4 s ou mais enquanto a sessão não estava sendo vista: `Terminou: nome`.
3. Fim do shell: `Processo finalizado` ou `Encerrado com código N` em vermelho.

Sessão sendo vista significa view montada, visível, janela ativa e sessão selecionada. Nesse caso a notificação vira um toast. A atenção some ao selecionar, ao digitar e quando a sessão passa a ser vista. O cabeçalho da coluna mostra quantas sessões pedem atenção; o chip e a paleta levam à próxima.

### Uso do plano dos agentes

Quando o primeiro plano é Claude Code ou Codex, o card mostra o percentual gasto da janela mais curta ao lado do nome do agente; acima de 75 por cento em âmbar, acima de 90 em vermelho; as demais janelas ficam na dica. Abaixo, dois chips: modelo e perfil quando não é o padrão. O uso é por perfil, identificado pelo slug da pasta de configuração: `claude` para `~/.claude`, `claude-work` para `~/.claude-work`, `codex-work` para `~/.codex-work`. Codex: `rollout-*.jsonl` mais recente de cada home, evento `token_count`, campo `rate_limits`. Claude Code: hook de linha de estado em `macos/scripts/claude-statusline.py`, instalado por `install-claude-statusline.sh` em `~/.ordinum/claude-statusline.py`, publicando `ai-usage/claude/<perfil>.json`. O caminho do hook não pode ter espaço. Varredura a cada 15 s, consulta a cada 5 s com agente em primeiro plano, validade de 6 h.

Agentes reconhecidos pela linha de comando em `procs.rs:466-528`: Claude Code, Codex, Gemini CLI, Aider, OpenCode, Cursor Agent, Copilot CLI, Goose, Amp, Crush, Kiro, Droid, Cline, Qwen Code e Ollama; runtimes desembrulhados: node, bun, deno, python, python3, npx, uv, uvx, tsx, ts-node. O binário, o script do node ou o módulo do python são conferidos; extensões `.js`, `.mjs`, `.cjs`, `.py`, `.ts` e `.sh` são removidas. Só quatro variáveis de ambiente são lidas: `CLAUDE_CONFIG_DIR`, `CLAUDE_PROFILE`, `CODEX_HOME` e `CODEX_PROFILE`.

### Métricas

CPU e memória são da árvore de processos do shell: soma do tempo de CPU entre duas amostras convertida para nanossegundos e soma do `phys_footprint`, a mesma coluna Memória do Monitor de Atividade. Amostra a cada 2 s com a seção visível e 6 s em segundo plano; sem sessão viva não há amostra. A primeira amostra só fixa a referência e o card mostra `Medindo…`; recusa do kernel mostra `Medição indisponível`. Fórmula em `terminal.rs:928-944`.

### Cores e tema

Paleta de 18 tons em `lib/organization-colors.js`, cada um com versão clara e escura, listada no documento 08. Sessões novas começam sem cor: card transparente, inclusive selecionado. O filete lateral de 3 px identifica a seleção, nunca troca a cor. Nome do agente, barras de atividade e ponto do cabeçalho acompanham o tom. Card com cor recebe gradiente de 10 para 4 por cento do acento no claro e 15 para 6 no escuro.

Tema do xterm em `terminals/theme.js`: fundo em `--mac-surface-2`, texto em `--mac-label`, cursor igual ao texto, seleção em `--mac-accent-soft-hover`, vermelho, verde e amarelo pelos tokens de estado, azul pelo acento, e oito cores ANSI fixas por modo. Objeto novo a cada chamada porque o xterm só reaplica quando a referência muda; observação de `data-theme` por `MutationObserver`. Opções do terminal em `runtime.js:358-382`: 120 colunas por 32 linhas iniciais, fonte mono do sistema, tamanho 12 no telefone ou o da preferência de 10 a 20, altura de linha 1,15, peso 400 e 600, 8000 linhas de scrollback, sensibilidade 2, cursor piscando, `macOptionIsMeta` desligado, API proposta ligada. Roda acelerada de 2 a 8 linhas com rampa 1,28 e intervalo de 180 ms, mudando só a sensibilidade do xterm.

### Layout

Três regiões: Sessões com 240 px iniciais entre 200 e 360; área de trabalho com o restante; Arquivos com 260 px entre 220 e 440. Divisores redimensionam; botões, ⇧⌘J e ⇧⌘E e a paleta recolhem. Abaixo de 980 px de conteúdo o explorador recolhe sozinho; abaixo de 720 as sessões também, sem gravar a preferência. Botão, atalho e paleta mostram a coluna recolhida mesmo assim, até a largura cruzar o limite outra vez. Terminal adotado pela área central e demais estacionados em `.terminais-parking` fora da tela; addon WebGL só no terminal exibido. A divisão entre editor e terminal nunca sobrepõe; mínimos cedem proporcionalmente. Modo foco recolhe as duas colunas e a barra lateral. Movimento de 140 a 240 ms só com opacidade e deslocamento; largura e altura nunca animam; acima de 60 linhas novas na árvore nada anima; tudo desliga com a preferência de menos movimento.

### Persistência

| Camada | Chave ou arquivo | Conteúdo | Origem |
| --- | --- | --- | --- |
| Webview | `oc_terminals`, `oc_terminals_phone` no telefone | Formato 2: `{version, sessions[], selectedId, recent[]}` com id, cwd, nome, nome personalizado, subtítulo, cor, fixação, criação, `editor{tabs, activeId, ratio}`, `explorer{root, expanded, followCwd}`, `browser{open, url}`; formato 1 da grade antiga é lido e convertido | `runtime.js:188-257` |
| Webview | `oc_terminals_layout` | `sessionsWidth`, `explorerWidth`, `sessionsCollapsed`, `explorerCollapsed`, `editorRatio`, `fontSize`; foco não persiste | `layout.js:58-63` |
| Webview | `oc_terminals_phone_route` | `{pane, sessionId, path}` | `phone-navigation.js` |
| Disco | `<Application Support>/br.com.ordinum.control/terminals/<tag>.log` | Saída bruta por lote; acima de 2 MiB fica o último 1 MiB a partir de uma linha; sem `fsync` | `journal.rs` |
| Disco | `terminals/<tag>.json` | `SavedMeta` versão 1: tag, cwd, colunas, linhas, atualização e `AgentSession`; gravado ao abrir e a cada 5 s só quando muda | `journal.rs` |
| Disco | `preferences.json` | `repoDir`, `stopStackOnQuit`, `meetings`, `devBrowser.chromiumPath` | `prefs.rs` |
| Disco | `ai-usage/claude/<perfil>.json` | Janelas do plano e sessões recentes | `claude-statusline.py` |
| Disco | `dev-browser/<sessão>/profile` e `owner.json` | Perfil do Chromium | `browser.rs` |
| Disco | `<pasta da sessão>/.dev-browser-panel/port` e `owner.json`, `~/.dev-browser-panel/port` | Porta publicada aos agentes, contrato com a extensão do VS Code | `browser.rs` |
| Disco | `~/Library/Caches/br.com.ordinum.control/office-pdf` | Cache de PDF até 512 MiB | `office.rs` |
| Plugin | window-state | Posição e tela cheia, nunca tamanho | `lib.rs:47-58` |

Ao reabrir o app, as sessões voltam com nome, ordem e pastas. Uma sessão só aparece viva se o Rust ainda tem o PTY, o que acontece depois de uma recarga do webview em desenvolvimento; o religamento usa a `tag`, identificador estável do frontend. Senão o card fica `Sessão desconectada` e o histórico gravado volta em segundo plano, uma sessão por vez, com sino e notificações calados, no tamanho em que foi escrito, seguido da linha `Histórico restaurado` com a hora. `Reabrir N desconectadas` fica no topo da coluna. `pty_prune` apaga o que sobrou de sessões que não existem mais.

### Retomada de agentes

Claude Code grava `<perfil>/sessions/<pid>.json` com `sessionId`; o Rust confere pid, `kind` interativo e que `startedAt` bate com o início do processo. Codex mantém aberto `rollout-<data>-<id>.jsonl`, achado entre os descritores do processo. Vale o agente mais próximo do shell. `Reabrir` abre shell novo na mesma pasta, continua o mesmo `<tag>.log` depois da marca `Shell reaberto em`, espera o prompt por quatro leituras sem saída nova a cada 100 ms com no máximo 8 s, confere por `pty_metrics` que nenhum programa tomou o terminal e digita `claude --resume <id>` ou `codex resume <id>`, com `cd` para a pasta do agente quando difere, as variáveis de perfil quando existiam e as opções da linha de comando original filtradas por listas fechadas em `resume.rs:68-117`; `--yolo` do Codex vira `--dangerously-bypass-approvals-and-sandbox`; o id precisa ser UUID e todo valor vai citado. `Encerrar sessão` apaga os dois arquivos por `pty_forget`.

### Área de trabalho, editor e explorador

Cabeçalho com nome, diretório atual do shell, branch com contagem de alterações e programa em execução; ações de buscar na saída, copiar seleção, fonte, modo foco, maximizar editor ou terminal. Shift+Enter com programa em primeiro plano manda avanço de linha. Arrastar arquivo ou pasta para o terminal cola o caminho absoluto citado com aspas simples e espaço final, respeitando bracketed paste, sem executar.

Editor: abas CodeMirror 6 por sessão, desfazer, cursor e rolagem preservados ao trocar; linguagem por `language-data`; ⌘F e ⌘S; ⌘N abre arquivo temporário sem lugar no disco; salvar compara mtime e recusa com `conflict`; arquivo mudado por fora sem alteração local recarrega em silêncio, com alteração local avisa; arquivo removido oferece salvar de novo ou fechar; Markdown alterna edição e visualização com HTML escapado; HTML alterna código e página por `preview://`; CSV e TSV viram tabela; imagens com tamanho; binários e acima de 2 MB oferecem abrir no app padrão e revelar; `Comparar alterações` abre diff contra HEAD; PDF pelo visualizador do WebKit; planilhas pelo SheetJS até 2000 linhas e 200 colunas; Word pelo mammoth; Office, iWork e RTF pelo LibreOffice headless.

Explorador: raiz é a pasta escolhida ao criar a sessão; até 2500 entradas por pasta; pastas antes de arquivos; ocultos esmaecidos; sujeira do macOS filtrada; observador por pasta expandida com releitura a cada 15 s e ao voltar à janela; marcadores Git por arquivo e ponto nas pastas; `Terminal em …` com `Ir` e `Acompanhar` quando o shell muda de pasta, sem a árvore mudar sozinha; busca por nome com índice reconstruído a cada 20 s até 60 mil entradas; arraste interno move, com Option copia com sufixo do Finder; do Finder entra sempre como cópia; nunca sobrescreve; Lixeira nunca apaga em definitivo; teclado com setas, Enter e ⌘⌫.

Dev Browser: um Chromium headless por sessão com perfil e porta próprios, nascido na primeira abertura da aba; CDP direto do webview por WebSocket em loopback; screencast em JPEG do tamanho do painel; entrada traduzida; diálogos nunca congelam; porta publicada em `.dev-browser-panel/port` para os agentes; binário pela preferência, pelo cache do Playwright ou pelo Chrome instalado, com instalação automática pelo `npx playwright install chromium`.

### Atalhos do macOS

| Atalho | Ação |
| --- | --- |
| ⌘T | Nova sessão |
| ⌘W | Fecha a aba ativa do editor; sem aba, encerra a sessão com confirmação; sem sessão, fecha a janela |
| ⇧⌘W | Fecha a janela |
| ⌘P | Buscar arquivo no projeto |
| ⌘F | Buscar na saída do terminal ou no editor |
| ⌘N | Novo arquivo temporário |
| ⌘S | Salvar |
| ⌘⌫ | Editor apaga a linha; terminal manda Ctrl+U; árvore pede exclusão |
| ⌘+, ⌘−, ⌘0 | Fonte do terminal |
| ⇧⌘] e ⇧⌘[ | Próxima e anterior sessão |
| ⌥↑ e ⌥↓ | Move o card selecionado |
| ⇧⌘B | Dev Browser |
| ⌘L, ⌘[, ⌘], ⌘R, Esc | Com o browser em foco |
| ⇧⌘J, ⇧⌘E | Colunas |
| ⌘K | Paleta |

Com o terminal em foco só essas combinações são interceptadas; o resto chega ao shell, inclusive Esc. O documento 04 define o esquema equivalente com Ctrl Shift no Linux e no Windows.

### Desempenho

O runtime emite eventos tipados e cada componente assina só o que lhe cabe: `sessions` para lista, seleção e metadados; `activity` com id para métricas, primeiro plano e atenção; `editor`, `explorer`, `viewport` e `browser` com id. Eventos iguais no mesmo giro são coalescidos. Com o shell em prompt digitar não emite nada; com processo rodando o card recebe no máximo dois `activity` por segundo e mais um quando a saída para. A amostra de métricas só emite para os cards cujos números mudaram. Cards memoizados; explorador só redesenha quando a árvore ou o diretório do shell muda.

## Modelos de dados

### Sessão no runtime, `runtime.js:388-473`

```js
{
  id, cwd, name, customName, subtitle, color, pinned, createdAt,
  term, fit, search, webgl, host,
  ptyId, pid, identityEpoch,
  status, exitCode, signal, early, error,
  spawning, reattachId, spawnToken,
  pendingAck, outputOffset, receivedOffset, channelId, ackTimer, fitTimer,
  lastOutputAt, activityTimer, idleTimer,
  activity, metricsAt, jobStartedAt, jobLabel,
  attention, saved, restoring, replaying, reopening, disposables,
  editor: { tabs, activeId, ratio, maximized, restoreTabs },
  explorer: { root, expanded, followCwd, nodes, git, gitAt, selected, revision },
  browser: { status, restoreOpen, autoStart, url, title, info, loading, canGoBack, canGoForward, error, canvas, canvasHandlers, epoch, install },
}
```

`activity` em `runtime.js:1004-1016`: `available`, `cpu`, `memory`, `processes`, `foreground{pid, name, command, agent, stopped, cwd, configDir, profile, profileName}`, `agent`, `profile`, `profileName`, `configDir`, `shellCwd`, `usage`. `attention`: `{kind, message, at}` com `kind` em `bell`, `notify`, `finished`, `exited` ou `error`. Aba do editor: `{id, kind, path, name, session, view, savedDoc, modifiedMs, lineEnding, dirty, conflict, loading, error, mode, image, viewer, viewerKind, size, diff, reloadedAt, watchPath, language}` com `kind` em text, markdown, html, csv, image, pdf, sheet, docx, office, binary, diff ou browser.

### Estruturas Rust, todas em camelCase na serialização

```rust
TerminalInfo { id: u32, tag, cwd, shell, pid: Option<u32>, alive, exit_code, cols, rows,
               view: Option<TerminalView>, presentation: Option<TerminalPresentation> }
TerminalView { id, cols, rows, owner: "local" | "remote", lease_id: u64, revision: u64 }
TerminalPresentation { name, subtitle, color: Option<String>, pinned, order }
TerminalExit { id, code: i32, signal: Option<String>, early: bool }
ForegroundProcess { pid, name, command, agent: Option<String>, stopped, cwd, config_dir, profile, profile_name }
SessionMetrics { id, tag, pid, available, cpu_percent: Option<f32>, memory_bytes: Option<u64>, processes: u32,
                 foreground: Option<ForegroundProcess>, agent, agent_profile, agent_config_dir, agent_profile_name, shell_cwd }
SavedMeta { version: 1, tag, cwd, cols, rows, updated_at_ms, agent: Option<AgentSession> }
SavedTerminal { tag, cwd, cols, rows, updated_at_ms, history_bytes, resume: Option<ResumePlan> }
ResumePlan { agent, session_id, command }
AgentSession { agent, session_id, cwd, config_dir, profile_name, args }
AgentUsage { agent, profile, config_dir, profile_name, model, sessions: Vec<UsageSession>, plan, windows: Vec<UsageWindow>, updated_at_ms, stale, source }
UsageWindow { id, label, used_percent, window_minutes, resets_at_ms }
GitStatus { is_repo, root, branch, detached, upstream, ahead, behind, changes: Vec<GitChange>, truncated }
FsError { code, message }   // not_found, denied, exists, conflict, binary, too_large, unsupported, missing_tool, timeout, trash, invalid, io, open, gesture
```

### Constantes que definem o comportamento

| Constante | Valor | Onde |
| --- | --- | --- |
| `READ_BUFFER`, `COALESCE_WINDOW`, `MAX_BATCH` | 16 KiB, 4 ms, 64 KiB | `terminal.rs:42-58` |
| `HIGH_WATER`, `LOW_WATER`, `QUEUE_DEPTH` | 512 KiB, 128 KiB, 32 | `terminal.rs` |
| `SCROLLBACK_LIMIT`, `REMOTE_LAG_GRACE` | 256 KiB, 3 s | `terminal.rs` |
| `KILL_GRACE`, `EARLY_EXIT_WINDOW`, `SNAPSHOT_INTERVAL`, `VIEW_LEASE` | 400 ms, 1000 ms, 5 s, 15 s | `terminal.rs` |
| `ACK_THRESHOLD`, `ACK_DELAY_MS`, `ACTIVITY_THROTTLE_MS`, `STREAMING_WINDOW_MS`, `FINISHED_MIN_MS` | 32 KiB, 100 ms, 500 ms, 1500 ms, 4000 ms | `runtime.js` |
| `LOG_KEEP`, `LOG_LIMIT`, `META_LIMIT`, `TAG_LIMIT` | 1 MiB, 2 MiB, 256 KiB, 80 | `journal.rs` |
| `LIST_LIMIT`, `TEXT_LIMIT`, `IMAGE_LIMIT`, `BYTES_LIMIT`, `FIND_VISIT_LIMIT`, `FIND_CACHE_TTL` | 2500, 2 MiB, 15 MiB, 40 MiB, 60000, 20 s | `files.rs` |
| `DEBOUNCE`, `MAX_GATHER`, `IDLE_TIMEOUT` | 80 ms, 400 ms, 500 ms | `watch.rs` |
| `TAIL_BYTES`, `STALE_MS`, `RECENT_DAYS`, `CACHE_TTL`, `SCAN_TTL` | 256 KiB, 6 h, 3, 2 s, 15 s | `ai.rs` |
| `MAX_ENTRIES`, `MAX_TEXT` | 200, 128 KiB | `mobile_files.rs` |
| `MAX_CONNECTIONS`, `MAX_CALLS`, `OUTBOUND_DEPTH`, `HANDSHAKE_TIMEOUT`, `WRITE_TIMEOUT`, `PING_INTERVAL`, `MAX_FRAME` | 8, 16, 64, 5 s, 5 s, 20 s, 1 MiB | `bridge/mod.rs`, `protocol.rs` |

Ambiente do shell em `terminal.rs:524-545`: `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=OrdinumControl`, PATH prefixado com `/opt/homebrew/bin:/usr/local/bin`, `LANG=pt_BR.UTF-8` quando vazio, `C` ou `POSIX`; remoção de `CLAUDECODE`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_CODE_*` e `CODEX_*`, preservando `CLAUDE_HOME`, `CLAUDE_CONFIG_DIR`, `CLAUDE_PROFILE` e `CODEX_HOME`.

## Comandos e eventos do Tauri

| Comando | Argumentos | Devolve |
| --- | --- | --- |
| `pty_spawn` | `cwd`, `cols`, `rows`, `tag`, canal `onOutput` | `TerminalInfo` |
| `pty_attach` | `id`, canal | `TerminalInfo` com replay pelo canal |
| `pty_write` | `id`, `data`, `binary` opcional | nada |
| `pty_resize` | `id`, `cols`, `rows` | nada; não toma a concessão |
| `pty_ack` | `id`, `bytes`, `channel` na ponte | nada |
| `pty_kill` | `id` | nada |
| `pty_list` | | lista de `TerminalInfo` |
| `pty_metrics` | | lista de `SessionMetrics` |
| `pty_view_claim`, `pty_view_renew`, `pty_view_release` | `id`, `leaseId`, `cols`, `rows` | `TerminalView` |
| `pty_presentation` | `id`, `presentation` | nada; só local |
| `pty_saved`, `pty_saved_history`, `pty_forget`, `pty_prune` | `tag`; `keep` | `SavedTerminal`; corpo binário; nada |
| `pty_files_list`, `pty_file_read` | `id`, `path` relativo | listagem restrita; texto; só pela ponte |
| `fs_list_dir`, `fs_stat`, `fs_read_text`, `fs_read_image`, `fs_read_bytes`, `fs_write_text`, `fs_create_file`, `fs_create_dir`, `fs_rename`, `fs_copy`, `fs_trash`, `fs_find`, `fs_reveal`, `fs_open_default`, `fs_drag_out`, `fs_watch`, `fs_unwatch` | caminhos e opções | estruturas de `files.rs` ou `FsError` |
| `git_status`, `git_diff` | `dir`; `root`, `path` | `GitStatus`; `GitDiff` |
| `office_convert` | `path`, `force` | `{pdfPath, url, cached, size}` |
| `preview_register` | raiz | token do `preview://` |
| `browser_start`, `browser_stop`, `browser_status`, `browser_list` | `sessionId`, `cwd`, dimensões, `origin`, `startUrl`, `purge` | `BrowserInfo` |
| `ai_usage` | | lista de `AgentUsage` |
| `list_repo_dirs` | | raízes e subpastas |

Eventos: `pty://exit`, `pty://view`, `fs://change` com `{id, path, kind, dir}` e `kind` em `changed`, `replaced` ou `removed`, `browser://exit`, `browser://install`, `drag-out://end`. Os eventos de stack, VPN e reuniões ficam fora.

## Dependências

npm em `frontend/package.json`: `@xterm/xterm` 6, `@xterm/addon-fit`, `addon-search`, `addon-web-links`, `addon-webgl`; `@codemirror/state`, `view`, `commands`, `search`, `language`, `language-data`, `lang-markdown`; `@lezer/common`, `highlight`; `marked`; `xlsx`; `mammoth`; `lucide-react`; `@tauri-apps/api` 2.11 com plugins dialog, fs e opener; `react` e `react-dom` 18.3; `@mui/material` e `@emotion` usados por `components/ui.jsx`; `chart.js` fica fora. Expo em `ios/app/package.json`: `expo` 57, `expo-constants`, `expo-file-system`, `expo-local-authentication`, `expo-secure-store`, `expo-sharing`, `expo-status-bar`, `react-native-safe-area-context`, `react-native-webview` 13.16; sem router, EAS, Firebase ou push.

Crates em `macos/src-tauri/Cargo.toml`: `tauri` 2 com `macos-private-api`, `tauri-plugin-dialog`, `fs`, `opener`, `window-state`, `window-vibrancy` 0.8, `serde`, `serde_json`, `portable-pty` 0.9, `libc`, `base64`, `chrono`, `tokio` com `net`, `time` e `macros`, `tokio-tungstenite` 0.30, `futures-util`; só no macOS `objc2`, `objc2-foundation` e `objc2-app-kit`. Perfil de release com `lto`, `opt-level = "s"`, `strip` e sem `panic = "abort"`, porque um panic numa thread de apoio não pode derrubar o app com todos os terminais.

## Testes e ferramentas herdados

| Suíte | Comando | Cobre |
| --- | --- | --- |
| Rust, 142 casos declarados no working tree atual | `cd macos && npm run check && npm run clippy && npm test` | O `HEAD` tem 138 casos e as mudanças preservadas adicionam quatro. O recorte sem stack, reuniões e VPN tem 114 casos declarados. Cobre zsh real, CPU de um `yes`, filhos, ambiente por `KERN_PROCARGS2`, arquivos com conflito, Lixeira, índice de busca, `git status` v2, kqueue, uso do plano, Dev Browser com árvores falsas, assinantes, replay com offset 37856 e comprimento 262144, concessão de largura, remoto que não confirma, protocolo e lista permitida da ponte, jornal, retomada e `tampered_state_never_becomes_a_command` |
| Node | `npm run test:terminals` e `npm run test:mobile` | `terminal-restore`, `mobile-terminal-touch`, `mobile-terminal-route`, `mobile-keyboard-viewport`, `mobile-api`, `mobile-site`, `mobile-launcher` |
| Frontend | `node scripts/check-terminal-sync.mjs` com 17 casos, `check-phone-terminal.mjs`, `check-phone-workbench.mjs`, `check-phone-terminal-visual.mjs`, `check-mobile.mjs` com 14 casos, `check-mobile-readonly-ui.mjs`, `check-file-kinds.mjs` | Sincronização entre desktop e telefone, concessão, casca do telefone, capturas, transporte remoto, somente leitura, classificação |
| Navegador | `check-studio-browser.js`, `check-explorer-drop-browser.js`, `check-terminal-drop-browser.js` por `wksnap` | Arraste, editor, roda, divisão |
| Dentro do app | `frontend/scripts/selftest-app.js` com `?oc_selftest=1`, resultado em `/tmp/oc-selftest.json` | Arraste real, PTY real, prévias, Dev Browser, uso do plano com agente falso, reordenação |
| Ferramentas Swift | `macos/tools/wksnap`, `winid`, `winbounds`, `drive` | Capturas, ids de janela, coreografia, automação de arraste |
| Demo | `?terminais=demo&motion=0#terminais` | Cinco sessões cobrindo os estados, árvore falsa e Git falso |

Fixtures: `frontend/scripts/fixtures/exemplo.{docx,xlsx}` e a pasta `~/.ordinum/selftest` criada pelo self test.

## O lado do celular no protótipo

Resumo; o documento 07 tem o protocolo inteiro e o documento 05 a casca.

O Node em `backend/node/index.js:172-210` abre um segundo listener em `127.0.0.1:3710`, hard-coded em loopback, que só aceita `GET`, `HEAD` e `OPTIONS`, nega mutações com `MOBILE_READ_ONLY`, exige `Host` em loopback ou `.ts.net` e origem igual ao host contra rebinding de DNS, e serve `mobile.html` por `services/mobile-site.js` com CSP, `no-store` no documento, `immutable` em `/assets/*`, fallback de SPA para caminhos sem extensão, recusa de `..`, barras invertidas, dotfiles, bytes nulos e links que saem da raiz, 503 sem build.

`frontend/mobile.html` declara `data-form-factor="phone"`, que `isPhone()` lê, e `<base href="/">`. `frontend/src/mobile/main.jsx` deriva a API e o WebSocket de `location`, aceitando `?api=` e `?bridge=` só em loopback. A ponte Rust em `127.0.0.1:3720` recebe `hello` e responde `welcome` com `features: ["terminal-mobile-v1"]`; a Tailscale hospedada publicava `/` para o Node e `/pty` para a ponte em HTTPS por `tailscale serve`.

## O que é específico da Ordinum e precisa mudar

| Item | Onde | No Cialai |
| --- | --- | --- |
| Raízes de projetos | `workspace/mod.rs:62-65`, `repos.rs`, `mobile_files.rs:88-97` | Preferência `projectRoots` com padrão detectado |
| Identificador `br.com.ordinum.control` e nome `Ordinum Control` | `tauri.conf.json`, `app.config.ts`, caminhos de dados | `br.com.ordinum.cialai` e `Cialai` |
| `TERM_PROGRAM=OrdinumControl` | `terminal.rs:531` | `Cialai` mais `TERM_PROGRAM_VERSION` |
| Chaves `oc_*` e globais `__ORDINUM_SHELL__` | `runtime.js`, `layout.js`, `appearance.js`, `shell.js`, `DesktopApp.jsx`, `useViewRoute.js`, `Sidebar.jsx` | `cialai_*` e `__CIALAI_SHELL__` |
| Hook em `~/.ordinum/claude-statusline.py` e `ORDINUM_APP_SUPPORT` | `macos/scripts` | `~/.cialai/claude-statusline.py` e `CIALAI_APP_SUPPORT` |
| PATH com Homebrew, `/bin/zsh -l`, `LANG=pt_BR.UTF-8` | `terminal.rs` | Por sistema, com preferência |
| Serviço `workplace` na saúde, URL `.ts.net` obrigatória | `ios/app/src/network/health.ts`, `config/url.ts` | Serviço `cialai`, URL do proxy em loopback |
| Marca Ordinum: azul `#1a4fa0`, gradiente da sidebar, ícone, textos | `macos.css`, `design/`, `Splash.jsx` | Identidade Cialai do documento 08 |
| Variáveis `ORDINUM_CONTROL_*` | `.env.example`, `stack.rs`, scripts | `CIALAI_*`, sem `.env` |
| Selftest em `~/.ordinum/selftest` e `/tmp/oc-selftest.json` | `selftest-app.js` | `~/.cialai/selftest` e diretório de logs |

## Documentos do Control a ler antes de executar

`docs/application/terminais.md`, `docs/application/design-system.md`, `docs/application/macos-app.md`, `docs/application/dev-browser.md`, `docs/architecture/overview.md`, `macos/README.md`, `ios/README.md`, `ios/docs/arquitetura.md`, `ios/docs/ponte.md`, `ios/docs/rede-e-seguranca.md`, `ios/docs/app-expo.md`, `ios/docs/build-e-distribuicao.md` e `docs/superpowers/specs/2026-09-08-terminais-iphone-design.md`.
