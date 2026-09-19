// SPDX-License-Identifier: Apache-2.0
//! Navegacao de pastas para o seletor de nova sessao.
//!
//! O seletor mostrava so as subpastas de primeiro nivel de cada raiz de
//! projeto. Com a raiz apontando para Documentos, nao havia como abrir uma
//! sessao na propria Documentos nem subir um nivel. Aqui a interface pede uma
//! pasta e recebe o caminho normalizado, o pai quando ele e permitido e as
//! subpastas.
//!
//! O que sai daqui e **nome de pasta**, nunca conteudo de arquivo. O celular ja
//! pode abrir um shell em qualquer pasta por `pty_spawn`, entao listar nomes
//! nao amplia o que ele alcanca; o limite existe para nao transformar o
//! seletor num explorador do disco inteiro.
//!
//! Limites: a arvore da pasta pessoal, as raizes de projeto configuradas e,
//! no macOS, `/Volumes`. No Windows, as unidades. Pasta oculta, nome com cara
//! de segredo e link simbolico ficam de fora, pela mesma regra de
//! [`super::mobile_files`].

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::platform::to_portable;

/// Teto de subpastas devolvidas numa pasta so.
pub const LIMIT: usize = 200;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// Caminho normalizado da pasta pedida, vazio na lista de pontos de
    /// partida.
    pub path: String,
    /// Pasta acima, quando ela continua dentro dos limites.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    pub entries: Vec<DirEntry>,
    /// A pasta tem mais subpastas do que o teto.
    pub truncated: bool,
}

fn denied() -> String {
    crate::i18n::t("native.error.mobileFileDenied")
}

/// Nome que nao entra na listagem: oculto, com cara de segredo ou reservado do
/// sistema. A regra e a mesma de `mobile_files::secret`, aplicada a pastas.
pub fn hidden_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with('.')
        || lower.contains("credential")
        || lower.contains("secret")
        || lower.contains("token")
        || lower.contains("private_key")
        || lower.contains("private-key")
        || lower == "$recycle.bin"
        || lower == "system volume information"
}

/// Pontos de partida da navegacao. Sao tambem os limites: nada fora da arvore
/// de um deles e listado.
pub fn starting_points(home: &Path, project_roots: &[PathBuf]) -> Vec<PathBuf> {
    let mut points: Vec<PathBuf> = vec![home.to_path_buf()];
    for root in project_roots {
        if !points.contains(root) {
            points.push(root.clone());
        }
    }
    for extra in platform_points() {
        if !points.contains(&extra) {
            points.push(extra);
        }
    }
    points
}

#[cfg(target_os = "macos")]
fn platform_points() -> Vec<PathBuf> {
    vec![PathBuf::from("/Volumes")]
}

