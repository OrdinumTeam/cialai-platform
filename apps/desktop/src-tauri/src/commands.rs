// SPDX-License-Identifier: Apache-2.0
//! Comandos invocaveis pelo frontend via `invoke`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::i18n::{t, tf};
use crate::platform::{self, PlatformInfo, ShellSpec};
use crate::prefs::{Preferences, PrefsState};
use crate::tunnel::{Awake, RpcProblem, Supervisor};
use crate::workspace::ai::{self, AgentUsage, UsageCache};
use crate::workspace::browser::{BrowserInfo, BrowserManager};
use crate::workspace::docgraph::{self, DocScan, DocScans, ScanOptions};
use crate::workspace::dragout;
use crate::workspace::files::{
    self, FileStat, FindCache, FindResult, FsError, FsResult, ImageFile, Listing, TextFile,
    WriteResult,
};
use crate::workspace::git::{self, GitDiff, GitStatus};
use crate::workspace::journal::SavedTerminal;
use crate::workspace::office::{self, ConvertResult, OfficeQueue};
use crate::workspace::preview::PreviewRoots;
use crate::workspace::pty::CursorPosition;
use crate::workspace::repos::{self, RepoListing, RepoRoot};
use crate::workspace::terminal::{
    SessionMetrics, SubscriberKey, TerminalInfo, TerminalManager, TerminalPresentation,
    TerminalView,
};
use crate::workspace::watch::Watcher;

#[tauri::command]
pub fn get_preferences(prefs: State<'_, PrefsState>) -> Preferences {
    prefs.get()
}

#[tauri::command]
pub fn app_platform(app: AppHandle, prefs: State<'_, PrefsState>) -> Result<PlatformInfo, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    Ok(PlatformInfo::detect(&home, &prefs.get()))
}

#[tauri::command]
pub fn set_preferences(
    app: AppHandle,
    prefs: State<'_, PrefsState>,
    mut next: Preferences,
) -> Result<Preferences, String> {
    let previous = prefs.get();
    let previous_backdrop = previous.window.backdrop().to_string();
    // O bloco da Barra de IA so muda pelos comandos `notch_*`: o dialogo de
    // Preferencias monta o objeto do zero e o zeraria.
    next.notch = previous.notch;
    // O mesmo vale para o perfil ativo de cada agente: ele so muda por
    // `agent_profile_select`.
    next.agents = previous.agents;
    next.save(&app)?;
    if let Some(browsers) = app.try_state::<BrowserManager>() {
        browsers.set_chromium_path(next.dev_browser.chromium_path.clone());
    }
    if next.window.backdrop() != previous_backdrop
        && let Some(window) = app.get_webview_window("main")
    {
        crate::window::apply_backdrop(&window, next.window.backdrop());
    }
    if let Some(awake) = app.try_state::<Awake>() {
        awake.set_enabled(next.network.keep_awake_while_paired);
    }
    prefs.set(next.clone());
    Ok(next)
}

/// Arquivos do aplicativo em barras portáveis, para Preferências mostrar os
/// caminhos reais de cada sistema.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppPaths {
    preferences: String,
    data: String,
    logs: String,
}

impl AppPaths {
    fn new(config: &Path, data: &Path, logs: &Path) -> Self {
        Self {
            preferences: platform::to_portable(config.join("preferences.json")),
            data: platform::to_portable(data),
            logs: platform::to_portable(logs),
        }
    }
}

#[tauri::command]
pub fn app_paths(app: AppHandle) -> Result<AppPaths, String> {
    let paths = app.path();
    let config = paths.app_config_dir().map_err(|error| error.to_string())?;
    let data = paths.app_data_dir().map_err(|error| error.to_string())?;
    let logs = paths.app_log_dir().map_err(|error| error.to_string())?;
    Ok(AppPaths::new(&config, &data, &logs))
}

fn tunnel_join_error(error: impl std::fmt::Display) -> RpcProblem {
    RpcProblem {
        code: "tunnel_internal".into(),
        message: format!("A operação do túnel foi interrompida: {error}"),
        retryable: true,
    }
}

#[tauri::command(async)]
pub async fn tunnel_call(
    supervisor: State<'_, Supervisor>,
    command: String,
    args: serde_json::Value,
) -> Result<serde_json::Value, RpcProblem> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.call(&command, args))
        .await
        .map_err(tunnel_join_error)?
}

/// Apaga a chave da API do Headscale deixada por versões anteriores; a
/// conectividade v2 não usa servidor de controle.
#[tauri::command(async)]
pub async fn tunnel_delete_api_key(supervisor: State<'_, Supervisor>) -> Result<(), RpcProblem> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.delete_api_key())
        .await
        .map_err(tunnel_join_error)?
}

#[tauri::command(async)]
pub async fn tunnel_doctor(
    supervisor: State<'_, Supervisor>,
) -> Result<serde_json::Value, RpcProblem> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.doctor())
        .await
        .map_err(tunnel_join_error)?
}

