// SPDX-License-Identifier: Apache-2.0
//! Uso do plano do Claude Code, por perfil.
//!
//! Nenhuma dessas fontes publica "quanto do limite foi gasto" como API. Cada
//! uma le o que a propria ferramenta ja le, e por isso sao quatro, tentadas
//! nesta ordem, caindo para a seguinte sem lancar erro:
//!
//! 1. **Hook de linha de estado**, que o Cialai instala. O Claude Code
//!    entrega `rate_limits` a cada redesenho da linha, e o script publica em
//!    `ai-usage/claude/<perfil>.json`. Nao custa processo, nao custa rede e
//!    nao abre dialogo, entao vem primeiro.
//! 2. **Cache do Claude Desktop**, para quem trabalha no app e nao no
//!    terminal, onde as duas fontes seguintes ficam mudas. So macOS e
//!    Windows tem o app; no Linux a fonte e pulada.
//! 3. **`claude /usage`**, perguntando a propria ferramenta.
//! 4. **Credencial do Claude Code** contra o endpoint que o `/usage` usa.
//!
//! Os ids das janelas sao normalizados para `session` e `weekly_all` em todas
//! as fontes, para o anel e o card nao trocarem de identidade conforme quem
//! respondeu. Os rotulos saem como codigos, que a interface traduz.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use chrono::{Datelike, Local, NaiveDateTime, TimeZone};

use crate::platform::{self, child_env};

use super::super::profiles::Profile;
use super::{FetchError, Fidelity, LimitWindow, Reading, credentials, http, now_ms};

pub const SOURCE_HOOK: &str = "statusline";
pub const SOURCE_DESKTOP: &str = "desktopCache";
pub const SOURCE_CLI: &str = "cli";
pub const SOURCE_API: &str = "anthropicApi";

const USAGE_ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
/// Idade maxima do arquivo do hook e do cache do Desktop.
const FRESH_MS: u64 = 30 * 60 * 1000;
/// A linha de comando custa um processo: no maximo uma a cada cinco minutos.
const CLI_INTERVAL_MS: u64 = 5 * 60 * 1000;
/// Uma varredura falha do cache do Desktop suprime a proxima por este tempo.
const DESKTOP_MISS_MS: u64 = 5 * 60 * 1000;
const CLI_TIMEOUT: Duration = Duration::from_secs(20);
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Percorre a cadeia de fontes.
pub fn fetch(
    profile: &Profile,
    home: &Path,
    app_support: &Path,
    holding: bool,
    cli_cache: Option<(u64, Reading)>,
    desktop_miss: Option<u64>,
) -> Result<Reading, FetchError> {
    let now = now_ms();
    if let Some(reading) = from_hook(profile, app_support, now) {
        return Ok(reading);
    }
    if let Some(reading) = from_desktop(profile, home, now, desktop_miss) {
        return Ok(reading);
    }
    if let Some((at, reading)) = cli_cache
        && now.saturating_sub(at) < CLI_INTERVAL_MS
        && !expired(&reading.windows, now)
    {
        return Ok(reading);
    }
    if let Some(reading) = from_cli(profile, home) {
        return Ok(reading);
    }
    if holding {
        // O recuo do endpoint vale; nao gastar a tentativa.
        return Err(FetchError::RateLimited { until_ms: now });
    }
    from_api(profile)
}

fn expired(windows: &[LimitWindow], now: u64) -> bool {
    windows
        .iter()
        .any(|window| window.resets_at_ms.is_some_and(|reset| reset <= now))
}

/* ── fonte 1: arquivo do hook de linha de estado ───────────────────── */

