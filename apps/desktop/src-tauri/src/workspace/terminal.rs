// SPDX-License-Identifier: Apache-2.0
//! Sessoes de terminal sobre PTY.
//!
//! Cada sessao abre o shell escolhido para o sistema num PTY do
//! `portable-pty` e transmite a saida ao webview por um `Channel` do Tauri em
//! bytes brutos. Tres threads
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

use portable_pty::{ChildKiller, CommandBuilder, ExitStatus, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

use crate::i18n::{t, tf};
use crate::platform::{self, ShellSpec};
use crate::prefs::{Preferences, PrefsState};

use super::EVENT_PTY_EXIT;
use super::agent_profiles;
use super::agent_state::{self, AgentTurn};
use super::journal::{self, JournalStore, JournalWriter, SavedMeta, SavedTerminal};
use super::procs::{self, CommandCache, CommandLine, ProcSource, ProcState, SystemProcs};
use super::pty::{self, CursorPosition, ShellFlavor};
use super::resume::{self, AgentEvidence};

const READ_BUFFER: usize = 16 * 1024;
const COALESCE_WINDOW: Duration = Duration::from_millis(4);
const MAX_BATCH: usize = 64 * 1024;
const HIGH_WATER: usize = 512 * 1024;
const LOW_WATER: usize = 128 * 1024;
const QUEUE_DEPTH: usize = 32;
const SCROLLBACK_LIMIT: usize = 256 * 1024;
const REMOTE_LAG_GRACE: Duration = Duration::from_secs(3);
/// Consultas que um programa faz ao terminal e que o xterm responde sozinho:
/// posicao do cursor, atributos do dispositivo e cores de frente e fundo. Ao
/// vivo elas seguem intactas, porque o programa espera a resposta. No anel de
/// historico cada byte delas vira NUL, que o xterm ignora: o replay de um
/// attach nao gera resposta nenhuma e mantem o tamanho e os offsets da saida
/// ao vivo. A pergunta do arranque do ConPTY e tratada antes, em `pty::cursor`.
const TERMINAL_QUERIES: &[&[u8]] = &[
    b"\x1b[6n",
    b"\x1b[?6n",
    b"\x1b[c",
    b"\x1b[0c",
    b"\x1b[>c",
    b"\x1b[>0c",
    b"\x1b]10;?\x07",
    b"\x1b]10;?\x1b\\",
    b"\x1b]11;?\x07",
    b"\x1b]11;?\x1b\\",
];
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
    pub shell_flavor: ShellFlavor,
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

/// Nome, subtitulo, cor, fixacao e ordem de um card. O Rust e a fonte de
/// verdade: computador e celular publicam e leem daqui, e `revision` resolve a
/// disputa. Quem grava recebe a revisao nova; quem le adota a apresentacao
/// quando a revisao recebida e maior que a conhecida.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct TerminalPresentation {
    pub name: String,
    pub subtitle: String,
    pub color: Option<String>,
    pub pinned: bool,
    pub order: u32,
    /// Contador que so cresce, atribuido pelo Rust a cada gravacao. O cliente
    /// nunca o escolhe: um campo ausente na entrada vira zero e e substituido.
    #[serde(default)]
    pub revision: u64,
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
    /// Pasta de configuracao do agente, como `~/.claude-work`, lida do
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
    /// Turno do agente desta sessao, lido dos arquivos que ele mesmo grava.
    /// Quando existe, decide sozinho o estado do card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_turn: Option<AgentTurn>,
    /// Milissegundos desde a ultima saida do PTY, pelo relogio do computador.
    /// `None` quando a sessao ainda nao produziu nada.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_age_ms: Option<u64>,
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
    /// Instante do ultimo lote de saida, medido no relogio do computador,
    /// para todos os clientes concordarem sobre a idade dela.
    last_output: Option<Instant>,
    /// Ate onde o historico ja foi limpo de consultas; o resto pode terminar
    /// num comeco de consulta cortado entre dois trechos.
    clean: usize,
}

/// Troca por NUL as consultas do historico a partir de `from` e devolve ate
/// onde ele esta limpo. Um comeco de consulta no fim do trecho fica pendente
/// ate o proximo trecho dizer se ela se completa.
fn neutralize_queries(history: &mut VecDeque<u8>, from: usize) -> usize {
    let tail: Vec<u8> = history.range(from..).copied().collect();
    let mut index = 0;
    while index < tail.len() {
        if tail[index] != 0x1b {
            index += 1;
            continue;
        }
        let rest = &tail[index..];
        if let Some(query) = TERMINAL_QUERIES
            .iter()
            .find(|query| rest.starts_with(query))
        {
            for offset in 0..query.len() {
                history[from + index + offset] = 0;
            }
            index += query.len();
        } else if TERMINAL_QUERIES.iter().any(|query| query.starts_with(rest)) {
            return from + index;
        } else {
            index += 1;
        }
    }
    history.len()
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
                state.last_output = Some(Instant::now());
                state.history.extend(data);
                let overflow = state.history.len().saturating_sub(SCROLLBACK_LIMIT);
                state.history.drain(..overflow);
                let from = state.clean.saturating_sub(overflow);
                state.clean = neutralize_queries(&mut state.history, from);
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

    /// Instante do ultimo lote de saida desta sessao.
    fn last_output(&self) -> Option<Instant> {
        lock(&self.state).last_output
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
    tree: Option<pty::ProcessTree>,
    link: Arc<OutputLink>,
    spawned_at: Instant,
    view_owner: SubscriberKey,
    view_deadline: Option<Instant>,
    local_size: Option<(u16, u16)>,
}

type KillTarget = (
    u32,
    Box<dyn ChildKiller + Send + Sync>,
    Option<u32>,
    Option<pty::ProcessTree>,
);

/// Prazo da posse remota do terminal sem renovacao. O celular renova a cada
/// 5 s, mas pela reserva uma renovacao pode levar bem mais que isso; com 15 s
/// a posse caia e voltava a toda hora, e o terminal do celular piscava.
const VIEW_LEASE: Duration = Duration::from_secs(45);
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
            .map_err(|_| t("native.error.terminalResize"))?;
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
    /// Homes do Codex das sessoes na ultima amostra, para o uso do plano
    /// achar perfis fora de `~/.codex*`.
    codex_homes: Arc<Mutex<Vec<PathBuf>>>,
    procs: Arc<dyn ProcSource>,
    /// Historico e estado em disco. `None` nos testes que nao pedem.
    journal: Option<Arc<JournalStore>>,
    /// O app esta saindo: o fim dos shells nao apaga a conversa do agente
    /// guardada para a retomada.
    closing: Arc<AtomicBool>,
    prefs: PrefsState,
    home: PathBuf,
}

impl TerminalManager {
    pub fn new(app: AppHandle, prefs: PrefsState) -> Self {
        let view_app = app.clone();
        let home = app
            .path()
            .home_dir()
            .unwrap_or_else(|_| std::env::temp_dir());
        let journal_dir = app
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("terminals"));
        let manager = Self::with_environment(
            Arc::new(move |exit| {
                let _ = app.emit(EVENT_PTY_EXIT, exit);
            }),
            Arc::new(move |view| {
                let _ = view_app.emit("pty://view", view);
            }),
            prefs,
            home,
            Arc::new(SystemProcs::default()),
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

    /// Abre o shell isolado dos testes para outras camadas, como a ponte.
    #[cfg(test)]
    pub(crate) fn spawn_test_shell_for(
        &self,
        shell: &pty::TestShell,
        tag: &str,
        key: SubscriberKey,
        channel: Channel,
    ) -> Result<TerminalInfo, String> {
        let prefs = self.prefs.get();
        self.spawn_for_with_spec(
            shell.cwd(),
            80,
            24,
            CursorPosition::default(),
            tag,
            key,
            channel,
            shell.spec(),
            &prefs,
        )
    }

    #[cfg(test)]
    fn with_notifiers(notify_exit: ExitNotifier, notify_view: ViewNotifier) -> Self {
        Self::with_environment(
            notify_exit,
            notify_view,
            PrefsState::new(Preferences::default()),
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir),
            Arc::new(SystemProcs::default()),
        )
    }

    /// Troca a pasta pessoal do gerenciador, para um teste apontar para uma
    /// arvore sintetica em vez do `HOME` de quem roda a suite. Existe onde
    /// existe quem o chama, e quem o chama e um teste de shell POSIX.
    #[cfg(all(test, unix))]
    fn with_home(mut self, home: PathBuf) -> Self {
        self.home = home;
        self
    }