/// O frontend montou a tela de abertura: a janela pequena pode aparecer.
/// Roda fora da thread principal porque a coreografia espera giros do loop.
#[tauri::command(async)]
pub fn splash_ready(window: WebviewWindow) {
    crate::window::mark_interface_ready();
    crate::window::show_splash(&window);
}

/// Os dados chegaram: cresce a janela ate o tamanho de trabalho. Roda fora da
/// thread principal e responde quando a animacao termina.
#[tauri::command(async)]
pub fn window_grow(window: WebviewWindow) -> bool {
    crate::window::mark_interface_ready();
    crate::window::grow(&window)
}

/* ── terminais ────────────────────────────────────────────────────── */

/// Abre um shell na pasta. A saida vai pelo canal em bytes brutos; o fim da
/// sessao chega pelo mesmo canal como JSON `{"type":"exit"}`. `tag` e o
/// identificador estavel da sessao no frontend. Fora da thread principal:
/// abrir o shell faz fork e exec e espera o exec numa leitura de pipe, que
/// pode levar segundos sob pressao de memoria, e reabrir varias sessoes de
/// uma vez somava essa espera com a janela parada.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn pty_spawn(
    terminals: State<'_, TerminalManager>,
    cwd: String,
    cols: u16,
    rows: u16,
    cursor_row: Option<u16>,
    cursor_col: Option<u16>,
    tag: Option<String>,
    on_output: Channel,
) -> Result<TerminalInfo, String> {
    terminals.spawn(
        &cwd,
        cols,
        rows,
        CursorPosition::from_client(cursor_row, cursor_col),
        tag.as_deref().unwrap_or(""),
        on_output,
    )
}

/// Medicoes reais de cada sessao viva: CPU e memoria da arvore de processos,
/// processo em primeiro plano, agente reconhecido e diretorio atual do shell.
#[tauri::command(async)]
pub fn pty_metrics(terminals: State<'_, TerminalManager>) -> Vec<SessionMetrics> {
    terminals.metrics()
}

/// Texto digitado ou colado. Com `binary`, cada char e um byte, para os
/// eventos `onBinary` do xterm: a pagina so usa esse caminho para os relatos
/// de mouse X10, que cabem em um byte por char. Qualquer char acima de U+00FF
/// e recusado em vez de truncado, para texto nunca perder acentos por ali.
#[tauri::command]
pub fn pty_write(
    terminals: State<'_, TerminalManager>,
    id: u32,
    data: String,
    binary: Option<bool>,
) -> Result<(), String> {
    if binary.unwrap_or(false) {
        terminals.write(id, &binary_bytes(&data)?)
    } else {
        terminals.write(id, data.as_bytes())
    }
}

/// Bytes do caminho `binary`: um por char, somente ate U+00FF.
fn binary_bytes(data: &str) -> Result<Vec<u8>, String> {
    data.chars()
        .map(|char| {
            u8::try_from(u32::from(char)).map_err(|_| {
                format!(
                    "o caminho binario do terminal so aceita chars ate U+00FF e recebeu U+{:04X}",
                    u32::from(char)
                )
            })
        })
        .collect()
}

#[tauri::command]
pub fn pty_resize(
    terminals: State<'_, TerminalManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    terminals.resize(id, cols, rows)
}

#[tauri::command]
pub fn pty_view_claim(
    terminals: State<'_, TerminalManager>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<TerminalView, String> {
    terminals.view_claim(id, SubscriberKey::Webview, cols, rows)
}

#[tauri::command]
pub fn pty_view_renew(
    terminals: State<'_, TerminalManager>,
    id: u32,
    lease_id: u64,
    cols: u16,
    rows: u16,
) -> Result<TerminalView, String> {
    terminals.view_renew(id, SubscriberKey::Webview, lease_id, cols, rows)
}

#[tauri::command]
pub fn pty_view_release(
    terminals: State<'_, TerminalManager>,
    id: u32,
    lease_id: u64,
) -> Result<TerminalView, String> {
    terminals.view_release(id, SubscriberKey::Webview, lease_id)
}

#[tauri::command]
pub fn pty_presentation(
    terminals: State<'_, TerminalManager>,
    id: u32,
    presentation: TerminalPresentation,
) -> Result<u64, String> {
    terminals.presentation(id, presentation)
}

/// O webview consumiu `bytes` da saida. Libera a thread de lote.
#[tauri::command]
pub fn pty_ack(terminals: State<'_, TerminalManager>, id: u32, bytes: usize) -> Result<(), String> {
    terminals.ack(id, bytes)
}

#[tauri::command]
pub fn pty_kill(terminals: State<'_, TerminalManager>, id: u32) -> Result<(), String> {
    terminals.kill(id)
}

