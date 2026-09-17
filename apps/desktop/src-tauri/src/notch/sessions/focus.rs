// SPDX-License-Identifier: Apache-2.0
//! Trazer para a frente a janela onde a sessao roda.
//!
//! Uma sessao publica o pid e nada mais: nem janela, nem aba, nem terminal.
//! Entao o app dono e descoberto subindo a arvore de processos, do agente ate
//! quem o lancou.
//!
//! So o macOS tem isso nesta entrega: `NSRunningApplication` diz qual
//! ancestral e um app e o ativa. Escolher a **aba** dentro do app exige a
//! interface de scripting do proprio terminal, e nao existe uma geral: o
//! Terminal e o iTerm2 casam uma aba pelo tty, enquanto o Warp e o Ghostty
//! nao publicam dicionario de scripting nenhum. Por isso o app e levantado
//! para todo mundo, e o nome da sessao no card deixa o ultimo passo a uma
//! tecla de distancia.
//!
//! No Linux e no Windows a sessao ainda e ligada ao card do estudio pela
//! arvore de processos; fora do estudio nao ha app dono para levantar, e a
//! chamada devolve `false` sem erro.

/// Traz para a frente o app dono do processo. `false` quando nao ha app, o
/// que acontece com uma sessao lancada por launchd, por ssh ou fora do macOS.
#[cfg(target_os = "macos")]
pub fn focus(pid: u32) -> bool {
    let Some((app_pid, bundle_id)) = macos::owning_app(pid) else {
        return false;
    };
    if let Some(tty) = macos::tty_of(pid) {
        // O melhor esforco pela aba certa acontece antes de levantar o app,
        // num processo separado, porque o osascript bloqueia.
        macos::select_tab(&bundle_id, &tty);
    }
    macos::activate(app_pid)
}

#[cfg(not(target_os = "macos"))]
pub fn focus(_pid: u32) -> bool {
    false
}

#[cfg(target_os = "macos")]
pub mod macos {
    use std::os::raw::{c_int, c_void};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    use crate::platform;

    use super::super::ancestry;

    const OSASCRIPT_TIMEOUT: Duration = Duration::from_secs(3);

    /// Primeiro ancestral que e um app com identificador de pacote.
    pub fn owning_app(pid: u32) -> Option<(u32, String)> {
        use objc2_app_kit::NSRunningApplication;
        for candidate in ancestry(pid) {
            let running =
                NSRunningApplication::runningApplicationWithProcessIdentifier(candidate as i32)?;
            let Some(bundle) = running.bundleIdentifier() else {
                continue;
            };
            return Some((candidate, bundle.to_string()));
        }
        None
    }

    pub fn activate(pid: u32) -> bool {
        use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
        let Some(running) =
            NSRunningApplication::runningApplicationWithProcessIdentifier(pid as i32)
        else {
            return false;
        };
        running.activateWithOptions(NSApplicationActivationOptions::ActivateAllWindows)
    }

    /// Terminal do processo, como `ttys014`. O `ProcInfo` portavel nao traz
    /// o dispositivo, entao ele e lido aqui do `proc_bsdinfo`.
    pub fn tty_of(pid: u32) -> Option<String> {
        let device = terminal_device(pid)?;
        // NODEV: o processo nao tem terminal.
        if device == u32::MAX {
            return None;
        }
        // SAFETY: devname devolve ponteiro para string estatica do sistema,
        // ou nulo, tratado abaixo.
        let name = unsafe { libc::devname(device as libc::dev_t, libc::S_IFCHR) };
        if name.is_null() {
            return None;
        }
        // SAFETY: ponteiro nao nulo para string estatica terminada em NUL.
        let text = unsafe { std::ffi::CStr::from_ptr(name) }
            .to_string_lossy()
            .to_string();
        if text.is_empty() { None } else { Some(text) }
    }

    fn terminal_device(pid: u32) -> Option<u32> {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as c_int;
        // SAFETY: buffer do tamanho da struct pedida pelo flavor.
        let written = unsafe {
            libc::proc_pidinfo(
                pid as c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut libc::proc_bsdinfo as *mut c_void,
                size,
            )
        };
        if written != size {
            return None;
        }
        Some(info.e_tdev)
    }

    /// Seleciona a aba pelo tty nos terminais que publicam scripting.
    pub fn select_tab(bundle_id: &str, tty: &str) -> bool {
        let script = match bundle_id {
            "com.apple.Terminal" => format!(
                r#"tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "/dev/{tty}" then
        set selected of t to true
        set index of w to 1
        return "found"
      end if
    end repeat
  end repeat
end tell"#
            ),
            "com.googlecode.iterm2" => format!(
                r#"tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "/dev/{tty}" then
          select s
          select t
          select w
          return "found"
        end if
      end repeat
    end repeat
  end repeat
end tell"#
            ),
            _ => return false,
        };
        run_osascript(&script).is_some_and(|out| out.contains("found"))
    }

    fn run_osascript(script: &str) -> Option<String> {
        let mut command = Command::new("/usr/bin/osascript");
        command
            .arg("-e")
            .arg(script)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        platform::configure_background_command(&mut command);
        let mut child = command.spawn().ok()?;
        let start = std::time::Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) => {
                    if start.elapsed() > OSASCRIPT_TIMEOUT {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                    std::thread::sleep(Duration::from_millis(30));
                }
                Err(_) => return None,
            }
        }
        let output = child.wait_with_output().ok()?;
        Some(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn focusing_a_dead_process_fails_quietly() {
        assert!(!focus(u32::MAX - 1));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_terminal_without_scripting_is_left_to_the_app_level() {
        assert!(!macos::select_tab("dev.warp.Warp-Stable", "ttys001"));
        assert!(!macos::select_tab("com.mitchellh.ghostty", "ttys001"));
        assert!(!macos::select_tab("", "ttys001"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_process_without_a_terminal_has_no_tty() {
        // O processo de teste roda sob o cargo, que pode ou nao ter tty; o
        // que importa e nao entrar em panico nos dois casos.
        let _ = macos::tty_of(std::process::id());
        assert!(macos::tty_of(u32::MAX - 1).is_none());
    }
}
