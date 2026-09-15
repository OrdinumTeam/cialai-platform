// SPDX-License-Identifier: Apache-2.0

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_LINE_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RpcProblem {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ResponseFrame {
    pub id: u64,
    pub ok: bool,
    pub result: Option<Value>,
    pub error: Option<RpcProblem>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct EventFrame {
    #[serde(rename = "event")]
    pub name: String,
    pub data: Value,
    pub ts: String,
}

#[derive(Clone, Debug)]
pub enum Inbound {
    Response(ResponseFrame),
    Event(EventFrame),
}

#[derive(Serialize)]
struct RequestFrame<'a> {
    id: u64,
    cmd: &'a str,
    args: Value,
}

pub fn parse_line(line: &str) -> Result<Inbound, String> {
    if line.is_empty() || line.len() > MAX_LINE_BYTES {
        return Err("quadro stdio vazio ou maior que 256 KiB".into());
    }
    let value: Value = serde_json::from_str(line).map_err(|_| "quadro stdio inválido")?;
    if value.get("event").is_some() {
        let event: EventFrame =
            serde_json::from_value(value).map_err(|_| "evento stdio inválido")?;
        if event.name.is_empty() || event.ts.is_empty() {
            return Err("evento stdio incompleto".into());
        }
        return Ok(Inbound::Event(event));
    }
    let response: ResponseFrame =
        serde_json::from_value(value).map_err(|_| "resposta stdio inválida")?;
    let valid = response.id > 0
        && ((response.ok && response.result.is_some() && response.error.is_none())
            || (!response.ok && response.result.is_none() && response.error.is_some()));
    if !valid {
        return Err("resposta stdio inconsistente".into());
    }
    Ok(Inbound::Response(response))
}

pub fn encode_request(id: u64, command: &str, args: Value) -> Result<String, String> {
    if id == 0 || command.is_empty() || !args.is_object() {
        return Err("requisição stdio inválida".into());
    }
    let mut line = serde_json::to_string(&RequestFrame {
        id,
        cmd: command,
        args,
    })
    .map_err(|_| "não foi possível codificar a requisição stdio")?;
    if line.len() > MAX_LINE_BYTES {
        return Err("requisição stdio maior que 256 KiB".into());
    }
    line.push('\n');
    Ok(line)
}

/// Canal `tunnel://*` de cada evento do sidecar: pareamento em `pair`,
/// celulares e sessões em `devices`, e `net.state`, `tor.state`,
/// `path.changed` e o estado do próprio supervisor em `state`.
pub fn event_channel(name: &str) -> &'static str {
    if name.starts_with("pair.") {
        "tunnel://pair"
    } else if name.starts_with("devices.") || name.starts_with("session.") {
        "tunnel://devices"
    } else {
        "tunnel://state"
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn parses_hello_response_and_routed_events() {
        let hello = parse_line(
            r#"{"event":"hello","data":{"protocol":1,"version":"0.1.0","tailscale":"1.102.0","pid":42},"ts":"2026-09-12T20:00:00Z"}"#,
        )
        .unwrap();
        let Inbound::Event(hello) = hello else {
            panic!("hello must be an event")
        };
        assert_eq!(hello.name, "hello");
        assert_eq!(hello.data["protocol"], 1);
        for (event, channel) in [
            ("net.state", "tunnel://state"),
            ("tor.state", "tunnel://state"),
            ("path.changed", "tunnel://state"),
            ("tunnel.state", "tunnel://state"),
            ("pair.requested", "tunnel://pair"),
            ("pair.completed", "tunnel://pair"),
            ("pair.failed", "tunnel://pair"),
            ("devices.changed", "tunnel://devices"),
            ("session.opened", "tunnel://devices"),
            ("session.closed", "tunnel://devices"),
        ] {
            assert_eq!(event_channel(event), channel, "{event}");
        }

        let response = parse_line(r#"{"id":7,"ok":true,"result":{"state":"running"}}"#).unwrap();
        let Inbound::Response(response) = response else {
            panic!("response expected")
        };
        assert_eq!(response.id, 7);
        assert_eq!(response.result, Some(json!({"state":"running"})));
    }

    #[test]
    fn rejects_ambiguous_invalid_and_oversized_frames() {
        for line in [
            r#"{"id":1,"ok":true,"result":{},"error":{"code":"bad","message":"bad","retryable":false}}"#,
            r#"{"id":1,"ok":false}"#,
            r#"{"event":"hello","data":{},"ts":"now","unknown":true}"#,
            r#"{"id":0,"ok":true,"result":{}}"#,
        ] {
            assert!(parse_line(line).is_err(), "accepted {line}");
        }
        assert!(parse_line(&"x".repeat(MAX_LINE_BYTES + 1)).is_err());
    }

    #[test]
    fn request_encoding_is_one_bounded_json_line() {
        let line = encode_request(9, "devices.list", json!({})).unwrap();
        assert_eq!(line, "{\"id\":9,\"cmd\":\"devices.list\",\"args\":{}}\n");
        assert!(encode_request(0, "devices.list", json!({})).is_err());
        assert!(encode_request(1, "", json!({})).is_err());
    }
}
