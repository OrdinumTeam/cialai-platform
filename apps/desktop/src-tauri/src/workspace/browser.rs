// SPDX-License-Identifier: Apache-2.0
//! Dev Browser por sessao do estudio: um Chromium headless por sessao, com
//! perfil e porta proprios, dirigido pelo protocolo do DevTools. O Rust so
//! lanca e supervisiona o processo; o webview fala com o CDP direto por
//! WebSocket, entao os quadros do screencast nunca passam pelo IPC.
//!
//! O que fica no disco:
//!
//! - o perfil do Chromium em `<Application Support>/dev-browser/<sessao>/profile`,
//!   com um `owner.json` dizendo qual app e qual Chromium o usam, para o
//!   proximo lancamento recolher orfaos de um app que morreu sem despedida;
//! - `<pasta da sessao>/.dev-browser-panel/port` e `owner.json`, que e onde
//!   os agentes do terminal leem a porta, no mesmo lugar em que a extensao do
//!   VS Code publica a dela. A primeira sessao a abrir um browser numa pasta
//!   e a dona do arquivo; as outras so mostram quem e;
//! - `~/.dev-browser-panel/port` e `owner.json`, o ponteiro global "ultimo
//!   aberto", reivindicado so quando o dono registrado nao esta mais vivo.
//!
//! O Chromium recusa WebSocket vindo de um navegador pelo cabecalho
//! `Origin`: o lancador passa `--remote-allow-origins` com a origem do
//! webview, `tauri://localhost` no app e `http://127.0.0.1:1420` no
//! desenvolvimento. O CLI `dev-browser`, o Playwright e o Puppeteer nao
//! mandam `Origin` e continuam entrando.
//!
//! Numa maquina sem Chromium nenhum, o primeiro `start` instala o do
//! Playwright em vez de devolver erro, e o andamento do download sai por
//! `browser://install` para a aba mostrar.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::platform;

use super::procs;

/// Evento global emitido quando um Chromium termina.
pub const EVENT_BROWSER_EXIT: &str = "browser://exit";
/// Pasta dos arquivos de porta, na pasta da sessao e na home.
pub const PORT_DIR: &str = ".dev-browser-panel";
/// Prazo para o Chromium anunciar a porta do DevTools.
const START_TIMEOUT: Duration = Duration::from_secs(20);
/// Entre o SIGTERM e o SIGKILL ao encerrar.
#[cfg(unix)]
const STOP_GRACE: Duration = Duration::from_millis(500);
/// Cache de disco por perfil; o disco do usuario anda apertado.
const DISK_CACHE_BYTES: u64 = 50 * 1024 * 1024;
/// Cauda do stderr guardada para o diagnostico de uma saida inesperada.
const STDERR_TAIL: usize = 4 * 1024;
/// Evento global com o andamento da instalacao automatica do Chromium.
pub const EVENT_BROWSER_INSTALL: &str = "browser://install";
/// Teto da instalacao automatica. O download passa de 200 MiB.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Linhas finais do instalador guardadas para explicar uma falha.
const INSTALL_TAIL_LINES: usize = 4;
/// O instalador, com `$1` sendo a pasta do Playwright. A pasta e fixada
/// depois do perfil do usuario, para um `PLAYWRIGHT_BROWSERS_PATH` do
/// `.zprofile` nao mandar o download para outro lugar; `exec 2>&1` traz a
/// saida de erro do `npx` na mesma leitura.
const INSTALL_SCRIPT: &str =
    "exec 2>&1; export PLAYWRIGHT_BROWSERS_PATH=\"$1\"; exec npx --yes playwright install chromium";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInfo {
    pub session_id: String,
    pub port: u16,
    pub ws_url: String,
    pub pid: u32,
    pub profile_dir: String,
    pub binary: String,
    /// Arquivo de porta na pasta da sessao, quando esta sessao e a dona.
    pub port_file: Option<String>,
    /// `self` quando o arquivo de porta da pasta aponta para este browser,
    /// `other` quando outra sessao viva chegou primeiro.
    pub port_owner: String,
    pub port_owner_session: Option<String>,
    pub downloads_dir: String,
    /// O ponteiro global `~/.dev-browser-panel/port` aponta para este browser.
    pub global_port: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserExit {
    pub session_id: String,
    pub pid: u32,
    pub code: Option<i32>,
    pub signal: Option<i32>,
    pub stderr_tail: String,
}

/// Andamento da instalacao automatica do Chromium. Nao tem sessao: uma
/// instalacao serve todas as que estao esperando para abrir.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserInstall {
    /// `false` no ultimo aviso, quando o instalador terminou.
    pub running: bool,
    pub message: String,
}

/// Dono de um perfil ou de um arquivo de porta.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Owner {
    pub app_pid: u32,
    pub chromium_pid: u32,
    pub port: u16,
    pub session_id: String,
    pub cwd: String,
    /// Campo que a extensao do VS Code grava no `owner.json` global.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

struct Running {
    info: BrowserInfo,
    cwd: String,
    stderr: Arc<Mutex<String>>,
    #[cfg(target_os = "windows")]
    job: crate::platform::win_job::JobHandle,
}

pub struct BrowserManager {
    app: AppHandle,
    /// `<Application Support>/dev-browser`.
    root: PathBuf,
    home: PathBuf,
    chromium_path: Mutex<Option<String>>,
    instances: Mutex<HashMap<String, Running>>,
    /// Uma instalacao do Chromium por vez: quem chega no meio espera a vez e
    /// aproveita o que a primeira baixou.
    install_lock: Mutex<()>,
}

/// Confirma que o pid ainda e o Chromium daquele perfil, pela linha de
/// comando, antes de mandar sinal.
fn is_chromium_of(pid: u32, profile: &Path) -> bool {
    let needle = profile.to_string_lossy().to_string();
    procs::command_line(pid)
        .map(|line| line.argv.iter().any(|arg| arg.contains(&needle)))
        .unwrap_or(false)
}

