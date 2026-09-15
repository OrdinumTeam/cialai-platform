// SPDX-License-Identifier: Apache-2.0
//! Uso do plano dos agentes de IA que rodam nas sessoes do estudio.
//!
//! O card de uma sessao mostra CPU e memoria lidas do kernel. Quando o
//! processo em primeiro plano e um agente conhecido, ele mostra tambem o
//! quanto do plano ja foi usado. Esse numero nao vem do processo: vem de onde
//! cada agente o publica.
//!
//! - **Codex** grava o proprio limite no arquivo da sessao, em
//!   `<home do Codex>/sessions/AAAA/MM/DD/rollout-*.jsonl`. O evento
//!   `token_count` carrega `rate_limits` com `primary` e `secondary`, cada um
//!   com `used_percent`, `window_minutes` e `resets_at`. Nada precisa ser
//!   configurado: basta ler a cauda do arquivo mais recente de cada home.
//!   Alem de `~/.codex*`, valem os homes que as sessoes abertas apontam por
//!   `CODEX_HOME`, como o de um lancador que guarda cada conta em
//!   `$XDG_DATA_HOME/<lancador>/codex/<conta>`.
//! - **Claude Code** nao guarda isso em lugar nenhum do disco. O unico lugar
//!   onde o numero aparece e a entrada do hook de linha de estado, que recebe
//!   `rate_limits` a cada redesenho. O script `scripts/claude-statusline.py`
//!   publica o que recebe em `ai-usage/claude/<perfil>.json`, dentro da pasta
//!   de dados do app, e aqui so lemos esses arquivos.
//!
//! O uso vale para a conta, nao para a pasta. Como o usuario tem varios
//! perfis do mesmo agente, cada um com a propria conta, o numero e publicado
//! e lido **por perfil**: o slug da pasta de configuracao, `claude` para
//! `~/.claude`, `claude-work` para `~/.claude-work`, `codex-work`
//! para `~/.codex-work`. O card casa o perfil do processo, lido do
//! ambiente dele, com o perfil do arquivo.

use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::procs::profile_slug;

/// Pasta com um arquivo por perfil do Claude Code, relativa ao Application
/// Support do app.
pub const CLAUDE_DIR: &str = "ai-usage/claude";
/// Arquivo unico do formato anterior, ainda lido quando a pasta nova esta
/// vazia.
pub const CLAUDE_FILE: &str = "ai-usage/claude.json";
/// Cauda lida do arquivo de sessao do Codex. O `token_count` mais recente
/// esta sempre perto do fim.
const TAIL_BYTES: u64 = 256 * 1024;
/// Acima disso o dado e velho demais para valer um numero na tela.
const STALE_MS: u64 = 6 * 60 * 60 * 1000;
/// Pastas de dia visitadas na busca pelo arquivo de sessao mais recente.
const RECENT_DAYS: usize = 3;
/// O numero e lido de novo quase sempre: quem chama pergunta a cada poucos
/// segundos e o card acompanha a sessao enquanto ela anda.
const CACHE_TTL: Duration = Duration::from_secs(2);
/// A varredura das pastas de sessao do Codex e a parte cara, e o arquivo em
/// uso nao muda a toda hora: o caminho fica guardado por mais tempo, e so a
/// cauda dele e relida.
const SCAN_TTL: Duration = Duration::from_secs(15);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    /// Chave de origem, como `five_hour` ou `primary`.
    pub id: String,
    /// Rotulo curto para a interface: `Sessão`, `Semana`, `5 h`.
    pub label: String,
    pub used_percent: f64,
    pub window_minutes: Option<u64>,
    pub resets_at_ms: Option<u64>,
}

