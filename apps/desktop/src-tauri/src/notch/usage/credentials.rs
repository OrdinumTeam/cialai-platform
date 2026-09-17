// SPDX-License-Identifier: Apache-2.0
//! Credencial do Claude Code, so leitura.
//!
//! O app nunca escreve, nunca renova e nunca copia o token. Onde ela mora
//! muda por sistema:
//!
//! - **macOS**: item do chaveiro do login, lido pelo `security` do sistema e
//!   guardado por alguns minutos, porque cada leitura pode abrir o dialogo do
//!   chaveiro, e um dialogo por minuto seria inaceitavel. O Claude Code grava
//!   um item **novo** a cada rotacao de token, e o "Permitir sempre" do item
//!   velho nao vale para o novo. Por isso a ordem das fontes poe a linha de
//!   comando antes daqui: perguntar ao proprio `claude` evita o dialogo.
//! - **Linux e Windows**: arquivo `<pasta>/.credentials.json`, com o mesmo
//!   objeto `claudeAiOauth`. E um arquivo do proprio usuario, sem dialogo, e
//!   a existencia dele e o que faz uma pasta `~/.claude-<slug>` virar perfil.

use std::path::Path;

use super::{FetchError, now_ms};

/// Arquivo de credencial fora do macOS.
pub const CREDENTIALS_FILE: &str = ".credentials.json";

#[derive(Clone, Debug, PartialEq)]
pub struct Credential {
    pub access_token: String,
    pub expires_at_ms: Option<u64>,
    pub subscription: Option<String>,
}

impl Credential {
    pub fn is_expired(&self) -> bool {
        self.expires_at_ms.is_some_and(|at| at <= now_ms())
    }
}

/// Existe credencial propria para a pasta, sem ler o segredo e sem dialogo.
pub fn exists(dir: &Path, is_default: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        keychain::exists(dir, is_default)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = is_default;
        dir.join(CREDENTIALS_FILE).is_file()
    }
}

/// Credencial do perfil.
pub fn read(profile_id: &str, dir: &Path, is_default: bool) -> Result<Credential, FetchError> {
    #[cfg(target_os = "macos")]
    {
        keychain::read(profile_id, dir, is_default)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (profile_id, is_default);
        read_file(&dir.join(CREDENTIALS_FILE))
    }
}

/// Esquece o que estava guardado de um perfil, para a proxima leitura poder
/// abrir o dialogo de novo. Fora do macOS nao ha cache a esquecer.
pub fn forget(profile_id: &str) {
    #[cfg(target_os = "macos")]
    keychain::forget(profile_id);
    #[cfg(not(target_os = "macos"))]
    let _ = profile_id;
}

/// Arquivo `.credentials.json`: ausente e login; recusado e acesso negado.
pub fn read_file(path: &Path) -> Result<Credential, FetchError> {
    match std::fs::read_to_string(path) {
        Ok(raw) => parse(raw.trim()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            Err(FetchError::AccessDenied)
        }
        Err(_) => Err(FetchError::NeedsAuth),
    }
}

/// Conteudo do item ou do arquivo: `{"claudeAiOauth": {...}}`.
pub fn parse(raw: &str) -> Result<Credential, FetchError> {
    let parsed: serde_json::Value = serde_json::from_str(raw).map_err(|_| FetchError::NeedsAuth)?;
    let node = parsed.get("claudeAiOauth").unwrap_or(&parsed);
    let token = node
        .get("accessToken")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    if token.is_empty() {
        // O Claude Code esvazia o item ao deslogar: o anel diz isso, em vez de
        // pedir login que ja existe.
        return Err(FetchError::SignedOutByOwner);
    }
    Ok(Credential {
        access_token: token.to_string(),
        // O campo vem em milissegundos.
        expires_at_ms: node.get("expiresAt").and_then(|value| value.as_u64()),
        subscription: node
            .get("subscriptionType")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
    })
}

#[cfg(target_os = "macos")]
mod keychain {
    use std::collections::BTreeMap;
    use std::path::Path;
    use std::process::{Command, Stdio};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use crate::notch::profiles::claude_keychain_services;
    use crate::notch::usage::FetchError;
    use crate::platform;

    use super::{Credential, parse};

    const SECURITY: &str = "/usr/bin/security";
    /// Uma leitura boa vale este tempo antes de perguntar de novo.
    const RECHECK: Duration = Duration::from_secs(5 * 60);
    /// Uma falha passageira espera o mesmo tanto.
    const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(5 * 60);

    #[derive(Clone)]
    struct Entry {
        at: Instant,
        value: Result<Credential, FetchError>,
    }