/// Origens que podem falar com o CDP a partir do webview: a do app e as de
/// desenvolvimento em loopback.
pub fn allowed_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost" | "https://tauri.localhost" | "http://tauri.localhost"
    ) {
        return true;
    }
    if let Some(rest) = origin.strip_prefix("http://") {
        let host = rest.split(':').next().unwrap_or("");
        return matches!(host, "127.0.0.1" | "localhost");
    }
    false
}

/// `DevTools listening on ws://127.0.0.1:PORTA/devtools/browser/<id>`.
pub fn parse_devtools_line(line: &str) -> Option<(u16, String)> {
    let url = line.trim().strip_prefix("DevTools listening on ")?.trim();
    let rest = url.strip_prefix("ws://")?;
    let host_port = rest.split('/').next()?;
    let port: u16 = host_port.rsplit(':').next()?.parse().ok()?;
    Some((port, url.to_string()))
}

/// Maior revisao entre pastas `prefixo-NNNN`.
fn newest_revision(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let read = fs::read_dir(dir).ok()?;
    let mut best: Option<(u64, PathBuf)> = None;
    for entry in read.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(prefix) else {
            continue;
        };
        let Ok(revision) = rest.parse::<u64>() else {
            continue;
        };
        if best
            .as_ref()
            .map(|(current, _)| revision > *current)
            .unwrap_or(true)
        {
            best = Some((revision, entry.path()));
        }
    }
    best.map(|(_, path)| path)
}

/// Navegadores em `/Applications` aceitos quando nao ha nada do Playwright.
#[cfg(target_os = "macos")]
const APP_FALLBACKS: [&str; 3] = [
    "/Applications/Google Chrome.app",
    "/Applications/Chromium.app",
    "/Applications/Google Chrome for Testing.app",
];

/// O executavel de dentro de um bundle `.app`, sem fixar o nome do binario.
#[cfg(target_os = "macos")]
fn app_binary(app: &Path) -> Option<PathBuf> {
    let macos = app.join("Contents/MacOS");
    if let Some(stem) = app.file_stem() {
        let by_name = macos.join(stem);
        if by_name.is_file() {
            return Some(by_name);
        }
    }
    let mut found: Vec<PathBuf> = fs::read_dir(&macos)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_file())
        .collect();
    found.sort();
    found.into_iter().next()
}

#[cfg(target_os = "macos")]
fn bundled_app(dir: &Path) -> Option<PathBuf> {
    let mut apps: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "app"))
        .collect();
    apps.sort();
    apps.into_iter().find_map(|app| app_binary(&app))
}

fn prefixed_binary(dir: &Path, prefix: &str, binary: &str) -> Option<PathBuf> {
    let mut builds: Vec<PathBuf> = fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with(prefix))
        })
        .collect();
    builds.sort();
    builds
        .into_iter()
        .map(|build| build.join(binary))
        .find(|path| path.is_file())
}

