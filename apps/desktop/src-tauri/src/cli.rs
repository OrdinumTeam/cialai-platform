// SPDX-License-Identifier: Apache-2.0
//! Comando `cialai` no terminal.
//!
//! Quem instala o app passa a ter um comando que abre o Cialai de qualquer
//! terminal. O script e embutido em tempo de compilacao e gravado na pasta
//! pessoal na primeira abertura, no mesmo molde do gancho do Claude Code em
//! `workspace::ai`: escrita atomica, gravacao so quando o conteudo muda,
//! permissao de execucao no unix e copia de seguranca antes de sobrescrever.
//!
//! Duas decisoes merecem registro.
//!
//! No POSIX o app **nao edita arquivo de shell**. O destino e `~/.local/bin`,
//! que nao exige privilegio e ja entra no PATH sozinho em boa parte das
//! distribuicoes. Quando nao entra, a interface mostra a linha exata para o
//! usuario colar. O raio de dano nao justifica o contrario: um `.zshrc`
//! corrompido quebra todo shell novo da maquina, enquanto a falha evitada e
//! apenas o comando nao ser encontrado. Ainda por cima o arquivo certo nao e
//! obvio entre `.zshrc`, `.zprofile`, `.bashrc`, `.bash_profile` e o do fish,
//! e dotfiles de quem programa costumam ser symlink de um repositorio.
//!
//! No Windows a conclusao se inverte, e a assimetria e proposital: la o PATH
//! do usuario nao e arquivo pessoal, e o valor `Path` em `HKCU\Environment`,
//! mecanismo por usuario, sem administrador, que o rustup e o instalador do
//! Node usam. Escrever ali nao tem o risco de estragar configuracao alheia.

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

/// Sistema de destino. Vem por parametro, e nao por `cfg!` dentro da funcao,
/// para os tres corpos de script serem exercitados nos tres runners da CI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Target {
    MacOs,
    Linux,
    Windows,
}

impl Target {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Target::MacOs
        } else if cfg!(target_os = "windows") {
            Target::Windows
        } else {
            Target::Linux
        }
    }
}

const MACOS_SOURCE: &str = include_str!("../../../../scripts/cialai-command-macos.sh");
const LINUX_SOURCE: &str = include_str!("../../../../scripts/cialai-command-linux.sh");
const WINDOWS_SOURCE: &str = include_str!("../../../../scripts/cialai-command-windows.cmd");

/// Primeira linha de comentario dos tres scripts. E por ela que o app
/// reconhece um arquivo como seu, e nunca sobrescreve nem apaga o de outro.
pub const CLI_MARKER: &str = "cialai-command v1";
const LAUNCHER_SLOT: &str = "@CIALAI_LAUNCHER@";
const MISSING_SLOT: &str = "@CIALAI_MISSING@";
/// Lapide de remocao: enquanto existir, a abertura nao reinstala.
const TOMBSTONE: &str = "cli-disabled";

/// Estado devolvido para a interface.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliReport {
    /// `installed`, `unchanged`, `kept`, `disabled`, `skipped` ou `missing`.
    pub state: &'static str,
    pub path: String,
    pub directory: String,
    /// `None` quando a sondagem do PATH nao foi feita ou nao respondeu.
    pub on_path: Option<bool>,
    /// Linha a acrescentar no arquivo do shell, quando a pasta esta fora do
    /// PATH. Viaja como dado, nunca como chave de dicionario, para o caminho
    /// nao passar pelo check de texto visivel.
    pub path_hint: Option<String>,
    /// No Windows o PATH novo so vale em console aberto depois.
    pub needs_new_terminal: bool,
}

impl CliReport {
    fn new(state: &'static str, path: &Path, directory: &Path) -> Self {
        Self {
            state,
            path: crate::platform::to_portable(path),
            directory: crate::platform::to_portable(directory),
            on_path: None,
            path_hint: None,
            needs_new_terminal: false,
        }
    }
}

