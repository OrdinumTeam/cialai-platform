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

use super::MobileSite;
use super::credentials::{ApiKeyStore, SecretStatus, api_key_prefix};
use super::protocol::{
    EventFrame, Inbound, MAX_LINE_BYTES, PROTOCOL_VERSION, RpcProblem, encode_request,
    event_channel, parse_line,
};

const CALL_TIMEOUT: Duration = Duration::from_secs(30);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RESTARTS: usize = 10;

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
    state_dir: PathBuf,
    static_dir: PathBuf,
    bridge: BridgeSession,
    parent_pid: u32,
}

#[derive(Clone)]
struct ProcessHandle {
    generation: u64,
    ready: Arc<AtomicBool>,
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
}

struct Inner {
    launch: LaunchConfig,
    events: EventSink,
    secrets: ApiKeyStore,
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
    ) -> Result<Self, String> {
        let binary = resolve_binary(app)?;
        let state_dir = app
            .path()
            .app_local_data_dir()
            .map_err(|error| format!("diretório local do túnel indisponível: {error}"))?
            .join("tunnel");
        let sink_app = app.clone();
        Ok(Self::new(
            LaunchConfig {
                binary,
                state_dir: state_dir.clone(),
                static_dir: mobile_site.static_dir().to_path_buf(),
                bridge,
                parent_pid: std::process::id(),
            },
            Arc::new(move |channel, payload| {
                let _ = sink_app.emit(channel, payload);
            }),
            ApiKeyStore::new(state_dir.join("headscale-api-key")),
        ))
    }

    fn new(launch: LaunchConfig, events: EventSink, secrets: ApiKeyStore) -> Self {
        Self {
            inner: Arc::new(Inner {
                launch,
                events,
                secrets,
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
        if matches!(command, "control.configure" | "control.apikey.rotate") {
            return Err(RpcProblem::local(
                "command_sensitive",
                "Use a operação segura dedicada para a chave da API.",
                false,
            ));
        }
        if command == "node.up" && args.get("authKey").is_some_and(Value::is_string) {
            return Err(RpcProblem::local(
                "command_sensitive",
                "A chave de entrada do nó não pode atravessar a chamada genérica.",
                false,
            ));
        }
        let args = self.inner.prepare_args(command, args)?;
        self.inner.ensure_started()?;
        let process = self.inner.ready_process()?;
        self.inner.send_on(&process, command, args, CALL_TIMEOUT)
    }

    pub fn configure_control(
        &self,
        url: String,
        api_key: String,
        ca_file: Option<String>,
    ) -> PendingResult {
        self.inner.ensure_started()?;
        let process = self.inner.ready_process()?;
        let result = self.inner.send_on(
            &process,
            "control.configure",
            json!({"url":url, "apiKey":api_key, "caFile":ca_file.unwrap_or_default()}),
            CALL_TIMEOUT,
        )?;
        let fallback = self
            .inner
            .secrets
            .store(&api_key)
            .map_err(|message| RpcProblem::local("keyring_unavailable", message, false))?;
        if fallback {
            self.inner.emit_local(
                "tunnel.credentialFallback",
                json!({"state":"file", "permissions":"0600"}),
            );
        }
        Ok(result)
    }

    pub fn configure_saved_control(&self, url: String, ca_file: Option<String>) -> PendingResult {
        let (api_key, _) = self
            .inner
            .secrets
            .load()
            .map_err(|message| RpcProblem::local("keyring_unavailable", message, false))?;
        let api_key = api_key.ok_or_else(|| {
            RpcProblem::local(
                "control_unconfigured",
                "Não há chave da API salva neste computador.",
                false,
            )
        })?;
        self.configure_control(url, api_key, ca_file)
    }

    pub fn rotate_api_key(&self, days: u16) -> PendingResult {
        if days == 0 {
            return Err(RpcProblem::local(
                "args_invalid",
                "A validade da chave precisa ser maior que zero.",
                false,
            ));
        }
        let (old_key, _) = self
            .inner
            .secrets
            .load()
            .map_err(|message| RpcProblem::local("keyring_unavailable", message, false))?;
        self.inner.ensure_started()?;
        let process = self.inner.ready_process()?;
        let mut result = self.inner.send_on(
            &process,
            "control.apikey.rotate",
            json!({"days":days}),
            CALL_TIMEOUT,
        )?;
        let new_key = result
            .get("apiKey")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                RpcProblem::local(
                    "control_protocol",
                    "O sidecar não devolveu a nova chave da API.",
                    false,
                )
            })?
            .to_owned();
        let fallback = self
            .inner
            .secrets
            .store(&new_key)
            .map_err(|message| RpcProblem::local("keyring_unavailable", message, false))?;
        let mut expired = false;
        if let Some(old_key) = old_key {
            let prefix = api_key_prefix(&old_key);
            expired = self
                .inner
                .send_on(
                    &process,
                    "control.apikey.expireOld",
                    json!({"prefix":prefix}),
                    CALL_TIMEOUT,
                )
                .is_ok();
        }
        if let Some(object) = result.as_object_mut() {
            object.remove("apiKey");
            object.insert("oldKeyExpired".into(), Value::Bool(expired));
            object.insert("fallback".into(), Value::Bool(fallback));
        }
        Ok(result)
    }

    pub fn secret_status(&self) -> Result<SecretStatus, RpcProblem> {
        self.inner
            .secrets
            .status()
            .map_err(|message| RpcProblem::local("keyring_unavailable", message, false))
    }

    pub fn delete_api_key(&self) -> Result<(), RpcProblem> {
        self.inner
            .secrets
            .delete()
            .map_err(|message| RpcProblem::local("keyring_unavailable", message, false))
    }

    pub fn shutdown_blocking(&self) {
        self.inner.shutdown();
    }
}

