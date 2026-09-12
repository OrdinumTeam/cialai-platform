// SPDX-License-Identifier: Apache-2.0
//! Lista de repositorios para o seletor rapido de pastas da secao Terminais.

use std::fs;
use std::path::Path;

use serde::Serialize;

use super::REPO_ROOTS_FROM_HOME;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRoot {
    pub label: String,
    pub path: String,
    pub exists: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoDir {
    pub name: String,
    pub path: String,
    pub root: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoListing {
    pub roots: Vec<RepoRoot>,
    pub repos: Vec<RepoDir>,
}

/// Subpastas de primeiro nivel de cada raiz, sem ocultas e sem arquivos,
/// ordenadas por nome sem distinguir maiusculas.
pub fn list(home: &Path) -> RepoListing {
    let mut roots = Vec::new();
    let mut repos = Vec::new();
    for relative in REPO_ROOTS_FROM_HOME {
        let path = home.join(relative);
        let label = Path::new(relative)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| relative.to_string());
        let exists = path.is_dir();
        if exists {
            repos.extend(list_root(&path, &label));
        }
        roots.push(RepoRoot {
            label,
            path: path.to_string_lossy().to_string(),
            exists,
        });
    }
    RepoListing { roots, repos }
}

fn list_root(root: &Path, label: &str) -> Vec<RepoDir> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut repos: Vec<RepoDir> = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            Some(RepoDir {
                path: entry.path().to_string_lossy().to_string(),
                name,
                root: label.to_string(),
            })
        })
        .collect();
    repos.sort_by_key(|repo| repo.name.to_lowercase());
    repos
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_ignores_files_and_hidden_dirs_and_sorts() {
        let home = std::env::temp_dir().join(format!("oc-repos-test-{}", std::process::id()));
        let root = home.join(REPO_ROOTS_FROM_HOME[0]);
        fs::create_dir_all(root.join("zeta")).unwrap();
        fs::create_dir_all(root.join("Alpha")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("README.md"), "x").unwrap();

        let listing = list(&home);

        assert_eq!(listing.roots.len(), REPO_ROOTS_FROM_HOME.len());
        assert!(listing.roots[0].exists);
        assert!(!listing.roots[1].exists);
        let names: Vec<&str> = listing
            .repos
            .iter()
            .map(|repo| repo.name.as_str())
            .collect();
        assert_eq!(names, vec!["Alpha", "zeta"]);
        assert_eq!(listing.repos[0].root, "Projects");

        fs::remove_dir_all(&home).unwrap();
    }
}