/// Pasta do comando. `~/.local/bin` no POSIX; no Windows uma pasta propria em
/// `%LOCALAPPDATA%`, que e o que entra no `Path` do usuario.
pub fn command_dir(home: &Path, target: Target) -> PathBuf {
    match target {
        Target::Windows => home
            .join("AppData")
            .join("Local")
            .join("Programs")
            .join("Cialai")
            .join("bin"),
        _ => home.join(".local").join("bin"),
    }
}

pub fn command_file(target: Target) -> &'static str {
    match target {
        Target::Windows => "cialai.cmd",
        _ => "cialai",
    }
}

pub fn command_path(home: &Path, target: Target) -> PathBuf {
    command_dir(home, target).join(command_file(target))
}

/// Aspas simples do shell, com `'` escapado como `'\''`.
pub fn quote_sh(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// Caminho que o script deve abrir.
///
/// No AppImage vale `$APPIMAGE`, o arquivo que o usuario guardou; `current_exe`
/// aponta para dentro da imagem montada, que some quando o app fecha. E o
/// mesmo raciocinio do sidecar do tunel. No macOS sobe do executavel ate o
/// pacote `.app`, que e o que o `open` entende.
///
/// Devolve `None` quando o app roda de um volume montado, tipico de abrir
/// direto do dmg: gravar esse caminho apontaria para um volume que vai ser
/// ejetado.
pub fn launcher_from(
    appimage: Option<&OsStr>,
    current_exe: &Path,
    target: Target,
) -> Option<PathBuf> {
    if let Some(value) = appimage {
        if !value.is_empty() {
            return Some(PathBuf::from(value));
        }
    }
    if current_exe.starts_with("/Volumes") {
        return None;
    }
    if target == Target::MacOs {
        // .../Cialai.app/Contents/MacOS/cialai-desktop
        let bundle = current_exe.parent()?.parent()?.parent()?;
        if bundle.extension().and_then(OsStr::to_str) == Some("app") {
            return Some(bundle.to_path_buf());
        }
    }
    Some(current_exe.to_path_buf())
}

/// Corpo do script para um sistema, com o caminho e a mensagem ja no lugar.
pub fn script_for(target: Target, launcher: &Path, missing: &str) -> String {
    let path = launcher.to_string_lossy();
    match target {
        Target::Windows => {
            let body = WINDOWS_SOURCE
                .replace(LAUNCHER_SLOT, &format!("\"{path}\""))
                // Aspas duplas quebrariam o `echo` do batch. O caractere e
                // escrito por codigo para nao confundir o varredor de chaves
                // de `check-mobile-i18n.mjs`, que parea aspas por regex.
                .replace(MISSING_SLOT, &missing.replace('\u{22}', "'"));
            // Batch com rotulo e fim de linha do Unix se comporta mal no
            // cmd.exe, entao o arquivo sai sempre em CRLF.
            body.replace("\r\n", "\n").replace('\n', "\r\n")
        }
        Target::MacOs => MACOS_SOURCE
            .replace(LAUNCHER_SLOT, &quote_sh(&path))
            .replace(MISSING_SLOT, &quote_sh(missing)),
        Target::Linux => LINUX_SOURCE
            .replace(LAUNCHER_SLOT, &quote_sh(&path))
            .replace(MISSING_SLOT, &quote_sh(missing)),
    }
}

fn is_ours(contents: &str) -> bool {
    contents
        .lines()
        .take(4)
        .any(|line| line.contains(CLI_MARKER))
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

fn backup(path: &Path) -> Result<(), String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let copy = path.with_extension(format!("bak-{stamp}"));
    fs::copy(path, copy)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Instala o comando. `forced` vem do botao das Preferencias e sobrescreve um
/// arquivo alheio, sempre com copia de seguranca antes.
pub fn install(
    home: &Path,
    config: &Path,
    launcher: Option<&Path>,
    target: Target,
    forced: bool,
) -> Result<CliReport, String> {
    let directory = command_dir(home, target);
    let path = command_path(home, target);
    if !forced && config.join(TOMBSTONE).exists() {
        return Ok(CliReport::new("disabled", &path, &directory));
    }
    let Some(launcher) = launcher else {
        return Ok(CliReport::new("skipped", &path, &directory));
    };
    let wanted = script_for(target, launcher, &crate::i18n::t("native.command.missing"));
    let current = fs::read_to_string(&path).ok();
    if let Some(current) = current.as_deref() {
        if current == wanted {
            return Ok(CliReport::new("unchanged", &path, &directory));
        }
        if !is_ours(current) {
            if !forced {
                return Ok(CliReport::new("kept", &path, &directory));
            }
            backup(&path)?;
        }
    }
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    write_atomic(&path, &wanted)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }
    if forced {
        let _ = fs::remove_file(config.join(TOMBSTONE));
    }
    let mut report = CliReport::new("installed", &path, &directory);
    if target == Target::Windows {
        report.needs_new_terminal = windows_path_add(&directory)?;
    }
    Ok(report)
}

/// Remove o comando e deixa a lapide, para a proxima abertura nao reinstalar.
/// Arquivo que nao carrega o marcador nunca e apagado.
pub fn uninstall(home: &Path, config: &Path, target: Target) -> Result<CliReport, String> {
    let directory = command_dir(home, target);
    let path = command_path(home, target);
    match fs::read_to_string(&path) {
        Ok(current) if is_ours(&current) => {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        Ok(_) => return Ok(CliReport::new("kept", &path, &directory)),
        Err(_) => {}
    }
    if target == Target::Windows {
        windows_path_remove(&directory)?;
    }
    fs::create_dir_all(config).map_err(|error| error.to_string())?;
    fs::write(config.join(TOMBSTONE), CLI_MARKER).map_err(|error| error.to_string())?;
    Ok(CliReport::new("disabled", &path, &directory))
}

/// A pasta aparece no PATH lido de um shell de login? Aceita a forma literal
/// com `~` e com `$HOME`, e a lista separada por espaco que o fish imprime.
pub fn on_path(output: &str, directory: &Path, home: &Path) -> bool {
    let target = crate::platform::to_portable(directory);
    let short = target.replacen(&crate::platform::to_portable(home), "~", 1);
    let dollar = target.replacen(&crate::platform::to_portable(home), "$HOME", 1);
    output
        .split([':', ' ', '\n', '\r'])
        .map(|item| item.trim().trim_end_matches('/'))
        .filter(|item| !item.is_empty())
        .any(|item| item == target || item == short || item == dollar)
}

/// Linha que o usuario cola no arquivo do shell. Sem parenteses e sem
/// travessao, para valer a mesma regra de texto visivel do resto.
pub fn path_hint(shell: &str, directory: &Path) -> String {
    let portable = crate::platform::to_portable(directory);
    if shell.contains("fish") {
        format!("fish_add_path {portable}")
    } else {
        format!("export PATH=\"{portable}:$PATH\"")
    }
}

#[cfg(windows)]
mod registry {
    use super::*;
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    use windows_sys::Win32::Foundation::{ERROR_SUCCESS, HWND};
    use windows_sys::Win32::System::Registry::{
        HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_WRITE, REG_EXPAND_SZ, REG_SZ, RegCloseKey,
        RegOpenKeyExW, RegQueryValueExW, RegSetValueExW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        HWND_BROADCAST, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_SETTINGCHANGE,
    };

    fn wide(value: &str) -> Vec<u16> {
        std::ffi::OsStr::new(value)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    /// Le `Path` sem expandir: ler expandido e regravar destruiria as
    /// entradas `%USERPROFILE%` que o usuario tem.
    fn read_path() -> Option<(String, u32)> {
        unsafe {
            let mut key: HKEY = std::ptr::null_mut();
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                wide("Environment").as_ptr(),
                0,
                KEY_READ,
                &mut key,
            ) != ERROR_SUCCESS
            {
                return None;
            }
            let name = wide("Path");
            let mut kind: u32 = 0;
            let mut size: u32 = 0;
            let status = RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                std::ptr::null_mut(),
                &mut size,
            );
            if status != ERROR_SUCCESS {
                RegCloseKey(key);
                return Some((String::new(), REG_EXPAND_SZ));
            }
            let mut buffer = vec![0u8; size as usize];
            let status = RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null_mut(),
                &mut kind,
                buffer.as_mut_ptr(),
                &mut size,
            );
            RegCloseKey(key);
            if status != ERROR_SUCCESS {
                return None;
            }
            let units: Vec<u16> = buffer
                .chunks_exact(2)
                .map(|pair| u16::from_ne_bytes([pair[0], pair[1]]))
                .take_while(|unit| *unit != 0)
                .collect();
            Some((
                std::ffi::OsString::from_wide(&units)
                    .to_string_lossy()
                    .into_owned(),
                kind,
            ))
        }
    }

    fn write_path(value: &str, kind: u32) -> Result<(), String> {
        unsafe {
            let mut key: HKEY = std::ptr::null_mut();
            if RegOpenKeyExW(
                HKEY_CURRENT_USER,
                wide("Environment").as_ptr(),
                0,
                KEY_WRITE,
                &mut key,
            ) != ERROR_SUCCESS
            {
                return Err("nao foi possivel abrir o ambiente do usuario".into());
            }
            let data = wide(value);
            let bytes = std::slice::from_raw_parts(
                data.as_ptr() as *const u8,
                data.len() * std::mem::size_of::<u16>(),
            );
            let kind = if kind == REG_SZ {
                REG_SZ
            } else {
                REG_EXPAND_SZ
            };
            let status = RegSetValueExW(
                key,
                wide("Path").as_ptr(),
                0,
                kind,
                bytes.as_ptr(),
                bytes.len() as u32,
            );
            RegCloseKey(key);
            if status != ERROR_SUCCESS {
                return Err("nao foi possivel gravar o PATH do usuario".into());
            }
            let environment = wide("Environment");
            SendMessageTimeoutW(
                HWND_BROADCAST as HWND,
                WM_SETTINGCHANGE,
                0,
                environment.as_ptr() as isize,
                SMTO_ABORTIFHUNG,
                1000,
                std::ptr::null_mut(),
            );
            Ok(())
        }
    }

    pub fn add(directory: &Path) -> Result<bool, String> {
        let Some((current, kind)) = read_path() else {
            return Ok(false);
        };
        let Some(next) = super::path_with(&current, directory) else {
            return Ok(false);
        };
        write_path(&next, kind)?;
        Ok(true)
    }

    pub fn remove(directory: &Path) -> Result<(), String> {
        let Some((current, kind)) = read_path() else {
            return Ok(());
        };
        let Some(next) = super::path_without(&current, directory) else {
            return Ok(());
        };
        write_path(&next, kind)
    }
}

