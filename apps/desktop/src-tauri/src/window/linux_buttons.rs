// SPDX-License-Identifier: Apache-2.0
//! Ordem dos botoes da janela no Linux com Wayland.
//!
//! No Wayland o tao desenha a barra de titulo com um `HeaderBar` do GTK e fixa
//! nele a ordem `menu:minimize,maximize,close`, em
//! `tao/src/platform_impl/linux/wayland/header.rs`. A ordem fixa passa por
//! cima do `button-layout` do GNOME e do KDE: quem usa os botoes a esquerda,
//! ou em outra ordem, via a janela do Cialai diferente de todas as outras. O
//! tao ainda reaplica a ordem fixa a cada troca de `resizable`, e a abertura
//! da janela troca essa propriedade.
//!
//! Sem ordem propria o `HeaderBar` segue o ajuste `gtk-decoration-layout`, que
//! o GTK le do sistema, e acompanha a mudanca com o app aberto. O GTK tambem
//! esconde sozinho o botao de maximizar numa janela que nao redimensiona, que
//! era o motivo da segunda ordem do tao.
//!
//! No X11, e na AppImage, que forca o X11, o tao nao cria a barra: o
//! gerenciador de janelas desenha a moldura na ordem do sistema e aqui nao ha
//! nada a fazer.

use gtk::prelude::*;
use tauri::WebviewWindow;

/// Devolve ao sistema a ordem dos botoes da barra de titulo. Roda na thread
/// principal, a unica em que o GTK aceita ser tocado.
pub fn follow_system_layout(window: &WebviewWindow) {
    let owner = window.clone();
    let _ = window.run_on_main_thread(move || {
        let Ok(gtk_window) = owner.gtk_window() else {
            return;
        };
        let Some(header) = tao_header_bar(&gtk_window) else {
            return;
        };
        header.set_decoration_layout(None);
        // O GLib chama os handlers na ordem em que foram ligados, entao este
        // roda depois do que o tao ligou ao criar a janela.
        let header = header.downgrade();
        gtk_window.connect_resizable_notify(move |_| {
            if let Some(header) = header.upgrade() {
                header.set_decoration_layout(None);
            }
        });
    });
}

/// O `HeaderBar` do tao fica dentro de um `EventBox` posto como barra de
/// titulo. Sem barra, que e o caso do X11, nao ha o que ajustar.
fn tao_header_bar(window: &gtk::ApplicationWindow) -> Option<gtk::HeaderBar> {
    let titlebar = match window.titlebar()?.downcast::<gtk::HeaderBar>() {
        Ok(header) => return Some(header),
        Err(titlebar) => titlebar,
    };
    titlebar
        .downcast::<gtk::Bin>()
        .ok()?
        .child()?
        .downcast::<gtk::HeaderBar>()
        .ok()
}