    #[cfg(test)]
    fn with_proc_source(notify_exit: ExitNotifier, procs: Arc<dyn ProcSource>) -> Self {
        Self::with_environment(
            notify_exit,
            Arc::new(|_| {}),
            PrefsState::new(Preferences::default()),
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir),
            procs,
        )
    }

    fn with_environment(
        notify_exit: ExitNotifier,
        notify_view: ViewNotifier,
        prefs: PrefsState,
        home: PathBuf,
        procs: Arc<dyn ProcSource>,
    ) -> Self {
        let manager = Self {
            inner: Arc::new(Mutex::new(Inner {
                next_id: 0,
                sessions: HashMap::new(),
            })),
            notify_exit,
            notify_view: notify_view.clone(),
            samples: Arc::new(Mutex::new(HashMap::new())),
            commands: Arc::new(Mutex::new(CommandCache::default())),
            codex_homes: Arc::new(Mutex::new(Vec::new())),
            procs,
            journal: None,
            closing: Arc::new(AtomicBool::new(false)),
            prefs,
            home,
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
        let home = self.home.clone();
        let _ = thread::Builder::new()
            .name("terminais-estado".into())
            .spawn(move || {
                loop {
                    thread::sleep(SNAPSHOT_INTERVAL);
                    let Some(inner) = weak.upgrade() else {
                        break;
                    };
                    snapshot(&inner, &store, &commands, &home);
                }
            });
        self
    }

    pub fn spawn(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        cursor: CursorPosition,
        tag: &str,
        channel: Channel,
    ) -> Result<TerminalInfo, String> {
        self.spawn_configured(
            cwd,
            cols,
            rows,
            cursor,
            tag,
            SubscriberKey::Webview,
            channel,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn_for(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        cursor: CursorPosition,
        tag: &str,
        key: SubscriberKey,
        channel: Channel,
    ) -> Result<TerminalInfo, String> {
        self.spawn_configured(cwd, cols, rows, cursor, tag, key, channel)
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_configured(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        cursor: CursorPosition,
        tag: &str,
        key: SubscriberKey,
        channel: Channel,
    ) -> Result<TerminalInfo, String> {
        let prefs = self.prefs.get();
        let shell = platform::default_shell(&prefs);
        self.spawn_for_with_spec(cwd, cols, rows, cursor, tag, key, channel, &shell, &prefs)
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn_for_with_spec(
        &self,
        cwd: &str,
        cols: u16,
        rows: u16,
        cursor: CursorPosition,
        tag: &str,
        key: SubscriberKey,
        channel: Channel,
        shell: &ShellSpec,
        prefs: &Preferences,
    ) -> Result<TerminalInfo, String> {
        // Pasta sempre explicita: no AppImage a pasta herdada e `$APPDIR/usr`.
        let Some(dir) = platform::child_env::pty_cwd(
            cwd,
            &self.home,
            platform::child_env::original_dir().as_deref(),
        ) else {
            return Err(tf("native.error.folderNotFoundPath", &[("path", &cwd)]));
        };
        // A sessao publica a pasta na forma portatil, como o resto da
        // interface espera; o proprio PTY continua abrindo em `dir`.
        let cwd = platform::to_portable(&dir);
        let cols = cols.max(2);
        let rows = rows.max(1);

        let mut command = CommandBuilder::new(&shell.path);
        for arg in &shell.args {
            command.arg(arg);
        }
        command.cwd(&dir);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Cialai");
        command.env("TERM_PROGRAM_VERSION", env!("CARGO_PKG_VERSION"));
        command.env("PATH", platform::path_env(prefs, &self.home));
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
        // Conta escolhida na interface. Vem depois da limpeza de marcadores, e
        // o cliente nunca manda variavel nem caminho: o servidor resolve a
        // pasta a partir da propria preferencia e da pasta pessoal. Um perfil
        // padrao ativo remove as variaveis; um nomeado as define. Se o arquivo
        // de inicializacao do shell exportar a variavel, ele vence, e o card
        // mostra a verdade lida do processo.
        for (agent, id) in [
            (
                agent_profiles::Agent::Claude,
                prefs.agents.active_profile.get("claude"),
            ),
            (
                agent_profiles::Agent::Codex,
                prefs.agents.active_profile.get("codex"),
            ),
        ] {
            let Some(id) = id else { continue };
            for (name, value) in agent_profiles::env_for(&self.home, agent, id) {
                match value {
                    Some(value) => command.env(name, value),
                    None => command.env_remove(name),
                }
            }
        }
        if needs_lang() {
            if let Some(lang) = platform::default_lang(prefs) {
                // Apps abertos pela interface grafica podem chegar sem LANG.
                command.env("LANG", lang);
            }
        }
        platform::child_env::sanitize(&mut command);

        let spawned = pty::spawn_shell(
            command,
            PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            },
        )?;
        let pair = spawned.pair;
        let mut child = spawned.child;
        let tree = spawned.tree;
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
            cwd: cwd.clone(),
            shell: shell.path.clone(),
            shell_flavor: shell.flavor,
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
        let (write_tx, write_rx) = mpsc::sync_channel::<Vec<u8>>(QUEUE_DEPTH);
        let mut startup = pty::StartupCursorQuery::for_platform(cursor);
        let mut answer = startup.active().then(|| write_tx.clone());
        thread::spawn(move || {
            let mut buffer = [0u8; READ_BUFFER];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => {
                        let (output, reply) = startup.filter(&buffer[..read]);
                        if let (Some(reply), Some(writer)) = (reply, answer.as_ref()) {
                            let _ = writer.try_send(reply);
                        }
                        if !startup.active() {
                            answer = None;
                        }
                        if !output.is_empty() && tx.send(Message::Data(output)).is_err() {
                            break;
                        }
                    }
                }
            }
            let held = startup.finish();
            if !held.is_empty() {
                let _ = tx.send(Message::Data(held));
            }
        });
        thread::spawn(move || {
            let status = child.wait().ok();
            let _ = tx_exit.send(Message::Exit(status));
        });

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
                tree,
                link,
                spawned_at: Instant::now(),
                view_owner: SubscriberKey::Webview,
                view_deadline: None,
                local_size: (key == SubscriberKey::Webview).then_some((cols, rows)),
            },
        );
        if let Some(store) = &self.journal {
            store.write_meta(&SavedMeta::sample(tag, &cwd, cols, rows, None), || true);
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
                mpsc::TrySendError::Full(_) => t("native.error.terminalBusy"),
                mpsc::TrySendError::Disconnected(_) => t("native.error.sessionEnded"),
            })
    }

    /// Abre um agente numa conta escolhida, no terminal que ja esta aberto.
    ///
    /// Um terminal vivo nao muda de ambiente, entao a troca acontece digitando
    /// a linha com as variaveis na frente. So escreve com o shell no prompt e
    /// sem processo em primeiro plano: no meio de um agente rodando, a linha
    /// viraria texto na conversa dele.
    pub fn launch_agent(&self, id: u32, agent: &str, profile_id: &str) -> Result<(), String> {
        let kind =
            agent_profiles::Agent::parse(agent).ok_or_else(|| t("native.error.agentUnknown"))?;
        let slug = agent_profiles::slug_of(kind, profile_id)
            .ok_or_else(|| t("native.error.profileUnknown"))?;
        let dir = agent_profiles::dir_of(&self.home, kind, profile_id)
            .filter(|dir| agent_profiles::is_profile_dir(dir, kind))
            .ok_or_else(|| t("native.error.profileUnknown"))?;
        let (flavor, busy) = {
            let guard = self.lock();
            let session = guard.sessions.get(&id).ok_or_else(closed_error)?;
            let foreground = pty::foreground_pid(
                session.master.as_ref(),
                session.info.pid,
                self.procs.as_ref(),
            );
            let busy = foreground.is_some_and(|pgid| Some(pgid) != session.info.pid);
            (session.info.shell_flavor, busy)
        };
        if busy {
            return Err(t("native.error.shellBusy"));
        }
        // O perfil padrao abre o agente sem variavel nenhuma, para ele cair no
        // proprio padrao; um nomeado leva caminho e nome, citados.
        let portable = crate::platform::to_portable(&dir);
        let line = match slug {
            None => resume::launch_command(
                if kind == agent_profiles::Agent::Claude {
                    resume::CLAUDE
                } else {
                    resume::CODEX
                },
                None,
                None,
                flavor,
            ),
            Some(name) => resume::launch_command(
                if kind == agent_profiles::Agent::Claude {
                    resume::CLAUDE
                } else {
                    resume::CODEX
                },
                Some(&portable),
                Some(name),
                flavor,
            ),
        }
        .ok_or_else(|| t("native.error.profileUnknown"))?;
        self.write(id, format!("{line}\r").as_bytes())
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
            return Err(t("native.error.subscribeBeforeControl"));
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
            return Err(t("native.error.controlExpired"));
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
            return Err(t("native.error.controlExpired"));
        }
        let view = session.restore_local()?;
        drop(guard);
        (self.notify_view)(view.clone());
        Ok(view)
    }

    /// Grava a apresentacao e devolve a revisao atribuida.
    pub fn presentation(&self, id: u32, presentation: TerminalPresentation) -> Result<u64, String> {
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
            return Err(t("native.error.presentationInvalid"));
        }
        let mut guard = self.lock();
        let session = guard.sessions.get_mut(&id).ok_or_else(closed_error)?;
        let revision = session
            .info
            .presentation
            .as_ref()
            .map(|current| current.revision)
            .unwrap_or(0)
            .saturating_add(1);
        session.info.presentation = Some(TerminalPresentation {
            revision,
            ..presentation
        });
        Ok(revision)
    }

    pub fn subscribed_cwd(&self, id: u32, key: SubscriberKey) -> Result<String, String> {
        let guard = self.lock();
        let session = guard.sessions.get(&id).ok_or_else(closed_error)?;
        if !session.subscribed(key) {
            return Err(t("native.error.subscribeBeforeFiles"));
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
        let (mut killer, pid, tree) = {
            let guard = self.lock();
            let session = guard.sessions.get(&id).ok_or_else(closed_error)?;
            session.link.drain();
            (
                session.killer.clone_killer(),
                session.info.pid,
                session.tree.clone(),
            )
        };
        pty::graceful_kill(killer.as_mut());
        let manager = self.clone();
        thread::spawn(move || {
            thread::sleep(KILL_GRACE);
            if manager.lock().sessions.contains_key(&id) {
                pty::force_kill_tree(pid, tree.as_ref());
            }
        });
        Ok(())
    }

    /// Encerra todas as sessoes ao sair do app. Bloqueia por no maximo a
    /// graca de encerramento, para nao segurar a saida.
    pub fn kill_all_blocking(&self) {
        self.closing.store(true, Ordering::SeqCst);
        let targets: Vec<KillTarget> = {
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
                        session.tree.clone(),
                    )
                })
                .collect()
        };
        if targets.is_empty() {
            return;
        }
        for (_, mut killer, _, _) in targets
            .iter()
            .map(|(id, killer, pid, tree)| (*id, killer.clone_killer(), *pid, tree.clone()))
        {
            pty::graceful_kill(killer.as_mut());
        }
        thread::sleep(KILL_GRACE);
        let mut guard = self.lock();
        for (id, _, pid, tree) in targets {
            if guard.sessions.remove(&id).is_some() {
                pty::force_kill_tree(pid, tree.as_ref());
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
        let flavor = platform::default_shell(&self.prefs.get()).flavor;
        self.journal.as_ref()?.saved(tag, flavor)
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
        let source = self.procs.as_ref();
        source.refresh();
        let targets: Vec<MetricsTarget> = {
            let guard = self.lock();
            guard
                .sessions
                .values()
                .map(|session| MetricsTarget {
                    id: session.info.id,
                    tag: session.info.tag.clone(),
                    pid: session.info.pid,
                    foreground_pgid: pty::foreground_pid(
                        session.master.as_ref(),
                        session.info.pid,
                        self.procs.as_ref(),
                    ),
                    last_output: session.link.last_output(),
                })
                .collect()
        };
        let now = Instant::now();
        let home = self.home.clone();
        let mut samples = lock(&self.samples);
        let mut commands = lock(&self.commands);
        let mut alive = Vec::new();
        let mut result = Vec::new();
        let mut codex_homes = Vec::new();
        for MetricsTarget {
            id,
            tag,
            pid,
            foreground_pgid,
            last_output,
        } in targets
        {
            let output_age_ms = last_output.map(|at| {
                now.saturating_duration_since(at)
                    .as_millis()
                    .min(u128::from(u64::MAX)) as u64
            });
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
                    agent_turn: None,
                    output_age_ms,
                });
                continue;
            };
            let mut tree = vec![pid];
            tree.extend(source.descendants(pid));
            alive.extend_from_slice(&tree);

            let mut cpu = 0f64;
            let mut cpu_known = false;
            let mut memory = 0u64;
            let mut memory_known = false;
            for &member in &tree {
                let Some(usage) = source.usage(member) else {
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
                let Some(info) = source.info(member) else {
                    continue;
                };
                let Some(command) = commands.get_from(source, member, info.start_sec) else {
                    continue;
                };
                if let Some(found) = procs::agent_of(&command) {
                    let command = agent_command(source, member, command, found, &mut commands);
                    agent = Some(found.to_string());
                    agent_profile = procs::agent_profile(&command, found, &home);
                    break;
                }
            }
            let foreground = foreground_pgid
                .filter(|pgid| *pgid != pid)
                .and_then(|pgid| describe_foreground(source, pgid, &tree, &mut commands, &home));
            if agent.as_deref() == Some("Codex") {
                codex_homes.extend(
                    agent_profile
                        .as_ref()
                        .map(|profile| profile.config_dir.clone()),
                );
            }
            if let Some(found) = foreground
                .as_ref()
                .filter(|found| found.agent.as_deref() == Some("Codex"))
            {
                codex_homes.extend(found.config_dir.clone());
            }
            // O estado do turno vem do arquivo do proprio agente, nunca de
            // silencio ou de CPU. Sem agente na arvore, nao ha o que ler.
            let agent_turn = agent
                .is_some()
                .then(|| resume::detect(pid, &tree, &mut commands, &home))
                .flatten()
                .and_then(|found| turn_of(&found.evidence));

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
                shell_cwd: source.cwd(pid),
                agent_turn,
                output_age_ms,
            });
        }
        samples.retain(|member, _| alive.contains(member));
        commands.retain(&alive);
        let mut codex_homes = codex_homes
            .into_iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        codex_homes.sort();
        codex_homes.dedup();
        *lock(&self.codex_homes) = codex_homes;
        result.sort_by_key(|metrics| metrics.id);
        result
    }

    /// Homes do Codex em uso nas sessoes, pela ultima amostra de metricas.
    pub fn codex_homes(&self) -> Vec<PathBuf> {
        lock(&self.codex_homes).clone()
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
fn snapshot(
    inner: &Mutex<Inner>,
    store: &JournalStore,
    commands: &Mutex<CommandCache>,
    home: &Path,
) {
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
    for (id, tag, cwd, cols, rows, pid) in targets {
        let agent = pid.and_then(|pid| {
            let mut tree = vec![pid];
            tree.extend(procs::descendants(pid));
            resume::detect(pid, &tree, &mut lock(commands), home).map(|found| found.session)
        });
        store.write_meta(&SavedMeta::sample(&tag, &cwd, cols, rows, agent), || {
            lock(inner)
                .sessions
                .get(&id)
                .is_some_and(|session| session.info.pid == pid)
        });
    }
}

/// Alvo de uma amostra de metricas, colhido dentro do lock das sessoes para
/// as chamadas ao kernel ficarem fora dele.
struct MetricsTarget {
    id: u32,
    tag: String,
    pid: Option<u32>,
    foreground_pgid: Option<u32>,
    last_output: Option<Instant>,
}

/// Turno do agente pelo arquivo que a deteccao apontou.
fn turn_of(evidence: &AgentEvidence) -> Option<AgentTurn> {
    match evidence {
        AgentEvidence::ClaudeRecord(path) => agent_state::claude_turn(path),
        AgentEvidence::CodexRollout(path) => agent_state::codex_turn(path),
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn closed_error() -> String {
    t("native.error.sessionEnded")
}

/// Descreve o lider do grupo em primeiro plano. Se o lider ja saiu, vale o
/// primeiro processo da arvore que ainda esta nesse grupo.
fn describe_foreground(
    source: &dyn ProcSource,
    pgid: u32,
    tree: &[u32],
    commands: &mut CommandCache,
    home: &Path,
) -> Option<ForegroundProcess> {
    let candidate = if tree.contains(&pgid) {
        Some(pgid)
    } else {
        tree.iter().copied().find(|member| {
            source
                .info(*member)
                .map(|info| info.pgid == pgid)
                .unwrap_or(false)
        })
    }?;
    let info = source.info(candidate)?;
    if info.state == ProcState::Zombie {
        return None;
    }
    let command = commands.get_from(source, candidate, info.start_sec);
    let found = command.as_ref().and_then(procs::agent_of);
    let profile = match (command.clone(), found) {
        (Some(line), Some(found)) => {
            let line = agent_command(source, candidate, line, found, commands);
            procs::agent_profile(&line, found, home)
        }
        _ => None,
    };
    let agent = found.map(str::to_string);
    let name = source.name(candidate).unwrap_or_else(|| info.comm.clone());
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
        stopped: info.state == ProcState::Stopped,
        cwd: source.cwd(candidate),
        config_dir: profile.as_ref().map(|value| value.config_dir.clone()),
        profile: profile.as_ref().map(|value| value.slug.clone()),
        profile_name: profile.as_ref().and_then(|value| value.name.clone()),
    })
}

/// Linha de comando de onde sai o perfil do agente achado em `pid`. Um
/// lancador como `python3 wrai.py claude` ou `node codex.js` e reconhecido
/// pelo argumento, mas o perfil so existe no ambiente do CLI que ele abre.
/// Quando um descendente e o proprio agente, vale a linha dele.
fn agent_command(
    source: &dyn ProcSource,
    pid: u32,
    command: CommandLine,
    agent: &str,
    commands: &mut CommandCache,
) -> CommandLine {
    if procs::direct_agent_of(&command).is_some() {
        return command;
    }
    source
        .descendants(pid)
        .into_iter()
        .find_map(|member| {
            let info = source.info(member)?;
            let line = commands.get_from(source, member, info.start_sec)?;
            (procs::direct_agent_of(&line) == Some(agent)).then_some(line)
        })
        .unwrap_or(command)
}

fn needs_lang() -> bool {
    match std::env::var("LANG") {
        Ok(value) => value.is_empty() || value == "C" || value == "POSIX",
        Err(_) => true,
    }
}

fn validate_view_size(cols: u16, rows: u16) -> Result<(), String> {
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        return Err(t("native.error.terminalSize"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn_test_shell(
        manager: &TerminalManager,
        shell: &pty::TestShell,
        tag: &str,
        key: SubscriberKey,
        channel: Channel,
    ) -> TerminalInfo {
        let prefs = manager.prefs.get();
        manager
            .spawn_for_with_spec(
                shell.cwd(),
                80,
                24,
                CursorPosition::default(),
                tag,
                key,
                channel,
                shell.spec(),
                &prefs,
            )
            .expect("spawn")
    }

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
        let shell = pty::TestShell::isolated();
        let id = spawn_test_shell(
            &manager,
            &shell,
            "resize-isolated",
            SubscriberKey::Webview,
            Channel::new(|_| Ok(())),
        )
        .id;
        let key = SubscriberKey::Remote(8);
        assert!(manager.subscribed_cwd(id, key).is_err());
        manager
            .attach_for(id, key, Channel::new(|_| Ok(())))
            .unwrap();
        assert_eq!(
            manager.subscribed_cwd(id, key).unwrap(),
            crate::platform::to_portable(shell.cwd())
        );
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
        let shell = pty::TestShell::isolated();
        let id = spawn_test_shell(
            &manager,
            &shell,
            "mobile-isolated",
            SubscriberKey::Webview,
            Channel::new(|_| Ok(())),
        )
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
        let shell = pty::TestShell::isolated();
        let id = spawn_test_shell(
            &manager,
            &shell,
            "expiry-isolated",
            SubscriberKey::Webview,
            Channel::new(|_| Ok(())),
        )
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

    /// O replay nao pode carregar consulta nenhuma, nem a que chegou cortada
    /// entre dois trechos; ao vivo a mesma saida passa intacta.
    #[test]
    fn replay_neutralizes_terminal_queries_even_when_split_between_chunks() {
        let (local, live) = sink();
        let link = OutputLink::new(local);
        let chunks: [&[u8]; 3] = [
            b"prompt \x1b[6n\x1b[",
            b"c\x1b]11;?",
            b"\x1b\\ \x1b[>0c\x1b[?25l fim",
        ];
        let mut seen = Vec::new();
        for chunk in chunks {
            link.send(InvokeResponseBody::Raw(chunk.to_vec()));
            let InvokeResponseBody::Raw(data) = live.recv().unwrap() else {
                panic!("saida ao vivo");
            };
            assert_eq!(data, chunk);
            seen.extend_from_slice(chunk);
        }
        let (remote, rx) = sink();
        link.attach(SubscriberKey::Remote(4), remote);
        let InvokeResponseBody::Json(marker) = rx.recv().unwrap() else {
            panic!("replay marker");
        };
        let marker: serde_json::Value = serde_json::from_str(&marker).unwrap();
        assert_eq!(marker["offset"], 0);
        assert_eq!(marker["length"], seen.len() as u64);
        let InvokeResponseBody::Raw(replay) = rx.recv().unwrap() else {
            panic!("replay");
        };
        assert_eq!(replay.len(), seen.len());
        for query in TERMINAL_QUERIES {
            assert!(
                !replay.windows(query.len()).any(|window| window == *query),
                "{query:?}"
            );
        }
        let visible: Vec<u8> = replay.iter().copied().filter(|byte| *byte != 0).collect();
        assert_eq!(visible, b"prompt  \x1b[?25l fim");
        // Um comeco de consulta que nao se completa volta a valer como saida.
        link.send(InvokeResponseBody::Raw(b"\x1b[".to_vec()));
        link.send(InvokeResponseBody::Raw(b"1;1H".to_vec()));
        let (again, rx) = sink();
        link.attach(SubscriberKey::Remote(5), again);
        let _ = rx.recv().unwrap();
        let InvokeResponseBody::Raw(replay) = rx.recv().unwrap() else {
            panic!("replay");
        };
        assert!(replay.ends_with(b"\x1b[1;1H"));
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
        let shell = pty::TestShell::isolated();
        let first = spawn_test_shell(
            &manager,
            &shell,
            "isolated-one",
            SubscriberKey::Remote(4),
            Channel::new(|_| Ok(())),
        );
        let second = spawn_test_shell(
            &manager,
            &shell,
            "isolated-two",
            SubscriberKey::Remote(4),
            Channel::new(|_| Ok(())),
        );
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
            manager.write(id, &shell.print("isolated")).unwrap();
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
    fn configured_path_prefix_wins() {
        let mut prefs = Preferences::default();
        let home = std::env::temp_dir();
        let prefix = home.join("cialai-test-bin");
        prefs.terminal.path_prefix = vec![prefix.to_string_lossy().into_owned()];
        let path = platform::path_env(&prefs, &home);
        assert_eq!(
            std::env::split_paths(&path).next().as_deref(),
            Some(prefix.as_path())
        );
    }

    /// Perguntas de cursor que chegam ao canal depois da abertura, quando o gerenciador
    /// já respondeu a primeira. No app quem responde a essas é o xterm à vista; aqui o
    /// leitor responde como ele e escreve no log da CI quantas vieram em cada teste.
    struct LaterCursorQueries {
        name: &'static str,
        manager: TerminalManager,
        id: u32,
        answered: usize,
        tail: Vec<u8>,
    }

    impl LaterCursorQueries {
        fn new(name: &'static str, manager: &TerminalManager, id: u32) -> Self {
            Self {
                name,
                manager: manager.clone(),
                id,
                answered: 0,
                tail: Vec::new(),
            }
        }

        fn observe(&mut self, bytes: &[u8]) {
            let mut window = std::mem::take(&mut self.tail);
            window.extend_from_slice(bytes);
            let asked = window
                .windows(4)
                .filter(|candidate| *candidate == b"\x1b[6n")
                .count();
            for _ in 0..asked {
                let _ = self.manager.write(self.id, b"\x1b[1;1R");
                self.answered += 1;
                // Fora da captura do libtest, para aparecer no log mesmo com o teste verde.
                let _ = writeln!(
                    std::io::stderr(),
                    "[cialai-test] {}: pergunta de cursor {} depois da abertura",
                    self.name,
                    self.answered
                );
            }
            let keep = window.len().min(3);
            self.tail = window[window.len() - keep..].to_vec();
        }
    }

    /// Espera o texto aparecer duas vezes, no eco do comando e na saída. No Windows a
    /// saída de um comando seguido de exit na mesma linha pode se perder quando o ConPTY
    /// fecha, então o teste só sai depois de ver o texto.
    /// Espera a resposta do shell aparecer na saida.
    fn collect_until_printed(
        rx: &Receiver<InvokeResponseBody>,
        queries: &mut LaterCursorQueries,
        output: &mut Vec<u8>,
        text: &str,
    ) -> bool {
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            if answered(output, text) {
                return true;
            }
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(InvokeResponseBody::Raw(bytes)) => {
                    queries.observe(&bytes);
                    output.extend_from_slice(&bytes);
                }
                Ok(InvokeResponseBody::Json(_)) | Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        false
    }

    /// A resposta e a linha que comeca pelo texto.
    ///
    /// Contar aparicoes nao distingue pergunta de resposta, porque o terminal
    /// ecoa o que foi escrito e um shell que ainda estava abrindo redesenha a
    /// mesma linha depois do prompt, as vezes pela metade: o eco sozinho ja da
    /// duas aparicoes e o teste segue antes da resposta chegar. Olhar so o
    /// comeco da linha tambem nao basta, porque o `dash` escreve o prompt e a
    /// resposta na mesma linha. Entao o texto tem que abrir a linha, ou abrir o
    /// que vem logo depois do fim de um prompt.
    fn answered(output: &[u8], text: &str) -> bool {
        visible_lines(&String::from_utf8_lossy(output))
            .iter()
            .any(|line| opens_the_line(line, text))
    }

    fn opens_the_line(line: &str, text: &str) -> bool {
        let line = line.trim_start();
        if line.starts_with(text) {
            return true;
        }
        // Fim de prompt: `$ ` e `# ` do POSIX, `>` do `cmd`. O espaco depois do
        // cifrao evita confundir com `$VARIAVEL` dentro do comando ecoado.
        ["$ ", "# ", ">"]
            .iter()
            .filter_map(|mark| line.find(mark).map(|at| at + mark.len()))
            .min()
            .is_some_and(|at| line[at..].trim_start().starts_with(text))
    }

    /// Quebra a saida crua nas linhas que ela mostra.
    ///
    /// Tira as sequencias de escape e trata a que move o cursor como quebra de
    /// linha, porque o `cmd` posiciona o cursor em vez de escrever uma quebra e
    /// sem isso o banner, o prompt e a resposta virariam uma linha so.
    fn visible_lines(text: &str) -> Vec<String> {
        let mut lines = vec![String::new()];
        let mut chars = text.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch == '\n' || ch == '\r' {
                lines.push(String::new());
                continue;
            }
            if ch != '\u{1b}' {
                lines.last_mut().expect("sempre ha uma linha").push(ch);
                continue;
            }
            match chars.next() {
                // CSI: parametros ate um final entre `@` e `~`. `H` e `f`
                // posicionam o cursor, o que na pratica abre outra linha.
                Some('[') => {
                    let mut last = '\0';
                    for next in chars.by_ref() {
                        if ('\u{40}'..='\u{7e}').contains(&next) {
                            last = next;
                            break;
                        }
                    }
                    if last == 'H' || last == 'f' {
                        lines.push(String::new());
                    }
                }
                // OSC: termina em BEL ou em ESC seguido de barra invertida.
                Some(']') => {
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => {}
            }
        }
        lines
    }

    /// A regra de `answered` vale contra saida gravada de verdade, de cada
    /// shell que a suite abre. As tres transcricoes vieram de execucao real: o
    /// `cmd` do runner `windows-2022`, o `dash` do Ubuntu e o `bash` que o
    /// macOS instala como `/bin/sh`. Sem elas, cada engano sobre eco, prompt e
    /// redesenho de linha so aparece uma plataforma por vez, e cada volta custa
    /// uma rodada inteira de CI.
    #[test]
    fn the_answer_is_told_apart_from_the_echo_in_every_shell() {
        // `cmd`: o banner, o prompt e a resposta sao separados por sequencias
        // que movem o cursor, nao por quebra de linha, e o eco do comando vem
        // colado no prompt.
        let cmd = concat!(
            "\u{1b}[m\u{1b}]0;C:\\Windows\\system32\\cmd.exe\u{7}\u{1b}[?25h\u{1b}[?25l",
            "Microsoft Windows [Version 10.0.20348.5622]\r\n",
            "(c) Microsoft Corporation. All rights reserved.",
            "\u{1b}[4;1HC:\\Users\\RUNNER~1\\AppData\\Local\\Temp>echo pty-ok-42\r\n",
            "pty-ok-42",
            "\u{1b}[7;1HC:\\Users\\RUNNER~1\\AppData\\Local\\Temp>",
        );
        assert!(answered(cmd.as_bytes(), "pty-ok-42"), "cmd: {cmd:?}");

        // `dash`: o eco sai numa linha propria e o prompt abre a linha da
        // resposta.
        let dash = "printf '%s\\n' 'pty-ok-42'\r\n$ pty-ok-42\r\n$ ";
        assert!(answered(dash.as_bytes(), "pty-ok-42"), "dash: {dash:?}");

        // `bash`: redesenha a linha depois de escrever o prompt, entao o eco
        // aparece duas vezes, a segunda as vezes pela metade.
        let bash_half = concat!(
            "echo \"casa=[$CODEX_HOME]\"\r\n",
            "\u{1b}[?1034hsh-3.2$ echo \"casa=[",
        );
        assert!(
            !answered(bash_half.as_bytes(), "casa=["),
            "o eco do bash nao pode passar por resposta: {bash_half:?}"
        );
        let bash = format!("{bash_half}$CODEX_HOME]\"\r\ncasa=[]\r\nsh-3.2$ ");
        assert!(answered(bash.as_bytes(), "casa=["), "bash: {bash:?}");

        // O eco sozinho nunca conta, em nenhum dos tres.
        for eco in [
            "C:\\Users\\RUNNER~1>echo pty-ok-42\r\n",
            "printf '%s\\n' 'pty-ok-42'\r\n",
            "$ echo idade-da-saida\r\n",
        ] {
            assert!(
                !answered(eco.as_bytes(), "pty-ok-42")
                    && !answered(eco.as_bytes(), "idade-da-saida"),
                "so eco: {eco:?}"
            );
        }
    }

    /// Esvazia o canal em segundo plano e devolve a mensagem de fim quando ela chega.
    fn drain_until_exit_in_background(
        rx: Receiver<InvokeResponseBody>,
        mut queries: LaterCursorQueries,
    ) -> thread::JoinHandle<Option<serde_json::Value>> {
        thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(60);
            while Instant::now() < deadline {
                match rx.recv_timeout(Duration::from_millis(200)) {
                    Ok(InvokeResponseBody::Raw(bytes)) => queries.observe(&bytes),
                    Err(RecvTimeoutError::Timeout) => {}
                    Ok(InvokeResponseBody::Json(json)) => {
                        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
                        if value["type"] == "exit" {
                            return Some(value);
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            None
        })
    }

    fn collect_until_exit(
        rx: &Receiver<InvokeResponseBody>,
        queries: &mut LaterCursorQueries,
    ) -> (Vec<u8>, Option<serde_json::Value>) {
        let mut output = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(InvokeResponseBody::Raw(bytes)) => {
                    queries.observe(&bytes);
                    output.extend_from_slice(&bytes);
                }
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

    /// Pasta temporaria propria deste teste, sempre sintetica: nenhum
    /// registro ou credencial real e lido aqui.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cialai-turno-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn claude_record_at(dir: &Path, pid: u32, body: serde_json::Value) -> PathBuf {
        let sessions = dir.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let path = sessions.join(format!("{pid}.json"));
        std::fs::write(&path, body.to_string()).unwrap();
        path
    }

    fn rollout_at(dir: &Path, name: &str, events: &[&str]) -> PathBuf {
        let day = dir.join("sessions/2026/09/18");
        std::fs::create_dir_all(&day).unwrap();
        let path = day.join(name);
        let body = events
            .iter()
            .map(|kind| format!("{{\"type\":\"event_msg\",\"payload\":{{\"type\":\"{kind}\"}}}}"))
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&path, format!("{body}\n")).unwrap();
        path
    }

    #[test]
    fn the_claude_record_decides_the_turn_and_only_a_stamped_idle_counts_as_answered() {
        let dir = scratch("claude");
        let started = 1_789_000_000_000u64;

        let busy = claude_record_at(
            &dir,
            11,
            serde_json::json!({"pid":11,"cwd":"/p","status":"busy","startedAt":started,"statusUpdatedAt":started + 500}),
        );
        let turn = turn_of(&AgentEvidence::ClaudeRecord(busy)).expect("turno");
        assert_eq!(turn.state, agent_state::TurnState::Busy);
        assert_eq!(turn.since_ms, started + 500);

        let waiting = claude_record_at(
            &dir,
            12,
            serde_json::json!({"pid":12,"cwd":"/p","status":"waiting","waitingFor":"permission","startedAt":started,"statusUpdatedAt":started + 900}),
        );
        let turn = turn_of(&AgentEvidence::ClaudeRecord(waiting)).expect("turno");
        assert_eq!(turn.state, agent_state::TurnState::Waiting);
        assert_eq!(turn.waiting_for.as_deref(), Some("permission"));

        // Sessao recem aberta: o carimbo de estado e o proprio inicio.
        let fresh = claude_record_at(
            &dir,
            13,
            serde_json::json!({"pid":13,"cwd":"/p","status":"idle","startedAt":started}),
        );
        assert_eq!(
            turn_of(&AgentEvidence::ClaudeRecord(fresh)).map(|turn| turn.state),
            Some(agent_state::TurnState::Idle)
        );

        // Mesmo `idle`, mas depois de um turno: o carimbo andou.
        let answered = claude_record_at(
            &dir,
            14,
            serde_json::json!({"pid":14,"cwd":"/p","status":"idle","startedAt":started,"statusUpdatedAt":started + 60_000}),
        );
        assert_eq!(
            turn_of(&AgentEvidence::ClaudeRecord(answered)).map(|turn| turn.state),
            Some(agent_state::TurnState::Done)
        );

        // Registro que nao diz nada que se entenda nao vira turno nenhum.
        let mute = claude_record_at(
            &dir,
            15,
            serde_json::json!({"pid":15,"cwd":"/p","entrypoint":"claude-desktop","startedAt":started}),
        );
        assert!(turn_of(&AgentEvidence::ClaudeRecord(mute)).is_none());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn two_codex_rollouts_in_one_profile_get_independent_turns() {
        let dir = scratch("codex");
        let working = rollout_at(
            &dir,
            "rollout-2026-09-18T10-00-00-aaaa.jsonl",
            &["task_started"],
        );
        let answered = rollout_at(
            &dir,
            "rollout-2026-09-18T10-05-00-bbbb.jsonl",
            &["task_started", "item_completed", "task_complete"],
        );
        let aborted = rollout_at(
            &dir,
            "rollout-2026-09-18T10-06-00-cccc.jsonl",
            &["task_started", "turn_aborted"],
        );

        assert_eq!(
            turn_of(&AgentEvidence::CodexRollout(working)).map(|turn| turn.state),
            Some(agent_state::TurnState::Busy)
        );
        // A segunda conversa do mesmo perfil nao herda o estado da primeira.
        assert_eq!(
            turn_of(&AgentEvidence::CodexRollout(answered)).map(|turn| turn.state),
            Some(agent_state::TurnState::Done)
        );
        // Turno abortado nao e conclusao: a conversa volta a aberta e parada.
        assert_eq!(
            turn_of(&AgentEvidence::CodexRollout(aborted)).map(|turn| turn.state),
            Some(agent_state::TurnState::Idle)
        );
        assert!(turn_of(&AgentEvidence::CodexRollout(dir.join("nao-existe.jsonl"))).is_none());

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn metrics_carry_the_age_of_the_last_output_and_serialize_the_new_fields() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let shell = pty::TestShell::isolated();
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let prefs = manager.prefs.get();
        let info = manager
            .spawn_for_with_spec(
                shell.cwd(),
                80,
                24,
                CursorPosition::default(),
                "t_age",
                SubscriberKey::Webview,
                sink,
                shell.spec(),
                &prefs,
            )
            .expect("spawn");
        let mut queries = LaterCursorQueries::new("age", &manager, info.id);
        let mut output = Vec::new();
        manager.write(info.id, b"echo idade-da-saida\n").unwrap();
        assert!(collect_until_printed(
            &rx,
            &mut queries,
            &mut output,
            "idade-da-saida"
        ));

        let sample = manager
            .metrics()
            .into_iter()
            .find(|metrics| metrics.tag == "t_age")
            .expect("metrica da sessao");
        let age = sample.output_age_ms.expect("idade da ultima saida");
        assert!(age < 20_000, "a saida acabou de chegar, veio {age} ms");
        // Um shell parado no prompt nao tem agente e, portanto, nao tem turno.
        assert!(sample.agent_turn.is_none());

        let json = serde_json::to_value(&sample).unwrap();
        assert!(json.get("outputAgeMs").is_some(), "camelCase no protocolo");
        assert!(
            json.get("agentTurn").is_none(),
            "campo ausente nao vai no fio"
        );

        manager.kill(info.id).ok();
        let _ = rx;
    }

    /// Contrato de barra normal na fronteira do PTY. No Windows a pasta
    /// resolvida vem com barra invertida e, publicada crua, nunca casava com o
    /// que o explorador e os recentes guardavam.
    /// Conta escolhida na interface chega ao shell novo como variavel de
    /// ambiente. O cliente nunca manda caminho: a pasta sai da preferencia e
    /// da pasta pessoal.
    ///
    /// A ida ao shell fica no POSIX porque a leitura da variavel e escrita na
    /// sintaxe dele. Quais variaveis cada escolha produz, inclusive a pasta que
    /// nao existe e a pasta sem marcador, e o `agent_profiles::env_for` que
    /// responde, com teste proprio e em todo sistema.
    #[cfg(unix)]
    #[test]
    fn the_active_profile_reaches_the_new_shell_as_environment() {
        let home = scratch("perfil-ativo");
        std::fs::create_dir_all(home.join(".codex-work")).unwrap();
        std::fs::write(home.join(".codex-work/auth.json"), "{}").unwrap();
        std::fs::create_dir_all(home.join(".codex")).unwrap();
        std::fs::write(home.join(".codex/config.toml"), "").unwrap();

        let echo = |prefs: &Preferences, tag: &'static str| -> String {
            let manager = TerminalManager::with_notifier(Arc::new(|_| {})).with_home(home.clone());
            let shell = pty::TestShell::isolated();
            let (tx, rx) = channel::<InvokeResponseBody>();
            let sink = Channel::new(move |body| {
                let _ = tx.send(body);
                Ok(())
            });
            let info = manager
                .spawn_for_with_spec(
                    shell.cwd(),
                    80,
                    24,
                    CursorPosition::default(),
                    tag,
                    SubscriberKey::Webview,
                    sink,
                    shell.spec(),
                    prefs,
                )
                .expect("spawn");
            let mut queries = LaterCursorQueries::new(tag, &manager, info.id);
            let mut output = Vec::new();
            manager
                .write(info.id, b"echo \"casa=[$CODEX_HOME]\"\n")
                .unwrap();
            assert!(
                collect_until_printed(&rx, &mut queries, &mut output, "casa=["),
                "{tag}: o shell nao respondeu dentro do prazo"
            );
            manager.kill(info.id).ok();
            String::from_utf8_lossy(&output).to_string()
        };

        let mut named = Preferences::default();
        named.agents.active_profile.set("codex", "codex-work");
        let seen = echo(&named, "t_perfil_nomeado");
        assert!(
            seen.contains(&format!(
                "casa=[{}]",
                crate::platform::to_portable(home.join(".codex-work"))
            )),
            "o perfil nomeado define CODEX_HOME: {seen}"
        );

        // Perfil padrao ativo remove a variavel, para o agente cair no proprio
        // padrao dele.
        let mut default = Preferences::default();
        default.agents.active_profile.set("codex", "codex");
        let seen = echo(&default, "t_perfil_padrao");
        assert!(
            seen.contains("casa=[]"),
            "o perfil padrao tira a variavel: {seen}"
        );

        let _ = std::fs::remove_dir_all(home);
    }

    /// A apresentacao e do card, e o Rust e a fonte de verdade dela. Cada
    /// gravacao recebe uma revisao maior, e e por ela que computador e celular
    /// decidem quem venceu sem um apagar o nome do outro.
    #[test]
    fn every_presentation_write_gets_a_higher_revision() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let shell = pty::TestShell::isolated();
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let prefs = manager.prefs.get();
        let info = manager
            .spawn_for_with_spec(
                shell.cwd(),
                80,
                24,
                CursorPosition::default(),
                "t_presentation",
                SubscriberKey::Webview,
                sink,
                shell.spec(),
                &prefs,
            )
            .expect("spawn");

        let card = |name: &str| TerminalPresentation {
            name: name.to_string(),
            subtitle: String::new(),
            color: None,
            pinned: false,
            order: 0,
            // O cliente nunca escolhe a revisao; o valor enviado e ignorado.
            revision: 999,
        };
        assert_eq!(manager.presentation(info.id, card("primeiro")), Ok(1));
        assert_eq!(manager.presentation(info.id, card("segundo")), Ok(2));
        assert_eq!(manager.presentation(info.id, card("terceiro")), Ok(3));

        let listed = manager
            .list()
            .into_iter()
            .find(|item| item.tag == "t_presentation")
            .expect("sessao na lista");
        let presentation = listed.presentation.expect("apresentacao publicada");
        assert_eq!(presentation.name, "terceiro");
        assert_eq!(presentation.revision, 3);
        assert_eq!(
            serde_json::to_value(&presentation).unwrap()["revision"],
            serde_json::json!(3)
        );

        // Nome invalido nao grava e nao consome revisao.
        let invalid = TerminalPresentation {
            name: "com\u{0007}sino".to_string(),
            ..card("x")
        };
        assert!(manager.presentation(info.id, invalid).is_err());
        assert_eq!(manager.presentation(info.id, card("quarto")), Ok(4));

        manager.kill(info.id).ok();
        let _ = rx;
    }

    #[test]
    fn the_session_publishes_its_folder_in_the_portable_form() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let shell = pty::TestShell::isolated();
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let prefs = manager.prefs.get();
        let info = manager
            .spawn_for_with_spec(
                shell.cwd(),
                80,
                24,
                CursorPosition::default(),
                "t_portable",
                SubscriberKey::Webview,
                sink,
                shell.spec(),
                &prefs,
            )
            .expect("spawn");
        assert!(
            !info.cwd.contains('\\'),
            "a pasta da sessao nao pode sair com barra invertida: {}",
            info.cwd
        );
        #[cfg(windows)]
        assert!(
            info.cwd.as_bytes().get(1) == Some(&b':') && info.cwd.contains('/'),
            "no Windows a pasta sai como C:/..., e nao como C:\\...: {}",
            info.cwd
        );
        manager.kill(info.id).ok();
        let _ = rx;
    }

    #[test]
    fn spawns_a_shell_streams_output_and_reports_exit() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let shell = pty::TestShell::isolated();
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });

        let prefs = manager.prefs.get();
        let info = manager
            .spawn_for_with_spec(
                shell.cwd(),
                80,
                24,
                CursorPosition::default(),
                "t1",
                SubscriberKey::Webview,
                sink,
                shell.spec(),
                &prefs,
            )
            .expect("spawn");
        assert!(info.alive);
        assert_eq!(info.shell_flavor, ShellFlavor::from_path(&info.shell));
        assert_eq!(
            serde_json::to_value(&info).unwrap()["shellFlavor"],
            serde_json::to_value(info.shell_flavor).unwrap()
        );
        assert_eq!(manager.list().len(), 1);
        manager.resize(info.id, 100, 30).expect("resize");
        manager
            .write(info.id, &shell.print("pty-ok-42"))
            .expect("write");
        let mut queries = LaterCursorQueries::new("spawns_a_shell", &manager, info.id);
        let mut printed = Vec::new();
        let seen = collect_until_printed(&rx, &mut queries, &mut printed, "pty-ok-42");
        assert!(seen, "saida: {}", String::from_utf8_lossy(&printed));
        assert_eq!(
            queries.answered, 0,
            "a pergunta de cursor da abertura do ConPTY nao pode chegar ao app"
        );
        manager.write(info.id, &shell.exit_with(3)).expect("write");

        let (_, exit) = collect_until_exit(&rx, &mut queries);
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
        let shell = pty::TestShell::isolated();
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let info = spawn_test_shell(&manager, &shell, "s_journal", SubscriberKey::Webview, sink);
        let saved = manager.saved("s_journal").expect("estado gravado ao abrir");
        // A pasta e publicada na forma portatil, o mesmo contrato do
        // `the_session_publishes_its_folder_in_the_portable_form`.
        assert_eq!(
            (saved.cwd.as_str(), saved.cols, saved.rows),
            (crate::platform::to_portable(shell.cwd()).as_str(), 80, 24)
        );
        assert!(saved.resume.is_none());
        assert_eq!(manager.live_count(), 1);
        manager
            .write(info.id, &shell.print("historico-42"))
            .expect("write");
        let mut queries = LaterCursorQueries::new("history", &manager, info.id);
        let mut printed = Vec::new();
        assert!(collect_until_printed(
            &rx,
            &mut queries,
            &mut printed,
            "historico-42"
        ));
        manager.write(info.id, &shell.exit_with(0)).expect("write");
        let (_, exit) = collect_until_exit(&rx, &mut queries);
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
        let missing = std::env::temp_dir().join(format!(
            "cialai-missing-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&missing);
        let error = manager
            .spawn(
                &missing.to_string_lossy(),
                80,
                24,
                CursorPosition::default(),
                "t2",
                sink,
            )
            .unwrap_err();
        assert!(error.contains("Pasta não encontrada"));
    }

    /// Marca o processo de teste que roda com o ambiente simulado de um AppImage.
    #[cfg(unix)]
    const APPIMAGE_TEST_CHILD: &str = "CIALAI_TEST_APPIMAGE_PTY";

    /// Abre um PTY real num processo de teste próprio, com as variáveis que o `AppRun` e
    /// o hook do GTK exportam e a pasta dentro do bundle, e confere pelo `env` do shell
    /// que nenhuma variável aponta para o `APPDIR`. O ambiente simulado existe só nesse
    /// processo; os outros testes seguem com o ambiente de sempre.
    #[cfg(unix)]
    #[test]
    fn appimage_environment_never_reaches_the_shell() {
        if std::env::var_os(APPIMAGE_TEST_CHILD).is_some() {
            return appimage_shell_in_simulated_bundle();
        }
        let home = std::env::temp_dir().canonicalize().unwrap();
        let appdir = home.join(format!(".mount_CialaiTeste{}", std::process::id()));
        let usr = appdir.join("usr");
        std::fs::create_dir_all(&usr).unwrap();
        let bundle = |rest: &str| format!("{}{rest}", appdir.display());
        let mut path = vec![bundle("/usr/bin/"), bundle("/usr/sbin/"), String::new()];
        path.extend(
            std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
                .map(|entry| entry.to_string_lossy().into_owned()),
        );
        path.push(String::new());

        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "workspace::terminal::tests::appimage_environment_never_reaches_the_shell",
                "--nocapture",
            ])
            .current_dir(&usr)
            .env(APPIMAGE_TEST_CHILD, "1")
            .env("HOME", &home)
            .env("PWD", &usr)
            .env("APPDIR", &appdir)
            .env("APPIMAGE", home.join("Cialai_amd64.AppImage"))
            .env("ARGV0", "./Cialai_amd64.AppImage")
            .env("OWD", &home)
            .env("PATH", path.join(":"))
            .env(
                "LD_LIBRARY_PATH",
                format!(
                    "{}:{}:",
                    bundle("/usr/lib/"),
                    bundle("/usr/lib/x86_64-linux-gnu/")
                ),
            )
            .env("PYTHONHOME", bundle("/usr/"))
            .env(
                "PYTHONPATH",
                format!(
                    "{}:/opt/cialai-teste/python",
                    bundle("/usr/share/pyshared/")
                ),
            )
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .env("PERLLIB", format!("{}:", bundle("/usr/share/perl5/")))
            .env(
                "QT_PLUGIN_PATH",
                format!("{}:", bundle("/usr/lib/qt5/plugins/")),
            )
            .env(
                "GST_PLUGIN_SYSTEM_PATH_1_0",
                format!("{}:", bundle("/usr/lib/gstreamer-1.0")),
            )
            .env("GDK_BACKEND", "x11")
            .env("GTK_THEME", "Adwaita:light")
            .env("GTK_PATH", bundle("//usr/lib/gtk-3.0"))
            .env("GTK_EXE_PREFIX", bundle("//usr"))
            .env("GTK_DATA_PREFIX", &appdir)
            .env(
                "GTK_IM_MODULE_FILE",
                bundle("//usr/lib/gtk-3.0/3.0.0/immodules.cache"),
            )
            .env(
                "GDK_PIXBUF_MODULE_FILE",
                bundle("//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"),
            )
            .env("GIO_EXTRA_MODULES", bundle("//usr/lib/gio/modules"))
            .env(
                "GSETTINGS_SCHEMA_DIR",
                bundle("//usr/share/glib-2.0/schemas"),
            )
            .env(
                "XDG_DATA_DIRS",
                format!(
                    "{}:{}:/usr/share:",
                    bundle("/usr/share/"),
                    bundle("/usr/share")
                ),
            )
            .output()
            .unwrap();
        let _ = std::fs::remove_dir_all(&appdir);
        let stdout = String::from_utf8_lossy(&output.stdout);
        // Um filtro que não casasse rodaria zero testes e sairia com sucesso.
        assert!(
            output.status.success() && stdout.contains("test result: ok. 1 passed"),
            "processo com ambiente de AppImage falhou:\n{stdout}\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[cfg(unix)]
    fn appimage_shell_in_simulated_bundle() {
        let appdir = std::env::var("APPDIR").expect("APPDIR simulado");
        let home = PathBuf::from(std::env::var_os("HOME").expect("HOME simulado"));
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let shell = pty::TestShell::isolated();
        let (channel, rx) = sink();
        let prefs = manager.prefs.get();
        // Sem pasta pedida o shell abre na pasta pessoal, não na pasta herdada do bundle.
        let info = manager
            .spawn_for_with_spec(
                "",
                200,
                24,
                CursorPosition::default(),
                "appimage",
                SubscriberKey::Webview,
                channel,
                shell.spec(),
                &prefs,
            )
            .expect("spawn");
        assert_eq!(Path::new(&info.cwd), home);
        manager
            .write(
                info.id,
                b"env; printf 'pasta=%s\\n' \"$(pwd -P)\"; exit 0\n",
            )
            .expect("write");
        let mut queries = LaterCursorQueries::new("appimage", &manager, info.id);
        let (output, exit) = collect_until_exit(&rx, &mut queries);
        let output = String::from_utf8_lossy(&output).replace('\r', "");
        assert!(exit.is_some(), "o shell não terminou: {output}");
        let variable = |name: &str| {
            output
                .lines()
                .find_map(|line| line.strip_prefix(&format!("{name}=")))
                .map(str::to_string)
        };
        assert_eq!(
            variable("TERM_PROGRAM").as_deref(),
            Some("Cialai"),
            "{output}"
        );
        assert!(
            !output.contains(&appdir),
            "o bundle vazou para o shell:\n{output}"
        );
        for name in [
            "APPDIR",
            "APPIMAGE",
            "ARGV0",
            "OWD",
            "PYTHONHOME",
            "PYTHONDONTWRITEBYTECODE",
            "LD_LIBRARY_PATH",
            "PERLLIB",
            "QT_PLUGIN_PATH",
            "GDK_BACKEND",
            "GTK_THEME",
            "GTK_PATH",
            "GIO_EXTRA_MODULES",
            "GSETTINGS_SCHEMA_DIR",
        ] {
            assert_eq!(variable(name), None, "{name} chegou ao shell:\n{output}");
        }
        assert_eq!(
            variable("PYTHONPATH").as_deref(),
            Some("/opt/cialai-teste/python")
        );
        assert_eq!(variable("XDG_DATA_DIRS").as_deref(), Some("/usr/share"));
        let path = variable("PATH").expect("PATH no shell");
        assert!(
            !path.split(':').any(str::is_empty),
            "PATH com entrada vazia: {path}"
        );
        assert!(
            output.contains(&format!("pasta={}", home.display())),
            "pasta do shell:\n{output}"
        );
    }

    #[test]
    fn kill_ends_the_session() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let shell = pty::TestShell::isolated();
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let prefs = manager.prefs.get();
        let info = manager
            .spawn_for_with_spec(
                shell.cwd(),
                80,
                24,
                CursorPosition::default(),
                "t1",
                SubscriberKey::Webview,
                sink,
                shell.spec(),
                &prefs,
            )
            .expect("spawn");
        manager.kill(info.id).expect("kill");
        let mut queries = LaterCursorQueries::new("kill", &manager, info.id);
        let (_, exit) = collect_until_exit(&rx, &mut queries);
        assert!(exit.is_some(), "o fim da sessao deve chegar pelo canal");
        assert!(manager.list().is_empty());
    }

    #[test]
    fn metrics_follow_the_foreground_job_and_measure_cpu() {
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let shell = pty::TestShell::isolated();
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let info = spawn_test_shell(&manager, &shell, "m1", SubscriberKey::Webview, sink);
        let reader = drain_until_exit_in_background(
            rx,
            LaterCursorQueries::new("metrics", &manager, info.id),
        );
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
        manager.write(info.id, &shell.burn_cpu()).expect("write");
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut seen = None;
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(250));
            let sample = manager.metrics().remove(0);
            if let Some(foreground) = &sample.foreground {
                if shell.cpu_process(&foreground.command) {
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
        assert!(shell.cpu_process(&foreground.command));
        assert!(foreground.agent.is_none());
        assert!(cpu > 20.0 && cpu < 800.0, "cpu fora da faixa: {cpu}");
        assert!(
            memory.unwrap_or(0) > 100 * 1024,
            "memoria da arvore muito baixa"
        );

        // O exit só vai depois de o job sair do primeiro plano: no Windows a linha digitada
        // junto do Ctrl C se perde enquanto o console entrega o sinal ao processo. Na CI do
        // Windows o PowerShell às vezes ignorou o primeiro Ctrl C, então ele se repete a
        // cada 3 s, como faria quem está no teclado.
        let deadline = Instant::now() + Duration::from_secs(15);
        let mut next_interrupt = Instant::now();
        let mut interrupted = false;
        while Instant::now() < deadline {
            if Instant::now() >= next_interrupt {
                manager.write(info.id, &[0x03]).expect("ctrl-c");
                next_interrupt = Instant::now() + Duration::from_secs(3);
            }
            thread::sleep(Duration::from_millis(100));
            if manager
                .metrics()
                .first()
                .is_some_and(|sample| sample.foreground.is_none())
            {
                interrupted = true;
                break;
            }
        }
        assert!(
            interrupted,
            "o Ctrl C deveria encerrar o job em primeiro plano"
        );
        manager.write(info.id, &shell.exit()).expect("exit");
        let exit = reader.join().expect("leitor do terminal");
        assert!(exit.is_some());
        assert!(manager.metrics().is_empty());
    }

    #[test]
    fn metrics_use_the_injected_process_source() {
        use super::procs::{CommandLine, FakeProcs, ProcInfo, ProcState, Usage};

        let fake = Arc::new(FakeProcs::default());
        let manager = TerminalManager::with_proc_source(Arc::new(|_| {}), fake.clone());
        struct Cleanup(TerminalManager);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.kill_all_blocking();
            }
        }
        let _cleanup = Cleanup(manager.clone());
        let test_shell = pty::TestShell::isolated();
        let info = spawn_test_shell(
            &manager,
            &test_shell,
            "fake-metrics",
            SubscriberKey::Webview,
            Channel::new(|_| Ok(())),
        );
        let shell = info.pid.expect("pid do shell");
        let agent = shell.saturating_add(10_000);
        fake.set_children(shell, vec![agent]);
        fake.set_info(ProcInfo {
            pid: shell,
            ppid: std::process::id(),
            pgid: shell,
            state: ProcState::Sleeping,
            comm: "zsh".into(),
            name: "zsh".into(),
            start_sec: 10,
        });
        fake.set_info(ProcInfo {
            pid: agent,
            ppid: shell,
            pgid: agent,
            state: ProcState::Running,
            comm: "node".into(),
            name: "node".into(),
            start_sec: 11,
        });
        fake.set_usages(
            shell,
            [
                Usage {
                    cpu_nanos: 1_000,
                    footprint: 4_096,
                },
                Usage {
                    cpu_nanos: 2_000_000,
                    footprint: 4_096,
                },
            ],
        );
        fake.set_usages(
            agent,
            [
                Usage {
                    cpu_nanos: 2_000,
                    footprint: 8_192,
                },
                Usage {
                    cpu_nanos: 4_000_000,
                    footprint: 8_192,
                },
            ],
        );
        fake.set_command(
            agent,
            CommandLine {
                exe: "/opt/cialai/bin/claude".into(),
                argv: vec!["claude".into()],
                ..Default::default()
            },
        );
        fake.set_name(agent, "claude");
        let project = std::env::temp_dir().join("projeto");
        fake.set_cwd(shell, project.to_string_lossy());

        let first = manager.metrics().remove(0);
        assert_eq!(first.cpu_percent, None);
        std::thread::sleep(Duration::from_millis(10));
        let second = manager.metrics().remove(0);
        assert_eq!(second.processes, 2);
        assert_eq!(second.memory_bytes, Some(12_288));
        assert!(second.cpu_percent.is_some_and(|cpu| cpu > 0.0));
        assert_eq!(second.agent.as_deref(), Some("Claude Code"));
        assert_eq!(second.agent_profile.as_deref(), Some("claude"));
        assert_eq!(
            second.shell_cwd.as_deref(),
            Some(project.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn metrics_take_the_agent_profile_from_the_cli_behind_a_launcher() {
        use super::procs::{FakeProcs, ProcInfo, Usage};

        let fake = Arc::new(FakeProcs::default());
        let manager = TerminalManager::with_proc_source(Arc::new(|_| {}), fake.clone());
        struct Cleanup(TerminalManager);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.kill_all_blocking();
            }
        }
        let _cleanup = Cleanup(manager.clone());
        let test_shell = pty::TestShell::isolated();
        let info = spawn_test_shell(
            &manager,
            &test_shell,
            "lancador",
            SubscriberKey::Webview,
            Channel::new(|_| Ok(())),
        );
        let shell = info.pid.expect("pid do shell");
        let launcher = shell.saturating_add(10_000);
        let agent = shell.saturating_add(10_001);
        fake.set_children(shell, vec![launcher]);
        fake.set_children(launcher, vec![agent]);
        for (pid, ppid, name) in [
            (shell, std::process::id(), "sh"),
            (launcher, shell, "python3"),
            (agent, launcher, "codex"),
        ] {
            fake.set_info(ProcInfo {
                pid,
                ppid,
                pgid: launcher,
                comm: name.into(),
                name: name.into(),
                start_sec: 10,
                ..Default::default()
            });
            fake.set_usages(
                pid,
                [Usage {
                    cpu_nanos: 1,
                    footprint: 1,
                }],
            );
        }
        // O lancador cita o agente no argumento, sem o perfil no ambiente.
        fake.set_command(
            launcher,
            CommandLine {
                exe: "/usr/bin/python3".into(),
                argv: vec![
                    "python3".into(),
                    "/h/.local/lib/webrota-ai/wrai.py".into(),
                    "codex".into(),
                ],
                ..Default::default()
            },
        );
        fake.set_command(
            agent,
            CommandLine {
                exe: "/h/.codex/packages/standalone/current/bin/codex".into(),
                argv: vec!["codex".into()],
                env: HashMap::from([(
                    "CODEX_HOME".to_string(),
                    "/h/.local/share/webrota-ai/codex/7".to_string(),
                )]),
            },
        );

        let sample = manager.metrics().remove(0);
        assert_eq!(sample.processes, 3);
        assert_eq!(sample.agent.as_deref(), Some("Codex"));
        assert_eq!(sample.agent_profile.as_deref(), Some("7"));
        let homes = manager.codex_homes();
        assert_eq!(homes.len(), 1, "{homes:?}");
        assert!(homes[0].to_string_lossy().ends_with("codex/7"), "{homes:?}");
    }

    /// Lancador do teste abaixo, como o `python3 wrai.py claude` de quem usa
    /// perfis: abre o agente de `CIALAI_TEST_AGENT` com o perfil so no
    /// ambiente do filho e espera por ele.
    #[test]
    fn metrics_launcher_helper_opens_the_agent() {
        let Ok(agent) = std::env::var("CIALAI_TEST_AGENT") else {
            return;
        };
        let mut child = std::process::Command::new(agent)
            .args([
                "--exact",
                "workspace::terminal::tests::metrics_load_helper_holds_cpu_and_memory",
                "--nocapture",
            ])
            .env(
                "CLAUDE_CONFIG_DIR",
                std::env::var("CIALAI_TEST_PROFILE").unwrap(),
            )
            .env("CIALAI_TEST_ALLOC_MB", "200")
            .spawn()
            .unwrap();
        let _ = child.wait();
    }

    /// Carga do agente de teste: toca a memoria pedida e ocupa um nucleo ate o
    /// teste principal encerrar a sessao.
    #[test]
    fn metrics_load_helper_holds_cpu_and_memory() {
        let Ok(megabytes) = std::env::var("CIALAI_TEST_ALLOC_MB") else {
            return;
        };
        let block = vec![1u8; megabytes.parse::<usize>().unwrap() * 1024 * 1024];
        let deadline = Instant::now() + Duration::from_secs(45);
        let mut spins = 0u64;
        while Instant::now() < deadline {
            spins = std::hint::black_box(spins.wrapping_add(1));
        }
        std::hint::black_box(&block);
    }

    /// Soma do PSS da arvore lida direto do `/proc`, a referencia do Linux.
    #[cfg(target_os = "linux")]
    fn proc_pss_of_tree(root: u32) -> u64 {
        let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
        for entry in std::fs::read_dir("/proc").unwrap().flatten() {
            let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
                continue;
            };
            let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
                continue;
            };
            let Some(close) = stat.rfind(')') else {
                continue;
            };
            if let Some(ppid) = stat[close + 1..]
                .split_ascii_whitespace()
                .nth(1)
                .and_then(|value| value.parse::<u32>().ok())
            {
                children.entry(ppid).or_default().push(pid);
            }
        }
        let mut tree = vec![root];
        let mut index = 0;
        while index < tree.len() {
            tree.extend(children.get(&tree[index]).cloned().unwrap_or_default());
            index += 1;
        }
        tree.iter()
            .filter_map(|pid| std::fs::read_to_string(format!("/proc/{pid}/smaps_rollup")).ok())
            .filter_map(|rollup| {
                rollup
                    .lines()
                    .find(|line| line.starts_with("Pss:"))
                    .and_then(|line| line.split_ascii_whitespace().nth(1))
                    .and_then(|value| value.parse::<u64>().ok())
            })
            .sum::<u64>()
            * 1024
    }

    /// Ponta a ponta num PTY real: o shell troca de pasta, um lancador abre o
    /// agente com o perfil so no ambiente do filho, e o agente ocupa um nucleo
    /// e 200 MB. As metricas precisam seguir a pasta nova, achar o perfil do
    /// agente e medir CPU e memoria na ordem de grandeza da carga.
    #[cfg(unix)]
    #[test]
    fn metrics_follow_cwd_agent_profile_cpu_and_memory_of_a_launched_agent() {
        let root =
            std::env::temp_dir().join(format!("cialai-metricas-agente-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // O kernel devolve a pasta resolvida, como /private/var no macOS.
        let root = root.canonicalize().unwrap();
        let bin = root.join("bin");
        let profile = root.join("perfis").join("conta-7");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&profile).unwrap();
        let exe = std::env::current_exe().unwrap();
        for name in ["python3", "claude"] {
            let _ = std::fs::remove_file(bin.join(name));
            std::os::unix::fs::symlink(&exe, bin.join(name)).unwrap();
        }
        struct Cleanup(TerminalManager, PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.kill_all_blocking();
                let _ = std::fs::remove_dir_all(&self.1);
            }
        }
        let manager = TerminalManager::with_notifier(Arc::new(|_| {}));
        let _cleanup = Cleanup(manager.clone(), root.clone());
        let shell = pty::TestShell::isolated();
        let (tx, rx) = channel::<InvokeResponseBody>();
        let sink = Channel::new(move |body| {
            let _ = tx.send(body);
            Ok(())
        });
        let info = spawn_test_shell(&manager, &shell, "agente", SubscriberKey::Webview, sink);
        let _reader = drain_until_exit_in_background(
            rx,
            LaterCursorQueries::new("agente", &manager, info.id),
        );
        let pid = info.pid.expect("pid do shell");

        // A primeira leitura ve o shell na pasta inicial; a troca vem depois.
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let sample = manager.metrics();
            if sample.first().is_some_and(|sample| {
                sample.available && sample.foreground.is_none() && sample.shell_cwd.is_some()
            }) {
                break;
            }
            thread::sleep(Duration::from_millis(100));
        }
        let quote = |path: &Path| format!("'{}'", path.display());
        let command = format!(
            "cd {}; unset CLAUDE_CONFIG_DIR CODEX_HOME; CIALAI_TEST_AGENT={} CIALAI_TEST_PROFILE={} {} --exact workspace::terminal::tests::metrics_launcher_helper_opens_the_agent claude\n",
            quote(&root),
            quote(&bin.join("claude")),
            quote(&profile),
            quote(&bin.join("python3")),
        );
        manager.write(info.id, command.as_bytes()).expect("write");

        let expected_cwd = root.to_string_lossy().to_string();
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut last = None;
        let mut passed = false;
        while Instant::now() < deadline {
            thread::sleep(Duration::from_secs(1));
            let sample = manager.metrics().remove(0);
            let foreground = sample.foreground.clone();
            let memory = sample.memory_bytes.unwrap_or(0);
            let ok = sample.shell_cwd.as_deref() == Some(expected_cwd.as_str())
                && foreground.as_ref().and_then(|value| value.agent.as_deref())
                    == Some("Claude Code")
                && foreground
                    .as_ref()
                    .and_then(|value| value.profile.as_deref())
                    == Some("conta-7")
                && sample.agent_profile.as_deref() == Some("conta-7")
                && sample.cpu_percent.is_some_and(|cpu| cpu > 20.0)
                && memory >= 150 * 1024 * 1024;
            let _ = writeln!(
                std::io::stderr(),
                "[cialai-test] agente: cpu={:?} memoria={} MB processos={} pasta={:?} primeiro plano={:?} perfil={:?}/{:?}",
                sample.cpu_percent,
                memory / 1024 / 1024,
                sample.processes,
                sample.shell_cwd,
                foreground
                    .as_ref()
                    .map(|value| (&value.command, &value.agent)),
                foreground.as_ref().and_then(|value| value.profile.clone()),
                sample.agent_profile,
            );
            last = Some(sample);
            if ok {
                passed = true;
                break;
            }
        }
        let sample = last.expect("amostra das metricas");
        assert!(
            passed,
            "metricas do agente lancado fora do esperado: {sample:?}"
        );
        let cpu = sample.cpu_percent.unwrap();
        let cores = thread::available_parallelism().map_or(1, |value| value.get()) as f32;
        assert!(cpu < cores * 100.0 + 50.0, "cpu acima dos nucleos: {cpu}");
        let memory = sample.memory_bytes.unwrap();
        assert!(
            memory < 2 * 1024 * 1024 * 1024,
            "memoria fora da ordem da carga: {memory}"
        );
        #[cfg(target_os = "linux")]
        {
            let reference = proc_pss_of_tree(pid) as f64;
            let measured = memory as f64;
            assert!(
                (measured - reference).abs() <= reference * 0.2,
                "memoria {measured} longe do PSS do /proc {reference}"
            );
        }
        #[cfg(not(target_os = "linux"))]
        let _ = pid;
        manager.write(info.id, &[0x03]).expect("ctrl-c");
    }
}