fn from_hook(profile: &Profile, app_support: &Path, now: u64) -> Option<Reading> {
    let path = app_support
        .join(crate::workspace::ai::CLAUDE_DIR)
        .join(format!("{}.json", profile.id));
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let updated = parsed
        .get("updatedAtMs")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    if updated == 0 || now.saturating_sub(updated) > FRESH_MS {
        return None;
    }
    let windows: Vec<LimitWindow> = parsed
        .get("windows")?
        .as_array()?
        .iter()
        .filter_map(|node| {
            let id = normalize_id(node.get("id")?.as_str()?);
            let used = node.get("usedPercent")?.as_f64()?;
            let resets = node.get("resetsAtMs").and_then(|value| value.as_u64());
            Some(LimitWindow {
                duration_ms: node
                    .get("windowMinutes")
                    .and_then(|value| value.as_u64())
                    .map(|minutes| minutes * 60_000)
                    .or_else(|| duration_for(&id)),
                label: label_for(&id),
                id,
                group: None,
                used_fraction: Some(used / 100.0),
                resets_at_ms: resets,
            })
        })
        .collect();
    if windows.is_empty() || expired(&windows, now) {
        return None;
    }
    Some(Reading {
        windows: sorted(windows),
        plan: parsed
            .get("plan")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        fidelity: Fidelity::Official,
        source: SOURCE_HOOK.to_string(),
    })
}

/* ── fonte 2: cache do Claude Desktop ──────────────────────────────── */

fn from_desktop(profile: &Profile, home: &Path, now: u64, miss_at: Option<u64>) -> Option<Reading> {
    if miss_at.is_some_and(|at| now.saturating_sub(at) < DESKTOP_MISS_MS) {
        return None;
    }
    let organization = super::desktop_cache::organization_of(profile)?;
    let found = super::desktop_cache::read(home, &organization)?;
    if now.saturating_sub(found.captured_at_ms) > FRESH_MS {
        return None;
    }
    let windows = windows_from_response(&found.body)?;
    if windows.is_empty() || expired(&windows, now) {
        return None;
    }
    Some(Reading {
        windows,
        plan: None,
        fidelity: Fidelity::Official,
        source: SOURCE_DESKTOP.to_string(),
    })
}

/* ── fonte 3: a propria ferramenta ─────────────────────────────────── */

fn from_cli(profile: &Profile, home: &Path) -> Option<Reading> {
    let binary = locate(home)?;
    let scratch = std::env::temp_dir().join("cialai-notch-usage");
    let _ = std::fs::create_dir_all(&scratch);
    let mut command = Command::new(&binary);
    command
        .args([
            "--print",
            "--no-session-persistence",
            "--strict-mcp-config",
            "/usage",
        ])
        .current_dir(&scratch)
        .env("PWD", &scratch)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Com a variavel apontando para a pasta padrao, o Claude Code procura o
    // `.claude.json` dentro dela em vez de ao lado. So perfil nomeado a leva.
    if profile.slug.is_some() {
        command.env("CLAUDE_CONFIG_DIR", &profile.config_dir);
    } else {
        command.env_remove("CLAUDE_CONFIG_DIR");
    }
    // A telemetria fica como esta: desliga-la apaga a linha semanal por
    // modelo da resposta.
    child_env::sanitize(&mut command);
    platform::configure_background_command(&mut command);
    let output = run_with_timeout(command, CLI_TIMEOUT)?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    let windows = parse_usage_output(&text);
    if windows.is_empty() {
        return None;
    }
    Some(Reading {
        windows,
        plan: plan_in(&text),
        fidelity: Fidelity::Official,
        source: SOURCE_CLI.to_string(),
    })
}

/// Espera o processo com prazo, levando o grupo inteiro quando ele passa.
fn run_with_timeout(mut command: Command, limit: Duration) -> Option<std::process::Output> {
    let mut child = command.spawn().ok()?;
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() > limit {
                    platform::terminate_background_process(child.id(), true);
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return None,
        }
    }
    child.wait_with_output().ok()
}

/// Lugares conhecidos dentro da pasta pessoal.
#[cfg(not(target_os = "windows"))]
const HOME_CANDIDATES: &[&str] = &[
    ".local/bin/claude",
    ".claude/local/claude",
    ".bun/bin/claude",
    ".volta/bin/claude",
    "Library/pnpm/claude",
    ".npm-global/bin/claude",
];
#[cfg(target_os = "windows")]
const HOME_CANDIDATES: &[&str] = &[
    ".local/bin/claude.exe",
    ".claude/local/claude.exe",
    ".bun/bin/claude.exe",
    ".volta/bin/claude.exe",
];

