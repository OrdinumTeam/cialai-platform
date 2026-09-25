// SPDX-License-Identifier: Apache-2.0
//! Aplicativo desktop do Cialai.
//!
//! O nucleo nativo hospeda o estudio local: PTYs, arquivos, Git, previews,
//! Dev Browser, persistencia e a ponte limitada a terminais. Stack, VPN,
//! reunioes, Node e Python pertenciam ao Control e nao fazem parte deste app.

pub mod bridge;
pub mod cli;
mod commands;
mod diagnostics;
mod i18n;
mod lifecycle;
#[cfg(target_os = "macos")]
mod menu;
pub mod notch;
pub mod platform;
mod prefs;
pub mod tunnel;
mod window;
pub mod workspace;

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, RunEvent};

/// Evita repetir a limpeza quando o Tauri emite `ExitRequested` e `Exit`.
static APP_STOPPED: AtomicBool = AtomicBool::new(false);

/// Peças da rede que o app gerencia quando tudo sobe.
struct Network {
    site: tunnel::MobileSite,
    supervisor: tunnel::Supervisor,
}

/// Estado da montagem da rede. Quando ela falha, o app segue como estúdio
/// local e o motivo fica registrado, em vez de o celular simplesmente nunca
/// conectar sem explicação.
#[derive(Clone, Debug, Default)]
pub struct NetworkSetup {
    problem: Option<String>,
}

impl NetworkSetup {
    fn ready() -> Self {
        Self { problem: None }
    }

    fn failed(reason: impl Into<String>) -> Self {
        Self {
            problem: Some(reason.into()),
        }
    }

    /// Motivo de a rede não ter subido, quando ela não subiu.
    pub fn problem(&self) -> Option<&str> {
        self.problem.as_deref()
    }

    pub fn is_ready(&self) -> bool {
        self.problem.is_none()
    }
}

/// Monta a rede na ordem em que uma peça depende da anterior. Cada passo
/// devolve o próprio motivo da falha, e nenhum deles derruba o app.
fn start_network(app: &tauri::AppHandle, awake: tunnel::Awake) -> Result<Network, String> {
    let site = tunnel::MobileSite::resolve(app)?;
    let bridge_config = bridge::BridgeConfig::from_process(
        tunnel::BridgeSession::generate(bridge::DEFAULT_BRIDGE_PORT)?
            .secret()
            .into(),
    );
    let bridge_secret = bridge_config.proxy_secret.clone().unwrap_or_default();
    let bridge_control = bridge::start(app.clone(), bridge_config)?;
    // O sidecar recebe a porta em que a ponte realmente abriu.
    let bridge_session = tunnel::BridgeSession::new(bridge_control.port(), bridge_secret);
    let supervisor =
        tunnel::Supervisor::for_app(app, &site, bridge_session, bridge_control, awake)?;
    Ok(Network { site, supervisor })
}

