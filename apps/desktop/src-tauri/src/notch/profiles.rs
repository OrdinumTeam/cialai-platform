// SPDX-License-Identifier: Apache-2.0
//! Perfis de Claude Code e Codex, que sao a unidade da Barra de IA.
//!
//! Diferenca deliberada em relacao ao Codenotch: aqui **nao existe um anel
//! neutro**. O Codenotch desenha um anel "Codex" e outro "Codex (webrota)";
//! esta barra desenha um anel por pasta de configuracao e o identifica pelo
//! perfil, porque quem tem cinco contas do Codex nao ganha nada com um anel
//! que diz apenas "Codex".
//!
//! - A identidade e a pasta: `~/.claude`, `~/.claude-webrota`, `~/.codex`,
//!   `~/.codex-amorim`. O id e o mesmo `profile_slug` que o estudio ja usa,
//!   entao um anel e um card de sessao falam do mesmo perfil.
//! - O rotulo e o slug sem prefixo: `webrota`, `amorim`, `aamorim`. O glifo
//!   diz o provedor; o texto diz a conta.
//! - As pastas sem slug, `~/.codex` e `~/.claude`, ganham rotulo da conta
//!   logada, a parte local do e-mail. Se essa conta ja aparece num perfil
//!   nomeado, a pasta sem slug some por padrao, para nao duplicar o anel.
//! - Um apelido nas Preferencias vence tudo.
//! - Uma pasta `~/.claude-<slug>` so vira perfil com credencial propria: o
//!   item do chaveiro no macOS, o `.credentials.json` no Linux e no Windows.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;

use super::prefs::NotchPreferences;
use super::usage::credentials;
use crate::workspace::procs::profile_slug;

/// Marcadores que provam que uma pasta `~/.claude-*` e mesmo um perfil do
/// Claude Code, e nao um plugin qualquer com nome parecido.
const CLAUDE_MARKERS: &[&str] = &[
    "sessions",
    "projects",
    "settings.json",
    "history.jsonl",
    ".claude.json",
];
/// O mesmo para o Codex.
const CODEX_MARKERS: &[&str] = &[
    "auth.json",
    "config.toml",
    "sessions",
    "history.jsonl",
    "state_5.sqlite",
];
/// Servico do item que o Claude Code grava no chaveiro do login do macOS.
const CLAUDE_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    /// `claude`, `claude-webrota`, `codex`, `codex-amorim`.
    pub id: String,
    pub provider: Provider,
    /// Sufixo da pasta, quando existe. `~/.codex` nao tem.
    pub slug: Option<String>,
    pub config_dir: String,
    /// Conta logada, quando o perfil a publica em disco.
    pub account: Option<String>,
    /// Chave estavel da conta para descobrir perfis duplicados: a organizacao
    /// no Claude, a conta no Codex.
    pub account_key: Option<String>,
    pub plan: Option<String>,
    /// O rotulo do anel.
    pub label: String,
    /// A pasta sem slug foi escondida por repetir a conta de um perfil
    /// nomeado.
    pub duplicate: bool,
}

impl Profile {
    pub fn dir(&self) -> PathBuf {
        PathBuf::from(&self.config_dir)
    }

    /// Nome legivel para avisos: `Claude · webrota`.
    pub fn title(&self) -> String {
        let provider = match self.provider {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
        };
        format!("{provider} · {}", self.label)
    }
}

/// Todos os perfis dos dois provedores, na ordem natural: padrao primeiro,
/// nomeados em ordem alfabetica.
pub fn discover(home: &Path) -> Vec<Profile> {
    let mut found = discover_provider(home, Provider::Claude);
    found.extend(discover_provider(home, Provider::Codex));
    mark_duplicates(&mut found);
    found
}