/// Acrescenta a pasta ao PATH, ou `None` quando ela ja esta la. A comparacao
/// ignora maiusculas e barra final, como o Windows faz.
pub fn path_with(existing: &str, directory: &Path) -> Option<String> {
    let wanted = directory.to_string_lossy().replace('/', "\\");
    let present = existing.split(';').any(|item| {
        item.trim()
            .trim_end_matches('\\')
            .eq_ignore_ascii_case(wanted.trim_end_matches('\\'))
    });
    if present {
        return None;
    }
    if existing.trim().is_empty() {
        return Some(wanted);
    }
    Some(format!("{};{}", existing.trim_end_matches(';'), wanted))
}

/// Tira a pasta do PATH, ou `None` quando ela nao esta la.
pub fn path_without(existing: &str, directory: &Path) -> Option<String> {
    let wanted = directory.to_string_lossy().replace('/', "\\");
    let kept: Vec<&str> = existing
        .split(';')
        .filter(|item| !item.trim().is_empty())
        .filter(|item| {
            !item
                .trim()
                .trim_end_matches('\\')
                .eq_ignore_ascii_case(wanted.trim_end_matches('\\'))
        })
        .collect();
    if kept.len()
        == existing
            .split(';')
            .filter(|item| !item.trim().is_empty())
            .count()
    {
        return None;
    }
    Some(kept.join(";"))
}

