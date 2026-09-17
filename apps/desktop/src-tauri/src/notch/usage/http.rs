// SPDX-License-Identifier: Apache-2.0
//! Cliente HTTP minimo sobre o `curl` do sistema.
//!
//! O app nao carrega uma pilha TLS propria para duas chamadas de leitura. O
//! `curl` do macOS e o do Windows 10 ja validam certificado com as raizes do
//! sistema, e o das distribuicoes Linux tambem; o processo custa alguns
//! milissegundos contra uma leitura por minuto. Sem `curl` a fonte fica
//! indisponivel, com estado de erro, e a proxima da cascata entra.
//!
//! Cabecalhos e corpo saem no mesmo fluxo por `--include`, porque
//! `/dev/stderr` nao existe no Windows; o corpo comeca depois da primeira
//! linha em branco do ultimo bloco de cabecalhos.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use crate::platform::{self, child_env};

use super::FetchError;

pub struct Response {
    pub status: u16,
    pub body: String,
    headers: Vec<(String, String)>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        let wanted = name.to_ascii_lowercase();
        self.headers
            .iter()
            .find(|(key, _)| *key == wanted)
            .map(|(_, value)| value.as_str())
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

/// O `curl` do sistema: `/usr/bin/curl` no macOS e na maioria das
/// distribuicoes, `System32\curl.exe` no Windows 10 ou mais novo, senao o
/// primeiro do `PATH`.
pub fn curl_binary() -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let system = PathBuf::from("/usr/bin/curl");
        if system.is_file() {
            return Some(system);
        }
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let system = PathBuf::from(root).join("System32").join("curl.exe");
            if system.is_file() {
                return Some(system);
            }
        }
    }
    which::which("curl").ok()
}

/// GET com cabecalhos, sem cache e com prazo.
pub fn get(url: &str, headers: &[(&str, &str)], timeout: Duration) -> Result<Response, FetchError> {
    let binary = curl_binary().ok_or(FetchError::CurlMissing)?;
    let mut command = Command::new(binary);
    command
        .arg("--silent")
        .arg("--show-error")
        .arg("--include")
        .arg("--max-time")
        .arg(format!("{}", timeout.as_secs().max(1)))
        // Sem cache em disco nem reuso de resposta: o numero precisa ser o de
        // agora.
        .arg("-H")
        .arg("Cache-Control: no-cache, no-store");
    for (name, value) in headers {
        command.arg("-H").arg(format!("{name}: {value}"));
    }
    command
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // O curl carrega TLS por bibliotecas do sistema, que o LD_LIBRARY_PATH
    // do AppImage quebraria.
    child_env::sanitize(&mut command);
    platform::configure_background_command(&mut command);

    let output = command
        .output()
        .map_err(|error| FetchError::Io(error.to_string()))?;
    if !output.status.success() {
        // 28 e o prazo estourado; o resto e rede ou certificado. A mensagem
        // do curl nao carrega cabecalho de pedido, entao nao carrega token.
        if output.status.code() == Some(28) {
            return Err(FetchError::Timeout);
        }
        let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(FetchError::Io(if message.is_empty() {
            format!("curl {}", output.status.code().unwrap_or_default())
        } else {
            message
        }));
    }
    let (status, headers, body) = split_response(&output.stdout);
    Ok(Response {
        status,
        body,
        headers,
    })
}

/// Separa os blocos de cabecalho do corpo. Um redirecionamento ou um `100
/// Continue` deixam mais de um bloco; vale o ultimo.
fn split_response(raw: &[u8]) -> (u16, Vec<(String, String)>, String) {
    let mut status = 0u16;
    let mut headers = Vec::new();
    let mut cursor = 0usize;
    while raw[cursor..].starts_with(b"HTTP/") {
        let Some((end, next)) = blank_line(&raw[cursor..]) else {
            // So cabecalhos, sem corpo.
            let (code, list) = parse_headers(&String::from_utf8_lossy(&raw[cursor..]));
            return (code, list, String::new());
        };
        let (code, list) = parse_headers(&String::from_utf8_lossy(&raw[cursor..cursor + end]));
        status = code;
        headers = list;
        cursor += next;
    }
    (
        status,
        headers,
        String::from_utf8_lossy(&raw[cursor..]).to_string(),
    )
}

