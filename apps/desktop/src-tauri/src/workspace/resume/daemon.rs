// SPDX-License-Identifier: Apache-2.0
//! Passive initialize handshake against an existing, profile-local control
//! socket. Never starts a daemon or invokes mutating lifecycle commands.

use std::path::Path;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum Health {
    NotObserved,
    Unknown,
    Draining,
    Running(String),
}

#[cfg(windows)]
#[path = "daemon/windows.rs"]
mod windows;

#[cfg(windows)]
pub(super) fn check(config: &Path, timeout: Duration) -> Health {
    windows::check(config, timeout)
}

#[cfg(not(any(unix, windows)))]
pub(super) fn check(_config: &Path, _timeout: Duration) -> Health {
    Health::Unknown
}

#[cfg(all(test, windows))]
#[path = "daemon/tests_windows.rs"]
mod tests_windows;

#[cfg(unix)]
pub(super) fn check(config: &Path, timeout: Duration) -> Health {
    use std::os::unix::fs::{FileTypeExt, MetadataExt};
    let Ok(config) = dunce::canonicalize(config) else {
        return Health::Unknown;
    };
    let path = config.join("app-server-control/app-server-control.sock");
    let meta = match std::fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Health::NotObserved,
        Err(_) => return Health::Unknown,
    };
    // Profile-local socket, owned by this user. Symlinks must not redirect a
    // saved account to another account's daemon.
    if !meta.file_type().is_socket()
        || meta.uid() != unsafe { libc::geteuid() }
        || dunce::canonicalize(&path).ok().as_deref() != Some(path.as_path())
    {
        return Health::Unknown;
    }
    // The native command may already run on Tauri's Tokio executor. Keep the
    // small, bounded I/O runtime off that executor; joining reaps this thread.
    std::thread::scope(|scope| {
        let worker = std::thread::Builder::new()
            .name("cialai-agent-probe".into())
            .spawn_scoped(scope, || {
                let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                else {
                    return Health::Unknown;
                };
                runtime.block_on(async {
                    tokio::time::timeout(timeout, initialize(&path))
                        .await
                        .unwrap_or(Health::Unknown)
                })
            });
        match worker {
            Ok(worker) => worker.join().unwrap_or(Health::Unknown),
            Err(_) => Health::Unknown,
        }
    })
}

#[cfg(unix)]
async fn initialize(path: &Path) -> Health {
    use futures_util::{SinkExt, StreamExt};
    use serde_json::{Value, json};
    use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
    let stream = match tokio::net::UnixStream::connect(path).await {
        Ok(stream) => stream,
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Health::NotObserved;
        }
        Err(_) => return Health::Unknown,
    };
    let config = WebSocketConfig::default()
        .max_message_size(Some(64 * 1024))
        .max_frame_size(Some(64 * 1024));
    let Ok((mut ws, _)) =
        tokio_tungstenite::client_async_with_config("ws://localhost/", stream, Some(config)).await
    else {
        return Health::Unknown;
    };
    let request = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"cialai_compatibility","version":env!("CARGO_PKG_VERSION")}}});
    if ws
        .send(Message::Text(request.to_string().into()))
        .await
        .is_err()
    {
        return Health::Unknown;
    }
    for _ in 0..16 {
        let Some(Ok(message)) = ws.next().await else {
            return Health::Unknown;
        };
        let Ok(text) = message.to_text() else {
            continue;
        };
        let Ok(frame) = serde_json::from_str::<Value>(text) else {
            return Health::Unknown;
        };
        if frame.get("id") != Some(&json!(1)) {
            continue;
        }
        if frame.get("error").is_some_and(|error| {
            error.get("code").and_then(Value::as_i64) == Some(-32600)
                && error
                    .get("message")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.to_ascii_lowercase().contains("draining"))
        }) {
            let _ = ws.close(None).await;
            return Health::Draining;
        }
        let version = frame
            .get("result")
            .and_then(|r| r.get("userAgent"))
            .and_then(Value::as_str)
            .and_then(|agent| agent.split_once('/'))
            .and_then(|(_, rest)| rest.split_whitespace().next())
            .filter(|v| !v.is_empty() && v.len() <= 160 && v.bytes().any(|b| b.is_ascii_digit()))
            .map(str::to_owned);
        let _ = ws
            .send(Message::Text(
                json!({"method":"initialized"}).to_string().into(),
            ))
            .await;
        let _ = ws.close(None).await;
        return version.map(Health::Running).unwrap_or(Health::Unknown);
    }
    Health::Unknown
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use futures_util::{SinkExt, StreamExt};
    use serde_json::json;
    use std::path::PathBuf;

    fn fake(reply: serde_json::Value, stall: bool) -> (PathBuf, std::thread::JoinHandle<()>) {
        let mut nonce = [0; 8];
        getrandom::fill(&mut nonce).unwrap();
        // Short path keeps the fixture below AF_UNIX's address limit.
        let dir = Path::new("/tmp").join(format!("cd-{:x}", u64::from_le_bytes(nonce)));
        let socket_dir = dir.join("app-server-control");
        std::fs::create_dir_all(&socket_dir).unwrap();
        let socket = socket_dir.join("app-server-control.sock");
        let listener = std::os::unix::net::UnixListener::bind(socket).unwrap();
        listener.set_nonblocking(true).unwrap();
        let worker = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap().block_on(async move {
                let _ = tokio::time::timeout(Duration::from_secs(1), async move {
                let listener = tokio::net::UnixListener::from_std(listener).unwrap();
                let (stream, _) = listener.accept().await.unwrap();
                let mut ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                let initialize = ws.next().await.unwrap().unwrap();
                let request: serde_json::Value = serde_json::from_str(initialize.to_text().unwrap()).unwrap();
                assert_eq!(request["method"], "initialize");
                if stall { tokio::time::sleep(Duration::from_millis(250)).await; return; }
                ws.send(tokio_tungstenite::tungstenite::Message::Text(reply.to_string().into())).await.unwrap();
                // Only initialization/close are allowed, never thread/resume,
                // shutdown, restart, or access to conversation content.
                while let Some(Ok(message)) = ws.next().await {
                    if message.is_close() { break; }
                    if let Ok(text) = message.to_text() {
                        assert_eq!(serde_json::from_str::<serde_json::Value>(text).unwrap()["method"], "initialized");
                    }
                }
                }).await;
            });
        });
        (dir, worker)
    }

    #[test]
    fn passive_probe_distinguishes_running_draining_and_unresponsive_profiles() {
        for (response, stall, expected) in [
            (
                json!({"id":1,"result":{"userAgent":"cialai/0.162.1 (fixture) codex_cli_rs/0.162.1"}}),
                false,
                Health::Running("0.162.1".into()),
            ),
            (
                json!({"id":1,"error":{"code":-32600,"message":"Server is draining; retry after reconnecting"}}),
                false,
                Health::Draining,
            ),
            (json!({}), true, Health::Unknown),
        ] {
            let (dir, worker) = fake(response, stall);
            let actual = check(&dir, Duration::from_millis(100));
            worker.join().unwrap();
            std::fs::remove_dir_all(&dir).unwrap();
            assert_eq!(actual, expected);
        }
    }
}
