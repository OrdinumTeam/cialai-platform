// SPDX-License-Identifier: Apache-2.0

use std::collections::{HashMap, VecDeque};
use std::ffi::OsStr;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, Weak, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::bridge::{BridgeControl, IdentityControl};
use crate::platform::{self, child_env};

use super::awake::Awake;
use super::credentials::ApiKeyStore;
use super::protocol::{
    EventFrame, Inbound, MAX_LINE_BYTES, PROTOCOL_VERSION, RpcProblem, encode_request,
    event_channel, parse_line,
};
use super::{MobileSite, bundled_tor_executable};

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
// Approval and execution are operational deadlines, not sidecar health checks.
fn command_timeout(command: &str) -> Duration {
    if command == "broto.call" {
        Duration::from_secs(40 * 60 + 30)
    } else {
        CALL_TIMEOUT
    }
}
fn invalidates_process(command: &str, code: &str) -> bool {
    code == "tunnel_disconnected" || (code == "tunnel_timeout" && command != "broto.call")
}
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESTARTS: usize = 10;
/// Janela em que `MAX_RESTARTS` inícios do sidecar são admitidos, somando os do
/// ciclo de reinício e os pedidos diretos da interface. Esgotada, nenhum
/// sidecar nasce até o início mais antigo sair da janela, para um crash loop
/// não multiplicar processos a cada chamada da interface.
const RESTART_WINDOW: Duration = Duration::from_secs(10 * 60);
const RESTART_LIMIT_CODE: &str = "tunnel_restart_limit";
const SIDECAR_NAME: &str = if cfg!(windows) {
    "cialai-tunnel.exe"
} else {
    "cialai-tunnel"
};

/// Comandos cujos argumentos de borda pertencem ao supervisor: `staticDir`,
/// `bridgeUrl` e `proxySecret` são sempre injetados aqui e o que vier da
/// interface nesses campos é descartado.
const EDGE_COMMANDS: &[&str] = &["net.start"];

/// Comandos que só o supervisor envia; a chamada genérica os recusa.
const NATIVE_ONLY_COMMANDS: &[&str] = &["hello", "shutdown", "edge.serve", "edge.stop"];

type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;
type PendingResult = Result<Value, RpcProblem>;

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl RpcProblem {
    fn local(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
        }
    }
}

#[derive(Clone)]
pub struct BridgeSession {
    port: u16,
    secret: String,
}

impl BridgeSession {
    pub fn generate(port: u16) -> Result<Self, String> {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes)
            .map_err(|error| format!("não foi possível proteger a ponte: {error}"))?;
        Ok(Self {
            port,
            secret: base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes),
        })
    }

    pub fn new(port: u16, secret: String) -> Self {
        Self { port, secret }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn secret(&self) -> &str {
        &self.secret
    }
}

#[derive(Clone)]
struct LaunchConfig {
    binary: PathBuf,
    binary_args: Vec<String>,
    tor_binary: Option<PathBuf>,
    state_dir: PathBuf,
    static_dir: PathBuf,
    bridge: BridgeSession,
    parent_pid: u32,
}

impl LaunchConfig {
    /// O sidecar descobre o Tor só por este argumento; ele nunca procura o
    /// binário por conta própria.
    fn append_tor(&self, command: &mut Command) {
        if let Some(tor) = &self.tor_binary {
            command.arg("--tor-bin").arg(tor);
        }
    }
}

#[derive(Clone)]
struct ProcessHandle {
    generation: u64,
    ready: Arc<AtomicBool>,
    stdin: mpsc::SyncSender<StdioRequest>,
    child: Arc<Mutex<Child>>,
    /// No Windows o sidecar e o `tor` que ele abre vivem neste Job Object com
    /// `KILL_ON_JOB_CLOSE`: se o app morre, o sistema fecha o handle e leva a
    /// árvore inteira. Nos outros sistemas o sidecar sai no fim do stdin e o
    /// `tor` sai sozinho ao perder o controle que o possui.
    #[cfg(target_os = "windows")]
    job: crate::platform::win_job::JobHandle,
}

struct StdioRequest {
    id: u64,
    line: String,
    deadline: Instant,
}

// A single bounded writer owns the pipe. Callers can time out even while the
// OS pipe is full; killing our child then releases the writer. A queued call
// that already expired is never sent into a later operation.
fn write_input(
    owner: Weak<Inner>,
    generation: u64,
    mut stdin: ChildStdin,
    requests: mpsc::Receiver<StdioRequest>,
) {
    for request in requests {
        if Instant::now() >= request.deadline {
            continue;
        }
        let current = owner.upgrade().is_some_and(|owner| {
            lock(&owner.pending)
                .get(&request.id)
                .is_some_and(|(epoch, _)| *epoch == generation)
        });
        if !current {
            continue;
        }
        if let Err(error) = stdin
            .write_all(request.line.as_bytes())
            .and_then(|_| stdin.flush())
        {
            if let Some(owner) = owner.upgrade() {
                owner.fail_pending(
                    Some(generation),
                    RpcProblem::local(
                        "tunnel_disconnected",
                        format!("O sidecar fechou a entrada stdio: {error}"),
                        true,
                    ),
                );
            }
            break;
        }
    }
}

impl ProcessHandle {
    /// Recolhe o que restou da árvore depois que o sidecar saiu ou foi morto.
    fn collect_tree(&self) {
        #[cfg(target_os = "windows")]
        let _ = self.job.terminate();
    }

    fn kill(&self) {
        let _ = lock(&self.child).kill();
        let _ = lock(&self.child).wait();
        self.collect_tree();
    }
}

/// Inícios do sidecar numa janela deslizante de `RESTART_WINDOW`.
struct RestartBudget {
    attempts: VecDeque<Instant>,
}

impl RestartBudget {
    fn new() -> Self {
        Self {
            attempts: VecDeque::new(),
        }
    }

    /// Admite um início em `now` ou devolve quanto falta para o próximo.
    fn admit(&mut self, now: Instant) -> Result<(), Duration> {
        while self
            .attempts
            .front()
            .is_some_and(|&at| now.duration_since(at) >= RESTART_WINDOW)
        {
            self.attempts.pop_front();
        }
        if self.attempts.len() >= MAX_RESTARTS {
            let oldest = self.attempts[0];
            return Err(RESTART_WINDOW - now.duration_since(oldest));
        }
        self.attempts.push_back(now);
        Ok(())
    }
}

struct Inner {
    launch: LaunchConfig,
    events: EventSink,
    bridge: Arc<dyn IdentityControl>,
    secrets: ApiKeyStore,
    awake: Awake,
    next_id: AtomicU64,
    next_generation: AtomicU64,
    process: Mutex<Option<ProcessHandle>>,
    pending: Mutex<HashMap<u64, (u64, mpsc::SyncSender<PendingResult>)>>,
    start_gate: Mutex<()>,
    stopping: AtomicBool,
    restart_active: AtomicBool,
    restarts: Mutex<RestartBudget>,
    retry_wait: Mutex<()>,
    retry_wake: Condvar,
}

#[derive(Clone)]
pub struct Supervisor {
    inner: Arc<Inner>,
}

