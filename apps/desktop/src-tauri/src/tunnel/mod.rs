// SPDX-License-Identifier: Apache-2.0
//! Contratos compartilhados com o futuro supervisor do sidecar.

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime};

mod awake;
mod credentials;
mod protocol;
mod supervisor;

pub use awake::Awake;
pub use credentials::SecretStatus;
pub use protocol::RpcProblem;
pub use supervisor::{BridgeSession, Supervisor};

const MOBILE_RESOURCE_DIR: &str = "mobile";
const MOBILE_ENTRY: &str = "mobile.html";
const TOR_RESOURCE_DIR: &str = "tor";

#[derive(Clone, Debug)]
pub struct MobileSite {
    static_dir: PathBuf,
}

impl MobileSite {
    pub fn resolve<R: Runtime>(app: &AppHandle<R>) -> Result<Self, String> {
        mobile_static_dir(app).map(|static_dir| Self { static_dir })
    }

    pub fn static_dir(&self) -> &Path {
        &self.static_dir
    }
}

/// Resolve o diretório estático que será enviado como `staticDir` em
/// `edge.serve`. O supervisor ainda não existe, mas recebe daqui um caminho
/// absoluto e já validado, sem tentar ler o `frontendDist` embutido.
pub fn mobile_static_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| format!("diretório de recursos indisponível: {error}"))?;
    validate_mobile_static_dir(&resources)
}

/// Caminho do `tor` que `tools/fetch-tor.mjs --stage` coloca em `$RESOURCE/tor`,
/// com o layout do Tor Expert Bundle: `tor/tor` ao lado das bibliotecas e de
/// `data/geoip`. O supervisor passa esse caminho ao sidecar em `--tor-bin` sem
/// exigir o arquivo: um build sem Tor continua abrindo o túnel, e o `doctor`
/// e o `tor.StartDesktop` do sidecar conferem o executável.
pub fn bundled_tor_executable(resources: &Path) -> PathBuf {
    let name = if cfg!(windows) { "tor.exe" } else { "tor" };
    resources.join(TOR_RESOURCE_DIR).join("tor").join(name)
}

fn validate_mobile_static_dir(resources: &Path) -> Result<PathBuf, String> {
    let directory = resources.join(MOBILE_RESOURCE_DIR);
    if !directory.join(MOBILE_ENTRY).is_file() {
        return Err("bundle da página do celular não encontrado".into());
    }
    directory
        .canonicalize()
        .map_err(|error| format!("bundle da página do celular inválido: {error}"))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn mobile_bundle_path_is_absolute_and_requires_the_entry() {
        let root = std::env::temp_dir().join(format!(
            "cialai-mobile-resource-{}-{}",
            std::process::id(),
            std::thread::current()
                .name()
                .unwrap_or("test")
                .replace("::", "-")
        ));
        let mobile = root.join(MOBILE_RESOURCE_DIR);
        fs::create_dir_all(&mobile).unwrap();
        assert!(validate_mobile_static_dir(&root).is_err());
        fs::write(mobile.join(MOBILE_ENTRY), "<!doctype html>").unwrap();
        let resolved = validate_mobile_static_dir(&root).unwrap();
        assert!(resolved.is_absolute());
        assert_eq!(
            resolved.file_name().and_then(|name| name.to_str()),
            Some("mobile")
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bundled_tor_keeps_the_expert_bundle_layout_inside_resources() {
        let resources = PathBuf::from("/Applications/Cialai.app/Contents/Resources");
        let expected = if cfg!(windows) { "tor.exe" } else { "tor" };
        assert_eq!(
            bundled_tor_executable(&resources),
            resources.join("tor").join("tor").join(expected)
        );
    }

    #[test]
    fn mobile_site_exposes_the_validated_static_directory() {
        let expected = PathBuf::from("/tmp/cialai-mobile");
        let site = MobileSite {
            static_dir: expected.clone(),
        };
        assert_eq!(site.static_dir(), expected);
    }
}
