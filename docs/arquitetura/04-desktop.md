# Desktop

O app desktop do Cialai é o app macOS do Control extraído para `apps/desktop`, sem Node, Python, reuniões, VPN e launcher, com o estúdio completo, o supervisor do sidecar do túnel e as telas de onboarding, Vincular celular e Dispositivos. No macOS o comportamento é idêntico ao Control. No Linux e no Windows cada capacidade tem um mecanismo próprio e uma diferença documentada aqui.

Versões conferidas no `Cargo.lock` do Control: tauri 2.11.5, wry 0.55.1, tao 0.35.3, portable-pty 0.9.0, window-vibrancy 0.8.0. Fatos que decidem o desenho: no Unix o `portable-pty` mata só o shell com SIGHUP e expõe `tcgetpgrp` pelo master; no Windows ele chama `TerminateProcess` no shell, não tem líder de grupo nem descritor e fechar o master fecha o ConPTY. O plugin `opener` já revela arquivos no Finder, no Explorer e nos gerenciadores Linux. O Tauri 2.11 já tem `work_area`, `set_effects` e as chaves `backgroundColor`, `decorations`, `shadow` e `transparent` por sistema.

## Estado em 13/09/2026

| Área | Estado | Situação atual |
| --- | --- | --- |
| Estrutura Tauri e crate macOS | Implementado | Crate extraído, sidecar integrado e compilação local aprovados |
| Estúdio e casca desktop | Implementado | Interface, onboarding, preferências, marca e página móvel passam nos checks locais |
| Terminal, arquivos, Git, prévias e Dev Browser | Implementado | Suíte Rust elegível e self test local aprovados no macOS |
| Ponte, supervisor e telas de rede | Implementado | Contratos e simulações locais aprovados; pareamento com celular físico segue pendente |
| Backend Linux | Pendente | Matriz e riscos estão especificados, sem integração nesta linha |
| Backend Windows | Pendente | ConPTY, Job Objects, janela, atalhos e arquivos permanecem especificados, sem integração nesta linha |
| Empacotamento desktop | Preparado | Sidecars e configuração Tauri existem; instaladores assinados e instalação limpa não foram produzidos |
| Tor embutido | Preparado | Tor Expert Bundle 15.0.22 fixado por hash, preparado em `$RESOURCE/tor`, passado ao sidecar em `--tor-bin` e aberto pelo `doctor` no macOS arm64 local; instaladores dos três sistemas, assinatura Developer ID dos binários aninhados e instalação limpa seguem pendentes; Linux arm64 aguarda decisão de produto |
| Encerramento em cascata | Preparado | Supervisor com espera do início em andamento e Job Object no Windows, testes com sidecar falso e `tor` real medido no macOS arm64; o roteiro manual com o app nos três sistemas segue pendente |
| Atualizador | Preparado | Plugin, interface, endpoint e guarda existem; chave pública, assinatura e atualização real estão pendentes |
| Testes multiplataforma | Pendente | Os testes locais macOS não substituem CI remota, IME, Wayland, WebView2 nem instalação nos outros sistemas |

## Estrutura do crate

```
apps/desktop/
  package.json                 scripts dev, build, icon, test, clippy, check
  index.html, mobile.html      entradas do Vite, movidas de $CONTROL/frontend
  vite.config.js               main e mobile no dist; build mobile isolado como recurso
  src-tauri/
    Cargo.toml                 crate cialai-desktop, lib cialai_desktop_lib
    tauri.conf.json            comum; tauri.macos.conf.json, tauri.windows.conf.json, tauri.linux.conf.json
    capabilities/default.json
    binaries/cialai-tunnel-<triple>   sidecar Go por alvo
    resources/mobile/          bundle da página do celular servido pela borda
    src/
      main.rs, lib.rs, commands.rs, lifecycle.rs, prefs.rs, diagnostics.rs
      platform/mod.rs          PlatformInfo, ShellFlavor, ShellSpec, default_shell, path_prefix, default_lang, to_portable
      platform/win_job.rs      Job Objects, só Windows
      window/{mod,macos,windows,generic}.rs
      tunnel/{mod,supervisor,protocol}.rs   supervisor do sidecar por stdio
      workspace/terminal.rs
      workspace/pty/{mod,unix,windows}.rs
      workspace/procs/{mod,macos,linux,windows}.rs
      workspace/watch/{mod,kqueue,notify}.rs
      workspace/{files,git,journal,resume,ai,preview,office,browser,repos,dragout,mobile_files}.rs
      notch/{mod,commands,prefs,profiles,alerts}.rs, notch/usage/*, notch/sessions/*   Barra de IA, documento 15
      bridge/{mod,protocol,dispatch,events}.rs
  tools/                       wksnap, winid, winbounds, drive, movidos de $CONTROL/macos/tools
```

## Estratégia de módulos

Um backend por sistema escolhido por `cfg`, com funções de mesmo nome e structs portáveis, no padrão que `window.rs:325-388` e `dragout.rs:100-256` já usam. Uma única trait, `ProcSource`, na costura entre `TerminalManager::metrics` em `terminal.rs:883-981` e a inspeção de processos, para permitir um fake em teste e obrigar os backends a concordar. Nada de polimorfismo em tempo de execução além disso. O backend macOS de `procs.rs`, linhas 1 a 300, vai verbatim para `procs/macos.rs`; a metade portável, linhas 305 a 565, fica em `procs/mod.rs` com `CommandLine`, `CommandCache`, `AGENTS`, `RUNTIMES`, `agent_of`, `agent_profile`, `profile_slug`, `basename`, `ProcInfo` e `ProcState`.

### Crates