impl Supervisor {
    pub fn for_app(
        app: &AppHandle,
        mobile_site: &MobileSite,
        bridge: BridgeSession,
        bridge_control: BridgeControl,
        awake: Awake,
    ) -> Result<Self, String> {
        let binary = resolve_binary().map_err(|error| {
            crate::diagnostics::note(&format!("[tunnel] sidecar não encontrado: {error}"));
            error
        })?;
        // Uma linha no `app.log` diz de onde o sidecar saiu: no Linux o caminho
        // muda entre AppImage, deb e rpm, e é a primeira coisa a conferir
        // quando a rede não sobe numa instalação de cliente.
        crate::diagnostics::note(&format!("[tunnel] sidecar em {}", binary.display()));
        let tor_binary = resolve_tor_binary(app)?;
        let state_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("diretório local do túnel indisponível: {error}"))?
            .join("tunnel");
        let sink_app = app.clone();
        Ok(Self::new(
            LaunchConfig {
                binary,
                binary_args: Vec::new(),
                tor_binary: Some(tor_binary),
                state_dir: state_dir.clone(),
                static_dir: mobile_site.static_dir().to_path_buf(),
                bridge,
                parent_pid: std::process::id(),
            },
            Arc::new(move |channel, payload| {
                if let Some(manager) =
                    sink_app.try_state::<crate::workspace::terminal::TerminalManager>()
                {
                    manager.broto_event(payload["event"].as_str().unwrap_or(""), &payload["data"]);
                }
                let _ = sink_app.emit(channel, payload);
            }),
            Arc::new(bridge_control),
            ApiKeyStore::new(state_dir.join("headscale-api-key")),
            awake,
        ))
    }

    fn new(
        launch: LaunchConfig,
        events: EventSink,
        bridge: Arc<dyn IdentityControl>,
        secrets: ApiKeyStore,
        awake: Awake,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                launch,
                events,
                bridge,
                secrets,
                awake,
                next_id: AtomicU64::new(1),
                next_generation: AtomicU64::new(1),
                process: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                start_gate: Mutex::new(()),
                stopping: AtomicBool::new(false),
                restart_active: AtomicBool::new(false),
                restarts: Mutex::new(RestartBudget::new()),
                retry_wait: Mutex::new(()),
                retry_wake: Condvar::new(),
            }),
        }
    }

    pub fn call(&self, command: &str, args: Value) -> PendingResult {
        if NATIVE_ONLY_COMMANDS.contains(&command) {
            return Err(RpcProblem::local(
                "command_sensitive",
                "Este comando do túnel é reservado ao aplicativo.",
                false,
            ));
        }
        let args = self.inner.prepare_args(command, args)?;
        self.inner.ensure_started()?;
        let process = self.inner.ready_process()?;
        let result = self
            .inner
            .send_on(&process, command, args.clone(), command_timeout(command));
        let result = match result {
            Ok(result) => result,
            Err(problem) => {
                if invalidates_process(command, &problem.code) {
                    // Only our exact child is invalidated, never a PID-file owner.
                    let _gate = lock(&self.inner.start_gate);
                    self.inner.fail_start(&process);
                    self.inner
                        .fail_pending(Some(process.generation), problem.clone());
                    // A delayed failure from an older generation must not
                    // announce another recovery after its replacement is ready.
                    if !self.inner.stopping.load(Ordering::SeqCst)
                        && self.inner.ready_process().is_err()
                    {
                        self.inner.schedule_restart();
                    }
                }
                return Err(problem);
            }
        };
        self.inner.sync_bridge_call(command, &args, &result);
        if command == "net.start" {
            // A ponte precisa dos nomes dos celulares antes da primeira
            // conexão, mesmo que a interface ainda não tenha listado.
            if let Ok(devices) =
                self.inner
                    .send_on(&process, "devices.list", json!({}), CALL_TIMEOUT)
            {
                self.inner
                    .sync_bridge_call("devices.list", &json!({}), &devices);
            }
        }
        Ok(result)
    }

    pub fn delete_api_key(&self) -> Result<(), RpcProblem> {
        self.inner
            .secrets
            .delete()
            .map_err(|message| RpcProblem::local("keyring_unavailable", message, false))
    }

    pub fn doctor(&self) -> PendingResult {
        let mut command = Command::new(&self.inner.launch.binary);
        command
            .arg("doctor")
            .arg("--state-dir")
            .arg(&self.inner.launch.state_dir)
            .stdin(Stdio::null())
            .stderr(Stdio::null());
        self.inner.launch.append_tor(&mut command);
        child_env::sanitize(&mut command);
        platform::configure_background_command(&mut command);
        let output = command.output().map_err(|error| {
            RpcProblem::local(
                "doctor_unavailable",
                format!("Não foi possível abrir o diagnóstico do túnel: {error}"),
                true,
            )
        })?;
        let result: Value = serde_json::from_slice(&output.stdout).map_err(|_| {
            RpcProblem::local(
                "doctor_invalid",
                "O diagnóstico do túnel devolveu uma resposta inválida.",
                false,
            )
        })?;
        if !result.is_object() {
            return Err(RpcProblem::local(
                "doctor_invalid",
                "O diagnóstico do túnel devolveu uma resposta inválida.",
                false,
            ));
        }
        Ok(result)
    }

    pub fn shutdown_blocking(&self) {
        self.inner.shutdown();
    }
}

impl Inner {
    /// Eventos do sidecar atualizam as identidades da ponte e a contagem de
    /// sessões da vigília antes de seguir para a interface.
    fn observe_event(&self, event: &EventFrame) {
        self.sync_bridge_event(event);
        self.awake.observe(event);
    }

    /// Mantém a ponte com o computador e os celulares do registro v2: nome e
    /// id do computador pelo `NetStatus`, e `deviceKey` de cada celular.
    fn sync_bridge_call(&self, command: &str, _args: &Value, result: &Value) {
        match command {
            "net.start" | "net.status" | "net.refresh" => {
                if let Some(desktop) = result.get("desktop") {
                    self.bridge.set_desktop(desktop);
                }
            }
            "devices.list" => self.bridge.sync_devices(result),
            "devices.rename" => self.bridge.upsert_device(result),
            _ => {}
        }
    }

    fn sync_bridge_event(&self, event: &EventFrame) {
        match event.name.as_str() {
            "net.state" => {
                if let Some(desktop) = event.data.get("desktop") {
                    self.bridge.set_desktop(desktop);
                }
            }
            "pair.completed" => {
                if let Some(device) = event.data.get("device") {
                    self.bridge.upsert_device(device);
                }
            }
            "devices.changed" => {
                let Some(device_id) = event.data.get("deviceId").and_then(Value::as_str) else {
                    return;
                };
                if event.data.get("revoked").and_then(Value::as_bool) == Some(true) {
                    self.bridge.revoke_device(device_id);
                } else if let Some(name) = event.data.get("name").and_then(Value::as_str) {
                    self.bridge.rename_device(device_id, name);
                }
            }
            _ => {}
        }
    }

    fn prepare_args(&self, command: &str, mut args: Value) -> Result<Value, RpcProblem> {
        if !args.is_object() {
            return Err(RpcProblem::local(
                "args_invalid",
                "Os argumentos do túnel precisam formar um objeto.",
                false,
            ));
        }
        if !EDGE_COMMANDS.contains(&command) {
            return Ok(args);
        }
        let object = args.as_object_mut().expect("checked object");
        object.insert(
            "staticDir".into(),
            Value::String(self.launch.static_dir.to_string_lossy().into_owned()),
        );
        object.insert(
            "bridgeUrl".into(),
            Value::String(format!("http://127.0.0.1:{}", self.launch.bridge.port())),
        );
        object.insert(
            "proxySecret".into(),
            Value::String(self.launch.bridge.secret().to_owned()),
        );
        Ok(args)
    }