/// Depois de uma recarga do webview, religa a saida de uma sessao viva. O
/// historico em memoria segue pelo canal fora da thread principal.
#[tauri::command(async)]
pub fn pty_attach(
    terminals: State<'_, TerminalManager>,
    id: u32,
    on_output: Channel,
) -> Result<TerminalInfo, String> {
    terminals.attach(id, on_output)
}

#[tauri::command]
pub fn pty_list(terminals: State<'_, TerminalManager>) -> Vec<TerminalInfo> {
    terminals.list()
}

/// Estado guardado de uma sessao que ja nao tem PTY: tamanho, tamanho do
/// historico e, quando um agente rodava nela, o comando que retoma a
/// conversa.
#[tauri::command(async)]
pub fn pty_saved(terminals: State<'_, TerminalManager>, tag: String) -> Option<SavedTerminal> {
    terminals.saved(&tag)
}

/// Historico gravado da sessao, como corpo binario.
#[tauri::command(async)]
pub fn pty_saved_history(
    terminals: State<'_, TerminalManager>,
    tag: String,
) -> tauri::ipc::Response {
    tauri::ipc::Response::new(terminals.saved_history(&tag))
}

/// A sessao foi encerrada de proposito: apaga historico e estado.
#[tauri::command(async)]
pub fn pty_forget(terminals: State<'_, TerminalManager>, tag: String) {
    terminals.forget(&tag);
}

/// Apaga historico e estado de sessoes que o frontend nao conhece mais.
#[tauri::command(async)]
pub fn pty_prune(terminals: State<'_, TerminalManager>, keep: Vec<String>) {
    terminals.prune(&keep);
}

/// Idioma escolhido na interface para menu, dialogos e mensagens nativas.
/// Fica gravado para o menu e a confirmacao de saida da proxima abertura.
#[tauri::command]
pub fn app_set_locale(app: AppHandle, locale: String) -> String {
    let locale = crate::i18n::set_locale(&locale);
    match app.path().app_config_dir() {
        Ok(dir) => {
            if let Err(error) = crate::i18n::persist(&dir, locale) {
                crate::diagnostics::note(&format!("idioma nao gravado: {error}"));
            }
        }
        Err(error) => crate::diagnostics::note(&format!("idioma nao gravado: {error}")),
    }
    locale.to_string()
}

/// Sair pelo menu: pede confirmacao quando ha terminais abertos.
#[tauri::command]
pub fn app_request_quit(app: AppHandle) {
    crate::lifecycle::request_exit(&app);
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelftestPaths {
    root: String,
    output: String,
}

fn prepare_selftest_paths(
    cache: &Path,
    logs: &Path,
    run_id: &str,
) -> Result<SelftestPaths, String> {
    let root = cache.join("selftest").join(format!("run-{run_id}"));
    let output = logs.join("selftest.json");
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(logs).map_err(|error| error.to_string())?;
    Ok(SelftestPaths {
        root: platform::to_portable(root),
        output: platform::to_portable(output),
    })
}

/// Diretórios exclusivos do autoteste. O roteiro nunca precisa conhecer a
/// pasta pessoal nem escrever em projetos do usuário.
#[tauri::command]
pub fn app_selftest_paths(app: AppHandle) -> Result<SelftestPaths, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    let logs = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?;
    let run_id = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    prepare_selftest_paths(&cache, &logs, &run_id)
}

/// Repositorios das raizes conhecidas, para o seletor rapido de pastas.
#[tauri::command]
pub fn list_repo_dirs(app: AppHandle, prefs: State<'_, PrefsState>) -> Result<RepoListing, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    Ok(repos::list(&home, &prefs.get().project_roots))
}

/// Subpastas de uma pasta, para o seletor de nova sessão navegar. Sem caminho,
/// devolve os pontos de partida: pasta pessoal, raízes de projeto e volumes.
/// Só nomes de pasta saem daqui, nunca conteúdo de arquivo.
#[tauri::command]
pub fn list_dirs(
    app: AppHandle,
    prefs: State<'_, PrefsState>,
    path: Option<String>,
) -> Result<crate::workspace::dirs::DirListing, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let roots = repos::project_roots(&home, &prefs.get().project_roots);
    crate::workspace::dirs::list(&home, &roots, path.as_deref())
}

/// Candidatas documentadas para o primeiro uso, com existência conferida sem
/// atravessar ou criar diretórios.
#[tauri::command]
pub fn detect_project_roots(app: AppHandle) -> Result<Vec<RepoRoot>, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    Ok(repos::detected_roots(&home))
}

/// Shell efetivo depois de aplicar preferência, argumentos de login e a
/// detecção específica da plataforma.
#[tauri::command]
pub fn app_shell(prefs: State<'_, PrefsState>) -> ShellSpec {
    platform::default_shell(&prefs.get())
}

#[cfg(test)]
mod pty_write_tests {
    use super::binary_bytes;

