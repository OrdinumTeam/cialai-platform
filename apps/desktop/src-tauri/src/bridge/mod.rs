// SPDX-License-Identifier: Apache-2.0
//! Bounded loopback transport. The Tailscale proxy supplies the perimeter.
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

use crate::workspace::terminal::{SubscriberKey, TerminalManager};

const MAX_CONNECTIONS: usize = 8;
const MAX_CALLS: usize = 16;
const OUTBOUND_DEPTH: usize = 64;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
const PING_INTERVAL: Duration = Duration::from_secs(20);

#[derive(Clone)]
pub struct BridgeConfig {
    pub port: Option<u16>,
    /// Segredo efemero entregue ao sidecar, nunca salvo nas preferencias.
    pub proxy_secret: Option<String>,
    /// Excecao explicita para desenvolvimento local sem o sidecar.
    pub dev_open: bool,
}

impl BridgeConfig {
    pub(crate) fn requested_port() -> u16 {
        std::env::var("CIALAI_BRIDGE_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .filter(|port| *port > 0)
            .unwrap_or(3720)
    }

    pub(crate) fn from_process(proxy_secret: String) -> Self {
        Self {
            port: Some(Self::requested_port()),
            proxy_secret: Some(proxy_secret),
            dev_open: std::env::args().any(|arg| arg == "--dev-open-bridge"),
        }
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
    node_key: Option<String>,
    tx: mpsc::Sender<Message>,
    closed: Arc<AtomicBool>,
    stop: Arc<Notify>,
    close_frame: Mutex<Option<CloseFrame>>,
    /// Session to client channel. Also serializes attach with scoped ACKs.
    bindings: Mutex<HashMap<u32, u32>>,
    pending: Mutex<HashSet<u64>>,
}

impl Connection {
    fn send(&self, message: Message) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("Ponte com o Mac desconectada.".into());
        }
        if message.len() > protocol::MAX_FRAME || self.tx.try_send(message).is_err() {
            self.close();
            return Err("Conexão encerrada por atraso.".into());
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

#[derive(Clone, Default)]
struct IdentityState {
    desktop: Option<protocol::WelcomeIdentity>,
    devices: HashMap<String, DeviceIdentity>,
}

#[derive(Clone)]
struct DeviceIdentity {
    display: protocol::WelcomeIdentity,
    node_key: String,
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
        let Some(display) = value_identity(value) else {
            return;
        };
        let Some(node_key) = value.get("nodeKey").and_then(Value::as_str) else {
            return;
        };
        lock(&self.identities).devices.insert(
            display.id.clone(),
            DeviceIdentity {
                display,
                node_key: node_key.into(),
            },
        );
    }

    pub(crate) fn sync_devices(&self, value: &Value) {
        let Some(devices) = value.get("devices").and_then(Value::as_array) else {
            return;
        };
        let mut identities = lock(&self.identities);
        identities.devices.clear();
        for value in devices {
            let Some(display) = value_identity(value) else {
                continue;
            };
            let Some(node_key) = value.get("nodeKey").and_then(Value::as_str) else {
                continue;
            };
            identities.devices.insert(
                display.id.clone(),
                DeviceIdentity {
                    display,
                    node_key: node_key.into(),
                },
            );
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
    let port = config.port.unwrap_or(3720);
    let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
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
        while let Ok((stream, _)) = listener.accept().await {
            let Ok(slot) = slots.clone().try_acquire_owned() else {
                continue;
            };
            let id = next.fetch_add(1, Ordering::Relaxed);
            let config = config.clone();
            let registry = registry.clone();
            let terminals = terminals.clone();
            let dispatch = dispatch.clone();
            let calls = calls.clone();
            let identities = identities.clone();
            tauri::async_runtime::spawn(async move {
                let _slot = slot;
                let Ok((socket, device_id, node_key)) =
                    handshake(stream, &config, &identities).await
                else {
                    return;
                };
                serve(
                    socket, device_id, node_key, id, registry, terminals, dispatch, calls,
                )
                .await;
            });
        }
    });
    Ok(control)
}

async fn handshake(
    stream: TcpStream,
    config: &BridgeConfig,
    identities: &Arc<Mutex<IdentityState>>,
) -> Result<(WebSocketStream<TcpStream>, Option<String>, Option<String>), ()> {
    let mut bearer = None;
    let mut device_id = None;
    let mut node_key = None;
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
            node_key = request
                .headers()
                .get("x-cialai-node-key")
                .and_then(|value| value.to_str().ok())
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            if device_id.is_none() || node_key.is_none() {
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
                .filter(|device| Some(device.node_key.as_str()) == node_key.as_deref())
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
    Ok((socket, device_id, node_key))
}

async fn serve(
    mut socket: WebSocketStream<TcpStream>,
    device_id: Option<String>,
    node_key: Option<String>,
    id: u64,
    registry: Registry,
    terminals: TerminalManager,
    dispatch: Dispatch,
    global_calls: Arc<Semaphore>,
) {
    let (tx, mut rx) = mpsc::channel(OUTBOUND_DEPTH);
    let conn = Arc::new(Connection {
        id,
        device_id,
        node_key,
        tx,
        closed: Arc::new(AtomicBool::new(false)),
        stop: Arc::new(Notify::new()),
        close_frame: Mutex::new(None),
        bindings: Mutex::new(HashMap::new()),
        pending: Mutex::new(HashSet::new()),
    });
    if let Some(device_id) = conn.device_id.as_deref() {
        eprintln!("Ponte conectada ao dispositivo {device_id}");
    }
    lock(&registry).insert(id, conn.clone());
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
    loop {
        tokio::select! {
            _ = conn.stop.notified() => break,
            _ = ping.tick() => {
                if last_pong.elapsed() >= PING_INTERVAL * 2 { break; }
                if !matches!(timeout(WRITE_TIMEOUT, socket.send(Message::Ping(vec![1].into()))).await, Ok(Ok(()))) { break; }
            }
            outgoing = rx.recv() => {
                let Some(message) = outgoing else { break; };
                if !matches!(timeout(WRITE_TIMEOUT, socket.send(message)).await, Ok(Ok(()))) { break; }
            }
            incoming = socket.next() => {
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Pong(_) => last_pong = Instant::now(),
                    Message::Ping(_) => {
                        if !matches!(timeout(WRITE_TIMEOUT, socket.flush()).await, Ok(Ok(()))) { break; }
                    }
                    Message::Text(text) => {
                        let Ok(protocol::Incoming::Call { id, cmd, args }) = serde_json::from_str(&text) else { break; };
                        if !args.is_object() { conn.result(id, Err("Argumentos inválidos.".into())); continue; }
                        if !protocol::allowed_command(&cmd) { conn.result(id, Err("Disponível só no Mac.".into())); continue; }
                        if !lock(&conn.pending).insert(id) { break; }
                        let permits = (calls.clone().try_acquire_owned(), global_calls.clone().try_acquire_owned());
                        let (Ok(local_permit), Ok(global_permit)) = permits else {
                            lock(&conn.pending).remove(&id);
                            conn.result(id, Err("Muitas chamadas simultâneas. Tente novamente.".into()));
                            continue;
                        };
                        let ordered = matches!(cmd.as_str(), "pty_spawn" | "pty_attach" | "pty_ack" | "pty_write" | "pty_kill" | "pty_view_claim" | "pty_view_renew" | "pty_view_release");
                        let target = conn.clone();
                        let dispatch = dispatch.clone();
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
                    Message::Close(_) => break,
                    _ => break,
                }
            }
        }
    }
    conn.close();
    lock(&registry).remove(&id);
    terminals.detach_all(conn.key());
    let frame = lock(&conn.close_frame).take();
    let _ = timeout(WRITE_TIMEOUT, socket.close(frame)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};

    async fn test_server(
        dispatch: Dispatch,
        token: Option<String>,
    ) -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = format!("ws://{}/pty", listener.local_addr().unwrap());
        let identities = Arc::new(Mutex::new(IdentityState::default()));
        let task = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let config = BridgeConfig {
                port: None,
                dev_open: token.is_none(),
                proxy_secret: token,
            };
            if let Ok((socket, device_id, node_key)) = handshake(stream, &config, &identities).await
            {
                serve(
                    socket,
                    device_id,
                    node_key,
                    1,
                    Arc::new(Mutex::new(HashMap::new())),
                    TerminalManager::with_notifier(Arc::new(|_| {})),
                    dispatch,
                    Arc::new(Semaphore::new(128)),
                )
                .await;
            }
        });
        (address, task)
    }

