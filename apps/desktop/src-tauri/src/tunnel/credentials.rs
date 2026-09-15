// SPDX-License-Identifier: Apache-2.0
//! Limpeza da chave da API do Headscale guardada por versões anteriores.
//!
//! A conectividade v2 não usa servidor de controle, então nada é gravado
//! aqui. O diagnóstico avançado oferece apagar a chave antiga do cofre do
//! sistema e do arquivo alternativo do Linux.

use std::fs;
use std::path::{Path, PathBuf};

const SERVICE: &str = "br.com.ordinum.cialai";
const ACCOUNT: &str = "headscale-api-key";

#[derive(Clone, Debug)]
pub struct ApiKeyStore {
    fallback_path: PathBuf,
}

impl ApiKeyStore {
    pub fn new(fallback_path: PathBuf) -> Self {
        Self { fallback_path }
    }

    /// Apaga a chave antiga do cofre e o arquivo alternativo. A ausência de
    /// qualquer um dos dois não é erro.
    pub fn delete(&self) -> Result<(), String> {
        let platform = match keyring::Entry::new(SERVICE, ACCOUNT)
            .map_err(|error| format!("armazenamento seguro indisponível: {error}"))
        {
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
}

fn inspect_regular(path: &Path) -> Result<Option<fs::Metadata>, String> {
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

    fn root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("cialai-key-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn legacy_fallback_file_is_deleted_and_absence_is_not_an_error() {
        let root = root("delete");
        let path = root.join(ACCOUNT);
        fs::write(&path, "hskey-api-legacy-secret").unwrap();
        delete_private(&path).unwrap();
        assert!(!path.exists());
        delete_private(&path).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn legacy_cleanup_refuses_to_follow_a_symlink() {
        let root = root("symlink");
        let target = root.join("target");
        fs::write(&target, "do-not-delete").unwrap();
        let path = root.join(ACCOUNT);
        std::os::unix::fs::symlink(&target, &path).unwrap();
        assert!(delete_private(&path).is_err());
        assert!(target.exists());
        fs::remove_dir_all(root).unwrap();
    }
}