| Crate | Uso | Motivo |
| --- | --- | --- |
| `sysinfo` 0.33 ou mais novo | Linux e Windows: pais, `accumulated_cpu_time`, memória, cwd, argv, ambiente, exe, início, estado | Cobre a maior parte de `procs.rs` nos dois sistemas; a leitura do PEB no Windows é o que se escreveria à mão |
| `windows-sys` com `Win32_Foundation`, `Win32_System_JobObjects`, `Win32_System_Threading`, `Win32_System_Console`, `Win32_UI_WindowsAndMessaging`, `Win32_Graphics_Dwm` | Job Objects, `SetWindowPos`, `SetStdHandle`, `GetProcessTimes`, `OpenProcess` | Superfície mínima, sem COM |
| `notify` 8 | inotify e ReadDirectoryChangesW | Mantido o coalescedor próprio de 80 e 400 ms |
| `trash` 5 | Lixeira do freedesktop e Recycle Bin com desfazer | Substitui o stub `Lixeira disponível só no macOS` de `files.rs:521-524` |
| `which` 7 | `git`, `soffice`, `pwsh`, `npx`, navegadores | Substitui caminhos fixos do macOS |
| `dunce` | Canonicalizar sem o prefixo `\\?\` | `preview.rs:33`, `office.rs:186` e `resume.rs` comparam strings canônicas |
| `sys-locale` | `LANG` padrão | Generaliza o `pt_BR.UTF-8` fixo de `terminal.rs:544` |
| `keyring` 3 | Chave da API do Headscale e segredos | Keychain, Secret Service e Credential Manager; no Linux sem backend, arquivo 0600 com aviso |
| `window-vibrancy` 0.8, agora `cfg(any(macos, windows))` | Vibrancy Sidebar no macOS, Mica no Windows | Mesma chamada de `window.rs:50-58` |
| `libc`, mantido | `getpwuid_r`, `kill`, `tcgetattr` | `nix` não vale a dependência por duas chamadas |
| `objc2`, `objc2-foundation`, `objc2-app-kit` | Só sob `cfg(target_os = "macos")`, como em `Cargo.toml:37-40` | Arraste para fora, janela, Lixeira |

Não adotados: `dirs`, porque a API `path()` do Tauri cobre todos os diretórios; `nix`; `notify-debouncer-*`, porque a semântica do coalescedor é específica e testada. Perfil de release sem `panic = "abort"`, pelo motivo documentado em `Cargo.toml:42-48`.

## Matriz de capacidades

| Capacidade | macOS mantido | Linux | Windows | Diferença a documentar |
| --- | --- | --- | --- | --- |
| Árvore de processos | `proc_listchildpids` em `procs.rs:62-82` | `/proc/<pid>/task/*/children` quando existe, senão mapa de ppid por uma leitura do `sysinfo`; mesmos `MAX_TREE` 512 e `MAX_DEPTH` 16 | Lista de pids do Job Object por `QueryInformationJobObject` unida ao mapa de ppid, porque o shell entra num job ao nascer | No Windows a árvore inclui processos que se desprenderam do pai |
| CPU da árvore | `proc_pid_rusage` com `mach_timebase_info` em `procs.rs:110-127`; delta sobre tempo de parede em `terminal.rs:928-944` | `accumulated_cpu_time` do `sysinfo` em `cpu_nanos`; algoritmo inalterado | `GetProcessTimes` pelo `sysinfo` | Resolução de 10 ms no Linux e 15,6 ms no Windows contra nanossegundos no macOS |
| Memória da árvore | `ri_phys_footprint` | `Pss` de `/proc/<pid>/smaps_rollup` quando legível, senão `VmRSS` | `PrivateWorkingSetSize` de `PROCESS_MEMORY_COUNTERS_EX2`, senão `WorkingSetSize` | Números não comparáveis entre sistemas; o rótulo continua memória |
| Primeiro plano do PTY | `master.process_group_leader()` em `terminal.rs:890-894` | Mesmo; reserva `tpgid` de `/proc/<shell>/stat` | Heurística: processo mais novo do job que é folha e não é o shell; nulo só com o shell vivo | No Windows é a melhor estimativa, dito na dica do card; sem Ctrl+Z |
| Processo parado | `pbi_status == SSTOP` em `terminal.rs:1138` | Estado `T` ou `t` em `/proc/<pid>/stat` | Nunca | Windows nunca mostra Processo parado |
| Diretório do shell | `PROC_PIDVNODEPATHINFO` em `procs.rs:197-222` | `readlink /proc/<pid>/cwd` | PEB por `sysinfo::cwd()` | Processo elevado devolve nulo; card mostra `n/d` e Acompanhar pausa |
| Argv e ambiente permitido | `KERN_PROCARGS2` em `procs.rs:312-397` | `/proc/<pid>/cmdline` e `environ`, legíveis do mesmo usuário; Yama não bloqueia `PTRACE_MODE_READ` | `sysinfo::cmd()` e `environ()` por `ReadProcessMemory` | Falha em agente elevado ou de bitness diferente, cai em `~/.claude` e `~/.codex` |
| Arquivos abertos para retomar o Codex | `PROC_PIDLISTFDS` e `proc_pidfdinfo` em `procs.rs:247-300` | `readlink /proc/<pid>/fd/*` | Não implementado; reserva nova em `resume.rs::codex_session`: `rollout-*.jsonl` mais recente em `<CODEX_HOME>/sessions` cujo `session_meta.cwd` da primeira linha bate com o cwd e mtime posterior ao início do processo | Dois Codex na mesma pasta podem confundir |
| Lixeira | `NSFileManager.trashItemAtURL` em `files.rs:510-519` | `trash::delete` com `.Trash-<uid>` por montagem | `trash::delete` com `FOF_ALLOWUNDO` | Montagem sem lixeira devolve erro `trash` com o item intacto, contrato de `files.rs:838-843` |
| Revelar e abrir | plugin opener | plugin opener por D-Bus `ShowItems`, reserva `xdg-open` da pasta | plugin opener por `SHOpenFolderAndSelectItems`; `ShellExecute` | Só os textos mudam: Finder, Arquivos, Explorer |
| Observador | kqueue com `NOTE_WRITE`, `DELETE`, `RENAME`, `ATTRIB`, `EXTEND` | `notify` inotify por caminho, sem recursão; `Remove` e `Rename(From)` em arquivo observado viram `replaced` ou `removed` após stat | `notify` ReadDirectoryChangesW pela pasta pai filtrando o nome | Limite `max_user_watches` do inotify, muito acima do uso |
| Encerrar a árvore | SIGHUP e SIGKILL após 400 ms em `terminal.rs:792-808` | Idêntico | `TerminateProcess` no shell, depois `TerminateJobObject` após `KILL_GRACE`; job com `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` para uma queda do app também recolher a árvore; `kill_all_blocking` encerra todos os jobs | Sem sinal gracioso no Windows; o jornal continua sendo escrito até o fim |
| Shell padrão | `/bin/zsh -l` em `workspace/mod.rs:71` e `terminal.rs:488` | `prefs.terminal.shell`, senão `$SHELL`, senão `getpwuid().pw_shell`, senão `/bin/bash`; `-l` para zsh, bash, fish, sh, dash, ksh, tcsh e nu | `prefs.terminal.shell`, senão `which pwsh.exe`, senão `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, senão `%COMSPEC%`; `-NoLogo` para pwsh e powershell | `TerminalInfo` ganha `shellFlavor` em `posix`, `powershell` ou `cmd` |
| Citação de caminhos inseridos | Aspas simples em `files.js:183-188` e `resume.rs:337-346` | Igual | PowerShell com aspas simples dobradas e barras invertidas; cmd com aspas duplas | `shellQuote(path, flavor)` e `shell_quote(value, flavor)` |
| Chromium | Caches do Playwright e `/Applications` em `browser.rs:59` e `209-274` | `~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell` e `chromium-*/chrome-linux*/chrome`; `which` de `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `/snap/bin/chromium`, `microsoft-edge` | `%LOCALAPPDATA%\ms-playwright\chromium_headless_shell-*\chrome-headless-shell-win64\chrome-headless-shell.exe` e `chromium-*\chrome-win64\chrome.exe`; Chrome em Program Files e `%LOCALAPPDATA%`; Edge `msedge.exe` | `allowed_origin` em `browser.rs:173-182` aceita `http://tauri.localhost` |
| Instalação do Playwright em `browser.rs:301-379` | `/bin/zsh -lc` | `$SHELL -lc` | `cmd /c npx.cmd --yes playwright install chromium` com `PLAYWRIGHT_BROWSERS_PATH`; sem grupo de processos, dentro de um Job Object para o prazo | Leitura do progresso inalterada |
| LibreOffice em `office.rs:55-63` | Lista mantida | `which soffice` e `libreoffice`, `/usr/lib/libreoffice/program/soffice`, `/opt/libreoffice*/program/soffice`, `/snap/bin/libreoffice` | `%PROGRAMFILES%\LibreOffice\program\soffice.exe`, `%PROGRAMFILES(X86)%`, `which soffice` | `file_url()` em `office.rs:97-108` emite `file:///C:/…`; o erro perde a dica de `brew install` fora do macOS |
| Diretórios | `app_data_dir`, `app_cache_dir`, `app_config_dir` em `terminal.rs:423`, `commands.rs:332-336`, `prefs.rs:81-86` | Mesma API | Mesma API; jornal e perfis do Dev Browser em `app_local_data_dir` para não sincronizar por roaming | Tabela de caminhos abaixo |
| `LANG` | `pt_BR.UTF-8` quando ausente, `C` ou `POSIX`, em `terminal.rs:541-545` | Mesma regra com `prefs.terminal.lang`, senão `sys-locale`, senão `C.UTF-8` | Não define | Mesmo resultado no Mac do autor |
| Prefixo de PATH | `/opt/homebrew/bin:/usr/local/bin` em `terminal.rs:1157-1162` e `office.rs:112-115` | `~/.local/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin`, `/snap/bin`, só os que existem | Nenhum | `prefs.terminal.pathPrefix` sobrepõe em todos |
| Sujeira filtrada | `MACOS_NOISE` em `files.rs:51-58` | Mais `.directory` e `.Trash-*` | `Thumbs.db`, `desktop.ini`, `$RECYCLE.BIN`, `System Volume Information` | Tabela `NOISE_BY_OS` |

