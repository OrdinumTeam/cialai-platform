// SPDX-License-Identifier: Apache-2.0

use std::fs;
use std::path::{Path, PathBuf};

#[cfg(any(target_os = "linux", test))]
use std::fs::OpenOptions;
#[cfg(any(target_os = "linux", test))]
use std::io::Write;

use serde::Serialize;

const SERVICE: &str = "br.com.ordinum.cialai";
const ACCOUNT: &str = "headscale-api-key";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub present: bool,
    pub fallback: bool,
    pub prefix: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ApiKeyStore {
    fallback_path: PathBuf,
}

impl ApiKeyStore {
    pub fn new(fallback_path: PathBuf) -> Self {
        Self { fallback_path }
    }

    fn entry(&self) -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT)
            .map_err(|error| format!("armazenamento seguro indisponível: {error}"))
    }

    pub fn store(&self, secret: &str) -> Result<bool, String> {
        if secret.trim().is_empty() {
            return Err("a chave da API está vazia".into());
        }
        match self.entry().and_then(|entry| {
            entry
                .set_password(secret)
                .map_err(|error| format!("não foi possível guardar a chave da API: {error}"))
        }) {
            Ok(()) => {
                let _ = delete_private(&self.fallback_path);
                Ok(false)
            }
            Err(error) => self.store_fallback(secret, error),
        }
    }

    pub fn load(&self) -> Result<(Option<String>, bool), String> {
        match self.entry().and_then(|entry| match entry.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("não foi possível ler a chave da API: {error}")),
        }) {
            Ok(Some(secret)) => Ok((Some(secret), false)),
            Ok(None) => self.load_fallback(),
            Err(error) => self.load_fallback_or_error(error),
        }
    }

    pub fn status(&self) -> Result<SecretStatus, String> {
        let (secret, fallback) = self.load()?;
        Ok(SecretStatus {
            present: secret.is_some(),
            fallback,
            prefix: secret.as_deref().map(api_key_prefix),
        })
    }

    pub fn delete(&self) -> Result<(), String> {
        let platform = match self.entry() {
            Ok(entry) => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(format!("não foi possível apagar a chave da API: {error}")),
            },
            Err(error) => Err(error),
        };
        let fallback = delete_private(&self.fallback_path);
        if cfg!(target_os = "linux") {
            fallback.or(platform)
        } else {
            platform
        }
    }

    #[cfg(target_os = "linux")]
    fn store_fallback(&self, secret: &str, _platform_error: String) -> Result<bool, String> {
        write_private(&self.fallback_path, secret)?;
        Ok(true)
    }

    #[cfg(not(target_os = "linux"))]
    fn store_fallback(&self, _secret: &str, platform_error: String) -> Result<bool, String> {
        Err(platform_error)
    }

    #[cfg(target_os = "linux")]
    fn load_fallback(&self) -> Result<(Option<String>, bool), String> {
        read_private(&self.fallback_path).map(|secret| (secret, true))
    }

    #[cfg(not(target_os = "linux"))]
    fn load_fallback(&self) -> Result<(Option<String>, bool), String> {
        Ok((None, false))
    }

    #[cfg(target_os = "linux")]
    fn load_fallback_or_error(
        &self,
        _platform_error: String,
    ) -> Result<(Option<String>, bool), String> {
        self.load_fallback()
    }

    #[cfg(not(target_os = "linux"))]
    fn load_fallback_or_error(
        &self,
        platform_error: String,
    ) -> Result<(Option<String>, bool), String> {
        Err(platform_error)
    }
}

/// Public prefix of a Headscale 0.29 key shaped
/// `hskey-api-{12 character prefix}-{secret}`. The base64url prefix may itself
/// contain `-`, so the fixed length wins over the first separator.
pub fn api_key_prefix(secret: &str) -> String {
    const MARKER: &str = "hskey-api-";
    const PREFIX_LENGTH: usize = 12;
    let remainder = secret.strip_prefix(MARKER).unwrap_or(secret);
    let fixed = remainder.is_char_boundary(PREFIX_LENGTH)
        && remainder.len() > PREFIX_LENGTH
        && remainder.as_bytes()[PREFIX_LENGTH] == b'-';
    let prefix = if fixed {
        remainder[..PREFIX_LENGTH].to_owned()
    } else {
        remainder
            .split_once('-')
            .map(|(prefix, _)| prefix.to_owned())
            .unwrap_or_else(|| remainder.chars().take(PREFIX_LENGTH).collect())
    };
    format!("{MARKER}{prefix}")
}

