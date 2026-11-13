// SPDX-License-Identifier: Apache-2.0
//! Skill do Cialai para o Claude Code e o Codex, instalada e atualizada sem
//! tela. A versão vem só da release, embutida no app. Editar a skill, pelas
//! Preferências ou direto no arquivo, desliga a atualização automática até a
//! pessoa voltar à versão do Cialai. Arquivo próprio que o Cialai nunca
//! escreveu fica intocado.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
};
const SOURCE: &str = include_str!("../resources/skills/cialai/SKILL.md");
const MARKER: &str = "<!-- cialai-managed-skill v";
const STATE_FILE: &str = "skill.json";
static WRITE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct State {
    /// Texto editado pela pessoa; vazio enquanto vale a versão do Cialai.
    custom: Option<String>,
    /// O que o Cialai gravou por último nos arquivos que ele cuida.
    written: Option<String>,
    /// Agentes cujo arquivo foi gravado pelo Cialai.
    managed: Vec<String>,
    updated_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    pub agent: &'static str,
    pub path: String,
    pub state: &'static str,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillView {
    pub content: String,
    pub edited: bool,
    pub updated_at: Option<String>,
    pub version: &'static str,
    pub agents: Vec<AgentView>,
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
fn managed_marker(body: &str) -> bool {
    body.lines()
        .any(|line| line.starts_with(MARKER) && line.ends_with(" -->"))
}
fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
fn load(dir: &Path) -> State {
    fs::read_to_string(dir.join(STATE_FILE))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}
fn write_atomic(path: &Path, body: &str) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("skill_path")?).map_err(|e| e.to_string())?;
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
        .write_all(body.as_bytes())
        .and_then(|_| file.sync_all())
        .and_then(|_| fs::rename(&temporary, path));
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}
fn save_state(dir: &Path, state: &State) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(state).map_err(|e| e.to_string())?;
    write_atomic(&dir.join(STATE_FILE), &raw)
}

enum Found {
    Absent,
    Missing,
    Ours,
    Edited(String),
    Personal,
}
fn classify(state: &State, agent: &str, path: &Path, present: bool) -> Found {
    let body = match fs::read_to_string(path) {
        Ok(body) => body,
        Err(_) if present => return Found::Missing,
        Err(_) => return Found::Absent,
    };
    let managed = state.managed.iter().any(|name| name == agent);
    match &state.written {
        Some(written) if managed && body == *written => Found::Ours,
        Some(_) if managed => Found::Edited(body),
        // Antes deste registro existir, o Cialai marcava a própria cópia.
        _ if managed_marker(&body) => Found::Ours,
        _ => Found::Personal,
    }
}

/// Instala o que falta, atualiza o que é do Cialai e adota uma edição feita
/// direto no arquivo como a skill da pessoa.
fn sync_locked(home: &Path, dir: &Path, state: &mut State) -> Result<(), String> {
    let mut plan = Vec::new();
    // Dois agentes podem apontar para o mesmo arquivo por um link.
    let mut aliases = Vec::new();
    for (agent, path, present) in targets(home) {
        let resolved = resolved_path(&path);
        if let Some(first) = plan.iter().position(|(_, other, _)| *other == resolved) {
            aliases.push((agent, first));
            continue;
        }
        let found = classify(state, agent, &resolved, present);
        if let Found::Edited(body) = &found {
            let custom = (body != SOURCE).then(|| body.clone());
            if state.custom != custom {
                state.custom = custom;
                state.updated_at = Some(now());
            }
        }
        plan.push((agent, resolved, found));
    }
    let handled: Vec<bool> = plan
        .iter()
        .map(|(_, _, found)| !matches!(found, Found::Absent | Found::Personal))
        .collect();
    let desired = state.custom.clone().unwrap_or_else(|| SOURCE.to_string());
    let mut changed = false;
    for (agent, path, found) in plan {
        let current = match found {
            Found::Absent | Found::Personal => continue,
            Found::Missing => None,
            Found::Ours => fs::read_to_string(&path).ok(),
            Found::Edited(body) => Some(body),
        };
        if current.as_deref() != Some(desired.as_str()) {
            write_atomic(&path, &desired)?;
            changed = true;
        }
        if !state.managed.iter().any(|name| name == agent) {
            state.managed.push(agent.to_string());
        }
    }
    for (agent, first) in aliases {
        if handled[first] && !state.managed.iter().any(|name| name == agent) {
            state.managed.push(agent.to_string());
        }
    }
    if state.written.as_deref() != Some(desired.as_str()) {
        state.written = Some(desired);
        if changed || state.updated_at.is_none() {
            state.updated_at = Some(now());
        }
    }
    save_state(dir, state)
}

