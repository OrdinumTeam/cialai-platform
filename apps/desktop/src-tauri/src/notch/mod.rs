// SPDX-License-Identifier: Apache-2.0
//! Barra de IA: um painel reto na direita da area de conteudo, com um anel
//! por perfil de agente, mostrando quanto do plano ja foi gasto e se a sessao
//! daquele perfil esta trabalhando, esperando voce ou parada.
//!
//! Ela vive **dentro** da janela do Cialai, como mais um painel da casca. O
//! desenho e o recolhimento acontecem no proprio webview, em `packages/ui`.
//! O Rust responde so pelos dados, e devolve codigos onde a interface precisa
//! de texto, para a traducao ficar num lugar so.
//!
//! Desenho, em uma volta:
//!
//! - **Perfis** em [`profiles`]. E a diferenca deliberada em relacao ao
//!   Codenotch: um anel por pasta de configuracao, identificado pelo perfil,
//!   e nenhum anel neutro chamado so "Codex" ou "Claude".
//! - **Uso** em [`usage`], com uma cadeia de fontes por provedor e a ultima
//!   leitura boa guardada em disco.
//! - **Sessoes** em [`sessions`], lidas dos arquivos que cada agente grava.
//!
//! O que muda entre macOS, Linux e Windows fica em cada modulo: a credencial
//! do Claude Code, o cache do Claude Desktop e o foco de uma sessao fora do
//! estudio. Detalhes e verificacao em `docs/arquitetura/15-barra-de-ia.md`.

pub mod alerts;
pub mod commands;
pub mod prefs;
pub mod profiles;
pub mod sessions;
pub mod usage;

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::prefs::PrefsState;
use alerts::AlertWatcher;
use prefs::NotchPreferences;
use profiles::Profile;
use sessions::{ActivitySummary, AgentSession};
use usage::{ProviderSnapshot, UsageStore};

/// Leituras de uso novas.
pub const EVENT_USAGE: &str = "notch://usage";
/// Sessoes de agente novas.
pub const EVENT_SESSIONS: &str = "notch://sessions";
/// Preferencias trocadas.
pub const EVENT_PREFS: &str = "notch://prefs";
/// Levar o usuario a uma sessao do estudio de terminais.
pub const EVENT_FOCUS_SESSION: &str = "notch://focus-session";
/// Abrir as Preferencias na secao da barra.
pub const EVENT_OPEN_SETTINGS: &str = "notch://open-settings";

/// Ritmo da varredura de sessoes. Custa um `readdir` e alguns `stat`.
const SESSION_TICK: Duration = Duration::from_millis(1000);
/// Ritmo do relogio de leitura de uso. A decisao de reler e da propria loja.
const USAGE_TICK: Duration = Duration::from_secs(10);
/// Perfis sao redescobertos de tempos em tempos, para uma pasta nova aparecer
/// sem reabrir o app.
const PROFILE_TTL: Duration = Duration::from_secs(60);

/* ── o que a pagina recebe ─────────────────────────────────────────── */

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotchState {
    pub prefs: NotchPreferences,
    /// Um por anel, ja filtrado e ordenado.
    pub profiles: Vec<ProviderSnapshot>,
    pub sessions: BTreeMap<String, Vec<AgentSession>>,
    pub activity: BTreeMap<String, ActivitySummary>,
    /// Todos os perfis da maquina, inclusive desligados, para as Preferencias.
    pub all_profiles: Vec<Profile>,
}

/* ── gerenciador ───────────────────────────────────────────────────── */

pub struct NotchManager {
    app: AppHandle,
    home: PathBuf,
    app_support: PathBuf,
    store: Arc<UsageStore>,
    inner: Arc<Mutex<Inner>>,
    running: Arc<AtomicBool>,
}

struct Inner {
    profiles: Vec<Profile>,
    profiles_at: Option<Instant>,
    sessions: BTreeMap<String, Vec<AgentSession>>,
    readers: BTreeMap<String, Arc<sessions::claude::TranscriptReader>>,
    alerts: AlertWatcher,
    /// Sessoes do estudio, para casar um agente com o card dele.
    terminals: Vec<(String, u32)>,
    busy: bool,
}

