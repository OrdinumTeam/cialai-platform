// SPDX-License-Identifier: Apache-2.0
//! Sessoes do Codex, lidas do arquivo de rollout que ele grava enquanto
//! trabalha.
//!
//! O Codex nao publica estado em lugar nenhum: o que existe e o proprio
//! arquivo da sessao, que recebe eventos `event_msg` a cada passo. Dai sai
//! apenas "trabalhando" e "terminou". Ele **nunca** aparece como aguardando,
//! porque nao ha evento que diga isso.
//!
//! A leitura erra para o lado curto de proposito. Um arquivo parado ha mais
//! de oito segundos deixa de contar como sessao viva e o anel volta ao
//! repouso, em vez de fingir que a sessao continua. Inatividade nao prova
//! conclusao, e um comando longo tambem fica quieto: por isso o silencio some
//! da tela em vez de virar "terminou".

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use super::{AgentSession, SessionState};

/// Cauda lida do arquivo de sessao.
const TAIL_BYTES: u64 = 256 * 1024;
/// Acima disto sem escrever, a sessao sai da lista.
pub const STALE_MS: u64 = 8_000;
/// Pastas de dia visitadas.
const RECENT_DAYS: usize = 3;
/// Codigo de onde a sessao roda, para o detalhe do card.
const SURFACE: &str = "rollout";

/// Sessao viva do perfil, se houver. No maximo uma por perfil: o Codex grava
/// um arquivo por conversa e so a mais recente esta em curso.
pub fn scan(
    profile_id: &str,
    config_dir: &Path,
    display_name: &str,
    now_ms: u64,
) -> Vec<AgentSession> {
    let Some((path, modified)) = newest_rollout(config_dir) else {
        return Vec::new();
    };
    if now_ms.saturating_sub(modified) > STALE_MS {
        return Vec::new();
    }
    let state = state_of(&path).unwrap_or(SessionState::Busy);
    let file_name = path
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_else(|| "rollout".to_string());
    vec![AgentSession {
        id: format!("{profile_id}.{file_name}"),
        profile_id: profile_id.to_string(),
        name: display_name.to_string(),
        detail: SURFACE.to_string(),
        state,
        waiting_for: None,
        since_ms: modified,
        // O Codex nao publica pid: nao da para trazer a janela dele para a
        // frente.
        pid: None,
        cwd: None,
        pty_tag: None,
    }]
}

/// Ultimo evento que diz alguma coisa sobre o turno.
///
/// `item_completed` nao conta: subitens tambem o emitem no meio do trabalho.
pub fn state_of(path: &Path) -> Option<SessionState> {
    let tail = read_tail(path)?;
    state_in(&tail)
}

pub fn state_in(tail: &str) -> Option<SessionState> {
    let mut found: Option<SessionState> = None;
    for line in tail.lines() {
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if parsed.get("type").and_then(|value| value.as_str()) != Some("event_msg") {
            continue;
        }
        match parsed
            .pointer("/payload/type")
            .and_then(|value| value.as_str())
        {
            Some("task_started") => found = Some(SessionState::Busy),
            Some("task_complete") => found = Some(SessionState::Success),
            // Turno abortado nao e conclusao, e tambem nao e trabalho: a
            // sessao sai da lista quando o arquivo esfriar.
            Some("turn_aborted") => found = None,
            _ => continue,
        }
    }
    found
}

fn newest_rollout(config_dir: &Path) -> Option<(PathBuf, u64)> {
    let sessions = config_dir.join("sessions");
    if !sessions.is_dir() {
        return None;
    }
    let mut newest: Option<(u64, PathBuf)> = None;
    for day in recent_days(&sessions) {
        let Ok(read) = std::fs::read_dir(&day) else {
            continue;
        };
        for item in read.flatten() {
            let path = item.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }
            let modified = item
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|value| value.as_millis() as u64)
                .unwrap_or(0);
            if newest.as_ref().is_none_or(|(time, _)| modified > *time) {
                newest = Some((modified, path));
            }
        }
    }
    newest.map(|(modified, path)| (path, modified))
}

fn recent_days(sessions: &Path) -> Vec<PathBuf> {
    fn children(dir: &Path) -> Vec<PathBuf> {
        let Ok(read) = std::fs::read_dir(dir) else {
            return Vec::new();
        };
        let mut found: Vec<PathBuf> = read
            .flatten()
            .filter(|item| item.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
            .map(|item| item.path())
            .collect();
        found.sort();
        found.reverse();
        found
    }
    let mut days = Vec::new();
    for year in children(sessions).into_iter().take(2) {
        for month in children(&year).into_iter().take(2) {
            for day in children(&month) {
                days.push(day);
                if days.len() >= RECENT_DAYS {
                    return days;
                }
            }
        }
    }
    days
}

fn read_tail(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    Some(String::from_utf8_lossy(&buffer).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_started_task_is_work_in_progress() {
        let tail = r#"{"type":"event_msg","payload":{"type":"task_started"}}"#;
        assert_eq!(state_in(tail), Some(SessionState::Busy));
    }

    #[test]
    fn the_last_relevant_event_wins() {
        let tail = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_complete\"}}";
        assert_eq!(state_in(tail), Some(SessionState::Success));
    }

    #[test]
    fn sub_items_do_not_end_the_turn() {
        let tail = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"item_completed\"}}";
        assert_eq!(state_in(tail), Some(SessionState::Busy));
    }

    #[test]
    fn an_aborted_turn_leaves_no_state() {
        let tail = "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"turn_aborted\"}}";
        assert_eq!(state_in(tail), None);
    }

    #[test]
    fn other_line_types_are_ignored() {
        let tail = "{\"type\":\"response_item\",\"payload\":{\"type\":\"task_complete\"}}";
        assert_eq!(state_in(tail), None);
    }

    #[test]
    fn a_quiet_file_leaves_the_list_instead_of_claiming_it_finished() {
        let dir =
            std::env::temp_dir().join(format!("cialai-notch-codex-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let day = dir.join("sessions/2026/09/16");
        std::fs::create_dir_all(&day).unwrap();
        std::fs::write(
            day.join("rollout-2026-09-16-abc.jsonl"),
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
        )
        .unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let live = scan("codex-amorim", &dir, "amorim", now);
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].state, SessionState::Busy);
        assert_eq!(live[0].profile_id, "codex-amorim");
        assert_eq!(live[0].name, "amorim");
        assert_eq!(live[0].detail, "rollout");
        assert!(live[0].pid.is_none());

        let later = scan("codex-amorim", &dir, "amorim", now + STALE_MS + 1);
        assert!(later.is_empty(), "silencio tira a sessao da lista");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_profile_without_sessions_has_nothing_to_show() {
        let dir =
            std::env::temp_dir().join(format!("cialai-notch-codex-none-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(scan("codex", &dir, "codex", 0).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