fn discover_provider(home: &Path, provider: Provider) -> Vec<Profile> {
    let base = format!(".{}", provider.as_str());
    let prefix = format!("{base}-");
    let mut named: Vec<Profile> = Vec::new();
    let mut default: Option<Profile> = None;

    if let Ok(read) = std::fs::read_dir(home) {
        for item in read.flatten() {
            let name = item.file_name().to_string_lossy().to_string();
            let is_default = name == base;
            let slug = if is_default {
                None
            } else if let Some(rest) = name.strip_prefix(&prefix) {
                if rest.is_empty() {
                    continue;
                }
                Some(rest.to_string())
            } else {
                continue;
            };
            let dir = item.path();
            if !dir.is_dir() || !has_marker(&dir, provider) {
                continue;
            }
            // Uma pasta nomeada do Claude so vale como perfil quando tem
            // credencial propria. Sem isto, plugins como `~/.claude-mem`
            // virariam aneis que nunca leem nada.
            if provider == Provider::Claude && slug.is_some() && !credentials::exists(&dir, false) {
                continue;
            }
            let profile = build(provider, slug.clone(), dir);
            if is_default {
                default = Some(profile);
            } else {
                named.push(profile);
            }
        }
    }
    named.sort_by(|a, b| a.slug.cmp(&b.slug));
    let mut all = Vec::new();
    if let Some(profile) = default {
        all.push(profile);
    }
    all.extend(named);
    all
}

fn has_marker(dir: &Path, provider: Provider) -> bool {
    let markers = match provider {
        Provider::Claude => CLAUDE_MARKERS,
        Provider::Codex => CODEX_MARKERS,
    };
    markers.iter().any(|marker| dir.join(marker).exists())
        || dir.join("sqlite/codex-dev.db").exists()
}

fn build(provider: Provider, slug: Option<String>, dir: PathBuf) -> Profile {
    let (account, account_key, plan) = match provider {
        Provider::Claude => claude_account(&dir, slug.is_none()),
        Provider::Codex => codex_account(&dir),
    };
    let label = slug
        .clone()
        .or_else(|| account.as_deref().and_then(local_part))
        .unwrap_or_else(|| match provider {
            Provider::Claude => "Claude".to_string(),
            Provider::Codex => "Codex".to_string(),
        });
    Profile {
        id: profile_slug(&dir),
        provider,
        slug,
        config_dir: crate::platform::to_portable(&dir),
        account,
        account_key,
        plan,
        label,
        duplicate: false,
    }
}

/// A pasta sem slug some quando a conta dela ja tem um anel nomeado.
fn mark_duplicates(profiles: &mut [Profile]) {
    let named: Vec<(Provider, String)> = profiles
        .iter()
        .filter(|profile| profile.slug.is_some())
        .filter_map(|profile| {
            profile
                .account_key
                .clone()
                .map(|key| (profile.provider, key))
        })
        .collect();
    for profile in profiles.iter_mut() {
        if profile.slug.is_some() {
            continue;
        }
        let Some(key) = profile.account_key.clone() else {
            continue;
        };
        profile.duplicate = named
            .iter()
            .any(|(provider, other)| *provider == profile.provider && *other == key);
    }
}

/// Parte local do e-mail: `amorim@ordinum.com.br` vira `amorim`.
fn local_part(email: &str) -> Option<String> {
    let trimmed = email.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.split('@').next().unwrap_or(trimmed).to_string())
}

/* ── conta do Claude Code ──────────────────────────────────────────── */

/// O arquivo de conta do perfil padrao fica **ao lado** da pasta, em
/// `~/.claude.json`; o de um perfil nomeado fica dentro dela.
pub fn claude_account_file(dir: &Path, is_default: bool) -> PathBuf {
    if is_default {
        dir.parent()
            .map(|home| home.join(".claude.json"))
            .unwrap_or_else(|| dir.join(".claude.json"))
    } else {
        dir.join(".claude.json")
    }
}

fn claude_account(
    dir: &Path,
    is_default: bool,
) -> (Option<String>, Option<String>, Option<String>) {
    let path = claude_account_file(dir, is_default);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return (None, None, None);
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return (None, None, None);
    };
    let account = parsed
        .pointer("/oauthAccount/emailAddress")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let organization = parsed
        .pointer("/oauthAccount/organizationUuid")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    // A organizacao sozinha nao separa duas contas do mesmo time; o e-mail
    // entra na chave para o dedupe nao esconder um anel que e outra conta.
    let key = match (&organization, &account) {
        (Some(organization), Some(account)) => Some(format!("{organization}|{account}")),
        (Some(organization), None) => Some(organization.clone()),
        (None, Some(account)) => Some(account.clone()),
        (None, None) => None,
    };
    (account, key, None)
}