    #[test]
    fn binary_path_maps_one_byte_per_char_and_rejects_anything_wider() {
        assert_eq!(binary_bytes("\x1b[M !!").unwrap(), b"\x1b[M !!");
        assert_eq!(binary_bytes("\u{ff}\u{80}").unwrap(), [0xff, 0x80]);
        // `ç` e U+00E7 e cabe no relato de mouse; nao vira UTF-8 por aqui.
        assert_eq!(binary_bytes("\u{e7}").unwrap(), [0xe7]);
        let error = binary_bytes("\x1b[M \u{e7}\u{100}").unwrap_err();
        assert!(error.contains("U+0100"), "{error}");
        assert!(binary_bytes("\u{1f600}").is_err());
    }
}

#[cfg(test)]
mod selftest_path_tests {
    use super::prepare_selftest_paths;

    #[test]
    fn selftest_paths_stay_inside_app_owned_directories() {
        let base = std::env::temp_dir().join(format!(
            "cialai-selftest-paths-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let cache = base.join("cache");
        let logs = base.join("logs");
        let paths = prepare_selftest_paths(&cache, &logs, "fixture").unwrap();
        // Os caminhos voltam em barras normais em todos os sistemas.
        assert_eq!(
            paths.root,
            crate::platform::to_portable(cache.join("selftest").join("run-fixture"))
        );
        assert_eq!(
            paths.output,
            crate::platform::to_portable(logs.join("selftest.json"))
        );
        assert!(cache.join("selftest/run-fixture").is_dir());
        assert!(logs.is_dir());
        std::fs::remove_dir_all(base).unwrap();
    }
}

#[cfg(test)]
mod app_path_tests {
    use std::path::Path;

    use super::AppPaths;

    #[test]
    fn app_paths_are_portable_and_name_the_preferences_file() {
        let windows = AppPaths::new(
            Path::new(r"C:\Users\ana\AppData\Roaming\br.com.ordinum.cialai"),
            Path::new(r"C:\Users\ana\AppData\Roaming\br.com.ordinum.cialai"),
            Path::new(r"C:\Users\ana\AppData\Local\br.com.ordinum.cialai\logs"),
        );
        assert_eq!(
            windows.preferences,
            "C:/Users/ana/AppData/Roaming/br.com.ordinum.cialai/preferences.json"
        );
        assert_eq!(
            windows.data,
            "C:/Users/ana/AppData/Roaming/br.com.ordinum.cialai"
        );
        assert_eq!(
            windows.logs,
            "C:/Users/ana/AppData/Local/br.com.ordinum.cialai/logs"
        );

        let linux = AppPaths::new(
            Path::new("/home/ana/.config/br.com.ordinum.cialai"),
            Path::new("/home/ana/.local/share/br.com.ordinum.cialai"),
            Path::new("/home/ana/.local/share/br.com.ordinum.cialai/logs"),
        );
        assert_eq!(
            linux.preferences,
            "/home/ana/.config/br.com.ordinum.cialai/preferences.json"
        );
        assert_eq!(linux.data, "/home/ana/.local/share/br.com.ordinum.cialai");
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProbe {
    shell: ShellSpec,
    output: String,
}

/// Abre o shell escolhido num PTY descartável. O ensaio não cria uma sessão
/// persistente nem entra na ponte; serve apenas para comprovar o prompt no
/// onboarding antes de salvar a preferência.
#[tauri::command(async)]
pub fn shell_probe(
    app: AppHandle,
    prefs: State<'_, PrefsState>,
    shell: String,
    cwd: String,
) -> Result<ShellProbe, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let Some(cwd) = platform::child_env::pty_cwd(
        cwd.trim(),
        &home,
        platform::child_env::original_dir().as_deref(),
    ) else {
        return Err(tf(
            "native.error.folderNotFoundPath",
            &[("path", &cwd.trim())],
        ));
    };
    let mut preferences = prefs.get();
    preferences.terminal.shell = Some(shell.trim().into());
    preferences.terminal.args.clear();
    let shell = platform::default_shell(&preferences);
    if shell.path.trim().is_empty() {
        return Err(t("native.error.shellPathRequired"));
    }
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 12,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| tf("native.error.ptyOpen", &[("error", &error)]))?;
    let mut command = CommandBuilder::new(&shell.path);
    for arg in &shell.args {
        command.arg(arg);
    }
    command.cwd(&cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Cialai");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    command.env("PATH", platform::path_env(&preferences, &home));
    if let Some(lang) = platform::default_lang(&preferences) {
        command.env("LANG", lang);
    }
    platform::child_env::sanitize(&mut command);
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| tf("native.error.shellStart", &[("error", &error)]))?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let (send, receive) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut bytes = vec![0_u8; 4096];
        let size = reader.read(&mut bytes).unwrap_or(0);
        bytes.truncate(size);
        let _ = send.send(bytes);
    });
    let bytes = receive
        .recv_timeout(Duration::from_millis(1600))
        .unwrap_or_default();
    let _ = child.kill();
    let _ = child.wait();
    // Sem texto inicial a interface mostra o aviso no idioma dela.
    let output = String::from_utf8_lossy(&bytes).into_owned();
    Ok(ShellProbe { shell, output })
}

