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
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::platform::{self, PlatformInfo, ShellSpec};
use crate::prefs::{Preferences, PrefsState};
use crate::tunnel::{RpcProblem, SecretStatus, Supervisor};
use crate::workspace::ai::{self, AgentUsage, UsageCache};
use crate::workspace::browser::{BrowserInfo, BrowserManager};
use crate::workspace::dragout;
use crate::workspace::files::{
    self, FileStat, FindCache, FindResult, FsError, FsResult, ImageFile, Listing, TextFile,
    WriteResult,
};
use crate::workspace::git::{self, GitDiff, GitStatus};
use crate::workspace::journal::SavedTerminal;
use crate::workspace::office::{self, ConvertResult, OfficeQueue};
use crate::workspace::preview::PreviewRoots;
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
    next: Preferences,
) -> Result<Preferences, String> {
    next.save(&app)?;
    if let Some(browsers) = app.try_state::<BrowserManager>() {
        browsers.set_chromium_path(next.dev_browser.chromium_path.clone());
    }
    prefs.set(next.clone());
    Ok(next)
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

#[tauri::command(async)]
pub async fn tunnel_control_configure(
    supervisor: State<'_, Supervisor>,
    url: String,
    api_key: String,
    ca_file: Option<String>,
) -> Result<serde_json::Value, RpcProblem> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        supervisor.configure_control(url, api_key, ca_file)
    })
    .await
    .map_err(tunnel_join_error)?
}

#[tauri::command(async)]
pub async fn tunnel_control_configure_saved(
    supervisor: State<'_, Supervisor>,
    url: String,
    ca_file: Option<String>,
) -> Result<serde_json::Value, RpcProblem> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.configure_saved_control(url, ca_file))
        .await
        .map_err(tunnel_join_error)?
}

#[tauri::command(async)]
pub async fn tunnel_control_rotate_api_key(
    supervisor: State<'_, Supervisor>,
    days: u16,
) -> Result<serde_json::Value, RpcProblem> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.rotate_api_key(days))
        .await
        .map_err(tunnel_join_error)?
}

#[tauri::command(async)]
pub async fn tunnel_api_key_status(
    supervisor: State<'_, Supervisor>,
) -> Result<SecretStatus, RpcProblem> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.secret_status())
        .await
        .map_err(tunnel_join_error)?
}

#[tauri::command(async)]
pub async fn tunnel_delete_api_key(supervisor: State<'_, Supervisor>) -> Result<(), RpcProblem> {
    let supervisor = supervisor.inner().clone();
    tauri::async_runtime::spawn_blocking(move || supervisor.delete_api_key())
        .await
        .map_err(tunnel_join_error)?
}

/// O frontend montou a tela de abertura: a janela pequena pode aparecer.
/// Roda fora da thread principal porque a coreografia espera giros do loop.
#[tauri::command(async)]
pub fn splash_ready(window: WebviewWindow) {
    crate::window::show_splash(&window);
}

/// Os dados chegaram: cresce a janela ate o tamanho de trabalho. Roda fora da
/// thread principal e responde quando a animacao termina.
#[tauri::command(async)]
pub fn window_grow(window: WebviewWindow) -> bool {
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
pub fn pty_spawn(
    terminals: State<'_, TerminalManager>,
    cwd: String,
    cols: u16,
    rows: u16,
    tag: Option<String>,
    on_output: Channel,
) -> Result<TerminalInfo, String> {
    terminals.spawn(&cwd, cols, rows, tag.as_deref().unwrap_or(""), on_output)
}

/// Medicoes reais de cada sessao viva: CPU e memoria da arvore de processos,
/// processo em primeiro plano, agente reconhecido e diretorio atual do shell.
#[tauri::command(async)]
pub fn pty_metrics(terminals: State<'_, TerminalManager>) -> Vec<SessionMetrics> {
    terminals.metrics()
}

/// Texto digitado ou colado. Com `binary`, cada char e um byte, para os
/// eventos `onBinary` do xterm.
#[tauri::command]
pub fn pty_write(
    terminals: State<'_, TerminalManager>,
    id: u32,
    data: String,
    binary: Option<bool>,
) -> Result<(), String> {
    if binary.unwrap_or(false) {
        let bytes: Vec<u8> = data.chars().map(|char| char as u32 as u8).collect();
        terminals.write(id, &bytes)
    } else {
        terminals.write(id, data.as_bytes())
    }
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
) -> Result<(), String> {
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
        assert_eq!(
            paths.root,
            cache.join("selftest/run-fixture").to_string_lossy()
        );
        assert_eq!(paths.output, logs.join("selftest.json").to_string_lossy());
        assert!(cache.join("selftest/run-fixture").is_dir());
        assert!(logs.is_dir());
        std::fs::remove_dir_all(base).unwrap();
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
    let cwd = Path::new(cwd.trim());
    if !cwd.is_dir() {
        return Err(format!("Pasta não encontrada: {}", cwd.display()));
    }
    let mut preferences = prefs.get();
    preferences.terminal.shell = Some(shell.trim().into());
    preferences.terminal.args.clear();
    let shell = platform::default_shell(&preferences);
    if shell.path.trim().is_empty() {
        return Err("Informe o caminho do shell.".into());
    }
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: 12,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("Não foi possível abrir o PTY: {error}"))?;
    let mut command = CommandBuilder::new(&shell.path);
    for arg in &shell.args {
        command.arg(arg);
    }
    command.cwd(cwd);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "Cialai");
    command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
    command.env("PATH", platform::path_env(&preferences, &home));
    if let Some(lang) = platform::default_lang(&preferences) {
        command.env("LANG", lang);
    }
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Não foi possível iniciar o shell: {error}"))?;
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
    let output = if bytes.is_empty() {
        "PTY aberto; o shell não escreveu texto inicial.".into()
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
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

/// Uso do plano dos agentes de IA: Claude Code pelo arquivo publicado pelo
/// hook de linha de estado, Codex pelo arquivo da propria sessao. Lista vazia
/// quando nenhum dos dois deixou dado recente.
#[tauri::command(async)]
pub fn ai_usage(app: AppHandle, cache: State<'_, UsageCache>) -> Vec<AgentUsage> {
    let Ok(home) = app.path().home_dir() else {
        return Vec::new();
    };
    let Ok(support) = app.path().app_data_dir() else {
        return Vec::new();
    };
    ai::cached(&cache, &home, &support)
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