pub fn run() {
    let app = tauri::Builder::default()
        // O menu localizado entra no setup, quando o idioma gravado ja foi lido.
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Avisos de limite da Barra de IA, desligados por padrao.
        .plugin(tauri_plugin_notification::init())
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
            commands::tunnel_call,
            commands::tunnel_delete_api_key,
            commands::tunnel_doctor,
            commands::app_platform,
            commands::app_paths,
            commands::app_shell,
            commands::shell_probe,
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
            commands::app_set_locale,
            commands::app_selftest_paths,
            commands::list_repo_dirs,
            commands::list_dirs,
            commands::docgraph_scan,
            commands::docgraph_cancel,
            commands::agent_profiles,
            commands::agent_profile_select,
            commands::agent_profile_create,
            commands::agent_profiles_refresh,
            commands::pty_launch_agent,
            commands::doc_preview_window,
            commands::doc_preview_path,
            commands::detect_project_roots,
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
            commands::ai_install_claude_hook,
            commands::cli_status,
            commands::cli_install,
            commands::cli_uninstall,
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
            notch::commands::notch_state,
            notch::commands::notch_refresh,
            notch::commands::notch_set_prefs,
            notch::commands::notch_focus_session,
            notch::commands::notch_open_settings,
            notch::commands::notch_set_visibility,
        ])
        .setup(|app| {
            diagnostics::install(app.handle());
            if let Ok(config) = app.path().app_config_dir() {
                i18n::restore(&config);
            }
            #[cfg(target_os = "macos")]
            menu::install(app.handle())?;
            let preferences = prefs::Preferences::load(app.handle());
            let chromium = preferences.dev_browser.chromium_path.clone();
            let backdrop = preferences.window.backdrop().to_string();
            let awake = tunnel::Awake::start(preferences.network.keep_awake_while_paired);
            app.manage(awake.clone());
            let prefs = prefs::PrefsState::new(preferences);
            app.manage(prefs.clone());
            app.manage(workspace::terminal::TerminalManager::new(
                app.handle().clone(),
                prefs,
            ));
            app.manage(workspace::watch::Watcher::new(app.handle().clone()));
            app.manage(workspace::files::FindCache::default());
            app.manage(workspace::ai::UsageCache::default());
            app.manage(workspace::preview::PreviewRoots::default());
            app.manage(workspace::docgraph::DocScans::default());
            app.manage(commands::DocPreviewState::default());
            app.manage(workspace::office::OfficeQueue::default());
            // A Barra de IA le os perfis e os arquivos que cada agente grava;
            // os dois relogios dela sobem aqui e param na saida.
            let notch = notch::setup(app.handle());
            notch.start();
            app.manage(notch);
            let support = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            let home = app
                .path()
                .home_dir()
                .unwrap_or_else(|_| std::env::temp_dir());
            // Comando `cialai` no terminal, instalado na primeira abertura e
            // conferido em toda abertura, para se consertar sozinho quando o
            // app muda de lugar. Nada aqui pode derrubar o app: o motivo vira
            // registro, como a rede logo abaixo. Fora da thread principal
            // porque toca disco e, no Windows, o ambiente do usuario.
            let cli_home = home.clone();
            let cli_config = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| support.clone());
            std::thread::spawn(move || {
                let target = cli::Target::current();
                let launcher = cli::launcher_from(
                    std::env::var_os("APPIMAGE").as_deref(),
                    &std::env::current_exe().unwrap_or_default(),
                    target,
                );
                // O shell de login do usuario, nao o que as Preferencias usam
                // dentro do Cialai: quem digita `cialai` esta no terminal dele.
                let shell = platform::system_shell();
                match cli::install(
                    &cli_home,
                    &cli_config,
                    launcher.as_deref(),
                    target,
                    false,
                    Some(shell.as_str()),
                ) {
                    Ok(report) => {
                        diagnostics::note(&format!("[cli] {} em {}", report.state, report.path))
                    }
                    Err(reason) => diagnostics::note(&format!("[cli] indisponivel: {reason}")),
                }
            });

            app.manage(workspace::browser::BrowserManager::new(
                app.handle().clone(),
                support.join("dev-browser"),
                home,
                chromium,
            ));

            // Rede: pagina do celular, ponte e supervisor do tunel. Numa
            // instalacao incompleta qualquer uma das tres pode faltar, e
            // derrubar o `setup` por isso matava o app inteiro com um `panic`
            // que, em release, so aparece no `app.log`. A falha vira registro e
            // estado, e o estudio local continua utilizavel sem o celular.
            match start_network(app.handle(), awake) {
                Ok(network) => {
                    app.manage(network.site);
                    app.manage(network.supervisor);
                    app.manage(NetworkSetup::ready());
                }
                Err(reason) => {
                    diagnostics::note(&format!("[rede] indisponivel: {reason}"));
                    app.manage(NetworkSetup::failed(reason));
                }
            }

            if let Some(main_window) = app.get_webview_window("main") {
                window::decorate(&main_window, &backdrop);
                #[cfg(not(target_os = "windows"))]
                let keyboard_owner = main_window.clone();
                let exit_handle = app.handle().clone();
                main_window.on_window_event(move |event| {
                    // No Windows o Tauri sintetiza `Focused(true)` a partir do
                    // GotFocus do proprio WebView2, e pedir foco de novo em
                    // resposta a ele faz o foco oscilar entre o HWND hospedeiro
                    // e a janela do navegador sem parar: teclado e roda do mouse
                    // ficam sem dono. La o WebView2 ja cuida do foco sozinho.
                    #[cfg(not(target_os = "windows"))]
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
            if let Some(notch) = handle.try_state::<notch::NotchManager>() {
                notch.stop();
            }
            if let Some(browsers) = handle.try_state::<workspace::browser::BrowserManager>() {
                browsers.kill_all_blocking();
            }
            if let Some(terminals) = handle.try_state::<workspace::terminal::TerminalManager>() {
                terminals.kill_all_blocking();
            }
            if let Some(tunnel) = handle.try_state::<tunnel::Supervisor>() {
                tunnel.shutdown_blocking();
            }
            if let Some(awake) = handle.try_state::<tunnel::Awake>() {
                awake.shutdown_blocking();
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Com a rede de pé o app não guarda problema nenhum, e o celular aparece.
    #[test]
    fn a_healthy_network_setup_reports_no_problem() {
        let setup = NetworkSetup::ready();
        assert!(setup.is_ready());
        assert_eq!(setup.problem(), None);
    }

    /// Antes, a falha de qualquer peça da rede virava `?` dentro do `setup`, o
    /// Tauri dava `panic` e, em release, o app abria uma janela morta e o
    /// motivo só existia no `app.log`. Agora o motivo vira estado.
    #[test]
    fn a_broken_network_setup_keeps_the_reason_instead_of_killing_the_app() {
        let setup = NetworkSetup::failed("bundle da página do celular não encontrado");
        assert!(!setup.is_ready());
        assert_eq!(
            setup.problem(),
            Some("bundle da página do celular não encontrado")
        );
    }

    /// O padrão nunca pode parecer saudável por acidente.
    #[test]
    fn the_default_setup_is_the_ready_one() {
        assert!(NetworkSetup::default().is_ready());
    }
}