/* ── arquivos do estudio ──────────────────────────────────────────── */

#[tauri::command(async)]
pub fn fs_list_dir(path: String, limit: Option<usize>) -> FsResult<Listing> {
    files::list_dir(&path, limit)
}

#[tauri::command(async)]
pub fn fs_stat(path: String) -> FsResult<FileStat> {
    files::stat(&path)
}

#[tauri::command(async)]
pub fn fs_read_text(path: String) -> FsResult<TextFile> {
    files::read_text(&path)
}

/// Grava o texto. Com `expected_modified_ms`, recusa com `conflict` quando o
/// arquivo mudou no disco desde a leitura.
#[tauri::command(async)]
pub fn fs_write_text(
    path: String,
    content: String,
    expected_modified_ms: Option<u64>,
) -> FsResult<WriteResult> {
    files::write_text(&path, &content, expected_modified_ms)
}

#[tauri::command(async)]
pub fn fs_read_image(path: String) -> FsResult<ImageFile> {
    files::read_image(&path)
}

/// Bytes crus de um arquivo, para as previas de planilha e Word montadas no
/// webview. Vai como corpo binario, sem base64.
#[tauri::command(async)]
pub fn fs_read_bytes(path: String) -> FsResult<tauri::ipc::Response> {
    files::read_bytes(&path).map(tauri::ipc::Response::new)
}

/// Converte um documento do Office, iWork ou RTF em PDF pelo LibreOffice e
/// devolve a URL `preview://` do resultado, com cache por caminho, data e
/// tamanho. Uma conversao por vez; `force` ignora o cache.
#[tauri::command(async)]
pub fn office_convert(
    app: AppHandle,
    queue: State<'_, OfficeQueue>,
    roots: State<'_, PreviewRoots>,
    path: String,
    force: Option<bool>,
) -> FsResult<ConvertResult> {
    let home = app.path().home_dir().map_err(|error| FsError {
        code: "io".into(),
        message: error.to_string(),
    })?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| FsError {
            code: "io".into(),
            message: error.to_string(),
        })?
        .join("office-pdf");
    office::convert(&queue, &roots, &home, &cache, &path, force.unwrap_or(false))
}

#[tauri::command(async)]
pub fn fs_create_file(path: String) -> FsResult<FileStat> {
    files::create_file(&path)
}

#[tauri::command(async)]
pub fn fs_create_dir(path: String) -> FsResult<FileStat> {
    files::create_dir(&path)
}

/// Move ou renomeia. Recusa quando o alvo existe e quando a pasta iria para
/// dentro dela mesma.
#[tauri::command(async)]
pub fn fs_rename(from: String, to: String) -> FsResult<FileStat> {
    files::rename(&from, &to)
}

/// Copia um arquivo, um link ou uma pasta inteira, sem sobrescrever nada.
#[tauri::command(async)]
pub fn fs_copy(from: String, to: String) -> FsResult<FileStat> {
    files::copy(&from, &to)
}

/// Move para a Lixeira. Nunca apaga em definitivo.
#[tauri::command(async)]
pub fn fs_trash(path: String) -> FsResult<()> {
    files::trash(&path)
}

/// Busca por nome dentro do projeto, com indice em cache por 20 s.
#[tauri::command(async)]
pub fn fs_find(
    cache: State<'_, FindCache>,
    root: String,
    query: String,
    limit: Option<usize>,
) -> FsResult<FindResult> {
    files::find(&cache, &root, &query, limit)
}

#[tauri::command]
pub fn fs_reveal(app: AppHandle, path: String) -> FsResult<()> {
    app.opener()
        .reveal_item_in_dir(PathBuf::from(&path))
        .map_err(|error| FsError {
            code: "open".into(),
            message: error.to_string(),
        })
}

/// Abre no app padrao do sistema para o tipo do arquivo.
#[tauri::command]
pub fn fs_open_default(app: AppHandle, path: String) -> FsResult<()> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|error| FsError {
            code: "open".into(),
            message: error.to_string(),
        })
}

/// Comeca uma sessao de arraste nativa com os caminhos, para soltar no
/// Finder e em outros apps. Chamado pelo frontend quando o arraste interno
/// cruza a borda da janela com o botao ainda pressionado. Assincrono para
/// esperar a thread principal sem ocupa-la.
#[tauri::command]
pub async fn fs_drag_out(window: WebviewWindow, paths: Vec<String>) -> FsResult<()> {
    dragout::start(&window, paths)
}

/* ── previa de documento em janela separada ───────────────────────── */

/// Rotulo da janela unica de previa. Uma so janela, reaproveitada: pedir
/// outro documento troca o conteudo dela em vez de espalhar janelas.
pub const DOC_PREVIEW_LABEL: &str = "doc-preview";
/// Evento que leva o caminho novo a janela ja aberta.
pub const DOC_PREVIEW_EVENT: &str = "docpreview://path";

