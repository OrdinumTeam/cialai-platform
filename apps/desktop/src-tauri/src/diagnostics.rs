// SPDX-License-Identifier: Apache-2.0
//! Registro do app em disco.
//!
//! Aberto pelo Dock, o stderr do app vai para lugar nenhum, e o macOS pode
//! nao guardar o relatorio de um crash: na queda de 10/09/2026 o ReportCrash
//! respondeu `Destination unavailable` e nada ficou. Por isso, fora de um
//! terminal, o stderr passa a ir para
//! `~/Library/Logs/br.com.ordinum.cialai/app.log`, com os `eprintln!` do
//! app, a mensagem de qualquer panic com a thread e o local, o inicio e a
//! saida pedida. Uma linha de inicio sem uma saida antes dela marca uma
//! queda. Rodando num terminal, como no `npm run dev`, nada muda.

use std::fs::{self, OpenOptions};
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};

/// Acima disto o log vira `app.log.1` na abertura seguinte.
const LOG_LIMIT: u64 = 5 * 1024 * 1024;

pub fn install() {
    // SAFETY: isatty so consulta o descritor.
    let interactive = unsafe { libc::isatty(libc::STDERR_FILENO) } == 1;
    if !interactive {
        if let Some(path) = log_path() {
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

fn log_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join("Library/Logs/br.com.ordinum.cialai/app.log"))
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
    // SAFETY: dup2 poe uma copia do arquivo no descritor 2. O arquivo pode
    // fechar ao sair daqui porque o descritor 2 segura a propria copia.
    unsafe {
        libc::dup2(file.as_raw_fd(), libc::STDERR_FILENO);
    }
}
