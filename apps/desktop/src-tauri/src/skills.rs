// SPDX-License-Identifier: Apache-2.0
//! Explicit opt-in installation. Only marked copies are refreshed on startup.
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
const SOURCE: &str = include_str!("../resources/skills/cialai/SKILL.md");
const MARKER: &str = "<!-- cialai-managed-skill v";
static WRITE_LOCK: Mutex<()> = Mutex::new(());
#[derive(Serialize)]
pub struct SkillStatus {
    pub agent: &'static str,
    pub state: &'static str,
    pub shared: bool,
}
fn targets(home: &Path) -> [(&'static str, PathBuf, bool); 2] {
    [
        (
            "claude",
            home.join(".claude/skills/cialai/SKILL.md"),
            home.join(".claude").is_dir(),
        ),
        (
            "codex",
            home.join(".agents/skills/cialai/SKILL.md"),
            home.join(".codex").is_dir() || std::env::var_os("CODEX_HOME").is_some(),
        ),
    ]
}
// Resolve aliases even before cialai/SKILL.md exists, without changing them.
fn resolved_path(path: &Path) -> PathBuf {
    if let Ok(path) = fs::canonicalize(path) {
        return path;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => resolved_path(parent).join(name),
        _ => path.to_path_buf(),
    }
}
fn shared_target(home: &Path, agent: &str, path: &Path) -> bool {
    let resolved = resolved_path(path);
    targets(home)
        .iter()
        .any(|(other, path, _)| *other != agent && resolved_path(path) == resolved)
}
fn managed(body: &str) -> bool {
    body.lines()
        .any(|line| line.starts_with(MARKER) && line.ends_with(" -->"))
}
pub fn status(home: &Path) -> Vec<SkillStatus> {
    targets(home)
        .into_iter()
        .map(|(agent, path, found)| {
            let shared = shared_target(home, agent, &path);
            let state = match fs::read_to_string(path) {
                Ok(body) if body == SOURCE => "installed",
                Ok(body) if managed(&body) => "outdated",
                Ok(_) => "kept",
                Err(_) if found => "available",
                Err(_) => "missing",
            };
            SkillStatus {
                agent,
                state,
                shared,
            }
        })
        .collect()
}
pub fn change(home: &Path, agent: &str, remove: bool) -> Result<Vec<SkillStatus>, String> {
    change_with_shared(home, agent, remove, false)
}
pub fn change_with_shared(
    home: &Path,
    agent: &str,
    remove: bool,
    remove_shared: bool,
) -> Result<Vec<SkillStatus>, String> {
    let _guard = WRITE_LOCK.lock().map_err(|_| "skill_busy")?;
    let (_, path, found) = targets(home)
        .into_iter()
        .find(|(name, _, _)| *name == agent)
        .ok_or("skill_unknown_agent")?;
    let shared = shared_target(home, agent, &path);
    if remove && shared && !remove_shared {
        return Err("skill_shared_removal_requires_explicit_intent".into());
    }
    let path = if shared { resolved_path(&path) } else { path };
    let old = match fs::read_to_string(&path) {
        Ok(body) => Some(body),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    if old.as_deref().is_some_and(|body| !managed(body)) {
        return Err("skill_unmanaged".into());
    }
    if !remove && !found {
        return Err("skill_agent_missing".into());
    }
    if let Some(body) = old.as_deref() {
        if !remove && body == SOURCE {
            return Ok(status(home));
        }
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        fs::write(path.with_extension(format!("md.bak-{stamp}")), body)
            .map_err(|e| e.to_string())?;
    }
    if remove {
        if old.is_some() {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    } else {
        fs::create_dir_all(path.parent().ok_or("skill_path")?).map_err(|e| e.to_string())?;
        use std::io::Write;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let temporary = path.with_extension(format!("tmp-{}-{stamp}", std::process::id()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|e| e.to_string())?;
        let result = file
            .write_all(SOURCE.as_bytes())
            .and_then(|_| file.sync_all())
            .and_then(|_| fs::rename(&temporary, &path));
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(error.to_string());
        }
    }
    Ok(status(home))
}
pub fn refresh(home: &Path) {
    for item in status(home) {
        if item.state == "outdated" {
            let _ = change(home, item.agent, false);
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn shared_alias_removal_requires_explicit_shared_intent() {
        let root =
            std::env::temp_dir().join(format!("cialai-shared-skills-{}", std::process::id()));
        fs::create_dir_all(root.join(".claude")).unwrap();
        fs::create_dir_all(root.join(".codex")).unwrap();
        fs::create_dir_all(root.join(".agents/skills")).unwrap();
        let alias = root.join(".claude/skills");
        if !alias.exists() {
            std::os::unix::fs::symlink(root.join(".agents/skills"), &alias).unwrap();
        }
        change(&root, "claude", false).unwrap();
        assert!(
            change(&root, "claude", true).is_err(),
            "ordinary removal must preserve another agent's shared source"
        );
        assert!(root.join(".agents/skills/cialai/SKILL.md").exists());
        assert!(
            fs::symlink_metadata(alias)
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }
    #[test]
    fn explicit_install_update_remove_preserves_unmanaged_content() {
        let root = std::env::temp_dir().join(format!("cialai-skills-{}", std::process::id()));
        fs::create_dir_all(root.join(".claude")).unwrap();
        let path = root.join(".claude/skills/cialai/SKILL.md");
        let _ = fs::remove_file(&path);
        refresh(&root);
        assert!(!path.exists());
        change(&root, "claude", false).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), SOURCE);
        fs::write(&path, "<!-- cialai-managed-skill v0 -->\nold").unwrap();
        refresh(&root);
        assert_eq!(fs::read_to_string(&path).unwrap(), SOURCE);
        assert!(
            fs::read_dir(path.parent().unwrap())
                .unwrap()
                .flatten()
                .any(|e| e.file_name().to_string_lossy().contains("bak-"))
        );
        change(&root, "claude", true).unwrap();
        refresh(&root);
        assert!(!path.exists());
        fs::write(&path, "personal skill").unwrap();
        assert!(change(&root, "claude", false).is_err());
        assert!(change(&root, "claude", true).is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "personal skill");
    }
}