/// Uma sessao do agente vista pelo hook: serve para o card mostrar o modelo
/// da sessao que roda naquela pasta.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSession {
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Esforco de raciocinio da sessao: `low`, `medium`, `high`, `xhigh` ou
    /// `max`, como a linha de estado o recebe.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Quanto da janela de contexto ja foi usada, em porcento.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used_percent: Option<f64>,
    /// Tamanho da janela de contexto em tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_size: Option<u64>,
    /// Custo estimado da sessao em dolares.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default)]
    pub updated_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentUsage {
    /// Nome do agente como `procs::agent_of` o reconhece.
    pub agent: String,
    /// Slug do perfil: `claude`, `claude-work`, `codex`, `codex-work`.
    pub profile: String,
    /// Pasta de configuracao ou home do Codex de onde o numero veio.
    pub config_dir: Option<String>,
    /// Nome dado pelo usuario ao perfil, quando o hook o recebeu.
    pub profile_name: Option<String>,
    /// Modelo da sessao mais recente do perfil.
    pub model: Option<String>,
    /// Sessoes recentes do perfil, com pasta e modelo. Vazio para o Codex.
    pub sessions: Vec<UsageSession>,
    pub plan: Option<String>,
    pub windows: Vec<UsageWindow>,
    pub updated_at_ms: u64,
    /// Dado velho demais: a interface mostra o numero apagado ou omite.
    pub stale: bool,
    /// De onde o numero veio, para a dica da interface.
    pub source: String,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/* ── Claude Code, pelo hook de linha de estado ─────────────────────── */

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeFile {
    #[serde(default)]
    profile: Option<String>,
    #[serde(default)]
    profile_name: Option<String>,
    #[serde(default)]
    config_dir: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    sessions: Vec<UsageSession>,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    windows: Vec<ClaudeWindow>,
    #[serde(default)]
    updated_at_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeWindow {
    id: String,
    label: String,
    used_percent: f64,
    #[serde(default)]
    window_minutes: Option<u64>,
    #[serde(default)]
    resets_at_ms: Option<u64>,
}

fn claude_from_file(
    path: &Path,
    fallback_profile: &str,
    fallback_dir: Option<&Path>,
    source: &str,
) -> Option<AgentUsage> {
    let raw = fs::read_to_string(path).ok()?;
    let parsed: ClaudeFile = serde_json::from_str(&raw).ok()?;
    if parsed.windows.is_empty() {
        return None;
    }
    let now = now_ms();
    let profile = parsed
        .profile
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback_profile.to_string());
    let config_dir = parsed
        .config_dir
        .filter(|value| !value.trim().is_empty())
        .or_else(|| fallback_dir.map(crate::platform::to_portable));
    let mut sessions = parsed.sessions;
    sessions.sort_by_key(|session| std::cmp::Reverse(session.updated_at_ms));
    let model = parsed
        .model
        .filter(|value| !value.trim().is_empty())
        .or_else(|| sessions.first().and_then(|session| session.model.clone()));
    Some(AgentUsage {
        agent: "Claude Code".to_string(),
        profile,
        config_dir,
        profile_name: parsed.profile_name.filter(|value| !value.trim().is_empty()),
        model,
        sessions,
        plan: parsed.plan,
        windows: parsed
            .windows
            .into_iter()
            .map(|window| UsageWindow {
                id: window.id,
                label: window.label,
                used_percent: window.used_percent,
                window_minutes: window.window_minutes,
                resets_at_ms: window.resets_at_ms,
            })
            .collect(),
        stale: parsed.updated_at_ms == 0 || now.saturating_sub(parsed.updated_at_ms) > STALE_MS,
        updated_at_ms: parsed.updated_at_ms,
        source: source.to_string(),
    })
}

/// Um item por perfil, lendo a pasta `ai-usage/claude`. Sem a pasta, ou com
/// ela vazia, cai no arquivo unico do formato anterior, que vale como o
/// perfil padrao `claude`.
pub fn claude(home: &Path, app_support: &Path) -> Vec<AgentUsage> {
    let mut found: BTreeMap<String, AgentUsage> = BTreeMap::new();
    if let Ok(read) = fs::read_dir(app_support.join(CLAUDE_DIR)) {
        for item in read.flatten() {
            let path = item.path();
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if !name.ends_with(".json") || name.ends_with(".tmp") {
                continue;
            }
            let stem = name.trim_end_matches(".json");
            if let Some(usage) = claude_from_file(&path, stem, None, "statusline") {
                found.insert(usage.profile.clone(), usage);
            }
        }
    }
    if found.is_empty() {
        let legacy = app_support.join(CLAUDE_FILE);
        let default_dir = home.join(".claude");
        if let Some(usage) =
            claude_from_file(&legacy, "claude", Some(&default_dir), "statusline legado")
        {
            found.insert(usage.profile.clone(), usage);
        }
    }
    found.into_values().collect()
}

/* ── Codex, pelo arquivo da propria sessao ─────────────────────────── */

/// Pastas de dia mais recentes, por nome: `sessions/AAAA/MM/DD`. Uma sessao
/// aberta ontem continua recebendo linhas hoje, entao mais de um dia entra.
fn recent_day_dirs(sessions: &Path) -> Vec<PathBuf> {
    fn children(dir: &Path) -> Vec<PathBuf> {
        let Ok(read) = fs::read_dir(dir) else {
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

/// Homes do Codex na pasta do usuario. Alem de `.codex`, cada perfil vira um
/// `.codex-alguma-coisa`, e cada um e uma conta: o numero vale por home.
/// `extra` traz os homes das sessoes abertas, que podem morar fora dela.
/// Devolve pares de home e pasta de sessoes.
fn codex_homes(home: &Path, extra: &[PathBuf]) -> Vec<(PathBuf, PathBuf)> {
    let mut homes: Vec<(PathBuf, PathBuf)> = fs::read_dir(home)
        .map(|read| {
            read.flatten()
                .filter(|item| {
                    let name = item.file_name();
                    let name = name.to_string_lossy();
                    name == ".codex" || name.starts_with(".codex-")
                })
                .map(|item| (item.path(), item.path().join("sessions")))
                .collect()
        })
        .unwrap_or_default();
    let mut seen: Vec<PathBuf> = homes
        .iter()
        .map(|(dir, _)| dir.canonicalize().unwrap_or_else(|_| dir.clone()))
        .collect();
    for dir in extra {
        let resolved = dir.canonicalize().unwrap_or_else(|_| dir.clone());
        if !seen.contains(&resolved) {
            seen.push(resolved);
            homes.push((dir.clone(), dir.join("sessions")));
        }
    }
    homes.retain(|(_, sessions)| sessions.is_dir());
    homes.sort();
    homes
}

/// O rollout mais recente de cada home do Codex.
fn newest_rollouts(home: &Path, extra: &[PathBuf]) -> Vec<(PathBuf, PathBuf)> {
    codex_homes(home, extra)
        .into_iter()
        .filter_map(|(home_dir, sessions)| newest_in(&sessions).map(|(_, path)| (home_dir, path)))
        .collect()
}

fn newest_in(sessions: &Path) -> Option<(SystemTime, PathBuf)> {
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for day in recent_day_dirs(sessions) {
        let Ok(read) = fs::read_dir(&day) else {
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
            if newest
                .as_ref()
                .map(|(time, _)| modified > *time)
                .unwrap_or(true)
            {
                newest = Some((modified, path));
            }
        }
    }
    newest
}

/// Ultima linha do arquivo que carrega `rate_limits`. So a cauda e lida.
fn last_rate_limits_line(path: &Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let start = size.saturating_sub(TAIL_BYTES);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer);
    text.lines()
        .rfind(|line| line.contains("\"rate_limits\""))
        .map(|line| line.to_string())
}

fn window_from(node: &serde_json::Value, id: &str) -> Option<UsageWindow> {
    let used = node.get("used_percent").and_then(|value| value.as_f64())?;
    let minutes = node.get("window_minutes").and_then(|value| value.as_u64());
    let resets = node
        .get("resets_at")
        .and_then(|value| value.as_u64())
        .map(|seconds| seconds.saturating_mul(1000));
    Some(UsageWindow {
        id: id.to_string(),
        label: label_for(minutes),
        used_percent: used,
        window_minutes: minutes,
        resets_at_ms: resets,
    })
}

/// Rotulo curto pela duracao da janela. 300 min e a sessao de 5 h; 10.080 min
/// e a semana.
fn label_for(minutes: Option<u64>) -> String {
    match minutes {
        Some(value) if value <= 60 => format!("{value} min"),
        Some(value) if value < 1440 => format!("{} h", (value as f64 / 60.0).round() as u64),
        Some(value) if value >= 10_000 => "Semana".to_string(),
        Some(value) => format!("{} d", (value as f64 / 1440.0).round() as u64),
        None => "Plano".to_string(),
    }
}

/// Um item por home do Codex, cada um com o rollout mais recente daquele
/// home.
pub fn codex(home: &Path, extra: &[PathBuf]) -> Vec<AgentUsage> {
    newest_rollouts(home, extra)
        .into_iter()
        .filter_map(|(home_dir, path)| codex_at(&path, &home_dir))
        .collect()
}

fn codex_at(path: &Path, home_dir: &Path) -> Option<AgentUsage> {
    let path = path.to_path_buf();
    let modified = fs::metadata(&path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0);
    let line = last_rate_limits_line(&path)?;
    let parsed: serde_json::Value = serde_json::from_str(&line).ok()?;
    let limits = parsed
        .pointer("/payload/rate_limits")
        .or_else(|| parsed.get("rate_limits"))?;
    let mut windows = Vec::new();
    if let Some(window) = limits
        .get("primary")
        .and_then(|node| window_from(node, "primary"))
    {
        windows.push(window);
    }
    if let Some(window) = limits
        .get("secondary")
        .and_then(|node| window_from(node, "secondary"))
    {
        windows.push(window);
    }
    if windows.is_empty() {
        return None;
    }
    windows.sort_by_key(|window| window.window_minutes.unwrap_or(u64::MAX));
    Some(AgentUsage {
        agent: "Codex".to_string(),
        profile: profile_slug(home_dir),
        config_dir: Some(crate::platform::to_portable(home_dir)),
        profile_name: None,
        model: None,
        sessions: Vec::new(),
        plan: limits
            .get("plan_type")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        windows,
        stale: now_ms().saturating_sub(modified) > STALE_MS,
        updated_at_ms: modified,
        source: "sessão do Codex".to_string(),
    })
}

/* ── instalacao da linha de estado do Claude Code ──────────────────── */

/// O hook, embutido no binario: e o mesmo `scripts/claude-statusline.py` do
/// repositorio que o instalador em Python copia.
pub const CLAUDE_HOOK_SOURCE: &str = include_str!("../../../../../scripts/claude-statusline.py");
/// Pasta e nome do hook na pasta pessoal.
pub const CLAUDE_HOOK_DIR: &str = ".cialai";
pub const CLAUDE_HOOK_FILE: &str = "claude-statusline.py";

/// Resultado da instalacao: quantos perfis apontam para o hook e quais
/// guardaram uma linha de estado propria.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookInstall {
    pub hook_path: String,
    /// Perfis que passaram a usar o hook nesta chamada ou ja usavam.
    pub installed: usize,
    /// Perfis com um `statusLine` proprio, deixados como estavam.
    pub kept: Vec<String>,
    /// Perfis do Claude Code encontrados na pasta pessoal.
    pub profiles: Vec<String>,
}

/// Perfis do Claude Code: `~/.claude` e cada `~/.claude-*`, em ordem.
fn claude_profiles(home: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let default = home.join(".claude");
    if default.is_dir() {
        found.push(default);
    }
    if let Ok(read) = fs::read_dir(home) {
        let mut extra: Vec<PathBuf> = read
            .flatten()
            .filter(|item| item.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|item| item.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(".claude-"))
            })
            .collect();
        extra.sort();
        found.extend(extra);
    }
    found
}

