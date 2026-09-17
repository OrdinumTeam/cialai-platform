// SPDX-License-Identifier: Apache-2.0
//! Uso do plano do Codex, por perfil.
//!
//! Duas fontes, nesta ordem:
//!
//! 1. O endpoint que o proprio Codex consulta, com o `auth.json` do perfil.
//! 2. A ultima linha com `rate_limits` da cauda do arquivo de sessao mais
//!    recente daquele perfil, que e o que o estudio ja le hoje para o card.
//!    Marcada como derivada, porque a resposta e oficial mas chegou de
//!    segunda mao.
//!
//! O token nunca e renovado nem reescrito. Um perfil com login vencido diz
//! isso no anel, e quem renova e o `codex login` daquela pasta.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::super::profiles::{Profile, jwt_claims};
use super::{FetchError, Fidelity, LimitWindow, Reading, http, now_ms};

pub const SOURCE_API: &str = "chatgptApi";
pub const SOURCE_ROLLOUT: &str = "rollout";

const USAGE_ENDPOINT: &str = "https://chatgpt.com/backend-api/wham/usage";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
/// Cauda lida do arquivo de sessao.
const TAIL_BYTES: u64 = 256 * 1024;
/// Pastas de dia visitadas na busca pelo arquivo mais recente.
const RECENT_DAYS: usize = 3;

pub fn fetch(profile: &Profile, holding: bool) -> Result<Reading, FetchError> {
    if !holding {
        match from_api(profile) {
            Ok(reading) => return Ok(reading),
            // Recuo e login vencido nao caem para a cauda: o numero de la
            // seria igual ou mais velho, e esconderia o estado real.
            Err(
                error @ (FetchError::RateLimited { .. }
                | FetchError::NeedsAuth
                | FetchError::CredentialExpired),
            ) => {
                if let Some(reading) = from_rollout(&profile.dir()) {
                    return Ok(reading);
                }
                return Err(error);
            }
            Err(_) => {}
        }
    }
    from_rollout(&profile.dir()).ok_or(FetchError::Timeout)
}

/* ── credencial ────────────────────────────────────────────────────── */

pub struct Credential {
    pub access_token: String,
    pub account_id: String,
    pub plan: Option<String>,
}

pub fn credential(dir: &Path) -> Result<Credential, FetchError> {
    let raw = std::fs::read_to_string(dir.join("auth.json")).map_err(|_| FetchError::NeedsAuth)?;
    let parsed: serde_json::Value =
        serde_json::from_str(&raw).map_err(|_| FetchError::NeedsAuth)?;
    let access_token = parsed
        .pointer("/tokens/access_token")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    let account_id = parsed
        .pointer("/tokens/account_id")
        .and_then(|value| value.as_str())
        .unwrap_or_default()
        .to_string();
    if access_token.is_empty() || account_id.is_empty() {
        return Err(FetchError::NeedsAuth);
    }
    if let Some(claims) = jwt_claims(&access_token)
        && let Some(exp) = claims.get("exp").and_then(|value| value.as_u64())
        && exp * 1000 <= now_ms()
    {
        return Err(FetchError::CredentialExpired);
    }
    let plan = parsed
        .pointer("/tokens/id_token")
        .and_then(|value| value.as_str())
        .and_then(jwt_claims)
        .and_then(|claims| {
            claims
                .get("https://api.openai.com/auth")
                .and_then(|node| node.get("chatgpt_plan_type"))
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
        });
    Ok(Credential {
        access_token,
        account_id,
        plan,
    })
}

/* ── fonte 1: endpoint ─────────────────────────────────────────────── */