/// Lugares conhecidos fora dela, do mais especifico ao mais generico.
fn system_candidates() -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"]
            .into_iter()
            .map(PathBuf::from)
            .collect()
    }
    #[cfg(target_os = "linux")]
    {
        ["/usr/local/bin/claude", "/usr/bin/claude"]
            .into_iter()
            .map(PathBuf::from)
            .collect()
    }
    #[cfg(target_os = "windows")]
    {
        let mut found = Vec::new();
        if let Some(roaming) = std::env::var_os("APPDATA") {
            found.push(PathBuf::from(roaming).join("npm").join("claude.cmd"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            found.push(
                PathBuf::from(local)
                    .join("Programs")
                    .join("claude")
                    .join("claude.exe"),
            );
        }
        found
    }
}

/// O binario do Claude Code. O `PATH` de um app aberto pelo Finder ou pelo
/// Dock e curto demais para um `which` resolver, entao os lugares conhecidos
/// entram na mao, e o `PATH` fica por ultimo.
pub fn locate(home: &Path) -> Option<PathBuf> {
    for item in HOME_CANDIDATES {
        let path = home.join(item);
        if is_executable(&path) {
            return Some(path);
        }
    }
    // Versoes do nvm, da mais nova para a mais velha.
    let nvm = home.join(".nvm/versions/node");
    if let Ok(read) = std::fs::read_dir(&nvm) {
        let mut versions: Vec<PathBuf> = read.flatten().map(|item| item.path()).collect();
        versions.sort_by_key(|path| std::cmp::Reverse(version_key(path)));
        for version in versions {
            let path = version.join("bin/claude");
            if is_executable(&path) {
                return Some(path);
            }
        }
    }
    for path in system_candidates() {
        if is_executable(&path) {
            return Some(path);
        }
    }
    which::which("claude").ok()
}

fn version_key(path: &Path) -> Vec<u64> {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
        .trim_start_matches('v')
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Le as linhas `Current session:` e `Current week (...):` da saida do
/// `/usage`.
///
/// Sem expressao regular: o formato e fixo o bastante, e os percentuais da
/// prosa que vem depois nao comecam com `Current`, entao nao entram.
pub fn parse_usage_output(text: &str) -> Vec<LimitWindow> {
    let mut windows: Vec<LimitWindow> = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("Current ") else {
            continue;
        };
        let (id, after) = if let Some(after) = rest.strip_prefix("session:") {
            ("session".to_string(), after)
        } else if let Some(after) = rest.strip_prefix("week (") {
            let Some((scope, after)) = after.split_once(')') else {
                continue;
            };
            let Some(after) = after.strip_prefix(':') else {
                continue;
            };
            (weekly_id(scope), after)
        } else {
            continue;
        };
        let Some((percent, tail)) = percent_before_used(after) else {
            continue;
        };
        if windows.iter().any(|window| window.id == id) {
            continue;
        }
        windows.push(LimitWindow {
            duration_ms: duration_for(&id),
            label: label_for(&id),
            id,
            group: None,
            used_fraction: Some(percent / 100.0),
            resets_at_ms: tail.and_then(parse_reset),
        });
    }
    // Sem a janela da sessao a leitura nao serve: e ela que vai no anel.
    if !windows.iter().any(|window| window.id == "session") {
        return Vec::new();
    }
    sorted(windows)
}

/// `  38% used · resets Sep 7 at 2:59pm (Asia/Jakarta)` vira `(38.0, "Sep 7 ...")`.
fn percent_before_used(text: &str) -> Option<(f64, Option<&str>)> {
    let marker = text.find("% used")?;
    let digits: String = text[..marker]
        .chars()
        .rev()
        .take_while(|value| value.is_ascii_digit() || *value == '.')
        .collect::<Vec<char>>()
        .into_iter()
        .rev()
        .collect();
    let percent: f64 = digits.trim().parse().ok()?;
    let tail = text[marker..]
        .find("resets ")
        .map(|at| text[marker + at + "resets ".len()..].trim());
    Some((percent, tail))
}

/// Na hora cheia o Claude Code imprime `3pm` em vez de `3:00pm`. Completar os
/// minutos deixa um formato so para o leitor de data.
fn with_minutes(text: &str) -> String {
    let Some(marker) = text.find("AM").or_else(|| text.find("PM")) else {
        return text.to_string();
    };
    let head = &text[..marker];
    let digits = head
        .chars()
        .rev()
        .take_while(|value| value.is_ascii_digit())
        .count();
    if digits == 0 || head[..head.len() - digits].ends_with(':') {
        return text.to_string();
    }
    format!("{head}:00{}", &text[marker..])
}

/// `Sep 7 at 2:59pm (Asia/Jakarta)` em epoch ms.
///
/// O fuso impresso e o local de quem rodou o comando, entao a data e lida no
/// fuso local. Sem ano na saida, vale o ano cuja data cai mais perto de
/// agora, o que resolve a virada de dezembro para janeiro.
pub fn parse_reset(text: &str) -> Option<u64> {
    let cleaned = text.split('(').next().unwrap_or(text).trim();
    let normalized = with_minutes(&cleaned.replace("am", "AM").replace("pm", "PM"));
    let now = Local::now();
    let mut best: Option<(i64, i64)> = None;
    for year in [now.year() - 1, now.year(), now.year() + 1] {
        let with_year = format!("{normalized} {year}");
        let Some(naive) = NaiveDateTime::parse_from_str(&with_year, "%b %e at %I:%M%p %Y").ok()
        else {
            continue;
        };
        let Some(local) = Local.from_local_datetime(&naive).single() else {
            continue;
        };
        let stamp = local.timestamp_millis();
        let distance = (stamp - now.timestamp_millis()).abs();
        if best.is_none_or(|(_, previous)| distance < previous) {
            best = Some((stamp, distance));
        }
    }
    best.map(|(stamp, _)| stamp.max(0) as u64)
}

/// Plano assinado, nas primeiras linhas da saida.
pub fn plan_in(text: &str) -> Option<String> {
    let head: String = text.lines().take(4).collect::<Vec<&str>>().join(" ");
    let lower = head.to_ascii_lowercase();
    for phrase in ["max 20x", "max 5x", "extra usage", "max", "pro", "team"] {
        if let Some(at) = lower.find(phrase) {
            // `Max` sozinho nao vale quando a linha ja disse `Max 5x`.
            if phrase == "max" && (lower.contains("max 5x") || lower.contains("max 20x")) {
                continue;
            }
            return Some(head[at..at + phrase.len()].to_string());
        }
    }
    None
}

/* ── fonte 4: credencial contra o endpoint ─────────────────────────── */

fn from_api(profile: &Profile) -> Result<Reading, FetchError> {
    let credential = credentials::read(&profile.id, &profile.dir(), profile.slug.is_none())?;
    if credential.is_expired() {
        return Err(FetchError::CredentialExpired);
    }
    let authorization = format!("Bearer {}", credential.access_token);
    let response = http::get(
        USAGE_ENDPOINT,
        &[
            ("Authorization", authorization.as_str()),
            ("anthropic-beta", OAUTH_BETA),
            ("Accept", "application/json"),
        ],
        HTTP_TIMEOUT,
    )?;

    if response.status == 401 || response.status == 403 {
        credentials::forget(&profile.id);
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
    let windows =
        windows_from_response(&response.body).ok_or(FetchError::BadResponse(response.status))?;
    if windows.is_empty() {
        return Err(FetchError::NothingMetered);
    }
    Ok(Reading {
        windows,
        plan: credential.subscription,
        fidelity: Fidelity::Official,
        source: SOURCE_API.to_string(),
    })
}

/// Corpo do endpoint de uso, usado tanto pela chamada direta quanto pelo
/// cache do Claude Desktop, que guarda a mesma resposta.
pub fn windows_from_response(body: &str) -> Option<Vec<LimitWindow>> {
    let parsed: serde_json::Value = serde_json::from_str(body).ok()?;
    let mut windows: Vec<LimitWindow> = Vec::new();

    if let Some(limits) = parsed.get("limits").and_then(|value| value.as_array()) {
        for node in limits {
            let Some(kind) = node.get("kind").and_then(|value| value.as_str()) else {
                continue;
            };
            // Sem data de reset a janela nao diz nada util.
            let Some(resets) = node
                .get("resets_at")
                .and_then(|value| value.as_str())
                .and_then(parse_iso)
            else {
                continue;
            };
            let Some(percent) = node.get("percent").and_then(|value| value.as_f64()) else {
                continue;
            };
            let id = normalize_id(kind);
            if windows.iter().any(|window| window.id == id) {
                continue;
            }
            // O nome do modelo e nome proprio: vai para a tela como esta.
            let label = node
                .pointer("/scope/model/display_name")
                .and_then(|value| value.as_str())
                .map(|value| value.to_string())
                .unwrap_or_else(|| label_for(&id));
            windows.push(LimitWindow {
                duration_ms: duration_for(&id),
                id,
                group: None,
                label,
                used_fraction: Some(percent / 100.0),
                resets_at_ms: Some(resets),
            });
        }
    }
    // A sessao some de `limits` no instante do reset, mas `five_hour`
    // continua: os dois blocos se completam.
    merge(&mut windows, &parsed, "five_hour", "session");
    merge(&mut windows, &parsed, "seven_day", "weekly_all");
    Some(sorted(windows))
}

fn merge(windows: &mut Vec<LimitWindow>, parsed: &serde_json::Value, key: &str, id: &str) {
    if windows.iter().any(|window| window.id == id) {
        return;
    }
    let Some(node) = parsed.get(key) else {
        return;
    };
    let Some(percent) = node.get("utilization").and_then(|value| value.as_f64()) else {
        return;
    };
    let resets = node
        .get("resets_at")
        .and_then(|value| value.as_str())
        .and_then(parse_iso);
    windows.push(LimitWindow {
        id: id.to_string(),
        group: None,
        label: label_for(id),
        used_fraction: Some(percent / 100.0),
        resets_at_ms: resets,
        duration_ms: duration_for(id),
    });
}

fn parse_iso(text: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|value| value.timestamp_millis().max(0) as u64)
}

/* ── vocabulario das janelas ───────────────────────────────────────── */

/// Ids diferentes das quatro fontes viram um so, para o anel nao trocar de
/// identidade conforme quem respondeu.
pub fn normalize_id(kind: &str) -> String {
    match kind {
        "five_hour" | "session" => "session".to_string(),
        "seven_day" | "weekly_all" => "weekly_all".to_string(),
        other => other.to_string(),
    }
}

fn weekly_id(scope: &str) -> String {
    let cleaned = scope.trim().to_ascii_lowercase();
    if cleaned == "all models" {
        return "weekly_all".to_string();
    }
    format!("weekly_{}", cleaned.replace(' ', "_"))
}

/// Codigo do rotulo: `session`, `weeklyAll` e `perModel` a interface traduz;
/// uma semana por modelo leva o nome do modelo, como `Opus`, que fica como
/// esta.
pub fn label_for(id: &str) -> String {
    match id {
        "session" => "session".to_string(),
        "weekly_all" => "weeklyAll".to_string(),
        "weekly_scoped" | "scoped" => "perModel".to_string(),
        other => {
            let cleaned = other.trim_start_matches("weekly_").replace('_', " ");
            let mut chars = cleaned.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => cleaned,
            }
        }
    }
}