/// No Windows os pontos de partida incluem as unidades montadas.
#[cfg(target_os = "windows")]
fn platform_points() -> Vec<PathBuf> {
    ('A'..='Z')
        .map(|letter| PathBuf::from(format!("{letter}:\\")))
        .filter(|drive| drive.is_dir())
        .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_points() -> Vec<PathBuf> {
    ["/media", "/mnt"]
        .iter()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .collect()
}

/// Nenhum componente do caminho pode ser `..`, e ele precisa ser absoluto.
fn plain_absolute(path: &Path) -> bool {
    path.is_absolute()
        && path
            .components()
            .all(|component| !matches!(component, Component::ParentDir | Component::CurDir))
}

fn within(path: &Path, points: &[PathBuf]) -> bool {
    points
        .iter()
        .any(|point| path == point.as_path() || path.starts_with(point))
}

/// Pasta acima, quando ela continua dentro dos limites. A raiz de um ponto de
/// partida nao tem pai: subir dali sairia do que foi autorizado.
fn parent_within(path: &Path, points: &[PathBuf]) -> Option<PathBuf> {
    if points.iter().any(|point| path == point.as_path()) {
        return None;
    }
    let parent = path.parent()?;
    within(parent, points).then(|| parent.to_path_buf())
}

/// Lista as subpastas de `target`, ou os pontos de partida quando ele e
/// `None`.
pub fn list(
    home: &Path,
    project_roots: &[PathBuf],
    target: Option<&str>,
) -> Result<DirListing, String> {
    let points = starting_points(home, project_roots);
    let Some(target) = target.filter(|value| !value.is_empty()) else {
        let entries = points
            .iter()
            .filter(|path| path.is_dir())
            .map(|path| DirEntry {
                name: label_of(path),
                path: to_portable(path),
            })
            .collect();
        return Ok(DirListing {
            path: String::new(),
            parent: None,
            entries,
            truncated: false,
        });
    };
    if target.len() > 4096 || target.contains('\0') {
        return Err(denied());
    }
    let asked = PathBuf::from(target);
    if !plain_absolute(&asked) {
        return Err(denied());
    }
    // `dunce` evita o prefixo estendido do Windows no caminho devolvido.
    let resolved = dunce::canonicalize(&asked).map_err(|_| denied())?;
    if !resolved.is_dir() || !within(&resolved, &points) {
        return Err(denied());
    }
    // Link simbolico nao entra: a canonicalizacao acima ja o teria levado para
    // fora dos limites, e aqui a recusa fica explicita.
    if fs::symlink_metadata(&asked)
        .map(|meta| meta.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(denied());
    }

    let mut entries = Vec::new();
    let mut truncated = false;
    if let Ok(read) = fs::read_dir(&resolved) {
        for item in read.flatten() {
            let Ok(kind) = item.file_type() else { continue };
            if kind.is_symlink() || !kind.is_dir() {
                continue;
            }
            let name = item.file_name().to_string_lossy().to_string();
            if hidden_name(&name) {
                continue;
            }
            if entries.len() >= LIMIT {
                truncated = true;
                break;
            }
            entries.push(DirEntry {
                path: to_portable(item.path()),
                name,
            });
        }
    }
    entries.sort_by_key(|entry| entry.name.to_lowercase());

    Ok(DirListing {
        path: to_portable(&resolved),
        parent: parent_within(&resolved, &points).map(|path| to_portable(&path)),
        entries,
        truncated,
    })
}

fn label_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| to_portable(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cialai-dirs-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(&dir).unwrap()
    }

    #[test]
    fn a_folder_lists_its_subfolders_the_parent_and_nothing_else() {
        let home = scratch("home");
        fs::create_dir_all(home.join("Documentos/projeto")).unwrap();
        fs::create_dir_all(home.join("Documentos/.oculta")).unwrap();
        fs::create_dir_all(home.join("Documentos/minhas-credentials")).unwrap();
        fs::write(home.join("Documentos/arquivo.txt"), "x").unwrap();

        let listing = list(&home, &[], Some(&to_portable(home.join("Documentos")))).unwrap();
        assert_eq!(
            listing.entries,
            vec![DirEntry {
                name: "projeto".into(),
                path: to_portable(home.join("Documentos/projeto")),
            }],
            "so subpastas visiveis, sem arquivo, sem oculta e sem nome de segredo"
        );
        assert_eq!(listing.parent.as_deref(), Some(to_portable(&home).as_str()));
        assert_eq!(listing.path, to_portable(home.join("Documentos")));
        assert!(!listing.truncated);

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_starting_points_have_no_parent_and_nothing_climbs_above_them() {
        let home = scratch("limites");
        let roots = vec![home.join("projetos")];
        fs::create_dir_all(home.join("projetos")).unwrap();

        let at_home = list(&home, &roots, Some(&to_portable(&home))).unwrap();
        assert_eq!(at_home.parent, None, "a pasta pessoal e um limite");

        let above = home.parent().unwrap().to_path_buf();
        assert!(
            list(&home, &roots, Some(&to_portable(&above))).is_err(),
            "acima do limite e recusado"
        );

        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn dot_dot_a_relative_path_and_a_file_are_all_refused() {
        let home = scratch("recusa");
        fs::create_dir_all(home.join("projeto")).unwrap();
        fs::write(home.join("nota.txt"), "x").unwrap();

        let with_dots = format!("{}/projeto/../projeto", to_portable(&home));
        assert!(list(&home, &[], Some(&with_dots)).is_err(), "`..` recusado");
        assert!(
            list(&home, &[], Some("projeto")).is_err(),
            "relativo recusado"
        );
        assert!(
            list(&home, &[], Some(&to_portable(home.join("nota.txt")))).is_err(),
            "arquivo nao e pasta"
        );
        assert!(list(&home, &[], Some(&to_portable(home.join("nao-existe")))).is_err());

        let _ = fs::remove_dir_all(home);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_never_becomes_a_way_out() {
        let home = scratch("link");
        fs::create_dir_all(home.join("dentro")).unwrap();
        let outside = scratch("fora");
        std::os::unix::fs::symlink(&outside, home.join("dentro/atalho")).unwrap();

        let listing = list(&home, &[], Some(&to_portable(home.join("dentro")))).unwrap();
        assert!(listing.entries.is_empty(), "o link nao aparece na listagem");
        assert!(
            list(&home, &[], Some(&to_portable(home.join("dentro/atalho")))).is_err(),
            "e nem pode ser navegado"
        );

        let _ = fs::remove_dir_all(home);
        let _ = fs::remove_dir_all(outside);
    }

    #[test]
    fn without_a_path_the_listing_is_the_set_of_starting_points() {
        let home = scratch("partida");
        let root = home.join("trabalho");
        fs::create_dir_all(&root).unwrap();
        let listing = list(&home, std::slice::from_ref(&root), None).unwrap();
        assert_eq!(listing.path, "");
        assert_eq!(listing.parent, None);
        assert!(
            listing
                .entries
                .iter()
                .any(|entry| entry.path == to_portable(&home))
        );
        assert!(
            listing
                .entries
                .iter()
                .any(|entry| entry.path == to_portable(&root))
        );
        let _ = fs::remove_dir_all(home);
    }

    /// No Windows a raiz de uma unidade e um ponto de partida e, como tal, nao
    /// tem pai: subir dali levaria a lista de unidades, que e a propria
    /// chamada sem caminho.
    #[cfg(windows)]
    #[test]
    fn a_windows_drive_root_is_a_starting_point_without_a_parent() {
        let home = scratch("unidade");
        let points = starting_points(&home, &[]);
        let drive = PathBuf::from("C:\\");
        assert!(
            points.contains(&drive),
            "a unidade do sistema e um ponto de partida"
        );
        assert_eq!(parent_within(&drive, &points), None);
        assert!(within(&PathBuf::from("C:\\Users"), &points));
        let _ = fs::remove_dir_all(home);
    }
}
