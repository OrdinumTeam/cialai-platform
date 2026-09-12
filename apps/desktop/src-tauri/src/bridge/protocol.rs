// SPDX-License-Identifier: Apache-2.0
//! Pure validation and framing for the loopback bridge.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MAX_FRAME: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Incoming {
    Hello {
        version: u32,
        #[serde(default)]
        token: Option<String>,
        #[serde(default)]
        client: Option<String>,
    },
    Call {
        id: u64,
        cmd: String,
        #[serde(default = "empty_args")]
        args: Value,
    },
}

fn empty_args() -> Value {
    serde_json::json!({})
}

#[derive(Serialize)]
pub struct Welcome<'a> {
    pub r#type: &'static str,
    pub version: u32,
    pub auth: &'static str,
    pub user: Option<&'a str>,
    pub capabilities: [&'static str; 1],
    pub features: [&'static str; 1],
}

pub fn validate_hello(
    message: &Incoming,
    expected_token: Option<&str>,
    bearer: Option<&str>,
) -> Result<(), u16> {
    let Incoming::Hello { version, token, .. } = message else {
        return Err(4400);
    };
    if *version != 1 {
        return Err(4426);
    }
    if let Some(expected) = expected_token {
        if token.as_deref() != Some(expected) && bearer != Some(expected) {
            return Err(4401);
        }
    }
    Ok(())
}

pub fn validate_origin(origin: Option<&str>, dev_open: bool) -> bool {
    if dev_open {
        return true;
    }
    let Some(origin) = origin else {
        return true;
    };
    let Ok(url) = tauri::Url::parse(origin) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return false;
    }
    let Some(origin_host) = url.host_str() else {
        return false;
    };
    origin_host == "localhost"
        || origin_host
            .trim_matches(['[', ']'])
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback())
}

pub fn validate_path(path: &str) -> bool {
    path == "/" || path == "/pty" || path.starts_with("/pty/")
}

pub fn binary_frame(channel: u32, bytes: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(4 + bytes.len());
    frame.extend_from_slice(&channel.to_be_bytes());
    frame.extend_from_slice(bytes);
    frame
}

pub fn allowed_command(cmd: &str) -> bool {
    matches!(
        cmd,
        "pty_list"
            | "pty_metrics"
            | "ai_usage"
            | "pty_attach"
            | "pty_ack"
            | "pty_write"
            | "pty_spawn"
            | "pty_kill"
            | "pty_view_claim"
            | "pty_view_renew"
            | "pty_view_release"
            | "pty_files_list"
            | "pty_file_read"
            | "list_repo_dirs"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn handshake_distinguishes_protocol_version_and_auth_failures() {
        let hello: Incoming = serde_json::from_str(r#"{"type":"hello","version":1}"#).unwrap();
        assert_eq!(validate_hello(&hello, None, None), Ok(()));
        assert_eq!(validate_hello(&hello, Some("test-token"), None), Err(4401));
        assert_eq!(
            validate_hello(&hello, Some("test-token"), Some("test-token")),
            Ok(())
        );
        let old: Incoming = serde_json::from_str(r#"{"type":"hello","version":2}"#).unwrap();
        assert_eq!(validate_hello(&old, None, None), Err(4426));
        let call: Incoming =
            serde_json::from_str(r#"{"type":"call","id":1,"cmd":"pty_list"}"#).unwrap();
        assert_eq!(validate_hello(&call, None, None), Err(4400));
    }
    #[test]
    fn origins_require_exact_host_or_loopback_and_valid_http_url() {
        assert!(validate_origin(None, false));
        assert!(validate_origin(Some("https://mac.tail.ts.net:443"), true));
        assert!(validate_origin(Some("http://127.0.0.1:1420"), false));
        assert!(validate_origin(Some("http://[::1]:1420"), false));
        for bad in [
            "null",
            "https://evil.example",
            "https://mac.tail.ts.net.evil.example",
            "https://mac.tail.ts.net@evil.example",
            "file://mac.tail.ts.net",
            "https://mac.tail.ts.net/path",
        ] {
            assert!(!validate_origin(Some(bad), false), "{bad}");
        }
    }

    #[test]
    fn matching_untrusted_host_does_not_bypass_origin_policy_by_dns_rebinding() {
        assert!(!validate_origin(Some("http://evil.example:3720"), false));
        assert!(!validate_origin(
            Some("https://mac.ts.net.evil.example"),
            false
        ));
        assert!(!validate_origin(Some("https://mac.tail.ts.net"), false));
        assert!(validate_origin(Some("http://127.0.0.2"), false));
        assert!(validate_origin(Some("https://example.com"), true));
    }
    #[test]
    fn upgrade_paths_and_channel_bytes_match_wire_contract() {
        for path in ["/", "/pty", "/pty/session"] {
            assert!(validate_path(path));
        }
        for path in ["/pty-evil", "/api", "//pty"] {
            assert!(!validate_path(path));
        }
        assert_eq!(binary_frame(0x01020304, b"ab"), vec![1, 2, 3, 4, 97, 98]);
    }
    #[test]
    fn remote_allows_terminal_interaction_and_nonterminal_reads_only() {
        for cmd in [
            "pty_list",
            "pty_ack",
            "pty_spawn",
            "pty_attach",
            "pty_write",
            "pty_kill",
            "pty_view_claim",
            "pty_view_renew",
            "pty_view_release",
            "pty_files_list",
            "pty_file_read",
        ] {
            assert!(allowed_command(cmd));
        }
        for cmd in [
            "fs_reveal",
            "git_diff",
            "pty_resize",
            "pty_presentation",
            "vpn_resize",
            "stack_state",
            "stack_restart",
            "set_preferences",
            "recorder_show",
            "meetings_request_permissions",
            "vpn_open",
            "vpn_action",
            "vpn_cancel",
            "vpn_input",
            "meetings_start",
            "meetings_stop",
            "meetings_cancel",
            "meetings_dismiss",
            "meetings_set_muted",
            "meetings_update",
            "meetings_rename",
            "meetings_transcribe",
            "meetings_delete",
            "unknown",
        ] {
            assert!(!allowed_command(cmd));
        }
    }
}