/// Documento que a janela de previa esta mostrando. Fica no Rust, e nao na
/// URL, para o caminho nao passar por codificacao nem aparecer na barra.
#[derive(Default)]
pub struct DocPreviewState(std::sync::Mutex<Option<String>>);

impl DocPreviewState {
    pub fn get(&self) -> Option<String> {
        self.0.lock().ok().and_then(|value| value.clone())
    }

    fn set(&self, path: &str) {
        if let Ok(mut value) = self.0.lock() {
            *value = Some(path.to_string());
        }
    }
}

/// Abre o documento numa janela separada, ou traz a que ja existe para a
/// frente com o documento novo. A divisao interna do grafo e fechada por quem
/// chama, entao a area volta inteira para o mapa.
#[tauri::command(async)]
pub fn doc_preview_window(
    app: AppHandle,
    state: State<'_, DocPreviewState>,
    path: String,
) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.is_file() {
        return Err(t("native.error.fileNotFound"));
    }
    state.set(&path);
    let title = target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "Cialai".to_string());
    if let Some(window) = app.get_webview_window(DOC_PREVIEW_LABEL) {
        let _ = window.set_title(&title);
        let _ = window.emit(DOC_PREVIEW_EVENT, path);
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        DOC_PREVIEW_LABEL,
        tauri::WebviewUrl::App("index.html?docpreview=1".into()),
    )
    .title(title)
    .inner_size(760.0, 860.0)
    .min_inner_size(360.0, 320.0)
    .resizable(true)
    .build()
    .map(|_| ())
    .map_err(|error| {
        tf(
            "native.error.previewWindow",
            &[("error", &error.to_string())],
        )
    })
}

/// Caminho que a janela de previa deve mostrar quando ela carrega.
#[tauri::command]
pub fn doc_preview_path(state: State<'_, DocPreviewState>) -> Option<String> {
    state.get()
}

/// Uso do plano dos agentes de IA: Claude Code pelo arquivo publicado pelo
/// hook de linha de estado, Codex pelo arquivo da propria sessao. Lista vazia
/// quando nenhum dos dois deixou dado recente.
#[tauri::command(async)]
pub fn ai_usage(
    app: AppHandle,
    cache: State<'_, UsageCache>,
    terminals: State<'_, TerminalManager>,
) -> Vec<AgentUsage> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let Ok(support) = app.path().app_data_dir() else {
        return Vec::new();
    };
    ai::cached(&cache, &home, &support, &terminals.codex_homes())
}

/* ── grafo da documentação ────────────────────────────────────────── */

/// Varre a raiz do projeto atrás de arquivos Markdown, para o grafo da
/// documentação do estúdio. `key` é a sessão e `token` identifica o pedido: um
/// pedido novo da mesma chave cancela o anterior. Pode durar até o prazo de
/// [`docgraph::SCAN_TIME_BUDGET`], por isso roda numa thread de bloqueio e não
/// num worker do runtime.
#[tauri::command]
pub async fn docgraph_scan(
    scans: State<'_, DocScans>,
    key: String,
    token: String,
    root: String,
) -> FsResult<DocScan> {
    let guard = scans.begin(&key, &token);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let result = docgraph::scan(&root, guard.flag(), &ScanOptions::default());
        drop(guard);
        result
    })
    .await
    .map_err(|error| FsError {
        code: "io".into(),
        message: crate::i18n::tf("native.error.scanFailed", &[("error", &error.to_string())]),
    })?;
    outcome.map(|mut scan| {
        scan.key = key;
        scan.token = token;
        scan
    })
}

/// Cancela a varredura da chave. Com `token`, só se for a desse pedido.
#[tauri::command]
pub fn docgraph_cancel(scans: State<'_, DocScans>, key: String, token: Option<String>) -> bool {
    scans.cancel(&key, token.as_deref())
}

/* ── contas dos agentes ───────────────────────────────────────────── */

/// Uma conta que o agente pode usar, para a tela de troca. Nunca leva
/// `account_key`, caminho de pasta, token nem conteúdo de arquivo de
/// credencial: só o que a pessoa precisa ver para escolher.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProfileView {
    /// `claude`, `claude-webrota`, `codex`, `codex-amorim`.
    pub id: String,
    /// `claude` ou `codex`.
    pub agent: String,
    pub label: String,
    pub plan: Option<String>,
    /// A pasta sem sufixo, que o agente usa quando nada é escolhido.
    pub is_default: bool,
    /// Conta que as sessões novas vão usar.
    pub active: bool,
    /// A pasta ainda não tem credencial: o login do próprio CLI está pendente.
    pub needs_login: bool,
    /// Conta logada, quando o perfil a publica em disco.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Leitura de uso da conta, a mesma da Barra de IA: janelas com rótulo,
    /// janela do anel, estado da leitura, fonte e instante. Vem do mesmo
    /// lugar nos dois provedores, então Claude Code e Codex mostram o mesmo
    /// tipo de número. `None` só quando nem placeholder existe.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<crate::notch::usage::ProviderSnapshot>,
}