    fn ensure_started(self: &Arc<Self>) -> Result<(), RpcProblem> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err(RpcProblem::local(
                "tunnel_stopping",
                "O núcleo do túnel está encerrando.",
                true,
            ));
        }
        let _gate = lock(&self.start_gate);
        if self
            .process
            .lock()
            .map(|process| {
                process
                    .as_ref()
                    .is_some_and(|process| process.ready.load(Ordering::SeqCst))
            })
            .unwrap_or(false)
        {
            return Ok(());
        }
        match self.start_once() {
            Ok(()) => Ok(()),
            Err(problem) => {
                // Recovery also remains armed while the start budget cools
                // down, so an initial failure never needs an app restart.
                if problem.retryable && !self.stopping.load(Ordering::SeqCst) {
                    self.schedule_restart();
                }
                Err(problem)
            }
        }
    }

    /// Chamado sempre com `start_gate`. O `shutdown` também passa pelo portão,
    /// então nenhum sidecar nasce depois dele, nem por uma nova tentativa.
    fn start_once(self: &Arc<Self>) -> Result<(), RpcProblem> {
        if self.stopping.load(Ordering::SeqCst) {
            return Err(RpcProblem::local(
                "tunnel_stopping",
                "O núcleo do túnel está encerrando.",
                true,
            ));
        }
        let previous = lock(&self.process).clone();
        if let Some(process) = previous {
            if process.ready.load(Ordering::SeqCst)
                && matches!(lock(&process.child).try_wait(), Ok(None))
            {
                return Ok(());
            }
            self.fail_start(&process);
        }
        if let Err(wait) = lock(&self.restarts).admit(Instant::now()) {
            return Err(RpcProblem::local(
                RESTART_LIMIT_CODE,
                format!(
                    "O núcleo do túnel falhou {MAX_RESTARTS} vezes em {} min. Nova tentativa em {} s.",
                    RESTART_WINDOW.as_secs() / 60,
                    wait.as_secs().max(1)
                ),
                true,
            ));
        }
        fs::create_dir_all(&self.launch.state_dir).map_err(|error| {
            RpcProblem::local(
                "tunnel_state",
                format!("Não foi possível preparar o estado do túnel: {error}"),
                false,
            )
        })?;
        self.emit_local("tunnel.state", json!({"state":"starting"}));
        let binary = validate_binary(&self.launch.binary).map_err(|message| {
            crate::diagnostics::note(&format!(
                "[tunnel] sidecar não encontrado em {}: {message}",
                self.launch.binary.display()
            ));
            RpcProblem::local("tunnel_start", message, true)
        })?;
        let mut command = Command::new(binary);
        command
            .args(&self.launch.binary_args)
            .arg("serve-stdio")
            .arg("--state-dir")
            .arg(&self.launch.state_dir)
            .arg("--parent-pid")
            .arg(self.launch.parent_pid.to_string());
        self.launch.append_tor(&mut command);
        // O sidecar e o `tor` que ele abre acham as proprias bibliotecas pelo
        // `$ORIGIN`; nada do ambiente do AppImage lhes serve.
        child_env::sanitize(&mut command);
        // Sem CREATE_NO_WINDOW o sidecar abriria um console no Windows em
        // release, e um crash loop deixaria uma janela por tentativa.
        platform::configure_background_command(&mut command);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                RpcProblem::local(
                    "tunnel_start",
                    format!("Não foi possível iniciar o núcleo do túnel: {error}"),
                    true,
                )
            })?;
        // O sidecar só abre o `tor` depois do handshake, então atribuir logo
        // após o spawn já cobre a árvore toda.
        #[cfg(target_os = "windows")]
        let job = crate::platform::win_job::assign(child.id()).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            RpcProblem::local(
                "tunnel_start",
                format!("Não foi possível isolar o núcleo do túnel: {error}"),
                true,
            )
        })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            RpcProblem::local("tunnel_start", "O sidecar não abriu a entrada stdio.", true)
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            RpcProblem::local("tunnel_start", "O sidecar não abriu a saída stdio.", true)
        })?;
        let generation = self.next_generation.fetch_add(1, Ordering::SeqCst);
        let (write_tx, write_rx) = mpsc::sync_channel(8);
        let writer_owner = Arc::downgrade(self);
        thread::spawn(move || write_input(writer_owner, generation, stdin, write_rx));
        let process = ProcessHandle {
            generation,
            ready: Arc::new(AtomicBool::new(false)),
            stdin: write_tx,
            child: Arc::new(Mutex::new(child)),
            #[cfg(target_os = "windows")]
            job,
        };
        *lock(&self.process) = Some(process.clone());
        let (hello_tx, hello_rx) = mpsc::sync_channel(1);
        let weak = Arc::downgrade(self);
        let reader_child = process.child.clone();
        thread::spawn(move || read_output(weak, generation, stdout, reader_child, hello_tx));
        let hello = match hello_rx.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(hello) if valid_hello(&hello) => hello,
            _ => {
                self.fail_start(&process);
                return Err(RpcProblem::local(
                    "tunnel_handshake",
                    "O sidecar não negociou o protocolo esperado.",
                    true,
                ));
            }
        };
        let _ = hello;
        let result = match self.send_on(
            &process,
            "hello",
            json!({"protocol":PROTOCOL_VERSION}),
            HANDSHAKE_TIMEOUT,
        ) {
            Ok(result) => result,
            Err(problem) => {
                self.fail_start(&process);
                return Err(problem);
            }
        };
        if result.get("protocol").and_then(Value::as_u64) != Some(PROTOCOL_VERSION) {
            self.fail_start(&process);
            return Err(RpcProblem::local(
                "tunnel_handshake",
                "O sidecar confirmou uma versão incompatível.",
                false,
            ));
        }
        process.ready.store(true, Ordering::SeqCst);
        self.emit_local("tunnel.state", json!({"state":"running"}));
        Ok(())
    }

    fn ready_process(&self) -> Result<ProcessHandle, RpcProblem> {
        lock(&self.process)
            .as_ref()
            .filter(|process| process.ready.load(Ordering::SeqCst))
            .cloned()
            .ok_or_else(|| {
                RpcProblem::local(
                    "tunnel_unavailable",
                    "O núcleo do túnel não está disponível.",
                    true,
                )
            })
    }

    fn send_on(
        &self,
        process: &ProcessHandle,
        command: &str,
        args: Value,
        timeout: Duration,
    ) -> PendingResult {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let line = encode_request(id, command, args)
            .map_err(|message| RpcProblem::local("rpc_invalid", message, false))?;
        let (sender, receiver) = mpsc::sync_channel(1);
        lock(&self.pending).insert(id, (process.generation, sender));
        if let Err(error) = process.stdin.try_send(StdioRequest {
            id,
            line,
            deadline: Instant::now() + timeout,
        }) {
            lock(&self.pending).remove(&id);
            return Err(match error {
                mpsc::TrySendError::Full(_) => RpcProblem::local(
                    "tunnel_busy",
                    "A fila do túnel está ocupada. Tente novamente.",
                    true,
                ),
                mpsc::TrySendError::Disconnected(_) => RpcProblem::local(
                    "tunnel_disconnected",
                    "O sidecar fechou a entrada stdio.",
                    true,
                ),
            });
        }
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                lock(&self.pending).remove(&id);
                Err(RpcProblem::local(
                    "tunnel_timeout",
                    "O núcleo do túnel não respondeu dentro do prazo.",
                    true,
                ))
            }
        }
    }

    fn fail_start(&self, process: &ProcessHandle) {
        process.kill();
        let mut current = lock(&self.process);
        if current
            .as_ref()
            .is_some_and(|value| value.generation == process.generation)
        {
            *current = None;
        }
    }

    fn handle_exit(self: &Arc<Self>, generation: u64, was_ready: bool) {
        let removed = {
            let mut process = lock(&self.process);
            if process
                .as_ref()
                .is_some_and(|current| current.generation == generation)
            {
                process.take()
            } else {
                None
            }
        };
        let Some(removed) = removed else {
            return;
        };
        removed.collect_tree();
        // As sessões móveis morreram com o processo sem emitir `session.closed`.
        self.awake.sidecar_exited();
        self.fail_pending(
            Some(generation),
            RpcProblem::local(
                "tunnel_disconnected",
                "O núcleo do túnel foi desconectado.",
                true,
            ),
        );
        if was_ready && !self.stopping.load(Ordering::SeqCst) {
            self.schedule_restart();
        }
    }

    fn fail_pending(&self, generation: Option<u64>, problem: RpcProblem) {
        lock(&self.pending).retain(|_, (owner, sender)| {
            if generation.is_none_or(|generation| generation == *owner) {
                let _ = sender.send(Err(problem.clone()));
                false
            } else {
                true
            }
        });
    }

    fn schedule_restart(self: &Arc<Self>) {
        if self
            .restart_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        // The UI reapplies net.start after the next running event. This is
        // required for initial failures and RPC timeouts as well as exits.
        self.emit_local("tunnel.state", json!({"state":"restarting"}));
        let owner = self.clone();
        thread::spawn(move || {
            let mut delays = restart_delays();
            let mut delay = delays.next().unwrap();
            loop {
                if owner.stopping.load(Ordering::SeqCst) {
                    break;
                }
                let wait = lock(&owner.retry_wait);
                let _ = owner
                    .retry_wake
                    .wait_timeout_while(wait, delay, |_| !owner.stopping.load(Ordering::SeqCst));
                let _gate = lock(&owner.start_gate);
                match owner.start_once() {
                    Ok(()) => {
                        owner.restart_active.store(false, Ordering::SeqCst);
                        return;
                    }
                    // A janela de inícios esgotou: o resto da escada não
                    // mudaria nada além de somar processos.
                    Err(problem) if problem.code == RESTART_LIMIT_CODE => {
                        delay = lock(&owner.restarts)
                            .attempts
                            .front()
                            .map(|at| RESTART_WINDOW.saturating_sub(at.elapsed()))
                            .unwrap_or(Duration::from_secs(1))
                            .max(Duration::from_millis(10));
                        owner.emit_local(
                            "tunnel.state",
                            json!({"state":"failed", "retryAfterMs":delay.as_millis()}),
                        );
                        delays = restart_delays();
                    }
                    Err(problem) if !problem.retryable => break,
                    Err(_) => {
                        delay = delays.next().unwrap_or(Duration::from_secs(30));
                    }
                }
            }
            owner.restart_active.store(false, Ordering::SeqCst);
            if !owner.stopping.load(Ordering::SeqCst) {
                owner.emit_local("tunnel.state", json!({"state":"failed"}));
            }
        });
    }

    fn shutdown(&self) {
        if self.stopping.swap(true, Ordering::SeqCst) {
            return;
        }
        self.retry_wake.notify_all();
        // Espera um início em andamento registrar o processo, para encerrá-lo
        // em vez de deixá-lo nascer depois do encerramento.
        let _gate = lock(&self.start_gate);
        // Release the process lock before waiting for the response: the
        // reader needs it to validate the generation before delivering ACKs.
        let process = lock(&self.process).clone();
        if let Some(process) = process {
            // O sidecar fecha a borda e o `tor` antes de sair; o `tor` tem 3 s
            // depois de `SIGNAL SHUTDOWN`, dentro deste prazo.
            let _ = self.send_on(&process, "shutdown", json!({}), Duration::from_secs(3));
            let started = Instant::now();
            while started.elapsed() < SHUTDOWN_TIMEOUT {
                match lock(&process.child).try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            process.kill();
        }
        *lock(&self.process) = None;
        self.awake.sidecar_exited();
        self.fail_pending(
            None,
            RpcProblem::local("tunnel_stopped", "O núcleo do túnel foi encerrado.", false),
        );
        self.emit_local("tunnel.state", json!({"state":"stopped"}));
    }

    fn emit_local(&self, event: &str, data: Value) {
        (self.events)(event_channel(event), json!({"event":event, "data":data}));
    }
}

fn read_output(
    owner: Weak<Inner>,
    generation: u64,
    stdout: impl Read,
    child: Arc<Mutex<Child>>,
    hello: mpsc::SyncSender<EventFrame>,
) {
    let mut reader = BufReader::new(stdout);
    let mut hello = Some(hello);
    loop {
        let mut bytes = Vec::new();
        let read = match (&mut reader)
            .take((MAX_LINE_BYTES + 1) as u64)
            .read_until(b'\n', &mut bytes)
        {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        if read > MAX_LINE_BYTES || bytes.last() != Some(&b'\n') {
            break;
        }
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
        let Ok(line) = std::str::from_utf8(&bytes) else {
            break;
        };
        let Ok(frame) = parse_line(line) else {
            break;
        };
        let Some(owner) = owner.upgrade() else {
            break;
        };
        if !lock(&owner.process)
            .as_ref()
            .is_some_and(|current| current.generation == generation)
        {
            break;
        }
        match frame {
            Inbound::Response(response) => {
                if let Some((_, sender)) = lock(&owner.pending).remove(&response.id) {
                    let result = if response.ok {
                        Ok(response.result.unwrap_or(Value::Null))
                    } else {
                        Err(response.error.unwrap_or_else(|| {
                            RpcProblem::local(
                                "rpc_invalid",
                                "O sidecar devolveu um erro incompleto.",
                                false,
                            )
                        }))
                    };
                    let _ = sender.send(result);
                }
            }
            Inbound::Event(event) if event.name == "hello" => {
                if let Some(sender) = hello.take() {
                    let _ = sender.send(event);
                }
            }
            Inbound::Event(event) => {
                let channel = event_channel(&event.name);
                owner.observe_event(&event);
                if let Ok(payload) = serde_json::to_value(event) {
                    (owner.events)(channel, payload);
                }
            }
        }
    }
    let was_ready = owner
        .upgrade()
        .and_then(|owner| {
            lock(&owner.process)
                .as_ref()
                .filter(|process| process.generation == generation)
                .map(|process| process.ready.load(Ordering::SeqCst))
        })
        .unwrap_or(false);
    let _ = lock(&child).kill();
    let _ = lock(&child).wait();
    if let Some(owner) = owner.upgrade() {
        owner.handle_exit(generation, was_ready);
    }
}

fn valid_hello(event: &EventFrame) -> bool {
    event.name == "hello"
        && event.data.get("protocol").and_then(Value::as_u64) == Some(PROTOCOL_VERSION)
        && event.data.get("version").and_then(Value::as_str).is_some()
        && event
            .data
            .get("tailscale")
            .and_then(Value::as_str)
            .is_some()
        && event.data.get("pid").and_then(Value::as_u64).is_some()
}

fn restart_delays() -> impl Iterator<Item = Duration> {
    (0..MAX_RESTARTS).map(|attempt| {
        let seconds = 1_u64
            .checked_shl(attempt as u32)
            .unwrap_or(u64::MAX)
            .min(30);
        Duration::from_secs(seconds)
    })
}

fn validate_binary(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("o caminho do sidecar precisa ser absoluto".into());
    }
    let path = path
        .canonicalize()
        .map_err(|error| format!("sidecar do túnel não encontrado: {error}"))?;
    if !path.is_file() {
        return Err("o sidecar do túnel não é um arquivo".into());
    }
    Ok(path)
}

