// SPDX-License-Identifier: Apache-2.0
//! Saida do app com terminais abertos.
//!
//! Os shells vivem dentro do processo do app, entao sair encerra todos, com
//! os agentes que rodam neles. Fechar a janela principal, `⌘W` fora da secao
//! Terminais e `⌘Q` pelo menu passam por aqui: sem terminal aberto o app sai
//! na hora; com terminal, um alerta nativo pede confirmacao. O alerta e do
//! AppKit e nao depende do webview, entao aparece mesmo com a interface
//! travada. A saida pelo Dock ou pelo desligamento do Mac chega direto como
//! `RunEvent::Exit` e nao pode ser interrompida.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::i18n::{locale, t, translate};
use crate::workspace::terminal::TerminalManager;

/// Um alerta por vez, mesmo com varios pedidos seguidos.
static ASKING: AtomicBool = AtomicBool::new(false);

pub fn request_exit(app: &AppHandle) {
    let live = app
        .try_state::<TerminalManager>()
        .map(|terminals| terminals.live_count())
        .unwrap_or(0);
    if live == 0 {
        app.exit(0);
        return;
    }
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    app.dialog()
        .message(exit_message(locale(), live))
        .title(t("native.quit.title"))
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            t("native.quit.confirm"),
            t("native.quit.cancel"),
        ))
        .show(move |confirmed| {
            ASKING.store(false, Ordering::SeqCst);
            if confirmed {
                handle.exit(0);
            }
        });
}

fn exit_message(locale: &str, live: usize) -> String {
    let count = if live == 1 {
        translate(locale, "native.quit.openOne", &[])
    } else {
        translate(locale, "native.quit.openMany", &[("count", &live)])
    };
    format!("{count} {}", translate(locale, "native.quit.detail", &[]))
}

#[cfg(test)]
mod tests {
    use super::exit_message;

    #[test]
    fn exit_message_counts_the_terminals() {
        assert!(exit_message("pt-BR", 1).starts_with("Há 1 terminal aberto. "));
        assert!(exit_message("pt-BR", 4).starts_with("Há 4 terminais abertos. "));
        assert!(exit_message("en", 4).starts_with("There are 4 open terminals. Quitting ends"));
        assert!(exit_message("es", 1).starts_with("Hay 1 terminal abierto. Salir finaliza"));
    }
}