fn from_api(profile: &Profile) -> Result<Reading, FetchError> {
    let credential = credential(&profile.dir())?;
    let authorization = format!("Bearer {}", credential.access_token);
    let response = http::get(
        USAGE_ENDPOINT,
        &[
            ("Authorization", authorization.as_str()),
            ("ChatGPT-Account-Id", credential.account_id.as_str()),
            ("Accept", "application/json"),
        ],
        HTTP_TIMEOUT,
    )?;

    if response.status == 401 || response.status == 403 {
        return Err(FetchError::NeedsAuth);
    }
    if response.status == 429 {
        let retry = response
            .header("retry-after")
            .and_then(|value| http::retry_after_ms(value, now_ms()));
        return Err(FetchError::RateLimited {
            until_ms: now_ms() + retry.unwrap_or(60_000).max(60_000),
        });
    }
    if !response.is_success() {
        return Err(FetchError::BadResponse(response.status));
    }
    let parsed: serde_json::Value = serde_json::from_str(&response.body)
        .map_err(|_| FetchError::BadResponse(response.status))?;
    let windows = windows_from(&parsed);
    if windows.is_empty() {
        return Err(FetchError::NothingMetered);
    }
    let plan = parsed
        .get("plan_type")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
        .or(credential.plan);
    Ok(Reading {
        windows,
        plan,
        fidelity: Fidelity::Official,
        source: SOURCE_API.to_string(),
    })
}

/// Janelas do corpo do endpoint. Cada campo entra com tolerancia: uma janela
/// malformada nao derruba as outras.
pub fn windows_from(parsed: &serde_json::Value) -> Vec<LimitWindow> {
    let mut windows = Vec::new();
    if let Some(node) = parsed.pointer("/rate_limit/primary_window") {
        push(&mut windows, node, "primary", None, true);
    }
    if let Some(node) = parsed.pointer("/rate_limit/secondary_window") {
        push(&mut windows, node, "secondary", None, false);
    }
    if let Some(extras) = parsed
        .get("additional_rate_limits")
        .and_then(|value| value.as_array())
    {
        for extra in extras {
            let name = extra
                .get("limit_name")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            let feature = extra
                .get("metered_feature")
                .and_then(|value| value.as_str())
                .unwrap_or_default();
            if !name.to_ascii_lowercase().contains("spark")
                && !feature.to_ascii_lowercase().contains("spark")
            {
                continue;
            }
            if let Some(node) = extra.pointer("/rate_limit/primary_window") {
                push(&mut windows, node, "spark", Some("Spark"), true);
            }
            if let Some(node) = extra.pointer("/rate_limit/secondary_window") {
                push(&mut windows, node, "spark-secondary", Some("Spark"), false);
            }
        }
    }
    if let Some(node) = parsed.pointer("/code_review_rate_limit/primary_window") {
        push(&mut windows, node, "code-review", Some("codeReview"), true);
    }
    if let Some(node) = parsed.pointer("/code_review_rate_limit/secondary_window") {
        push(
            &mut windows,
            node,
            "code-review-secondary",
            Some("codeReview"),
            false,
        );
    }
    windows
}

fn push(
    windows: &mut Vec<LimitWindow>,
    node: &serde_json::Value,
    id: &str,
    group: Option<&str>,
    primary: bool,
) {
    if windows.iter().any(|window| window.id == id) {
        return;
    }
    let Some(window) = limit_window(node, id, group, primary) else {
        return;
    };
    windows.push(window);
}

fn limit_window(
    node: &serde_json::Value,
    id: &str,
    group: Option<&str>,
    primary: bool,
) -> Option<LimitWindow> {
    let used = node.get("used_percent").and_then(|value| value.as_f64())?;
    let seconds = node
        .get("limit_window_seconds")
        .and_then(|value| value.as_u64());
    let resets = node
        .get("reset_at")
        .and_then(|value| value.as_u64())
        .map(|value| value.saturating_mul(1000))
        .or_else(|| {
            node.get("reset_after_seconds")
                .and_then(|value| value.as_u64())
                .map(|value| now_ms() + value * 1000)
        });
    Some(LimitWindow {
        id: id.to_string(),
        group: group.map(|value| value.to_string()),
        label: label_for(seconds, primary),
        used_fraction: Some(used / 100.0),
        resets_at_ms: resets,
        duration_ms: seconds.map(|value| value * 1000),
    })
}