/// Sidecar ao lado do executável real. `tauri::process::current_binary` não
/// serve aqui: no AppImage ele devolve `$APPIMAGE`, o arquivo `.AppImage` na
/// pasta de download, enquanto o sidecar vive na imagem montada, em
/// `$APPDIR/usr/bin`, ao lado do `cialai-desktop` que `current_exe` aponta.
fn resolve_binary() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CIALAI_TUNNEL_BIN") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("CIALAI_TUNNEL_BIN precisa ser absoluto".into());
        }
        return Ok(path);
    }
    let appdir = if cfg!(target_os = "linux") {
        std::env::var_os("APPDIR")
    } else {
        None
    };
    let current = std::env::current_exe()
        .map_err(|error| format!("executável do Cialai indisponível: {error}"))?;
    sidecar_beside(&current, appdir.as_deref())
}

/// `$APPDIR/usr/bin` quando o AppRun definiu a variável; senão o diretório do
/// executável, que cobre `.deb`, `.rpm`, o `.app` do macOS e o Windows.
fn sidecar_beside(current_exe: &Path, appdir: Option<&OsStr>) -> Result<PathBuf, String> {
    if let Some(appdir) = appdir.filter(|value| !value.is_empty()) {
        return Ok(Path::new(appdir).join("usr/bin").join(SIDECAR_NAME));
    }
    let directory = current_exe
        .parent()
        .ok_or_else(|| "o executável do Cialai não tem diretório".to_string())?;
    Ok(directory.join(SIDECAR_NAME))
}

/// `CIALAI_TOR_BIN` aponta para um `tor` de desenvolvimento, o mesmo nome do
/// teste real de `internal/tor`; sem ele vale o recurso empacotado.
fn resolve_tor_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CIALAI_TOR_BIN") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("CIALAI_TOR_BIN precisa ser absoluto".into());
        }
        return Ok(path);
    }
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("diretório de recursos indisponível: {error}"))?;
    Ok(bundled_tor_executable(&resources))
}

#[cfg(test)]
mod tests {
    #[test]
    fn broto_operational_deadline_does_not_restart_a_healthy_sidecar() {
        assert_eq!(
            super::command_timeout("broto.call"),
            std::time::Duration::from_secs(2430)
        );
        assert!(!super::invalidates_process("broto.call", "tunnel_timeout"));
        assert!(super::invalidates_process(
            "broto.call",
            "tunnel_disconnected"
        ));
        assert!(super::invalidates_process("devices.list", "tunnel_timeout"));
        assert_eq!(super::command_timeout("devices.list"), super::CALL_TIMEOUT);
    }

    use std::fs;

    use super::super::awake::AwakeBackend;
    use super::*;

    #[derive(Clone, Default)]
    struct RecordingBridge {
        updates: Arc<Mutex<Vec<Value>>>,
    }

    impl IdentityControl for RecordingBridge {
        fn set_desktop(&self, value: &Value) {
            lock(&self.updates).push(json!({"kind":"desktop", "value":value}));
        }

        fn upsert_device(&self, value: &Value) {
            lock(&self.updates).push(json!({"kind":"upsert", "value":value}));
        }

        fn sync_devices(&self, value: &Value) {
            lock(&self.updates).push(json!({"kind":"sync", "value":value}));
        }

        fn rename_device(&self, device_id: &str, name: &str) {
            lock(&self.updates).push(json!({"kind":"rename", "deviceId":device_id, "name":name}));
        }

        fn revoke_device(&self, device_id: &str) -> usize {
            lock(&self.updates).push(json!({"kind":"revoke", "deviceId":device_id}));
            1
        }
    }

    fn fixture(root: &Path, binary: PathBuf, bridge: BridgeSession) -> LaunchConfig {
        LaunchConfig {
            binary,
            binary_args: Vec::new(),
            tor_binary: None,
            state_dir: root.join("state"),
            static_dir: root.join("mobile"),
            bridge,
            parent_pid: std::process::id(),
        }
    }

    #[test]
    fn restart_backoff_is_bounded_and_has_ten_attempts() {
        assert_eq!(
            restart_delays().collect::<Vec<_>>(),
            [1, 2, 4, 8, 16, 30, 30, 30, 30, 30].map(Duration::from_secs)
        );
    }

    #[test]
    fn restart_budget_admits_ten_starts_per_window_and_then_waits() {
        let mut budget = RestartBudget::new();
        let start = Instant::now();
        let second = |seconds: usize| start + Duration::from_secs(seconds as u64);
        for attempt in 0..MAX_RESTARTS {
            assert!(budget.admit(second(attempt)).is_ok(), "{attempt}");
        }
        assert_eq!(
            budget.admit(second(MAX_RESTARTS)).unwrap_err(),
            RESTART_WINDOW - Duration::from_secs(MAX_RESTARTS as u64)
        );
        // O início mais antigo sai da janela e libera exatamente um novo.
        assert!(budget.admit(start + RESTART_WINDOW).is_ok());
        assert!(budget.admit(start + RESTART_WINDOW).is_err());
        assert!(
            budget
                .admit(start + RESTART_WINDOW + Duration::from_secs(1))
                .is_ok()
        );
    }

    /// Cada chamada da interface tenta iniciar de novo, como no crash loop
    /// do Windows. Dentro da janela só `MAX_RESTARTS` sidecars nascem, entre
    /// as tentativas diretas e as do ciclo de reinício; depois a chamada é
    /// recusada sem rearmar o ciclo.
    #[test]
    fn a_missing_sidecar_is_not_retried_beyond_the_restart_window() {
        let root = std::env::temp_dir();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let supervisor = Supervisor::new(
            fixture(
                &root,
                root.join("missing-sidecar"),
                BridgeSession {
                    port: 3720,
                    secret: "fixture".into(),
                },
            ),
            Arc::new(move |_, value| lock(&captured).push(value)),
            Arc::new(RecordingBridge::default()),
            ApiKeyStore::new(root.join("unused-key")),
            Awake::disabled(),
        );
        let codes = (0..MAX_RESTARTS + 5)
            .map(|_| supervisor.call("net.status", json!({})).unwrap_err().code)
            .collect::<Vec<_>>();
        supervisor.shutdown_blocking();
        assert_eq!(codes[0], "tunnel_start");
        assert!(
            codes[MAX_RESTARTS..]
                .iter()
                .all(|code| code == RESTART_LIMIT_CODE),
            "{codes:?}"
        );
        let starting = lock(&events)
            .iter()
            .filter(|value| value["data"]["state"] == "starting")
            .count();
        assert_eq!(starting, MAX_RESTARTS);
    }

    #[test]
    fn edge_arguments_are_owned_by_the_native_supervisor() {
        let root = std::env::temp_dir();
        let bridge = BridgeSession {
            port: 3720,
            secret: "native-secret".into(),
        };
        let supervisor = Supervisor::new(
            fixture(&root, root.join("sidecar"), bridge),
            Arc::new(|_, _| {}),
            Arc::new(RecordingBridge::default()),
            ApiKeyStore::new(root.join("unused-key")),
            Awake::disabled(),
        );
        let args = supervisor
            .inner
            .prepare_args(
                "net.start",
                json!({"desktopName":"MacBook", "requireApproval":false, "staticDir":"evil", "bridgeUrl":"http://evil", "proxySecret":"evil"}),
            )
            .unwrap();
        assert_eq!(
            args["staticDir"].as_str(),
            Some(root.join("mobile").to_string_lossy().as_ref())
        );
        assert_eq!(args["bridgeUrl"], "http://127.0.0.1:3720");
        assert_eq!(args["proxySecret"], "native-secret");
        assert_eq!(args["desktopName"], "MacBook");

        // Os outros comandos passam sem os campos da borda.
        let status = supervisor
            .inner
            .prepare_args("net.status", json!({}))
            .unwrap();
        assert_eq!(status, json!({}));
    }

