// SPDX-License-Identifier: Apache-2.0
//! Bounded loopback transport. The edge of the tunnel sidecar supplies the
//! perimeter: it authenticates each phone by its Ed25519 key and token and
//! proves itself to the bridge with the per-launch proxy secret.
mod dispatch;
mod events;
pub mod protocol;

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tauri::{AppHandle, Manager};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, Semaphore, mpsc};
use tokio::time::{Instant, timeout};
use tokio_tungstenite::tungstenite::{
    Message,
    handshake::server::{ErrorResponse, Request, Response},
    protocol::{CloseFrame, WebSocketConfig},
};
use tokio_tungstenite::{WebSocketStream, accept_hdr_async_with_config};

use crate::i18n::t;
use crate::workspace::terminal::{SubscriberKey, TerminalManager};

const MAX_CONNECTIONS: usize = 8;
const MAX_CALLS: usize = 16;
// Quadros de saida em fila por conexao. O limite em bytes por assinante e o
// HIGH_WATER de terminal.rs; este so cobre rajadas de quadros pequenos, e uma
// fila cheia desliga apenas o canal atrasado, nunca a conexao inteira.
const OUTBOUND_DEPTH: usize = 4096;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
// Um replay de 256 KiB pela reserva pode levar mais que alguns segundos; a
// vivacidade do socket fica por conta dos pings.
const WRITE_TIMEOUT: Duration = Duration::from_secs(20);
const PING_INTERVAL: Duration = Duration::from_secs(20);

pub(crate) const DEFAULT_BRIDGE_PORT: u16 = 3720;

#[derive(Clone)]
pub struct BridgeConfig {
    pub port: Option<u16>,
    /// Segredo efemero entregue ao sidecar, nunca salvo nas preferencias.
    pub proxy_secret: Option<String>,
    /// Excecao explicita para desenvolvimento local sem o sidecar.
    pub dev_open: bool,
    /// A porta padrao pode estar com outro Cialai ou com o Control; so a porta
    /// pedida por CIALAI_BRIDGE_PORT falha em vez de cair numa porta livre.
    pub fallback_to_free_port: bool,
}

impl BridgeConfig {
    fn explicit_port() -> Option<u16> {
        std::env::var("CIALAI_BRIDGE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .filter(|port| *port > 0)
    }

    pub(crate) fn from_process(proxy_secret: String) -> Self {
        let explicit = Self::explicit_port();
        Self {
            port: Some(explicit.unwrap_or(DEFAULT_BRIDGE_PORT)),
            proxy_secret: Some(proxy_secret),
            dev_open: std::env::args().any(|arg| arg == "--dev-open-bridge"),
            fallback_to_free_port: explicit.is_none(),
        }
    }
}

/// Abre a ponte na porta pedida. Com a porta padrao ocupada, usa uma porta livre
/// do loopback; o sidecar recebe a porta real pelo supervisor.
pub(crate) fn bind_listener(
    port: u16,
    fallback_to_free_port: bool,
) -> std::io::Result<std::net::TcpListener> {
    match std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)) {
        Err(error) if fallback_to_free_port && error.kind() == std::io::ErrorKind::AddrInUse => {
            crate::diagnostics::note(&format!(
                "porta {port} da ponte ocupada; usando uma porta livre do loopback"
            ));
            std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        }
        result => result,
    }
}

fn secret_eq(actual: &str, expected: &str) -> bool {
    let mut difference = actual.len() ^ expected.len();
    let width = actual.len().max(expected.len());
    let left = actual.as_bytes();
    let right = expected.as_bytes();
    for index in 0..width {
        difference |= usize::from(
            left.get(index).copied().unwrap_or(0) ^ right.get(index).copied().unwrap_or(0),
        );
    }
    difference == 0
}

pub(super) fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(super) struct Connection {
    id: u64,
    pub(super) device_id: Option<String>,
    tx: mpsc::Sender<Message>,
    closed: Arc<AtomicBool>,
    stop: Arc<Notify>,
    close_frame: Mutex<Option<CloseFrame>>,
    /// Session to client channel. Also serializes attach with scoped ACKs.
    bindings: Mutex<HashMap<u32, u32>>,
    pending: Mutex<HashSet<u64>>,
    /// Canais de saida que a fila cheia desligou. A proxima volta do socket
    /// avisa a pagina, que religa a sessao pelo deslocamento que ja tem.
    lagged: Arc<Mutex<Vec<u32>>>,
}

impl Connection {
    fn send(&self, message: Message) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(t("native.error.bridgeDisconnected"));
        }
        if message.len() > protocol::MAX_FRAME || self.tx.try_send(message).is_err() {
            self.close();
            return Err(t("native.error.bridgeLagging"));
        }
        Ok(())
    }

    fn result(&self, id: u64, result: Result<Value, String>) {
        let value = match result {
            Ok(value) => json!({"type":"result", "id":id, "ok":true, "value":value}),
            Err(error) => json!({"type":"result", "id":id, "ok":false, "error":error}),
        };
        let _ = self.send(Message::Text(value.to_string().into()));
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.stop.notify_one();
    }

    fn close_with(&self, code: u16, reason: &'static str) {
        *lock(&self.close_frame) = Some(CloseFrame {
            code: code.into(),
            reason: reason.into(),
        });
        self.close();
    }

    fn key(&self) -> SubscriberKey {
        SubscriberKey::Remote(self.id)
    }
}

type Registry = Arc<Mutex<HashMap<u64, Arc<Connection>>>>;
type Dispatch = Arc<dyn Fn(&Connection, &str, Value) -> Result<Value, String> + Send + Sync>;

#[derive(Clone)]
struct ServeContext {
    registry: Registry,
    terminals: TerminalManager,
    dispatch: Dispatch,
    global_calls: Arc<Semaphore>,
}

#[derive(Clone, Default)]
struct IdentityState {
    desktop: Option<protocol::WelcomeIdentity>,
    devices: HashMap<String, DeviceIdentity>,
}

/// Celular do registro v2: nome para o `welcome` e a chave Ed25519 que a
/// borda provou, conferida com `X-Cialai-Device-Key`.
#[derive(Clone)]
struct DeviceIdentity {
    display: protocol::WelcomeIdentity,
    device_key: String,
}

#[derive(Clone)]
pub struct BridgeControl {
    port: u16,
    registry: Registry,
    identities: Arc<Mutex<IdentityState>>,
}

impl BridgeControl {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub(crate) fn set_desktop(&self, value: &Value) {
        if let Some(identity) = value_identity(value) {
            lock(&self.identities).desktop = Some(identity);
        }
    }

    pub(crate) fn upsert_device(&self, value: &Value) {
        let Some(device) = value_device(value) else {
            return;
        };
        lock(&self.identities)
            .devices
            .insert(device.display.id.clone(), device);
    }

    pub(crate) fn sync_devices(&self, value: &Value) {
        let Some(devices) = value.get("devices").and_then(Value::as_array) else {
            return;
        };
        let mut identities = lock(&self.identities);
        identities.devices.clear();
        for device in devices.iter().filter_map(value_device) {
            identities.devices.insert(device.display.id.clone(), device);
        }
    }