    fn cache() -> &'static Mutex<BTreeMap<String, Entry>> {
        static CACHE: OnceLock<Mutex<BTreeMap<String, Entry>>> = OnceLock::new();
        CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
    }

    pub fn forget(profile_id: &str) {
        if let Ok(mut guard) = cache().lock() {
            guard.retain(|key, _| !key.starts_with(profile_id));
        }
    }

    /// Existe item no chaveiro para esta pasta. So atributos sao consultados,
    /// sem ler o segredo, entao nao abre dialogo.
    pub fn exists(dir: &Path, is_default: bool) -> bool {
        claude_keychain_services(dir, is_default)
            .iter()
            .any(|service| item_exists(service))
    }

    fn item_exists(service: &str) -> bool {
        let mut command = Command::new(SECURITY);
        command
            .args(["find-generic-password", "-s", service])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        platform::configure_background_command(&mut command);
        command.status().is_ok_and(|status| status.success())
    }

    /// Credencial do perfil, tentando cada servico na ordem dada.
    pub fn read(profile_id: &str, dir: &Path, is_default: bool) -> Result<Credential, FetchError> {
        let services = claude_keychain_services(dir, is_default);
        let key = format!("{profile_id}\u{1}{}", services.join(","));
        if let Ok(guard) = cache().lock()
            && let Some(entry) = guard.get(&key)
        {
            let fresh = match &entry.value {
                Ok(_) => entry.at.elapsed() < RECHECK,
                // Recusa do chaveiro e permanente ate o usuario autorizar.
                Err(FetchError::AccessDenied) => true,
                Err(_) => entry.at.elapsed() < RETRY_AFTER_FAILURE,
            };
            if fresh {
                return entry.value.clone();
            }
        }
        let mut outcome = Err(FetchError::NeedsAuth);
        for service in &services {
            outcome = read_service(service);
            if outcome.is_ok() {
                break;
            }
            if matches!(
                outcome,
                Err(FetchError::AccessDenied) | Err(FetchError::SignedOutByOwner)
            ) {
                break;
            }
        }
        if let Ok(mut guard) = cache().lock() {
            guard.insert(
                key,
                Entry {
                    at: Instant::now(),
                    value: outcome.clone(),
                },
            );
        }
        outcome
    }

    fn read_service(service: &str) -> Result<Credential, FetchError> {
        let mut command = Command::new(SECURITY);
        command
            .args(["find-generic-password", "-s", service, "-w"])
            .stdin(Stdio::null());
        platform::configure_background_command(&mut command);
        let output = command
            .output()
            .map_err(|error| FetchError::Io(error.to_string()))?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr);
            // 44 e "item nao encontrado"; 45 e a recusa do usuario no dialogo.
            if message.contains("could not be found") {
                return Err(FetchError::NeedsAuth);
            }
            if message.contains("User interaction is not allowed")
                || message.contains("user canceled")
                || message.contains("denied")
            {
                return Err(FetchError::AccessDenied);
            }
            return Err(FetchError::NeedsAuth);
        }
        let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
        parse(&raw)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_token_and_the_expiry() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"abc","expiresAt":1789000000000,"subscriptionType":"max"}}"#;
        let credential = parse(raw).unwrap();
        assert_eq!(credential.access_token, "abc");
        assert_eq!(credential.expires_at_ms, Some(1_789_000_000_000));
        assert_eq!(credential.subscription.as_deref(), Some("max"));
    }

    #[test]
    fn an_empty_token_means_the_owner_signed_out() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"","expiresAt":1}}"#;
        assert_eq!(parse(raw), Err(FetchError::SignedOutByOwner));
    }

    #[test]
    fn garbage_is_not_a_credential() {
        assert_eq!(parse("nao e json"), Err(FetchError::NeedsAuth));
    }

    #[test]
    fn an_expired_token_is_visible_as_such() {
        let credential = Credential {
            access_token: "a".to_string(),
            expires_at_ms: Some(1),
            subscription: None,
        };
        assert!(credential.is_expired());
        let fresh = Credential {
            access_token: "a".to_string(),
            expires_at_ms: Some(now_ms() + 60_000),
            subscription: None,
        };
        assert!(!fresh.is_expired());
    }

    #[test]
    fn the_credentials_file_is_read_like_the_keychain_item() {
        let dir =
            std::env::temp_dir().join(format!("cialai-notch-credentials-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(CREDENTIALS_FILE);
        assert_eq!(
            read_file(&path),
            Err(FetchError::NeedsAuth),
            "sem arquivo e login"
        );
        std::fs::write(
            &path,
            r#"{"claudeAiOauth":{"accessToken":"abc","expiresAt":1789000000000,"subscriptionType":"pro"}}"#,
        )
        .unwrap();
        let credential = read_file(&path).unwrap();
        assert_eq!(credential.access_token, "abc");
        assert_eq!(credential.subscription.as_deref(), Some("pro"));
        std::fs::write(&path, r#"{"claudeAiOauth":{"accessToken":""}}"#).unwrap();
        assert_eq!(read_file(&path), Err(FetchError::SignedOutByOwner));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