fn duration_for(id: &str) -> Option<u64> {
    if id == "session" {
        return Some(5 * 3600 * 1000);
    }
    if id.starts_with("weekly_") {
        return Some(7 * 24 * 3600 * 1000);
    }
    None
}

/// Sessao primeiro, semana geral depois, o resto em ordem alfabetica.
fn sorted(mut windows: Vec<LimitWindow>) -> Vec<LimitWindow> {
    windows.sort_by_key(|window| match window.id.as_str() {
        "session" => (0u8, String::new()),
        "weekly_all" => (1, String::new()),
        other => (2, other.to_string()),
    });
    windows
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notch::profiles::Provider;

    /// Saida real do `/usage`, fixada pelos testes do Codenotch.
    const OUTPUT: &str = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 38% used · resets Sep 7 at 2:59pm (Asia/Jakarta)\nCurrent week (all models): 4% used · resets Sep 14 at 5:59am (Asia/Jakarta)\n\nWhat's contributing to your limits usage?\nApproximate, based on local sessions on this machine — does not include other devices.\n\nLast 24h · 268 requests · 3 sessions\n  37% of your usage was at >150k context\n  Top skills: /jira-tools 1%\n";

    #[test]
    fn reads_the_two_limit_lines() {
        let windows = parse_usage_output(OUTPUT);
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].id, "session");
        assert_eq!(windows[0].used_fraction, Some(0.38));
        assert_eq!(windows[1].id, "weekly_all");
        assert_eq!(windows[1].used_fraction, Some(0.04));
        assert!(windows[0].resets_at_ms.is_some());
    }

    #[test]
    fn the_prose_percentages_are_not_windows() {
        let windows = parse_usage_output(OUTPUT);
        assert!(
            windows
                .iter()
                .all(|window| window.used_fraction != Some(0.37))
        );
    }

    #[test]
    fn a_reading_without_the_session_line_is_worthless() {
        let text = "Current week (all models): 4% used · resets Sep 14 at 5:59am (Asia/Jakarta)\n";
        assert!(parse_usage_output(text).is_empty());
    }

    #[test]
    fn a_model_scoped_week_gets_its_own_id() {
        let text = "Current session: 10% used\nCurrent week (Opus): 61% used · resets Sep 14 at 5:59am (X/Y)\n";
        let windows = parse_usage_output(text);
        assert!(
            windows
                .iter()
                .any(|window| window.id == "weekly_opus" && window.label == "Opus")
        );
    }

    #[test]
    fn a_window_without_a_reset_still_counts() {
        let windows = parse_usage_output("Current session: 7% used\n");
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].resets_at_ms, None);
    }

    #[test]
    fn the_whole_hour_prints_without_minutes() {
        assert!(parse_reset("Sep 7 at 3pm (America/Sao_Paulo)").is_some());
        assert!(parse_reset("Sep 7 at 2:59pm (America/Sao_Paulo)").is_some());
    }

    #[test]
    fn the_reset_lands_near_today_not_years_away() {
        let parsed = parse_reset("Sep 7 at 2:59pm (America/Sao_Paulo)").unwrap() as i64;
        let now = Local::now().timestamp_millis();
        let year = 366i64 * 24 * 3600 * 1000;
        assert!(
            (parsed - now).abs() < year,
            "a data escolhida fica dentro de um ano"
        );
    }

    #[test]
    fn the_plan_reads_the_longest_phrase() {
        assert_eq!(
            plan_in("You are on the Max 20x plan\n").as_deref(),
            Some("Max 20x")
        );
        assert_eq!(plan_in("Max 5x subscription\n").as_deref(), Some("Max 5x"));
        assert_eq!(plan_in("You are on the Pro plan\n").as_deref(), Some("Pro"));
        assert_eq!(plan_in("nada aqui\n"), None);
    }

    #[test]
    fn the_endpoint_body_maps_to_windows() {
        let body = r#"{
          "five_hour": { "utilization": 52.0, "resets_at": "2026-08-28T09:50:00.316290+00:00" },
          "seven_day": { "utilization": 17.0, "resets_at": "2026-09-02T17:00:00.316321+00:00" },
          "limits": [
            { "kind": "session", "percent": 52, "resets_at": "2026-08-28T09:50:00.316290+00:00" },
            { "kind": "weekly_all", "percent": 17, "resets_at": "2026-09-02T17:00:00.316321+00:00" }
          ]
        }"#;
        let windows = windows_from_response(body).unwrap();
        assert_eq!(windows.len(), 2);
        assert_eq!(windows[0].id, "session");
        assert_eq!(windows[0].label, "session");
        assert_eq!(windows[0].used_fraction, Some(0.52));
        assert_eq!(windows[0].duration_ms, Some(5 * 3600 * 1000));
        assert_eq!(windows[1].id, "weekly_all");
        assert_eq!(windows[1].label, "weeklyAll");
        assert_eq!(windows[1].duration_ms, Some(7 * 24 * 3600 * 1000));
    }

    #[test]
    fn the_five_hour_block_fills_in_a_missing_session() {
        let body = r#"{
          "five_hour": { "utilization": 3.0, "resets_at": "2026-08-28T09:50:00Z" },
          "limits": []
        }"#;
        let windows = windows_from_response(body).unwrap();
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].id, "session");
        assert_eq!(windows[0].used_fraction, Some(0.03));
    }

    #[test]
    fn a_scoped_model_window_keeps_the_model_name() {
        let body = r#"{"limits":[
          {"kind":"session","percent":1,"resets_at":"2026-08-28T09:50:00Z"},
          {"kind":"weekly_scoped","percent":61,"resets_at":"2026-09-02T17:00:00Z","scope":{"model":{"display_name":"Fable","id":"claude-fable-5-1"}}}
        ]}"#;
        let windows = windows_from_response(body).unwrap();
        assert!(windows.iter().any(|window| window.label == "Fable"));
    }

    #[test]
    fn a_window_without_a_reset_is_dropped_from_the_endpoint() {
        let body = r#"{"limits":[{"kind":"session","percent":5}]}"#;
        assert!(windows_from_response(body).unwrap().is_empty());
    }

    #[test]
    fn the_hook_ids_become_the_shared_ids() {
        assert_eq!(normalize_id("five_hour"), "session");
        assert_eq!(normalize_id("seven_day"), "weekly_all");
        assert_eq!(normalize_id("weekly_opus"), "weekly_opus");
    }

    #[test]
    fn the_labels_are_codes_or_proper_names() {
        assert_eq!(label_for("session"), "session");
        assert_eq!(label_for("weekly_all"), "weeklyAll");
        assert_eq!(label_for("weekly_scoped"), "perModel");
        assert_eq!(label_for("weekly_opus"), "Opus");
        assert_eq!(label_for("weekly_cowork"), "Cowork");
    }

    #[test]
    fn the_hook_file_is_the_first_source_and_expires() {
        let dir = std::env::temp_dir().join(format!("cialai-notch-hook-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let folder = dir.join(crate::workspace::ai::CLAUDE_DIR);
        std::fs::create_dir_all(&folder).unwrap();
        let profile = Profile {
            id: "claude-work".to_string(),
            provider: Provider::Claude,
            slug: Some("work".to_string()),
            config_dir: dir.join(".claude-work").to_string_lossy().to_string(),
            account: None,
            account_key: None,
            plan: None,
            label: "work".to_string(),
            duplicate: false,
        };
        let now = now_ms();
        let write = |updated: u64| {
            std::fs::write(
                folder.join("claude-work.json"),
                format!(
                    r#"{{"plan":"max","updatedAtMs":{updated},"windows":[{{"id":"five_hour","label":"Sessão","usedPercent":12.5,"windowMinutes":300,"resetsAtMs":{}}},{{"id":"seven_day","label":"Semana","usedPercent":34.0}}]}}"#,
                    now + 3_600_000
                ),
            )
            .unwrap();
        };
        write(now);
        let reading = from_hook(&profile, &dir, now).unwrap();
        assert_eq!(reading.source, SOURCE_HOOK);
        assert_eq!(reading.plan.as_deref(), Some("max"));
        assert_eq!(reading.windows[0].id, "session");
        assert_eq!(reading.windows[0].label, "session");
        assert_eq!(reading.windows[0].used_fraction, Some(0.125));
        assert_eq!(reading.windows[0].duration_ms, Some(300 * 60_000));
        assert_eq!(reading.windows[1].id, "weekly_all");
        // Mais de trinta minutos: a fonte cala e a proxima entra.
        write(now - FRESH_MS - 1);
        assert!(from_hook(&profile, &dir, now).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn locating_the_cli_in_an_empty_home_is_quiet() {
        let dir = std::env::temp_dir().join(format!("cialai-notch-locate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Sem os lugares conhecidos, o resultado e o `PATH` deste processo,
        // que pode ou nao ter o `claude`; o que importa e nao entrar em panico.
        let _ = locate(&dir);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