    pub(crate) fn rename_device(&self, device_id: &str, name: &str) {
        if let Some(device) = lock(&self.identities).devices.get_mut(device_id) {
            device.display.name = name.into();
        }
    }

    pub(crate) fn revoke_device(&self, device_id: &str) -> usize {
        lock(&self.identities).devices.remove(device_id);
        let connections: Vec<_> = lock(&self.registry)
            .values()
            .filter(|connection| connection.device_id.as_deref() == Some(device_id))
            .cloned()
            .collect();
        for connection in &connections {
            connection.close_with(4401, "Dispositivo revogado.");
        }
        connections.len()
    }
}

pub(crate) trait IdentityControl: Send + Sync {
    fn set_desktop(&self, value: &Value);
    fn upsert_device(&self, value: &Value);
    fn sync_devices(&self, value: &Value);
    fn rename_device(&self, device_id: &str, name: &str);
    fn revoke_device(&self, device_id: &str) -> usize;
}

impl IdentityControl for BridgeControl {
    fn set_desktop(&self, value: &Value) {
        BridgeControl::set_desktop(self, value);
    }

    fn upsert_device(&self, value: &Value) {
        BridgeControl::upsert_device(self, value);
    }

    fn sync_devices(&self, value: &Value) {
        BridgeControl::sync_devices(self, value);
    }

    fn rename_device(&self, device_id: &str, name: &str) {
        BridgeControl::rename_device(self, device_id, name);
    }

    fn revoke_device(&self, device_id: &str) -> usize {
        BridgeControl::revoke_device(self, device_id)
    }
}

/// Celular ativo do registro v2; revogados ficam fora do mapa.
fn value_device(value: &Value) -> Option<DeviceIdentity> {
    if value.get("revoked").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let display = value_identity(value)?;
    let device_key = value.get("deviceKey")?.as_str()?.trim();
    if device_key.is_empty() {
        return None;
    }
    Some(DeviceIdentity {
        display,
        device_key: device_key.into(),
    })
}

fn value_identity(value: &Value) -> Option<protocol::WelcomeIdentity> {
    let id = value.get("id")?.as_str()?.trim();
    let name = value.get("name")?.as_str()?.trim();
    if id.is_empty() || name.is_empty() {
        return None;
    }
    Some(protocol::WelcomeIdentity {
        id: id.into(),
        name: name.into(),
    })
}

pub fn start(app: AppHandle, config: BridgeConfig) -> Result<BridgeControl, String> {
    let port = config.port.unwrap_or(DEFAULT_BRIDGE_PORT);
    let listener = bind_listener(port, config.fallback_to_free_port)
        .map_err(|error| format!("Não foi possível abrir a ponte do Cialai: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Não foi possível preparar a ponte do Cialai: {error}"))?;
    let actual_port = listener
        .local_addr()
        .map_err(|error| format!("Endereço da ponte do Cialai indisponível: {error}"))?
        .port();
    let registry: Registry = Arc::new(Mutex::new(HashMap::new()));
    let identities = Arc::new(Mutex::new(IdentityState::default()));
    let control = BridgeControl {
        port: actual_port,
        registry: registry.clone(),
        identities: identities.clone(),
    };
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("Não foi possível preparar a ponte do Cialai: {error}");
                return;
            }
        };
        eprintln!("Ponte Cialai em ws://127.0.0.1:{actual_port}");
        let _events = events::forward(app.clone(), registry.clone());
        let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
        let calls = Arc::new(Semaphore::new(MAX_CONNECTIONS * MAX_CALLS));
        let next = AtomicU64::new(1);
        let terminals = app.state::<TerminalManager>().inner().clone();
        let dispatch: Dispatch =
            Arc::new(move |conn, cmd, args| dispatch::dispatch(&app, conn, cmd, args));
        let serve_context = ServeContext {
            registry: registry.clone(),
            terminals,
            dispatch,
            global_calls: calls,
        };
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(slot) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let id = next.fetch_add(1, Ordering::Relaxed);
            let config = config.clone();
            let serve_context = serve_context.clone();
            let identities = identities.clone();
            tauri::async_runtime::spawn(async move {
                let _slot = slot;
                let Ok((socket, device_id)) = handshake(stream, &config, &identities).await else {
                    return;
                };
                serve(socket, device_id, id, serve_context).await;
            });
        }
    });
    Ok(control)
}

async fn handshake(
    stream: TcpStream,
    config: &BridgeConfig,
    identities: &Arc<Mutex<IdentityState>>,
) -> Result<(WebSocketStream<TcpStream>, Option<String>), ()> {
    let mut bearer = None;
    let mut device_id = None;
    let mut device_key = None;
    let mut auth = "open";
    // Tungstenite's callback requires this exact HTTP error response type.
    #[allow(clippy::result_large_err)]
    let callback = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
        let origin = request
            .headers()
            .get("origin")
            .map(|v| v.to_str().unwrap_or("null"));
        if !protocol::validate_path(request.uri().path())
            || !protocol::validate_origin(origin, config.dev_open)
        {
            return Err(tauri::http::Response::builder()
                .status(403)
                .body(Some("Origem ou caminho recusado.".into()))
                .unwrap());
        }
        bearer = request
            .headers()
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(str::to_owned);
        let proxy_secret = request
            .headers()
            .get("x-cialai-proxy-secret")
            .and_then(|value| value.to_str().ok());
        let via_proxy = config
            .proxy_secret
            .as_deref()
            .zip(proxy_secret)
            .is_some_and(|(expected, actual)| secret_eq(actual, expected));
        let via_bearer = config
            .proxy_secret
            .as_deref()
            .zip(bearer.as_deref())
            .is_some_and(|(expected, actual)| secret_eq(actual, expected));
        if !config.dev_open && !via_proxy && !via_bearer {
            return Err(tauri::http::Response::builder()
                .status(403)
                .body(Some("Credencial da ponte recusada.".into()))
                .unwrap());
        }
        if via_proxy {
            device_id = request
                .headers()
                .get("x-cialai-device-id")
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            device_key = request
                .headers()
                .get("x-cialai-device-key")
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            if device_id.is_none() || device_key.is_none() {
                return Err(tauri::http::Response::builder()
                    .status(403)
                    .body(Some("Identidade da borda incompleta.".into()))
                    .unwrap());
            }
            auth = "device";
        } else if via_bearer {
            auth = "token";
        }
        Ok(response)
    };
    let ws_config = WebSocketConfig::default()
        .max_frame_size(Some(protocol::MAX_FRAME))
        .max_message_size(Some(protocol::MAX_FRAME))
        .max_write_buffer_size(protocol::MAX_FRAME + 128 * 1024);
    let mut socket = timeout(
        HANDSHAKE_TIMEOUT,
        accept_hdr_async_with_config(stream, callback, Some(ws_config)),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    let hello = timeout(HANDSHAKE_TIMEOUT, socket.next()).await;
    let parsed = match hello {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<protocol::Incoming>(&text).ok(),
        _ => None,
    };
    let valid = parsed
        .as_ref()
        .ok_or(4400u16)
        .and_then(|message| protocol::validate_hello(message, None, bearer.as_deref()));
    if let Err(code) = valid {
        let _ = timeout(
            WRITE_TIMEOUT,
            socket.close(Some(CloseFrame {
                code: code.into(),
                reason: "Handshake recusado.".into(),
            })),
        )
        .await;
        return Err(());
    }
    let (device, desktop) = {
        let identities = lock(identities);
        let device = device_id.as_deref().map(|id| {
            identities
                .devices
                .get(id)
                .filter(|device| Some(device.device_key.as_str()) == device_key.as_deref())
                .map(|device| device.display.clone())
                .unwrap_or_else(|| protocol::WelcomeIdentity {
                    id: id.into(),
                    name: id.into(),
                })
        });
        (device, identities.desktop.clone())
    };
    let welcome = protocol::Welcome {
        r#type: "welcome",
        version: 1,
        auth,
        user: None,
        device,
        desktop,
        capabilities: ["pty"],
        features: ["terminal-mobile-v1"],
    };
    timeout(
        WRITE_TIMEOUT,
        socket.send(Message::Text(
            serde_json::to_string(&welcome).map_err(|_| ())?.into(),
        )),
    )
    .await
    .map_err(|_| ())?
    .map_err(|_| ())?;
    Ok((socket, device_id))
}

