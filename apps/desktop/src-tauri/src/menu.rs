// SPDX-License-Identifier: Apache-2.0
//! Menubar nativa do macOS antes da interface.
//!
//! Sem este menu o Tauri mostraria o padrao em ingles ate a interface instalar
//! a menubar completa por `packages/ui/src/desktop/menu.js`. Aqui ficam os itens
//! do sistema no idioma gravado, e Sair passa pela confirmacao de `lifecycle`.
//! A interface reinstala a menubar com as mesmas chaves quando o idioma muda,
//! sem reiniciar o app.

use tauri::AppHandle;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};

use crate::i18n::t;

const QUIT_ID: &str = "cialai-startup-quit";

pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let about = AboutMetadata {
        name: Some("Cialai".into()),
        version: Some(app.package_info().version.to_string()),
        comments: Some(t("native.menu.aboutComment")),
        copyright: Some("Ordinum".into()),
        ..Default::default()
    };
    let application = Submenu::with_items(
        app,
        "Cialai",
        true,
        &[
            &PredefinedMenuItem::about(app, Some(&t("native.menu.about")), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some(&t("native.menu.services")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some(&t("native.menu.hide")))?,
            &PredefinedMenuItem::hide_others(app, Some(&t("native.menu.hideOthers")))?,
            &PredefinedMenuItem::show_all(app, Some(&t("native.menu.showAll")))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(
                app,
                QUIT_ID,
                t("native.menu.quit"),
                true,
                Some("CmdOrCtrl+Q"),
            )?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        t("native.menu.edit"),
        true,
        &[
            &PredefinedMenuItem::undo(app, Some(&t("native.menu.undo")))?,
            &PredefinedMenuItem::redo(app, Some(&t("native.menu.redo")))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some(&t("native.menu.cut")))?,
            &PredefinedMenuItem::copy(app, Some(&t("native.menu.copy")))?,
            &PredefinedMenuItem::paste(app, Some(&t("native.menu.paste")))?,
            &PredefinedMenuItem::select_all(app, Some(&t("native.menu.selectAll")))?,
        ],
    )?;
    let view = Submenu::with_items(
        app,
        t("native.menu.view"),
        true,
        &[&PredefinedMenuItem::fullscreen(
            app,
            Some(&t("native.menu.fullscreen")),
        )?],
    )?;
    let window = Submenu::with_items(
        app,
        t("native.menu.window"),
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some(&t("native.menu.minimize")))?,
            &PredefinedMenuItem::maximize(app, Some(&t("native.menu.zoom")))?,
        ],
    )?;
    app.set_menu(Menu::with_items(
        app,
        &[&application, &edit, &view, &window],
    )?)?;
    app.on_menu_event(|app, event| {
        if event.id() == QUIT_ID {
            crate::lifecycle::request_exit(app);
        }
    });
    Ok(())
}