impl NotchManager {
    pub fn new(app: AppHandle) -> Self {
        let home = app
            .path()
            .home_dir()
            .unwrap_or_else(|_| std::env::temp_dir());
        // A mesma pasta de dados em que `workspace/ai.rs` le o hook.
        let app_support = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir());
        let store = Arc::new(UsageStore::new(&app_support));
        Self {
            app,
            home,
            app_support,
            store,
            inner: Arc::new(Mutex::new(Inner {
                profiles: Vec::new(),
                profiles_at: None,
                sessions: BTreeMap::new(),
                readers: BTreeMap::new(),
                alerts: AlertWatcher::default(),
                terminals: Vec::new(),
                busy: false,
            })),
            running: Arc::new(AtomicBool::new(false)),
        }
    }

    fn preferences(&self) -> NotchPreferences {
        self.app
            .try_state::<PrefsState>()
            .map(|state| state.get().notch)
            .unwrap_or_default()
    }

    /// Perfis da maquina, redescobertos de tempos em tempos.
    pub fn profiles(&self) -> Vec<Profile> {
        if let Ok(guard) = self.inner.lock()
            && guard
                .profiles_at
                .is_some_and(|at| at.elapsed() < PROFILE_TTL)
        {
            return guard.profiles.clone();
        }
        let found = profiles::discover(&self.home);
        if let Ok(mut guard) = self.inner.lock() {
            guard.profiles = found.clone();
            guard.profiles_at = Some(Instant::now());
        }
        found
    }

    /// Perfis que viram anel agora.
    pub fn visible_profiles(&self) -> Vec<Profile> {
        profiles::visible(&self.profiles(), &self.preferences())
    }

    pub fn state(&self) -> NotchState {
        let prefs = self.preferences();
        let all = self.profiles();
        let visible = profiles::visible(&all, &prefs);
        let sessions = self
            .inner
            .lock()
            .map(|guard| guard.sessions.clone())
            .unwrap_or_default();
        let activity = sessions
            .iter()
            .filter_map(|(id, list)| ActivitySummary::of(list).map(|summary| (id.clone(), summary)))
            .collect();
        NotchState {
            profiles: self.store.for_profiles(&visible),
            sessions,
            activity,
            all_profiles: all,
            prefs,
        }
    }

    pub fn emit_prefs(&self) {
        let _ = self.app.emit(EVENT_PREFS, self.preferences());
    }

    /// Le o uso agora, de um perfil ou de todos.
    pub fn refresh(&self, only: Option<&str>) {
        let visible = self.visible_profiles();
        let wanted: Vec<Profile> = match only {
            Some(id) => visible
                .into_iter()
                .filter(|profile| profile.id == id)
                .collect(),
            None => visible,
        };
        if wanted.is_empty() {
            return;
        }
        if let Some(id) = only {
            self.store.forget(id);
        }
        self.store.refresh(&wanted, &self.home, &self.app_support);
        self.publish_usage();
    }

    fn publish_usage(&self) {
        let visible = self.visible_profiles();
        let snapshots = self.store.for_profiles(&visible);
        let _ = self.app.emit(EVENT_USAGE, &snapshots);
        let prefs = self.preferences();
        let alerts = self
            .inner
            .lock()
            .map(|mut guard| guard.alerts.absorb(&snapshots, &prefs))
            .unwrap_or_default();
        for alert in alerts {
            self.notify(&alert);
        }
    }

    /// Manda o aviso ao sistema. A permissao e pedida no primeiro aviso de
    /// verdade, nao na abertura do app.
    fn notify(&self, alert: &alerts::Alert) {
        use tauri_plugin_notification::NotificationExt;
        let _ = self
            .app
            .notification()
            .builder()
            .title(alert.title())
            .body(alert.body())
            .show();
    }

    /// Sessoes do estudio de terminais, para ligar um agente ao card dele.
    fn refresh_terminals(&self) {
        let Some(terminals) = self
            .app
            .try_state::<crate::workspace::terminal::TerminalManager>()
        else {
            return;
        };
        let pairs: Vec<(String, u32)> = terminals
            .list()
            .into_iter()
            .filter(|info| info.alive)
            .filter_map(|info| info.pid.map(|pid| (info.tag, pid)))
            .collect();
        if let Ok(mut guard) = self.inner.lock() {
            guard.terminals = pairs;
        }
    }

    /// Uma varredura de sessoes de todos os perfis ligados.
    fn scan_sessions(&self) {
        let visible = self.visible_profiles();
        let now = usage::now_ms();
        let terminals = self
            .inner
            .lock()
            .map(|guard| guard.terminals.clone())
            .unwrap_or_default();
        // Uma tabela de processos por varredura: no Linux e no Windows cada
        // consulta de pid sairia de um snapshot proprio.
        sessions::refresh_process_table();

        let mut found: BTreeMap<String, Vec<AgentSession>> = BTreeMap::new();
        for profile in &visible {
            let list = match profile.provider {
                profiles::Provider::Claude => {
                    let reader = {
                        let mut guard = match self.inner.lock() {
                            Ok(guard) => guard,
                            Err(_) => continue,
                        };
                        Arc::clone(guard.readers.entry(profile.id.clone()).or_insert_with(|| {
                            Arc::new(sessions::claude::TranscriptReader::default())
                        }))
                    };
                    sessions::claude::scan(&profile.id, &profile.dir(), &reader, &terminals, now)
                }
                profiles::Provider::Codex => {
                    sessions::codex::scan(&profile.id, &profile.dir(), &profile.label, now)
                }
            };
            if !list.is_empty() {
                found.insert(profile.id.clone(), list);
            }
        }

        let busy = found
            .values()
            .flatten()
            .any(|session| session.state == sessions::SessionState::Busy);

        let changed = {
            let Ok(mut guard) = self.inner.lock() else {
                return;
            };
            let changed = guard.sessions != found;
            guard.sessions = found.clone();
            guard.busy = busy;
            changed
        };

        if changed {
            let activity: BTreeMap<String, ActivitySummary> = found
                .iter()
                .filter_map(|(id, list)| {
                    ActivitySummary::of(list).map(|summary| (id.clone(), summary))
                })
                .collect();
            let _ = self.app.emit(
                EVENT_SESSIONS,
                serde_json::json!({ "byProfile": found, "activity": activity }),
            );
        }
    }

    /// Leva o usuario ate a sessao: o card do estudio quando ela roda dentro
    /// do Cialai, senao o app dono do processo, onde a plataforma permite.
    pub fn focus_session(&self, session_id: &str) -> bool {
        let session = {
            let Ok(guard) = self.inner.lock() else {
                return false;
            };
            guard
                .sessions
                .values()
                .flatten()
                .find(|session| session.id == session_id)
                .cloned()
        };
        let Some(session) = session else {
            return false;
        };
        if let Some(tag) = session.pty_tag.clone() {
            let _ = self
                .app
                .emit(EVENT_FOCUS_SESSION, serde_json::json!({ "ptyTag": tag }));
            if let Some(main) = self.app.get_webview_window("main") {
                let _ = main.unminimize();
                let _ = main.show();
                let _ = main.set_focus();
            }
            return true;
        }
        session.pid.is_some_and(sessions::focus::focus)
    }

    /// Sobe os dois relogios: sessoes e uso.
    pub fn start(&self) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }

        let running = Arc::clone(&self.running);
        let manager = self.clone_handles();
        std::thread::spawn(move || {
            while running.load(Ordering::SeqCst) {
                manager.refresh_terminals();
                manager.scan_sessions();
                std::thread::sleep(SESSION_TICK);
            }
        });

        let running = Arc::clone(&self.running);
        let manager = self.clone_handles();
        std::thread::spawn(move || {
            // Uma primeira leitura logo na abertura, para o anel nao passar
            // um minuto mostrando so o que veio do disco.
            manager.refresh(None);
            while running.load(Ordering::SeqCst) {
                std::thread::sleep(USAGE_TICK);
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                let busy = manager
                    .inner
                    .lock()
                    .map(|guard| guard.busy)
                    .unwrap_or(false);
                if manager.store.due(busy) {
                    manager.refresh(None);
                }
            }
        });
    }

    pub fn stop(&self) {
        self.running.store(false, Ordering::SeqCst);
    }

    /// Copia barata para as threads: tudo que importa esta atras de `Arc`.
    fn clone_handles(&self) -> Self {
        Self {
            app: self.app.clone(),
            home: self.home.clone(),
            app_support: self.app_support.clone(),
            store: Arc::clone(&self.store),
            inner: Arc::clone(&self.inner),
            running: Arc::clone(&self.running),
        }
    }
}

/// Sobe a barra junto com o app. Quem desenha e a janela principal; aqui so
/// nasce o gerenciador dos dados.
pub fn setup(app: &AppHandle) -> NotchManager {
    NotchManager::new(app.clone())
}
