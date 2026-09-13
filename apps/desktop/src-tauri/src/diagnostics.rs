// SPDX-License-Identifier: Apache-2.0
//! Registro do app em disco.
//!
//! Fora de um terminal, o stderr passa a ir para `app.log` na pasta de logs
//! que o Tauri resolve para o sistema atual. O arquivo recebe os `eprintln!`
//! do app, a mensagem de qualquer panic com a thread e o local, o inicio e a
//! saida pedida. Uma linha de inicio sem uma saida antes dela marca uma queda.
//! Rodando num terminal, como no `npm run dev`, nada muda.

use std::fs::{self, OpenOptions};
use std::io::IsTerminal;
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// Acima disto o log vira `app.log.1` na abertura seguinte.
const LOG_LIMIT: u64 = 5 * 1024 * 1024;

pub fn install(app: &AppHandle) {
    if !std::io::stderr().is_terminal() {
        if let Some(path) = log_path(app) {
            redirect_stderr(&path);
        }
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        eprintln!(
            "[{}] panic na thread {}: {info}",
            timestamp(),
            thread.name().unwrap_or("sem nome")
        );
        default_hook(info);
    }));
    note(&format!(
        "Cialai {} iniciado, pid {}",
        env!("CARGO_PKG_VERSION"),
        std::process::id()
    ));
}

pub fn note(message: &str) {
    eprintln!("[{}] {message}", timestamp());
}

fn timestamp() -> String {
    chrono::Local::now()
        .format("%Y-%m-%d %H:%M:%S%.3f")
        .to_string()
}

fn log_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_log_dir().ok().map(|dir| dir.join("app.log"))
}

fn redirect_stderr(path: &Path) {
    let Some(dir) = path.parent() else { return };
    if fs::create_dir_all(dir).is_err() {
        return;
    }
    if fs::metadata(path).is_ok_and(|meta| meta.len() > LOG_LIMIT) {
        let _ = fs::rename(path, path.with_extension("log.1"));
    }
    let Ok(file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    #[cfg(unix)]
    {
        // SAFETY: dup2 poe uma copia do arquivo no descritor 2. O arquivo pode
        // fechar ao sair daqui porque o descritor 2 segura a propria copia.
        unsafe {
            libc::dup2(file.as_raw_fd(), libc::STDERR_FILENO);
        }
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::io::IntoRawHandle;
        use windows_sys::Win32::System::Console::{STD_ERROR_HANDLE, SetStdHandle};

        let handle = file.into_raw_handle();
        // SAFETY: o handle passa a pertencer ao stderr do processo e permanece
        // aberto ate a saida do aplicativo.
        if unsafe { SetStdHandle(STD_ERROR_HANDLE, handle as _) } == 0 {
            // Reconstruir fecha o handle quando o redirecionamento falha.
            use std::os::windows::io::FromRawHandle;
            unsafe { drop(std::fs::File::from_raw_handle(handle)) };
        }
    }
}