/// Codigo do rotulo. Com duracao conhecida vale `duration`, que a interface
/// formata a partir de `durationMs`, porque o plano muda o que cada janela
/// cobre; sem duracao, a principal e a sessao atual e a outra a janela longa.
pub fn label_for(seconds: Option<u64>, primary: bool) -> String {
    match seconds.filter(|value| *value > 0) {
        Some(_) => "duration".to_string(),
        None if primary => "session".to_string(),
        None => "longWindow".to_string(),
    }
}

/* ── fonte 2: cauda do arquivo de sessao ───────────────────────────── */

fn from_rollout(dir: &Path) -> Option<Reading> {
    let path = newest_rollout(dir)?;
    let line = last_rate_limits_line(&path)?;
    let parsed: serde_json::Value = serde_json::from_str(&line).ok()?;
    let limits = parsed
        .pointer("/payload/rate_limits")
        .or_else(|| parsed.get("rate_limits"))?;
    let mut windows = Vec::new();
    if let Some(node) = limits.get("primary") {
        push(&mut windows, node, "primary", None, true);
    }
    if let Some(node) = limits.get("secondary") {
        push(&mut windows, node, "secondary", None, false);
    }
    if windows.is_empty() {
        return None;
    }
    let plan = limits
        .get("plan_type")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    Some(Reading {
        windows,
        plan,
        fidelity: Fidelity::Derived,
        source: SOURCE_ROLLOUT.to_string(),
    })
}

/// O arquivo de sessao mais recente do perfil, olhando so os dias recentes.
fn newest_rollout(dir: &Path) -> Option<PathBuf> {
    let sessions = dir.join("sessions");
    if !sessions.is_dir() {
        return None;
    }
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for day in recent_days(&sessions) {
        let Ok(read) = std::fs::read_dir(&day) else {
            continue;
        };
        for item in read.flatten() {
            let path = item.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(modified) = item.metadata().and_then(|meta| meta.modified()) else {
                continue;
            };
            if newest.as_ref().is_none_or(|(time, _)| modified > *time) {
                newest = Some((modified, path));
            }
        }
    }
    newest.map(|(_, path)| path)
}

/// `sessions/AAAA/MM/DD`, do mais recente para tras. Uma sessao aberta ontem
/// continua recebendo linhas hoje, entao mais de um dia entra.
fn recent_days(sessions: &Path) -> Vec<PathBuf> {
    fn children(dir: &Path) -> Vec<PathBuf> {
        let Ok(read) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut found: Vec<PathBuf> = read
            .flatten()
            .filter(|item| item.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|item| item.path())
            .collect();
        found.sort();
        found.reverse();
        found
    }
    let mut days = Vec::new();
    for year in children(sessions).into_iter().take(2) {
        for month in children(&year).into_iter().take(2) {
            for day in children(&month) {
                days.push(day);
                if days.len() >= RECENT_DAYS {
                    return days;
                }
            }
        }
    }
    days
}