/// Comando que o Claude Code roda: o caminho do hook no POSIX, onde o
/// shebang resolve o Python, e `python "caminho"` no Windows.
fn hook_command(target: &Path) -> String {
    if cfg!(windows) {
        format!("python \"{}\"", target.display())
    } else {
        target.to_string_lossy().into_owned()
    }
}

fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let temporary = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

/// Copia o hook para `~/.cialai` e aponta o `statusLine` de cada perfil do
/// Claude Code para ele. Um perfil com linha de estado propria fica como
/// esta; um perfil sem `settings.json` ganha um so com o `statusLine`. Cada
/// `settings.json` alterado deixa uma copia `.bak-<segundos>` ao lado.
pub fn install_claude_hook(home: &Path) -> Result<HookInstall, String> {
    let target = home.join(CLAUDE_HOOK_DIR).join(CLAUDE_HOOK_FILE);
    let parent = target
        .parent()
        .ok_or_else(|| "hook sem pasta".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    if fs::read_to_string(&target).ok().as_deref() != Some(CLAUDE_HOOK_SOURCE) {
        fs::write(&target, CLAUDE_HOOK_SOURCE).map_err(|error| error.to_string())?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }
    let wanted = serde_json::json!({
        "type": "command",
        "command": hook_command(&target),
        "padding": 0,
    });
    let mut result = HookInstall {
        hook_path: crate::platform::to_portable(&target),
        ..HookInstall::default()
    };
    for profile in claude_profiles(home) {
        let name = profile
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        result.profiles.push(name.clone());
        let settings = profile.join("settings.json");
        let mut data = match fs::read_to_string(&settings) {
            Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(serde_json::Value::Object(map)) => serde_json::Value::Object(map),
                // JSON invalido ou de outra forma: nao mexe.
                _ => {
                    result.kept.push(name);
                    continue;
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                serde_json::Value::Object(serde_json::Map::new())
            }
            Err(error) => return Err(error.to_string()),
        };
        let current = data.get("statusLine");
        if current == Some(&wanted) {
            result.installed += 1;
            continue;
        }
        if current.is_some_and(|value| !value.is_null()) {
            result.kept.push(name);
            continue;
        }
        if settings.is_file() {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_secs())
                .unwrap_or(0);
            let backup = profile.join(format!("settings.json.bak-{stamp}"));
            fs::copy(&settings, &backup).map_err(|error| error.to_string())?;
        }
        data["statusLine"] = wanted.clone();
        let pretty = serde_json::to_string_pretty(&data).map_err(|error| error.to_string())?;
        write_atomic(&settings, &format!("{pretty}\n"))?;
        result.installed += 1;
    }
    Ok(result)
}

