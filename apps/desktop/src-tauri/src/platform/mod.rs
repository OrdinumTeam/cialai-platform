// SPDX-License-Identifier: Apache-2.0
//! Contratos portaveis de sistema, shell, locale e caminhos.

#[cfg(unix)]
use std::ffi::CStr;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::prefs::Preferences;

pub mod child_env;
#[cfg(target_os = "windows")]
pub mod win_job;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellFlavor {
    Posix,
    Powershell,
    Cmd,
}

impl ShellFlavor {
    pub fn from_path(path: &str) -> Self {
        let name = path
            .replace('\\', "/")
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        match name.as_str() {
            "pwsh" | "pwsh.exe" | "powershell" | "powershell.exe" => Self::Powershell,
            "cmd" | "cmd.exe" => Self::Cmd,
            _ => Self::Posix,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpec {
    pub path: String,
    pub args: Vec<String>,
    pub flavor: ShellFlavor,
}

impl ShellSpec {
    pub fn new(path: impl Into<String>, args: Vec<String>) -> Self {
        let path = path.into();
        Self {
            flavor: ShellFlavor::from_path(&path),
            path,
            args,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformInfo {
    pub os: String,
    pub is_mac: bool,
    pub home: String,
    pub file_manager: String,
    pub default_shell_flavor: ShellFlavor,
    pub sep: String,
}

impl PlatformInfo {
    pub fn detect(home: &Path, preferences: &Preferences) -> Self {
        Self {
            os: OS.into(),
            is_mac: cfg!(target_os = "macos"),
            home: to_portable(home),
            file_manager: FILE_MANAGER.into(),
            default_shell_flavor: default_shell(preferences).flavor,
            sep: MAIN_SEPARATOR.into(),
        }
    }
}

#[cfg(target_os = "macos")]
const OS: &str = "macos";
#[cfg(target_os = "windows")]
const OS: &str = "windows";
#[cfg(all(unix, not(target_os = "macos")))]
const OS: &str = "linux";

#[cfg(target_os = "macos")]
const FILE_MANAGER: &str = "Finder";
#[cfg(target_os = "windows")]
const FILE_MANAGER: &str = "Explorer";
#[cfg(all(unix, not(target_os = "macos")))]
const FILE_MANAGER: &str = "Arquivos";

#[cfg(target_os = "windows")]
const MAIN_SEPARATOR: &str = "\\";
#[cfg(not(target_os = "windows"))]
const MAIN_SEPARATOR: &str = "/";

pub fn to_portable(path: impl AsRef<Path>) -> String {
    let value = path.as_ref().to_string_lossy().replace('\\', "/");
    if let Some(rest) = value.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = value.strip_prefix("//?/") {
        rest.to_string()
    } else {
        value
    }
}

pub fn playwright_cache(home: &Path) -> PathBuf {
    #[cfg(target_os = "macos")]
    return home.join("Library/Caches/ms-playwright");
    #[cfg(all(unix, not(target_os = "macos")))]
    return home.join(".cache/ms-playwright");
    #[cfg(target_os = "windows")]
    return std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Local"))
        .join("ms-playwright");
}

#[cfg(unix)]
pub fn process_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: o sinal zero apenas consulta a existencia e a permissao.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(target_os = "windows")]
pub fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return false;
    }
    // SAFETY: o handle e apenas consultado e sempre fechado nesta funcao.
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() {
        return false;
    }
    let mut code = 0_u32;
    // SAFETY: `process` e `code` sao validos durante a chamada.
    let running =
        unsafe { GetExitCodeProcess(process, &mut code) } != 0 && code == STILL_ACTIVE as u32;
    // SAFETY: o handle foi aberto acima e nao escapa.
    unsafe { CloseHandle(process) };
    running
}

/// Configura processos auxiliares sem janela. No Unix eles tambem ganham um
/// grupo proprio para que filhos sejam recolhidos no prazo.
pub fn configure_background_command(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
        command.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Encerra um grupo auxiliar no Unix. No Windows o Job Object cuida da arvore;
/// esta reserva cobre somente um processo orfao de uma versao anterior.
pub fn terminate_background_process(pid: u32, force: bool) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: o processo foi criado como lider do proprio grupo.
        unsafe { libc::kill(-(pid as libc::pid_t), signal) };
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_TERMINATE, TerminateProcess,
        };
        // SAFETY: o handle e usado apenas nesta funcao e sempre fechado.
        let process = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if !process.is_null() {
            unsafe {
                TerminateProcess(process, 1);
                CloseHandle(process);
            }
        }
        let _ = force;
    }
}

fn login_args(path: &str) -> Vec<String> {
    match ShellFlavor::from_path(path) {
        ShellFlavor::Powershell => vec!["-NoLogo".into()],
        ShellFlavor::Cmd => Vec::new(),
        ShellFlavor::Posix => {
            let name = path
                .replace('\\', "/")
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_ascii_lowercase();
            if matches!(
                name.as_str(),
                "zsh" | "bash" | "fish" | "sh" | "dash" | "ksh" | "tcsh" | "nu"
            ) {
                vec!["-l".into()]
            } else {
                Vec::new()
            }
        }
    }
}

pub fn default_shell(preferences: &Preferences) -> ShellSpec {
    let configured = preferences
        .terminal
        .shell
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let path = configured.unwrap_or_else(system_shell);
    let args = if preferences.terminal.args.is_empty() {
        login_args(&path)
    } else {
        preferences.terminal.args.clone()
    };
    ShellSpec::new(path, args)
}

#[cfg(unix)]
fn system_shell() -> String {
    if let Some(shell) = std::env::var_os("SHELL").and_then(|value| value.into_string().ok()) {
        if !shell.trim().is_empty() {
            return shell;
        }
    }
    login_shell_from_passwd().unwrap_or_else(|| "/bin/bash".into())
}

#[cfg(unix)]
fn login_shell_from_passwd() -> Option<String> {
    // SAFETY: getpwuid_r escreve apenas na estrutura e no buffer fornecidos;
    // o CStr e copiado antes que ambos saiam de escopo.
    unsafe {
        let mut entry: libc::passwd = std::mem::zeroed();
        let mut result = std::ptr::null_mut();
        let size = libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX).clamp(1024, 65536) as usize;
        let mut buffer = vec![0_u8; size];
        let status = libc::getpwuid_r(
            libc::getuid(),
            &mut entry,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        );
        if status != 0 || result.is_null() || entry.pw_shell.is_null() {
            return None;
        }
        CStr::from_ptr(entry.pw_shell)
            .to_str()
            .ok()
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    }
}