/// Contas de cada agente, com a marca do perfil ativo e o uso do plano.
///
/// O uso vem da loja da Barra de IA, e não mais de `workspace::ai`: aquela lê
/// o Claude Code só pelo hook de linha de estado, então uma conta sem o hook
/// aparecia sem plano e sem porcentagem enquanto o Codex mostrava as duas
/// coisas. A loja lê CLI, endpoint oficial, cache do Claude Desktop e o
/// próprio hook, e publica o estado de cada leitura em vez de um zero
/// inventado.
#[tauri::command(async)]
pub fn agent_profiles(
    app: AppHandle,
    prefs: State<'_, PrefsState>,
    notch: State<'_, crate::notch::NotchManager>,
) -> Result<Vec<AgentProfileView>, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let snapshots = notch.all_snapshots();
    let active = prefs.get().agents.active_profile.clone();
    Ok(crate::notch::profiles::discover(&home)
        .into_iter()
        .map(|profile| {
            let agent = profile.provider.as_str().to_string();
            let usage = snapshots
                .iter()
                .find(|item| item.id == profile.id)
                .cloned()
                .map(|mut snapshot| {
                    // A pasta de configuracao nunca sai daqui, nem para o
                    // celular: para escolher a conta bastam o rotulo, a conta
                    // logada, o plano e o uso.
                    snapshot.config_dir = String::new();
                    snapshot
                });
            AgentProfileView {
                active: active.get(&agent) == Some(profile.id.as_str()),
                is_default: profile.slug.is_none(),
                needs_login: !crate::notch::usage::credentials::exists(
                    &profile.dir(),
                    profile.slug.is_none(),
                ),
                label: profile.label.clone(),
                // O plano da leitura vence o do arquivo de conta: o Claude
                // Code só publica a assinatura na credencial, que a loja lê.
                plan: usage
                    .as_ref()
                    .and_then(|item| item.plan.clone())
                    .or_else(|| profile.plan.clone()),
                account: profile.account.clone(),
                id: profile.id,
                agent,
                usage,
            }
        })
        .collect())
}

/// Relê o uso de todas as contas agora, inclusive as escondidas da Barra de
/// IA. É o que o botão de reler as contas chama antes de pedir a lista.
#[tauri::command(async)]
pub fn agent_profiles_refresh(notch: State<'_, crate::notch::NotchManager>) {
    notch.refresh_scope(None, true);
}

/// Escolhe a conta que os terminais novos vão usar. Vazio volta a não
/// interferir. Tarefa em execução continua na conta em que começou.
#[tauri::command(async)]
pub fn agent_profile_select(
    app: AppHandle,
    prefs: State<'_, PrefsState>,
    agent: String,
    id: String,
) -> Result<(), String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let kind = crate::workspace::agent_profiles::Agent::parse(&agent)
        .ok_or_else(|| crate::i18n::t("native.error.agentUnknown"))?;
    if !id.is_empty() {
        let valid = crate::workspace::agent_profiles::dir_of(&home, kind, &id)
            .is_some_and(|dir| crate::workspace::agent_profiles::is_profile_dir(&dir, kind));
        if !valid {
            return Err(crate::i18n::t("native.error.profileUnknown"));
        }
    }
    let mut next = prefs.get();
    if !next.agents.active_profile.set(&agent, &id) {
        return Err(crate::i18n::t("native.error.agentUnknown"));
    }
    next.save(&app)?;
    prefs.set(next);
    let _ = app.emit("agents://profiles", ());
    Ok(())
}

/// Cria a pasta de uma conta nova, vazia e só para o dono. O login é feito
/// pelo próprio CLI, no terminal que a interface abre em seguida.
#[tauri::command(async)]
pub fn agent_profile_create(app: AppHandle, agent: String, name: String) -> Result<String, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let kind = crate::workspace::agent_profiles::Agent::parse(&agent)
        .ok_or_else(|| crate::i18n::t("native.error.agentUnknown"))?;
    crate::workspace::agent_profiles::create(&home, kind, &name)?;
    let _ = app.emit("agents://profiles", ());
    Ok(format!("{agent}-{name}"))
}

/// Abre o agente numa conta escolhida, no terminal já aberto. Só escreve com o
/// shell no prompt e sem processo em primeiro plano.
#[tauri::command(async)]
pub fn pty_launch_agent(
    terminals: State<'_, TerminalManager>,
    id: u32,
    agent: String,
    profile: String,
) -> Result<(), String> {
    terminals.launch_agent(id, &agent, &profile)
}

/// Instala a linha de estado do Claude Code nos perfis da pasta pessoal. E
/// ela que publica o uso do plano, o modelo, o esforco, o contexto e o custo
/// que `ai_usage` le para os cards.
#[tauri::command(async)]
pub fn ai_install_claude_hook(app: AppHandle) -> Result<ai::HookInstall, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    ai::install_claude_hook(&home)
}