/// Servicos do chaveiro do macOS que podem guardar a credencial deste perfil.
/// O nome sufixado vem primeiro: quando o shell exporta `CLAUDE_CONFIG_DIR`,
/// ate o perfil padrao ganha sufixo.
pub fn claude_keychain_services(dir: &Path, is_default: bool) -> Vec<String> {
    let mut services = vec![format!("{CLAUDE_KEYCHAIN_SERVICE}-{}", path_suffix(dir))];
    if is_default {
        services.push(CLAUDE_KEYCHAIN_SERVICE.to_string());
    }
    services
}

/// Oito primeiros digitos do SHA-256 do caminho da pasta, sem barra final. E
/// a regra que o proprio Claude Code usa para nomear o item do chaveiro.
pub fn path_suffix(dir: &Path) -> String {
    let text = dir.to_string_lossy();
    let trimmed = text.trim_end_matches('/');
    let digest = sha256(trimmed.as_bytes());
    digest
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/* ── conta do Codex ────────────────────────────────────────────────── */

fn codex_account(dir: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let Ok(raw) = std::fs::read_to_string(dir.join("auth.json")) else {
        return (None, None, None);
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return (None, None, None);
    };
    let account_id = parsed
        .pointer("/tokens/account_id")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let claims = parsed
        .pointer("/tokens/id_token")
        .and_then(|value| value.as_str())
        .and_then(jwt_claims)
        .unwrap_or(serde_json::Value::Null);
    let email = claims
        .get("email")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let plan = claims
        .get("https://api.openai.com/auth")
        .and_then(|node| node.get("chatgpt_plan_type"))
        .and_then(|value| value.as_str())
        .map(|value| value.to_string());
    let key = account_id.clone().or_else(|| email.clone());
    (email, key, plan)
}

/// Payload de um JWT, sem validar assinatura: aqui ele so serve para nomear a
/// conta e o plano, valores que a propria interface ja mostraria.
pub fn jwt_claims(token: &str) -> Option<serde_json::Value> {
    let payload = token.split('.').nth(1)?;
    let decoded = base64_url(payload)?;
    serde_json::from_slice(&decoded).ok()
}

fn base64_url(input: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bits = 0u32;
    let mut count = 0u32;
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        let value = TABLE.iter().position(|item| *item == byte)? as u32;
        bits = (bits << 6) | value;
        count += 6;
        if count >= 8 {
            count -= 8;
            out.push((bits >> count) as u8);
        }
    }
    Some(out)
}

/* ── SHA-256, o suficiente para o nome do item do chaveiro ─────────── */