#[cfg(target_os = "windows")]
fn system_shell() -> String {
    if let Ok(path) = which::which("pwsh.exe") {
        return path.to_string_lossy().into_owned();
    }
    if let Some(root) = std::env::var_os("SystemRoot") {
        let candidate = PathBuf::from(root).join("System32/WindowsPowerShell/v1.0/powershell.exe");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into())
}

pub fn default_lang(preferences: &Preferences) -> Option<String> {
    if cfg!(target_os = "windows") {
        return None;
    }
    if let Some(value) = preferences
        .terminal
        .lang
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(value.to_string());
    }
    let locale = sys_locale::get_locale().unwrap_or_else(|| "C.UTF-8".into());
    if locale == "C" || locale == "POSIX" {
        Some("C.UTF-8".into())
    } else if locale.contains('.') {
        Some(locale.replace('-', "_"))
    } else {
        Some(format!("{}.UTF-8", locale.replace('-', "_")))
    }
}

fn expand_home(value: &str, home: &Path) -> PathBuf {
    if value == "~" {
        home.to_path_buf()
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        PathBuf::from(value)
    }
}

pub fn path_prefix(preferences: &Preferences, home: &Path) -> Vec<PathBuf> {
    if !preferences.terminal.path_prefix.is_empty() {
        return preferences
            .terminal
            .path_prefix
            .iter()
            .map(|value| expand_home(value, home))
            .collect();
    }
    default_path_candidates(home)
        .into_iter()
        .filter(|path| path.is_dir())
        .collect()
}

#[cfg(target_os = "macos")]
fn default_path_candidates(_home: &Path) -> Vec<PathBuf> {
    ["/opt/homebrew/bin", "/usr/local/bin"]
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn default_path_candidates(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join(".local/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/home/linuxbrew/.linuxbrew/bin"),
        PathBuf::from("/snap/bin"),
    ]
}

#[cfg(target_os = "windows")]
fn default_path_candidates(_home: &Path) -> Vec<PathBuf> {
    Vec::new()
}

pub fn path_env(preferences: &Preferences, home: &Path) -> String {
    let mut paths = path_prefix(preferences, home);
    if let Some(current) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current));
    }
    std::env::join_paths(paths)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_flavor_recognizes_all_three_contract_values() {
        assert_eq!(ShellFlavor::from_path("/bin/zsh"), ShellFlavor::Posix);
        assert_eq!(
            ShellFlavor::from_path(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            ShellFlavor::Powershell
        );
        assert_eq!(
            ShellFlavor::from_path(r"C:\Windows\System32\cmd.exe"),
            ShellFlavor::Cmd
        );
    }

    #[test]
    fn configured_shell_and_arguments_win_over_detected_defaults() {
        let mut prefs = Preferences::default();
        prefs.terminal.shell = Some("/opt/homebrew/bin/fish".into());
        assert_eq!(default_shell(&prefs).args, ["-l"]);
        prefs.terminal.args = vec!["--no-config".into()];
        assert_eq!(default_shell(&prefs).args, ["--no-config"]);
    }

    #[test]
    fn portable_paths_remove_windows_device_prefixes() {
        assert_eq!(
            to_portable(Path::new(r"\\?\C:\Users\Ana\Projeto")),
            "C:/Users/Ana/Projeto"
        );
        assert_eq!(
            to_portable(Path::new(r"\\?\UNC\server\share\x")),
            "//server/share/x"
        );
    }

    #[test]
    fn configured_prefix_expands_home_without_requiring_existing_dirs() {
        let mut prefs = Preferences::default();
        prefs.terminal.path_prefix = vec!["~/.local/bin".into(), "/custom/bin".into()];
        assert_eq!(
            path_prefix(&prefs, Path::new("/home/ana")),
            [
                PathBuf::from("/home/ana/.local/bin"),
                PathBuf::from("/custom/bin")
            ]
        );
    }

    #[test]
    fn platform_info_uses_portable_home_and_serializable_flavor() {
        let info = PlatformInfo::detect(Path::new("/Users/ana"), &Preferences::default());
        let value = serde_json::to_value(info).unwrap();
        assert_eq!(value["home"], "/Users/ana");
        assert!(matches!(
            value["defaultShellFlavor"].as_str(),
            Some("posix" | "powershell" | "cmd")
        ));
    }
}