## Ajustes por módulo

| Módulo | Ajuste |
| --- | --- |
| `workspace/terminal.rs` | `spawn_for_with_args` em `505-638` recebe `ShellSpec { path, args, flavor }` de `platform::default_shell(&prefs)`; mantém `TERM`, `COLORTERM` e a remoção dos marcadores de agente em `64-73` e `536-540`, que funciona no Windows porque `CommandBuilder` ignora caixa; `TERM_PROGRAM` vira `Cialai` e ganha `TERM_PROGRAM_VERSION`; no Windows, logo após `spawn_command`, `win_job::assign(child.process_id())` e `Session` guarda `Option<JobHandle>`; `kill` em `792-808` e `kill_all_blocking` em `812-838` chamam `pty::force_kill_tree`; `metrics` troca `process_group_leader()` por `pty::foreground_pid` e `procs::bsd_info` por `procs::info` com `ProcInfo { pid, ppid, pgid, state, comm, name, start_sec }`; `describe_foreground` em `1108-1144` compara `ProcState`; `user_home()` em `1102-1104` recebe o `home_dir()` do Tauri; testes trocam `/tmp` e `zsh -f` por `TestShell::isolated()` com `print_and_exit` e `burn_cpu` |
| `workspace/terminal.rs`, anel de histórico | `OutputLink::send` troca por NUL, no anel de 256 KiB que o `pty_attach` reproduz, as consultas que um programa faz ao terminal e que o xterm responde sozinho ao reparsear: `ESC[6n`, `ESC[?6n`, `ESC[c`, `ESC[0c`, `ESC[>c`, `ESC[>0c`, `OSC 10;?` e `OSC 11;?` com BEL ou ST, inclusive cortadas entre dois trechos, guardadas como resto pendente até o trecho seguinte. A saída ao vivo segue intacta, porque o programa espera a resposta, e o NUL mantém o tamanho e os offsets do replay iguais aos do fluxo ao vivo. Generaliza o que `pty/cursor.rs` faz só nos 512 primeiros bytes do ConPTY. Teste `replay_neutralizes_terminal_queries_even_when_split_between_chunks` |
| `workspace/pty/` | `spawn_shell`, `graceful_kill`, `force_kill_tree`, `foreground_pid` e `ShellFlavor::from_path`, extraídos de `terminal.rs:515-560`, `792-838`, `890-894` e `1146-1154` |
| `workspace/procs/` | `mod.rs` com a trait `ProcSource` e `SystemProcs`; `linux.rs` e `windows.rs` sobre `sysinfo`; `name()` no Linux prefere o basename do exe ao `comm` truncado em 15 caracteres |
| `workspace/resume.rs` | `resume_command(session, shell_cwd, flavor)`; PowerShell gera `Set-Location -LiteralPath 'dir'; $env:CLAUDE_CONFIG_DIR='x'; claude --resume <id> …`; cmd gera `cd /d "dir" && set "CLAUDE_CONFIG_DIR=x" && claude --resume <id> …`; documentar que no Windows a variável persiste no shell; `program_args` em `244-248` ignora `claude.cmd` e `node.exe`; reserva do Codex por cwd e mtime |
| `workspace/files.rs` | Caminhos devolvidos passam por `platform::to_portable` com barras normais; entradas aceitam as duas formas; `copy_entry` com links sob `cfg(unix)`; tabela de sujeira por sistema |
| `workspace/git.rs` | `/dev/null` em `diff --no-index` mantido; `git()` em `68-82` chama `platform::configure_background_command`, que põe `CREATE_NO_WINDOW` no Windows e um grupo de processos próprio no Unix, como `soffice`, `npx`, o Chromium e o sidecar do túnel. Sem a flag, em release no Windows cada `git status` do explorador abria uma janela de console, porque o app é subsistema GUI e não tem console para o filho herdar. O teste `git_helper_is_configured_as_a_background_command` prova a passagem pelo helper no Unix, onde o `pgroup` fica visível no comando; o std não expõe as flags de criação do Windows, então lá a garantia é `tools/check/desktop-background-commands.mjs`, que reprova qualquer `Command::new` de produção sem a chamada na mesma função e aceita a dispensa `sem CREATE_NO_WINDOW:` com motivo |
| `workspace/preview.rs` | `handle` em `116-140` aceita `preview://<token>/<path>` e `http://preview.localhost/<token>/<path>`; `dunce::canonicalize` em `33` e `130` |
| `workspace/watch/` | `mod.rs` mantém `Watcher` e o coalescedor de `watch.rs:162-241`; `kqueue.rs` mantém `register` e `run` de `138-199`; `notify.rs` alimenta o mesmo mapa de pendências |
| `workspace/browser.rs` | `alive` e `kill_group` em `142-160` viram `platform::process_alive` e Job Object por instância; `process_group(0)` em `313` e `613` e `ExitStatusExt::signal` em `716` sob `cfg(unix)`; `PLAYWRIGHT_CACHE` em `59` vira `platform::playwright_cache()`; tabelas por sistema |
| `workspace/office.rs` | `find_soffice` e `file_url` por sistema; `search_path` por `platform::path_prefix()`; `.env("HOME", …)` em `229` só no Unix |
| `workspace/repos.rs` e `workspace/mod.rs:62-65` | `REPO_ROOTS_FROM_HOME` vira `prefs.projectRoots`; `mobile_files::root` em `mobile_files.rs:88-97` lê a mesma lista |
| `workspace/mobile_files.rs` | Arquivo inteiro `cfg(unix)`; no Windows os dois comandos devolvem `indisponível` até a implementação Win32 com `FILE_FLAG_OPEN_REPARSE_POINT` |
| `workspace/dragout.rs` | Inalterado; o stub `cfg(not(macos))` em `245-256` fica na primeira rodada |
| `workspace/ai.rs` | Comparações `ends_with("/.codex")` viram `Path::ends_with`; `codex_homes` em `258-272` usa o home do Tauri |
| `diagnostics.rs` | `install` em `19-34` usa `std::io::IsTerminal`; `dup2` no Unix inalterado em `49-63`; `SetStdHandle(STD_ERROR_HANDLE)` no Windows; `log_path` em `44-47` usa `app_log_dir()` |
| `prefs.rs` | Esquema novo abaixo; some `repo_dir`, `stop_stack_on_quit`, `meetings` e `default_repo_dir` de `72-79` |
| `bridge/**` | `BridgeConfig { port, proxy_secret, dev_open }` de `CIALAI_BRIDGE_PORT` e preferências em `mod.rs:42-48`; `capabilities: ["pty"]` em `219-220`; braços de VPN, reuniões e stack removidos de `dispatch.rs:181-233`; `events.rs:5-13` reduzido; `Connection` ganha `device_id` |
| `lib.rs` | Sem `StackManager`, `VpnManager` e `RecorderManager`; `tunnel::Supervisor` gerenciado; ordem de encerramento: Chromiums, terminais, `shutdown` do sidecar |
| `lifecycle.rs`, `commands.rs` | Inalterados fora os comandos removidos; `fs_reveal` e `fs_open_default` em `commands.rs:375-388` já são portáveis |