/// Passa a observar um caminho; as mudancas chegam por `fs://change`.
#[tauri::command]
pub fn fs_watch(watcher: State<'_, Watcher>, path: String) -> Result<u64, String> {
    watcher.watch(&path)
}

#[tauri::command]
pub fn fs_unwatch(watcher: State<'_, Watcher>, id: u64) {
    watcher.unwatch(id);
}

/* ── git ──────────────────────────────────────────────────────────── */

#[tauri::command(async)]
pub fn git_status(dir: String) -> Result<GitStatus, String> {
    git::status(&dir)
}

#[tauri::command(async)]
pub fn git_diff(root: String, path: String) -> Result<GitDiff, String> {
    git::diff(&root, &path)
}

/* ── dev browser ──────────────────────────────────────────────────── */

/// Lanca o Chromium da sessao, ou devolve o que ja esta vivo. `origin` e a
/// origem do webview, que o Chromium precisa autorizar para o WebSocket.
#[tauri::command(async)]
#[allow(clippy::too_many_arguments)]
pub fn browser_start(
    browsers: State<'_, BrowserManager>,
    session_id: String,
    cwd: String,
    width: Option<u32>,
    height: Option<u32>,
    origin: String,
    start_url: Option<String>,
) -> Result<BrowserInfo, String> {
    browsers.start(
        &session_id,
        &cwd,
        width.unwrap_or(1200),
        height.unwrap_or(800),
        &origin,
        start_url.as_deref().unwrap_or(""),
    )
}

#[tauri::command(async)]
pub fn browser_stop(browsers: State<'_, BrowserManager>, session_id: String, purge: Option<bool>) {
    browsers.stop(&session_id, purge.unwrap_or(false));
}

#[tauri::command]
pub fn browser_status(
    browsers: State<'_, BrowserManager>,
    session_id: String,
) -> Option<BrowserInfo> {
    browsers.status(&session_id)
}

#[tauri::command]
pub fn browser_list(browsers: State<'_, BrowserManager>) -> Vec<BrowserInfo> {
    browsers.list()
}

/* ── visualizacao de html ─────────────────────────────────────────── */

/// Registra a raiz de um projeto para o protocolo `preview://` e devolve o
/// token que vira o host da URL.
#[tauri::command]
pub fn preview_register(roots: State<'_, PreviewRoots>, root: String) -> Result<String, String> {
    roots.register(&root)
}

#[cfg(test)]
mod agent_profile_tests {
    use super::*;

    /// A tela de troca precisa do que a pessoa vê para escolher, e de nada
    /// além disso. `accountKey`, token e conteúdo de credencial nunca saem
    /// daqui, nem para o computador nem para o celular.
    #[test]
    fn the_profile_view_carries_no_account_key_and_no_credential() {
        let view = AgentProfileView {
            id: "codex-work".into(),
            agent: "codex".into(),
            label: "work".into(),
            plan: Some("plus".into()),
            is_default: false,
            active: true,
            needs_login: false,
            account: Some("work@exemplo.com".into()),
            usage: Some(crate::notch::usage::ProviderSnapshot {
                id: "codex-work".into(),
                provider: "codex".into(),
                label: "work".into(),
                account: Some("work@exemplo.com".into()),
                // A pasta de configuracao sai vazia antes de ir para a tela,
                // como `agent_profiles` a limpa.
                config_dir: String::new(),
                plan: Some("plus".into()),
                fidelity: crate::notch::usage::Fidelity::Official,
                status: crate::notch::usage::ProviderStatus::Ok,
                windows: vec![crate::notch::usage::LimitWindow {
                    id: "primary".into(),
                    group: None,
                    label: "duration".into(),
                    used_fraction: Some(0.41),
                    resets_at_ms: None,
                    duration_ms: Some(5 * 3_600_000),
                }],
                headline_id: Some("primary".into()),
                weekly_id: None,
                fetched_at_ms: 1,
                source: Some("chatgptApi".into()),
            }),
        };
        let wire = serde_json::to_value(&view).unwrap();
        let mut keys = wire
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        keys.sort();
        assert_eq!(
            keys,
            [
                "account",
                "active",
                "agent",
                "id",
                "isDefault",
                "label",
                "needsLogin",
                "plan",
                "usage",
            ]
        );
        // A pasta de configuracao nunca vai junto, nem dentro da leitura.
        assert_eq!(
            wire.pointer("/usage/configDir").and_then(|v| v.as_str()),
            Some("")
        );
        let text = wire.to_string();
        for forbidden in [
            "accountKey",
            "account_key",
            "token",
            "auth.json",
            "credential",
            "/Users/",
            ".codex-",
        ] {
            assert!(
                !text.contains(forbidden),
                "{forbidden} nao pode sair: {text}"
            );
        }
    }
}