impl Inner {
    fn prepare_args(&self, command: &str, mut args: Value) -> Result<Value, RpcProblem> {
        if !args.is_object() {
            return Err(RpcProblem::local(
                "args_invalid",
                "Os argumentos do túnel precisam formar um objeto.",
                false,
            ));
        }
        if command != "edge.serve" {
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
                self.schedule_restart();
                Err(problem)
            }
        }
    }

    fn start_once(self: &Arc<Self>) -> Result<(), RpcProblem> {
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
        let mut child = Command::new(binary)
            .arg("serve-stdio")
            .arg("--state-dir")
            .arg(&self.launch.state_dir)
            .arg("--parent-pid")
            .arg(self.launch.parent_pid.to_string())
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
        let _ = lock(&process.child).kill();
        let _ = lock(&process.child).wait();
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
                process.take();
                true
            } else {
                false
            }
        };
        if !removed {
            return;
        }
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
        if let Some(process) = lock(&self.process).clone() {
            let _ = self.send_on(&process, "shutdown", json!({}), Duration::from_secs(3));
            let started = Instant::now();
            while started.elapsed() < SHUTDOWN_TIMEOUT {
                match lock(&process.child).try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            if lock(&process.child).try_wait().ok().flatten().is_none() {
                let _ = lock(&process.child).kill();
            }
            let _ = lock(&process.child).wait();
        }
        *lock(&self.process) = None;
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

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn fixture(root: &Path, binary: PathBuf, bridge: BridgeSession) -> LaunchConfig {
        LaunchConfig {
            binary,
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
            ApiKeyStore::new(root.join("unused-key")),
        );
        let args = supervisor
            .inner
            .prepare_args(
                "edge.serve",
                json!({"staticDir":"evil", "bridgeUrl":"http://evil", "proxySecret":"evil", "port":4740}),
            )
            .unwrap();
        assert_eq!(
            args["staticDir"].as_str(),
            Some(root.join("mobile").to_string_lossy().as_ref())
        );
        assert_eq!(args["bridgeUrl"], "http://127.0.0.1:3720");
        assert_eq!(args["proxySecret"], "native-secret");
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
    fn sidecar_binary_must_be_an_absolute_regular_file() {
        assert!(validate_binary(Path::new("relative-sidecar")).is_err());
        let directory = std::env::temp_dir();
        assert!(validate_binary(&directory).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn real_child_negotiates_serves_a_call_and_shuts_down() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "cialai-supervisor-{}-{}",
            std::process::id(),
            std::thread::current().name().unwrap_or("test")
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("mobile")).unwrap();
        let script = root.join("fake-sidecar.sh");
        fs::write(
            &script,
            r#"#!/bin/sh
printf '%s\n' '{"event":"hello","data":{"protocol":1,"version":"0.1.0","tailscale":"1.102.0","pid":42},"ts":"2026-09-12T20:00:00Z"}'
IFS= read -r hello
printf '%s\n' '{"id":1,"ok":true,"result":{"protocol":1,"capabilities":["control","edge","pairing","devices"]}}'
IFS= read -r request
printf '%s\n' '{"id":2,"ok":true,"result":{"lines":[]}}'
IFS= read -r shutdown
printf '%s\n' '{"id":3,"ok":true,"result":{}}'
"#,
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let supervisor = Supervisor::new(
            fixture(
                &root,
                script,
                BridgeSession {
                    port: 3720,
                    secret: "fixture".into(),
                },
            ),
            Arc::new(move |channel, value| {
                lock(&captured).push((channel.to_owned(), value));
            }),
            ApiKeyStore::new(root.join("key")),
        );
        let result = supervisor.call("logs.tail", json!({"lines":10})).unwrap();
        assert_eq!(result, json!({"lines":[]}));
        supervisor.shutdown_blocking();
        assert!(lock(&events).iter().any(|(channel, value)| {
            channel == "tunnel://state" && value["data"]["state"] == "running"
        }));
        fs::remove_dir_all(root).unwrap();
    }
}
