// SPDX-License-Identifier: Apache-2.0
//! Quanto de cada plano ja foi gasto, por perfil.
//!
//! O modelo e o do Codenotch: um provedor devolve **janelas de limite**, e uma
//! delas, declarada por ele, e a que vai no anel. Nunca se promove outra
//! janela ao lugar da declarada: se ela nao veio, o anel mostra um traco, que
//! e diferente de zero por cento.
//!
//! Uma falha nunca inventa numero. Ela vira estado visivel, e a ultima
//! leitura boa envelhece na tela ate voltar a valer, menos quando o perfil
//! perdeu a credencial: ai o historico sai junto, porque um numero de uma
//! conta deslogada nao diz nada.
//!
//! Rotulos, fontes e mensagens de estado saem como **codigos**, que a
//! interface traduz. Os codigos estao nos comentarios de cada campo.

pub mod claude;
pub mod codex;
pub mod credentials;
pub mod desktop_cache;
pub mod http;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::profiles::{Profile, Provider};

/// Com sessao trabalhando, uma leitura por minuto basta.
pub const BUSY_INTERVAL: Duration = Duration::from_secs(60);
/// Sem sessao de agente rodando, uma leitura a cada cinco minutos basta.
pub const IDLE_INTERVAL: Duration = Duration::from_secs(300);
/// Acima disto a leitura aparece apagada.
pub const STALE_AFTER_MS: u64 = 15 * 60 * 1000;
/// Uma rodada inteira nao passa disto.
pub const ROUND_DEADLINE: Duration = Duration::from_secs(60);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

/* ── modelo ────────────────────────────────────────────────────────── */

/// De onde o numero veio, para a interface nunca mostrar um palpite como se
/// fosse dado publicado pelo fornecedor.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fidelity {
    #[default]
    Official,
    /// Derivado de resposta oficial, mas nao publicado assim. Leva `~`.
    Derived,
    Manual,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProviderStatus {
    Ok,
    /// Leitura antiga, mostrada apagada.
    Stale {
        since_ms: u64,
    },
    /// Nunca logou, ou a credencial sumiu.
    NeedsAuth,
    /// O item existe, mas o dono esvaziou o token.
    SignedOutByOwner,
    /// O chaveiro ou o arquivo recusou a leitura.
    AccessDenied,
    /// A conta nao tem limite medido. `message` e o codigo `nothingMetered`.
    Unsupported {
        message: String,
    },
    /// `message` e um codigo: `timeout`, `http`, `network` ou `curlMissing`.
    /// `detail` traz o status HTTP ou a mensagem do `curl`, quando existe.
    Error {
        message: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
    },
}

impl ProviderStatus {
    pub fn is_stale(&self) -> bool {
        matches!(self, ProviderStatus::Stale { .. })
    }