    #[test]
    fn native_only_and_removed_key_commands_never_cross_the_generic_call() {
        let root = std::env::temp_dir();
        let supervisor = Supervisor::new(
            fixture(
                &root,
                root.join("missing-sidecar"),
                BridgeSession {
                    port: 3720,
                    secret: "fixture".into(),
                },
            ),
            Arc::new(|_, _| {}),
            Arc::new(RecordingBridge::default()),
            ApiKeyStore::new(root.join("unused-key")),
            Awake::disabled(),
        );
        for command in ["hello", "shutdown", "edge.serve", "edge.stop"] {
            let problem = supervisor.call(command, json!({})).unwrap_err();
            assert_eq!(problem.code, "command_sensitive", "{command}");
        }
    }

    #[test]
    fn generated_bridge_secret_is_256_bits_and_not_reused() {
        let first = BridgeSession::generate(3720).unwrap();
        let second = BridgeSession::generate(3720).unwrap();
        assert_ne!(first.secret(), second.secret());
        assert_eq!(
            base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(first.secret())
                .unwrap()
                .len(),
            32
        );
    }

    #[test]
    fn successful_tunnel_updates_keep_bridge_identities_current() {
        let root = std::env::temp_dir();
        let bridge = RecordingBridge::default();
        let supervisor = Supervisor::new(
            fixture(
                &root,
                root.join("sidecar"),
                BridgeSession {
                    port: 3720,
                    secret: "fixture".into(),
                },
            ),
            Arc::new(|_, _| {}),
            Arc::new(bridge.clone()),
            ApiKeyStore::new(root.join("unused-key")),
            Awake::disabled(),
        );

        supervisor.inner.sync_bridge_call(
            "net.start",
            &json!({"desktopName":"MacBook"}),
            &json!({"state":"ready", "desktop":{"id":"d_fixture", "name":"MacBook", "publicKey":"key", "fingerprint":"fp"}}),
        );
        supervisor.inner.sync_bridge_call(
            "devices.list",
            &json!({}),
            &json!({"devices":[{"id":"dev_fixture", "name":"iPhone", "deviceKey":"key-fixture"}]}),
        );
        supervisor.inner.sync_bridge_event(&EventFrame {
            name: "devices.changed".into(),
            data: json!({"deviceId":"dev_fixture", "name":"iPhone novo"}),
            ts: "2026-09-12T20:00:00Z".into(),
        });
        supervisor.inner.sync_bridge_event(&EventFrame {
            name: "devices.changed".into(),
            data: json!({"deviceId":"dev_fixture", "revoked":true}),
            ts: "2026-09-12T20:00:01Z".into(),
        });
        supervisor.inner.sync_bridge_event(&EventFrame {
            name: "pair.completed".into(),
            data: json!({"pairId":"pair_fixture", "device":{"id":"dev_second", "name":"iPad", "deviceKey":"key-second"}}),
            ts: "2026-09-12T20:00:00Z".into(),
        });
        supervisor.inner.sync_bridge_event(&EventFrame {
            name: "net.state".into(),
            data: json!({"state":"ready", "desktop":{"id":"d_fixture", "name":"Mac renomeado"}}),
            ts: "2026-09-12T20:00:02Z".into(),
        });
        supervisor.inner.sync_bridge_event(&EventFrame {
            name: "tor.state".into(),
            data: json!({"state":"ready", "progress":100}),
            ts: "2026-09-12T20:00:03Z".into(),
        });

        assert_eq!(
            *lock(&bridge.updates),
            vec![
                json!({"kind":"desktop", "value":{"id":"d_fixture", "name":"MacBook", "publicKey":"key", "fingerprint":"fp"}}),
                json!({"kind":"sync", "value":{"devices":[{"id":"dev_fixture", "name":"iPhone", "deviceKey":"key-fixture"}]}}),
                json!({"kind":"rename", "deviceId":"dev_fixture", "name":"iPhone novo"}),
                json!({"kind":"revoke", "deviceId":"dev_fixture"}),
                json!({"kind":"upsert", "value":{"id":"dev_second", "name":"iPad", "deviceKey":"key-second"}}),
                json!({"kind":"desktop", "value":{"id":"d_fixture", "name":"Mac renomeado"}}),
            ]
        );
    }