fn find_playwright_binary(cache: &Path, os: &str) -> Option<PathBuf> {
    if let Some(dir) = newest_revision(cache, "chromium_headless_shell-") {
        let found = match os {
            "macos" => prefixed_binary(&dir, "chrome-headless-shell-mac", "chrome-headless-shell"),
            "linux" => {
                prefixed_binary(&dir, "chrome-headless-shell-linux", "chrome-headless-shell")
            }
            "windows" => prefixed_binary(
                &dir,
                "chrome-headless-shell-win",
                "chrome-headless-shell.exe",
            ),
            _ => None,
        };
        if found.is_some() {
            return found;
        }
    }
    let dir = newest_revision(cache, "chromium-")?;
    match os {
        #[cfg(target_os = "macos")]
        "macos" => {
            let mut builds: Vec<PathBuf> = fs::read_dir(&dir)
                .ok()?
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("chrome-mac"))
                })
                .collect();
            builds.sort();
            builds.into_iter().find_map(|build| bundled_app(&build))
        }
        "linux" => prefixed_binary(&dir, "chrome-linux", "chrome"),
        "windows" => prefixed_binary(&dir, "chrome-win", "chrome.exe"),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn installed_binary(_home: &Path) -> Option<PathBuf> {
    APP_FALLBACKS
        .iter()
        .find_map(|app| app_binary(Path::new(app)))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn installed_binary(_home: &Path) -> Option<PathBuf> {
    [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "microsoft-edge",
    ]
    .into_iter()
    .find_map(|name| which::which(name).ok())
    .or_else(|| {
        ["/snap/bin/chromium", "/snap/bin/microsoft-edge"]
            .into_iter()
            .map(PathBuf::from)
            .find(|path| path.is_file())
    })
}

#[cfg(target_os = "windows")]
fn installed_binary(_home: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for variable in ["PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"] {
        if let Some(root) = std::env::var_os(variable).map(PathBuf::from) {
            candidates.push(root.join("Google/Chrome/Application/chrome.exe"));
            candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
        }
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .or_else(|| {
            ["chrome.exe", "msedge.exe"]
                .into_iter()
                .find_map(|name| which::which(name).ok())
        })
}

/// Binario do Chromium: a preferencia do app, o cache do Playwright e as
/// instalacoes usuais de cada sistema.
pub fn find_binary(home: &Path, preferred: Option<&str>) -> Option<PathBuf> {
    if let Some(path) = preferred.map(str::trim).filter(|value| !value.is_empty()) {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
        #[cfg(target_os = "macos")]
        if let Some(binary) = app_binary(&candidate) {
            return Some(binary);
        }
    }
    find_playwright_binary(&platform::playwright_cache(home), std::env::consts::OS)
        .or_else(|| installed_binary(home))
}

/// Traduz uma linha do `playwright install` para o painel: o inicio de cada
/// download e o percentual, que sem TTY sai de dez em dez. O resto, como a
/// moldura do aviso de projeto sem dependencias, fica de fora. `current`
/// guarda o nome do download em curso, que a linha de percentual nao traz.
fn install_progress(line: &str, current: &mut String) -> Option<String> {
    let line = line.trim();
    // `Downloading Chrome for Testing 153.0.8010.12 (playwright chromium v1243) from https://...`
    if let Some(rest) = line.strip_prefix("Downloading ") {
        let title = rest.split(" (").next().unwrap_or(rest);
        let title = title.split(" from ").next().unwrap_or(title).trim();
        let name = title
            .trim_end_matches(|value: char| value.is_ascii_digit() || value == '.')
            .trim();
        *current = if name.is_empty() {
            title.to_string()
        } else {
            name.to_string()
        };
        return Some(format!("Baixando {current}"));
    }
    // `|■■■■■■        |  40% of 162.4 MiB`
    let (_, tail) = line.strip_prefix('|')?.rsplit_once('|')?;
    let (percent, size) = tail.trim().split_once("% of ")?;
    let percent: f64 = percent.trim().parse().ok()?;
    let name = if current.is_empty() {
        "Chromium"
    } else {
        current.as_str()
    };
    Some(format!("Baixando {name}, {percent:.0}% de {}", size.trim()))
}

/// Roda o instalador no shell do sistema e repassa o andamento a `progress`.
/// No teto de tempo recolhe tambem os processos filhos.
fn run_install(
    script: &str,
    home: &Path,
    cache: &Path,
    cwd: &Path,
    timeout: Duration,
    mut progress: impl FnMut(String),
) -> Result<(), String> {
    #[cfg(unix)]
    let mut command = {
        let shell = if cfg!(target_os = "macos") {
            "/bin/zsh".to_string()
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
        };
        let mut command = Command::new(&shell);
        command.arg("-lc").arg(script).arg(&shell).arg(cache);
        command.env("HOME", home);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let _ = script;
        let mut command = Command::new("cmd.exe");
        command.args([
            "/d",
            "/s",
            "/c",
            "npx.cmd --yes playwright install chromium 2>&1",
        ]);
        command.env("PLAYWRIGHT_BROWSERS_PATH", cache);
        command
    };
    command
        .current_dir(cwd)
        .env("PATH", super::office::search_path(home))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    platform::configure_background_command(&mut command);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Não foi possível iniciar a instalação do Chromium: {error}"))?;
    let pid = child.id();
    #[cfg(target_os = "windows")]
    let install_job = crate::platform::win_job::assign(pid).map_err(|error| {
        let _ = child.kill();
        let _ = child.wait();
        format!("Não foi possível isolar a instalação do Chromium: {error}")
    })?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Sem saída do instalador do Chromium".to_string())?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    thread::Builder::new()
        .name("browser-install".to_string())
        .spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if tx.send(line).is_err() {
                    break;
                }
            }
        })
        .map_err(|error| error.to_string())?;
    let mut current = String::new();
    let mut tail: Vec<String> = Vec::new();
    let mut take = |line: String| {
        if let Some(message) = install_progress(&line, &mut current) {
            progress(message);
        }
        let line = line.trim();
        // A moldura do aviso e as barras de progresso nao explicam falha.
        if line.is_empty() || line.starts_with(['╔', '║', '╚', '|']) {
            return;
        }
        tail.push(line.to_string());
        if tail.len() > INSTALL_TAIL_LINES {
            tail.remove(0);
        }
    };
    let started = Instant::now();
    let status = loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => take(line),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            // A saida fechou antes de o processo sair: sem a pausa, a espera
            // viraria laco ocupado.
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                thread::sleep(Duration::from_millis(100))
            }
        }
        if let Ok(Some(status)) = child.try_wait() {
            break status;
        }
        if started.elapsed() > timeout {
            #[cfg(unix)]
            platform::terminate_background_process(pid, true);
            #[cfg(target_os = "windows")]
            let _ = install_job.terminate();
            let _ = child.wait();
            let seconds = timeout.as_secs();
            let limit = if seconds >= 60 {
                format!("{} min", seconds / 60)
            } else {
                format!("{seconds} s")
            };
            return Err(format!(
                "A instalação do Chromium passou de {limit} e foi interrompida"
            ));
        }
    };
    // O processo saiu; o que ficou no caminho da leitura chega agora.
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(500)) {
        take(line);
    }
    if status.success() {
        return Ok(());
    }
    if status.code() == Some(127) {
        return Err("O npx não foi encontrado para instalar o Chromium. Instale o Node, ou aponte o binário em Preferências".to_string());
    }
    let joined = tail.join(" ");
    let detail = joined.trim().trim_end_matches('.');
    let detail = if detail.is_empty() {
        format!("código {}", status.code().unwrap_or(-1))
    } else {
        detail.to_string()
    };
    Err(format!(
        "A instalação do Chromium falhou: {detail}. Rode npx playwright install chromium no terminal, ou aponte o binário em Preferências"
    ))
}

fn read_owner(path: &Path) -> Option<Owner> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, raw).map_err(|error| error.to_string())
}

/// O dono registrado num `owner.json` ainda esta vivo: o app ou o Chromium.
fn owner_alive(owner: &Owner) -> bool {
    platform::process_alive(owner.app_pid)
        || platform::process_alive(owner.chromium_pid)
        || owner.pid.map(platform::process_alive).unwrap_or(false)
}

/// Reivindica `<dir>/port` para este browser, a menos que outro dono vivo
/// ja o tenha. Devolve o dono atual quando nao conseguiu.
pub fn claim_port_file(dir: &Path, owner: &Owner) -> Result<Option<Owner>, String> {
    let owner_path = dir.join("owner.json");
    if let Some(current) = read_owner(&owner_path) {
        let same = current.session_id == owner.session_id && current.app_pid == owner.app_pid;
        if !same && owner_alive(&current) {
            return Ok(Some(current));
        }
    }
    fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    fs::write(dir.join("port"), format!("{}\n", owner.port)).map_err(|error| error.to_string())?;
    write_json(&owner_path, owner)?;
    Ok(None)
}

