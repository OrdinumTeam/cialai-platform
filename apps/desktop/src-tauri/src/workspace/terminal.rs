// SPDX-License-Identifier: Apache-2.0
//! Sessoes de terminal sobre PTY.
//!
//! Cada sessao abre um `/bin/zsh -l` num PTY do `portable-pty` e transmite a
//! saida ao webview por um `Channel` do Tauri em bytes brutos. Tres threads
//! por sessao: a leitora do master, a que espera o processo terminar e a de
//! lote, que junta os chunks por ate 4 ms, respeita a marca d'agua de bytes
//! sem confirmacao e envia o fim da sessao pelo mesmo canal, depois do ultimo
//! lote. Uma quarta thread escreve no PTY para o comando `pty_write` nunca
//! bloquear a thread principal.
//!
//! Controle de fluxo: o webview confirma os bytes consumidos com `pty_ack`.
//! Acima de [`HIGH_WATER`] bytes sem confirmacao a thread de lote para, a fila
//! entre leitora e lote enche, a leitora para de ler e o processo filho
//! bloqueia ao escrever, como num terminal que ninguem le. Isso segura `yes`
//! ou `cat` de arquivo grande sem estourar memoria nem travar a interface.
//!
//! Historico em disco: com [`TerminalManager::with_journal`], a thread de
//! lote tambem acrescenta cada lote ao arquivo da sessao, e uma thread de
//! estado grava a cada 5 s a pasta, o tamanho e o agente em uso, para a
//! sessao voltar depois que o app fecha ou cai. Detalhes em
//! [`super::journal`] e [`super::resume`].

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use portable_pty::{
    ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize, native_pty_system,
};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

use super::journal::{self, JournalStore, JournalWriter, SavedMeta, SavedTerminal};
use super::procs::{self, CommandCache};
use super::resume;
use super::{DEFAULT_SHELL, EVENT_PTY_EXIT};

const READ_BUFFER: usize = 16 * 1024;
const COALESCE_WINDOW: Duration = Duration::from_millis(4);
const MAX_BATCH: usize = 64 * 1024;
const HIGH_WATER: usize = 512 * 1024;
const LOW_WATER: usize = 128 * 1024;
const QUEUE_DEPTH: usize = 32;
const SCROLLBACK_LIMIT: usize = 256 * 1024;
const REMOTE_LAG_GRACE: Duration = Duration::from_secs(3);
/// Tempo entre o SIGHUP e o SIGKILL de um shell que nao encerrou sozinho.
const KILL_GRACE: Duration = Duration::from_millis(400);
/// Shell que sai antes disto provavelmente falhou no .zshrc.
pub const EARLY_EXIT_WINDOW: Duration = Duration::from_millis(1000);
/// Intervalo entre as amostras do estado das sessoes gravado em disco.
const SNAPSHOT_INTERVAL: Duration = Duration::from_secs(5);
/// Variaveis de configuracao do usuario que um agente tambem le, e que por
/// isso ficam mesmo quando o resto do ambiente do agente e descartado.
const AGENT_USER_CONFIG: &[&str] = &[
    "CLAUDE_HOME",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_PROFILE",
    "CODEX_HOME",
];

/// Um agente deixa marcadores de sessao no ambiente dos filhos: `CLAUDECODE`,
/// `CLAUDE_CODE_*`, `CLAUDE_PID`, `CODEX_SANDBOX*` e afins. Um Claude Code
/// aberto com eles se acha sessao filha e desliga o historico; um Codex se
/// acha dentro do sandbox. Nada disso deve chegar aos shells do estudio.
fn is_inherited_agent_marker(name: &str) -> bool {
    if AGENT_USER_CONFIG.contains(&name) {
        return false;
    }
    name == "CLAUDECODE"
        || name == "CLAUDE_PID"
        || name == "CLAUDE_EFFORT"
        || name.starts_with("CLAUDE_CODE_")
        || name.starts_with("CODEX_")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: u32,
    /// Identificador estavel da sessao, dado pelo frontend, para religar a
    /// sessao certa depois de uma recarga do webview.
    pub tag: String,
    pub cwd: String,
    pub shell: String,
    pub pid: Option<u32>,
    pub alive: bool,
    pub exit_code: Option<i32>,
    pub cols: u16,
    pub rows: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view: Option<TerminalView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presentation: Option<TerminalPresentation>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalView {
    pub id: u32,
    pub cols: u16,
    pub rows: u16,
    pub owner: String,
    pub lease_id: u64,
    pub revision: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TerminalPresentation {
    pub name: String,
    pub subtitle: String,
    pub color: Option<String>,
    pub pinned: bool,
    pub order: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub id: u32,
    pub code: i32,
    pub signal: Option<String>,
    /// O shell durou menos que [`EARLY_EXIT_WINDOW`].
    pub early: bool,
}

/// Processo que esta com o terminal em primeiro plano: o lider do grupo de
/// processos que o tty aponta, quando nao e o proprio shell.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundProcess {
    pub pid: u32,
    /// Nome do executavel, como o Monitor de Atividade mostra.
    pub name: String,
    /// Primeiro argumento da linha de comando, sem o caminho.
    pub command: String,
    /// Agente de codigo reconhecido pela linha de comando, se for o caso.
    pub agent: Option<String>,
    /// Parado por sinal, como depois de Ctrl+Z.
    pub stopped: bool,
    /// Diretorio atual do processo, lido do kernel.
    pub cwd: Option<String>,
    /// Pasta de configuracao do agente, como `~/.claude-webrota`, lida do
    /// ambiente do processo; padrao do agente quando nao ha variavel.
    pub config_dir: Option<String>,
    /// Slug do perfil, o mesmo do arquivo de uso publicado pelo hook.
    pub profile: Option<String>,
    /// Nome do perfil dado pelo usuario, como .
    pub profile_name: Option<String>,
}

/// Medicoes reais de uma sessao: CPU e memoria somadas na arvore de
/// processos do shell, processo em primeiro plano e diretorio atual do shell.
/// `available` e falso quando o shell nao existe mais ou o kernel negou a
/// leitura; nesse caso os numeros vem como `None`.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMetrics {
    pub id: u32,
    pub tag: String,
    pub pid: Option<u32>,
    pub available: bool,
    /// Soma do uso de CPU dos processos da arvore desde a amostra anterior.
    /// `None` na primeira amostra, que so fixa a referencia.
    pub cpu_percent: Option<f32>,
    pub memory_bytes: Option<u64>,
    pub processes: u32,
    pub foreground: Option<ForegroundProcess>,
    /// Agente encontrado em qualquer processo da arvore, mesmo fora do
    /// primeiro plano.
    pub agent: Option<String>,
    /// Perfil desse agente, pela mesma regra de [`ForegroundProcess`].
    pub agent_profile: Option<String>,
    pub agent_config_dir: Option<String>,
    pub agent_profile_name: Option<String>,
    pub shell_cwd: Option<String>,
}

enum Message {
    Data(Vec<u8>),
    Exit(Option<ExitStatus>),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum SubscriberKey {
    Webview,
    Remote(u64),
}

struct Subscriber {
    channel: Channel,
    in_flight: usize,
    stalled_since: Option<Instant>,
}

#[derive(Default)]
struct OutputState {
    subscribers: HashMap<SubscriberKey, Subscriber>,
    history: VecDeque<u8>,
    sequence: u64,
}

/// Delivery serializes replay with live output, but callbacks run outside
/// the state mutex: a remote sink may acknowledge synchronously from send.
struct OutputLink {
    state: Mutex<OutputState>,
    delivery: Mutex<()>,
    room: Condvar,
    closed: AtomicBool,
}

impl OutputLink {
    fn new(channel: Channel) -> Self {
        Self::with_subscriber(SubscriberKey::Webview, channel)
    }