/// Fim do bloco e inicio do que vem depois da primeira linha em branco.
fn blank_line(raw: &[u8]) -> Option<(usize, usize)> {
    for (index, byte) in raw.iter().enumerate() {
        if *byte != b'\n' {
            continue;
        }
        let rest = &raw[index + 1..];
        if rest.starts_with(b"\r\n") {
            return Some((index + 1, index + 3));
        }
        if rest.starts_with(b"\n") {
            return Some((index + 1, index + 2));
        }
    }
    None
}

fn parse_headers(raw: &str) -> (u16, Vec<(String, String)>) {
    let mut status = 0u16;
    let mut headers = Vec::new();
    for line in raw.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        if let Some(rest) = line.strip_prefix("HTTP/") {
            status = rest
                .split_whitespace()
                .nth(1)
                .and_then(|code| code.parse().ok())
                .unwrap_or(status);
            headers.clear();
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    (status, headers)
}

/// `Retry-After` em milissegundos. Aceita segundos ou data HTTP, nunca
/// negativo.
pub fn retry_after_ms(value: &str, now_ms: u64) -> Option<u64> {
    let trimmed = value.trim();
    if let Ok(seconds) = trimmed.parse::<f64>() {
        if seconds <= 0.0 {
            return Some(0);
        }
        return Some((seconds * 1000.0) as u64);
    }
    let parsed = chrono::DateTime::parse_from_rfc2822(trimmed).ok()?;
    let target = parsed.timestamp_millis().max(0) as u64;
    Some(target.saturating_sub(now_ms))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_status_the_headers_and_the_body() {
        let raw =
            b"HTTP/2 429 \r\nretry-after: 30\r\ncontent-type: application/json\r\n\r\n{\"a\":1}";
        let (status, headers, body) = split_response(raw);
        assert_eq!(status, 429);
        assert_eq!(
            headers
                .iter()
                .find(|(key, _)| key == "retry-after")
                .unwrap()
                .1,
            "30"
        );
        assert_eq!(body, "{\"a\":1}");
    }

    #[test]
    fn a_redirect_leaves_only_the_last_block() {
        let raw = b"HTTP/1.1 301 Moved\r\nlocation: /next\r\n\r\nHTTP/2 200 \r\ncontent-type: application/json\r\n\r\n{}";
        let (status, headers, body) = split_response(raw);
        assert_eq!(status, 200);
        assert!(headers.iter().all(|(key, _)| key != "location"));
        assert_eq!(body, "{}");
    }

    #[test]
    fn bare_newlines_and_a_missing_body_are_tolerated() {
        let (status, _, body) = split_response(b"HTTP/1.1 204 No Content\nx: y\n\n");
        assert_eq!(status, 204);
        assert_eq!(body, "");
        let (status, headers, body) = split_response(b"HTTP/1.1 500 Oops\r\nx: y");
        assert_eq!(status, 500);
        assert_eq!(headers.len(), 1);
        assert_eq!(body, "");
        let (status, _, body) = split_response(b"sem cabecalho");
        assert_eq!(status, 0);
        assert_eq!(body, "sem cabecalho");
    }

    #[test]
    fn retry_after_in_seconds() {
        assert_eq!(retry_after_ms("30", 0), Some(30_000));
        assert_eq!(retry_after_ms("0", 0), Some(0));
        assert_eq!(retry_after_ms("-5", 0), Some(0));
    }

    #[test]
    fn retry_after_as_a_date() {
        let value = "Wed, 21 Oct 2026 07:28:00 GMT";
        let at = chrono::DateTime::parse_from_rfc2822(value)
            .unwrap()
            .timestamp_millis() as u64;
        assert_eq!(retry_after_ms(value, at - 5_000), Some(5_000));
        assert_eq!(
            retry_after_ms(value, at + 5_000),
            Some(0),
            "data no passado nao espera"
        );
    }
}