/// Solta `<dir>/port` se ainda apontar para este browser.
pub fn release_port_file(dir: &Path, session_id: &str, app_pid: u32) {
    let owner_path = dir.join("owner.json");
    let Some(current) = read_owner(&owner_path) else {
        return;
    };
    if current.session_id != session_id || current.app_pid != app_pid {
        return;
    }
    let _ = fs::remove_file(dir.join("port"));
    let _ = fs::remove_file(owner_path);
}

fn chromium_args(
    binary: &Path,
    port_dir: &Path,
    profile: &Path,
    origin: &str,
    width: u32,
    height: u32,
    start_url: &str,
) -> Vec<String> {
    let headless_shell = binary.to_string_lossy().contains("headless-shell");
    let mut args = vec![
        "--remote-debugging-port=0".to_string(),
        "--remote-debugging-address=127.0.0.1".to_string(),
        format!("--remote-allow-origins={origin}"),
        format!("--user-data-dir={}", profile.to_string_lossy()),
        "--no-first-run".to_string(),
        "--no-default-browser-check".to_string(),
        "--disable-background-networking".to_string(),
        "--disable-background-timer-throttling".to_string(),
        "--disable-backgrounding-occluded-windows".to_string(),
        "--disable-breakpad".to_string(),
        "--disable-client-side-phishing-detection".to_string(),
        "--disable-component-extensions-with-background-pages".to_string(),
        "--disable-default-apps".to_string(),
        "--disable-dev-shm-usage".to_string(),
        "--disable-extensions".to_string(),
        "--disable-features=Translate,OptimizationHints,DialMediaRouteProvider,GlobalMediaControls,MediaRouter,PaintHolding".to_string(),
        "--disable-hang-monitor".to_string(),
        "--disable-ipc-flooding-protection".to_string(),
        "--disable-popup-blocking".to_string(),
        "--disable-prompt-on-repost".to_string(),
        "--disable-renderer-backgrounding".to_string(),
        "--disable-sync".to_string(),
        "--enable-features=CDPScreenshotNewSurface".to_string(),
        "--force-color-profile=srgb".to_string(),
        "--metrics-recording-only".to_string(),
        "--no-sandbox".to_string(),
        "--hide-scrollbars".to_string(),
        "--mute-audio".to_string(),
        "--use-mock-keychain".to_string(),
        "--password-store=basic".to_string(),
        format!("--disk-cache-size={DISK_CACHE_BYTES}"),
        if headless_shell { "--headless".to_string() } else { "--headless=new".to_string() },
        format!("--window-size={width},{height}"),
    ];
    let _ = port_dir;
    args.push(if start_url.is_empty() {
        "about:blank".to_string()
    } else {
        start_url.to_string()
    });
    args
}

impl BrowserManager {
    pub fn new(
        app: AppHandle,
        root: PathBuf,
        home: PathBuf,
        chromium_path: Option<String>,
    ) -> Self {
        let manager = Self {
            app,
            root,
            home,
            chromium_path: Mutex::new(chromium_path),
            instances: Mutex::new(HashMap::new()),
            install_lock: Mutex::new(()),
        };
        manager.reap_orphans();
        manager
    }

    pub fn set_chromium_path(&self, path: Option<String>) {
        if let Ok(mut guard) = self.chromium_path.lock() {
            *guard = path;
        }
    }

    fn profile_dir(&self, session_id: &str) -> PathBuf {
        self.root.join(session_id).join("profile")
    }

    fn global_dir(&self) -> PathBuf {
        self.home.join(PORT_DIR)
    }

    /// Chromiums de perfis deste app cujo app ja morreu. Confere a linha de
    /// comando antes de matar, porque o pid pode ter sido reaproveitado.
    pub fn reap_orphans(&self) {
        let Ok(read) = fs::read_dir(&self.root) else {
            return;
        };
        for entry in read.flatten() {
            let profile = entry.path().join("profile");
            let owner_path = profile.join("owner.json");
            let Some(owner) = read_owner(&owner_path) else {
                continue;
            };
            if owner.app_pid == std::process::id() || platform::process_alive(owner.app_pid) {
                continue;
            }
            if platform::process_alive(owner.chromium_pid)
                && is_chromium_of(owner.chromium_pid, &profile)
            {
                platform::terminate_background_process(owner.chromium_pid, true);
            }
            let _ = fs::remove_file(&owner_path);
            if !owner.cwd.is_empty() {
                release_port_file(
                    &Path::new(&owner.cwd).join(PORT_DIR),
                    &owner.session_id,
                    owner.app_pid,
                );
            }
            let global = self.global_dir();
            if let Some(current) = read_owner(&global.join("owner.json")) {
                if current.session_id == owner.session_id && current.app_pid == owner.app_pid {
                    let _ = fs::remove_file(global.join("port"));
                    let _ = fs::remove_file(global.join("owner.json"));
                }
            }
        }
    }

    pub fn status(&self, session_id: &str) -> Option<BrowserInfo> {
        let mut guard = self
            .instances
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let dead = guard
            .get(session_id)
            .map(|running| !platform::process_alive(running.info.pid))
            .unwrap_or(false);
        if dead {
            guard.remove(session_id);
        }
        guard.get(session_id).map(|running| running.info.clone())
    }

    pub fn list(&self) -> Vec<BrowserInfo> {
        let mut guard = self
            .instances
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.retain(|_, running| platform::process_alive(running.info.pid));
        let mut list: Vec<BrowserInfo> =
            guard.values().map(|running| running.info.clone()).collect();
        list.sort_by(|a, b| a.session_id.cmp(&b.session_id));
        list
    }