fn last_rate_limits_line(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer);
    text.lines()
        .rfind(|line| line.contains("\"rate_limits\""))
        .map(|line| line.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = r#"{
      "rate_limit": {
        "primary_window":   { "used_percent": 25, "limit_window_seconds": 18000,  "reset_at": 1800001000 },
        "secondary_window": { "used_percent": 10, "limit_window_seconds": 604800, "reset_at": 1800600000 }
      },
      "plan_type": "plus",
      "additional_rate_limits": [
        { "limit_name": "Spark", "metered_feature": "spark",
          "rate_limit": { "primary_window": { "used_percent": 4, "limit_window_seconds": 3600, "reset_at": 1800001000 } } }
      ],
      "code_review_rate_limit": { "primary_window": { "used_percent": 2, "limit_window_seconds": 86400, "reset_at": 1800001000 } }
    }"#;

    #[test]
    fn the_two_main_windows_come_first() {
        let parsed: serde_json::Value = serde_json::from_str(BODY).unwrap();
        let windows = windows_from(&parsed);
        assert_eq!(windows[0].id, "primary");
        assert_eq!(windows[0].used_fraction, Some(0.25));
        assert_eq!(windows[0].duration_ms, Some(18_000_000));
        assert_eq!(windows[0].label, "duration");
        assert_eq!(windows[1].id, "secondary");
        assert_eq!(windows[1].used_fraction, Some(0.10));
    }

    #[test]
    fn spark_and_code_review_come_grouped() {
        let parsed: serde_json::Value = serde_json::from_str(BODY).unwrap();
        let windows = windows_from(&parsed);
        let spark = windows.iter().find(|window| window.id == "spark").unwrap();
        assert_eq!(spark.group.as_deref(), Some("Spark"));
        let review = windows
            .iter()
            .find(|window| window.id == "code-review")
            .unwrap();
        assert_eq!(review.group.as_deref(), Some("codeReview"));
    }

    #[test]
    fn a_malformed_window_does_not_drop_the_others() {
        let body = r#"{"rate_limit":{"primary_window":{"used_percent":"muito"},"secondary_window":{"used_percent":9,"limit_window_seconds":604800,"reset_at":1}}}"#;
        let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
        let windows = windows_from(&parsed);
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].id, "secondary");
    }

    #[test]
    fn the_label_is_a_code_the_interface_formats() {
        assert_eq!(label_for(Some(18_000), true), "duration");
        assert_eq!(label_for(Some(604_800), false), "duration");
        assert_eq!(label_for(Some(0), true), "session");
        assert_eq!(label_for(None, true), "session");
        assert_eq!(label_for(None, false), "longWindow");
    }

    #[test]
    fn the_free_plan_keeps_its_monthly_duration() {
        let body = r#"{"rate_limit":{"primary_window":{"used_percent":40,"limit_window_seconds":2592000,"reset_at":1800001000}}}"#;
        let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
        let windows = windows_from(&parsed);
        assert_eq!(windows[0].label, "duration");
        assert_eq!(windows[0].duration_ms, Some(2_592_000_000));
    }

    #[test]
    fn reset_after_seconds_is_used_when_there_is_no_absolute_reset() {
        let body = r#"{"rate_limit":{"primary_window":{"used_percent":1,"limit_window_seconds":18000,"reset_after_seconds":120}}}"#;
        let parsed: serde_json::Value = serde_json::from_str(body).unwrap();
        let windows = windows_from(&parsed);
        let reset = windows[0].resets_at_ms.unwrap();
        assert!(reset > now_ms() && reset <= now_ms() + 121_000);
    }

    #[test]
    fn the_rollout_tail_is_a_derived_reading() {
        let dir = std::env::temp_dir().join(format!("cialai-notch-codex-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let day = dir.join("sessions/2026/09/16");
        std::fs::create_dir_all(&day).unwrap();
        let line = r#"{"type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":12,"window_minutes":300,"limit_window_seconds":18000,"reset_at":1800001000},"secondary":{"used_percent":3,"limit_window_seconds":604800,"reset_at":1800600000}}}}"#;
        std::fs::write(
            day.join("rollout-2026-09-16-abc.jsonl"),
            format!("{{\"outro\":1}}\n{line}\n"),
        )
        .unwrap();
        let reading = from_rollout(&dir).unwrap();
        assert_eq!(reading.fidelity, Fidelity::Derived);
        assert_eq!(reading.source, SOURCE_ROLLOUT);
        assert_eq!(reading.windows[0].id, "primary");
        assert_eq!(reading.windows[0].used_fraction, Some(0.12));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_profile_without_sessions_has_no_fallback() {
        let dir =
            std::env::temp_dir().join(format!("cialai-notch-codex-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(from_rollout(&dir).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_auth_file_without_tokens_needs_a_login() {
        let dir =
            std::env::temp_dir().join(format!("cialai-notch-codex-auth-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("auth.json"), r#"{"tokens":{}}"#).unwrap();
        assert_eq!(credential(&dir).err(), Some(FetchError::NeedsAuth));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
