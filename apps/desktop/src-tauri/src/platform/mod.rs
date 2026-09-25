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
            // O mesmo objeto anunciava `home` com barra normal e `sep` com
            // barra invertida, e quem juntasse os dois montava um caminho
            // misturado. O separador dos caminhos que a interface manipula e
            // sempre a barra normal; para mostrar no estilo do sistema existe
            // `displayPath`.
            sep: "/".into(),
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
pub fn system_shell() -> String {
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
pub fn system_shell() -> String {
    if let Ok(path) = which::which("pwsh.exe") {
        return path.to_string_lossy().into_owned();
    }
    if let Some(root) = std::env::var_os("SystemRoot") {
        // Componente a componente: um sufixo com barra normal colado ao
        // `SystemRoot` saia misturado, `C:\WINDOWS\System32/WindowsPowerShell`.
        let candidate = PathBuf::from(root)
            .join("System32")
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
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
fn default_path_candidates(home: &Path) -> Vec<PathBuf> {
    windows_path_candidates(
        home,
        std::env::var_os("APPDATA").map(PathBuf::from),
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from),
    )
}

/// Pastas em que os instaladores de linha de comando do Windows deixam os
/// executaveis: o Claude Code em `~/.local/bin`, os pacotes globais do npm
/// em `%APPDATA%/npm`, os portateis do winget, o cargo e o scoop. Como no
/// Linux, so as que existem entram, e o usuario nao precisa configurar nada.
#[cfg(any(test, target_os = "windows"))]
fn windows_path_candidates(
    home: &Path,
    appdata: Option<PathBuf>,
    local_appdata: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates = vec![home.join(".local").join("bin")];
    if let Some(appdata) = appdata {
        candidates.push(appdata.join("npm"));
    }
    if let Some(local) = local_appdata {
        candidates.push(local.join("Microsoft").join("WinGet").join("Links"));
    }
    candidates.push(home.join(".cargo").join("bin"));
    candidates.push(home.join("scoop").join("shims"));
    candidates
}

pub fn path_env(preferences: &Preferences, home: &Path) -> String {
    let current = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();
    let paths = merge_paths(
        path_prefix(preferences, home),
        fresh_system_path(),
        current,
        cfg!(windows),
    );
    std::env::join_paths(paths)
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

/// Prefixos, depois o PATH que um processo novo receberia agora, depois o que
/// so o processo do app tem. Sem repeticao, e no Windows sem distinguir
/// maiusculas, que e como o sistema compara caminhos.
fn merge_paths(
    prefixes: Vec<PathBuf>,
    fresh: Option<Vec<PathBuf>>,
    current: Vec<PathBuf>,
    fold_case: bool,
) -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut merged = Vec::new();
    for path in prefixes
        .into_iter()
        .chain(fresh.unwrap_or_default())
        .chain(current)
    {
        if path.as_os_str().is_empty() {
            continue;
        }
        let mut key = path
            .to_string_lossy()
            .trim_end_matches(['\\', '/'])
            .to_string();
        if fold_case {
            key = key.to_lowercase();
        }
        if seen.insert(key) {
            merged.push(path);
        }
    }
    merged
}

/// Fora do Windows o PATH do processo ja e o melhor que existe.
#[cfg(not(target_os = "windows"))]
fn fresh_system_path() -> Option<Vec<PathBuf>> {
    None
}

/// O PATH do processo foi copiado na abertura do app e nao ve o que os
/// instaladores gravaram no registro depois: quem instala o Claude Code com o
/// Cialai aberto ficava sem `claude` ate reiniciar. O Windows monta o PATH
/// de um processo novo com o da maquina seguido do usuario; aqui e igual.
#[cfg(target_os = "windows")]
fn fresh_system_path() -> Option<Vec<PathBuf>> {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let machine = registry_path(
        HKEY_LOCAL_MACHINE,
        r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
    );
    let user = registry_path(HKEY_CURRENT_USER, "Environment");
    if machine.is_none() && user.is_none() {
        return None;
    }
    let mut paths = Vec::new();
    for value in [machine, user].into_iter().flatten() {
        paths.extend(std::env::split_paths(&value));
    }
    Some(paths)
}

/// Valor `Path` de uma chave do registro, ja com `%USERPROFILE%` e afins
/// expandidos, que e o que um processo novo recebe.
#[cfg(target_os = "windows")]
fn registry_path(
    root: windows_sys::Win32::System::Registry::HKEY,
    subkey: &str,
) -> Option<std::ffi::OsString> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegGetValueW};

    let wide = |value: &str| -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let subkey = wide(subkey);
    let name = wide("Path");
    let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ;
    let mut size: u32 = 0;
    // SAFETY: os ponteiros apontam para buffers locais vivos; a primeira
    // chamada so mede, e a segunda recebe um buffer do tamanho pedido com
    // folga, porque para REG_EXPAND_SZ a medida e uma estimativa.
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            name.as_ptr(),
            flags,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS || size == 0 {
        return None;
    }
    let mut buffer = vec![0u16; size as usize + 512];
    let mut size = (buffer.len() * std::mem::size_of::<u16>()) as u32;
    let status = unsafe {
        RegGetValueW(
            root,
            subkey.as_ptr(),
            name.as_ptr(),
            flags,
            std::ptr::null_mut(),
            buffer.as_mut_ptr().cast(),
            &mut size,
        )
    };
    if status != ERROR_SUCCESS {
        return None;
    }
    let end = buffer
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(buffer.len());
    Some(std::ffi::OsString::from_wide(&buffer[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// O contrato de `docs/arquitetura/14-diferencas-por-plataforma.md` diz que
    /// todo caminho entregue a interface usa barra normal. O mesmo objeto
    /// anunciava `home` assim e `sep` com barra invertida, e quem juntasse os
    /// dois montava um caminho misturado que nenhuma comparacao casava.
    #[test]
    fn the_platform_announces_one_separator_and_it_is_the_portable_one() {
        let prefs = Preferences::default();
        let info = PlatformInfo::detect(Path::new("/tmp/casa"), &prefs);
        assert_eq!(info.sep, "/");
        assert!(!info.home.contains('\\'), "home tambem sai portatil");
    }

    #[test]
    fn to_portable_unwraps_the_windows_extended_prefixes() {
        assert_eq!(to_portable("C:\\Users\\ana"), "C:/Users/ana");
        assert_eq!(to_portable("\\\\?\\C:\\Users\\ana"), "C:/Users/ana");
        assert_eq!(
            to_portable("\\\\?\\UNC\\servidor\\publico\\ana"),
            "//servidor/publico/ana"
        );
        assert_eq!(to_portable("/Users/ana"), "/Users/ana");
    }

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

    /// No Windows a lista padrao era vazia: quem instalava o Claude Code, que
    /// vai para `~/.local/bin`, ou um pacote global do npm, tinha de abrir as
    /// Preferencias e digitar a pasta. No Linux `~/.local/bin` ja entrava.
    #[test]
    fn windows_candidates_cover_the_installers_that_skip_the_path() {
        let home = Path::new(r"C:\Users\ana");
        let found = windows_path_candidates(
            home,
            Some(PathBuf::from(r"C:\Users\ana\AppData\Roaming")),
            Some(PathBuf::from(r"C:\Users\ana\AppData\Local")),
        );
        assert_eq!(found[0], home.join(".local").join("bin"));
        assert!(found.contains(&PathBuf::from(r"C:\Users\ana\AppData\Roaming").join("npm")));
        assert!(found.iter().any(|path| path.ends_with("Links")));
        assert!(found.iter().any(|path| path.ends_with("shims")));
        let sem_env = windows_path_candidates(home, None, None);
        assert_eq!(
            sem_env.len(),
            3,
            "sem APPDATA e LOCALAPPDATA sobram as pastas da casa"
        );
    }

    /// O PATH fresco do registro vem antes do que o processo carrega desde a
    /// abertura, e o do processo so acrescenta o que o fresco nao tem.
    #[test]
    fn merge_paths_prefers_the_fresh_path_and_never_repeats() {
        let merged = merge_paths(
            vec![PathBuf::from("/opt/prefixo")],
            Some(vec![PathBuf::from("/usr/bin"), PathBuf::from("/novo/bin")]),
            vec![
                PathBuf::from("/usr/bin"),
                PathBuf::from(""),
                PathBuf::from("/do/processo"),
                PathBuf::from("/opt/prefixo/"),
            ],
            false,
        );
        assert_eq!(
            merged,
            [
                PathBuf::from("/opt/prefixo"),
                PathBuf::from("/usr/bin"),
                PathBuf::from("/novo/bin"),
                PathBuf::from("/do/processo"),
            ]
        );
        let windows = merge_paths(
            Vec::new(),
            Some(vec![PathBuf::from(r"C:\Windows\System32")]),
            vec![PathBuf::from(r"c:\windows\system32\")],
            true,
        );
        assert_eq!(windows, [PathBuf::from(r"C:\Windows\System32")]);
        let sem_fresco = merge_paths(Vec::new(), None, vec![PathBuf::from("/bin")], false);
        assert_eq!(sem_fresco, [PathBuf::from("/bin")]);
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