    #[tokio::test]
    async fn websocket_rejects_origin_before_upgrade_and_call_before_hello() {
        let (url, task) = test_server(
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

        let (url, task) = test_server(Arc::new(|_, _, _| Ok(Value::Null)), None).await;
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
        let (url, task) = test_server(
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
        let (url, task) = test_server(
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

    #[tokio::test]
    async fn hello_deadline_closes_an_idle_upgraded_socket() {
        let (url, task) = test_server(Arc::new(|_, _, _| Ok(Value::Null)), None).await;
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
        let (url, task) = test_server(Arc::new(|_, _, _| Ok(Value::Null)), None).await;
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
        let (url, task) = test_server(
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
        let (url, task) = test_server(
            Arc::new(|_, _, _| Ok(Value::Null)),
            Some("fixture-secret".into()),
        )
        .await;
        let mut request = url.into_client_request().unwrap();
        request
            .headers_mut()
            .insert("x-cialai-proxy-secret", "fixture-secret".parse().unwrap());
        request
            .headers_mut()
            .insert("x-cialai-device-id", "dev_fixture".parse().unwrap());
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
        socket.close(None).await.unwrap();
        task.await.unwrap();
    }

    #[tokio::test]
    async fn unsupported_version_closes_with_4426() {
        let (url, task) = test_server(Arc::new(|_, _, _| Ok(Value::Null)), None).await;
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
        let (url, task) = test_server(
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
            node_key: None,
            tx,
            closed: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(Notify::new()),
            close_frame: Mutex::new(None),
            bindings: Mutex::new(HashMap::new()),
            pending: Mutex::new(HashSet::new()),
        };
        assert!(conn.send(Message::Text("one".into())).is_ok());
        assert!(conn.send(Message::Text("two".into())).is_ok());
        assert!(conn.send(Message::Text("three".into())).is_err());
        assert!(conn.closed.load(Ordering::SeqCst));
        assert!(conn.send(Message::Text("four".into())).is_err());
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
        let (url, task) = test_server(
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