#[cfg(windows)]
fn windows_path_add(directory: &Path) -> Result<bool, String> {
    registry::add(directory)
}

#[cfg(not(windows))]
fn windows_path_add(_directory: &Path) -> Result<bool, String> {
    Ok(false)
}

#[cfg(windows)]
fn windows_path_remove(directory: &Path) -> Result<(), String> {
    registry::remove(directory)
}

#[cfg(not(windows))]
fn windows_path_remove(_directory: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("oc-cli-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let home = dir.join("home");
        let config = dir.join("config");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&config).unwrap();
        (home, config)
    }

    fn app(dir: &Path, name: &str) -> PathBuf {
        let path = dir.join(name);
        fs::write(&path, "binario").unwrap();
        path
    }

    #[test]
    fn installs_the_command_and_writes_only_when_it_changes() {
        let (home, config) = sandbox("install");
        let launcher = app(&home, "Cialai");
        let first = install(&home, &config, Some(&launcher), Target::Linux, false).unwrap();
        assert_eq!(first.state, "installed");
        let path = command_path(&home, Target::Linux);
        assert!(path.exists());
        let body = fs::read_to_string(&path).unwrap();
        assert!(body.contains(CLI_MARKER));
        assert!(body.contains(&launcher.to_string_lossy().to_string()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(fs::metadata(&path).unwrap().permissions().mode() & 0o111, 0);
        }
        let again = install(&home, &config, Some(&launcher), Target::Linux, false).unwrap();
        assert_eq!(again.state, "unchanged");
    }

    #[test]
    fn rewrites_the_command_when_the_app_moved() {
        let (home, config) = sandbox("moved");
        let first = app(&home, "um");
        install(&home, &config, Some(&first), Target::Linux, false).unwrap();
        let second = app(&home, "dois");
        let report = install(&home, &config, Some(&second), Target::Linux, false).unwrap();
        assert_eq!(report.state, "installed");
        let body = fs::read_to_string(command_path(&home, Target::Linux)).unwrap();
        assert!(body.contains(&second.to_string_lossy().to_string()));
        assert!(!body.contains(&first.to_string_lossy().to_string()));
    }

    #[test]
    fn keeps_a_file_that_is_not_ours_until_forced() {
        let (home, config) = sandbox("alheio");
        let launcher = app(&home, "Cialai");
        let path = command_path(&home, Target::Linux);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "#!/bin/sh\necho outro\n").unwrap();
        let kept = install(&home, &config, Some(&launcher), Target::Linux, false).unwrap();
        assert_eq!(kept.state, "kept");
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "#!/bin/sh\necho outro\n"
        );

        let forced = install(&home, &config, Some(&launcher), Target::Linux, true).unwrap();
        assert_eq!(forced.state, "installed");
        assert!(fs::read_to_string(&path).unwrap().contains(CLI_MARKER));
        let backups = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|item| item.file_name().to_string_lossy().contains("bak-"))
            .count();
        assert_eq!(
            backups, 1,
            "o arquivo alheio precisa virar copia de seguranca"
        );
    }

    #[test]
    fn uninstall_removes_only_our_script_and_leaves_a_tombstone() {
        let (home, config) = sandbox("remover");
        let launcher = app(&home, "Cialai");
        install(&home, &config, Some(&launcher), Target::Linux, false).unwrap();
        let gone = uninstall(&home, &config, Target::Linux).unwrap();
        assert_eq!(gone.state, "disabled");
        assert!(!command_path(&home, Target::Linux).exists());
        let blocked = install(&home, &config, Some(&launcher), Target::Linux, false).unwrap();
        assert_eq!(
            blocked.state, "disabled",
            "a lapide impede a reinstalacao automatica"
        );
        let back = install(&home, &config, Some(&launcher), Target::Linux, true).unwrap();
        assert_eq!(back.state, "installed", "o botao apaga a lapide");
    }

    #[test]
    fn uninstall_never_touches_a_file_that_is_not_ours() {
        let (home, config) = sandbox("remover-alheio");
        let path = command_path(&home, Target::Linux);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "#!/bin/sh\necho outro\n").unwrap();
        let report = uninstall(&home, &config, Target::Linux).unwrap();
        assert_eq!(report.state, "kept");
        assert!(path.exists());
    }

    #[test]
    fn each_system_gets_the_body_it_needs() {
        let launcher = PathBuf::from("/Applications/Cialai.app");
        let mac = script_for(Target::MacOs, &launcher, "faltou");
        assert!(mac.contains("open -b br.com.ordinum.cialai"));
        assert!(mac.starts_with("#!/bin/sh"));

        let linux = script_for(
            Target::Linux,
            &PathBuf::from("/usr/bin/cialai-desktop"),
            "faltou",
        );
        assert!(linux.contains("setsid"));
        assert!(linux.contains("/usr/bin/cialai-desktop"));

        let windows = script_for(
            Target::Windows,
            &PathBuf::from("C:\\Cialai\\cialai-desktop.exe"),
            "faltou",
        );
        assert!(windows.starts_with("@echo off"));
        assert!(windows.contains("start \"\""));
        assert!(!windows.contains('\n') || windows.contains("\r\n"));
        assert!(
            !windows.replace("\r\n", "").contains('\n'),
            "o batch precisa sair em CRLF"
        );
    }

    #[test]
    fn the_launcher_prefers_the_appimage_and_the_bundle() {
        let appimage = std::ffi::OsString::from("/home/ana/Apps/Cialai.AppImage");
        assert_eq!(
            launcher_from(
                Some(&appimage),
                Path::new("/tmp/.mount_x/usr/bin/cialai-desktop"),
                Target::Linux
            ),
            Some(PathBuf::from("/home/ana/Apps/Cialai.AppImage")),
        );
        assert_eq!(
            launcher_from(
                None,
                Path::new("/Applications/Cialai.app/Contents/MacOS/cialai-desktop"),
                Target::MacOs
            ),
            Some(PathBuf::from("/Applications/Cialai.app")),
        );
        assert_eq!(
            launcher_from(None, Path::new("/usr/bin/cialai-desktop"), Target::Linux),
            Some(PathBuf::from("/usr/bin/cialai-desktop")),
        );
        // Aberto direto do dmg montado: nao da para gravar esse caminho.
        assert_eq!(
            launcher_from(
                None,
                Path::new("/Volumes/Cialai/Cialai.app/Contents/MacOS/cialai-desktop"),
                Target::MacOs
            ),
            None,
        );
    }

    #[test]
    fn the_login_path_is_read_from_text() {
        let home = Path::new("/home/ana");
        let dir = Path::new("/home/ana/.local/bin");
        assert!(on_path("/usr/bin:/home/ana/.local/bin:/bin", dir, home));
        assert!(
            on_path("/usr/bin /home/ana/.local/bin /bin", dir, home),
            "fish imprime separado por espaco"
        );
        assert!(on_path("~/.local/bin:/usr/bin", dir, home));
        assert!(on_path("$HOME/.local/bin:/usr/bin", dir, home));
        assert!(
            on_path("/home/ana/.local/bin/:/usr/bin", dir, home),
            "barra final nao muda a pasta"
        );
        assert!(!on_path("/usr/bin:/bin", dir, home));
        assert!(!on_path("", dir, home));
    }

    #[test]
    fn the_suggested_line_matches_the_shell_and_obeys_the_text_rule() {
        let dir = Path::new("/home/ana/.local/bin");
        assert_eq!(
            path_hint("/bin/zsh", dir),
            "export PATH=\"/home/ana/.local/bin:$PATH\""
        );
        assert_eq!(
            path_hint("/usr/bin/fish", dir),
            "fish_add_path /home/ana/.local/bin"
        );
        for shell in ["/bin/zsh", "/bin/bash", "/usr/bin/fish"] {
            let line = path_hint(shell, dir);
            assert!(!line.contains('('), "sem parenteses em {line}");
            assert!(!line.contains(')'), "sem parenteses em {line}");
            assert!(!line.contains(" - "), "sem hifen isolado em {line}");
            assert!(
                !line.contains('\u{2013}') && !line.contains('\u{2014}'),
                "sem travessao em {line}"
            );
        }
    }

    /// Sintaxe de verdade, pelo proprio shell. Um erro de aspas so apareceria
    /// na maquina do usuario, e o script e gerado por substituicao de texto.
    #[cfg(unix)]
    #[test]
    fn the_posix_scripts_are_valid_shell() {
        use std::io::Write;
        for (target, launcher) in [
            (Target::MacOs, "/Applications/Cialai.app"),
            (Target::MacOs, "/Users/d'ana/Applications/Cialai.app"),
            (Target::Linux, "/usr/bin/cialai-desktop"),
            (Target::Linux, "/home/d'ana/Apps/Cialai.AppImage"),
        ] {
            let body = script_for(target, Path::new(launcher), "Cialai nao encontrado.");
            let mut child = std::process::Command::new("sh")
                .arg("-n")
                .stdin(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .expect("sh disponivel");
            child
                .stdin
                .as_mut()
                .expect("entrada do sh")
                .write_all(body.as_bytes())
                .expect("escreve o script");
            let output = child.wait_with_output().expect("sh responde");
            assert!(
                output.status.success(),
                "script invalido para {launcher}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn quote_sh_survives_a_quote_in_the_path() {
        assert_eq!(quote_sh("/home/d'ana/Cialai"), "'/home/d'\\''ana/Cialai'");
        let script = script_for(Target::MacOs, Path::new("/home/d'ana/Cialai.app"), "faltou");
        assert!(script.contains("'/home/d'\\''ana/Cialai.app'"));
    }

    #[test]
    fn the_user_path_gains_the_folder_once_and_loses_it_cleanly() {
        let dir = Path::new("C:\\Users\\ana\\AppData\\Local\\Programs\\Cialai\\bin");
        let wanted = "C:\\Users\\ana\\AppData\\Local\\Programs\\Cialai\\bin";
        assert_eq!(path_with("", dir).as_deref(), Some(wanted));
        assert_eq!(
            path_with("C:\\Windows", dir).as_deref(),
            Some(&*format!("C:\\Windows;{wanted}"))
        );
        assert_eq!(
            path_with(&format!("C:\\Windows;{wanted}"), dir),
            None,
            "ja presente nao duplica"
        );
        assert_eq!(
            path_with(&format!("C:\\Windows;{}\\", wanted.to_lowercase()), dir),
            None,
            "maiusculas e barra final nao contam"
        );
        // %USERPROFILE% precisa sobreviver, entao a entrada nao expandida fica.
        let expandable = "%USERPROFILE%\\bin;C:\\Windows";
        assert_eq!(
            path_with(expandable, dir).as_deref(),
            Some(&*format!("{expandable};{wanted}"))
        );

        assert_eq!(
            path_without(&format!("C:\\Windows;{wanted}"), dir).as_deref(),
            Some("C:\\Windows")
        );
        assert_eq!(
            path_without(&format!("{wanted};C:\\Windows"), dir).as_deref(),
            Some("C:\\Windows")
        );
        assert_eq!(path_without(wanted, dir).as_deref(), Some(""));
        assert_eq!(path_without("C:\\Windows", dir), None);
        assert_eq!(
            path_without(&format!("A;{wanted};B"), dir).as_deref(),
            Some("A;B")
        );
    }
}