    /// Sem Chromium nenhum na maquina, instala o do Playwright e procura de
    /// novo, em vez de mandar o usuario rodar o comando a mao. Uma por vez:
    /// quem chega no meio espera e aproveita o download da primeira.
    fn install_chromium(&self, preferred: Option<&str>) -> Result<PathBuf, String> {
        let _turn = self
            .install_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(binary) = find_binary(&self.home, preferred) {
            return Ok(binary);
        }
        let cache = platform::playwright_cache(&self.home);
        fs::create_dir_all(&self.root).map_err(|error| {
            format!("Não foi possível preparar a instalação do Chromium: {error}")
        })?;
        let app = self.app.clone();
        let notify = move |running: bool, message: String| {
            let _ = app.emit(EVENT_BROWSER_INSTALL, BrowserInstall { running, message });
        };
        notify(true, "Preparando o download do Chromium".to_string());
        let result = run_install(
            INSTALL_SCRIPT,
            &self.home,
            &cache,
            &self.root,
            INSTALL_TIMEOUT,
            |message| notify(true, message),
        );
        notify(false, String::new());
        result?;
        find_binary(&self.home, preferred).ok_or_else(|| {
            format!(
                "A instalação terminou, mas nenhum Chromium apareceu em {}",
                cache.to_string_lossy()
            )
        })
    }

    /// Lanca o Chromium da sessao, ou devolve o que ja esta vivo.
    #[allow(clippy::too_many_arguments)]
    pub fn start(
        &self,
        session_id: &str,
        cwd: &str,
        width: u32,
        height: u32,
        origin: &str,
        start_url: &str,
    ) -> Result<BrowserInfo, String> {
        if session_id.is_empty() || session_id.contains('/') || session_id.contains("..") {
            return Err("Identificador de sessão inválido".to_string());
        }
        if !allowed_origin(origin) {
            return Err("Origem recusada".to_string());
        }
        let cwd_path = Path::new(cwd);
        if !cwd_path.is_absolute() || !cwd_path.is_dir() {
            return Err(format!("Pasta não encontrada: {cwd}"));
        }
        if let Some(existing) = self.status(session_id) {
            return Ok(existing);
        }
        self.reap_orphans();
        let preferred = self
            .chromium_path
            .lock()
            .ok()
            .and_then(|guard| guard.clone());
        let binary = match find_binary(&self.home, preferred.as_deref()) {
            Some(binary) => binary,
            // Maquina sem Chromium nenhum: instala o do Playwright em vez de
            // parar aqui, e a aba mostra o download no lugar do erro.
            None => self.install_chromium(preferred.as_deref())?,
        };
        let profile = self.profile_dir(session_id);
        fs::create_dir_all(&profile)
            .map_err(|error| format!("Não foi possível criar o perfil: {error}"))?;
        // Um lancamento anterior pode ter deixado o lock do perfil.
        let _ = fs::remove_file(profile.join("SingletonLock"));
        let _ = fs::remove_file(profile.join("SingletonSocket"));
        let _ = fs::remove_file(profile.join("SingletonCookie"));
        let _ = fs::remove_file(profile.join("DevToolsActivePort"));
        let port_dir = cwd_path.join(PORT_DIR);
        let downloads = port_dir.join("downloads");
        let _ = fs::create_dir_all(&downloads);
        let args = chromium_args(
            &binary,
            &port_dir,
            &profile,
            origin,
            width.max(320),
            height.max(240),
            start_url,
        );
        let mut command = Command::new(&binary);
        command
            .args(&args)
            .env("HOME", &self.home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        platform::configure_background_command(&mut command);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Não foi possível iniciar o Chromium: {error}"))?;
        let pid = child.id();
        #[cfg(target_os = "windows")]
        let job = crate::platform::win_job::assign(pid).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            format!("Não foi possível isolar o Chromium: {error}")
        })?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Sem stderr do Chromium".to_string())?;
        let tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
        let (tx, rx) = std::sync::mpsc::channel::<(u16, String)>();
        {
            let tail = Arc::clone(&tail);
            thread::Builder::new()
                .name(format!("browser-stderr-{session_id}"))
                .spawn(move || {
                    let reader = BufReader::new(stderr);
                    let mut announced = false;
                    for line in reader.lines() {
                        let Ok(line) = line else { break };
                        if !announced {
                            if let Some(found) = parse_devtools_line(&line) {
                                announced = true;
                                let _ = tx.send(found);
                            }
                        }
                        if let Ok(mut guard) = tail.lock() {
                            guard.push_str(&line);
                            guard.push('\n');
                            if guard.len() > STDERR_TAIL {
                                let cut = guard.len() - STDERR_TAIL;
                                guard.drain(..cut);
                            }
                        }
                    }
                })
                .map_err(|error| error.to_string())?;
        }
        let started = Instant::now();
        let announced = loop {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(found) => break Some(found),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if let Ok(Some(_)) = child.try_wait() {
                        break None;
                    }
                    // Plano B: o Chromium tambem grava a porta no perfil.
                    if let Some(found) = read_active_port(&profile) {
                        break Some(found);
                    }
                    if started.elapsed() > START_TIMEOUT {
                        break None;
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    break read_active_port(&profile);
                }
            }
        };
        let Some((port, ws_url)) = announced else {
            #[cfg(unix)]
            platform::terminate_background_process(pid, true);
            #[cfg(target_os = "windows")]
            let _ = job.terminate();
            let _ = child.wait();
            let detail = tail.lock().map(|guard| guard.clone()).unwrap_or_default();
            return Err(format!(
                "O Chromium não respondeu em 20 s. {}",
                detail.trim()
            ));
        };
        let owner = Owner {
            app_pid: std::process::id(),
            chromium_pid: pid,
            port,
            session_id: session_id.to_string(),
            cwd: cwd.to_string(),
            pid: Some(std::process::id()),
        };
        let _ = write_json(&profile.join("owner.json"), &owner);
        let (port_owner, port_owner_session, port_file) = match claim_port_file(&port_dir, &owner) {
            Ok(None) => (
                "self".to_string(),
                None,
                Some(port_dir.join("port").to_string_lossy().to_string()),
            ),
            Ok(Some(other)) => ("other".to_string(), Some(other.session_id), None),
            Err(_) => ("other".to_string(), None, None),
        };
        let global_port = matches!(claim_port_file(&self.global_dir(), &owner), Ok(None));
        let info = BrowserInfo {
            session_id: session_id.to_string(),
            port,
            ws_url,
            pid,
            profile_dir: profile.to_string_lossy().to_string(),
            binary: binary.to_string_lossy().to_string(),
            port_file,
            port_owner,
            port_owner_session,
            downloads_dir: downloads.to_string_lossy().to_string(),
            global_port,
        };
        {
            let mut guard = self
                .instances
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.insert(
                session_id.to_string(),
                Running {
                    info: info.clone(),
                    cwd: cwd.to_string(),
                    stderr: Arc::clone(&tail),
                    #[cfg(target_os = "windows")]
                    job: job.clone(),
                },
            );
        }
        // A thread de espera avisa o app e limpa os arquivos quando o
        // Chromium sai por conta propria.
        let app = self.app.clone();
        let session = session_id.to_string();
        let cwd_owned = cwd.to_string();
        let global_dir = self.global_dir();
        let root = self.root.clone();
        #[cfg(target_os = "windows")]
        let wait_job = job;
        thread::Builder::new()
            .name(format!("browser-wait-{session_id}"))
            .spawn(move || {
                #[cfg(target_os = "windows")]
                let _keep_job_alive = wait_job;
                let status = child.wait().ok();
                let code = status.as_ref().and_then(std::process::ExitStatus::code);
                let signal = exit_signal(status.as_ref());
                let stderr_tail = tail.lock().map(|guard| guard.clone()).unwrap_or_default();
                let _ = fs::remove_file(root.join(&session).join("profile").join("owner.json"));
                release_port_file(
                    &Path::new(&cwd_owned).join(PORT_DIR),
                    &session,
                    std::process::id(),
                );
                release_port_file(&global_dir, &session, std::process::id());
                let _ = app.emit(
                    EVENT_BROWSER_EXIT,
                    BrowserExit {
                        session_id: session,
                        pid,
                        code,
                        signal,
                        stderr_tail,
                    },
                );
            })
            .map_err(|error| error.to_string())?;
        Ok(info)
    }

    /// Encerra o Chromium da sessao. Com `purge`, apaga o perfil, cookies e
    /// tudo; sem, o perfil sobrevive ao proximo lancamento.
    pub fn stop(&self, session_id: &str, purge: bool) {
        let removed = {
            let mut guard = self
                .instances
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.remove(session_id)
        };
        if let Some(running) = removed {
            let pid = running.info.pid;
            #[cfg(unix)]
            if platform::process_alive(pid) {
                platform::terminate_background_process(pid, false);
                let deadline = Instant::now() + STOP_GRACE;
                while platform::process_alive(pid) && Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(25));
                }
                if platform::process_alive(pid) {
                    platform::terminate_background_process(pid, true);
                }
            }
            #[cfg(target_os = "windows")]
            if platform::process_alive(pid) {
                let _ = running.job.terminate();
            }
            release_port_file(
                &Path::new(&running.cwd).join(PORT_DIR),
                session_id,
                std::process::id(),
            );
            release_port_file(&self.global_dir(), session_id, std::process::id());
            drop(running.stderr);
        }
        let profile = self.profile_dir(session_id);
        let _ = fs::remove_file(profile.join("owner.json"));
        if purge {
            let _ = fs::remove_dir_all(self.root.join(session_id));
        }
    }

    /// Ao sair do app: encerra todos, mantendo os perfis.
    pub fn kill_all_blocking(&self) {
        let ids: Vec<String> = {
            let guard = self
                .instances
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            guard.keys().cloned().collect()
        };
        for id in ids {
            self.stop(&id, false);
        }
    }
}

