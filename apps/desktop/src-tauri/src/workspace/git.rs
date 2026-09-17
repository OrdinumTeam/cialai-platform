// SPDX-License-Identifier: Apache-2.0
//! Estado Git de um projeto para os indicadores do estudio: branch, avanço
//! em relação ao remoto e os arquivos alterados, lidos de
//! `git status --porcelain=v2 --branch -z`. O diff de um arquivo vem de
//! `git diff HEAD -- caminho`, ou contra `/dev/null` quando o arquivo ainda
//! nao esta no indice. Tudo por processo `git`, sem biblioteca.

use std::path::Path;
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::i18n::{t, tf};
use crate::platform::{self, child_env};

/// Teto de entradas alteradas devolvidas; acima disso a lista vem cortada.
const CHANGES_LIMIT: usize = 3_000;
/// Teto do diff devolvido ao webview.
const DIFF_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Copied,
    Typechange,
    Untracked,
    Conflict,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    /// Caminho relativo a raiz do repositorio.
    pub path: String,
    pub status: ChangeStatus,
    pub staged: bool,
    pub worktree: bool,
    pub original: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub detached: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub changes: Vec<GitChange>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub path: String,
    pub diff: String,
    pub truncated: bool,
    pub untracked: bool,
}

fn git() -> Command {
    let mut command = Command::new("git");
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    // O git por HTTPS carrega libcurl, que quebra com o LD_LIBRARY_PATH do AppImage.
    child_env::sanitize(&mut command);
    // Em release no Windows o app e subsistema GUI, sem console: um `git.exe`
    // criado sem CREATE_NO_WINDOW abre uma janela de console a cada consulta.
    platform::configure_background_command(&mut command);
    command
}

fn run(args: &[&str], dir: &Path) -> Result<(Vec<u8>, i32), String> {
    let output = git()
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|error| tf("native.error.gitUnavailable", &[("error", &error)]))?;
    Ok((output.stdout, output.status.code().unwrap_or(-1)))
}

/// Raiz do repositorio que contem `dir`, ou `None` fora de um repositorio.
pub fn root_of(dir: &Path) -> Option<String> {
    let (stdout, code) = run(&["rev-parse", "--show-toplevel"], dir).ok()?;
    if code != 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&stdout).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

pub fn status(dir: &str) -> Result<GitStatus, String> {
    let path = Path::new(dir);
    if !path.is_dir() {
        return Err(t("native.error.folderNotFound"));
    }
    let Some(root) = root_of(path) else {
        return Ok(GitStatus::default());
    };
    let (stdout, code) = run(
        &["status", "--porcelain=v2", "--branch", "-z"],
        Path::new(&root),
    )?;
    if code != 0 {
        return Ok(GitStatus {
            is_repo: true,
            root: Some(root),
            ..GitStatus::default()
        });
    }
    let mut result = parse_status(&stdout);
    result.is_repo = true;
    result.root = Some(root);
    Ok(result)
}

fn status_of(code: u8) -> Option<ChangeStatus> {
    Some(match code {
        b'M' => ChangeStatus::Modified,
        b'A' => ChangeStatus::Added,
        b'D' => ChangeStatus::Deleted,
        b'R' => ChangeStatus::Renamed,
        b'C' => ChangeStatus::Copied,
        b'T' => ChangeStatus::Typechange,
        b'U' => ChangeStatus::Conflict,
        _ => return None,
    })
}

