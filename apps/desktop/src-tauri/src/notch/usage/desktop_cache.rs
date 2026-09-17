// SPDX-License-Identifier: Apache-2.0
//! Leitura do cache HTTP do Claude Desktop.
//!
//! O Claude Desktop e um app Chromium, entao a resposta de uso que o painel
//! dele desenha fica gravada num arquivo do Simple Cache: em
//! `~/Library/Application Support/Claude/Cache/Cache_Data` no macOS e em
//! `%APPDATA%\Claude\Cache\Cache_Data` no Windows. Nao existe Claude Desktop
//! para Linux, entao la a fonte e pulada sem erro. Ler isso e o que mantem o
//! anel certo para quem trabalha no app em vez do terminal: nesse caso o
//! `claude /usage` e a credencial ficam mudos, porque nenhum dos dois foi
//! exercitado.
//!
//! A leitura e estritamente de leitura e estreita: so entradas cuja URL
//! guardada e o `/api/organizations/<organizacao deste perfil>/usage` sao
//! abertas. Assim o numero de uma conta nunca cai no anel de outra. Nenhum
//! token, cookie ou credencial passa por aqui, e nenhuma chamada e feita a
//! Anthropic.
//!
//! O formato do cache do Chromium e privado e pode mudar. Se mudar, esta
//! fonte fica em silencio e as outras assumem.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use super::super::profiles::{Profile, claude_account_file};

/// Assinatura do Simple Cache do Chromium.
const MAGIC: u64 = 0xfcfb_6d1b_a772_5c30;
/// Assinatura de um quadro zstd.
const ZSTD_MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];
/// Cabecalho minimo: magic, versao, tamanho da chave, um campo ignorado e
/// quatro bytes de alinhamento.
const HEADER: usize = 24;
const MAX_KEY: u32 = 8 * 1024;
/// Corpo descomprimido: a resposta de uso tem alguns kilobytes.
const MAX_BODY: usize = 256 * 1024;
/// Entradas maiores que isto nao sao resposta de uso.
const MAX_FILE: u64 = 512 * 1024;
/// Arquivos examinados por varredura, dos mais recentes para tras.
const MAX_SCANNED: usize = 400;

pub struct CachedResponse {
    pub body: String,
    pub captured_at_ms: u64,
}

/// Pasta do cache neste sistema. `None` onde o app nao existe.
pub fn cache_dir(home: &Path) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        Some(home.join("Library/Application Support/Claude/Cache/Cache_Data"))
    }
    #[cfg(target_os = "windows")]
    {
        let roaming = std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join("AppData").join("Roaming"));
        Some(roaming.join("Claude").join("Cache").join("Cache_Data"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = home;
        None
    }
}