/* ── leitura com cache ─────────────────────────────────────────────── */

/// Estado do Tauri: o uso muda devagar, entao alguns segundos de cache
/// evitam varrer as pastas a cada amostra de metricas.
/// Pares de home do Codex e rollout mais recente daquele home.
type RolloutList = Vec<(PathBuf, PathBuf)>;

#[derive(Default)]
pub struct UsageCache {
    inner: Mutex<Option<(Instant, Vec<AgentUsage>)>>,
    /// Varredura guardada junto dos homes extras que ela considerou.
    rollouts: Mutex<Option<(Instant, Vec<PathBuf>, RolloutList)>>,
}

pub fn read_all(home: &Path, app_support: &Path, codex_extra: &[PathBuf]) -> Vec<AgentUsage> {
    let mut found = claude(home, app_support);
    found.extend(codex(home, codex_extra));
    found
}

/// Rollout mais recente de cada home do Codex, revarrendo as pastas de
/// tempos em tempos ou quando uma sessao passa a usar outro home.
fn rollout_paths(cache: &UsageCache, home: &Path, extra: &[PathBuf]) -> RolloutList {
    let mut guard = cache
        .rollouts
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, known, paths)) = guard.as_ref() {
        if at.elapsed() < SCAN_TTL && known.as_slice() == extra {
            return paths.clone();
        }
    }
    let found = newest_rollouts(home, extra);
    *guard = Some((Instant::now(), extra.to_vec(), found.clone()));
    found
}

