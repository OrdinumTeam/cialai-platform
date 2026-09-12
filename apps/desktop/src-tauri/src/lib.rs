// SPDX-License-Identifier: Apache-2.0
//! Aplicativo desktop do Cialai.
//!
//! O nucleo nativo hospeda o estudio local: PTYs, arquivos, Git, previews,
//! Dev Browser, persistencia e a ponte limitada a terminais. Stack, VPN,
//! reunioes, Node e Python pertenciam ao Control e nao fazem parte deste app.

pub mod bridge;
mod commands;
mod diagnostics;
mod lifecycle;
mod prefs;
mod window;
pub mod workspace;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, RunEvent};

/// Evita repetir a limpeza quando o Tauri emite `ExitRequested` e `Exit`.
static APP_STOPPED: AtomicBool = AtomicBool::new(false);

pub fn run() {
    diagnostics::install();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_uri_scheme_protocol(workspace::preview::SCHEME, |context, request| {
            let roots = context
                .app_handle()
                .state::<workspace::preview::PreviewRoots>();
            workspace::preview::handle(&roots, request)
        })
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::FULLSCREEN,
                )
                .skip_initial_state("main")
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::get_preferences,
            commands::set_preferences,
            commands::splash_ready,
            commands::window_grow,
            commands::pty_spawn,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_view_claim,
            commands::pty_view_renew,
            commands::pty_view_release,
            commands::pty_presentation,
            commands::pty_ack,
            commands::pty_kill,
            commands::pty_attach,
            commands::pty_list,
            commands::pty_metrics,
            commands::pty_saved,
            commands::pty_saved_history,
            commands::pty_forget,
            commands::pty_prune,
            commands::app_request_quit,
            commands::list_repo_dirs,
            commands::fs_list_dir,
            commands::fs_stat,
            commands::fs_read_text,
            commands::fs_write_text,
            commands::fs_read_image,
            commands::fs_create_file,
            commands::fs_create_dir,
            commands::fs_rename,
            commands::fs_copy,
            commands::fs_trash,
            commands::fs_find,
            commands::fs_reveal,
            commands::fs_open_default,
            commands::fs_drag_out,
            commands::ai_usage,
            commands::fs_read_bytes,
            commands::office_convert,
            commands::browser_start,
            commands::browser_stop,
            commands::browser_status,
            commands::browser_list,
            commands::fs_watch,
            commands::fs_unwatch,
            commands::git_status,
            commands::git_diff,
            commands::preview_register,
        ])
        .setup(|app| {
            let preferences = prefs::Preferences::load(app.handle());
            let chromium = preferences.dev_browser.chromium_path.clone();
            app.manage(prefs::PrefsState::new(preferences));
            app.manage(workspace::terminal::TerminalManager::new(
                app.handle().clone(),
            ));
            app.manage(workspace::watch::Watcher::new(app.handle().clone()));
            app.manage(workspace::files::FindCache::default());
            app.manage(workspace::ai::UsageCache::default());
            app.manage(workspace::preview::PreviewRoots::default());
            app.manage(workspace::office::OfficeQueue::default());
            let support = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let home = app
                .path()
                .home_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            app.manage(workspace::browser::BrowserManager::new(
                app.handle().clone(),
                support.join("dev-browser"),
                home,
                chromium,
            ));

            bridge::start(app.handle().clone(), bridge::BridgeConfig::from_process());

            if let Some(main_window) = app.get_webview_window("main") {
                window::decorate(&main_window);
                let keyboard_owner = main_window.clone();
                let exit_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    if matches!(
                        event,
                        tauri::WindowEvent::Focused(true) | tauri::WindowEvent::Resized(_)
                    ) {
                        window::focus_webview(&keyboard_owner);
                    }
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        lifecycle::request_exit(&exit_handle);
                    }
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao construir o app Cialai");

    app.run(|handle, event| {
        if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
            if APP_STOPPED.swap(true, Ordering::SeqCst) {
                return;
            }
            diagnostics::note("saida pedida: encerrando browsers e terminais");
            if let Some(browsers) = handle.try_state::<workspace::browser::BrowserManager>() {
                browsers.kill_all_blocking();
            }
            if let Some(terminals) = handle.try_state::<workspace::terminal::TerminalManager>() {
                terminals.kill_all_blocking();
            }
        }
    });
}