    /// Estados que apagam o historico: um numero antigo de uma conta sem
    /// credencial so confunde.
    pub fn supersedes_history(&self) -> bool {
        matches!(
            self,
            ProviderStatus::NeedsAuth | ProviderStatus::Unsupported { .. }
        )
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LimitWindow {
    /// `session`, `weekly_all`, `primary`, `secondary`, `spark`.
    pub id: String,
    /// Grupo no detalhe: `Spark` fica como esta, `codeReview` e traduzido.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    /// Codigo do rotulo: `session`, `weeklyAll`, `perModel`, `longWindow` ou
    /// `duration`, este formatado pela interface a partir de `durationMs`.
    /// Qualquer outro valor e um nome proprio, como o de um modelo, e vai
    /// para a tela como esta.
    pub label: String,
    /// 0 a 1, onde 1 e o limite gasto. `None` quando o provedor nao deu
    /// denominador.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub used_fraction: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    /// Id do perfil: `claude-webrota`, `codex-amorim`.
    pub id: String,
    /// `claude` ou `codex`, so para o glifo.
    pub provider: String,
    /// Rotulo do anel: o perfil, nunca o provedor sozinho.
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    pub config_dir: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    pub fidelity: Fidelity,
    pub status: ProviderStatus,
    pub windows: Vec<LimitWindow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headline_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weekly_id: Option<String>,
    pub fetched_at_ms: u64,
    /// Codigo da fonte: `statusline`, `desktopCache`, `cli`, `anthropicApi`,
    /// `chatgptApi` ou `rollout`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

impl ProviderSnapshot {
    pub fn placeholder(profile: &Profile, status: ProviderStatus) -> Self {
        Self {
            id: profile.id.clone(),
            provider: profile.provider.as_str().to_string(),
            label: profile.label.clone(),
            account: profile.account.clone(),
            config_dir: profile.config_dir.clone(),
            plan: profile.plan.clone(),
            fidelity: Fidelity::Official,
            status,
            windows: Vec::new(),
            headline_id: None,
            weekly_id: None,
            fetched_at_ms: 0,
            source: None,
        }
    }

    /// A janela do anel e a **declarada** pelo provedor. Sem ela, nada e
    /// promovido no lugar.
    pub fn headline(&self) -> Option<&LimitWindow> {
        let id = self.headline_id.as_deref()?;
        self.windows.iter().find(|window| window.id == id)
    }

    pub fn used_fraction(&self) -> Option<f64> {
        self.headline().and_then(|window| window.used_fraction)
    }

    /// A janela semanal so vira anel quando nao repete a do meio.
    pub fn weekly(&self) -> Option<&LimitWindow> {
        let id = self.weekly_id.as_deref()?;
        if Some(id) == self.headline_id.as_deref() {
            return None;
        }
        self.windows.iter().find(|window| window.id == id)
    }

    pub fn has_reading(&self) -> bool {
        !self.windows.is_empty()
    }
}

/* ── bandas de uso ─────────────────────────────────────────────────── */

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageBand {
    Ample,
    Watch,
    Critical,
    Exhausted,
}

pub fn band(fraction: f64, watch: f64, critical: f64) -> UsageBand {
    if fraction >= 1.0 {
        UsageBand::Exhausted
    } else if fraction >= critical {
        UsageBand::Critical
    } else if fraction >= watch {
        UsageBand::Watch
    } else {
        UsageBand::Ample
    }
}

/* ── erros de leitura ──────────────────────────────────────────────── */

#[derive(Clone, Debug, PartialEq)]
pub enum FetchError {
    NeedsAuth,
    SignedOutByOwner,
    AccessDenied,
    CredentialExpired,
    RateLimited {
        until_ms: u64,
    },
    BadResponse(u16),
    NothingMetered,
    Timeout,
    /// Sem `curl` no sistema: a fonte fica indisponivel e a proxima entra.
    CurlMissing,
    Io(String),
}

impl FetchError {
    pub fn status(&self) -> ProviderStatus {
        match self {
            FetchError::NeedsAuth => ProviderStatus::NeedsAuth,
            FetchError::SignedOutByOwner => ProviderStatus::SignedOutByOwner,
            FetchError::AccessDenied => ProviderStatus::AccessDenied,
            // Token vencido e coisa do dono renovar: a leitura envelhece, nao
            // some.
            FetchError::CredentialExpired => ProviderStatus::Stale { since_ms: now_ms() },
            FetchError::RateLimited { .. } => ProviderStatus::Stale { since_ms: now_ms() },
            FetchError::BadResponse(code) => ProviderStatus::Error {
                message: "http".to_string(),
                detail: Some(code.to_string()),
            },
            FetchError::NothingMetered => ProviderStatus::Unsupported {
                message: "nothingMetered".to_string(),
            },
            FetchError::Timeout => ProviderStatus::Error {
                message: "timeout".to_string(),
                detail: None,
            },
            FetchError::CurlMissing => ProviderStatus::Error {
                message: "curlMissing".to_string(),
                detail: None,
            },
            FetchError::Io(message) => ProviderStatus::Error {
                message: "network".to_string(),
                detail: Some(message.clone()),
            },
        }
    }
}

/// O que uma fonte devolve quando da certo.
#[derive(Clone, Debug, PartialEq)]
pub struct Reading {
    pub windows: Vec<LimitWindow>,
    pub plan: Option<String>,
    pub fidelity: Fidelity,
    /// Codigo da fonte, o mesmo de [`ProviderSnapshot::source`].
    pub source: String,
}

/* ── memoria entre leituras ────────────────────────────────────────── */

/// Estado que sobrevive entre rodadas: o recuo depois de um 429 e o
/// resultado recente da linha de comando, que e cara.
#[derive(Default)]
pub struct Memory {
    /// Id do perfil para o instante, em epoch ms, antes do qual nao se tenta
    /// de novo.
    pub backoff_until: BTreeMap<String, u64>,
    /// Quantos 429 seguidos, para dobrar a espera.
    pub rate_limit_streak: BTreeMap<String, u32>,
    /// Ultima saida boa da linha de comando por perfil.
    pub cli: BTreeMap<String, (u64, Reading)>,
    /// Ultima varredura falha do cache do Claude Desktop por perfil.
    pub desktop_miss: BTreeMap<String, u64>,
}

impl Memory {
    pub fn holding(&self, id: &str, now: u64) -> bool {
        self.backoff_until.get(id).is_some_and(|until| *until > now)
    }

    /// Recuo do Codenotch: um minuto, dobrando a cada 429 seguido, teto de
    /// quinze minutos. `Retry-After` so pode aumentar a espera.
    pub fn note_rate_limit(&mut self, id: &str, retry_after_ms: Option<u64>) -> u64 {
        let streak = self.rate_limit_streak.entry(id.to_string()).or_insert(0);
        let doubled = 60_000u64 << (*streak).min(4);
        *streak = streak.saturating_add(1);
        let wait = doubled.max(retry_after_ms.unwrap_or(0)).min(900_000);
        let until = now_ms() + wait;
        self.backoff_until.insert(id.to_string(), until);
        until
    }

    pub fn clear_rate_limit(&mut self, id: &str) {
        self.rate_limit_streak.remove(id);
        self.backoff_until.remove(id);
    }
}

/* ── arquivo da ultima leitura boa ─────────────────────────────────── */

#[derive(Serialize, Deserialize, Default)]
struct Archive {
    #[serde(default)]
    snapshots: Vec<ProviderSnapshot>,
    #[serde(default)]
    backoff: BTreeMap<String, u64>,
}

fn archive_path(app_support: &Path) -> PathBuf {
    app_support.join("notch").join("usage.json")
}

pub fn load_archive(app_support: &Path) -> (Vec<ProviderSnapshot>, BTreeMap<String, u64>) {
    let Ok(raw) = std::fs::read_to_string(archive_path(app_support)) else {
        return (Vec::new(), BTreeMap::new());
    };
    let Ok(parsed) = serde_json::from_str::<Archive>(&raw) else {
        return (Vec::new(), BTreeMap::new());
    };
    let now = now_ms();
    let snapshots = parsed
        .snapshots
        .into_iter()
        .map(|mut snapshot| {
            // Tudo que vem do disco entra velho: ainda nao foi confirmado
            // nesta sessao.
            snapshot.status = ProviderStatus::Stale {
                since_ms: snapshot.fetched_at_ms,
            };
            snapshot
        })
        .collect();
    let backoff = parsed
        .backoff
        .into_iter()
        .filter(|(_, until)| *until > now)
        .collect();
    (snapshots, backoff)
}

pub fn save_archive(
    app_support: &Path,
    snapshots: &[ProviderSnapshot],
    backoff: &BTreeMap<String, u64>,
) {
    let path = archive_path(app_support);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let archive = Archive {
        snapshots: snapshots
            .iter()
            .filter(|snapshot| snapshot.has_reading())
            .cloned()
            .collect(),
        backoff: backoff.clone(),
    };
    if let Ok(raw) = serde_json::to_string_pretty(&archive) {
        let temporary = path.with_extension("tmp");
        if std::fs::write(&temporary, raw).is_ok() {
            let _ = std::fs::rename(&temporary, &path);
        }
    }
}

/* ── loja ──────────────────────────────────────────────────────────── */

pub struct UsageStore {
    inner: Mutex<StoreState>,
}

#[derive(Default)]
struct StoreState {
    snapshots: BTreeMap<String, ProviderSnapshot>,
    memory: Memory,
    last_attempt: Option<Instant>,
}

impl UsageStore {
    pub fn new(app_support: &Path) -> Self {
        let (saved, backoff) = load_archive(app_support);
        let mut snapshots = BTreeMap::new();
        for snapshot in saved {
            snapshots.insert(snapshot.id.clone(), snapshot);
        }
        let memory = Memory {
            backoff_until: backoff,
            ..Memory::default()
        };
        Self {
            inner: Mutex::new(StoreState {
                snapshots,
                memory,
                last_attempt: None,
            }),
        }
    }

    pub fn snapshots(&self) -> Vec<ProviderSnapshot> {
        self.inner
            .lock()
            .map(|guard| guard.snapshots.values().cloned().collect())
            .unwrap_or_default()
    }

    /// Leituras dos perfis pedidos, na ordem pedida, com placeholder para
    /// quem ainda nao foi lido.
    pub fn for_profiles(&self, profiles: &[Profile]) -> Vec<ProviderSnapshot> {
        let guard = self.inner.lock();
        profiles
            .iter()
            .map(|profile| {
                let saved = guard
                    .as_ref()
                    .ok()
                    .and_then(|state| state.snapshots.get(&profile.id).cloned());
                match saved {
                    Some(mut snapshot) => {
                        // O rotulo e a conta vivem no perfil, nao no arquivo:
                        // trocar um apelido nao pode exigir nova leitura.
                        snapshot.label = profile.label.clone();
                        snapshot.account = profile.account.clone();
                        snapshot.config_dir = profile.config_dir.clone();
                        snapshot
                    }
                    None => ProviderSnapshot::placeholder(
                        profile,
                        ProviderStatus::Stale { since_ms: 0 },
                    ),
                }
            })
            .collect()
    }

    /// Chegou a hora de reler.
    pub fn due(&self, busy: bool) -> bool {
        let Ok(guard) = self.inner.lock() else {
            return false;
        };
        let Some(last) = guard.last_attempt else {
            return true;
        };
        let elapsed = last.elapsed();
        if busy {
            return elapsed >= BUSY_INTERVAL;
        }
        if elapsed >= IDLE_INTERVAL {
            return true;
        }
        // Uma janela que acabou de virar merece uma leitura fora de hora.
        let now = now_ms();
        let last_ms = now.saturating_sub(elapsed.as_millis() as u64);
        guard.snapshots.values().any(|snapshot| {
            snapshot.windows.iter().any(|window| {
                window
                    .resets_at_ms
                    .is_some_and(|reset| reset > last_ms && reset <= now)
            })
        })
    }

    /// Le todos os perfis pedidos em paralelo e guarda o resultado.
    pub fn refresh(
        &self,
        profiles: &[Profile],
        home: &Path,
        app_support: &Path,
    ) -> Vec<ProviderSnapshot> {
        if let Ok(mut guard) = self.inner.lock() {
            guard.last_attempt = Some(Instant::now());
        }
        let (sender, receiver) = mpsc::channel::<(String, Result<Reading, FetchError>)>();
        let mut expected = 0usize;
        for profile in profiles {
            let (holding, cli_cache, desktop_miss) = self
                .inner
                .lock()
                .map(|guard| {
                    (
                        guard.memory.holding(&profile.id, now_ms()),
                        guard.memory.cli.get(&profile.id).cloned(),
                        guard.memory.desktop_miss.get(&profile.id).copied(),
                    )
                })
                .unwrap_or((false, None, None));
            let profile = profile.clone();
            let home = home.to_path_buf();
            let support = app_support.to_path_buf();
            let sender = sender.clone();
            expected += 1;
            std::thread::spawn(move || {
                let outcome = match profile.provider {
                    Provider::Claude => {
                        claude::fetch(&profile, &home, &support, holding, cli_cache, desktop_miss)
                    }
                    Provider::Codex => codex::fetch(&profile, holding),
                };
                let _ = sender.send((profile.id.clone(), outcome));
            });
        }
        drop(sender);

        let deadline = Instant::now() + ROUND_DEADLINE;
        let mut results: BTreeMap<String, Result<Reading, FetchError>> = BTreeMap::new();
        while results.len() < expected {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            match receiver.recv_timeout(left) {
                Ok((id, outcome)) => {
                    results.insert(id, outcome);
                }
                Err(_) => break,
            }
        }

        let mut out = Vec::new();
        if let Ok(mut guard) = self.inner.lock() {
            for profile in profiles {
                let outcome = results
                    .remove(&profile.id)
                    .unwrap_or(Err(FetchError::Timeout));
                let snapshot = apply(&mut guard, profile, outcome);
                out.push(snapshot);
            }
            let all: Vec<ProviderSnapshot> = guard.snapshots.values().cloned().collect();
            let backoff = guard.memory.backoff_until.clone();
            save_archive(app_support, &all, &backoff);
        }
        out
    }

    /// Esquece a credencial guardada e obriga uma leitura nova daquele perfil.
    pub fn forget(&self, id: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard.memory.cli.remove(id);
            guard.memory.desktop_miss.remove(id);
            guard.memory.clear_rate_limit(id);
            guard.last_attempt = None;
        }
        credentials::forget(id);
    }
}

/// Junta o resultado de uma leitura ao que ja se sabia do perfil.
fn apply(
    state: &mut StoreState,
    profile: &Profile,
    outcome: Result<Reading, FetchError>,
) -> ProviderSnapshot {
    let now = now_ms();
    match outcome {
        Ok(reading) => {
            state.memory.clear_rate_limit(&profile.id);
            if reading.source == claude::SOURCE_CLI {
                state
                    .memory
                    .cli
                    .insert(profile.id.clone(), (now, reading.clone()));
            }
            let snapshot = ProviderSnapshot {
                id: profile.id.clone(),
                provider: profile.provider.as_str().to_string(),
                label: profile.label.clone(),
                account: profile.account.clone(),
                config_dir: profile.config_dir.clone(),
                plan: reading.plan.clone().or_else(|| profile.plan.clone()),
                fidelity: reading.fidelity,
                status: ProviderStatus::Ok,
                headline_id: headline_for(profile.provider, &reading.windows),
                weekly_id: weekly_for(profile.provider, &reading.windows),
                windows: reading.windows,
                fetched_at_ms: now,
                source: Some(reading.source),
            };
            state.snapshots.insert(profile.id.clone(), snapshot.clone());
            snapshot
        }
        Err(error) => {
            if let FetchError::RateLimited { until_ms } = error {
                state
                    .memory
                    .backoff_until
                    .insert(profile.id.clone(), until_ms);
            }
            let status = error.status();
            if status.supersedes_history() {
                state.snapshots.remove(&profile.id);
                let snapshot = ProviderSnapshot::placeholder(profile, status);
                state.snapshots.insert(profile.id.clone(), snapshot.clone());
                return snapshot;
            }
            match state.snapshots.get(&profile.id).cloned() {
                Some(mut previous) if previous.has_reading() => {
                    let age = now.saturating_sub(previous.fetched_at_ms);
                    previous.status = if age > STALE_AFTER_MS {
                        ProviderStatus::Stale {
                            since_ms: previous.fetched_at_ms,
                        }
                    } else {
                        status
                    };
                    previous.label = profile.label.clone();
                    state.snapshots.insert(profile.id.clone(), previous.clone());
                    previous
                }
                _ => {
                    let snapshot = ProviderSnapshot::placeholder(profile, status);
                    state.snapshots.insert(profile.id.clone(), snapshot.clone());
                    snapshot
                }
            }
        }
    }
}

/// A janela do anel e a **sessao atual**: cinco horas no Claude Code, a
/// janela curta no Codex. E o mesmo numero que o `/usage` de cada ferramenta
/// poe em primeiro lugar, entao os dois nunca discordam. As outras janelas
/// ficam no detalhe.
fn headline_for(provider: Provider, windows: &[LimitWindow]) -> Option<String> {
    let wanted = match provider {
        Provider::Claude => "session",
        Provider::Codex => "primary",
    };
    windows
        .iter()
        .find(|window| window.id == wanted)
        .map(|window| window.id.clone())
}

/// A janela semanal geral, para o card. `None` quando e a mesma do anel.
fn weekly_for(provider: Provider, windows: &[LimitWindow]) -> Option<String> {
    let wanted = match provider {
        Provider::Claude => "weekly_all",
        Provider::Codex => "secondary",
    };
    windows
        .iter()
        .find(|window| window.id == wanted)
        .map(|window| window.id.clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notch::profiles::Provider;

    fn window(id: &str, used: f64) -> LimitWindow {
        LimitWindow {
            id: id.to_string(),
            group: None,
            label: id.to_string(),
            used_fraction: Some(used),
            resets_at_ms: Some(now_ms() + 60_000),
            duration_ms: Some(5 * 3600 * 1000),
        }
    }

    fn profile(id: &str, provider: Provider) -> Profile {
        Profile {
            id: id.to_string(),
            provider,
            slug: Some("x".to_string()),
            config_dir: "/tmp/x".to_string(),
            account: None,
            account_key: None,
            plan: None,
            label: "x".to_string(),
            duplicate: false,
        }
    }

    #[test]
    fn the_bands_sit_on_the_thresholds() {
        assert_eq!(band(0.4999, 0.5, 0.7), UsageBand::Ample);
        assert_eq!(band(0.5, 0.5, 0.7), UsageBand::Watch);
        assert_eq!(band(0.6999, 0.5, 0.7), UsageBand::Watch);
        assert_eq!(band(0.7, 0.5, 0.7), UsageBand::Critical);
        assert_eq!(band(0.9999, 0.5, 0.7), UsageBand::Critical);
        assert_eq!(band(1.0, 0.5, 0.7), UsageBand::Exhausted);
    }

    #[test]
    fn the_ring_shows_the_current_session() {
        let windows = vec![
            window("session", 0.0),
            window("weekly_all", 0.9),
            window("weekly_fable", 1.0),
        ];
        assert_eq!(
            headline_for(Provider::Claude, &windows).as_deref(),
            Some("session")
        );
        let codex = vec![window("primary", 0.12), window("secondary", 0.57)];
        assert_eq!(
            headline_for(Provider::Codex, &codex).as_deref(),
            Some("primary")
        );
    }

    #[test]
    fn without_the_session_window_nothing_is_promoted() {
        let windows = vec![window("weekly_all", 0.9)];
        assert!(
            headline_for(Provider::Claude, &windows).is_none(),
            "sem a sessao, o anel mostra o traco"
        );
    }

    #[test]
    fn the_weekly_ring_never_repeats_the_headline() {
        let mut snapshot = ProviderSnapshot::placeholder(
            &profile("codex-amorim", Provider::Codex),
            ProviderStatus::Ok,
        );
        snapshot.windows = vec![window("primary", 0.2)];
        snapshot.headline_id = Some("primary".to_string());
        snapshot.weekly_id = Some("primary".to_string());
        assert!(snapshot.weekly().is_none());
    }

    #[test]
    fn the_backoff_doubles_and_stops_at_fifteen_minutes() {
        let mut memory = Memory::default();
        let base = now_ms();
        let first = memory.note_rate_limit("claude", None);
        assert!((first - base) >= 60_000 && (first - base) <= 61_000);
        let second = memory.note_rate_limit("claude", None);
        assert!((second - base) >= 120_000);
        for _ in 0..10 {
            memory.note_rate_limit("claude", None);
        }
        let capped = memory.note_rate_limit("claude", None);
        assert!((capped - now_ms()) <= 900_000);
    }

    #[test]
    fn retry_after_can_only_raise_the_wait() {
        let mut memory = Memory::default();
        let base = now_ms();
        let until = memory.note_rate_limit("codex", Some(600_000));
        assert!((until - base) >= 600_000);
        let mut other = Memory::default();
        let low = other.note_rate_limit("codex", Some(0));
        assert!(
            (low - now_ms()) >= 59_000,
            "Retry-After zero nao derruba o piso"
        );
    }

    #[test]
    fn losing_the_credential_clears_the_history() {
        let mut state = StoreState::default();
        let profile = profile("claude-webrota", Provider::Claude);
        let good = Reading {
            windows: vec![window("session", 0.3)],
            plan: None,
            fidelity: Fidelity::Official,
            source: "teste".to_string(),
        };
        apply(&mut state, &profile, Ok(good));
        assert!(state.snapshots.get("claude-webrota").unwrap().has_reading());
        let after = apply(&mut state, &profile, Err(FetchError::NeedsAuth));
        assert!(!after.has_reading());
        assert_eq!(after.status, ProviderStatus::NeedsAuth);
    }

    #[test]
    fn a_network_failure_only_ages_the_reading() {
        let mut state = StoreState::default();
        let profile = profile("codex-amorim", Provider::Codex);
        let good = Reading {
            windows: vec![window("primary", 0.3)],
            plan: None,
            fidelity: Fidelity::Official,
            source: "teste".to_string(),
        };
        apply(&mut state, &profile, Ok(good));
        let after = apply(&mut state, &profile, Err(FetchError::Timeout));
        assert!(after.has_reading(), "a ultima leitura boa continua na tela");
        assert_eq!(after.used_fraction(), Some(0.3));
        assert_eq!(
            after.status,
            ProviderStatus::Error {
                message: "timeout".to_string(),
                detail: None
            }
        );
    }

    #[test]
    fn the_status_codes_are_what_the_interface_translates() {
        let value = serde_json::to_value(FetchError::BadResponse(503).status()).unwrap();
        assert_eq!(value["kind"], "error");
        assert_eq!(value["message"], "http");
        assert_eq!(value["detail"], "503");
        let value = serde_json::to_value(FetchError::NothingMetered.status()).unwrap();
        assert_eq!(value["kind"], "unsupported");
        assert_eq!(value["message"], "nothingMetered");
        let value = serde_json::to_value(ProviderStatus::Stale { since_ms: 7 }).unwrap();
        assert_eq!(value["kind"], "stale");
        assert_eq!(value["sinceMs"], 7);
        let value = serde_json::to_value(FetchError::CurlMissing.status()).unwrap();
        assert_eq!(value["message"], "curlMissing");
        assert!(value.get("detail").is_none());
    }

    #[test]
    fn the_archive_comes_back_stale_and_drops_expired_backoff() {
        let dir = std::env::temp_dir().join(format!("cialai-notch-archive-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut snapshot = ProviderSnapshot::placeholder(
            &profile("codex-amorim", Provider::Codex),
            ProviderStatus::Ok,
        );
        snapshot.windows = vec![window("primary", 0.4)];
        snapshot.fetched_at_ms = 123;
        let empty =
            ProviderSnapshot::placeholder(&profile("claude", Provider::Claude), ProviderStatus::Ok);
        let mut backoff = BTreeMap::new();
        backoff.insert("codex-amorim".to_string(), now_ms() + 60_000);
        backoff.insert("claude".to_string(), 1);
        save_archive(&dir, &[snapshot, empty], &backoff);
        assert!(dir.join("notch").join("usage.json").is_file());
        let (loaded, kept) = load_archive(&dir);
        assert_eq!(loaded.len(), 1, "sem leitura nao vai para o disco");
        assert_eq!(loaded[0].status, ProviderStatus::Stale { since_ms: 123 });
        assert_eq!(kept.len(), 1);
        assert!(kept.contains_key("codex-amorim"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