    fn with_subscriber(key: SubscriberKey, channel: Channel) -> Self {
        let mut state = OutputState::default();
        state.subscribers.insert(
            key,
            Subscriber {
                channel,
                in_flight: 0,
                stalled_since: None,
            },
        );
        Self {
            state: Mutex::new(state),
            delivery: Mutex::new(()),
            room: Condvar::new(),
            closed: AtomicBool::new(false),
        }
    }

    fn send(&self, body: InvokeResponseBody) {
        let _delivery = lock(&self.delivery);
        let targets = {
            let mut state = lock(&self.state);
            let bytes = if let InvokeResponseBody::Raw(data) = &body {
                state.sequence += data.len() as u64;
                state.history.extend(data);
                let overflow = state.history.len().saturating_sub(SCROLLBACK_LIMIT);
                state.history.drain(..overflow);
                data.len()
            } else {
                0
            };
            state
                .subscribers
                .iter_mut()
                .map(|(&key, subscriber)| {
                    subscriber.in_flight = subscriber.in_flight.saturating_add(bytes);
                    (key, subscriber.channel.clone())
                })
                .collect::<Vec<_>>()
        };
        for (key, channel) in targets {
            if channel.send(body.clone()).is_err() {
                self.detach(key);
            }
        }
    }

    /// Espera haver espaco para mais `bytes`. Devolve false se o canal foi
    /// fechado enquanto esperava.
    fn wait_for_room(&self, _bytes: usize) -> bool {
        loop {
            let mut state = lock(&self.state);
            if self.closed.load(Ordering::SeqCst) {
                return false;
            }
            let mut blocked = false;
            let mut expired = Vec::new();
            let mut wait = REMOTE_LAG_GRACE;
            for (&key, subscriber) in &mut state.subscribers {
                if subscriber.in_flight <= HIGH_WATER {
                    subscriber.stalled_since = None;
                    continue;
                }
                match key {
                    SubscriberKey::Webview => blocked = true,
                    SubscriberKey::Remote(_) => {
                        let elapsed = subscriber
                            .stalled_since
                            .get_or_insert_with(Instant::now)
                            .elapsed();
                        if elapsed >= REMOTE_LAG_GRACE {
                            expired.push(key);
                        } else {
                            blocked = true;
                            wait = wait.min(REMOTE_LAG_GRACE - elapsed);
                        }
                    }
                }
            }
            if !expired.is_empty() {
                let channels: Vec<_> = expired
                    .into_iter()
                    .filter_map(|key| state.subscribers.remove(&key))
                    .collect();
                drop(state);
                for subscriber in channels {
                    let _ = subscriber.channel.send(InvokeResponseBody::Json(
                        r#"{"type":"detached","reason":"lagged"}"#.into(),
                    ));
                    eprintln!("Ponte iPhone: assinante remoto desligado por atraso.");
                }
                continue;
            }
            if !blocked {
                return true;
            }
            drop(
                self.room
                    .wait_timeout(state, wait)
                    .unwrap_or_else(|poisoned| poisoned.into_inner()),
            );
        }
    }

    fn ack(&self, bytes: usize) {
        self.ack_for(SubscriberKey::Webview, bytes);
    }

    fn ack_for(&self, key: SubscriberKey, bytes: usize) {
        if let Some(subscriber) = lock(&self.state).subscribers.get_mut(&key) {
            subscriber.in_flight = subscriber.in_flight.saturating_sub(bytes);
            if subscriber.in_flight <= LOW_WATER {
                subscriber.stalled_since = None;
                self.room.notify_all();
            }
        }
    }

    /// Troca o canal depois de uma recarga do webview e zera a contagem, ja
    /// que o consumidor antigo nunca mais vai confirmar nada.
    fn reset(&self, channel: Channel) -> bool {
        self.attach(SubscriberKey::Webview, channel)
    }

    fn attach(&self, key: SubscriberKey, channel: Channel) -> bool {
        let _delivery = lock(&self.delivery);
        if self.closed.load(Ordering::SeqCst) {
            return false;
        }
        let (offset, bytes) = {
            let mut state = lock(&self.state);
            let bytes: Vec<u8> = state.history.iter().copied().collect();
            let offset = state.sequence - bytes.len() as u64;
            state.subscribers.insert(
                key,
                Subscriber {
                    channel: channel.clone(),
                    in_flight: bytes.len(),
                    stalled_since: None,
                },
            );
            (offset, bytes)
        };
        let marker = serde_json::json!({"type":"replay", "offset":offset, "length":bytes.len()});
        if channel
            .send(InvokeResponseBody::Json(marker.to_string()))
            .is_err()
            || (!bytes.is_empty() && channel.send(InvokeResponseBody::Raw(bytes)).is_err())
        {
            self.detach(key);
        }
        self.room.notify_all();
        true
    }

    fn detach(&self, key: SubscriberKey) {
        lock(&self.state).subscribers.remove(&key);
        self.room.notify_all();
    }

    /// Libera a thread de lote sem fechar o canal. Usado ao matar a sessao,
    /// para o fim chegar ao webview mesmo se ele parou de confirmar.
    fn drain(&self) {
        for subscriber in lock(&self.state).subscribers.values_mut() {
            subscriber.in_flight = 0;
            subscriber.stalled_since = None;
        }
        self.room.notify_all();
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.room.notify_all();
    }
}

struct Session {
    info: TerminalInfo,
    master: Box<dyn MasterPty + Send>,
    writer: SyncSender<Vec<u8>>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    link: Arc<OutputLink>,
    spawned_at: Instant,
    view_owner: SubscriberKey,
    view_deadline: Option<Instant>,
    local_size: Option<(u16, u16)>,
}

const VIEW_LEASE: Duration = Duration::from_secs(15);
type ViewNotifier = Arc<dyn Fn(TerminalView) + Send + Sync>;

impl Session {
    fn subscribed(&self, key: SubscriberKey) -> bool {
        key == SubscriberKey::Webview
            || (!self.link.closed.load(Ordering::SeqCst)
                && lock(&self.link.state).subscribers.contains_key(&key))
    }

    fn apply_view(
        &mut self,
        key: SubscriberKey,
        cols: u16,
        rows: u16,
        claim: bool,
    ) -> Result<TerminalView, String> {
        self.master
            .resize(PtySize {
                cols,
                rows,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|_| "Falha ao redimensionar o terminal.".to_string())?;
        let previous = self.info.view.as_ref();
        let view = TerminalView {
            id: self.info.id,
            cols,
            rows,
            owner: if key == SubscriberKey::Webview {
                "local"
            } else {
                "remote"
            }
            .into(),
            lease_id: previous.map_or(1, |v| v.lease_id + u64::from(claim)),
            revision: previous.map_or(1, |v| v.revision + 1),
        };
        self.info.cols = cols;
        self.info.rows = rows;
        self.info.view = Some(view.clone());
        self.view_owner = key;
        self.view_deadline = (key != SubscriberKey::Webview).then(|| Instant::now() + VIEW_LEASE);
        Ok(view)
    }

    fn restore_local(&mut self) -> Result<TerminalView, String> {
        let (cols, rows) = self.local_size.unwrap_or((self.info.cols, self.info.rows));
        self.apply_view(SubscriberKey::Webview, cols, rows, true)
    }

    fn lease_matches(&self, key: SubscriberKey, lease: u64) -> bool {
        self.view_owner == key
            && self.info.view.as_ref().is_some_and(|v| v.lease_id == lease)
            && self
                .view_deadline
                .is_none_or(|deadline| deadline > Instant::now())
            && self.subscribed(key)
    }
}

struct Inner {
    next_id: u32,
    sessions: HashMap<u32, Session>,
}

/// Quem recebe o fim de cada sessao. No app e o `emit` do Tauri; nos testes,
/// um coletor, o que dispensa um runtime simulado.
type ExitNotifier = Arc<dyn Fn(TerminalExit) + Send + Sync>;

#[derive(Clone)]
pub struct TerminalManager {
    inner: Arc<Mutex<Inner>>,
    notify_exit: ExitNotifier,
    notify_view: ViewNotifier,
    /// Ultimo tempo de CPU por pid, para a proxima amostra virar percentual.
    samples: Arc<Mutex<HashMap<u32, (u64, Instant)>>>,
    commands: Arc<Mutex<CommandCache>>,
    /// Historico e estado em disco. `None` nos testes que nao pedem.
    journal: Option<Arc<JournalStore>>,
    /// O app esta saindo: o fim dos shells nao apaga a conversa do agente
    /// guardada para a retomada.
    closing: Arc<AtomicBool>,
}

impl TerminalManager {
    pub fn new(app: AppHandle) -> Self {
        let view_app = app.clone();
        let journal_dir = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("terminals"));
        let manager = Self::with_notifiers(
            Arc::new(move |exit| {
                let _ = app.emit(EVENT_PTY_EXIT, exit);
            }),
            Arc::new(move |view| {
                let _ = view_app.emit("pty://view", view);
            }),
        );
        match journal_dir {
            Some(dir) => manager.with_journal(dir),
            None => manager,
        }
    }