## Janela e casca por sistema

| Tema | macOS mantido | Windows | Linux |
| --- | --- | --- | --- |
| Configuração | `tauri.conf.json` com `macOSPrivateApi`, `titleBarStyle Overlay`, `hiddenTitle`, semáforos em 20 por 21, `transparent`, `acceptFirstMouse`, de `tauri.conf.json:16-31` | `tauri.windows.conf.json`: `decorations false`, `shadow true`, `transparent true`, `backgroundColor` do plum da marca antes da primeira pintura, sem `windowEffects` | `tauri.linux.conf.json`: `decorations true`, `transparent false`, `backgroundColor` do plum |
| Vibrancy | `apply_vibrancy(Sidebar, FollowsWindowActiveState)` de `window.rs:48-59` | `apply_mica` só em build 22621 ou mais novo, erro logado e não fatal; a página pinta o restante | Nenhuma |
| Barra de título | Semáforos; espaçador `.mac-sidebar__drag` de 52 px em `macos.css:305`; toolbar com `padding-left: 82px` com a sidebar oculta em `macos.css:385` | Controles minimizar, maximizar e fechar no fim de `Toolbar.jsx` via `getCurrentWindow()`; `data-tauri-drag-region` já existe em `Toolbar.jsx:16` e `Sidebar.jsx:107-108`; bordas de redimensionamento do tao; espaçador zero | Decorações do gerenciador; espaçador zero; sem controles próprios, porque janelas sem moldura no Wayland não podem ser posicionadas |
| Abertura de 440 por 320 até 1380 por 880 em 520 ms, `window.rs:122-165` | `setFrame_display` por quadro em `361-369` | `window/windows.rs`: um `SetWindowPos` com `SWP_NOZORDER` e `SWP_NOACTIVATE` a cada 16 ms na thread principal, em pixels físicos; `current_frame` por `outer_position` e `outer_size`; `visible_area` por `work_area()` | `window/generic.rs`: X11 por `set_position` e `set_size` por quadro; Wayland, detectado por `WAYLAND_DISPLAY` sem `GDK_BACKEND=x11`, salta ao tamanho final sem animação e sem centralizar o splash |
| window-state | Posição e tela cheia, `skip_initial_state("main")` de `lib.rs:47-58` | Igual | Igual; restaurar posição não faz nada no Wayland |
| Escape e tela cheia | `useEscapeGuard` em `DesktopApp.jsx:57-65`; `watchFullscreen` em `221-229` | Guarda do Escape só no macOS | Igual ao Windows |
| Menu nativo | `desktop/menu.js` inalterado, com o menu Editar predefinido obrigatório para copiar e colar no WKWebView | Sem menubar nativa, porque `TranslateAccelerator` engoliria Ctrl+T, Ctrl+W e Ctrl+C antes do terminal; botão de menu na toolbar com os mesmos itens; atalhos no DOM por `keys.js` | Igual ao Windows, porque grupos de aceleração GTK roubariam Ctrl+C |
| Fontes | `-apple-system` e `"SF Mono", SFMono-Regular, ui-monospace, Menlo` de `macos.css:26-27` e `theme.js:14-16` | `"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif` e `"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, monospace` | `system-ui, "Inter", Cantarell, Ubuntu, "Noto Sans", sans-serif` e `ui-monospace, "JetBrains Mono", "Fira Code", "DejaVu Sans Mono", "Noto Sans Mono", monospace`; JetBrains Mono empacotada em `packages/ui/src/fonts` como último recurso do terminal para cobertura de caracteres de caixa |
| WebKitGTK | | | Addon WebGL com o fallback e `onContextLoss` já existentes em `runtime.js:765-779`; esperar renderizador DOM em NVIDIA e dmabuf; documentar `WEBKIT_DISABLE_DMABUF_RENDERER=1` e `WEBKIT_DISABLE_COMPOSITING_MODE=1`; `:has()` de `Terminais.css:9` exige WebKitGTK 2.40; `input switch` de `Preferences.jsx:124` vira checkbox estilizado `.mac-switch`; arraste HTML5 também não chega à página, então `drag.js` já é o desenho certo; posições de `onDragDropEvent` lógicas |
| WebView2 | | Origem `http://tauri.localhost`; `preview` por `http://preview.localhost/`; posições de arraste em pixels físicos; `Alt` sozinho foca uma menubar inexistente, inofensivo; `acceptFirstMouse` ignorado | |

### Atalhos

No macOS a tabela do documento 02 fica inalterada, porque ⌘ nunca chega ao shell. No Linux e no Windows, com o terminal em foco, tudo que colide com uma tecla do shell vai para Ctrl Shift, a convenção do Windows Terminal e do GNOME Terminal; fora do terminal, no editor e no explorador, o Ctrl simples também vale. `lib/keys.js` concentra `mod(event)`, `isShortcut(event, 'Mod+Shift+E')`, `label('Mod+Shift+E')` e `terminalSafe('Mod+F')`.