const K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = data.to_vec();
    let bits = (data.len() as u64).wrapping_mul(8);
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bits.to_be_bytes());

    for chunk in message.chunks_exact(64) {
        let mut w = [0u32; 64];
        for (index, word) in chunk.chunks_exact(4).enumerate() {
            w[index] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for index in 16..64 {
            let s0 = w[index - 15].rotate_right(7)
                ^ w[index - 15].rotate_right(18)
                ^ (w[index - 15] >> 3);
            let s1 = w[index - 2].rotate_right(17)
                ^ w[index - 2].rotate_right(19)
                ^ (w[index - 2] >> 10);
            w[index] = w[index - 16]
                .wrapping_add(s0)
                .wrapping_add(w[index - 7])
                .wrapping_add(s1);
        }
        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for index in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[index])
                .wrapping_add(w[index]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);
            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }
        for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
            *slot = slot.wrapping_add(value);
        }
    }
    let mut out = [0u8; 32];
    for (index, word) in state.iter().enumerate() {
        out[index * 4..index * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/* ── ordem e visibilidade ──────────────────────────────────────────── */

/// Perfis que viram anel, na ordem escolhida pelo usuario.
///
/// Um perfil desligado sai. Uma pasta sem slug que repete a conta de um
/// perfil nomeado sai por padrao, e volta se o usuario der um apelido a ela.
pub fn visible(profiles: &[Profile], prefs: &NotchPreferences) -> Vec<Profile> {
    let mut shown: Vec<Profile> = profiles
        .iter()
        .filter(|profile| {
            if !prefs.profile_enabled(&profile.id) {
                return false;
            }
            if profile.duplicate && prefs.hide_default_when_duplicate {
                return prefs
                    .profiles
                    .get(&profile.id)
                    .is_some_and(|row| row.enabled && row.alias.is_some());
            }
            true
        })
        .cloned()
        .collect();
    for profile in shown.iter_mut() {
        if let Some(alias) = prefs.profile_alias(&profile.id) {
            profile.label = alias;
        }
    }
    arrange(shown, &prefs.order)
}

/// Ordena pela lista salva; ids desconhecidos ficam no fim, na ordem natural.
pub fn arrange(items: Vec<Profile>, order: &[String]) -> Vec<Profile> {
    let rank: BTreeMap<&str, usize> = order
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect();
    let mut known: Vec<Profile> = Vec::new();
    let mut fresh: Vec<Profile> = Vec::new();
    for item in items {
        if rank.contains_key(item.id.as_str()) {
            known.push(item);
        } else {
            fresh.push(item);
        }
    }
    known.sort_by_key(|item| rank.get(item.id.as_str()).copied().unwrap_or(usize::MAX));
    known.extend(fresh);
    known
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cialai-notch-profiles-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn codex_auth(dir: &Path, account: &str, email: &str) {
        fs::create_dir_all(dir).unwrap();
        // Payload sem assinatura valida: o codigo so le os claims.
        let claims = serde_json::json!({ "email": email, "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" } });
        let payload = base64_url_encode(claims.to_string().as_bytes());
        let token = format!("aaaa.{payload}.bbbb");
        fs::write(
            dir.join("auth.json"),
            serde_json::json!({ "tokens": { "access_token": "t", "account_id": account, "id_token": token } }).to_string(),
        )
        .unwrap();
    }

    fn base64_url_encode(data: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in data.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            let take = chunk.len() + 1;
            for index in 0..take {
                out.push(TABLE[((n >> (18 - index * 6)) & 0x3f) as usize] as char);
            }
        }
        out
    }

    #[test]
    fn a_named_codex_profile_is_labelled_by_its_slug() {
        let home = sandbox("codex-slug");
        codex_auth(
            &home.join(".codex-amorim"),
            "acc-1",
            "amorim@ordinum.com.br",
        );
        let found = discover(&home);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "codex-amorim");
        assert_eq!(found[0].label, "amorim");
        assert_eq!(found[0].slug.as_deref(), Some("amorim"));
        assert_eq!(found[0].plan.as_deref(), Some("plus"));
        assert!(!found[0].config_dir.contains('\\'), "caminho portavel");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_default_codex_folder_is_labelled_by_its_account() {
        let home = sandbox("codex-default");
        codex_auth(&home.join(".codex"), "acc-9", "pessoal@exemplo.com");
        let found = discover(&home);
        assert_eq!(found[0].label, "pessoal", "sem slug, o rotulo vem da conta");
        assert_ne!(found[0].label, "Codex", "nunca um anel neutro");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_default_folder_is_hidden_when_it_repeats_a_named_account() {
        let home = sandbox("codex-dup");
        codex_auth(&home.join(".codex"), "acc-1", "amorim@ordinum.com.br");
        codex_auth(
            &home.join(".codex-amorim"),
            "acc-1",
            "amorim@ordinum.com.br",
        );
        let found = discover(&home);
        let default = found.iter().find(|profile| profile.id == "codex").unwrap();
        let named = found
            .iter()
            .find(|profile| profile.id == "codex-amorim")
            .unwrap();
        assert!(default.duplicate);
        assert!(!named.duplicate);

        let prefs = NotchPreferences::default();
        let shown = visible(&found, &prefs);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0].id, "codex-amorim");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn an_alias_brings_the_hidden_default_folder_back() {
        let home = sandbox("codex-dup-alias");
        codex_auth(&home.join(".codex"), "acc-1", "amorim@ordinum.com.br");
        codex_auth(
            &home.join(".codex-amorim"),
            "acc-1",
            "amorim@ordinum.com.br",
        );
        let found = discover(&home);
        let mut prefs = NotchPreferences::default();
        prefs.profiles.insert(
            "codex".to_string(),
            super::super::prefs::ProfilePreference {
                enabled: true,
                alias: Some("Pessoal".to_string()),
                muted: false,
            },
        );
        let shown = visible(&found, &prefs);
        assert_eq!(shown.len(), 2);
        assert!(shown.iter().any(|profile| profile.label == "Pessoal"));
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_different_account_in_the_default_folder_keeps_its_ring() {
        let home = sandbox("codex-two");
        codex_auth(&home.join(".codex"), "acc-2", "outra@exemplo.com");
        codex_auth(
            &home.join(".codex-amorim"),
            "acc-1",
            "amorim@ordinum.com.br",
        );
        let found = discover(&home);
        assert!(!found.iter().any(|profile| profile.duplicate));
        assert_eq!(visible(&found, &NotchPreferences::default()).len(), 2);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn named_profiles_come_in_alphabetical_order_after_the_default() {
        let home = sandbox("codex-order");
        codex_auth(&home.join(".codex"), "acc-0", "zero@exemplo.com");
        codex_auth(&home.join(".codex-webrota"), "acc-3", "w@exemplo.com");
        codex_auth(&home.join(".codex-aamorim"), "acc-2", "aa@exemplo.com");
        codex_auth(&home.join(".codex-amorim"), "acc-1", "a@exemplo.com");
        let ids: Vec<String> = discover(&home)
            .into_iter()
            .map(|profile| profile.id)
            .collect();
        assert_eq!(
            ids,
            vec!["codex", "codex-aamorim", "codex-amorim", "codex-webrota"]
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn an_alias_wins_over_the_slug() {
        let home = sandbox("codex-alias");
        codex_auth(&home.join(".codex-webrota"), "acc-3", "w@exemplo.com");
        let found = discover(&home);
        let mut prefs = NotchPreferences::default();
        prefs.profiles.insert(
            "codex-webrota".to_string(),
            super::super::prefs::ProfilePreference {
                enabled: true,
                alias: Some("WebRota".to_string()),
                muted: false,
            },
        );
        assert_eq!(visible(&found, &prefs)[0].label, "WebRota");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_disabled_profile_has_no_ring() {
        let home = sandbox("codex-off");
        codex_auth(&home.join(".codex-amorim"), "acc-1", "a@exemplo.com");
        let found = discover(&home);
        let mut prefs = NotchPreferences::default();
        prefs.profiles.insert(
            "codex-amorim".to_string(),
            super::super::prefs::ProfilePreference {
                enabled: false,
                alias: None,
                muted: false,
            },
        );
        assert!(visible(&found, &prefs).is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn a_folder_without_markers_is_not_a_profile() {
        let home = sandbox("codex-empty");
        fs::create_dir_all(home.join(".codex-vazio")).unwrap();
        fs::create_dir_all(home.join(".claude-vazio")).unwrap();
        assert!(discover(&home).is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    /// Fora do macOS a credencial e o `.credentials.json` da pasta: sem ele
    /// uma pasta `~/.claude-*` com marcadores e so um plugin com nome
    /// parecido. No macOS a mesma regra passa pelo chaveiro, que o teste nao
    /// toca.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_named_claude_folder_needs_its_own_credentials_file() {
        let home = sandbox("claude-credentials");
        fs::create_dir_all(home.join(".claude-mem/projects")).unwrap();
        fs::create_dir_all(home.join(".claude-work/projects")).unwrap();
        fs::write(
            home.join(".claude-work")
                .join(credentials::CREDENTIALS_FILE),
            r#"{"claudeAiOauth":{"accessToken":"x","expiresAt":1}}"#,
        )
        .unwrap();
        let ids: Vec<String> = discover(&home)
            .into_iter()
            .map(|profile| profile.id)
            .collect();
        assert_eq!(ids, vec!["claude-work"]);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_default_claude_folder_reads_its_account_beside_it() {
        let home = sandbox("claude-default");
        fs::create_dir_all(home.join(".claude/projects")).unwrap();
        fs::write(
            home.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"amorim@ordinum.com.br","organizationUuid":"org-1"}}"#,
        )
        .unwrap();
        let found = discover(&home);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].id, "claude");
        assert_eq!(found[0].label, "amorim");
        assert_eq!(
            found[0].account_key.as_deref(),
            Some("org-1|amorim@ordinum.com.br")
        );
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_saved_order_wins_and_new_profiles_go_last() {
        let home = sandbox("codex-arrange");
        codex_auth(&home.join(".codex-amorim"), "a", "a@e.com");
        codex_auth(&home.join(".codex-webrota"), "b", "b@e.com");
        codex_auth(&home.join(".codex-ordinum"), "c", "c@e.com");
        let found = discover(&home);
        let prefs = NotchPreferences {
            order: vec!["codex-webrota".to_string(), "codex-amorim".to_string()],
            ..NotchPreferences::default()
        };
        let ids: Vec<String> = visible(&found, &prefs)
            .into_iter()
            .map(|profile| profile.id)
            .collect();
        assert_eq!(ids, vec!["codex-webrota", "codex-amorim", "codex-ordinum"]);
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn the_keychain_service_follows_the_folder_path() {
        // Valores fixados pelo Codenotch para as mesmas pastas.
        assert_eq!(
            path_suffix(Path::new("/Users/vinz/.claude-work")),
            "19914660"
        );
        assert_eq!(path_suffix(Path::new("/Users/vinz/.claude")), "337ba600");
        let services = claude_keychain_services(Path::new("/Users/vinz/.claude"), true);
        assert_eq!(services[0], "Claude Code-credentials-337ba600");
        assert_eq!(services[1], "Claude Code-credentials");
        assert_eq!(
            claude_keychain_services(Path::new("/Users/vinz/.claude-work"), false).len(),
            1
        );
    }

    #[test]
    fn a_trailing_slash_does_not_change_the_service() {
        assert_eq!(
            path_suffix(Path::new("/Users/vinz/.claude/")),
            path_suffix(Path::new("/Users/vinz/.claude"))
        );
    }

    #[test]
    fn sha256_matches_the_known_vector() {
        let digest = sha256(b"abc");
        let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
        assert_eq!(
            hex,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn the_claude_account_file_sits_beside_the_default_folder() {
        assert_eq!(
            claude_account_file(Path::new("/Users/x/.claude"), true),
            PathBuf::from("/Users/x/.claude.json")
        );
        assert_eq!(
            claude_account_file(Path::new("/Users/x/.claude-webrota"), false),
            PathBuf::from("/Users/x/.claude-webrota/.claude.json")
        );
    }

    #[test]
    fn the_jwt_claims_are_read_without_the_signature() {
        let claims = serde_json::json!({ "email": "a@e.com", "exp": 1 });
        let token = format!("h.{}.s", base64_url_encode(claims.to_string().as_bytes()));
        assert_eq!(jwt_claims(&token).unwrap()["email"], "a@e.com");
        assert!(jwt_claims("sem-ponto").is_none());
    }

    /// Descoberta contra a maquina de quem roda, para conferir o que a barra
    /// vai desenhar aqui. Fica de fora da suite por depender da pasta pessoal
    /// real: `cargo test -- --ignored descobre_os_perfis_desta_maquina --nocapture`.
    #[test]
    #[ignore]
    fn descobre_os_perfis_desta_maquina() {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap();
        let found = discover(&home);
        let prefs = NotchPreferences::default();
        let shown = visible(&found, &prefs);
        println!("\nperfis encontrados: {}", found.len());
        for profile in &found {
            println!(
                "  {:22} {:10} rotulo {:12} conta {:32} {}",
                profile.id,
                profile.provider.as_str(),
                profile.label,
                profile
                    .account
                    .clone()
                    .unwrap_or_else(|| "sem conta".to_string()),
                if profile.duplicate {
                    "repete uma conta nomeada"
                } else {
                    ""
                }
            );
        }
        println!("\naneis que apareceriam: {}", shown.len());
        for profile in &shown {
            println!("  {} rotulado {}", profile.id, profile.label);
        }
        assert!(
            shown
                .iter()
                .all(|profile| profile.label != "Claude" && profile.label != "Codex"),
            "nenhum anel pode ficar com rotulo neutro"
        );
    }
}