pub fn cached(
    cache: &UsageCache,
    home: &Path,
    app_support: &Path,
    codex_extra: &[PathBuf],
) -> Vec<AgentUsage> {
    let guard = cache
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, value)) = guard.as_ref() {
        if at.elapsed() < CACHE_TTL {
            return value.clone();
        }
    }
    drop(guard);
    let mut fresh = claude(home, app_support);
    for (home_dir, path) in rollout_paths(cache, home, codex_extra) {
        if let Some(usage) = codex_at(&path, &home_dir) {
            fresh.push(usage);
        }
    }
    let mut guard = cache
        .inner
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard = Some((Instant::now(), fresh.clone()));
    fresh
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oc-ai-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn reads_claude_statusline_file_per_profile() {
        let dir = sandbox("claude");
        fs::create_dir_all(dir.join(CLAUDE_DIR)).unwrap();
        let now = now_ms();
        fs::write(
            dir.join(CLAUDE_DIR).join("claude-work.json"),
            format!(
                r#"{{"agent":"Claude Code","format":2,"profile":"claude-work","profileName":"Work","configDir":"/Users/x/.claude-work","plan":"max","model":"Fable 5.1","updatedAtMs":{now},
                   "sessions":[{{"sessionId":"s1","cwd":"/Users/x/projeto","model":"Fable 5.1","effort":"max","contextUsedPercent":42.5,"contextWindowSize":200000,"costUsd":1.83,"updatedAtMs":{now}}},{{"sessionId":"s0","cwd":"/Users/x/outro","model":"Opus 5","updatedAtMs":{}}}],
                   "windows":[{{"id":"five_hour","label":"Sessão","usedPercent":12.5,"resetsAtMs":1789000000000}},{{"id":"seven_day","label":"Semana","usedPercent":34.0}}]}}"#,
                now - 1000
            ),
        )
        .unwrap();
        let list = claude(&dir, &dir);
        assert_eq!(list.len(), 1);
        let usage = &list[0];
        assert_eq!(usage.agent, "Claude Code");
        assert_eq!(usage.profile, "claude-work");
        assert_eq!(usage.profile_name.as_deref(), Some("Work"));
        assert_eq!(usage.config_dir.as_deref(), Some("/Users/x/.claude-work"));
        assert_eq!(usage.model.as_deref(), Some("Fable 5.1"));
        assert_eq!(usage.plan.as_deref(), Some("max"));
        assert_eq!(usage.windows.len(), 2);
        assert_eq!(usage.windows[0].used_percent, 12.5);
        assert_eq!(usage.sessions.len(), 2);
        assert_eq!(usage.sessions[0].cwd.as_deref(), Some("/Users/x/projeto"));
        assert_eq!(usage.sessions[0].effort.as_deref(), Some("max"));
        assert_eq!(usage.sessions[0].context_used_percent, Some(42.5));
        assert_eq!(usage.sessions[0].context_window_size, Some(200_000));
        assert_eq!(usage.sessions[0].cost_usd, Some(1.83));
        // Sessao publicada por um hook anterior, sem os campos novos.
        assert_eq!(usage.sessions[1].effort, None);
        assert_eq!(usage.sessions[1].context_used_percent, None);
        assert!(!usage.stale);
        // Arquivo antigo continua sendo lido, mas marcado.
        fs::write(
            dir.join(CLAUDE_DIR).join("claude-work.json"),
            r#"{"profile":"claude-work","windows":[{"id":"a","label":"Sessão","usedPercent":1.0}],"updatedAtMs":1}"#,
        )
        .unwrap();
        assert!(claude(&dir, &dir)[0].stale);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn lists_one_usage_per_claude_profile() {
        let dir = sandbox("perfis-claude");
        fs::create_dir_all(dir.join(CLAUDE_DIR)).unwrap();
        let now = now_ms();
        let file = |percent: f64| {
            format!(
                r#"{{"updatedAtMs":{now},"windows":[{{"id":"five_hour","label":"Sessão","usedPercent":{percent}}}]}}"#
            )
        };
        fs::write(dir.join(CLAUDE_DIR).join("claude.json"), file(7.0)).unwrap();
        fs::write(dir.join(CLAUDE_DIR).join("claude-cialai.json"), file(63.0)).unwrap();
        // Temporario de uma escrita atomica em andamento nao entra.
        fs::write(
            dir.join(CLAUDE_DIR).join("claude-x.json.123.tmp"),
            file(99.0),
        )
        .unwrap();
        let list = claude(&dir, &dir);
        assert_eq!(list.len(), 2, "{list:?}");
        assert_eq!(list[0].profile, "claude");
        assert_eq!(list[0].windows[0].used_percent, 7.0);
        assert_eq!(list[1].profile, "claude-cialai");
        assert_eq!(list[1].windows[0].used_percent, 63.0);
        // Sem `configDir` no arquivo o campo fica vazio: o perfil e o slug.
        assert_eq!(list[1].config_dir, None);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn installs_the_hook_in_every_profile_and_keeps_custom_status_lines() {
        let home = sandbox("hook");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(home.join(".claude/settings.json"), "{\"theme\":\"dark\"}\n").unwrap();
        // Perfil sem settings.json ganha um so com a linha de estado.
        fs::create_dir_all(home.join(".claude-work")).unwrap();
        // Linha de estado propria fica como esta.
        fs::create_dir_all(home.join(".claude-custom")).unwrap();
        fs::write(
            home.join(".claude-custom/settings.json"),
            "{\"statusLine\":{\"type\":\"command\",\"command\":\"meu-hook\"}}",
        )
        .unwrap();
        // Pasta que nao e perfil e arquivo solto sao ignorados.
        fs::create_dir_all(home.join(".claudette")).unwrap();
        fs::write(home.join(".claude-notes"), "x").unwrap();

        let first = install_claude_hook(&home).unwrap();
        // `~/.claude` primeiro; os demais perfis em ordem alfabetica.
        assert_eq!(
            first.profiles,
            [".claude", ".claude-custom", ".claude-work"]
        );
        assert_eq!(first.installed, 2, "{first:?}");
        assert_eq!(first.kept, [".claude-custom"]);
        let hook = home.join(CLAUDE_HOOK_DIR).join(CLAUDE_HOOK_FILE);
        assert_eq!(fs::read_to_string(&hook).unwrap(), CLAUDE_HOOK_SOURCE);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(fs::metadata(&hook).unwrap().permissions().mode() & 0o111, 0);
        }
        let settings: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(home.join(".claude/settings.json")).unwrap())
                .unwrap();
        assert_eq!(settings["theme"], "dark");
        assert_eq!(settings["statusLine"]["type"], "command");
        assert_eq!(settings["statusLine"]["padding"], 0);
        assert!(
            settings["statusLine"]["command"]
                .as_str()
                .unwrap()
                .contains(CLAUDE_HOOK_FILE)
        );
        let work: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(home.join(".claude-work/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(work["statusLine"], settings["statusLine"]);
        let custom: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(home.join(".claude-custom/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(custom["statusLine"]["command"], "meu-hook");
        let backups = |profile: &str| {
            fs::read_dir(home.join(profile))
                .unwrap()
                .flatten()
                .filter(|item| {
                    item.file_name()
                        .to_string_lossy()
                        .starts_with("settings.json.bak-")
                })
                .count()
        };
        assert_eq!(backups(".claude"), 1);
        assert_eq!(backups(".claude-work"), 0);
        assert_eq!(backups(".claude-custom"), 0);

        // Segunda chamada: nada muda e nenhuma copia nova.
        let second = install_claude_hook(&home).unwrap();
        assert_eq!(second.installed, 2);
        assert_eq!(second.kept, [".claude-custom"]);
        assert_eq!(backups(".claude"), 1);
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn legacy_claude_file_is_converted() {
        let dir = sandbox("legado");
        fs::create_dir_all(dir.join("ai-usage")).unwrap();
        let now = now_ms();
        fs::write(
            dir.join(CLAUDE_FILE),
            format!(r#"{{"agent":"Claude Code","plan":"max","updatedAtMs":{now},"windows":[{{"id":"five_hour","label":"Sessão","usedPercent":5.0}}]}}"#),
        )
        .unwrap();
        let home = dir.join("home");
        let list = claude(&home, &dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].profile, "claude");
        assert!(
            list[0]
                .config_dir
                .as_deref()
                .unwrap()
                .ends_with("/home/.claude")
        );
        assert_eq!(list[0].source, "statusline legado");
        // Com a pasta nova povoada, o legado deixa de contar.
        fs::create_dir_all(dir.join(CLAUDE_DIR)).unwrap();
        fs::write(dir.join(CLAUDE_DIR).join("claude-work.json"), format!(r#"{{"updatedAtMs":{now},"windows":[{{"id":"a","label":"Sessão","usedPercent":1.0}}]}}"#)).unwrap();
        let list = claude(&home, &dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].profile, "claude-work");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_codex_rollout_tail() {
        let dir = sandbox("codex");
        let day = dir.join(".codex/sessions/2026/09/07");
        fs::create_dir_all(&day).unwrap();
        // Um dia mais velho com outro valor: o mais recente e que vale.
        let older = dir.join(".codex/sessions/2026/09/06");
        fs::create_dir_all(&older).unwrap();
        fs::write(older.join("rollout-velho.jsonl"), "{\"payload\":{\"rate_limits\":{\"primary\":{\"used_percent\":99.0,\"window_minutes\":300,\"resets_at\":1}}}}\n").unwrap();
        let lines = [
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"rate_limits\":{\"primary\":{\"used_percent\":1.0,\"window_minutes\":300,\"resets_at\":1779416259},\"secondary\":{\"used_percent\":5.0,\"window_minutes\":10080,\"resets_at\":1779835606},\"plan_type\":\"plus\"}}}",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"rate_limits\":{\"primary\":{\"used_percent\":7.5,\"window_minutes\":300,\"resets_at\":1779416259},\"secondary\":{\"used_percent\":9.0,\"window_minutes\":10080,\"resets_at\":1779835606},\"plan_type\":\"plus\"}}}",
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"agent_message\"}}",
        ];
        fs::write(
            day.join("rollout-novo.jsonl"),
            format!("{}\n", lines.join("\n")),
        )
        .unwrap();
        let list = codex(&dir, &[]);
        assert_eq!(list.len(), 1);
        let usage = &list[0];
        assert_eq!(usage.agent, "Codex");
        assert_eq!(usage.profile, "codex");
        assert!(usage.config_dir.as_deref().unwrap().ends_with("/.codex"));
        assert_eq!(usage.plan.as_deref(), Some("plus"));
        // A ultima linha com rate_limits vence, e a janela curta vem antes.
        assert_eq!(usage.windows[0].used_percent, 7.5);
        assert_eq!(usage.windows[0].label, "5 h");
        assert_eq!(usage.windows[1].label, "Semana");
        assert_eq!(usage.windows[1].used_percent, 9.0);
        assert_eq!(usage.windows[0].resets_at_ms, Some(1779416259000));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_one_usage_per_codex_home() {
        let dir = sandbox("perfis");
        let linha = |percent: f64| {
            format!(
                "{{\"payload\":{{\"type\":\"token_count\",\"rate_limits\":{{\"primary\":{{\"used_percent\":{percent},\"window_minutes\":300,\"resets_at\":1}}}}}}}}\n"
            )
        };
        let velho = dir.join(".codex/sessions/2026/09/07");
        fs::create_dir_all(&velho).unwrap();
        fs::write(velho.join("rollout-a.jsonl"), linha(90.0)).unwrap();
        // Perfil separado e outra conta: os dois numeros valem, cada um no
        // seu home.
        let novo = dir.join(".codex-work/sessions/2026/09/08");
        fs::create_dir_all(&novo).unwrap();
        std::thread::sleep(Duration::from_millis(20));
        fs::write(novo.join("rollout-b.jsonl"), linha(4.0)).unwrap();
        let list = codex(&dir, &[]);
        assert_eq!(list.len(), 2, "{list:?}");
        let padrao = list
            .iter()
            .find(|usage| usage.profile == "codex")
            .expect("home padrao");
        let perfil = list
            .iter()
            .find(|usage| usage.profile == "codex-work")
            .expect("home do perfil");
        assert_eq!(padrao.windows[0].used_percent, 90.0);
        assert_eq!(perfil.windows[0].used_percent, 4.0);
        assert!(
            perfil
                .config_dir
                .as_deref()
                .unwrap()
                .ends_with("/.codex-work")
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reads_codex_homes_of_open_sessions_outside_the_user_folder() {
        let dir = sandbox("xdg");
        let linha = |percent: f64| {
            format!(
                "{{\"payload\":{{\"type\":\"token_count\",\"rate_limits\":{{\"primary\":{{\"used_percent\":{percent},\"window_minutes\":300,\"resets_at\":1}}}}}}}}\n"
            )
        };
        let home = dir.join("home");
        let padrao = home.join(".codex/sessions/2026/09/14");
        fs::create_dir_all(&padrao).unwrap();
        fs::write(padrao.join("rollout-a.jsonl"), linha(11.0)).unwrap();
        // Conta de um lancador em $XDG_DATA_HOME, fora de ~/.codex*.
        let conta = home.join(".local/share/webrota-ai/codex/7");
        let dia = conta.join("sessions/2026/09/15");
        fs::create_dir_all(&dia).unwrap();
        fs::write(dia.join("rollout-b.jsonl"), linha(42.0)).unwrap();
        assert_eq!(
            codex(&home, &[]).len(),
            1,
            "sem a sessao aberta so o padrao"
        );
        // O home padrao repetido pela sessao nao duplica o item.
        let extra = vec![conta.clone(), home.join(".codex")];
        let list = codex(&home, &extra);
        assert_eq!(list.len(), 2, "{list:?}");
        let perfil = list
            .iter()
            .find(|usage| usage.profile == "7")
            .expect("conta 7");
        assert_eq!(perfil.windows[0].used_percent, 42.0);
        assert!(
            perfil
                .config_dir
                .as_deref()
                .unwrap()
                .ends_with("/webrota-ai/codex/7")
        );
        // O cache revarre quando os homes das sessoes mudam.
        let cache = UsageCache::default();
        assert_eq!(rollout_paths(&cache, &home, &[]).len(), 1);
        assert_eq!(rollout_paths(&cache, &home, &extra[..1]).len(), 2);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn missing_sources_are_silent() {
        let dir = sandbox("vazio");
        assert!(claude(&dir, &dir).is_empty());
        assert!(codex(&dir, &[]).is_empty());
        assert!(read_all(&dir, &dir, &[dir.join("inexistente")]).is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }
}