pub fn sync(home: &Path, dir: &Path) -> Result<(), String> {
    let _guard = WRITE_LOCK.lock().map_err(|_| "skill_busy")?;
    let mut state = load(dir);
    sync_locked(home, dir, &mut state)
}

pub fn view(home: &Path, dir: &Path) -> Result<SkillView, String> {
    let _guard = WRITE_LOCK.lock().map_err(|_| "skill_busy")?;
    let mut state = load(dir);
    sync_locked(home, dir, &mut state)?;
    let agents = targets(home)
        .into_iter()
        .map(|(agent, path, present)| {
            let state = match classify(&state, agent, &resolved_path(&path), present) {
                Found::Absent => "missing",
                Found::Personal => "kept",
                Found::Missing => "pending",
                Found::Ours | Found::Edited(_) => "installed",
            };
            AgentView {
                agent,
                path: path.to_string_lossy().into_owned(),
                state,
            }
        })
        .collect();
    Ok(SkillView {
        content: state.custom.clone().unwrap_or_else(|| SOURCE.to_string()),
        edited: state.custom.is_some(),
        updated_at: state.updated_at.clone(),
        version: env!("CARGO_PKG_VERSION"),
        agents,
    })
}

/// Grava a skill editada pela pessoa; texto igual ao do Cialai volta ao automático.
pub fn edit(home: &Path, dir: &Path, content: String) -> Result<SkillView, String> {
    {
        let _guard = WRITE_LOCK.lock().map_err(|_| "skill_busy")?;
        let mut state = load(dir);
        let custom = (content != SOURCE).then_some(content);
        if state.custom != custom {
            state.custom = custom;
            state.updated_at = Some(now());
        }
        sync_locked(home, dir, &mut state)?;
    }
    view(home, dir)
}