| Ação | macOS | Linux e Windows |
| --- | --- | --- |
| Nova sessão | ⌘T | Ctrl Shift T |
| Fechar aba, sessão ou janela | ⌘W | Ctrl Shift W |
| Buscar arquivo | ⌘P | Ctrl Shift P |
| Buscar na saída ou no editor | ⌘F | Ctrl Shift F no terminal, Ctrl F no editor |
| Novo arquivo temporário | ⌘N | Ctrl Shift N |
| Salvar | ⌘S | Ctrl S |
| Apagar linha | ⌘⌫ | Ctrl Shift Backspace |
| Fonte do terminal | ⌘+, ⌘−, ⌘0 | Ctrl Shift mais, menos e zero |
| Copiar e colar no terminal | ⌘C, ⌘V | Ctrl Shift C, Ctrl Shift V, mais Ctrl Insert e Shift Insert |
| Sessão seguinte e anterior | ⇧⌘] e ⇧⌘[ | Ctrl Shift ] e Ctrl Shift [ |
| Mover card | ⌥↑ e ⌥↓ | Alt ↑ e Alt ↓ |
| Dev Browser | ⇧⌘B | Ctrl Shift B |
| Colunas | ⇧⌘J e ⇧⌘E | Ctrl Shift J e Ctrl Shift E |
| Paleta | ⌘K | Ctrl Shift K |
| Excluir na árvore | ⌘⌫ | Delete e Ctrl Shift Backspace |

## Frontend em `packages/ui`

### Vão sem mudança

`terminals/hooks.js`, `replay.js`, `restore.js`, `viewport.js`, `layout.js` com a chave renomeada, `kinds.js`, `motion.js`, `phone-navigation.js` com a chave renomeada, `touch-scroll.js`, `editor.js`, cujos atalhos `Mod-` já são por plataforma em `editor.js:172-177`; `terminals/browser/{cdp,input,screencast,session}.js`, com `input.js:114` e `155` já usando `metaKey || ctrlKey`; `terminals/ui/{dialogs,Menu,NewSessionPopover,QuickOpen,Splitter,SessionCard,PhoneFiles,PhoneWorkbench}.jsx`; `desktop/{shell-bridge.js,palette-registry.js,appearance.js,theme.macos.js,Sidebar.jsx,Splash.jsx,CommandPalette.jsx}` com renomeações; `lib/{remote,sensitive,shell,organization-colors,downloads,useViewRoute}.js`; `mobile/**`; `components/ui.jsx` com MUI para modal, toast e drawer na primeira rodada; `styles.css` para `.btn`, `.view`, `.page-empty` e `.field*`; `views/Terminais.jsx` e `Terminais.css`.

### Edições

| Arquivo | Mudança |
| --- | --- |
| `lib/native.js` | Mantém todas as exportações de `native.js:10-142`; `normalizeDragPosition` em `41-47` vira tabela por sistema: macOS lógico com a peculiaridade comentada, Windows físico dividido por `devicePixelRatio`, Linux lógico com a heurística de fora da janela; `previewUrl` em `136-142` monta `preview://` ou `http://preview.localhost/`; novas exportações `windowControls` com `minimize`, `toggleMaximize`, `close`, `isMaximized` e `onMaximizedChange`, e `NATIVE_ONLY_MESSAGE` |
| `lib/platform.js`, novo | `platform()` com `os`, `isMac`, `home`, `fileManager`, `defaultShellFlavor` e `sep`, preenchido no boot por `invoke('app_platform')` com reserva pelo `navigator.userAgent`; grava `data-platform` e `data-shell="desktop"` no `html` |
| `lib/keys.js`, novo | Funções de atalho; todos os literais ⌘ saem dos componentes |
| `terminals/ui/Workbench.jsx` | `handled()` em `336-345` e o `keydown` em `364-386` por `keys.js`; `isDeleteLine` em `348`; textos de atalho da paleta em `392-419` e títulos em `480`, `563`, `602` por `label()`; `Abrir pasta no Finder` em `237` por `platform().fileManager`; Ctrl Shift C e V com `term.getSelection()` e `term.paste()` |
| `terminals/ui/{WorkArea,SessionsPane,BrowserPane,ExplorerPane,EditorPane}.jsx` | Dicas de atalho em `WorkArea:303-318`, `SessionsPane:169-172`, `BrowserPane:95-103`, `ExplorerPane:561`; textos de Finder em `ExplorerPane:451`, `EditorPane:188` e `350`; `ExplorerPane:541` aceita `Delete` |
| `terminals/files.js` | `shellQuote(path, flavor)` em `183-188`; `shortPath` em `137-139` pelo home real em vez de `/^\/Users\/[^/]+/`; `displayPath` com barras invertidas só para rótulos no Windows |
| `terminals/runtime.js` | `STORAGE_KEY` em `63` vira `cialai_terminals` e `cialai_terminals_phone` com leitura única das chaves `oc_*`; `insertPaths` em `1727-1735` passa `session.shellFlavor`, aplicado em `applyTerminalInfo` em `860-867`; `seedDemo` em `1982-2036` pelo home da plataforma; `macOptionIsMeta` inalterado |
| `terminals/drag.js` | Inalterado; `handOff` em `96-109` já tolera `unsupported` de `fs_drag_out` |
| `desktop/DesktopApp.jsx` | Sem `AppProvider`, `BootProbe`, `StackGate`, reuniões e `bumpQueryEpoch`; `useBoot` em `69-115` espera `hydrate()` do runtime ou 1500 ms; `actions` em `185-204` sem stack; `installNativeMenu` em `209-213` só no macOS, senão `installDomShortcuts`, generalização de `installBrowserShortcuts` em `menu.js:140-160`; guarda do Escape só no macOS; `reloadData` mantém a recarga do Dev Browser em `144-150` |
| `desktop/main.jsx` | Sem `stack_config`, `API.base` e Chart; `await platform.init()` antes de renderizar; `data-platform` em `36` pela plataforma; flag `cialai_selftest` em `43` |
| `desktop/menu.js` | Só macOS; textos renomeados; submenu Stack removido; `Ctrl+Cmd+S` mantido |
| `desktop/Toolbar.jsx` | Sem `StackStatus` e `RecordingIndicator` de `28-29`; `<kbd>⌘K</kbd>` em `42` por `label()`; `WindowControls` no Windows e botão de menu fora do macOS; botão Vincular celular com estado do túnel |
| `desktop/Sidebar.jsx` | Seções Terminais, Dispositivos e Preferências; item Vincular celular fixo no rodapé com ponto de estado |
| `desktop/Preferences.jsx` | Aparência mantida; Terminal com shell, argumentos, `LANG` e prefixo de PATH; Projetos com raízes e `chooseDirectory`; Dev Browser com caminho do Chromium; Rede com URL do Headscale, chave da API por keychain, usuário e nome do computador; Janela com fundo, só no Windows; sem Stack e Reuniões de `116-172` |
| `desktop/macos.css` | Vira `shell.css` mais `platform.css`; seletores `[data-platform="macos"]` que descrevem a casca viram `[data-shell="desktop"]`; regras só do macOS como o espaçador em `305`, o padding em `385-388` e `-webkit-font-smoothing` ficam sob `[data-platform="macos"]`; `platform.css` traz fontes e controles de janela por sistema; tokens `--mac-*` mantidos na primeira rodada, com renomeação para `--ui-*` como tarefa opcional final |
| `views/registry.js` | Só `terminais`, mantendo `#view-terminais` e a derivação de ⌘1 |
| `components/ContentArea.jsx` | Sem `useApp`; só `Suspense` e o componente |
| `frontend/scripts/check-terminal-sync.mjs` | Chave em `45` vira `cialai_terminals` |
| `frontend/scripts/check-terminal-drop-browser.js` | Expectativa em `70` continua posix; asserção nova com `shellFlavor` `powershell` |

O estúdio só toca a casca por `shell-bridge.js`, `palette-registry.js` e `components/ui.jsx`, todos mantidos. `isTauri()` em `native.js:10-12`, `isPhone()` em `shell.js:6` por `data-form-factor="phone"` e `hasBridge()` continuam sendo os únicos interruptores.

## Onboarding

Fluxo de primeira abertura, dentro do webview, com o splash e a coreografia de janela do Control preservados:

1. Boas-vindas com a marca e um botão só.
2. Pastas de projetos: lista com padrão detectado entre `~/Projects`, `~/Developer`, `~/src`, `~/dev`, `~/code` e `~/Github Projects`, mais `Adicionar pasta` por `chooseDirectory`. No macOS os prompts de acesso a Desktop, Documentos e Downloads aparecem aqui, cedo. Sessões fora das raízes continuam funcionando como terminais, só sem arquivos no celular.
3. Shell: o detectado por sistema, com campo para trocar e teste que abre um PTY e mostra o prompt.
4. Rede, opcional: `Configurar agora` abre o assistente do Headscale do documento 06; `Depois` deixa a barra lateral com o item Vincular celular em estado "rede não configurada".
5. Pronto: cria a primeira sessão na primeira raiz e cai no estúdio.

O assistente do Headscale: URL, chave da API, `control.configure` com diagnóstico de DNS, 443, certificado, versão e 3478; escolha do usuário existente ou criação; nome do computador; `node.up`; estado `running` com IP. Tudo por comandos `tunnel.*` do Rust ao sidecar.

## Preferências

```json
{
  "appearance": "system",
  "terminal": { "shell": null, "args": [], "lang": null, "pathPrefix": [] },
  "projectRoots": ["~/Projects"],
  "devBrowser": { "chromiumPath": null },
  "window": { "backdrop": "auto" },
  "network": { "controlUrl": null, "userId": null, "userName": null, "desktopName": null, "requireApproval": false, "keepAwakeWhilePaired": false }
}
```

A chave da API do Headscale nunca entra no arquivo: fica no keychain pelo `keyring`, sob o serviço `br.com.ordinum.cialai` e a conta `headscale-api-key`.

## Telas de rede

Vincular celular: botão visível na barra lateral, no estado vazio da lista de sessões e no fim do onboarding. Abre um diálogo com o QR de 280 px ou mais, o nome do computador, o tempo restante, a instrução "abra o Cialai no celular e leia este código", o estado do túnel e, com aprovação exigida, o código de 4 dígitos. O QR gira a cada 90 s. Fechar cancela. Sucesso mostra "Vinculado: nome do dispositivo" com atalho para Dispositivos.

Dispositivos: lista com nome, modelo, plataforma, última conexão, estado online e ações renomear, revogar e revogar também na rede. Estado do computador: IP na tailnet, nome no Headscale, DERP em uso, validade da chave da API, botão de diagnóstico que roda `cialai-tunnel doctor`.

## Diretórios, chaves e variáveis

| Diretório pela API do Tauri | macOS | Linux | Windows |
| --- | --- | --- | --- |
| Preferências, `app_config_dir` | `~/Library/Application Support/br.com.ordinum.cialai/preferences.json` | `~/.config/br.com.ordinum.cialai/` | `%APPDATA%\br.com.ordinum.cialai\` |
| Jornal `terminals/<tag>.log` e `.json`, `app_local_data_dir` | `~/Library/Application Support/br.com.ordinum.cialai/terminals/` | `~/.local/share/br.com.ordinum.cialai/terminals/` | `%LOCALAPPDATA%\br.com.ordinum.cialai\terminals\` |
| Perfis do Dev Browser `dev-browser/<sessão>/profile` | Mesma raiz | Mesma | Mesma |
| Túnel `tunnel/` com `tsnet/`, `devices.json`, `identity.json`, `pair.lock`, `tunnel.log`, `pid` | Mesma raiz | Mesma | Mesma, com ACL do usuário |
| Uso do plano `ai-usage/claude/<perfil>.json`, `app_data_dir` | Mesma raiz | `${XDG_DATA_HOME:-~/.local/share}/br.com.ordinum.cialai/ai-usage/claude/` | `%APPDATA%\br.com.ordinum.cialai\ai-usage\claude\` |
| Cache Office `office-pdf/`, `app_cache_dir` | `~/Library/Caches/br.com.ordinum.cialai/office-pdf/` | `~/.cache/br.com.ordinum.cialai/office-pdf/` | `%LOCALAPPDATA%\br.com.ordinum.cialai\office-pdf\` |
| Logs, `app_log_dir` | `~/Library/Logs/br.com.ordinum.cialai/` | `~/.local/share/br.com.ordinum.cialai/logs/` | `%LOCALAPPDATA%\br.com.ordinum.cialai\logs\` |
| Hook da linha de estado | `~/.cialai/claude-statusline.py` | Igual | `%USERPROFILE%\.cialai\claude-statusline.py`, com `msvcrt.locking` |
| Arquivos de porta do Dev Browser | `<cwd>/.dev-browser-panel/port` e `~/.dev-browser-panel/port`, contrato com a extensão do VS Code | Iguais | Iguais |

Chaves do webview: `oc_terminals` vira `cialai_terminals`; `oc_terminals_phone` vira `cialai_terminals_phone`; `oc_terminals_layout` de `layout.js:8` vira `cialai_terminals_layout`; `oc_terminals_phone_route` vira `cialai_terminals_phone_route`; `oc_theme` de `appearance.js:13` e `36` vira `cialai_theme`; `oc_sidebar` de `DesktopApp.jsx:125` e `135` vira `cialai_sidebar`; `oc_view` de `useViewRoute.js:6` e `15` vira `cialai_view`; `oc_mac_groups_closed` de `Sidebar.jsx:12` vira `cialai_groups_closed`; flag `oc_selftest` vira `cialai_selftest`; `window.__ORDINUM_SHELL__` e `__ordinumShellReceive` de `shell.js:5` e `20` viram `__CIALAI_SHELL__` e `__cialaiShellReceive`; prefixos temporários `oc-*` viram `cialai-*`; `/tmp/oc-selftest.json` vira `<app_log_dir>/selftest.json`. Migração única: ler `oc_terminals`, `oc_terminals_layout` e `oc_theme` quando a chave nova está vazia e gravar a nova.

Variáveis: `CIALAI_BRIDGE_PORT`, `CIALAI_SHELL`, `CIALAI_LANG`, `CIALAI_PATH_PREFIX`, `CIALAI_APP_SUPPORT` para o hook, `CIALAI_TUNNEL_BIN` para testes do supervisor, `CIALAI_TOR_BIN` para um `tor` de desenvolvimento no lugar de `$RESOURCE/tor`; `ORDINUM_CONTROL_*` deixam de existir; não há `.env`. Nomes de eventos `pty://exit`, `pty://view`, `fs://change`, `browser://exit`, `browser://install` e `drag-out://end` não mudam.

## Empacotamento

| Sistema | Alvos do Tauri | Assinatura | Observações |
| --- | --- | --- | --- |
| macOS | `app` e `dmg`, `minimumSystemVersion 13.0`, universal ou arm64 e x86_64 separados | Developer ID com hardened runtime e notarização por `notarytool`; a identidade autoassinada `Ordinum Local Signing` de `macos/scripts/signing.sh` fica só para desenvolvimento local | O sidecar entra em `externalBin` com o triplo no nome, como `binaries/ordinum-audio-capture-aarch64-apple-darwin` hoje |
| Windows | `nsis` e `msi` | Authenticode por Azure Trusted Signing; nightly sem assinatura | Prompt do firewall no primeiro uso do sidecar é esperado e documentado |
| Linux | `appimage`, `deb` e `rpm`, compilados em Ubuntu 22.04 | Nenhuma | Recomendar deb e rpm; AppImage como alternativa; Flatpak adiado porque o shell do host exigiria `flatpak-spawn --host` |

### Tor embutido

O desktop leva o Tor Expert Bundle 15.0.22 como recurso do Tauri, sem download nem instalação pelo usuário. `tools/fetch-tor.mjs` baixa o arquivo do alvo, confere o SHA 256 fixado a partir do manifesto assinado do Tor Browser, extrai e copia para `apps/desktop/src-tauri/resources/tor/` o diretório `tor/` com as bibliotecas ao lado do executável, `data/geoip`, `data/geoip6` e as licenças de `docs/`. Transportes plugáveis e `torrc-defaults` ficam fora, porque o serviço onion de salto único não usa pontes. A cópia grava `tor-bundle.json` e `SHA256SUMS`, ajusta os modos para 755 no código e 644 nos dados e é conferida por `--verify-resource` antes do `tauri build`. `npm run sidecar` prepara o alvo do host; a release prepara cada alvo da matriz.

| Sistema | Caminho instalado | Assinatura |
| --- | --- | --- |
| macOS | `Cialai.app/Contents/Resources/tor/tor/tor` e `libevent-2.1.7.dylib` | Ad hoc na extração; com Developer ID, `fetch-tor.mjs --sign` assina cada Mach-O com hardened runtime e carimbo de tempo antes do Tauri, que só assina `externalBin` |
| Linux | `/usr/lib/Cialai/tor/tor/tor` no deb e no rpm; mesmo caminho dentro do AppImage | Nenhuma |
| Windows | `tor\tor\tor.exe` ao lado de `Cialai.exe` na pasta de instalação | `tor.exe` vai sem Authenticode, como sai do Tor Project |

Descoberta: o Rust resolve `resource_dir()/tor/tor/tor`, ou `tor.exe` no Windows, e passa o caminho absoluto ao sidecar em `--tor-bin` no `serve-stdio` e no `doctor`. `CIALAI_TOR_BIN` substitui o caminho em desenvolvimento. O sidecar nunca procura o binário sozinho; o `doctor` roda `tor --version` e devolve `checks.tor`. O sidecar guarda o caminho em `TorExecutable`, e o `net.start` da tarefa CON-029 ainda precisa entregá-lo a `tor.StartDesktop`. Linux arm64 não tem bundle oficial: `fetch-tor.mjs --stage` falha nesse alvo e `npm run sidecar` avisa e grava `resources/tor/UNAVAILABLE.txt`, sem escolher substituto.

Firewall do Windows: o `tor` só escuta em 127.0.0.1 pela porta de controle, com `SocksPort 0`, e só faz conexões de saída aos relays. O Windows Defender Firewall pergunta quando um programa escuta em interface de rede, então o esperado é nenhum aviso para `tor.exe`. O aviso que pode aparecer no primeiro uso é do `cialai-tunnel.exe`, pelo caminho direto em UDP; recusar bloqueia só a entrada direta pela rede, e a conexão de reserva pelo Tor continua funcionando porque usa saída. Os instaladores não criam regra de firewall. A confirmação depende da instalação limpa no Windows.

Rede local no macOS 15: a privacidade de rede local vale para apps fora da sandbox e atribui ao Cialai os sockets do sidecar e do `tor`, que são processos filhos. O `tor` usa loopback e endereços da internet, que não pedem essa permissão; o aviso vem do caminho direto quando o sidecar fala com endereços da rede local. Recusar em Ajustes do Sistema, Privacidade e Segurança, Rede Local desliga só o caminho direto na mesma rede; a conexão de reserva pelo Tor segue. O desktop ainda não declara `NSLocalNetworkUsageDescription`. A confirmação depende da instalação limpa em macOS 15.

Licenças: esta build do Tor informa cobertura pela GPL versão 3 e traz libevent e OpenSSL. As licenças vão em `$RESOURCE/tor/docs` e o `NOTICE` registra os componentes; a oferta de código fonte correspondente ainda precisa de revisão antes da versão 1.

Updater por `tauri-plugin-updater` com chave própria e `latest.json` nas releases do GitHub, a partir da Fase 7.

### Encerramento do túnel

Sair pelo menu e fechar a janela chegam a `RunEvent::Exit`, que chama `Supervisor::shutdown_blocking`. O supervisor espera um início em andamento registrar o processo, para que nenhum sidecar nasça depois do encerramento, envia `shutdown`, dá 5 s para o sidecar sair e então o mata. O sidecar fecha a borda e os ouvintes; o `tor` fecha por `tor.Desktop.Close`, com `SIGNAL SHUTDOWN` e morte do processo que não sair em 3 s. Nesta linha o sidecar ainda não abre o `tor`: o `net.start` da CON-029 precisa fechar o `Desktop` no encerramento do runtime.

Quando o app morre sem esse caminho, o sidecar sai pelo fim do stdin ou pela ausência do pai, conferida a cada 2 s. O `tor` sai assim que fecha a conexão de controle que enviou `TAKEOWNERSHIP` e, como reserva, em até 15 s por `__OwningControllerProcess`, que aponta para o sidecar. No Windows o supervisor coloca o sidecar num Job Object com `KILL_ON_JOB_CLOSE`, herdado pelo `tor`: o sistema fecha o handle quando o app morre e leva a árvore inteira, e o supervisor termina o job depois de cada saída, falha de início ou morte forçada do sidecar.

Testes: `tunnel::supervisor::tests::sidecar_tree_ends_after_shutdown`, `sidecar_tree_ends_when_shutdown_is_ignored` e `sidecar_tree_ends_when_the_app_dies` usam um sidecar falso que abre um filho e conferem o fim dos dois; no Windows o filho ignora o dono e só o Job Object o encerra. `TestRealTorFollowsItsOwner`, em `internal/tor`, roda com `CIALAI_TOR_BIN` e mede o `tor` real depois de `Close`, com o dono morto e só com `__OwningControllerProcess`.

Roteiro manual, repetido em macOS, Linux e Windows com o app instalado e o Tor Browser fechado, porque o `tor` dele entra na mesma lista:

1. Abrir o Cialai, esperar o túnel em execução e listar a árvore. No macOS e no Linux: `pgrep -l cialai-tunnel; pgrep -lx tor`. No Windows, no PowerShell: `Get-Process cialai-tunnel, tor -ErrorAction SilentlyContinue`.
2. Sair pelo menu e repetir a listagem depois de 10 s.
3. Abrir de novo, fechar a janela e repetir a listagem depois de 10 s.
4. Abrir de novo e matar o app sem encerramento. No macOS e no Linux: `kill -9 $(ps -o ppid= -p $(pgrep -x cialai-tunnel))`. No Windows: `Stop-Process -Force -Id (Get-CimInstance Win32_Process -Filter "Name='cialai-tunnel.exe'").ParentProcessId`. Repetir a listagem depois de 20 s.
5. Registrar sistema, versão do app e a saída de cada listagem. O critério é nenhuma linha nos passos 2, 3 e 4.

Resultado físico do roteiro: pendente nos três sistemas.

### Sidecar ao lado do executável, sem janela e com reinício limitado

`Supervisor::for_app` resolve o `cialai-tunnel` por `std::env::current_exe()`, com `CIALAI_TUNNEL_BIN` mandando quando definido e, no Linux, `$APPDIR/usr/bin` quando o AppRun definiu a variável. `tauri::process::current_binary` não serve: no AppImage ele devolve `$APPIMAGE`, o arquivo baixado, e a prévia 0.2.1 procurava o sidecar em `~/Downloads` ou `~/.local/bin`, ficando em Rede com problema no Arch enquanto o `tor` era achado certo por `resource_dir`. A falha de `resolve_binary` e a de `validate_binary` entram no `app.log` por `diagnostics::note`, com o caminho tentado e o texto `sidecar não encontrado`. Testes: `appimage_sidecar_lives_in_the_mounted_image_beside_the_real_executable` e `resolve_binary_ignores_appimage_and_follows_appdir_or_the_executable`, este com as variáveis trocadas sob um mutex. O smoke do AppImage falha quando nenhum `cialai-tunnel` nasce de dentro do `APPDIR` ou quando `tunnel/tunnel.log` não aparece no `HOME` isolado.

O `serve-stdio` e o `doctor` passam por `platform::configure_background_command`: `CREATE_NO_WINDOW` no Windows, onde o app em release é subsistema GUI e um filho de console sem a flag abre uma janela por tentativa, e grupo de processos próprio no Unix. O sidecar Go do Windows ainda sai com `-H=windowsgui` em `tools/build-tunnel.mjs`, defesa em profundidade. Os inícios do sidecar são contados numa janela deslizante de 10 min com teto de 10, somando o ciclo de reinício e as tentativas diretas de `ensure_started` a cada chamada da interface; esgotada a janela, `start_once` devolve `tunnel_restart_limit` sem criar processo e `ensure_started` não rearma o ciclo, que só volta quando o início mais antigo sai da janela. Testes: `restart_budget_admits_ten_starts_per_window_and_then_waits` e `a_missing_sidecar_is_not_retried_beyond_the_restart_window`.

## Testes e CI

Detalhes em `09-monorepo-e-ferramentas.md` e `10-ci-cd-e-distribuicao.md`. Em resumo: suítes Node portam como estão; suítes Rust ganham `TestShell` e `TestChild` por sistema e variantes de `procs`, `terminal`, `resume`, `files`, `watch` e `browser`; checks de navegador saem do `wksnap` para Playwright; `selftest-app.js` roda por `tauri-driver` no Linux e no Windows e por `tauri dev` no macOS; matriz do GitHub Actions com `ubuntu-22.04`, `windows-2022`, `macos-14` e `macos-13`.

## Riscos

| Risco | Mitigação |
| --- | --- |
| ConPTY reflui a saída, ignora `?2026` e o `<u` do kitty em `TERMINAL_RESET` de `journal.rs:49`; Windows PowerShell 5.1 sem bracketed paste; repintura no redimensionamento no Windows 10 | Exigir Windows 10 21H2 ou 11; pwsh 7 padrão; replay do jornal na largura atual sem `resizeRenderer`; reset específico para ConPTY |
| Leitura de ambiente e cwd falha em processos elevados no Windows | Perfil padrão; dica no card; retomada do Codex por cwd e mtime |
| WebKitGTK sem WebGL ou com bugs de composição | Fallback já existente; variáveis documentadas; medir com `yes`; preferência de scrollback menor só no Linux |
| AppImage com versões de WebKitGTK e GLib do host | Compilar em Ubuntu 22.04; `tools/release/fix-appimage.mjs` deixa a pilha gráfica com o sistema, corrige o RUNPATH dos auxiliares do WebKit e isola os módulos GIO; `appimage-smoke.yml` abre o AppImage no Ubuntu 24.04 e no Arch; recomendar deb e rpm |
| `/proc` escondido por `hidepid` ou Snap | Campos ilegíveis viram nulos, contrato de `terminal.rs:151-154` |
| Assinatura e notarização | Orçar certificados na Fase 0; nightly sem assinatura; releases assinadas |
| Wayland sem posicionamento | Abertura sem animação; splash dentro da janela final |
| Barra de título própria no Windows sem Snap Layouts e mudança de DPI com transparência | Aceitar e documentar; `set_min_size` depois do crescimento |
| IME e teclas mortas no xterm em WebKitGTK e WebView2 | Matriz manual com fcitx5, ibus e IME do Windows |
| Job Object aninhado quando o app nasce dentro de outro job, como tarefas do VS Code | Windows 8 ou mais novo aninha; atribuir sem `BREAKAWAY` |
| `compact()` do jornal renomeia sobre arquivo aberto no Windows, `journal.rs:307-313` | Rust abre com `FILE_SHARE_DELETE`; teste específico |
| `npx.cmd` e política de execução do PowerShell | Sempre por `cmd /c`, nunca por `powershell -File` |