/// Avisa a pagina dos canais que a fila cheia desligou, para ela religar a
/// sessao a partir do deslocamento que ja tem, sem derrubar a conexao. O
/// aviso passa na frente dos quadros em fila; a pagina descarta o que ainda
/// chegar pelo canal antigo.
async fn notify_lagged(socket: &mut WebSocketStream<TcpStream>, conn: &Connection) -> bool {
    let lagged: Vec<u32> = std::mem::take(&mut *lock(&conn.lagged));
    for channel in lagged {
        let notice = Message::Text(
            format!(r#"{{"type":"channel","channel":{channel},"message":{{"type":"detached","reason":"lagged"}}}}"#)
                .into(),
        );
        if !matches!(
            timeout(WRITE_TIMEOUT, socket.send(notice)).await,
            Ok(Ok(()))
        ) {
            return false;
        }
        eprintln!("Ponte: canal {channel} desligado por fila cheia; a pagina religa a sessao.");
    }
    true
}

async fn serve(
    mut socket: WebSocketStream<TcpStream>,
    device_id: Option<String>,
    id: u64,
    context: ServeContext,
) {
    let (tx, mut rx) = mpsc::channel(OUTBOUND_DEPTH);
    let conn = Arc::new(Connection {
        id,
        device_id,
        tx,
        closed: Arc::new(AtomicBool::new(false)),
        stop: Arc::new(Notify::new()),
        close_frame: Mutex::new(None),
        bindings: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashSet::new()),
        lagged: Arc::new(Mutex::new(Vec::new())),
    });
    if let Some(device_id) = conn.device_id.as_deref() {
        eprintln!("Ponte conectada ao dispositivo {device_id}");
    }
    lock(&context.registry).insert(id, conn.clone());
    let calls = Arc::new(Semaphore::new(MAX_CALLS));
    // PTY writes, ACKs and replacement channels follow receive order. Slow
    // Disk and metrics calls use the independent bounded blocking pool.
    let (terminal_tx, terminal_rx) =
        std::sync::mpsc::sync_channel::<Box<dyn FnOnce() + Send>>(MAX_CALLS);
    std::thread::spawn(move || {
        for job in terminal_rx {
            job();
        }
    });
    let mut ping = tokio::time::interval_at(Instant::now() + PING_INTERVAL, PING_INTERVAL);
    let mut last_pong = Instant::now();
    let reason = loop {
        tokio::select! {
            _ = conn.stop.notified() => break "encerrada pelo desktop",
            _ = ping.tick() => {
                if last_pong.elapsed() >= PING_INTERVAL * 2 { break "dois pings sem resposta"; }
                if !matches!(timeout(WRITE_TIMEOUT, socket.send(Message::Ping(vec![1].into()))).await, Ok(Ok(()))) { break "falha ao enviar ping"; }
                if !notify_lagged(&mut socket, &conn).await { break "falha ao avisar canal atrasado"; }
            }
            outgoing = rx.recv() => {
                let Some(message) = outgoing else { break "fila de saida fechada"; };
                if !matches!(timeout(WRITE_TIMEOUT, socket.send(message)).await, Ok(Ok(()))) { break "falha ao enviar quadro"; }
                if !notify_lagged(&mut socket, &conn).await { break "falha ao avisar canal atrasado"; }
            }
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break "socket fechado pelo celular"; };
                match message {
                    Message::Pong(_) => last_pong = Instant::now(),
                    Message::Ping(_) => {
                        if !matches!(timeout(WRITE_TIMEOUT, socket.flush()).await, Ok(Ok(()))) { break "falha ao responder ping"; }
                    }
                    Message::Text(text) => {
                        let Ok(protocol::Incoming::Call { id, cmd, args }) = serde_json::from_str(&text) else { break "mensagem fora do protocolo"; };
                        if !args.is_object() { conn.result(id, Err(t("native.error.argumentsInvalid"))); continue; }
                        if !protocol::allowed_command(&cmd) { conn.result(id, Err(t("native.error.desktopOnly"))); continue; }
                        if !lock(&conn.pending).insert(id) { break "id de chamada repetido"; }
                        let permits = (calls.clone().try_acquire_owned(), context.global_calls.clone().try_acquire_owned());
                        let (Ok(local_permit), Ok(global_permit)) = permits else {
                            lock(&conn.pending).remove(&id);
                            conn.result(id, Err(t("native.error.tooManyCalls")));
                            continue;
                        };
                        let ordered = matches!(cmd.as_str(), "pty_spawn" | "pty_attach" | "pty_ack" | "pty_write" | "pty_kill" | "pty_view_claim" | "pty_view_renew" | "pty_view_release");
                        let target = conn.clone();
                        let dispatch = context.dispatch.clone();
                        let job = move || {
                            let _permits = (local_permit, global_permit);
                            if !target.closed.load(Ordering::SeqCst) {
                                let result = dispatch(&target, &cmd, args);
                                target.result(id, result);
                            }
                            lock(&target.pending).remove(&id);
                        };
                        if ordered {
                            if terminal_tx.try_send(Box::new(job)).is_err() { conn.close(); }
                        } else {
                            tokio::task::spawn_blocking(job);
                        }
                    }
                    Message::Close(_) => break "fechado pelo celular",
                    _ => break "quadro inesperado",
                }
            }
        }
    };
    conn.close();
    lock(&context.registry).remove(&id);
    context.terminals.detach_all(conn.key());
    if let Some(device_id) = conn.device_id.as_deref() {
        eprintln!("Ponte encerrada para o dispositivo {device_id}: {reason}");
    }
    let frame = lock(&conn.close_frame).take();
    let _ = timeout(WRITE_TIMEOUT, socket.close(frame)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::{
        MaybeTlsStream, connect_async, tungstenite::client::IntoClientRequest,
    };

    async fn test_server(
        dispatch: Dispatch,
        token: Option<String>,
    ) -> (String, tokio::task::JoinHandle<()>, BridgeControl) {
        sequential_server(
            dispatch,
            token,
            TerminalManager::with_notifier(Arc::new(|_| {})),
            1,
        )
        .await
    }

    /// Atende `connections` sockets em sequência com o mesmo registro, o mesmo
    /// despacho e os mesmos terminais, como o celular religando pelo caminho
    /// novo depois de uma troca. A conexão `n` recebe o id `n`.
    async fn sequential_server(
        dispatch: Dispatch,
        token: Option<String>,
        terminals: TerminalManager,
        connections: u64,
    ) -> (String, tokio::task::JoinHandle<()>, BridgeControl) {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = format!("ws://{}/pty", listener.local_addr().unwrap());
        let identities = Arc::new(Mutex::new(IdentityState::default()));
        let registry = Arc::new(Mutex::new(HashMap::new()));
        let control = BridgeControl {
            port: listener.local_addr().unwrap().port(),
            registry: registry.clone(),
            identities: identities.clone(),
        };
        let task = tokio::spawn(async move {
            let config = BridgeConfig {
                port: None,
                dev_open: token.is_none(),
                proxy_secret: token,
                fallback_to_free_port: false,
            };
            let global_calls = Arc::new(Semaphore::new(128));
            for id in 1..=connections {
                let (stream, _) = listener.accept().await.unwrap();
                if let Ok((socket, device_id)) = handshake(stream, &config, &identities).await {
                    serve(
                        socket,
                        device_id,
                        id,
                        ServeContext {
                            registry: registry.clone(),
                            terminals: terminals.clone(),
                            dispatch: dispatch.clone(),
                            global_calls: global_calls.clone(),
                        },
                    )
                    .await;
                }
            }
        });
        (address, task, control)
    }

    type PhoneSocket = WebSocketStream<MaybeTlsStream<TcpStream>>;

    /// Socket do mesmo celular vindo da borda, já com `welcome`.
    async fn phone_socket(url: &str) -> PhoneSocket {
        let request = device_request(url, Some(("x-cialai-device-key", "device-key-fixture")));
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"hello","version":1}"#.into()))
            .await
            .unwrap();
        let welcome = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let welcome: Value = serde_json::from_str(&welcome).unwrap();
        assert_eq!(welcome["auth"], "device");
        assert_eq!(welcome["device"]["id"], "dev_fixture");
        socket
    }

    async fn send_call(socket: &mut PhoneSocket, id: u64, cmd: &str, args: Value) {
        socket
            .send(Message::Text(
                json!({"type":"call", "id":id, "cmd":cmd, "args":args})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
    }

    async fn next_json(socket: &mut PhoneSocket) -> Value {
        loop {
            let frame = timeout(Duration::from_secs(10), socket.next())
                .await
                .expect("quadro dentro do prazo")
                .expect("socket aberto")
                .expect("quadro válido");
            match frame {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Ping(_) | Message::Pong(_) => {}
                other => panic!("quadro inesperado: {other:?}"),
            }
        }
    }

    async fn eventually(what: &str, condition: impl Fn() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while !condition() {
            assert!(Instant::now() < deadline, "{what}");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Segura uma chamada dentro do despacho para a troca de caminho
    /// acontecer com ela em voo: avisa que começou e espera uma liberação.
    struct Gate {
        permits: Mutex<usize>,
        released: std::sync::Condvar,
        started: mpsc::UnboundedSender<()>,
    }

    impl Gate {
        fn new() -> (Arc<Self>, mpsc::UnboundedReceiver<()>) {
            let (started, receiver) = mpsc::unbounded_channel();
            let gate = Self {
                permits: Mutex::new(0),
                released: std::sync::Condvar::new(),
                started,
            };
            (Arc::new(gate), receiver)
        }

        fn pass(&self) {
            let _ = self.started.send(());
            let (mut permits, _) = self
                .released
                .wait_timeout_while(lock(&self.permits), Duration::from_secs(10), |permits| {
                    *permits == 0
                })
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            *permits = permits.saturating_sub(1);
        }

        fn release(&self) {
            *lock(&self.permits) += 1;
            self.released.notify_all();
        }
    }

    async fn wait_started(started: &mut mpsc::UnboundedReceiver<()>) {
        timeout(Duration::from_secs(10), started.recv())
            .await
            .expect("a chamada precisa entrar no despacho")
            .expect("porta viva");
    }

    #[tokio::test]
    async fn pty_write_in_flight_during_a_path_switch_runs_at_most_once() {
        let applied = Arc::new(Mutex::new(Vec::new()));
        let (gate, mut started) = Gate::new();
        let dispatch: Dispatch = {
            let applied = applied.clone();
            let gate = gate.clone();
            Arc::new(move |conn, cmd, args| {
                assert_eq!(cmd, "pty_write");
                let data = args["data"].as_str().unwrap().to_owned();
                if data == "primeiro\n" {
                    gate.pass();
                }
                lock(&applied).push((conn.id, conn.device_id.clone(), data));
                Ok(Value::Null)
            })
        };
        let (url, task, control) = sequential_server(
            dispatch,
            Some("fixture-secret".into()),
            TerminalManager::with_notifier(Arc::new(|_| {})),
            2,
        )
        .await;

        let mut first = phone_socket(&url).await;
        send_call(
            &mut first,
            1,
            "pty_write",
            json!({"id":3, "data":"primeiro\n"}),
        )
        .await;
        wait_started(&mut started).await;
        send_call(
            &mut first,
            2,
            "pty_write",
            json!({"id":3, "data":"segundo\n"}),
        )
        .await;
        let old = lock(&control.registry).get(&1).cloned().unwrap();
        eventually(
            "a segunda escrita precisa chegar à ponte antes da troca",
            || lock(&old.pending).len() == 2,
        )
        .await;
        // Troca de caminho: o proxy fecha o upstream sem handshake de fechamento.
        drop(first);
        eventually("a conexão antiga precisa sair do registro", || {
            lock(&control.registry).is_empty()
        })
        .await;
        gate.release();
        eventually("as chamadas da conexão antiga precisam terminar", || {
            lock(&old.pending).is_empty()
        })
        .await;

        let mut second = phone_socket(&url).await;
        send_call(
            &mut second,
            3,
            "pty_write",
            json!({"id":3, "data":"terceiro\n"}),
        )
        .await;
        let reply = next_json(&mut second).await;
        assert_eq!(
            (
                reply["type"].as_str(),
                reply["id"].as_u64(),
                reply["ok"].as_bool()
            ),
            (Some("result"), Some(3), Some(true)),
            "a resposta da escrita antiga não pode chegar pelo socket novo"
        );
        second.close(None).await.unwrap();
        task.await.unwrap();

        // A escrita em voo terminou uma vez; a enfileirada atrás dela, já
        // recebida pela ponte, não rodou depois da queda; nada foi repetido
        // no socket novo.
        let device = Some("dev_fixture".to_owned());
        assert_eq!(
            *lock(&applied),
            vec![
                (1, device.clone(), "primeiro\n".to_owned()),
                (2, device, "terceiro\n".to_owned()),
            ]
        );
    }

    #[tokio::test]
    async fn pty_spawn_in_flight_during_a_path_switch_creates_a_single_terminal() {
        // O `id` da chamada só correlaciona a resposta dentro de um socket. A
        // ponte não guarda ids entre conexões nem tem chave de idempotência
        // para `pty_spawn`: um id repetido só é barrado enquanto a primeira
        // chamada ainda está pendente no mesmo socket. Entre sockets, quem
        // garante a execução única é o cliente, que rejeita a chamada pendente
        // na queda e nunca a reenvia, como conferem os testes de troca de
        // caminho em `packages/protocol/tests/transport.test.mjs`.
        let spawned = Arc::new(Mutex::new(Vec::<(u64, String)>::new()));
        let (gate, mut started) = Gate::new();
        let dispatch: Dispatch = {
            let spawned = spawned.clone();
            let gate = gate.clone();
            Arc::new(move |conn, cmd, args| match cmd {
                "pty_spawn" => {
                    gate.pass();
                    let mut spawned = lock(&spawned);
                    spawned.push((conn.id, args["tag"].as_str().unwrap().to_owned()));
                    Ok(json!({"id": spawned.len()}))
                }
                "pty_list" => Ok(Value::Array(
                    lock(&spawned)
                        .iter()
                        .enumerate()
                        .map(|(index, (_, tag))| json!({"id": index + 1, "tag": tag}))
                        .collect(),
                )),
                _ => Err("comando inesperado".into()),
            })
        };
        let (url, task, control) = sequential_server(
            dispatch,
            Some("fixture-secret".into()),
            TerminalManager::with_notifier(Arc::new(|_| {})),
            2,
        )
        .await;
        let spawn = |tag: &str| json!({"cwd":"/tmp", "cols":80, "rows":24, "tag":tag, "onOutput":{"__channel__":1}});

        let mut first = phone_socket(&url).await;
        send_call(&mut first, 7, "pty_spawn", spawn("sessao-a")).await;
        wait_started(&mut started).await;
        let old = lock(&control.registry).get(&1).cloned().unwrap();
        drop(first);
        eventually("a conexão antiga precisa sair do registro", || {
            lock(&control.registry).is_empty()
        })
        .await;
        gate.release();
        eventually("o spawn em voo precisa terminar", || {
            lock(&old.pending).is_empty()
        })
        .await;
        assert_eq!(*lock(&spawned), vec![(1, "sessao-a".to_owned())]);

        let mut second = phone_socket(&url).await;
        let current = lock(&control.registry).get(&2).cloned().unwrap();
        send_call(&mut second, 8, "pty_list", json!({})).await;
        let listing = next_json(&mut second).await;
        assert_eq!(
            listing["id"], 8,
            "o resultado do spawn antigo não pode chegar pelo socket novo"
        );
        assert_eq!(listing["value"], json!([{"id":1, "tag":"sessao-a"}]));

        send_call(&mut second, 9, "pty_spawn", spawn("sessao-b")).await;
        wait_started(&mut started).await;
        send_call(&mut second, 9, "pty_spawn", spawn("sessao-b")).await;
        let closed = timeout(Duration::from_secs(10), async {
            while let Some(Ok(frame)) = second.next().await {
                if matches!(frame, Message::Close(_)) {
                    break;
                }
            }
        })
        .await;
        assert!(
            closed.is_ok(),
            "id repetido com a chamada pendente fecha o socket"
        );
        gate.release();
        eventually("o spawn pendente precisa terminar", || {
            lock(&current.pending).is_empty()
        })
        .await;
        task.await.unwrap();
        assert_eq!(
            *lock(&spawned),
            vec![(1, "sessao-a".to_owned()), (2, "sessao-b".to_owned())]
        );
    }

    /// Saída de uma assinatura do celular: bytes na ordem do fio a partir do
    /// offset que o `replay` anunciou.
    struct PhoneChannel {
        id: u32,
        replay: Option<(usize, usize)>,
        bytes: Vec<u8>,
        results: Vec<Value>,
    }

    impl PhoneChannel {
        fn new(id: u32) -> Self {
            Self {
                id,
                replay: None,
                bytes: Vec::new(),
                results: Vec::new(),
            }
        }

        fn printed(&self, text: &str) -> usize {
            String::from_utf8_lossy(&self.bytes).matches(text).count()
        }

        async fn read_until(&mut self, socket: &mut PhoneSocket, done: impl Fn(&Self) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(20);
            while !done(self) {
                let frame = tokio::time::timeout_at(deadline, socket.next())
                    .await
                    .expect("saída do terminal dentro do prazo")
                    .expect("socket aberto")
                    .expect("quadro válido");
                match frame {
                    Message::Binary(frame) => {
                        let channel = u32::from_be_bytes(frame[..4].try_into().unwrap());
                        assert_eq!(channel, self.id, "quadro de outro canal");
                        assert!(self.replay.is_some(), "saída antes do replay");
                        self.bytes.extend_from_slice(&frame[4..]);
                    }
                    Message::Text(text) => {
                        let value: Value = serde_json::from_str(&text).unwrap();
                        if value["type"] != "channel" {
                            self.results.push(value);
                            continue;
                        }
                        assert_eq!(value["channel"], self.id, "mensagem de outro canal");
                        if value["message"]["type"] == "replay" {
                            assert!(self.replay.is_none(), "um replay por assinatura");
                            let field = |name: &str| {
                                usize::try_from(value["message"][name].as_u64().unwrap()).unwrap()
                            };
                            self.replay = Some((field("offset"), field("length")));
                        }
                    }
                    Message::Ping(_) | Message::Pong(_) => {}
                    other => panic!("quadro inesperado: {other:?}"),
                }
            }
        }
    }

    #[tokio::test]
    async fn replay_after_a_path_switch_resumes_exactly_at_the_client_offset() {
        let terminals = TerminalManager::with_notifier(Arc::new(|_| {}));
        struct Cleanup(TerminalManager);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.kill_all_blocking();
            }
        }
        let _cleanup = Cleanup(terminals.clone());
        let shell = crate::workspace::pty::TestShell::isolated();
        // O desktop assina desde a abertura e vê o fluxo inteiro desde o byte zero.
        let desktop = Arc::new(Mutex::new(Vec::new()));
        let session = {
            let desktop = desktop.clone();
            terminals
                .spawn_test_shell_for(
                    &shell,
                    "ponte-troca-de-caminho",
                    SubscriberKey::Webview,
                    tauri::ipc::Channel::new(move |body| {
                        if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
                            lock(&desktop).extend_from_slice(&bytes);
                        }
                        Ok(())
                    }),
                )
                .unwrap()
                .id
        };
        // Canal real da ponte e as mesmas chamadas do `TerminalManager` que
        // `dispatch` usa para assinar e escrever, sem depender de AppHandle.
        let dispatch: Dispatch = {
            let terminals = terminals.clone();
            Arc::new(move |conn, cmd, args| {
                let id = args["id"]
                    .as_u64()
                    .and_then(|id| u32::try_from(id).ok())
                    .ok_or_else(|| "id inválido".to_owned())?;
                match cmd {
                    "pty_attach" => {
                        let (_, channel) = super::dispatch::channel(conn, &args)?;
                        let info = terminals.attach_for(id, conn.key(), channel)?;
                        Ok(json!({"id": info.id}))
                    }
                    "pty_write" => {
                        let data = args["data"].as_str().unwrap_or_default();
                        terminals.write(id, data.as_bytes()).map(|()| Value::Null)
                    }
                    _ => Err("comando inesperado".into()),
                }
            })
        };
        let (url, task, control) = sequential_server(
            dispatch,
            Some("fixture-secret".into()),
            terminals.clone(),
            2,
        )
        .await;
        let print = |text: &str| String::from_utf8(shell.print(text)).unwrap();

        // Caminho antigo: assina, digita e lê só parte do que o shell produz.
        let mut first = phone_socket(&url).await;
        let mut old = PhoneChannel::new(11);
        send_call(
            &mut first,
            1,
            "pty_attach",
            json!({"id":session, "onOutput":{"__channel__":11}}),
        )
        .await;
        old.read_until(&mut first, |channel| !channel.results.is_empty())
            .await;
        assert_eq!(old.results[0]["ok"], true);
        send_call(
            &mut first,
            2,
            "pty_write",
            json!({"id":session, "data":print("cialai-antes")}),
        )
        .await;
        old.read_until(&mut first, |channel| channel.printed("cialai-antes") >= 2)
            .await;
        let (old_offset, _) = old.replay.unwrap();
        assert_eq!(old_offset, 0);
        let client_offset = old_offset + old.bytes.len();
        drop(first);
        eventually("a assinatura antiga precisa sair da sessão", || {
            lock(&control.registry).is_empty()
                && !terminals.has_subscriber(session, SubscriberKey::Remote(1))
        })
        .await;

        // Com o celular fora, o computador continua produzindo saída.
        terminals
            .write(session, &shell.print("cialai-fora"))
            .unwrap();
        eventually("a saída feita fora precisa chegar ao desktop", || {
            String::from_utf8_lossy(&lock(&desktop))
                .matches("cialai-fora")
                .count()
                >= 2
        })
        .await;

        // Caminho novo, mesmo celular: nova assinatura, novo canal, replay.
        let mut second = phone_socket(&url).await;
        let mut new = PhoneChannel::new(12);
        send_call(
            &mut second,
            3,
            "pty_attach",
            json!({"id":session, "onOutput":{"__channel__":12}}),
        )
        .await;
        new.read_until(&mut second, |channel| !channel.results.is_empty())
            .await;
        assert_eq!(new.results[0]["ok"], true);
        let (offset, length) = new.replay.expect("replay na assinatura nova");
        assert!(new.bytes.len() >= length, "o replay vem antes do resultado");
        send_call(
            &mut second,
            4,
            "pty_write",
            json!({"id":session, "data":print("cialai-depois")}),
        )
        .await;
        new.read_until(&mut second, |channel| channel.printed("cialai-depois") >= 2)
            .await;
        second.close(None).await.unwrap();
        task.await.unwrap();

        let end = offset + new.bytes.len();
        eventually("o desktop precisa ter visto o mesmo trecho", || {
            lock(&desktop).len() >= end
        })
        .await;
        let desktop = lock(&desktop).clone();
        assert_eq!(
            desktop[offset..end],
            new.bytes[..],
            "replay e saída ao vivo são o fluxo exato a partir do offset anunciado"
        );
        assert!(
            offset <= client_offset,
            "o replay começa onde o celular parou ou antes, sem lacuna"
        );
        let missed = &new.bytes[client_offset - offset..length];
        assert!(
            String::from_utf8_lossy(missed).contains("cialai-fora"),
            "o replay traz o que foi produzido com o celular fora"
        );
        // Tela do celular: o que ele já tinha, mais o replay cortado no offset
        // que já recebeu. Nenhum byte duplicado e nenhum perdido.
        let mut screen = old.bytes.clone();
        screen.extend_from_slice(&new.bytes[client_offset - offset..]);
        assert_eq!(screen[..], desktop[..end]);
    }

    #[test]
    fn busy_default_port_falls_back_to_a_free_loopback_port() {
        let busy = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = busy.local_addr().unwrap().port();

        let fallback = bind_listener(port, true).unwrap();
        let address = fallback.local_addr().unwrap();
        assert!(address.ip().is_loopback());
        assert_ne!(address.port(), port);

        let error = bind_listener(port, false).unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::AddrInUse);
    }

    #[tokio::test]
    async fn websocket_rejects_origin_before_upgrade_and_call_before_hello() {
        let (url, task, _) = test_server(
            Arc::new(|_, _, _| Ok(Value::Null)),
            Some("fixture-secret".into()),
        )
        .await;
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert("origin", "https://evil.example".parse().unwrap());
        request
            .headers_mut()
            .insert("x-cialai-proxy-secret", "fixture-secret".parse().unwrap());
        let error = connect_async(request).await.unwrap_err();
        assert!(
            matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 403)
        );
        task.await.unwrap();

        let (url, task, _) = test_server(Arc::new(|_, _, _| Ok(Value::Null)), None).await;
        let (mut socket, _) = connect_async(url).await.unwrap();
        socket
            .send(Message::Text(
                r#"{"type":"call","id":1,"cmd":"pty_list"}"#.into(),
            ))
            .await
            .unwrap();
        let Message::Close(Some(frame)) = socket.next().await.unwrap().unwrap() else {
            panic!("close");
        };
        assert_eq!(u16::from(frame.code), 4400);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn websocket_welcome_and_allowlist_work_without_touching_real_managers() {
        let (url, task, _) = test_server(
            Arc::new(|_, cmd, _| {
                assert_eq!(cmd, "pty_list");
                Ok(json!([]))
            }),
            None,
        )
        .await;
        let (mut socket, _) = connect_async(url).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"hello","version":1}"#.into()))
            .await
            .unwrap();
        let welcome = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&welcome).unwrap()["type"],
            "welcome"
        );
        socket
            .send(Message::Text(
                r#"{"type":"call","id":1,"cmd":"fs_reveal","args":{}}"#.into(),
            ))
            .await
            .unwrap();
        let reply = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&reply).unwrap()["ok"], false);
        socket
            .send(Message::Text(
                r#"{"type":"call","id":2,"cmd":"pty_list","args":{}}"#.into(),
            ))
            .await
            .unwrap();
        let reply = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&reply).unwrap()["value"],
            json!([])
        );
        socket.close(None).await.unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn terminal_calls_preserve_wire_order_when_first_write_is_slow() {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let output = writes.clone();
        let (url, task, _) = test_server(
            Arc::new(move |_, _, args| {
                let part = args["data"].as_str().unwrap().to_owned();
                if part == "a" {
                    std::thread::sleep(Duration::from_millis(100));
                }
                lock(&output).push(part);
                Ok(Value::Null)
            }),
            None,
        )
        .await;
        let (mut socket, _) = connect_async(url).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"hello","version":1}"#.into()))
            .await
            .unwrap();
        let _ = socket.next().await;
        for (id, part) in [(1, "a"), (2, "b")] {
            socket
                .send(Message::Text(
                    json!({"type":"call", "id":id,"cmd":"pty_write","args":{"id":1,"data":part}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        }
        for _ in 0..2 {
            let _ = socket.next().await.unwrap().unwrap();
        }
        socket.close(None).await.unwrap();
        task.await.unwrap();
        assert_eq!(*lock(&writes), vec!["a", "b"]);
    }

    /// `ç` digitado no celular chega ao PTY como os bytes UTF-8 `C3 A7`: o
    /// quadro JSON da ponte, o despacho e `TerminalManager::write` não
    /// recodificam. O shell confirma imprimindo em hexadecimal o que recebeu.
    #[cfg(unix)]
    #[tokio::test]
    async fn pty_write_delivers_the_utf8_bytes_of_cedilla_to_the_pty() {
        let terminals = TerminalManager::with_notifier(Arc::new(|_| {}));
        struct Cleanup(TerminalManager);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                self.0.kill_all_blocking();
            }
        }
        let _cleanup = Cleanup(terminals.clone());
        let shell = crate::workspace::pty::TestShell::isolated();
        let output = Arc::new(Mutex::new(Vec::new()));
        let session = {
            let output = output.clone();
            terminals
                .spawn_test_shell_for(
                    &shell,
                    "ponte-cedilha",
                    SubscriberKey::Webview,
                    tauri::ipc::Channel::new(move |body| {
                        if let tauri::ipc::InvokeResponseBody::Raw(bytes) = body {
                            lock(&output).extend_from_slice(&bytes);
                        }
                        Ok(())
                    }),
                )
                .unwrap()
                .id
        };
        // O mesmo caminho de `dispatch` para `pty_write` sem `binary`: a
        // string do JSON vai aos bytes do PTY como está.
        let dispatch: Dispatch = {
            let terminals = terminals.clone();
            Arc::new(move |_, cmd, args| {
                assert_eq!(cmd, "pty_write");
                let id = u32::try_from(args["id"].as_u64().unwrap()).unwrap();
                let data = args["data"].as_str().unwrap();
                terminals.write(id, data.as_bytes()).map(|()| Value::Null)
            })
        };
        let (url, task, _) = sequential_server(dispatch, None, terminals.clone(), 1).await;
        let (mut socket, _) = connect_async(url).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"hello","version":1}"#.into()))
            .await
            .unwrap();
        let _ = socket.next().await;
        send_call(
            &mut socket,
            1,
            "pty_write",
            json!({"id":session, "data":"printf '%s' 'ç' | od -An -tx1\n"}),
        )
        .await;
        assert_eq!(next_json(&mut socket).await["ok"], true);
        eventually("o shell precisa mostrar os bytes c3 a7", || {
            String::from_utf8_lossy(&lock(&output))
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .contains("c3 a7")
        })
        .await;
        socket.close(None).await.unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn hello_deadline_closes_an_idle_upgraded_socket() {
        let (url, task, _) = test_server(Arc::new(|_, _, _| Ok(Value::Null)), None).await;
        let (mut socket, _) = connect_async(url).await.unwrap();
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(6)).await;
        let Message::Close(Some(frame)) = socket.next().await.unwrap().unwrap() else {
            panic!("close");
        };
        assert_eq!(u16::from(frame.code), 4400);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn missing_pongs_disconnect_within_forty_seconds() {
        let (url, task, _) = test_server(Arc::new(|_, _, _| Ok(Value::Null)), None).await;
        let (mut socket, _) = connect_async(url).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"hello","version":1}"#.into()))
            .await
            .unwrap();
        let _ = socket.next().await.unwrap().unwrap();
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(40)).await;
        tokio::task::yield_now().await;
        assert!(
            task.is_finished(),
            "socket sem pong deve ser removido até 40 s"
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn missing_proxy_secret_is_rejected_before_upgrade() {
        let (url, task, _) = test_server(
            Arc::new(|_, _, _| Ok(Value::Null)),
            Some("fixture-secret".into()),
        )
        .await;
        let error = connect_async(url).await.unwrap_err();
        assert!(
            matches!(error, tokio_tungstenite::tungstenite::Error::Http(response) if response.status() == 403)
        );
        task.await.unwrap();
    }

    #[tokio::test]
    async fn proxy_secret_marks_the_connection_as_a_device() {
        let (url, task, control) = test_server(
            Arc::new(|_, _, _| Ok(Value::Null)),
            Some("fixture-secret".into()),
        )
        .await;
        control
            .set_desktop(&json!({"id":"d_fixture", "name":"MacBook", "publicKey":"desktop-key"}));
        control.upsert_device(&json!({
            "id":"dev_fixture",
            "name":"iPhone de Teste",
            "deviceKey":"device-key-fixture"
        }));
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert("x-cialai-proxy-secret", "fixture-secret".parse().unwrap());
        request
            .headers_mut()
            .insert("x-cialai-device-id", "dev_fixture".parse().unwrap());
        request
            .headers_mut()
            .insert("x-cialai-device-key", "device-key-fixture".parse().unwrap());
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"hello","version":1}"#.into()))
            .await
            .unwrap();
        let welcome = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&welcome).unwrap()["auth"],
            "device"
        );
        let welcome: Value = serde_json::from_str(&welcome).unwrap();
        assert_eq!(welcome["device"]["name"], "iPhone de Teste");
        assert_eq!(welcome["desktop"]["name"], "MacBook");

        let started = Instant::now();
        assert_eq!(control.revoke_device("dev_fixture"), 1);
        let Message::Close(Some(frame)) = timeout(Duration::from_secs(1), socket.next())
            .await
            .expect("revogação precisa fechar em menos de um segundo")
            .unwrap()
            .unwrap()
        else {
            panic!("revogação precisa enviar um close WebSocket")
        };
        assert_eq!(u16::from(frame.code), 4401);
        assert!(started.elapsed() < Duration::from_secs(1));
        task.await.unwrap();
    }

    fn device_request(url: &str, device_key: Option<(&'static str, &str)>) -> Request {
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert("x-cialai-proxy-secret", "fixture-secret".parse().unwrap());
        request
            .headers_mut()
            .insert("x-cialai-device-id", "dev_fixture".parse().unwrap());
        if let Some((name, value)) = device_key {
            request.headers_mut().insert(name, value.parse().unwrap());
        }
        request
    }

    #[tokio::test]
    async fn edge_identity_requires_the_v2_device_key_header() {
        for header in [None, Some(("x-cialai-node-key", "device-key-fixture"))] {
            let (url, task, _) = test_server(
                Arc::new(|_, _, _| Ok(Value::Null)),
                Some("fixture-secret".into()),
            )
            .await;
            let error = connect_async(device_request(&url, header))
                .await
                .unwrap_err();
            assert!(
                matches!(error, tokio_tungstenite::tungstenite::Error::Http(ref response) if response.status() == 403),
                "{header:?}: {error:?}"
            );
            task.await.unwrap();
        }
    }

    #[tokio::test]
    async fn welcome_names_only_registered_devices_whose_key_matches() {
        let (url, task, control) = test_server(
            Arc::new(|_, _, _| Ok(Value::Null)),
            Some("fixture-secret".into()),
        )
        .await;
        control.set_desktop(&json!({"id":"d_fixture", "name":"MacBook"}));
        control.sync_devices(&json!({"devices":[
            {"id":"dev_fixture", "name":"iPhone de Teste", "deviceKey":"device-key-fixture"},
            {"id":"dev_revoked", "name":"iPad antigo", "deviceKey":"device-key-revoked", "revoked":true}
        ]}));
        assert!(
            !lock(&control.identities)
                .devices
                .contains_key("dev_revoked")
        );
        let request = device_request(&url, Some(("x-cialai-device-key", "another-key")));
        let (mut socket, _) = connect_async(request).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"hello","version":1}"#.into()))
            .await
            .unwrap();
        let welcome = socket.next().await.unwrap().unwrap().into_text().unwrap();
        let welcome: Value = serde_json::from_str(&welcome).unwrap();
        assert_eq!(welcome["auth"], "device");
        assert_eq!(welcome["device"]["id"], "dev_fixture");
        assert_eq!(
            welcome["device"]["name"], "dev_fixture",
            "a key that differs from the registry must not borrow the known name"
        );
        assert_eq!(welcome["desktop"]["name"], "MacBook");
        socket.close(None).await.unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn unsupported_version_closes_with_4426() {
        let (url, task, _) = test_server(Arc::new(|_, _, _| Ok(Value::Null)), None).await;
        let (mut socket, _) = connect_async(url).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"hello","version":2}"#.into()))
            .await
            .unwrap();
        let Message::Close(Some(frame)) = socket.next().await.unwrap().unwrap() else {
            panic!("close");
        };
        assert_eq!(u16::from(frame.code), 4426);
        task.await.unwrap();
    }

    #[tokio::test]
    async fn oversized_message_never_reaches_dispatch() {
        let (url, task, _) = test_server(
            Arc::new(|_, _, _| panic!("oversized call dispatched")),
            None,
        )
        .await;
        let (mut socket, _) = connect_async(url).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"hello","version":1}"#.into()))
            .await
            .unwrap();
        let _ = socket.next().await;
        let _ = socket
            .send(Message::Text("x".repeat(protocol::MAX_FRAME + 1).into()))
            .await;
        assert!(timeout(Duration::from_secs(2), task).await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn full_outgoing_queue_marks_the_connection_closed() {
        let (tx, _rx) = mpsc::channel(2);
        let conn = Connection {
            id: 1,
            device_id: None,
            tx,
            closed: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(Notify::new()),
            close_frame: Mutex::new(None),
            bindings: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashSet::new()),
            lagged: Arc::new(Mutex::new(Vec::new())),
        };
        assert!(conn.send(Message::Text("one".into())).is_ok());
        assert!(conn.send(Message::Text("two".into())).is_ok());
        assert!(conn.send(Message::Text("three".into())).is_err());
        assert!(conn.closed.load(Ordering::SeqCst));
        assert!(conn.send(Message::Text("four".into())).is_err());
    }

    fn test_connection(tx: mpsc::Sender<Message>) -> Connection {
        Connection {
            id: 1,
            device_id: None,
            tx,
            closed: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(Notify::new()),
            close_frame: Mutex::new(None),
            bindings: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashSet::new()),
            lagged: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// A fila cheia de saida de terminal desliga so o canal atrasado: a
    /// conexao segue viva para as outras sessoes e a pagina recebe o aviso
    /// para religar. Antes a conexao inteira caia e o celular entrava num
    /// ciclo de reconexao a cada replay.
    #[tokio::test]
    async fn full_output_queue_detaches_only_the_lagging_channel() {
        let (tx, mut rx) = mpsc::channel(1);
        let conn = test_connection(tx);
        let (id, channel) =
            super::dispatch::channel(&conn, &json!({"onOutput": {"__channel__": 7}})).unwrap();
        assert_eq!(id, 7);
        assert!(
            channel
                .send(tauri::ipc::InvokeResponseBody::Raw(vec![1, 2, 3]))
                .is_ok()
        );
        assert!(
            channel
                .send(tauri::ipc::InvokeResponseBody::Raw(vec![4]))
                .is_err()
        );
        assert!(!conn.closed.load(Ordering::SeqCst));
        assert_eq!(*lock(&conn.lagged), vec![7]);
        let Some(Message::Binary(frame)) = rx.recv().await else {
            panic!("primeiro quadro")
        };
        assert_eq!(&frame[4..], &[1, 2, 3]);
    }

    #[tokio::test]
    async fn output_larger_than_a_frame_is_split_into_frames() {
        let (tx, mut rx) = mpsc::channel(8);
        let conn = test_connection(tx);
        let (_, channel) =
            super::dispatch::channel(&conn, &json!({"onOutput": {"__channel__": 3}})).unwrap();
        let bytes = vec![7u8; protocol::MAX_FRAME + 10];
        assert!(
            channel
                .send(tauri::ipc::InvokeResponseBody::Raw(bytes))
                .is_ok()
        );
        let mut total = 0;
        while let Ok(Message::Binary(frame)) = rx.try_recv() {
            assert!(frame.len() <= protocol::MAX_FRAME);
            assert_eq!(&frame[..4], &3u32.to_be_bytes());
            total += frame.len() - 4;
        }
        assert_eq!(total, protocol::MAX_FRAME + 10);
        assert!(lock(&conn.lagged).is_empty());
        assert!(!conn.closed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn excess_concurrent_calls_are_rejected_before_dispatch() {
        let gate = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        struct Release(Arc<(Mutex<bool>, std::sync::Condvar)>);
        impl Drop for Release {
            fn drop(&mut self) {
                *lock(&self.0.0) = true;
                self.0.1.notify_all();
            }
        }
        let release = Release(gate.clone());
        let (url, task, _) = test_server(
            Arc::new(move |_, _, _| {
                let mut ready = lock(&gate.0);
                while !*ready {
                    ready = gate.1.wait(ready).unwrap();
                }
                Ok(Value::Null)
            }),
            None,
        )
        .await;
        let (mut socket, _) = connect_async(url).await.unwrap();
        socket
            .send(Message::Text(r#"{"type":"hello","version":1}"#.into()))
            .await
            .unwrap();
        let _ = socket.next().await;
        for id in 0..17 {
            socket
                .send(Message::Text(
                    json!({"type":"call","id":id,"cmd":"pty_metrics","args":{}})
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
        }
        let reply = timeout(Duration::from_secs(2), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_text()
            .unwrap();
        let reply: Value = serde_json::from_str(&reply).unwrap();
        assert_eq!(reply["id"], 16);
        assert_eq!(reply["ok"], false);
        drop(release);
        for _ in 0..16 {
            let _ = socket.next().await.unwrap().unwrap();
        }
        socket.close(None).await.unwrap();
        task.await.unwrap();
    }
}
