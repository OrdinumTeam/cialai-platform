// SPDX-License-Identifier: Apache-2.0
//! Lista de projetos a partir das raízes escolhidas nas preferências.

use std::fs;
use std::path::{Component, Path, PathBuf};

use serde::Serialize;

use crate::platform::to_portable;

const DETECTED_ROOTS: &[&str] = &[
    "Projects",
    "Developer",
    "src",
    "dev",
    "code",
    "Github Projects",
];

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

fn configured_path(home: &Path, value: &str) -> Option<PathBuf> {
    let value = value.trim();
    let path = if value == "~" {
        home.to_path_buf()
    } else if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        home.join(rest)
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return None;
    }
    Some(path)
}

pub fn project_roots(home: &Path, configured: &[String]) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for value in configured {
        let Some(path) = configured_path(home, value) else {
            continue;
        };
        if !roots.contains(&path) {
            roots.push(path);
        }
    }
    roots
}

pub fn detected_roots(home: &Path) -> Vec<RepoRoot> {
    DETECTED_ROOTS
        .iter()
        .map(|relative| {
            let path = home.join(relative);
            RepoRoot {
                label: (*relative).into(),
                path: to_portable(&path),
                exists: path.is_dir(),
            }
        })
        .collect()
}

/// Subpastas de primeiro nível de cada raiz configurada, sem ocultas e sem
/// arquivos, ordenadas por nome sem distinguir maiúsculas.
pub fn list(home: &Path, configured: &[String]) -> RepoListing {
    let mut roots = Vec::new();
    let mut repos = Vec::new();
    for path in project_roots(home, configured) {
        let label = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| to_portable(&path));
        let exists = path.is_dir();
        if exists {
            repos.extend(list_root(&path, &label));
        }
        roots.push(RepoRoot {
            label,
            path: to_portable(&path),
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
                path: to_portable(entry.path()),
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
    fn list_uses_only_configured_roots_and_sorts_projects() {
        let home = std::env::temp_dir().join(format!("cialai-repos-test-{}", std::process::id()));
        let root = home.join("code");
        fs::create_dir_all(root.join("zeta")).unwrap();
        fs::create_dir_all(root.join("Alpha")).unwrap();
        fs::create_dir_all(root.join(".hidden")).unwrap();
        fs::write(root.join("README.md"), "x").unwrap();

        let listing = list(&home, &["~/code".into(), "relative/ignored".into()]);

        assert_eq!(listing.roots.len(), 1);
        assert!(listing.roots[0].exists);
        assert_eq!(
            listing
                .repos
                .iter()
                .map(|repo| repo.name.as_str())
                .collect::<Vec<_>>(),
            ["Alpha", "zeta"]
        );
        assert_eq!(listing.repos[0].root, "code");
        fs::remove_dir_all(&home).unwrap();
    }

    #[test]
    fn roots_expand_home_reject_traversal_and_remove_duplicates() {
        // Caminho absoluto exige letra de disco no Windows.
        let (home, absolute) = if cfg!(windows) {
            (r"C:\Users\ana", r"C:\Users\ana\Projects")
        } else {
            ("/Users/ana", "/Users/ana/Projects")
        };
        let roots = project_roots(
            Path::new(home),
            &[
                "~/Projects".into(),
                absolute.into(),
                "../escape".into(),
                "relative".into(),
            ],
        );
        assert_eq!(roots, [PathBuf::from(absolute)]);
    }

    #[test]
    fn onboarding_candidates_follow_the_documented_order() {
        let roots = detected_roots(Path::new("/Users/ana"));
        assert_eq!(roots.len(), 6);
        assert_eq!(roots[0].path, "/Users/ana/Projects");
        assert_eq!(roots[5].label, "Github Projects");
    }
}