    #[cfg(test)]
    pub(crate) fn with_notifier(notify_exit: ExitNotifier) -> Self {
        Self::with_notifiers(notify_exit, Arc::new(|_| {}))
    }

    fn with_notifiers(notify_exit: ExitNotifier, notify_view: ViewNotifier) -> Self {
        let manager = Self {
            inner: Arc::new(Mutex::new(Inner {
                next_id: 0,
                sessions: HashMap::new(),
            })),
            notify_exit,
            notify_view: notify_view.clone(),
            samples: Arc::new(Mutex::new(HashMap::new())),
            commands: Arc::new(Mutex::new(CommandCache::default())),
            journal: None,
            closing: Arc::new(AtomicBool::new(false)),
        };
        // Weak ownership prevents this watchdog from keeping a manager alive.
        let weak = Arc::downgrade(&manager.inner);
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_millis(250));
                let Some(inner) = weak.upgrade() else {
                    break;
                };
                let changes: Vec<_> = lock(&inner)
                    .sessions
                    .values_mut()
                    .filter_map(|session| {
                        let expired = session
                            .view_deadline
                            .is_some_and(|deadline| deadline <= Instant::now());
                        let detached = session.view_owner != SubscriberKey::Webview
                            && !session.subscribed(session.view_owner);
                        if expired || detached {
                            session.restore_local().ok()
                        } else {
                            None
                        }
                    })
                    .collect();
                for view in changes {
                    notify_view(view);
                }
            }
        });
        manager
    }

    /// Liga o historico em disco e a thread que grava o estado de cada sessao
    /// a cada [`SNAPSHOT_INTERVAL`], com o agente e a conversa em uso.
    pub(crate) fn with_journal(mut self, dir: PathBuf) -> Self {
        let store = Arc::new(JournalStore::new(dir));
        self.journal = Some(store.clone());
        let weak = Arc::downgrade(&self.inner);
        let commands = self.commands.clone();
        let _ = thread::Builder::new()
            .name("terminais-estado".into())
            .spawn(move || {
                loop {
                    thread::sleep(SNAPSHOT_INTERVAL);
                    let Some(inner) = weak.upgrade() else {
                        break;
                    };
                    snapshot(&inner, &store, &commands);
                }
            });
        self
    }

    pub fn spawn(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        tag: &str,
        channel: Channel,
    ) -> Result<TerminalInfo, String> {
        self.spawn_with_args(cwd, cols, rows, tag, channel, &["-l"])
    }

    pub(crate) fn spawn_with_args(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        tag: &str,
        channel: Channel,
        args: &[&str],
    ) -> Result<TerminalInfo, String> {
        self.spawn_for_with_args(cwd, cols, rows, tag, SubscriberKey::Webview, channel, args)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn_for(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        tag: &str,
        key: SubscriberKey,
        channel: Channel,
    ) -> Result<TerminalInfo, String> {
        self.spawn_for_with_args(cwd, cols, rows, tag, key, channel, &["-l"])
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_for_with_args(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        tag: &str,
        key: SubscriberKey,
        channel: Channel,
        args: &[&str],
    ) -> Result<TerminalInfo, String> {
        let dir = Path::new(cwd);
        if !dir.is_dir() {
            return Err(format!("Pasta não encontrada: {cwd}"));
        }
        let cols = cols.max(2);
        let rows = rows.max(1);

        let pair = native_pty_system()
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Não foi possível abrir o PTY: {error}"))?;

        let mut command = CommandBuilder::new(DEFAULT_SHELL);
        // Login shell: le o .zprofile e herda o PATH do usuario, com Homebrew,
        // Node e Python, mesmo quando o app foi aberto pelo Dock.
        for arg in args {
            command.arg(arg);
        }
        command.cwd(dir);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Cialai");
        command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        command.env("PATH", prefixed_path());
        // O app pode ter sido aberto de dentro de um agente, e ai o ambiente
        // traz marcadores de sessao filha que fariam um Claude Code novo
        // desligar o historico. Os shells nascem sem isso.
        for (name, _) in std::env::vars_os()
            .filter_map(|(name, value)| name.into_string().ok().map(|name| (name, value)))
        {
            if is_inherited_agent_marker(&name) {
                command.env_remove(&name);
            }
        }
        if needs_lang() {
            // App aberto pelo Dock chega sem LANG e o zsh cai em C, o que
            // quebra acentos. O Terminal do macOS faz o mesmo ajuste.
            command.env("LANG", "pt_BR.UTF-8");
        }

        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Não foi possível iniciar o zsh: {error}"))?;
        // Sem soltar o slave aqui a leitora nunca ve EOF quando o shell sai.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| error.to_string())?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|error| error.to_string())?;
        let killer = child.clone_killer();
        let pid = child.process_id();

        let id = {
            let mut guard = self.lock();
            guard.next_id += 1;
            guard.next_id
        };
        let info = TerminalInfo {
            id,
            tag: tag.to_string(),
            cwd: cwd.to_string(),
            shell: DEFAULT_SHELL.to_string(),
            pid,
            alive: true,
            exit_code: None,
            cols,
            rows,
            view: Some(TerminalView {
                id,
                cols,
                rows,
                owner: "local".into(),
                lease_id: 1,
                revision: 1,
            }),
            presentation: None,
        };
        let link = Arc::new(match key {
            SubscriberKey::Webview => OutputLink::new(channel),
            _ => OutputLink::with_subscriber(key, channel),
        });
        let journal = self.journal.as_ref().and_then(|store| store.writer(tag));

        let (tx, rx) = mpsc::sync_channel::<Message>(QUEUE_DEPTH);
        let tx_exit = tx.clone();
        thread::spawn(move || {
            let mut buffer = [0u8; READ_BUFFER];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        if tx.send(Message::Data(buffer[..read].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        thread::spawn(move || {
            let status = child.wait().ok();
            let _ = tx_exit.send(Message::Exit(status));
        });

        let (write_tx, write_rx) = mpsc::sync_channel::<Vec<u8>>(QUEUE_DEPTH);
        thread::spawn(move || {
            for bytes in write_rx {
                if writer.write_all(&bytes).is_err() {
                    break;
                }
                let _ = writer.flush();
            }
        });

        let manager = self.clone();
        let pump_link = link.clone();
        self.lock().sessions.insert(
            id,
            Session {
                info: info.clone(),
                master: pair.master,
                writer: write_tx,
                killer,
                link,
                spawned_at: Instant::now(),
                view_owner: SubscriberKey::Webview,
                view_deadline: None,
                local_size: (key == SubscriberKey::Webview).then_some((cols, rows)),
            },
        );
        if let Some(store) = &self.journal {
            store.write_meta(&SavedMeta::sample(tag, cwd, cols, rows, None), || true);
        }
        // Publish the session before the pump can observe a fast child exit.
        thread::spawn(move || manager.pump(id, rx, pump_link, journal));
        Ok(info)
    }

    pub fn write(&self, id: u32, bytes: &[u8]) -> Result<(), String> {
        let writer = {
            let guard = self.lock();
            let session = guard.sessions.get(&id).ok_or_else(closed_error)?;
            session.writer.clone()
        };
        writer
            .try_send(bytes.to_vec())
            .map_err(|error| match error {
                mpsc::TrySendError::Full(_) => {
                    "Terminal ocupado. Aguarde antes de enviar mais texto.".to_string()
                }
                mpsc::TrySendError::Disconnected(_) => "Sessão encerrada".to_string(),
            })
    }

    pub fn resize(&self, id: u32, cols: u16, rows: u16) -> Result<(), String> {
        let mut guard = self.lock();
        let session = guard.sessions.get_mut(&id).ok_or_else(closed_error)?;
        let cols = cols.clamp(2, 500);
        let rows = rows.clamp(1, 300);
        session.local_size = Some((cols, rows));
        if session.view_owner != SubscriberKey::Webview {
            return Ok(());
        }
        if (session.info.cols, session.info.rows) == (cols, rows) {
            return Ok(());
        }
        let view = session.apply_view(SubscriberKey::Webview, cols, rows, false)?;
        drop(guard);
        (self.notify_view)(view);
        Ok(())
    }

    pub fn view_claim(
        &self,
        id: u32,
        key: SubscriberKey,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalView, String> {
        validate_view_size(cols, rows)?;
        let mut guard = self.lock();
        let session = guard.sessions.get_mut(&id).ok_or_else(closed_error)?;
        if !session.subscribed(key) {
            return Err("Assine a sessão antes de assumir o controle.".into());
        }
        let view = session.apply_view(key, cols, rows, true)?;
        if key == SubscriberKey::Webview {
            session.local_size = Some((cols, rows));
        }
        drop(guard);
        (self.notify_view)(view.clone());
        Ok(view)
    }

    pub fn view_renew(
        &self,
        id: u32,
        key: SubscriberKey,
        lease: u64,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalView, String> {
        validate_view_size(cols, rows)?;
        let mut guard = self.lock();
        let session = guard.sessions.get_mut(&id).ok_or_else(closed_error)?;
        if !session.lease_matches(key, lease) {
            return Err("Controle do terminal expirou ou mudou.".into());
        }
        let view = session.apply_view(key, cols, rows, false)?;
        if key == SubscriberKey::Webview {
            session.local_size = Some((cols, rows));
        }
        drop(guard);
        (self.notify_view)(view.clone());
        Ok(view)
    }

    pub fn view_release(
        &self,
        id: u32,
        key: SubscriberKey,
        lease: u64,
    ) -> Result<TerminalView, String> {
        let mut guard = self.lock();
        let session = guard.sessions.get_mut(&id).ok_or_else(closed_error)?;
        if !session.lease_matches(key, lease) {
            return Err("Controle do terminal expirou ou mudou.".into());
        }
        let view = session.restore_local()?;
        drop(guard);
        (self.notify_view)(view.clone());
        Ok(view)
    }

    pub fn presentation(&self, id: u32, presentation: TerminalPresentation) -> Result<(), String> {
        if presentation.name.chars().count() > 120
            || presentation.subtitle.chars().count() > 240
            || presentation
                .color
                .as_ref()
                .is_some_and(|color| color.len() > 32)
            || presentation.order > 100_000
            || presentation
                .name
                .chars()
                .chain(presentation.subtitle.chars())
                .any(char::is_control)
            || presentation.color.as_ref().is_some_and(|color| {
                !color
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '#' || c == '-')
            })
        {
            return Err("Apresentação do terminal inválida.".into());
        }
        self.lock()
            .sessions
            .get_mut(&id)
            .ok_or_else(closed_error)?
            .info
            .presentation = Some(presentation);
        Ok(())
    }

    pub fn subscribed_cwd(&self, id: u32, key: SubscriberKey) -> Result<String, String> {
        let guard = self.lock();
        let session = guard.sessions.get(&id).ok_or_else(closed_error)?;
        if !session.subscribed(key) {
            return Err("Assine a sessão para consultar seus arquivos.".into());
        }
        Ok(session.info.cwd.clone())
    }

    pub fn ack(&self, id: u32, bytes: usize) -> Result<(), String> {
        let link = {
            let guard = self.lock();
            guard
                .sessions
                .get(&id)
                .ok_or_else(closed_error)?
                .link
                .clone()
        };
        link.ack(bytes);
        Ok(())
    }

    /// Reencaminha a saida para um canal novo, depois de uma recarga do
    /// webview em desenvolvimento.
    pub fn attach(&self, id: u32, channel: Channel) -> Result<TerminalInfo, String> {
        let (link, info) = self.output(id)?;
        if !link.reset(channel) {
            return Err(closed_error());
        }
        Ok(info)
    }

    fn output(&self, id: u32) -> Result<(Arc<OutputLink>, TerminalInfo), String> {
        let guard = self.lock();
        let session = guard.sessions.get(&id).ok_or_else(closed_error)?;
        Ok((session.link.clone(), session.info.clone()))
    }

    pub fn ack_for(&self, id: u32, key: SubscriberKey, bytes: usize) -> Result<(), String> {
        self.output(id)?.0.ack_for(key, bytes);
        Ok(())
    }

    pub fn attach_for(
        &self,
        id: u32,
        key: SubscriberKey,
        channel: Channel,
    ) -> Result<TerminalInfo, String> {
        let (link, info) = self.output(id)?;
        if !link.attach(key, channel) {
            return Err(closed_error());
        }
        Ok(info)
    }

    pub fn detach(&self, id: u32, key: SubscriberKey) -> Result<(), String> {
        self.output(id)?.0.detach(key);
        self.release_disconnected(key);
        Ok(())
    }

    /// Query a live subscription without nesting the manager and output
    /// locks. Bridge channel accounting also uses this after lag eviction.
    pub fn has_subscriber(&self, id: u32, key: SubscriberKey) -> bool {
        let Ok((link, _)) = self.output(id) else {
            return false;
        };
        let state = lock(&link.state);
        !link.closed.load(Ordering::SeqCst) && state.subscribers.contains_key(&key)
    }

    pub fn detach_all(&self, key: SubscriberKey) {
        let links: Vec<_> = self
            .lock()
            .sessions
            .values()
            .map(|session| session.link.clone())
            .collect();
        for link in links {
            link.detach(key);
        }
        self.release_disconnected(key);
    }

    fn release_disconnected(&self, key: SubscriberKey) {
        let changes: Vec<_> = self
            .lock()
            .sessions
            .values_mut()
            .filter_map(|session| {
                if session.view_owner == key && !session.subscribed(key) {
                    session.restore_local().ok()
                } else {
                    None
                }
            })
            .collect();
        for view in changes {
            (self.notify_view)(view);
        }
    }

    /// SIGHUP no shell, que repassa aos jobs. Se em 400 ms a sessao ainda
    /// existe, SIGKILL. O fim chega ao webview pela thread de lote.
    pub fn kill(&self, id: u32) -> Result<(), String> {
        let (mut killer, pid) = {
            let guard = self.lock();
            let session = guard.sessions.get(&id).ok_or_else(closed_error)?;
            session.link.drain();
            (session.killer.clone_killer(), session.info.pid)
        };
        let _ = killer.kill();
        let manager = self.clone();
        thread::spawn(move || {
            thread::sleep(KILL_GRACE);
            if manager.lock().sessions.contains_key(&id) {
                force_kill(pid);
            }
        });
        Ok(())
    }

    /// Encerra todas as sessoes ao sair do app. Bloqueia por no maximo a
    /// graca de encerramento, para nao segurar a saida.
    pub fn kill_all_blocking(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let targets: Vec<(u32, Box<dyn ChildKiller + Send + Sync>, Option<u32>)> = {
            let guard = self.lock();
            guard
                .sessions
                .values()
                .map(|session| {
                    session.link.drain();
                    (
                        session.info.id,
                        session.killer.clone_killer(),
                        session.info.pid,
                    )
                })
                .collect()
        };
        if targets.is_empty() {
            return;
        }
        for (_, mut killer, _) in targets
            .iter()
            .map(|(id, killer, pid)| (*id, killer.clone_killer(), *pid))
        {
            let _ = killer.kill();
        }
        thread::sleep(KILL_GRACE);
        let mut guard = self.lock();
        for (id, _, pid) in targets {
            if guard.sessions.remove(&id).is_some() {
                force_kill(pid);
            }
        }
    }

    pub fn list(&self) -> Vec<TerminalInfo> {
        let guard = self.lock();
        let mut sessions: Vec<TerminalInfo> = guard
            .sessions
            .values()
            .map(|session| session.info.clone())
            .collect();
        sessions.sort_by_key(|info| info.id);
        sessions
    }

    /// Sessoes com PTY vivo, para a saida do app pedir confirmacao.
    pub fn live_count(&self) -> usize {
        self.lock().sessions.len()
    }

    /// Estado guardado de uma sessao, com o comando de retomada do agente.
    pub fn saved(&self, tag: &str) -> Option<SavedTerminal> {
        self.journal.as_ref()?.saved(tag)
    }

    /// Historico gravado da sessao, vazio quando nao ha.
    pub fn saved_history(&self, tag: &str) -> Vec<u8> {
        self.journal
            .as_ref()
            .map(|store| store.history(tag))
            .unwrap_or_default()
    }

    /// A sessao foi encerrada de proposito: historico e estado saem do disco.
    pub fn forget(&self, tag: &str) {
        if let Some(store) = &self.journal {
            store.forget(tag);
        }
    }

    /// Apaga o que ficou de sessoes fora de `keep` e sem PTY vivo.
    pub fn prune(&self, keep: &[String]) {
        let Some(store) = &self.journal else { return };
        let mut tags: HashSet<String> = keep.iter().cloned().collect();
        tags.extend(
            self.lock()
                .sessions
                .values()
                .map(|session| session.info.tag.clone()),
        );
        store.prune(&tags);
    }

    /// Amostra CPU, memoria, primeiro plano e diretorio de cada sessao viva.
    /// As chamadas ao kernel ficam fora do lock das sessoes.
    pub fn metrics(&self) -> Vec<SessionMetrics> {
        let targets: Vec<(u32, String, Option<u32>, Option<u32>)> = {
            let guard = self.lock();
            guard
                .sessions
                .values()
                .map(|session| {
                    let foreground = session
                        .master
                        .process_group_leader()
                        .filter(|pgid| *pgid > 0)
                        .map(|pgid| pgid as u32);
                    (
                        session.info.id,
                        session.info.tag.clone(),
                        session.info.pid,
                        foreground,
                    )
                })
                .collect()
        };
        let now = Instant::now();
        let home = user_home();
        let mut samples = lock(&self.samples);
        let mut commands = lock(&self.commands);
        let mut alive = Vec::new();
        let mut result = Vec::new();
        for (id, tag, pid, foreground_pgid) in targets {
            let Some(pid) = pid else {
                result.push(SessionMetrics {
                    id,
                    tag,
                    pid: None,
                    available: false,
                    cpu_percent: None,
                    memory_bytes: None,
                    processes: 0,
                    foreground: None,
                    agent: None,
                    agent_profile: None,
                    agent_config_dir: None,
                    agent_profile_name: None,
                    shell_cwd: None,
                });
                continue;
            };
            let mut tree = vec![pid];
            tree.extend(procs::descendants(pid));
            alive.extend_from_slice(&tree);

            let mut cpu = 0f64;
            let mut cpu_known = false;
            let mut memory = 0u64;
            let mut memory_known = false;
            for &member in &tree {
                let Some(usage) = procs::usage(member) else {
                    continue;
                };
                memory = memory.saturating_add(usage.footprint);
                memory_known = true;
                if let Some((previous, at)) = samples.get(&member) {
                    let wall = now.duration_since(*at).as_nanos() as f64;
                    if wall > 0.0 {
                        cpu += usage.cpu_nanos.saturating_sub(*previous) as f64 / wall * 100.0;
                        cpu_known = true;
                    }
                }
                samples.insert(member, (usage.cpu_nanos, now));
            }

            let mut agent = None;
            let mut agent_profile = None;
            for &member in &tree {
                let Some(info) = procs::bsd_info(member) else {
                    continue;
                };
                let Some(command) = commands.get(member, info.start_sec) else {
                    continue;
                };
                if let Some(found) = procs::agent_of(&command) {
                    agent = Some(found.to_string());
                    agent_profile = procs::agent_profile(&command, found, &home);
                    break;
                }
            }
            let foreground = foreground_pgid
                .filter(|pgid| *pgid != pid)
                .and_then(|pgid| describe_foreground(pgid, &tree, &mut commands, &home));

            result.push(SessionMetrics {
                id,
                tag,
                pid: Some(pid),
                available: memory_known,
                cpu_percent: cpu_known.then_some(cpu as f32),
                memory_bytes: memory_known.then_some(memory),
                processes: tree.len() as u32,
                foreground,
                agent,
                agent_profile: agent_profile.as_ref().map(|profile| profile.slug.clone()),
                agent_config_dir: agent_profile
                    .as_ref()
                    .map(|profile| profile.config_dir.clone()),
                agent_profile_name: agent_profile
                    .as_ref()
                    .and_then(|profile| profile.name.clone()),
                shell_cwd: procs::cwd(pid),
            });
        }
        samples.retain(|member, _| alive.contains(member));
        commands.retain(&alive);
        result.sort_by_key(|metrics| metrics.id);
        result
    }

    fn pump(
        &self,
        id: u32,
        rx: Receiver<Message>,
        link: Arc<OutputLink>,
        mut journal: Option<JournalWriter>,
    ) {
        while let Ok(first) = rx.recv() {
            let mut exit: Option<Option<ExitStatus>> = None;
            let mut batch = Vec::new();
            match first {
                Message::Data(data) => batch = data,
                Message::Exit(status) => exit = Some(status),
            }
            if exit.is_none() {
                let deadline = Instant::now() + COALESCE_WINDOW;
                while batch.len() < MAX_BATCH {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    match rx.recv_timeout(remaining) {
                        Ok(Message::Data(more)) => batch.extend_from_slice(&more),
                        Ok(Message::Exit(status)) => {
                            exit = Some(status);
                            break;
                        }
                        Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {
                            break;
                        }
                    }
                }
            }
            if !batch.is_empty() {
                if !link.wait_for_room(batch.len()) {
                    break;
                }
                if let Some(journal) = journal.as_mut() {
                    journal.append(&batch);
                }
                link.send(InvokeResponseBody::Raw(batch));
            }
            if let Some(status) = exit {
                let (code, signal) = match status {
                    Some(status) => (
                        status.exit_code() as i32,
                        status.signal().map(str::to_string),
                    ),
                    None => (-1, None),
                };
                let early = self.finish(id, code, signal.clone());
                let payload = serde_json::json!({
                    "type": "exit",
                    "code": code,
                    "signal": signal,
                    "early": early,
                });
                link.send(InvokeResponseBody::Json(payload.to_string()));
                break;
            }
        }
    }

    /// Remove a sessao e avisa o app. Devolve se o shell saiu cedo demais.
    fn finish(&self, id: u32, code: i32, signal: Option<String>) -> bool {
        let removed = self.lock().sessions.remove(&id);
        let early = removed
            .as_ref()
            .map(|session| session.spawned_at.elapsed() < EARLY_EXIT_WINDOW)
            .unwrap_or(false);
        if let Some(session) = removed {
            session.link.close();
            // Shell encerrado com o app aberto: nao ha mais agente para
            // retomar. Na saida do app a conversa fica guardada.
            if let Some(store) = self
                .journal
                .as_ref()
                .filter(|_| !self.closing.load(Ordering::SeqCst))
            {
                let (cols, rows) = session
                    .local_size
                    .unwrap_or((session.info.cols, session.info.rows));
                store.write_meta(
                    &SavedMeta::sample(&session.info.tag, &session.info.cwd, cols, rows, None),
                    || true,
                );
            }
        }
        (self.notify_exit)(TerminalExit {
            id,
            code,
            signal,
            early,
        });
        early
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        lock(&self.inner)
    }
}

/// Grava pasta, tamanho e agente de cada sessao viva. As leituras do kernel
/// ficam fora do lock das sessoes, e a escrita confere de novo que a sessao
/// continua a mesma, para uma amostra atrasada nao desfazer o fim dela.
fn snapshot(inner: &Mutex<Inner>, store: &JournalStore, commands: &Mutex<CommandCache>) {
    let targets = lock(inner)
        .sessions
        .values()
        .filter(|session| journal::valid_tag(&session.info.tag))
        .map(|session| {
            let (cols, rows) = session
                .local_size
                .unwrap_or((session.info.cols, session.info.rows));
            (
                session.info.id,
                session.info.tag.clone(),
                session.info.cwd.clone(),
                cols,
                rows,
                session.info.pid,
            )
        })
        .collect::<Vec<_>>();
    let home = user_home();
    for (id, tag, cwd, cols, rows, pid) in targets {
        let agent = pid.and_then(|pid| {
            let mut tree = vec![pid];
            tree.extend(procs::descendants(pid));
            resume::detect(pid, &tree, &mut lock(commands), &home)
        });
        store.write_meta(&SavedMeta::sample(&tag, &cwd, cols, rows, agent), || {
            lock(inner)
                .sessions
                .get(&id)
                .is_some_and(|session| session.info.pid == pid)
        });
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn closed_error() -> String {
    "Sessão encerrada".to_string()
}

/// Pasta do usuario, para resolver o perfil padrao dos agentes.
fn user_home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// Descreve o lider do grupo em primeiro plano. Se o lider ja saiu, vale o
/// primeiro processo da arvore que ainda esta nesse grupo.
fn describe_foreground(
    pgid: u32,
    tree: &[u32],
    commands: &mut CommandCache,
    home: &Path,
) -> Option<ForegroundProcess> {
    let candidate = if tree.contains(&pgid) {
        Some(pgid)
    } else {
        tree.iter().copied().find(|member| {
            procs::bsd_info(*member)
                .map(|info| info.pgid == pgid)
                .unwrap_or(false)
        })
    }?;
    let info = procs::bsd_info(candidate)?;
    if info.status == libc::SZOMB {
        return None;
    }
    let command = commands.get(candidate, info.start_sec);
    let agent = command
        .as_ref()
        .and_then(procs::agent_of)
        .map(str::to_string);
    let profile = match (command.as_ref(), agent.as_deref()) {
        (Some(line), Some(found)) => procs::agent_profile(line, found, home),
        _ => None,
    };
    let name = procs::name(candidate).unwrap_or_else(|| info.comm.clone());
    let argv0 = command
        .as_ref()
        .and_then(|line| line.argv.first().cloned())
        .map(|value| procs::basename(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| name.clone());
    Some(ForegroundProcess {
        pid: candidate,
        name,
        command: argv0,
        agent,
        stopped: info.status == libc::SSTOP,
        cwd: procs::cwd(candidate),
        config_dir: profile.as_ref().map(|value| value.config_dir.clone()),
        profile: profile.as_ref().map(|value| value.slug.clone()),
        profile_name: profile.as_ref().and_then(|value| value.name.clone()),
    })
}

fn force_kill(pid: Option<u32>) {
    if let Some(pid) = pid {
        // SAFETY: kill(2) com um pid que este processo criou; o pior caso e o
        // pid ja ter sido reaproveitado, e o erro e ignorado.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

/// PATH com o Homebrew na frente para apps iniciados pelo Dock.
fn prefixed_path() -> String {
    format!(
        "/opt/homebrew/bin:/usr/local/bin:{}",
        std::env::var("PATH").unwrap_or_default()
    )
}

fn needs_lang() -> bool {
    match std::env::var("LANG") {
        Ok(value) => value.is_empty() || value == "C" || value == "POSIX",
        Err(_) => true,
    }
}

fn validate_view_size(cols: u16, rows: u16) -> Result<(), String> {
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err("Dimensões do terminal fora do limite.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_presentation_accepts_default_color_and_rejects_wrong_types() {
        let value = serde_json::json!({"name":"Codex", "subtitle":"Projeto", "color":null, "pinned":true, "order":3});
        assert!(serde_json::from_value::<TerminalPresentation>(value.clone()).is_ok());
        for (field, wrong) in [
            ("name", serde_json::json!(4)),
            ("pinned", serde_json::json!("true")),
            ("order", serde_json::json!(-1)),
            ("color", serde_json::json!([])),
        ] {
            let mut malformed = value.clone();
            malformed[field] = wrong;
            assert!(serde_json::from_value::<TerminalPresentation>(malformed).is_err());
        }
        let mut extra = value;
        extra["owner"] = serde_json::json!("remote");
        assert!(serde_json::from_value::<TerminalPresentation>(extra).is_err());
    }

    #[test]
    fn mobile_view_serializes_passive_resizes_and_remote_renewals() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        struct Cleanup(TerminalManager);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.kill_all_blocking();
            }
        }
        let _cleanup = Cleanup(manager.clone());
        let id = manager
            .spawn_with_args(
                "/tmp",
                80,
                24,
                "resize-isolated",
                Channel::new(|_| Ok(())),
                &["-f"],
            )
            .unwrap()
            .id;
        let key = SubscriberKey::Remote(8);
        assert!(manager.subscribed_cwd(id, key).is_err());
        manager
            .attach_for(id, key, Channel::new(|_| Ok(())))
            .unwrap();
        assert_eq!(manager.subscribed_cwd(id, key).unwrap(), "/tmp");
        let view = manager.view_claim(id, key, 40, 20).unwrap();
        let local = manager.clone();
        let resize = thread::spawn(move || {
            for _ in 0..100 {
                local.resize(id, 150, 40).unwrap();
            }
        });
        for _ in 0..100 {
            manager.view_renew(id, key, view.lease_id, 45, 21).unwrap();
        }
        resize.join().unwrap();
        let remote = manager.list()[0].view.clone().unwrap();
        assert_eq!(
            (remote.cols, remote.rows, remote.lease_id),
            (45, 21, view.lease_id)
        );
        assert_eq!(remote.revision, view.revision + 100);
        let restored = manager.view_release(id, key, view.lease_id).unwrap();
        assert_eq!((restored.cols, restored.rows), (150, 40));
        manager.resize(id, 160, 42).unwrap();
        let local = manager.list()[0].view.clone().unwrap();
        assert_eq!(local.lease_id, restored.lease_id);
        assert!(local.revision > restored.revision);
        manager.detach(id, key).unwrap();
        assert!(manager.subscribed_cwd(id, key).is_err());
    }

    #[test]
    fn mobile_view_ownership_restores_local_size_and_rejects_stale_leases() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        struct Cleanup(TerminalManager);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.kill_all_blocking();
            }
        }
        let _cleanup = Cleanup(manager.clone());
        let id = manager
            .spawn_with_args(
                "/tmp",
                80,
                24,
                "mobile-isolated",
                Channel::new(|_| Ok(())),
                &["-f"],
            )
            .unwrap()
            .id;
        let a = SubscriberKey::Remote(1);
        let b = SubscriberKey::Remote(2);
        assert!(manager.view_claim(id, a, 40, 20).is_err());
        for key in [a, b] {
            manager
                .attach_for(id, key, Channel::new(|_| Ok(())))
                .unwrap();
        }
        let first = manager.view_claim(id, a, 40, 20).unwrap();
        manager.resize(id, 120, 35).unwrap();
        assert_eq!((manager.list()[0].cols, manager.list()[0].rows), (40, 20));
        let second = manager.view_claim(id, b, 50, 21).unwrap();
        assert!(second.lease_id > first.lease_id && second.revision > first.revision);
        assert!(manager.view_renew(id, a, first.lease_id, 60, 22).is_err());
        assert!(manager.view_release(id, a, first.lease_id).is_err());
        let renewed = manager.view_renew(id, b, second.lease_id, 60, 22).unwrap();
        assert_eq!(renewed.lease_id, second.lease_id);
        assert!(renewed.revision > second.revision);
        manager.detach_all(b);
        let restored = manager.list()[0].view.clone().unwrap();
        assert_eq!(
            (restored.cols, restored.rows, restored.owner.as_str()),
            (120, 35, "local")
        );
        assert!(manager.view_renew(id, b, second.lease_id, 60, 22).is_err());
        let third = manager.view_claim(id, a, 40, 20).unwrap();
        let local = manager
            .view_claim(id, SubscriberKey::Webview, 100, 30)
            .unwrap();
        assert!(local.lease_id > third.lease_id);
        assert!(manager.view_renew(id, a, third.lease_id, 60, 22).is_err());
        assert!(manager.view_claim(id, a, 501, 20).is_err());
        assert!(manager.view_claim(id, a, 40, 301).is_err());
    }

    #[test]
    fn mobile_view_expires_on_server_without_api_calls() {
        let (tx, rx) = mpsc::channel();
        let manager = TerminalManager::with_notifiers(
            Arc::new(|_| {}),
            Arc::new(move |view| {
                let _ = tx.send(view);
            }),
        );
        struct Cleanup(TerminalManager);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.kill_all_blocking();
            }
        }
        let _cleanup = Cleanup(manager.clone());
        let id = manager
            .spawn_with_args(
                "/tmp",
                80,
                24,
                "expiry-isolated",
                Channel::new(|_| Ok(())),
                &["-f"],
            )
            .unwrap()
            .id;
        let key = SubscriberKey::Remote(7);
        manager
            .attach_for(id, key, Channel::new(|_| Ok(())))
            .unwrap();
        manager.view_claim(id, key, 40, 20).unwrap();
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1)).unwrap().owner,
            "remote"
        );
        manager.lock().sessions.get_mut(&id).unwrap().view_deadline =
            Some(Instant::now() - Duration::from_secs(1));
        let released = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(
            (released.owner.as_str(), released.cols, released.rows),
            ("local", 80, 24)
        );
    }

    fn sink() -> (Channel, Receiver<InvokeResponseBody>) {
        let (tx, rx) = mpsc::channel();
        (
            Channel::new(move |body| {
                tx.send(body).unwrap();
                Ok(())
            }),
            rx,
        )
    }

    #[test]
    fn two_subscribers_receive_the_same_output() {
        let (local, a) = sink();
        let (remote, b) = sink();
        let link = OutputLink::new(local);
        link.attach(SubscriberKey::Remote(7), remote);
        let _ = b.recv().unwrap(); // empty replay marker
        link.send(InvokeResponseBody::Raw(b"shared".to_vec()));
        for rx in [a, b] {
            assert!(
                matches!(rx.recv().unwrap(), InvokeResponseBody::Raw(data) if data == b"shared")
            );
        }
    }

    #[test]
    fn attach_replays_the_scrollback_with_offset() {
        let link = OutputLink::new(Channel::new(|_| Ok(())));
        link.send(InvokeResponseBody::Raw(vec![b'a'; 300_000]));
        let (remote, rx) = sink();
        link.attach(SubscriberKey::Remote(2), remote);
        let InvokeResponseBody::Json(marker) = rx.recv().unwrap() else {
            panic!("replay marker");
        };
        let marker: serde_json::Value = serde_json::from_str(&marker).unwrap();
        assert_eq!(marker["offset"], 37_856);
        assert_eq!(marker["length"], 262_144);
        assert!(
            matches!(rx.recv().unwrap(), InvokeResponseBody::Raw(data) if data == vec![b'a'; 262_144])
        );
        link.send(InvokeResponseBody::Raw(b"next".to_vec()));
        assert!(matches!(rx.recv().unwrap(), InvokeResponseBody::Raw(data) if data == b"next"));
    }

    #[test]
    fn remote_that_never_acks_is_detached_and_shell_keeps_going() {
        let (remote, rx) = sink();
        let link = OutputLink::with_subscriber(SubscriberKey::Remote(9), remote);
        link.send(InvokeResponseBody::Raw(vec![0; HIGH_WATER + 1]));
        let started = Instant::now();
        assert!(link.wait_for_room(1));
        assert!(started.elapsed() >= REMOTE_LAG_GRACE);
        assert!(started.elapsed() < REMOTE_LAG_GRACE + Duration::from_secs(2));
        let _ = rx.recv().unwrap();
        assert!(
            matches!(rx.recv().unwrap(), InvokeResponseBody::Json(data) if data.contains("lagged"))
        );
        assert!(link.wait_for_room(1));
    }

    #[test]
    fn synchronous_remote_ack_does_not_deadlock_delivery() {
        let link = Arc::new(OutputLink::new(Channel::new(|_| Ok(()))));
        let target = Arc::downgrade(&link);
        link.attach(
            SubscriberKey::Webview,
            Channel::new(move |body| {
                if let InvokeResponseBody::Raw(bytes) = body {
                    target
                        .upgrade()
                        .unwrap()
                        .ack_for(SubscriberKey::Webview, bytes.len());
                }
                Ok(())
            }),
        );
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            link.send(InvokeResponseBody::Raw(vec![0; HIGH_WATER + 1]));
            tx.send(link.wait_for_room(1)).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap());
    }

    #[test]
    fn remote_ack_cannot_release_a_stalled_webview() {
        let link = Arc::new(OutputLink::new(Channel::new(|_| Ok(()))));
        link.attach(SubscriberKey::Remote(8), Channel::new(|_| Ok(())));
        link.send(InvokeResponseBody::Raw(vec![0; HIGH_WATER + 1]));
        link.ack_for(SubscriberKey::Remote(8), HIGH_WATER + 1);
        let waiting = link.clone();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || tx.send(waiting.wait_for_room(1)).unwrap());
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
        link.ack_for(SubscriberKey::Webview, HIGH_WATER + 1);
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
    }

    #[test]
    fn replay_and_live_output_never_overlap_during_concurrent_attach() {
        let link = Arc::new(OutputLink::new(Channel::new(|_| Ok(()))));
        let writer = link.clone();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let start = barrier.clone();
        let thread = thread::spawn(move || {
            start.wait();
            for number in 0..1000u32 {
                writer.send(InvokeResponseBody::Raw(number.to_be_bytes().to_vec()));
            }
        });
        let (channel, rx) = sink();
        barrier.wait();
        link.attach(SubscriberKey::Remote(3), channel);
        thread.join().unwrap();
        let mut bytes = Vec::new();
        let mut marker_seen = false;
        for frame in rx.try_iter() {
            match frame {
                InvokeResponseBody::Json(text) => {
                    assert!(!marker_seen);
                    marker_seen = true;
                    assert_eq!(
                        serde_json::from_str::<serde_json::Value>(&text).unwrap()["offset"],
                        0
                    );
                }
                InvokeResponseBody::Raw(data) => {
                    assert!(marker_seen);
                    bytes.extend(data);
                }
            }
        }
        let values: Vec<_> = bytes
            .chunks_exact(4)
            .map(|chunk| u32::from_be_bytes(chunk.try_into().unwrap()))
            .collect();
        assert_eq!(values, (0..1000).collect::<Vec<_>>());
    }

    #[test]
    fn detach_all_removes_a_connection_from_every_session() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        struct Cleanup(TerminalManager);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.kill_all_blocking();
            }
        }
        let _cleanup = Cleanup(manager.clone());
        let first = manager
            .spawn_for_with_args(
                "/tmp",
                80,
                24,
                "isolated-one",
                SubscriberKey::Remote(4),
                Channel::new(|_| Ok(())),
                &["-f"],
            )
            .unwrap();
        let second = manager
            .spawn_for_with_args(
                "/tmp",
                80,
                24,
                "isolated-two",
                SubscriberKey::Remote(4),
                Channel::new(|_| Ok(())),
                &["-f"],
            )
            .unwrap();
        manager
            .attach_for(first.id, SubscriberKey::Remote(5), Channel::new(|_| Ok(())))
            .unwrap();
        assert!(manager.has_subscriber(first.id, SubscriberKey::Remote(4)));
        assert!(manager.has_subscriber(second.id, SubscriberKey::Remote(4)));
        manager.detach_all(SubscriberKey::Remote(4));
        for id in [first.id, second.id] {
            assert!(!manager.has_subscriber(id, SubscriberKey::Remote(4)));
            let (link, _) = manager.output(id).unwrap();
            assert!(
                !lock(&link.state)
                    .subscribers
                    .contains_key(&SubscriberKey::Remote(4))
            );
            assert!(
                !lock(&link.state)
                    .subscribers
                    .contains_key(&SubscriberKey::Webview)
            );
            manager.write(id, b"printf isolated\n").unwrap();
        }
        assert!(
            lock(&manager.output(first.id).unwrap().0.state)
                .subscribers
                .contains_key(&SubscriberKey::Remote(5))
        );
        assert!(manager.has_subscriber(first.id, SubscriberKey::Remote(5)));
        assert!(!manager.has_subscriber(u32::MAX, SubscriberKey::Remote(5)));
        assert_eq!(manager.list().len(), 2);
    }

    #[test]
    fn inherited_agent_markers_are_recognised() {
        assert!(is_inherited_agent_marker("CLAUDECODE"));
        assert!(is_inherited_agent_marker("CLAUDE_CODE_CHILD_SESSION"));
        assert!(is_inherited_agent_marker("CLAUDE_CODE_SESSION_ID"));
        assert!(is_inherited_agent_marker("CLAUDE_PID"));
        assert!(is_inherited_agent_marker("CODEX_SANDBOX_NETWORK_DISABLED"));
        assert!(!is_inherited_agent_marker("CLAUDE_HOME"));
        assert!(!is_inherited_agent_marker("CLAUDE_CONFIG_DIR"));
        assert!(!is_inherited_agent_marker("CODEX_HOME"));
        assert!(!is_inherited_agent_marker("PATH"));
    }
    use std::sync::mpsc::channel;

    #[test]
    fn prefixed_path_puts_homebrew_first() {
        assert!(prefixed_path().starts_with("/opt/homebrew/bin:/usr/local/bin:"));
    }

    fn collect_until_exit(
        rx: &Receiver<InvokeResponseBody>,
    ) -> (Vec<u8>, Option<serde_json::Value>) {
        let mut output = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(InvokeResponseBody::Raw(bytes)) => output.extend_from_slice(&bytes),
                Ok(InvokeResponseBody::Json(json)) => {
                    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
                    if value["type"] == "exit" {
                        return (output, Some(value));
                    }
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        (output, None)
    }

    #[test]
    fn spawns_a_shell_streams_output_and_reports_exit() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });

        let info = manager.spawn("/tmp", 80, 24, "t1", sink).expect("spawn");
        assert!(info.alive);
        assert_eq!(manager.list().len(), 1);
        manager.resize(info.id, 100, 30).expect("resize");
        manager
            .write(info.id, b"printf 'pty-ok-%s\\n' $((40+2)); exit 3\n")
            .expect("write");

        let (output, exit) = collect_until_exit(&rx);
        let text = String::from_utf8_lossy(&output);
        assert!(text.contains("pty-ok-42"), "saida: {text}");
        let exit = exit.expect("mensagem de fim");
        assert_eq!(exit["type"], "exit");
        assert_eq!(exit["code"], 3);
        assert!(manager.list().is_empty());
        assert!(manager.write(info.id, b"x").is_err());
    }

    #[test]
    fn history_and_state_outlive_the_shell_on_disk() {
        let dir = std::env::temp_dir().join(format!("oc-terminal-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let manager = TerminalManager::with_notifier(Arc::new(|_| {})).with_journal(dir.clone());
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let info = manager
            .spawn_with_args("/tmp", 80, 24, "s_journal", sink, &["-f"])
            .expect("spawn");
        let saved = manager.saved("s_journal").expect("estado gravado ao abrir");
        assert_eq!(
            (saved.cwd.as_str(), saved.cols, saved.rows),
            ("/tmp", 80, 24)
        );
        assert!(saved.resume.is_none());
        assert_eq!(manager.live_count(), 1);
        manager
            .write(info.id, b"printf 'historico-%s\\n' $((40+2)); exit 0\n")
            .expect("write");
        let (_, exit) = collect_until_exit(&rx);
        assert!(exit.is_some());
        let history = manager.saved_history("s_journal");
        assert!(String::from_utf8_lossy(&history).contains("historico-42"));
        assert!(history.ends_with(journal::TERMINAL_RESET));
        manager.forget("s_journal");
        assert!(manager.saved("s_journal").is_none());
        assert!(manager.saved_history("s_journal").is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn rejects_missing_directory() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let sink = Channel::new(|_| Ok(()));
        let error = manager
            .spawn("/definitivamente/nao/existe", 80, 24, "t2", sink)
            .unwrap_err();
        assert!(error.contains("Pasta não encontrada"));
    }

    #[test]
    fn kill_ends_the_session() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let info = manager.spawn("/tmp", 80, 24, "t1", sink).expect("spawn");
        manager.kill(info.id).expect("kill");
        let (_, exit) = collect_until_exit(&rx);
        assert!(exit.is_some(), "o fim da sessao deve chegar pelo canal");
        assert!(manager.list().is_empty());
    }

    #[test]
    fn metrics_follow_the_foreground_job_and_measure_cpu() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let info = manager.spawn("/tmp", 80, 24, "m1", sink).expect("spawn");
        // Espera o prompt: o shell em primeiro plano e sem job.
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut idle = false;
        while Instant::now() < deadline {
            let sample = manager.metrics();
            if sample.len() == 1
                && sample[0].available
                && sample[0].foreground.is_none()
                && sample[0].shell_cwd.is_some()
            {
                idle = true;
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        assert!(idle, "o shell deveria ficar em primeiro plano sem job");
        assert_eq!(manager.metrics()[0].tag, "m1");

        // Um job que ocupa a CPU: o lider do grupo em primeiro plano e o yes
        // e a soma de CPU da arvore precisa aparecer na segunda amostra.
        manager.write(info.id, b"yes > /dev/null\n").expect("write");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = None;
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(250));
            let sample = manager.metrics().remove(0);
            if let Some(foreground) = &sample.foreground {
                if foreground.command == "yes" {
                    if let Some(cpu) = sample.cpu_percent {
                        if cpu > 20.0 {
                            seen = Some((foreground.clone(), cpu, sample.memory_bytes));
                            break;
                        }
                    }
                }
            }
        }
        let (foreground, cpu, memory) = seen.expect("yes em primeiro plano com CPU medida");
        assert_eq!(foreground.command, "yes");
        assert!(foreground.agent.is_none());
        assert!(cpu > 20.0 && cpu < 800.0, "cpu fora da faixa: {cpu}");
        assert!(
            memory.unwrap_or(0) > 100 * 1024,
            "memoria da arvore muito baixa"
        );

        manager.write(info.id, &[0x03]).expect("ctrl-c");
        manager.write(info.id, b"exit\n").expect("exit");
        let (_, exit) = collect_until_exit(&rx);
        assert!(exit.is_some());
        assert!(manager.metrics().is_empty());
    }
}