/// Volta à versão que vem com o Cialai e religa a atualização automática.
pub fn restore(home: &Path, dir: &Path) -> Result<SkillView, String> {
    edit(home, dir, SOURCE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(name: &str) -> (PathBuf, PathBuf) {
        let root =
            std::env::temp_dir().join(format!("cialai-skills-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join(".claude")).unwrap();
        fs::create_dir_all(root.join(".codex")).unwrap();
        let state = root.join("state");
        (root, state)
    }
    fn claude(root: &Path) -> PathBuf {
        root.join(".claude/skills/cialai/SKILL.md")
    }
    fn codex(root: &Path) -> PathBuf {
        root.join(".agents/skills/cialai/SKILL.md")
    }

    #[test]
    fn installs_silently_for_both_agents_and_comes_back_when_deleted() {
        let (root, state) = fixture("install");
        sync(&root, &state).unwrap();
        assert_eq!(fs::read_to_string(claude(&root)).unwrap(), SOURCE);
        assert_eq!(fs::read_to_string(codex(&root)).unwrap(), SOURCE);
        fs::remove_file(claude(&root)).unwrap();
        sync(&root, &state).unwrap();
        assert_eq!(fs::read_to_string(claude(&root)).unwrap(), SOURCE);
        let view = view(&root, &state).unwrap();
        assert!(!view.edited && view.updated_at.is_some());
    }

    #[test]
    fn missing_agent_is_not_created() {
        let (root, state) = fixture("missing");
        fs::remove_dir_all(root.join(".codex")).unwrap();
        if std::env::var_os("CODEX_HOME").is_none() {
            sync(&root, &state).unwrap();
            assert!(!codex(&root).exists());
            assert_eq!(view(&root, &state).unwrap().agents[1].state, "missing");
        }
    }

    #[test]
    fn old_release_copy_is_updated_automatically() {
        let (root, state) = fixture("update");
        fs::create_dir_all(claude(&root).parent().unwrap()).unwrap();
        fs::write(claude(&root), "<!-- cialai-managed-skill v0 -->\nold").unwrap();
        sync(&root, &state).unwrap();
        assert_eq!(fs::read_to_string(claude(&root)).unwrap(), SOURCE);
        // A cópia gravada por uma release anterior também segue a nova.
        let mut saved = load(&state);
        saved.written = Some("release anterior".into());
        save_state(&state, &saved).unwrap();
        fs::write(claude(&root), "release anterior").unwrap();
        fs::write(codex(&root), "release anterior").unwrap();
        sync(&root, &state).unwrap();
        assert_eq!(fs::read_to_string(codex(&root)).unwrap(), SOURCE);
        assert!(!view(&root, &state).unwrap().edited);
    }

    #[test]
    fn editing_on_disk_stops_updates_and_reaches_the_other_agent() {
        let (root, state) = fixture("disk-edit");
        sync(&root, &state).unwrap();
        fs::write(claude(&root), "minha skill").unwrap();
        let view = view(&root, &state).unwrap();
        assert!(view.edited);
        assert_eq!(view.content, "minha skill");
        assert_eq!(fs::read_to_string(codex(&root)).unwrap(), "minha skill");
        sync(&root, &state).unwrap();
        assert_eq!(fs::read_to_string(claude(&root)).unwrap(), "minha skill");
    }

    #[test]
    fn editing_in_preferences_then_restoring() {
        let (root, state) = fixture("prefs-edit");
        let view = edit(&root, &state, "editada no app".into()).unwrap();
        assert!(view.edited);
        assert_eq!(fs::read_to_string(claude(&root)).unwrap(), "editada no app");
        assert_eq!(fs::read_to_string(codex(&root)).unwrap(), "editada no app");
        let view = restore(&root, &state).unwrap();
        assert!(!view.edited);
        assert_eq!(fs::read_to_string(claude(&root)).unwrap(), SOURCE);
    }

    #[test]
    fn personal_file_never_written_by_cialai_is_kept() {
        let (root, state) = fixture("personal");
        fs::create_dir_all(codex(&root).parent().unwrap()).unwrap();
        fs::write(codex(&root), "skill pessoal").unwrap();
        sync(&root, &state).unwrap();
        edit(&root, &state, "editada no app".into()).unwrap();
        assert_eq!(fs::read_to_string(codex(&root)).unwrap(), "skill pessoal");
        assert_eq!(fs::read_to_string(claude(&root)).unwrap(), "editada no app");
        assert_eq!(view(&root, &state).unwrap().agents[1].state, "kept");
    }

    #[cfg(unix)]
    #[test]
    fn shared_alias_is_written_once() {
        let (root, state) = fixture("alias");
        fs::create_dir_all(root.join(".agents/skills")).unwrap();
        std::os::unix::fs::symlink(root.join(".agents/skills"), root.join(".claude/skills"))
            .unwrap();
        sync(&root, &state).unwrap();
        assert_eq!(fs::read_to_string(codex(&root)).unwrap(), SOURCE);
        edit(&root, &state, "editada no app".into()).unwrap();
        let view = view(&root, &state).unwrap();
        assert!(view.agents.iter().all(|agent| agent.state == "installed"));
        assert_eq!(fs::read_to_string(codex(&root)).unwrap(), "editada no app");
    }
}