/// Formato v2 com `-z`: registros separados por NUL; os renomeados trazem o
/// caminho original num registro extra logo depois.
pub fn parse_status(raw: &[u8]) -> GitStatus {
    let mut result = GitStatus::default();
    let records: Vec<&[u8]> = raw.split(|byte| *byte == 0).collect();
    let mut index = 0usize;
    while index < records.len() {
        let record = records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(record);
        if let Some(rest) = text.strip_prefix("# ") {
            if let Some(head) = rest.strip_prefix("branch.head ") {
                if head == "(detached)" {
                    result.detached = true;
                } else {
                    result.branch = Some(head.to_string());
                }
            } else if let Some(upstream) = rest.strip_prefix("branch.upstream ") {
                result.upstream = Some(upstream.to_string());
            } else if let Some(ab) = rest.strip_prefix("branch.ab ") {
                for part in ab.split_whitespace() {
                    if let Some(value) = part.strip_prefix('+') {
                        result.ahead = value.parse().unwrap_or(0);
                    } else if let Some(value) = part.strip_prefix('-') {
                        result.behind = value.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        if result.changes.len() >= CHANGES_LIMIT {
            result.truncated = true;
            break;
        }
        let mut fields = text.splitn(2, ' ');
        let kind = fields.next().unwrap_or("");
        let rest = fields.next().unwrap_or("");
        match kind {
            "?" => result.changes.push(GitChange {
                path: rest.to_string(),
                status: ChangeStatus::Untracked,
                staged: false,
                worktree: true,
                original: None,
            }),
            "1" | "2" | "u" => {
                let parts: Vec<&str> = rest.split(' ').collect();
                let Some(xy) = parts.first() else { continue };
                let xy = xy.as_bytes();
                if xy.len() < 2 {
                    continue;
                }
                let (x, y) = (xy[0], xy[1]);
                // Campos fixos antes do caminho: 7 no registro comum, 8 no
                // renomeado, que traz a pontuacao, e 9 no conflito, com tres
                // modos e tres hashes. O original do renomeado vem no registro
                // seguinte.
                let path_index = match kind {
                    "1" => 7,
                    "2" => 8,
                    _ => 9,
                };
                let path = parts
                    .get(path_index..)
                    .map(|slice| slice.join(" "))
                    .unwrap_or_default();
                if path.is_empty() {
                    continue;
                }
                let original = if kind == "2" && index < records.len() {
                    let value = String::from_utf8_lossy(records[index]).to_string();
                    index += 1;
                    Some(value)
                } else {
                    None
                };
                let status = if kind == "u" {
                    ChangeStatus::Conflict
                } else if y != b'.' {
                    status_of(y).unwrap_or(ChangeStatus::Modified)
                } else {
                    status_of(x).unwrap_or(ChangeStatus::Modified)
                };
                result.changes.push(GitChange {
                    path,
                    status,
                    staged: x != b'.',
                    worktree: y != b'.',
                    original,
                });
            }
            _ => {}
        }
    }
    result
}

/// Diff de um arquivo contra o HEAD. Arquivo novo: contra `/dev/null`.
pub fn diff(root: &str, path: &str) -> Result<GitDiff, String> {
    let base = Path::new(root);
    if !base.is_dir() {
        return Err(t("native.error.folderNotFound"));
    }
    let relative = Path::new(path)
        .strip_prefix(base)
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|_| path.to_string());
    let (tracked_out, tracked_code) = run(&["ls-files", "--error-unmatch", "--", &relative], base)?;
    let tracked = tracked_code == 0 && !tracked_out.is_empty();
    let (stdout, _) = if tracked {
        run(&["diff", "--no-color", "HEAD", "--", &relative], base)?
    } else {
        run(
            &[
                "diff",
                "--no-color",
                "--no-index",
                "--",
                "/dev/null",
                &relative,
            ],
            base,
        )?
    };
    let truncated = stdout.len() > DIFF_LIMIT;
    let slice = if truncated {
        &stdout[..DIFF_LIMIT]
    } else {
        &stdout[..]
    };
    Ok(GitDiff {
        path: relative,
        diff: String::from_utf8_lossy(slice).to_string(),
        truncated,
        untracked: !tracked,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_and_changes() {
        let raw = b"# branch.oid abc\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +2 -1\0\
1 .M N... 100644 100644 100644 aaaa bbbb src/app.js\0\
1 A. N... 000000 100644 100644 0000 cccc novo com espaco.txt\0\
2 R. N... 100644 100644 100644 dddd eeee R100 novo.md\0velho.md\0\
u UU N... 100644 100644 100644 100644 h1 h2 h3 conflito.txt\0\
? rascunho/\0";
        let status = parse_status(raw);
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        assert_eq!(status.changes.len(), 5);
        assert_eq!(status.changes[0].path, "src/app.js");
        assert_eq!(status.changes[0].status, ChangeStatus::Modified);
        assert!(status.changes[0].worktree && !status.changes[0].staged);
        assert_eq!(status.changes[1].path, "novo com espaco.txt");
        assert_eq!(status.changes[1].status, ChangeStatus::Added);
        assert!(status.changes[1].staged);
        assert_eq!(status.changes[2].status, ChangeStatus::Renamed);
        assert_eq!(status.changes[2].original.as_deref(), Some("velho.md"));
        assert_eq!(status.changes[3].status, ChangeStatus::Conflict);
        assert_eq!(status.changes[4].status, ChangeStatus::Untracked);
        assert_eq!(status.changes[4].path, "rascunho/");
    }

    #[test]
    fn detached_head() {
        let status = parse_status(b"# branch.oid abc\0# branch.head (detached)\0");
        assert!(status.detached);
        assert!(status.branch.is_none());
    }

    /// No Unix o helper deixa `pgroup` no comando, prova de que passou por
    /// `configure_background_command`, a mesma chamada que no Windows poe
    /// `CREATE_NO_WINDOW`. O std nao expoe as flags de criacao do Windows, por
    /// isso la a garantia fica com `tools/check/desktop-background-commands.mjs`.
    #[cfg(unix)]
    #[test]
    fn git_helper_is_configured_as_a_background_command() {
        let described = format!("{:#?}", git());
        assert!(described.contains("pgroup: Some("), "{described}");
    }

    #[test]
    fn outside_a_repo_is_not_a_repo() {
        let dir = std::env::temp_dir().join(format!("oc-git-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let status = status(&dir.to_string_lossy()).unwrap();
        assert!(!status.is_repo);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
