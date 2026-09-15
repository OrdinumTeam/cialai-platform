// SPDX-License-Identifier: Apache-2.0

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::bridge::{BridgeControl, IdentityControl};

use super::awake::Awake;
use super::credentials::ApiKeyStore;
use super::protocol::{
    EventFrame, Inbound, MAX_LINE_BYTES, PROTOCOL_VERSION, RpcProblem, encode_request,
    event_channel, parse_line,
};
use super::{MobileSite, bundled_tor_executable};

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESTARTS: usize = 10;

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
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    /// No Windows o sidecar e o `tor` que ele abre vivem neste Job Object com
    /// `KILL_ON_JOB_CLOSE`: se o app morre, o sistema fecha o handle e leva a
    /// árvore inteira. Nos outros sistemas o sidecar sai no fim do stdin e o
    /// `tor` sai sozinho ao perder o controle que o possui.
    #[cfg(target_os = "windows")]
    job: crate::platform::win_job::JobHandle,
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

struct Inner {
    launch: LaunchConfig,
    events: EventSink,
    bridge: Arc<dyn IdentityControl>,
    secrets: ApiKeyStore,
    awake: Awake,
    next_id: AtomicU64,
    next_generation: AtomicU64,
    process: Mutex<Option<ProcessHandle>>,
    pending: Mutex<HashMap<u64, mpsc::SyncSender<PendingResult>>>,
    start_gate: Mutex<()>,
    stopping: AtomicBool,
    restart_active: AtomicBool,
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
        let binary = resolve_binary(app)?;
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
            .send_on(&process, command, args.clone(), CALL_TIMEOUT)?;
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
                if !self.stopping.load(Ordering::SeqCst) {
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
        fs::create_dir_all(&self.launch.state_dir).map_err(|error| {
            RpcProblem::local(
                "tunnel_state",
                format!("Não foi possível preparar o estado do túnel: {error}"),
                false,
            )
        })?;
        self.emit_local("tunnel.state", json!({"state":"starting"}));
        let binary = validate_binary(&self.launch.binary)
            .map_err(|message| RpcProblem::local("tunnel_start", message, true))?;
        let mut command = Command::new(binary);
        command
            .args(&self.launch.binary_args)
            .arg("serve-stdio")
            .arg("--state-dir")
            .arg(&self.launch.state_dir)
            .arg("--parent-pid")
            .arg(self.launch.parent_pid.to_string());
        self.launch.append_tor(&mut command);
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
        let process = ProcessHandle {
            generation,
            ready: Arc::new(AtomicBool::new(false)),
            stdin: Arc::new(Mutex::new(stdin)),
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
        lock(&self.pending).insert(id, sender);
        let write = {
            let mut stdin = lock(&process.stdin);
            stdin.write_all(line.as_bytes()).and_then(|_| stdin.flush())
        };
        if let Err(error) = write {
            lock(&self.pending).remove(&id);
            return Err(RpcProblem::local(
                "tunnel_disconnected",
                format!("O sidecar fechou a entrada stdio: {error}"),
                true,
            ));
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
        self.fail_pending(RpcProblem::local(
            "tunnel_disconnected",
            "O núcleo do túnel foi desconectado.",
            true,
        ));
        if was_ready && !self.stopping.load(Ordering::SeqCst) {
            self.emit_local("tunnel.state", json!({"state":"restarting"}));
            self.schedule_restart();
        }
    }

    fn fail_pending(&self, problem: RpcProblem) {
        let pending = std::mem::take(&mut *lock(&self.pending));
        for (_, sender) in pending {
            let _ = sender.send(Err(problem.clone()));
        }
    }

    fn schedule_restart(self: &Arc<Self>) {
        if self
            .restart_active
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return;
        }
        let owner = self.clone();
        thread::spawn(move || {
            for delay in restart_delays() {
                if owner.stopping.load(Ordering::SeqCst) {
                    break;
                }
                thread::sleep(delay);
                let _gate = lock(&owner.start_gate);
                if owner.start_once().is_ok() {
                    owner.restart_active.store(false, Ordering::SeqCst);
                    return;
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
        // Espera um início em andamento registrar o processo, para encerrá-lo
        // em vez de deixá-lo nascer depois do encerramento.
        let _gate = lock(&self.start_gate);
        if let Some(process) = lock(&self.process).clone() {
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
        self.fail_pending(RpcProblem::local(
            "tunnel_stopped",
            "O núcleo do túnel foi encerrado.",
            false,
        ));
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
        match frame {
            Inbound::Response(response) => {
                if let Some(sender) = lock(&owner.pending).remove(&response.id) {
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

fn resolve_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CIALAI_TUNNEL_BIN") {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("CIALAI_TUNNEL_BIN precisa ser absoluto".into());
        }
        return Ok(path);
    }
    let current = tauri::process::current_binary(&app.env())
        .map_err(|error| format!("executável do Cialai indisponível: {error}"))?;
    let name = if cfg!(windows) {
        "cialai-tunnel.exe"
    } else {
        "cialai-tunnel"
    };
    let sibling = current
        .parent()
        .ok_or_else(|| "o executável do Cialai não tem diretório".to_string())?
        .join(name);
    Ok(sibling)
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
        supervisor.shutdown_blocking();
        assert!(lock(&events).iter().any(|(channel, value)| {
            channel == "tunnel://state" && value["data"]["state"] == "running"
        }));
        fs::remove_dir_all(root).unwrap();
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