/// Organizacao que o perfil registra, e que amarra a entrada a esta conta.
pub fn organization_of(profile: &Profile) -> Option<String> {
    let path = claude_account_file(&profile.dir(), profile.slug.is_none());
    let raw = std::fs::read_to_string(path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    parsed
        .pointer("/oauthAccount/organizationUuid")
        .and_then(|value| value.as_str())
        .map(|value| value.to_string())
}

/// Resposta de uso guardada para esta organizacao, se houver.
///
/// O Desktop alterna entre dois arquivos, um por variante da URL, entao a
/// varredura roda a cada leitura em vez de lembrar um vencedor.
pub fn read(home: &Path, organization: &str) -> Option<CachedResponse> {
    let dir = cache_dir(home)?;
    let mut best: Option<CachedResponse> = None;
    for path in candidates(&dir) {
        let Some(entry) = parse_entry(&path) else {
            continue;
        };
        if !key_matches(&entry.key, organization) {
            continue;
        }
        let Some(body) = decompress(&entry.body) else {
            continue;
        };
        let captured = modified_ms(&path);
        if best
            .as_ref()
            .is_none_or(|found| captured > found.captured_at_ms)
        {
            best = Some(CachedResponse {
                body,
                captured_at_ms: captured,
            });
        }
    }
    best
}

/// Arquivos plausiveis, do mais recente para o mais antigo.
fn candidates(dir: &Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<(u64, PathBuf)> = read
        .flatten()
        .filter_map(|item| {
            let path = item.path();
            let name = path.file_name()?.to_str()?;
            if !name.ends_with("_0") {
                return None;
            }
            let meta = item.metadata().ok()?;
            if !meta.is_file() || meta.len() <= HEADER as u64 || meta.len() > MAX_FILE {
                return None;
            }
            Some((modified_ms(&path), path))
        })
        .collect();
    found.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    found
        .into_iter()
        .take(MAX_SCANNED)
        .map(|(_, path)| path)
        .collect()
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

struct Entry {
    key: String,
    body: Vec<u8>,
}

fn parse_entry(path: &Path) -> Option<Entry> {
    let raw = std::fs::read(path).ok()?;
    parse_bytes(&raw)
}

/// Cabecalho do Simple Cache, em little endian.
fn parse_bytes(raw: &[u8]) -> Option<Entry> {
    if raw.len() < HEADER {
        return None;
    }
    let magic = u64::from_le_bytes(raw[0..8].try_into().ok()?);
    if magic != MAGIC {
        return None;
    }
    let key_length = u32::from_le_bytes(raw[12..16].try_into().ok()?);
    if key_length == 0 || key_length > MAX_KEY {
        return None;
    }
    let start = HEADER;
    let end = start.checked_add(key_length as usize)?;
    if end > raw.len() {
        return None;
    }
    let key = String::from_utf8_lossy(&raw[start..end]).to_string();
    Some(Entry {
        key,
        body: raw[end..].to_vec(),
    })
}

/// A chave guarda a URL. So o `/usage` desta organizacao passa: sem isso, o
/// numero de uma conta poderia cair no anel de outra.
pub fn key_matches(key: &str, organization: &str) -> bool {
    if !key.contains("claude.ai") && !key.contains("anthropic.com") {
        return false;
    }
    let Some(after) = key.split("/api/organizations/").nth(1) else {
        return false;
    };
    let path = after.split('?').next().unwrap_or(after);
    let path = path.split('#').next().unwrap_or(path);
    let mut parts = path.trim_end_matches('/').split('/');
    let Some(found) = parts.next() else {
        return false;
    };
    if found != organization {
        return false;
    }
    parts.next() == Some("usage") && parts.next().is_none()
}

/// Descomprime um quadro zstd e para nele, ignorando o rodape de cabecalhos
/// que o Chromium grava depois do corpo.
fn decompress(body: &[u8]) -> Option<String> {
    if body.len() < 4 || body[0..4] != ZSTD_MAGIC {
        // Corpo sem compressao acontece em respostas curtas.
        let text = String::from_utf8_lossy(body);
        let start = text.find('{')?;
        return Some(text[start..].to_string());
    }
    use std::io::Read;
    let decoder = zstd::stream::read::Decoder::new(body).ok()?.single_frame();
    let mut out = Vec::new();
    decoder.take(MAX_BODY as u64).read_to_end(&mut out).ok()?;
    let text = String::from_utf8(out).ok()?;
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ORG: &str = "abc79839-96f7-4394-9cc8-e85cbfe32b07";

    #[test]
    fn the_usage_key_of_this_organization_matches() {
        let key = format!("1/0/https://claude.ai/api/organizations/{ORG}/usage");
        assert!(key_matches(&key, ORG));
    }

    #[test]
    fn the_variant_with_a_query_also_matches() {
        let key = format!("1/0/https://claude.ai/api/organizations/{ORG}/usage?skip_spend=1");
        assert!(key_matches(&key, ORG));
    }

    #[test]
    fn another_organization_never_matches() {
        let key = format!("1/0/https://claude.ai/api/organizations/{ORG}/usage");
        assert!(!key_matches(&key, "99999999-0000-0000-0000-000000000000"));
    }

    #[test]
    fn other_endpoints_of_the_same_organization_are_left_closed() {
        for tail in [
            "projects",
            "skills/list-skills",
            "subscription_details",
            "usage/extra",
        ] {
            let key = format!("1/0/https://claude.ai/api/organizations/{ORG}/{tail}");
            assert!(!key_matches(&key, ORG), "{tail} nao devia abrir");
        }
    }

    #[test]
    fn a_key_from_another_host_never_matches() {
        let key = format!("1/0/https://exemplo.com/api/organizations/{ORG}/usage");
        assert!(!key_matches(&key, ORG));
    }

    #[test]
    fn reads_the_header_of_a_simple_cache_entry() {
        let key = format!("1/0/https://claude.ai/api/organizations/{ORG}/usage");
        let mut raw = Vec::new();
        raw.extend_from_slice(&MAGIC.to_le_bytes());
        raw.extend_from_slice(&1u32.to_le_bytes());
        raw.extend_from_slice(&(key.len() as u32).to_le_bytes());
        raw.extend_from_slice(&0u32.to_le_bytes());
        raw.extend_from_slice(&[0, 0, 0, 0]);
        raw.extend_from_slice(key.as_bytes());
        raw.extend_from_slice(b"corpo");
        let entry = parse_bytes(&raw).unwrap();
        assert_eq!(entry.key, key);
        assert_eq!(entry.body, b"corpo");
    }

    #[test]
    fn a_file_with_another_magic_is_not_an_entry() {
        let raw = vec![0u8; 64];
        assert!(parse_bytes(&raw).is_none());
    }

    #[test]
    fn a_key_longer_than_the_file_is_refused() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&MAGIC.to_le_bytes());
        raw.extend_from_slice(&1u32.to_le_bytes());
        raw.extend_from_slice(&999u32.to_le_bytes());
        raw.extend_from_slice(&0u32.to_le_bytes());
        raw.extend_from_slice(&[0, 0, 0, 0]);
        assert!(parse_bytes(&raw).is_none());
    }

    #[test]
    fn a_zstd_body_round_trips() {
        let payload = br#"{"five_hour":{"utilization":42.0,"resets_at":"2026-09-16T12:00:00Z"}}"#;
        let compressed = zstd::stream::encode_all(&payload[..], 3).unwrap();
        // Rodape de cabecalhos depois do quadro, como o Chromium grava.
        let mut body = compressed.clone();
        body.extend_from_slice(b"\0date:Tue, 16 Sep 2026 12:00:00 GMT\0");
        let text = decompress(&body).unwrap();
        assert!(text.contains("five_hour"));
        let windows = super::super::claude::windows_from_response(&text).unwrap();
        assert_eq!(windows[0].id, "session");
        assert_eq!(windows[0].used_fraction, Some(0.42));
    }

    #[test]
    fn a_full_scan_of_a_temporary_cache_finds_the_newest_usage_entry() {
        let home =
            std::env::temp_dir().join(format!("cialai-notch-desktop-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&home);
        let dir = home.join("cache");
        std::fs::create_dir_all(&dir).unwrap();
        let entry = |key: &str, body: &[u8]| {
            let mut raw = Vec::new();
            raw.extend_from_slice(&MAGIC.to_le_bytes());
            raw.extend_from_slice(&1u32.to_le_bytes());
            raw.extend_from_slice(&(key.len() as u32).to_le_bytes());
            raw.extend_from_slice(&0u32.to_le_bytes());
            raw.extend_from_slice(&[0, 0, 0, 0]);
            raw.extend_from_slice(key.as_bytes());
            raw.extend_from_slice(body);
            raw
        };
        std::fs::write(
            dir.join("aaaa_0"),
            entry(
                &format!("1/0/https://claude.ai/api/organizations/{ORG}/projects"),
                b"{\"outro\":1}",
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("bbbb_0"),
            entry(
                &format!("1/0/https://claude.ai/api/organizations/{ORG}/usage"),
                b"{\"five_hour\":{\"utilization\":9.0}}",
            ),
        )
        .unwrap();
        std::fs::write(dir.join("cccc_1"), b"nao e entrada").unwrap();
        // A varredura e a mesma nos tres sistemas; so a pasta muda.
        let mut best: Option<CachedResponse> = None;
        for path in candidates(&dir) {
            let Some(found) = parse_entry(&path) else {
                continue;
            };
            if !key_matches(&found.key, ORG) {
                continue;
            }
            let body = decompress(&found.body).unwrap();
            best = Some(CachedResponse {
                body,
                captured_at_ms: modified_ms(&path),
            });
        }
        let found = best.expect("a entrada de uso e encontrada");
        assert!(found.body.contains("five_hour"));
        assert!(found.captured_at_ms > 0);
        let _ = std::fs::remove_dir_all(&home);
    }
}
