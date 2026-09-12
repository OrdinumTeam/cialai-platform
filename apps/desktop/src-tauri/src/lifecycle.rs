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
        .message(exit_message(live))
        .title("Sair do Cialai?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Sair".into(),
            "Cancelar".into(),
        ))
        .show(move |confirmed| {
            ASKING.store(false, Ordering::SeqCst);
            if confirmed {
                handle.exit(0);
            }
        });
}

fn exit_message(live: usize) -> String {
    let count = if live == 1 {
        "Há 1 terminal aberto.".to_string()
    } else {
        format!("Há {live} terminais abertos.")
    };
    format!(
        "{count} Sair encerra os shells e os agentes que rodam neles. O histórico e as conversas de Claude Code e Codex ficam salvos e voltam quando você reabrir as sessões."
    )
}

#[cfg(test)]
mod tests {
    use super::exit_message;

    #[test]
    fn exit_message_counts_the_terminals() {
        assert!(exit_message(1).starts_with("Há 1 terminal aberto. "));
        assert!(exit_message(4).starts_with("Há 4 terminais abertos. "));
    }
}