    #[derive(Clone, Default)]
    struct AwakeCalls(Arc<Mutex<Vec<&'static str>>>);

    impl AwakeBackend for AwakeCalls {
        fn acquire(&mut self) -> Result<(), String> {
            lock(&self.0).push("acquire");
            Ok(())
        }

        fn release(&mut self) {
            lock(&self.0).push("release");
        }
    }

    #[test]
    fn sidecar_sessions_and_tunnel_exit_drive_the_awake_assertion() {
        let root = std::env::temp_dir();
        let calls = AwakeCalls::default();
        let backend = calls.clone();
        let awake = Awake::spawn(move || backend, true);
        let supervisor = Supervisor::new(
            fixture(
                &root,
                root.join("sidecar"),
                BridgeSession {
                    port: 3720,
                    secret: "fixture".into(),
                },
            ),
            Arc::new(|_, _| {}),
            Arc::new(RecordingBridge::default()),
            ApiKeyStore::new(root.join("unused-key")),
            awake.clone(),
        );
        let session = |name: &str| EventFrame {
            name: name.into(),
            data: json!({"deviceId":"dev_fixture", "transport":"lan"}),
            ts: "2026-09-14T12:00:00Z".into(),
        };

        supervisor.inner.observe_event(&session("session.opened"));
        supervisor.shutdown_blocking();
        supervisor.inner.observe_event(&session("session.closed"));
        awake.shutdown_blocking();

        assert_eq!(*lock(&calls.0), ["acquire", "release"]);
    }

    #[test]
    fn bundled_tor_reaches_the_sidecar_only_as_an_explicit_argument() {
        let root = std::env::temp_dir();
        let bridge = BridgeSession {
            port: 3720,
            secret: "fixture".into(),
        };
        let mut launch = fixture(&root, root.join("sidecar"), bridge);
        let mut without = Command::new("cialai-tunnel");
        launch.append_tor(&mut without);
        assert_eq!(without.get_args().count(), 0);

        let tor = bundled_tor_executable(&root.join("resources"));
        launch.tor_binary = Some(tor.clone());
        let mut with = Command::new("cialai-tunnel");
        launch.append_tor(&mut with);
        assert_eq!(
            with.get_args().collect::<Vec<_>>(),
            [std::ffi::OsStr::new("--tor-bin"), tor.as_os_str()]
        );
    }

    #[test]
    fn sidecar_binary_must_be_an_absolute_regular_file() {
        assert!(validate_binary(Path::new("relative-sidecar")).is_err());
        let directory = std::env::temp_dir();
        assert!(validate_binary(&directory).is_err());
    }

    #[test]
    fn appimage_sidecar_lives_in_the_mounted_image_beside_the_real_executable() {
        let image = Path::new("/tmp/.mount_CialaiXYZ");
        let desktop = image.join("usr/bin/cialai-desktop");
        assert_eq!(
            sidecar_beside(&desktop, Some(image.as_os_str())).unwrap(),
            image.join("usr/bin").join(SIDECAR_NAME)
        );
        // APPDIR vazio e ausência de APPDIR valem o diretório do executável.
        assert_eq!(
            sidecar_beside(&desktop, Some(OsStr::new(""))).unwrap(),
            image.join("usr/bin").join(SIDECAR_NAME)
        );
        assert_eq!(
            sidecar_beside(Path::new("/opt/cialai/cialai-desktop"), None).unwrap(),
            Path::new("/opt/cialai").join(SIDECAR_NAME)
        );
    }

    /// Os pacotes `.deb` e `.rpm` instalam `cialai-desktop` e o sidecar em
    /// `/usr/bin`, sem AppRun e portanto sem `APPDIR`: o sidecar é o vizinho
    /// do executável, e um `APPDIR` vazio herdado do ambiente não muda isso.
    #[test]
    fn deb_and_rpm_sidecar_lives_in_usr_bin_beside_the_executable() {
        let desktop = Path::new("/usr/bin/cialai-desktop");
        let expected = Path::new("/usr/bin").join(SIDECAR_NAME);
        assert_eq!(sidecar_beside(desktop, None).unwrap(), expected);
        assert_eq!(
            sidecar_beside(desktop, Some(OsStr::new(""))).unwrap(),
            expected
        );
        assert_eq!(
            sidecar_beside(Path::new("/usr/lib/cialai/cialai-desktop"), None).unwrap(),
            Path::new("/usr/lib/cialai").join(SIDECAR_NAME)
        );
        assert!(sidecar_beside(Path::new("/"), None).is_err());
    }

    /// Variáveis do processo trocadas só por um teste de cada vez; o valor
    /// anterior volta ao sair do escopo, mesmo com pânico.
    struct ScopedEnv {
        previous: Vec<(&'static str, Option<std::ffi::OsString>)>,
        _lock: MutexGuard<'static, ()>,
    }

    impl ScopedEnv {
        fn new(vars: &[(&'static str, Option<&str>)]) -> Self {
            static ENV_LOCK: Mutex<()> = Mutex::new(());
            let guard = lock(&ENV_LOCK);
            let previous = vars
                .iter()
                .map(|(key, _)| (*key, std::env::var_os(key)))
                .collect();
            for (key, value) in vars {
                Self::apply(key, value.map(OsStr::new));
            }
            Self {
                previous,
                _lock: guard,
            }
        }

        fn apply(key: &str, value: Option<&OsStr>) {
            // SAFETY: o mutex de `ScopedEnv` serializa os testes que alteram o
            // ambiente; o std sincroniza as leituras feitas em Rust.
            unsafe {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    impl Drop for ScopedEnv {
        fn drop(&mut self) {
            for (key, value) in self.previous.drain(..) {
                Self::apply(key, value.as_deref());
            }
        }
    }

    /// `APPIMAGE` aponta para o arquivo baixado e nunca decide o sidecar; no
    /// Linux `APPDIR` leva à imagem montada, e nos demais vale `current_exe`.
    #[test]
    fn resolve_binary_ignores_appimage_and_follows_appdir_or_the_executable() {
        let image = std::env::temp_dir().join("cialai-mount-fixture");
        let env = ScopedEnv::new(&[
            ("CIALAI_TUNNEL_BIN", None),
            ("APPDIR", Some(image.to_str().unwrap())),
            (
                "APPIMAGE",
                Some("/home/ana/Downloads/Cialai_amd64.AppImage"),
            ),
        ]);
        let resolved = resolve_binary().unwrap();
        assert_ne!(resolved.parent(), Some(Path::new("/home/ana/Downloads")));
        if cfg!(target_os = "linux") {
            assert_eq!(resolved, image.join("usr/bin").join(SIDECAR_NAME));
        } else {
            assert_eq!(
                resolved,
                std::env::current_exe()
                    .unwrap()
                    .with_file_name(SIDECAR_NAME)
            );
        }
        drop(env);

        let env = ScopedEnv::new(&[("CIALAI_TUNNEL_BIN", Some("relative/cialai-tunnel"))]);
        assert!(resolve_binary().is_err());
        drop(env);

        let custom = std::env::temp_dir().join("custom-cialai-tunnel");
        let _env = ScopedEnv::new(&[("CIALAI_TUNNEL_BIN", Some(custom.to_str().unwrap()))]);
        assert_eq!(resolve_binary().unwrap(), custom);
    }

    #[cfg(unix)]
    #[test]
    fn doctor_uses_the_sidecar_cli_without_starting_another_node() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("cialai-doctor-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("mobile")).unwrap();
        let script = root.join("fake-doctor.sh");
        fs::write(
            &script,
            r#"#!/bin/sh
[ "$1" = doctor ] || exit 8
[ "$2" = --state-dir ] || exit 9
[ "$#" = 3 ] || exit 10
printf '%s\n' '{"ok":true,"checks":{"state":{"ok":true}}}'
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let supervisor = Supervisor::new(
            fixture(
                &root,
                script,
                BridgeSession {
                    port: 3720,
                    secret: "fixture".into(),
                },
            ),
            Arc::new(|_, _| {}),
            Arc::new(RecordingBridge::default()),
            ApiKeyStore::new(root.join("key")),
            Awake::disabled(),
        );
        let result = supervisor.doctor().unwrap();
        assert_eq!(result["checks"]["state"]["ok"], true);
        fs::remove_dir_all(root).unwrap();
    }

    struct TestChild {
        binary: PathBuf,
        args: Vec<String>,
    }

    /// Fixture que aceita IDs de qualquer geração, sem iniciar Tor ou outro
    /// processo. O arquivo `available` permite recuperar o mesmo supervisor.
    #[cfg(unix)]
    fn recovery_supervisor(root: &Path) -> Supervisor {
        recovery_supervisor_with_events(root, Arc::new(|_, _| {}))
    }

    #[cfg(unix)]
    fn recovery_supervisor_with_events(root: &Path, events: EventSink) -> Supervisor {
        let script = root.join("fake-recovery-sidecar.sh");
        fs::write(
            &script,
            r#"#!/bin/sh
[ -f "$1/available" ] || exit 17
printf '%s\n' "$$" >> "$1/starts"
printf '%s\n' '{"event":"hello","data":{"protocol":1,"version":"0.1.0","tailscale":"fixture","pid":42},"ts":"2026-09-12T20:00:00Z"}'
while IFS= read -r request; do
    id=${request#*\"id\":}
    id=${id%%,*}
    case "$request" in
        *'"cmd":"hello"'*) result='{"protocol":1}' ;;
        *'"cmd":"shutdown"'*) printf '{"id":%s,"ok":true,"result":{}}\n' "$id"; exit 0 ;;
        *) result="{\"pid\":$$}" ;;
    esac
    printf '{"id":%s,"ok":true,"result":%s}\n' "$id" "$result"
    if [ -f "$1/block-stdin" ]; then while :; do :; done; fi
done
"#,
        )
        .unwrap();
        let mut launch = fixture(
            root,
            PathBuf::from("/bin/sh"),
            BridgeSession::new(3720, "fixture".into()),
        );
        launch.binary_args = vec![
            script.to_string_lossy().into_owned(),
            root.to_string_lossy().into_owned(),
        ];
        Supervisor::new(
            launch,
            events,
            Arc::new(RecordingBridge::default()),
            ApiKeyStore::new(root.join("key")),
            Awake::disabled(),
        )
    }

    #[cfg(unix)]
    fn wait_until(limit: Duration, condition: impl Fn() -> bool) -> bool {
        let start = Instant::now();
        while !condition() {
            if start.elapsed() >= limit {
                return false;
            }
            thread::sleep(Duration::from_millis(10));
        }
        true
    }

    #[cfg(unix)]
    #[test]
    fn scheduled_restart_keeps_the_child_recovered_by_a_foreground_call() {
        let root = cascade_root("foreground-recovery");
        let supervisor = recovery_supervisor(&root);
        assert!(supervisor.call("net.status", json!({})).is_err());
        fs::write(root.join("available"), "ready").unwrap();
        let first = supervisor.call("net.status", json!({})).unwrap();
        let original = supervisor.inner.ready_process().unwrap();
        let finished = wait_until(Duration::from_secs(3), || {
            !supervisor.inner.restart_active.load(Ordering::SeqCst)
        });
        let second = supervisor.call("net.status", json!({}));
        let starts = fs::read_to_string(root.join("starts")).unwrap();
        supervisor.shutdown_blocking();
        // Também recolhe o filho original se a regressão substituir seu handle.
        original.kill();
        fs::remove_dir_all(root).unwrap();
        assert!(finished, "o reinício pendente não terminou");
        assert_eq!(second.unwrap(), first, "o filho recuperado foi substituído");
        assert_eq!(starts.lines().count(), 1, "nasceu um sidecar duplicado");
    }

    #[cfg(unix)]
    #[test]
    fn an_initial_failure_emits_recovery_before_running_so_the_ui_restarts_network() {
        let root = cascade_root("initial-network-recovery");
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let supervisor = recovery_supervisor_with_events(
            &root,
            Arc::new(move |_, value| {
                lock(&recorded).push(value);
            }),
        );
        assert!(supervisor.call("net.start", json!({})).is_err());
        fs::write(root.join("available"), "ready").unwrap();
        let recovered = wait_until(Duration::from_secs(4), || {
            supervisor.inner.ready_process().is_ok()
        });
        supervisor.shutdown_blocking();
        let states = lock(&events)
            .iter()
            .filter_map(|frame| frame.get("data")?.get("state")?.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        fs::remove_dir_all(root).unwrap();
        assert!(recovered);
        let restarting = states
            .iter()
            .position(|state| state == "restarting")
            .expect("recovery must be announced after initial failure");
        let running = states.iter().position(|state| state == "running").unwrap();
        assert!(
            restarting < running,
            "UI must be armed before the process recovers: {states:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn exhausted_restart_budget_recovers_after_cooldown_without_an_app_restart() {
        let root = cascade_root("cooldown-recovery");
        let supervisor = recovery_supervisor(&root);
        fs::write(root.join("available"), "ready").unwrap();
        let near_expiry = Instant::now() - RESTART_WINDOW + Duration::from_millis(1800);
        lock(&supervisor.inner.restarts).attempts =
            std::iter::repeat_n(near_expiry, MAX_RESTARTS).collect();
        assert_eq!(
            supervisor.call("net.status", json!({})).unwrap_err().code,
            RESTART_LIMIT_CODE
        );
        let recovered = wait_until(Duration::from_secs(5), || {
            supervisor.inner.ready_process().is_ok()
        });
        let starts = fs::read_to_string(root.join("starts")).unwrap_or_default();
        supervisor.shutdown_blocking();
        fs::remove_dir_all(root).unwrap();
        assert!(recovered, "budget exhaustion became permanent");
        assert_eq!(starts.lines().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn failure_from_an_old_generation_does_not_cancel_new_requests() {
        let root = cascade_root("pending-generations");
        let supervisor = recovery_supervisor(&root);
        let (old_tx, old_rx) = mpsc::sync_channel(1);
        let (new_tx, new_rx) = mpsc::sync_channel(1);
        lock(&supervisor.inner.pending).insert(10, (1, old_tx));
        lock(&supervisor.inner.pending).insert(11, (2, new_tx));
        supervisor
            .inner
            .fail_pending(Some(1), RpcProblem::local("test", "fixture", true));
        assert!(old_rx.try_recv().unwrap().is_err());
        assert!(matches!(new_rx.try_recv(), Err(mpsc::TryRecvError::Empty)));
        assert!(lock(&supervisor.inner.pending).contains_key(&11));
        supervisor.shutdown_blocking();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_late_failed_call_keeps_the_recovered_generation_running() {
        let root = cascade_root("late-failed-call");
        let events = Arc::new(Mutex::new(Vec::new()));
        let recorded = events.clone();
        let supervisor = recovery_supervisor_with_events(
            &root,
            Arc::new(move |_, value| lock(&recorded).push(value)),
        );
        fs::write(root.join("available"), "ready").unwrap();
        fs::write(root.join("block-stdin"), "fixture").unwrap();
        supervisor.inner.ensure_started().unwrap();
        let old_process = supervisor.inner.ready_process().unwrap();
        let caller = supervisor.clone();
        let old_call = thread::spawn(move || caller.call("logs.tail", json!({"lines":10})));
        assert!(
            wait_until(Duration::from_secs(1), || {
                lock(&supervisor.inner.pending)
                    .values()
                    .any(|(generation, _)| *generation == old_process.generation)
            }),
            "generation A never registered its pending call"
        );

        // Intercept the actual exit failure so A's caller receives it only
        // after B has recovered, independent of thread scheduling.
        let (exit_tx, exit_rx) = mpsc::sync_channel(1);
        let delayed_tx = {
            let mut pending = lock(&supervisor.inner.pending);
            let (_, sender) = pending
                .values_mut()
                .find(|(generation, _)| *generation == old_process.generation)
                .unwrap();
            std::mem::replace(sender, exit_tx)
        };
        old_process.kill();
        let old_failure = exit_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("generation A's exit did not fail its pending RPC");
        assert!(
            old_failure.is_err(),
            "the intercepted call must have failed"
        );
        fs::remove_file(root.join("block-stdin")).unwrap();
        let recovered = supervisor.call("net.status", json!({})).unwrap();
        let recovered_process = supervisor.inner.ready_process().unwrap();
        let recovery_finished = wait_until(Duration::from_secs(3), || {
            !supervisor.inner.restart_active.load(Ordering::SeqCst)
        });
        let before_late_failure = lock(&events).len();

        delayed_tx.send(old_failure).unwrap();
        let old_result = old_call.join().unwrap();
        let unnecessary_restart = supervisor.inner.restart_active.load(Ordering::SeqCst);
        let follow_up = supervisor.call("net.status", json!({}));
        let late_states = lock(&events)[before_late_failure..]
            .iter()
            .filter_map(|frame| frame.get("data")?.get("state")?.as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        let last_state = lock(&events)
            .iter()
            .rev()
            .find_map(|frame| frame.get("data")?.get("state")?.as_str().map(str::to_owned));
        let starts = fs::read_to_string(root.join("starts")).unwrap();
        supervisor.shutdown_blocking();
        recovered_process.kill();
        fs::remove_dir_all(root).unwrap();

        assert!(
            recovery_finished,
            "B's recovery did not settle before A resumed"
        );
        assert!(
            old_result.is_err(),
            "A must still receive its original failure"
        );
        assert_eq!(
            follow_up.unwrap(),
            recovered,
            "A's late failure replaced or killed generation B"
        );
        assert_eq!(starts.lines().count(), 2, "an extra sidecar was started");
        assert!(
            !unnecessary_restart && !late_states.iter().any(|state| state == "restarting"),
            "A's late failure scheduled another restart after B recovered: {late_states:?}"
        );
        assert_eq!(
            last_state.as_deref(),
            Some("running"),
            "the tunnel must stay running after B recovered"
        );
    }

    #[cfg(unix)]
    #[test]
    fn an_unread_stdin_pipe_cannot_bypass_the_rpc_deadline() {
        let root = cascade_root("blocked-stdio");
        let supervisor = recovery_supervisor(&root);
        fs::write(root.join("available"), "ready").unwrap();
        fs::write(root.join("block-stdin"), "fixture").unwrap();
        supervisor.inner.ensure_started().unwrap();
        let process = supervisor.inner.ready_process().unwrap();
        let owner = supervisor.inner.clone();
        let blocked = process.clone();
        let (tx, rx) = mpsc::sync_channel(1);
        let call = thread::spawn(move || {
            let result = owner.send_on(
                &blocked,
                "logs.tail",
                json!({"fixture":"x".repeat(MAX_LINE_BYTES / 2)}),
                Duration::from_millis(100),
            );
            let _ = tx.send(result);
        });
        let result = rx.recv_timeout(Duration::from_millis(500));
        supervisor.inner.fail_start(&process);
        call.join().unwrap();
        supervisor.shutdown_blocking();
        fs::remove_dir_all(root).unwrap();
        assert_eq!(
            result
                .expect("writing the pipe bypassed the RPC timeout")
                .unwrap_err()
                .code,
            "tunnel_timeout"
        );
    }

    impl TestChild {
        fn sidecar(root: &Path) -> Self {
            #[cfg(unix)]
            {
                let script = root.join("fake-sidecar.sh");
                fs::write(
                    &script,
                    r#"#!/bin/sh
printf '%s\n' '{"event":"hello","data":{"protocol":1,"version":"0.1.0","tailscale":"1.102.0","pid":42},"ts":"2026-09-12T20:00:00Z"}'
IFS= read -r hello
printf '%s\n' '{"id":1,"ok":true,"result":{"protocol":1,"capabilities":["direct","tor","pairing","devices"]}}'
IFS= read -r request
printf '%s\n' '{"id":2,"ok":true,"result":{"lines":[]}}'
IFS= read -r shutdown
printf '%s\n' '{"id":3,"ok":true,"result":{}}'
"#,
                )
                .unwrap();
                Self {
                    binary: PathBuf::from("/bin/sh"),
                    args: vec![script.to_string_lossy().into_owned()],
                }
            }
            #[cfg(target_os = "windows")]
            {
                let script = root.join("fake-sidecar.cmd");
                fs::write(
                    &script,
                    "@echo off\r\necho {\"event\":\"hello\",\"data\":{\"protocol\":1,\"version\":\"0.1.0\",\"tailscale\":\"1.102.0\",\"pid\":42},\"ts\":\"2026-09-12T20:00:00Z\"}\r\nset /p hello=\r\necho {\"id\":1,\"ok\":true,\"result\":{\"protocol\":1,\"capabilities\":[\"direct\",\"tor\",\"pairing\",\"devices\"]}}\r\nset /p request=\r\necho {\"id\":2,\"ok\":true,\"result\":{\"lines\":[]}}\r\nset /p shutdown=\r\necho {\"id\":3,\"ok\":true,\"result\":{}}\r\n",
                )
                .unwrap();
                Self {
                    binary: script,
                    args: Vec::new(),
                }
            }
        }
    }

    #[test]
    fn real_child_negotiates_serves_a_call_and_shuts_down() {
        let root = std::env::temp_dir().join(format!(
            "cialai-supervisor-{}-{}",
            std::process::id(),
            std::thread::current()
                .name()
                .unwrap_or("test")
                .replace("::", "-")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("mobile")).unwrap();
        let child = TestChild::sidecar(&root);
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let mut launch = fixture(
            &root,
            child.binary,
            BridgeSession {
                port: 3720,
                secret: "fixture".into(),
            },
        );
        launch.binary_args = child.args;
        let supervisor = Supervisor::new(
            launch,
            Arc::new(move |channel, value| {
                lock(&captured).push((channel.to_owned(), value));
            }),
            Arc::new(RecordingBridge::default()),
            ApiKeyStore::new(root.join("key")),
            Awake::disabled(),
        );
        let result = supervisor.call("logs.tail", json!({"lines":10})).unwrap();
        assert_eq!(result, json!({"lines":[]}));
        let shutdown_started = Instant::now();
        supervisor.shutdown_blocking();
        let shutdown_elapsed = shutdown_started.elapsed();
        assert!(lock(&events).iter().any(|(channel, value)| {
            channel == "tunnel://state" && value["data"]["state"] == "running"
        }));
        fs::remove_dir_all(root).unwrap();
        assert!(
            shutdown_elapsed < Duration::from_secs(1),
            "a responsive sidecar ACK must complete shutdown promptly: {shutdown_elapsed:?}"
        );
    }

    /// Sidecar falso que confere a injeção dos campos da borda em `net.start`
    /// e responde à listagem de celulares que o supervisor faz em seguida.
    #[cfg(unix)]
    #[test]
    fn net_start_injects_the_edge_and_syncs_the_bridge_with_the_registry() {
        let root = cascade_root("net-start");
        fs::create_dir_all(root.join("mobile")).unwrap();
        let script = root.join("fake-net-sidecar.sh");
        fs::write(
            &script,
            r#"#!/bin/sh
printf '%s\n' '{"event":"hello","data":{"protocol":1,"version":"0.1.0","tailscale":"1.102.0","pid":42},"ts":"2026-09-12T20:00:00Z"}'
IFS= read -r hello
printf '%s\n' '{"id":1,"ok":true,"result":{"protocol":1,"capabilities":["direct","tor","pairing","devices"]}}'
IFS= read -r start
case "$start" in
  *'"staticDir":"evil"'*) exit 7 ;;
  *'"cmd":"net.start"'*'"bridgeUrl":"http://127.0.0.1:3720"'*'"desktopName":"MacBook"'*'"proxySecret":"fixture"'*) ;;
  *) exit 8 ;;
esac
printf '%s\n' '{"id":2,"ok":true,"result":{"state":"ready","desktop":{"id":"d_fixture","name":"MacBook"}}}'
IFS= read -r list
case "$list" in
  *'"cmd":"devices.list"'*) ;;
  *) exit 9 ;;
esac
printf '%s\n' '{"id":3,"ok":true,"result":{"devices":[{"id":"dev_fixture","name":"iPhone","deviceKey":"device-key"}]}}'
IFS= read -r shutdown
printf '%s\n' '{"id":4,"ok":true,"result":{}}'
"#,
        )
        .unwrap();
        let bridge = RecordingBridge::default();
        let mut launch = fixture(
            &root,
            PathBuf::from("/bin/sh"),
            BridgeSession {
                port: 3720,
                secret: "fixture".into(),
            },
        );
        launch.binary_args = vec![script.to_string_lossy().into_owned()];
        let supervisor = Supervisor::new(
            launch,
            Arc::new(|_, _| {}),
            Arc::new(bridge.clone()),
            ApiKeyStore::new(root.join("key")),
            Awake::disabled(),
        );
        let status = supervisor
            .call(
                "net.start",
                json!({"desktopName":"MacBook", "requireApproval":false, "staticDir":"evil", "proxySecret":"evil"}),
            )
            .unwrap();
        assert_eq!(status["state"], "ready");
        supervisor.shutdown_blocking();
        assert_eq!(
            *lock(&bridge.updates),
            vec![
                json!({"kind":"desktop", "value":{"id":"d_fixture", "name":"MacBook"}}),
                json!({"kind":"sync", "value":{"devices":[{"id":"dev_fixture", "name":"iPhone", "deviceKey":"device-key"}]}}),
            ]
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn no_sidecar_starts_after_shutdown() {
        let root = std::env::temp_dir();
        let supervisor = Supervisor::new(
            fixture(
                &root,
                root.join("sidecar"),
                BridgeSession {
                    port: 3720,
                    secret: "fixture".into(),
                },
            ),
            Arc::new(|_, _| {}),
            Arc::new(RecordingBridge::default()),
            ApiKeyStore::new(root.join("unused-key")),
            Awake::disabled(),
        );
        supervisor.shutdown_blocking();
        // A nova tentativa agendada chama `start_once` direto, sem passar pela
        // checagem de `ensure_started`.
        let problem = supervisor.inner.start_once().unwrap_err();
        assert_eq!(problem.code, "tunnel_stopping");
        assert!(lock(&supervisor.inner.process).is_none());
    }

    const CASCADE_APP_ENV: &str = "CIALAI_SUPERVISOR_CASCADE_APP";

    fn cascade_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("cialai-supervisor-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    impl TestChild {
        /// Sidecar falso que abre um `tor` falso antes do handshake e, depois
        /// de responder ao `shutdown`, sai com `exit` ou trava com `hold`, que
        /// ignora até o fim do stdin. Em nenhum dos modos ele encerra o filho.
        /// No Unix o filho segue o dono como o `__OwningControllerProcess` do
        /// Tor real; no Windows ele ignora o dono e só o Job Object o encerra.
        fn cascade(root: &Path, mode: &str) -> Self {
            #[cfg(unix)]
            {
                let script = root.join("fake-cascade-sidecar.sh");
                fs::write(
                    &script,
                    r#"#!/bin/sh
owner=$$
(while kill -0 "$owner" 2>/dev/null; do sleep 0.1; done) </dev/null >/dev/null 2>&1 &
tor=$!
printf '%s\n' '{"event":"hello","data":{"protocol":1,"version":"0.1.0","tailscale":"1.102.0","pid":42},"ts":"2026-09-12T20:00:00Z"}'
IFS= read -r hello || exit 0
printf '%s\n' '{"id":1,"ok":true,"result":{"protocol":1,"capabilities":["direct","tor","pairing","devices"]}}'
IFS= read -r request || exit 0
printf '{"id":2,"ok":true,"result":{"tree":[%s]}}\n' "$tor"
IFS= read -r shutdown || exit 0
printf '%s\n' '{"id":3,"ok":true,"result":{}}'
[ "$1" = hold ] || exit 0
exec sleep 600 </dev/null
"#,
                )
                .unwrap();
                Self {
                    binary: PathBuf::from("/bin/sh"),
                    args: vec![script.to_string_lossy().into_owned(), mode.into()],
                }
            }
            #[cfg(target_os = "windows")]
            {
                let script = root.join("fake-cascade-sidecar.cmd");
                fs::write(
                    &script,
                    "@echo off\r\nstart \"\" /b cmd /d /c \"ping -n 600 127.0.0.1 >nul\"\r\necho {\"event\":\"hello\",\"data\":{\"protocol\":1,\"version\":\"0.1.0\",\"tailscale\":\"1.102.0\",\"pid\":42},\"ts\":\"2026-09-12T20:00:00Z\"}\r\nset /p hello=\r\necho {\"id\":1,\"ok\":true,\"result\":{\"protocol\":1,\"capabilities\":[\"direct\",\"tor\",\"pairing\",\"devices\"]}}\r\nset /p request=\r\necho {\"id\":2,\"ok\":true,\"result\":{\"tree\":[]}}\r\nset /p shutdown=\r\necho {\"id\":3,\"ok\":true,\"result\":{}}\r\nif \"%~1\"==\"hold\" ping -n 600 127.0.0.1 >nul\r\n",
                )
                .unwrap();
                Self {
                    binary: script,
                    args: vec![mode.into()],
                }
            }
        }
    }

    fn cascade_supervisor(root: &Path, mode: &str) -> Supervisor {
        let child = TestChild::cascade(root, mode);
        let mut launch = fixture(
            root,
            child.binary,
            BridgeSession {
                port: 3720,
                secret: "fixture".into(),
            },
        );
        launch.binary_args = child.args;
        Supervisor::new(
            launch,
            Arc::new(|_, _| {}),
            Arc::new(RecordingBridge::default()),
            ApiKeyStore::new(root.join("key")),
            Awake::disabled(),
        )
    }

    /// Inicia o sidecar falso e devolve o pid dele e os do `tor` falso. No
    /// Windows os filhos vêm da lista de membros do Job Object.
    fn start_tree(supervisor: &Supervisor) -> (u32, Vec<u32>) {
        let reported = supervisor.call("logs.tail", json!({"lines":1})).unwrap();
        let sidecar = lock(&supervisor.inner.ready_process().unwrap().child).id();
        #[cfg(unix)]
        let tree = reported["tree"]
            .as_array()
            .unwrap()
            .iter()
            .map(|pid| u32::try_from(pid.as_u64().unwrap()).unwrap())
            .collect::<Vec<_>>();
        #[cfg(target_os = "windows")]
        let tree = {
            let _ = reported;
            crate::platform::win_job::members_for(sidecar)
                .into_iter()
                .filter(|pid| *pid != sidecar)
                .collect::<Vec<_>>()
        };
        assert!(!tree.is_empty(), "o sidecar falso não abriu o filho");
        assert!(tree.iter().all(|pid| crate::platform::process_alive(*pid)));
        (sidecar, tree)
    }

    fn survivors(pids: &[u32], limit: Duration) -> Vec<u32> {
        let started = Instant::now();
        loop {
            let alive = pids
                .iter()
                .copied()
                .filter(|pid| crate::platform::process_alive(*pid))
                .collect::<Vec<_>>();
            if alive.is_empty() || started.elapsed() >= limit {
                return alive;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn sidecar_tree_ends_after_shutdown() {
        let root = cascade_root("cascade-exit");
        let supervisor = cascade_supervisor(&root, "exit");
        let (sidecar, mut pids) = start_tree(&supervisor);
        pids.push(sidecar);
        supervisor.shutdown_blocking();
        assert_eq!(survivors(&pids, Duration::from_secs(10)), Vec::<u32>::new());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sidecar_tree_ends_when_shutdown_is_ignored() {
        let root = cascade_root("cascade-hold");
        let supervisor = cascade_supervisor(&root, "hold");
        let (sidecar, mut pids) = start_tree(&supervisor);
        pids.push(sidecar);
        let started = Instant::now();
        supervisor.shutdown_blocking();
        assert!(started.elapsed() >= SHUTDOWN_TIMEOUT);
        assert_eq!(survivors(&pids, Duration::from_secs(10)), Vec::<u32>::new());
        fs::remove_dir_all(root).unwrap();
    }

    /// Papel do app no teste abaixo: só age quando ele reexecuta o binário de
    /// testes com `CIALAI_SUPERVISOR_CASCADE_APP`, e fica vivo até ser morto.
    #[test]
    fn cascade_app_process() {
        let Some(root) = std::env::var_os(CASCADE_APP_ENV).map(PathBuf::from) else {
            return;
        };
        let supervisor = cascade_supervisor(&root, "exit");
        let (sidecar, tree) = start_tree(&supervisor);
        let pids = std::iter::once(sidecar)
            .chain(tree)
            .map(|pid| pid.to_string())
            .collect::<Vec<_>>()
            .join(" ");
        fs::write(root.join("pids.tmp"), pids).unwrap();
        fs::rename(root.join("pids.tmp"), root.join("pids")).unwrap();
        thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn sidecar_tree_ends_when_the_app_dies() {
        let root = cascade_root("cascade-app");
        let mut app = Command::new(std::env::current_exe().unwrap())
            .args([
                "tunnel::supervisor::tests::cascade_app_process",
                "--exact",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CASCADE_APP_ENV, &root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let started = Instant::now();
        let pids = loop {
            if let Ok(text) = fs::read_to_string(root.join("pids")) {
                break text
                    .split_whitespace()
                    .map(|pid| pid.parse::<u32>().unwrap())
                    .collect::<Vec<_>>();
            }
            if started.elapsed() > Duration::from_secs(20) || app.try_wait().unwrap().is_some() {
                let _ = app.kill();
                let _ = app.wait();
                panic!("o app de teste não iniciou o sidecar falso");
            }
            thread::sleep(Duration::from_millis(50));
        };
        assert!(pids.len() >= 2);
        // Morte abrupta, sem `shutdown`: SIGKILL no Unix e TerminateProcess
        // no Windows.
        app.kill().unwrap();
        app.wait().unwrap();
        assert_eq!(survivors(&pids, Duration::from_secs(10)), Vec::<u32>::new());
        fs::remove_dir_all(root).unwrap();
    }
}