#[cfg(unix)]
fn exit_signal(status: Option<&std::process::ExitStatus>) -> Option<i32> {
    use std::os::unix::process::ExitStatusExt;
    status.and_then(ExitStatusExt::signal)
}

#[cfg(target_os = "windows")]
fn exit_signal(_status: Option<&std::process::ExitStatus>) -> Option<i32> {
    None
}

/// `DevToolsActivePort` no perfil: a porta numa linha e o caminho do
/// WebSocket na seguinte.
fn read_active_port(profile: &Path) -> Option<(u16, String)> {
    let raw = fs::read_to_string(profile.join("DevToolsActivePort")).ok()?;
    let mut lines = raw.lines();
    let port: u16 = lines.next()?.trim().parse().ok()?;
    let path = lines.next()?.trim();
    if !path.starts_with('/') {
        return None;
    }
    Some((port, format!("ws://127.0.0.1:{port}{path}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oc-browser-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn parses_the_devtools_line() {
        let (port, url) = parse_devtools_line(
            "DevTools listening on ws://127.0.0.1:51998/devtools/browser/ae68bd94-a09c",
        )
        .unwrap();
        assert_eq!(port, 51998);
        assert_eq!(url, "ws://127.0.0.1:51998/devtools/browser/ae68bd94-a09c");
        assert!(parse_devtools_line("[0908/204411.123:WARNING:x] nada").is_none());
    }

    #[test]
    fn origins_are_restricted_to_the_app_and_loopback() {
        assert!(allowed_origin("tauri://localhost"));
        assert!(allowed_origin("http://tauri.localhost"));
        assert!(allowed_origin("http://127.0.0.1:1420"));
        assert!(allowed_origin("http://localhost:1420"));
        assert!(!allowed_origin("https://evil.example"));
        assert!(!allowed_origin("http://10.0.0.5:1420"));
        assert!(!allowed_origin(""));
    }

    #[test]
    fn finds_playwright_layouts_for_linux_and_windows() {
        let root = sandbox("layouts");
        let linux = root.join(
            "linux/chromium_headless_shell-1200/chrome-headless-shell-linux-arm64/chrome-headless-shell",
        );
        let windows = root.join("windows/chromium-1201/chrome-win64/chrome.exe");
        fs::create_dir_all(linux.parent().unwrap()).unwrap();
        fs::create_dir_all(windows.parent().unwrap()).unwrap();
        fs::write(&linux, b"").unwrap();
        fs::write(&windows, b"").unwrap();

        assert_eq!(
            find_playwright_binary(&root.join("linux"), "linux"),
            Some(linux)
        );
        assert_eq!(
            find_playwright_binary(&root.join("windows"), "windows"),
            Some(windows)
        );
        fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(target_os = "macos")]
    fn fake_app(parent: &Path, bundle: &str) -> PathBuf {
        let app = parent.join(bundle);
        let macos = app.join("Contents/MacOS");
        fs::create_dir_all(&macos).unwrap();
        let binary = macos.join(Path::new(bundle).file_stem().unwrap());
        fs::write(&binary, b"").unwrap();
        binary
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn finds_the_newest_playwright_binary() {
        let home = sandbox("binario");
        let cache = home.join("Library/Caches/ms-playwright");
        for revision in ["1190", "1208"] {
            let dir = cache.join(format!(
                "chromium_headless_shell-{revision}/chrome-headless-shell-mac-arm64"
            ));
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("chrome-headless-shell"), b"").unwrap();
        }
        let build = cache.join("chromium-1300/chrome-mac-arm64");
        fs::create_dir_all(&build).unwrap();
        let legacy = fake_app(&build, "Chromium.app");
        let found = find_binary(&home, None).unwrap();
        assert!(
            found
                .to_string_lossy()
                .contains("chromium_headless_shell-1208"),
            "{found:?}"
        );
        // A preferencia vence quando existe, e e ignorada quando nao.
        let preferred = home.join("meu-chrome");
        fs::write(&preferred, b"").unwrap();
        assert_eq!(
            find_binary(&home, Some(&preferred.to_string_lossy())).unwrap(),
            preferred
        );
        assert!(
            find_binary(&home, Some("/nao/existe"))
                .unwrap()
                .to_string_lossy()
                .contains("1208")
        );
        // A preferencia tambem aceita o bundle inteiro.
        let bundle = build.join("Chromium.app");
        assert_eq!(
            find_binary(&home, Some(&bundle.to_string_lossy())).unwrap(),
            legacy
        );
        // Sem o headless shell, vale o Chromium completo.
        fs::remove_dir_all(cache.join("chromium_headless_shell-1208")).unwrap();
        fs::remove_dir_all(cache.join("chromium_headless_shell-1190")).unwrap();
        assert_eq!(find_binary(&home, None).unwrap(), legacy);
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn accepts_the_renamed_playwright_bundle() {
        // O Playwright entrega `Google Chrome for Testing.app` desde a v1.5x.
        // Fixar `Chromium.app` deixava o painel sem binario mesmo com o
        // download completo no cache.
        let home = sandbox("renomeado");
        let build = home.join("Library/Caches/ms-playwright/chromium-1243/chrome-mac-arm64");
        fs::create_dir_all(&build).unwrap();
        let binary = fake_app(&build, "Google Chrome for Testing.app");
        assert_eq!(find_binary(&home, None).unwrap(), binary);
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn reads_the_executable_inside_a_bundle() {
        let dir = sandbox("bundle");
        let binary = fake_app(&dir, "Chromium.app");
        assert_eq!(app_binary(&dir.join("Chromium.app")).unwrap(), binary);
        // Nome do executavel diferente do nome do bundle: cai na varredura.
        let odd = dir.join("Estranho.app/Contents/MacOS");
        fs::create_dir_all(&odd).unwrap();
        fs::write(odd.join("outro-nome"), b"").unwrap();
        assert_eq!(
            app_binary(&dir.join("Estranho.app")).unwrap(),
            odd.join("outro-nome")
        );
        assert!(app_binary(&dir.join("Nao existe.app")).is_none());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn port_file_respects_a_living_owner() {
        let dir = sandbox("porta");
        let port_dir = dir.join(PORT_DIR);
        let me = Owner {
            app_pid: std::process::id(),
            chromium_pid: 0,
            port: 4001,
            session_id: "a".into(),
            cwd: dir.to_string_lossy().to_string(),
            pid: None,
        };
        assert!(claim_port_file(&port_dir, &me).unwrap().is_none());
        assert_eq!(
            fs::read_to_string(port_dir.join("port")).unwrap().trim(),
            "4001"
        );
        // Outra sessao deste mesmo app, vivo: recusada.
        let other = Owner {
            session_id: "b".into(),
            port: 4002,
            ..me.clone()
        };
        let current = claim_port_file(&port_dir, &other)
            .unwrap()
            .expect("dono vivo");
        assert_eq!(current.session_id, "a");
        assert_eq!(
            fs::read_to_string(port_dir.join("port")).unwrap().trim(),
            "4001"
        );
        // Dono morto: pid inexistente.
        let dead = Owner {
            app_pid: 999_999,
            chromium_pid: 999_998,
            port: 1,
            session_id: "z".into(),
            cwd: String::new(),
            pid: None,
        };
        write_json(&port_dir.join("owner.json"), &dead).unwrap();
        assert!(claim_port_file(&port_dir, &other).unwrap().is_none());
        assert_eq!(
            fs::read_to_string(port_dir.join("port")).unwrap().trim(),
            "4002"
        );
        // Soltar so tira o arquivo do proprio dono.
        release_port_file(&port_dir, "a", std::process::id());
        assert!(port_dir.join("port").exists());
        release_port_file(&port_dir, "b", std::process::id());
        assert!(!port_dir.join("port").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_the_active_port_file() {
        let dir = sandbox("ativo");
        fs::write(
            dir.join("DevToolsActivePort"),
            "51998\n/devtools/browser/abc\n",
        )
        .unwrap();
        let (port, url) = read_active_port(&dir).unwrap();
        assert_eq!(port, 51998);
        assert_eq!(url, "ws://127.0.0.1:51998/devtools/browser/abc");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn args_pick_headless_flag_by_binary() {
        let shell = chromium_args(
            Path::new("/x/chrome-headless-shell"),
            Path::new("/p"),
            Path::new("/prof"),
            "tauri://localhost",
            800,
            600,
            "",
        );
        assert!(shell.contains(&"--headless".to_string()));
        assert!(shell.contains(&"--remote-allow-origins=tauri://localhost".to_string()));
        assert!(shell.contains(&"--remote-debugging-port=0".to_string()));
        assert_eq!(shell.last().unwrap(), "about:blank");
        let full = chromium_args(
            Path::new("/x/Chromium"),
            Path::new("/p"),
            Path::new("/prof"),
            "tauri://localhost",
            800,
            600,
            "http://127.0.0.1:3700",
        );
        assert!(full.contains(&"--headless=new".to_string()));
        assert_eq!(full.last().unwrap(), "http://127.0.0.1:3700");
    }

    #[test]
    fn install_progress_reads_the_playwright_lines() {
        let mut current = String::new();
        let download = install_progress(
            "Downloading Chrome for Testing 153.0.8010.12 (playwright chromium v1243) from https://cdn.playwright.dev/builds/cft/153.0.8010.12/mac-arm64/chrome-mac-arm64.zip",
            &mut current,
        );
        assert_eq!(download.as_deref(), Some("Baixando Chrome for Testing"));
        // A linha de percentual nao diz o que esta baixando: vem do anterior.
        let percent = install_progress(
            "|■■■■■■■■                              |  40% of 162.4 MiB",
            &mut current,
        );
        assert_eq!(
            percent.as_deref(),
            Some("Baixando Chrome for Testing, 40% de 162.4 MiB")
        );
        let ffmpeg = install_progress(
            "Downloading FFmpeg (playwright ffmpeg v1011) from https://cdn.playwright.dev/x.zip",
            &mut current,
        );
        assert_eq!(ffmpeg.as_deref(), Some("Baixando FFmpeg"));
        // Moldura do aviso, fim do download e linha vazia nao viram andamento.
        assert!(
            install_progress(
                "║ WARNING: It looks like you are running 'npx playwright install' ║",
                &mut current
            )
            .is_none()
        );
        assert!(
            install_progress(
                "Chrome for Testing 153.0.8010.12 (playwright chromium v1243) downloaded to /x",
                &mut current
            )
            .is_none()
        );
        assert!(install_progress("", &mut current).is_none());
    }

    #[test]
    #[cfg(unix)]
    fn install_reports_progress_and_leaves_the_binary() {
        let home = sandbox("instalacao");
        let cache = platform::playwright_cache(&home);
        // Instalador de mentira: fala como o Playwright e deixa o headless
        // shell onde `find_binary` procura.
        let layout = if cfg!(target_os = "macos") {
            "chrome-headless-shell-mac-arm64"
        } else {
            "chrome-headless-shell-linux-test"
        };
        let script = format!(
            "exec 2>&1; \
            echo 'Downloading Chrome Headless Shell 153.0.8010.12 (playwright chromium-headless-shell v1243) from https://cdn.playwright.dev/x.zip'; \
            echo '|■■■■                        |  50% of 90.1 MiB'; \
            mkdir -p \"$1/chromium_headless_shell-1243/{layout}\"; \
            touch \"$1/chromium_headless_shell-1243/{layout}/chrome-headless-shell\""
        );
        let mut seen: Vec<String> = Vec::new();
        run_install(
            &script,
            &home,
            &cache,
            &home,
            Duration::from_secs(30),
            |message| seen.push(message),
        )
        .unwrap();
        assert_eq!(
            seen,
            [
                "Baixando Chrome Headless Shell",
                "Baixando Chrome Headless Shell, 50% de 90.1 MiB"
            ]
        );
        let found = find_binary(&home, None).unwrap();
        assert!(found.starts_with(&cache), "{found:?}");
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn install_failures_say_what_to_do() {
        let home = sandbox("instalacao-falha");
        let cache = platform::playwright_cache(&home);
        let failed = run_install(
            "exec 2>&1; echo 'Error: getaddrinfo ENOTFOUND cdn.playwright.dev'; exit 1",
            &home,
            &cache,
            &home,
            Duration::from_secs(30),
            |_| {},
        )
        .unwrap_err();
        assert!(
            failed.contains("ENOTFOUND") && failed.contains("Preferências"),
            "{failed}"
        );
        // Sem o Node no PATH o zsh sai com 127, e a mensagem muda.
        let without_node = run_install(
            "exec 2>&1; exec oc-nao-existe-mesmo",
            &home,
            &cache,
            &home,
            Duration::from_secs(30),
            |_| {},
        )
        .unwrap_err();
        assert!(
            without_node.contains("npx não foi encontrado"),
            "{without_node}"
        );
        // Travado: o teto de tempo mata o grupo e nao fica esperando.
        let started = Instant::now();
        let stuck = run_install(
            "sleep 30",
            &home,
            &cache,
            &home,
            Duration::from_millis(600),
            |_| {},
        )
        .unwrap_err();
        assert!(stuck.contains("interrompida"), "{stuck}");
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "{:?}",
            started.elapsed()
        );
        fs::remove_dir_all(&home).unwrap();
    }

    /// Instalacao de verdade, que baixa mais de 200 MiB e depende de rede.
    /// Roda a mao, de preferencia com o PATH curto que o app herda do Dock:
    /// `PATH=/usr/bin:/bin cargo test --lib installs_the_real_playwright_chromium -- --ignored --nocapture`.
    #[test]
    #[cfg(unix)]
    #[ignore = "baixa o Chromium de verdade"]
    fn installs_the_real_playwright_chromium() {
        let home = sandbox("instalacao-real");
        let cache = platform::playwright_cache(&home);
        let mut seen: Vec<String> = Vec::new();
        run_install(
            INSTALL_SCRIPT,
            &home,
            &cache,
            &home,
            INSTALL_TIMEOUT,
            |message| {
                println!("{message}");
                seen.push(message);
            },
        )
        .unwrap();
        assert!(
            seen.iter().any(|message| message.contains('%')),
            "sem percentual: {seen:?}"
        );
        let found = find_binary(&home, None).unwrap();
        assert!(found.starts_with(&cache), "{found:?}");
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn dead_pids_are_not_alive() {
        assert!(platform::process_alive(std::process::id()));
        assert!(!platform::process_alive(0));
        assert!(!platform::process_alive(999_999));
    }
}