fn inspect_regular(path: &Path) -> Result<Option<std::fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err("o arquivo alternativo da chave precisa ser regular".into())
        }
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "não foi possível conferir a chave alternativa: {error}"
        )),
    }
}

#[cfg(any(target_os = "linux", test))]
fn read_private(path: &Path) -> Result<Option<String>, String> {
    if inspect_regular(path)?.is_none() {
        return Ok(None);
    }
    let secret = fs::read_to_string(path)
        .map_err(|error| format!("não foi possível ler a chave alternativa: {error}"))?;
    if secret.is_empty() {
        Ok(None)
    } else {
        Ok(Some(secret))
    }
}

#[cfg(any(target_os = "linux", test))]
fn write_private(path: &Path, secret: &str) -> Result<(), String> {
    if secret.is_empty() {
        return Err("a chave alternativa está vazia".into());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "a chave alternativa não tem diretório".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("não foi possível criar o diretório da chave: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("não foi possível proteger o diretório da chave: {error}"))?;
    }
    let _ = inspect_regular(path)?;
    let mut random = [0_u8; 16];
    getrandom::fill(&mut random).map_err(|error| format!("aleatoriedade indisponível: {error}"))?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let temporary = parent.join(format!(".{ACCOUNT}-{suffix}"));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("não foi possível criar a chave alternativa: {error}"))?;
    let result = (|| {
        file.write_all(secret.as_bytes())?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)?;
        Ok::<(), std::io::Error>(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "não foi possível guardar a chave alternativa: {error}"
        ));
    }
    Ok(())
}

fn delete_private(path: &Path) -> Result<(), String> {
    if inspect_regular(path)?.is_none() {
        return Ok(());
    }
    fs::remove_file(path)
        .map_err(|error| format!("não foi possível apagar a chave alternativa: {error}"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn api_key_prefix_keeps_dashes_inside_the_fixed_length_prefix() {
        let secret = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
        assert_eq!(
            api_key_prefix(&format!("hskey-api-FYQT-7gktHAV-{secret}")),
            "hskey-api-FYQT-7gktHAV"
        );
        assert_eq!(
            api_key_prefix(&format!("hskey-api-7Y-BtzrE7y8c-{secret}")),
            "hskey-api-7Y-BtzrE7y8c"
        );
        assert_eq!(
            api_key_prefix(&format!("hskey-api-_KcCpQuLBJCa-{secret}")),
            "hskey-api-_KcCpQuLBJCa"
        );
        assert_eq!(api_key_prefix("hskey-api-test-secret"), "hskey-api-test");
    }

    #[test]
    fn private_fallback_round_trip_never_exposes_the_secret_in_metadata() {
        let root = std::env::temp_dir().join(format!(
            "cialai-keyring-fallback-{}-{}",
            std::process::id(),
            std::thread::current()
                .name()
                .unwrap_or("test")
                .replace("::", "-")
        ));
        let path = root.join("headscale-api-key");
        let _ = fs::remove_dir_all(&root);
        write_private(&path, "hskey-api-test-secret").unwrap();
        assert_eq!(
            read_private(&path).unwrap().as_deref(),
            Some("hskey-api-test-secret")
        );
        let status = SecretStatus {
            present: true,
            fallback: true,
            prefix: Some(api_key_prefix("hskey-api-test-secret")),
        };
        let encoded = serde_json::to_string(&status).unwrap();
        assert!(!encoded.contains("test-secret"));
        delete_private(&path).unwrap();
        assert_eq!(read_private(&path).unwrap(), None);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn private_fallback_has_owner_only_permissions_and_rejects_symlink_reads() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!("cialai-key-mode-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let path = root.join("api-key");
        write_private(&path, "secret").unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let target = root.join("target");
        fs::write(&target, "do-not-read").unwrap();
        fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(read_private(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
