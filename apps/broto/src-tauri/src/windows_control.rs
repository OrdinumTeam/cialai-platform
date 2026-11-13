// SPDX-License-Identifier: Apache-2.0
//! Overlapped named-pipe I/O with one deadline covering connect and reply.
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;

pub(super) async fn control(method: &str, params: Value) -> Result<Value, String> {
    let path = std::env::var_os("CIALAI_BROTO_SOCKET")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(super::pipe_name(
                &std::env::var("USERNAME").unwrap_or_default(),
            ))
        });
    request(&path, method, params, Duration::from_secs(5)).await
}

async fn request(
    path: &Path,
    method: &str,
    params: Value,
    budget: Duration,
) -> Result<Value, String> {
    tokio::time::timeout(budget, async {
        let mut pipe = loop {
            match ClientOptions::new().open(path) {
                Ok(pipe) => break pipe,
                Err(error) if matches!(error.raw_os_error(), Some(2 | 231)) => {
                    tokio::time::sleep(Duration::from_millis(25)).await
                }
                Err(_) => return Err("service_unavailable".into()),
            }
        };
        let mut bytes =
            serde_json::to_vec(&json!({"id":"monitor","method":method,"params":params}))
                .map_err(|_| "request_encoding_failed")?;
        bytes.push(b'\n');
        pipe.write_all(&bytes)
            .await
            .map_err(|_| "service_write_failed")?;
        let mut response = String::new();
        BufReader::new(pipe)
            .take(1024 * 1024)
            .read_line(&mut response)
            .await
            .map_err(|_| "service_read_failed")?;
        super::decode_response(&response)
    })
    .await
    .map_err(|_| "service_timeout")?
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::windows::named_pipe::ServerOptions;
    fn address(label: &str) -> PathBuf {
        PathBuf::from(format!(
            r"\\.\pipe\cialai-broto-control-test-{}-{label}",
            std::process::id()
        ))
    }
    #[test]
    fn windows_service_busy_retries_until_an_instance_is_available() {
        tauri::async_runtime::block_on(async {
            let path = address("busy");
            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .max_instances(1)
                .create(&path)
                .unwrap();
            let occupied = ClientOptions::new().open(&path).unwrap();
            server.connect().await.unwrap();
            assert_eq!(
                ClientOptions::new().open(&path).unwrap_err().raw_os_error(),
                Some(231)
            );
            let server_path = path.clone();
            let service = tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(120)).await;
                // A listener accepts through a fresh instance. Reusing the old
                // Tokio registration after disconnect retains stale readiness.
                drop(occupied);
                drop(server);
                // Windows keeps the cancelled overlapped handle counted until
                // its completion is drained. Yield until that instance is gone.
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                let server = loop {
                    match ServerOptions::new()
                        .first_pipe_instance(true)
                        .max_instances(1)
                        .create(&server_path)
                    {
                        Ok(server) => break server,
                        Err(error)
                            if matches!(error.raw_os_error(), Some(5 | 231))
                                && std::time::Instant::now() < deadline =>
                        {
                            tokio::time::sleep(Duration::from_millis(25)).await
                        }
                        Err(error) => panic!("fresh pipe instance was not released: {error}"),
                    }
                };
                server.connect().await.unwrap();
                let mut reader = BufReader::new(server);
                let mut request = String::new();
                reader.read_line(&mut request).await.unwrap();
                assert_eq!(
                    serde_json::from_str::<Value>(&request).unwrap()["method"],
                    "broto.status"
                );
                reader
                    .get_mut()
                    .write_all(b"{\"id\":\"monitor\",\"result\":{\"state\":\"paused\"}}\n")
                    .await
                    .unwrap();
                tokio::time::sleep(Duration::from_millis(50)).await;
            });
            let result = request(&path, "broto.status", json!({}), Duration::from_secs(5))
                .await
                .unwrap();
            assert_eq!(result["state"], "paused");
            service.await.unwrap();
        });
    }
    #[test]
    fn windows_service_without_response_has_a_bounded_deadline() {
        tauri::async_runtime::block_on(async {
            let path = address("no-response");
            let server = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&path)
                .unwrap();
            let service = tauri::async_runtime::spawn(async move {
                server.connect().await.unwrap();
                tokio::time::sleep(Duration::from_secs(10)).await;
            });
            let start = std::time::Instant::now();
            assert_eq!(
                request(&path, "broto.status", json!({}), Duration::from_millis(150))
                    .await
                    .unwrap_err(),
                "service_timeout"
            );
            assert!(start.elapsed() < Duration::from_secs(2));
            service.abort();
        });
    }
}
