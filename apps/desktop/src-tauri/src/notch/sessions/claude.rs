// SPDX-License-Identifier: Apache-2.0
//! Sessoes do Claude Code, lidas dos arquivos que ele mesmo grava.
//!
//! Duas fontes, e a escolha entre elas nao e preferencia, e capacidade:
//!
//! - O **registro** `<perfil>/sessions/<pid>.json` traz `status` quando a
//!   sessao roda no terminal. So ele sabe dizer "parei para perguntar",
//!   porque o pedido de permissao nao deixa rastro no transcript.
//! - O **transcript** `<perfil>/projects/<slug>/<sessao>.jsonl` cobre as
//!   sessoes do app Desktop, que nao gravam `status`. Ele distingue apenas
//!   trabalhando de parado; nunca afirma que a sessao espera voce.
//!
//! O transcript so e consultado quando o registro nao disse nada que se
//! entenda. Ler os dois e deixar o transcript vencer apagaria justamente o
//! unico sinal de espera que existe.

use std::collections::BTreeMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::{AgentSession, SessionState, is_alive};

/// Cauda lida do transcript. A decisao esta sempre nas ultimas linhas.
const TAIL_BYTES: u64 = 64 * 1024;

/* ── registro da sessao ────────────────────────────────────────────── */

// Os leitores puros do registro moram em `workspace::agent_state`, para o
// estudio ler o mesmo estado sem passar pela Barra de IA.
pub use crate::workspace::agent_state::{SessionRecord, folder_of, parse_proc_start, parse_record};

/* ── transcript ────────────────────────────────────────────────────── */

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Turn {
    /// Um turno esta correndo.
    InFlight,
    /// O ultimo turno fechou.
    Finished,
}

/// Le o fim do transcript de tras para frente.
///
/// So `assistant` e `user` decidem. O Claude Code continua anexando linhas de
/// servico, como `system`, `cost-state`, `last-prompt` e `attachment`,
/// enquanto a sessao esta parada; por isso "arquivo tocado agora" nao serve
/// de sinal, e a lista de tipos que decidem e fechada em vez de ser uma lista
/// do que ignorar.
pub fn turn_in(tail: &str) -> Option<Turn> {
    for line in tail.lines().rev() {
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        // Subagente nao fala pela sessao.
        if parsed
            .get("isSidechain")
            .and_then(|value| value.as_bool())
            .unwrap_or(false)
        {
            continue;
        }
        match parsed.get("type").and_then(|value| value.as_str()) {
            Some("assistant") => {
                let stop = parsed
                    .pointer("/message/stop_reason")
                    .and_then(|value| value.as_str());
                return Some(if stop == Some("tool_use") {
                    Turn::InFlight
                } else {
                    Turn::Finished
                });
            }
            Some("user") => {
                return Some(if is_interruption(&parsed) {
                    Turn::Finished
                } else {
                    Turn::InFlight
                });
            }
            _ => continue,
        }
    }
    None
}

/// Uma interrupcao encerra o turno, mesmo vindo como mensagem do usuario.
fn is_interruption(parsed: &serde_json::Value) -> bool {
    const PREFIX: &str = "[Request interrupted by user";
    let Some(content) = parsed.pointer("/message/content") else {
        return false;
    };
    if let Some(text) = content.as_str() {
        return text.starts_with(PREFIX);
    }
    content.as_array().is_some_and(|blocks| {
        blocks.iter().any(|block| {
            block
                .get("text")
                .and_then(|value| value.as_str())
                .is_some_and(|text| text.starts_with(PREFIX))
        })
    })
}

/// Pasta do transcript de um diretorio de trabalho: `/` e `.` viram `-`.
pub fn project_slug(cwd: &str) -> String {
    cwd.chars()
        .map(|value| {
            if value == '/' || value == '.' {
                '-'
            } else {
                value
            }
        })
        .collect()
}

#[derive(Default)]
struct Cached {
    modified: u64,
    size: u64,
    turn: Option<Turn>,
}

/// Le transcripts com cache, uma instancia por perfil.
#[derive(Default)]
pub struct TranscriptReader {
    seen: Mutex<BTreeMap<String, Cached>>,
    entered: Mutex<BTreeMap<String, (Turn, u64)>>,
    scanned: Mutex<BTreeMap<String, Option<PathBuf>>>,
}

impl TranscriptReader {
    /// Estado do turno e o instante em que ele mudou.
    pub fn activity(
        &self,
        projects: &Path,
        session_id: &str,
        cwd: &str,
        now_ms: u64,
    ) -> Option<(Turn, u64)> {
        let path = self.locate(projects, session_id, cwd)?;
        let meta = std::fs::metadata(&path).ok()?;
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|value| value.as_millis() as u64)
            .unwrap_or(0);
        let size = meta.len();

        let cached = {
            let guard = self.seen.lock().ok()?;
            guard
                .get(session_id)
                .map(|entry| (entry.modified, entry.size, entry.turn))
        };
        let turn = match cached {
            // Nada mudou no arquivo: nao ha o que reler.
            Some((last_modified, last_size, turn))
                if last_modified == modified && last_size == size =>
            {
                turn
            }
            _ => {
                let turn = read_tail(&path).and_then(|tail| turn_in(&tail));
                if let Ok(mut guard) = self.seen.lock() {
                    guard.insert(
                        session_id.to_string(),
                        Cached {
                            modified,
                            size,
                            turn,
                        },
                    );
                }
                turn
            }
        };
        let turn = turn?;

        // A data do arquivo anda a cada linha de servico; o carimbo so avanca
        // quando o estado de fato muda.
        let mut guard = self.entered.lock().ok()?;
        let entry = guard
            .entry(session_id.to_string())
            .or_insert((turn, now_ms));
        if entry.0 != turn {
            *entry = (turn, now_ms);
        }
        Some(*entry)
    }

    /// Caminho do transcript. Uma sessao retomada em outra pasta mantem o
    /// arquivo onde nasceu, entao a varredura existe; ela roda uma vez por
    /// sessao.
    fn locate(&self, projects: &Path, session_id: &str, cwd: &str) -> Option<PathBuf> {
        let direct = projects
            .join(project_slug(cwd))
            .join(format!("{session_id}.jsonl"));
        if direct.is_file() {
            return Some(direct);
        }
        if let Ok(guard) = self.scanned.lock()
            && let Some(found) = guard.get(session_id)
        {
            return found.clone();
        }
        let mut found = None;
        if let Ok(read) = std::fs::read_dir(projects) {
            for item in read.flatten() {
                let candidate = item.path().join(format!("{session_id}.jsonl"));
                if candidate.is_file() {
                    found = Some(candidate);
                    break;
                }
            }
        }
        if let Ok(mut guard) = self.scanned.lock() {
            guard.insert(session_id.to_string(), found.clone());
        }
        found
    }

    pub fn forget(&self, keep: &[String]) {
        if let Ok(mut guard) = self.seen.lock() {
            guard.retain(|key, _| keep.contains(key));
        }
        if let Ok(mut guard) = self.entered.lock() {
            guard.retain(|key, _| keep.contains(key));
        }
        if let Ok(mut guard) = self.scanned.lock() {
            guard.retain(|key, _| keep.contains(key));
        }
    }
}

/// Ultimos 64 KiB do arquivo. A primeira linha sai cortada e falha no parse,
/// o que e o tratamento esperado.
fn read_tail(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(TAIL_BYTES)))
        .ok()?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    Some(String::from_utf8_lossy(&buffer).to_string())
}

/* ── varredura de um perfil ────────────────────────────────────────── */

/// Sessoes vivas de um perfil.
pub fn scan(
    profile_id: &str,
    config_dir: &Path,
    reader: &TranscriptReader,
    terminals: &[(String, u32)],
    now_ms: u64,
) -> Vec<AgentSession> {
    let sessions_dir = config_dir.join("sessions");
    let projects_dir = config_dir.join("projects");
    let Ok(read) = std::fs::read_dir(&sessions_dir) else {
        return Vec::new();
    };

    let mut records: Vec<SessionRecord> = Vec::new();
    for item in read.flatten() {
        let path = item.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Some(record) = parse_record(&raw) else {
            continue;
        };
        // Arquivo deixado por uma sessao que caiu nao vira anel ocupado.
        if !is_alive(record.pid, record.started_at_ms) {
            continue;
        }
        records.push(record);
    }
    let records = deduplicate(records);
    let ids: Vec<String> = records
        .iter()
        .filter_map(|record| record.session_id.clone())
        .collect();
    reader.forget(&ids);

    let mut sessions: Vec<AgentSession> = records
        .into_iter()
        .map(|record| {
            let (state, since_ms, waiting_for) = resolve(&record, &projects_dir, reader, now_ms);
            AgentSession {
                id: format!("{profile_id}.{}", record.pid),
                profile_id: profile_id.to_string(),
                name: record.name.clone(),
                detail: record.surface.to_string(),
                state,
                waiting_for,
                since_ms,
                pid: Some(record.pid),
                pty_tag: super::pty_tag_for(record.pid, terminals),
                cwd: Some(record.cwd),
            }
        })
        .collect();
    super::sort_for_display(&mut sessions);
    sessions
}

/// Quem manda no estado: o registro, quando ele disse algo; o transcript, so
/// quando ele nao disse.
fn resolve(
    record: &SessionRecord,
    projects: &Path,
    reader: &TranscriptReader,
    now_ms: u64,
) -> (SessionState, u64, Option<String>) {
    if record.reports_status {
        return (record.state, record.since_ms, record.waiting_for.clone());
    }
    let Some(session_id) = record.session_id.as_deref() else {
        return (record.state, record.since_ms, None);
    };
    let Some((turn, since)) = reader.activity(projects, session_id, &record.cwd, now_ms) else {
        return (record.state, record.since_ms, None);
    };
    // O transcript nunca afirma espera: nao ha registro de pedido de
    // permissao nele.
    let state = if turn == Turn::InFlight {
        SessionState::Busy
    } else {
        SessionState::Idle
    };
    (state, since, None)
}

/// Ao retomar depois de uma queda, dois registros apontam para a mesma
/// sessao por um instante. Fica o mais novo.
fn deduplicate(records: Vec<SessionRecord>) -> Vec<SessionRecord> {
    let mut best: BTreeMap<String, SessionRecord> = BTreeMap::new();
    let mut loose: Vec<SessionRecord> = Vec::new();
    for record in records {
        match record.session_id.clone() {
            Some(id) => match best.get(&id) {
                Some(previous) if previous.started_at_ms >= record.started_at_ms => {}
                _ => {
                    best.insert(id, record);
                }
            },
            None => loose.push(record),
        }
    }
    let mut all: Vec<SessionRecord> = best.into_values().collect();
    all.extend(loose);
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    const TERMINAL: &str = r#"{"pid":2678,"sessionId":"c85d4247","cwd":"/Users/vinz/usage-notch","startedAt":1787894126697,"procStart":"Fri Aug 28 05:15:20 2026","kind":"interactive","entrypoint":"cli","name":"usage-notch-bc","status":"busy","statusUpdatedAt":1787897225305,"peerFeatures":["notify_idle"],"algoNovo":42}"#;
    const DESKTOP: &str = r#"{"pid":900,"sessionId":"d1","cwd":"/Users/vinz/projeto","startedAt":1787894126697,"entrypoint":"claude-desktop","messagingSocketPath":"/tmp/x.sock"}"#;

    #[test]
    fn reads_a_terminal_record() {
        let record = parse_record(TERMINAL).unwrap();
        assert_eq!(record.pid, 2678);
        assert_eq!(record.state, SessionState::Busy);
        assert!(record.reports_status);
        assert_eq!(record.surface, "terminal");
        assert_eq!(record.name, "usage-notch-bc");
        assert_eq!(record.since_ms, 1787897225305);
    }

    #[test]
    fn an_unknown_field_does_not_drop_the_session() {
        assert!(parse_record(TERMINAL).is_some());
    }

    #[test]
    fn a_desktop_record_reports_no_status() {
        let record = parse_record(DESKTOP).unwrap();
        assert!(!record.reports_status);
        assert_eq!(record.surface, "desktop");
        assert_eq!(record.name, "projeto");
    }

    #[test]
    fn tempo_wins_over_status() {
        let raw =
            r#"{"pid":1,"cwd":"/a","status":"busy","tempo":"blocked","waitingFor":"permission"}"#;
        let record = parse_record(raw).unwrap();
        assert_eq!(record.state, SessionState::Waiting);
        assert_eq!(record.waiting_for.as_deref(), Some("permission"));
    }

    #[test]
    fn an_unknown_status_leaves_the_decision_to_the_transcript() {
        let raw = r#"{"pid":1,"cwd":"/a","status":"hibernating"}"#;
        let record = parse_record(raw).unwrap();
        assert_eq!(record.state, SessionState::Idle);
        assert!(!record.reports_status);
    }

    #[test]
    fn proc_start_is_read_as_utc() {
        // Medido no Control: o registro grava 17:38:53 UTC para um processo
        // iniciado as 14:38:53 em Sao Paulo.
        let parsed = parse_proc_start("Wed Sep 16 17:38:53 2026").unwrap();
        assert_eq!(parsed, 1_789_580_333_000);
    }

    #[test]
    fn a_day_padded_with_two_spaces_still_parses() {
        assert!(parse_proc_start("Sat Aug  8 05:15:20 2026").is_some());
    }

    #[test]
    fn the_epoch_field_wins_over_proc_start() {
        let record = parse_record(TERMINAL).unwrap();
        assert_eq!(record.started_at_ms, Some(1787894126697));
    }

    #[test]
    fn the_folder_name_accepts_both_separators() {
        assert_eq!(folder_of("/Users/x/projeto"), "projeto");
        assert_eq!(folder_of("C:\\Users\\x\\projeto\\"), "projeto");
    }

    #[test]
    fn a_tool_use_stop_means_the_turn_is_running() {
        let tail = r#"{"type":"assistant","message":{"stop_reason":"tool_use"}}"#;
        assert_eq!(turn_in(tail), Some(Turn::InFlight));
    }

    #[test]
    fn an_end_turn_stop_means_the_turn_closed() {
        for stop in ["end_turn", "stop_sequence", "max_tokens"] {
            let tail = format!(r#"{{"type":"assistant","message":{{"stop_reason":"{stop}"}}}}"#);
            assert_eq!(turn_in(&tail), Some(Turn::Finished), "{stop}");
        }
    }

    #[test]
    fn a_user_line_means_the_turn_is_running() {
        let tail = r#"{"type":"user","message":{"content":"faz isso"}}"#;
        assert_eq!(turn_in(tail), Some(Turn::InFlight));
    }

    #[test]
    fn an_interruption_closes_the_turn() {
        for text in [
            "[Request interrupted by user]",
            "[Request interrupted by user for tool use]",
        ] {
            let tail = format!(r#"{{"type":"user","message":{{"content":"{text}"}}}}"#);
            assert_eq!(turn_in(&tail), Some(Turn::Finished), "{text}");
        }
        let blocks = r#"{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}"#;
        assert_eq!(turn_in(blocks), Some(Turn::Finished));
    }

    #[test]
    fn bookkeeping_lines_never_decide() {
        // Tipos vistos numa cauda real com a sessao parada.
        let tail = "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"end_turn\"}}\n{\"type\":\"system\",\"subtype\":\"stop_hook_summary\"}\n{\"type\":\"last-prompt\"}\n{\"type\":\"cost-state\"}\n{\"type\":\"attachment\"}";
        assert_eq!(
            turn_in(tail),
            Some(Turn::Finished),
            "as linhas de servico nao reabrem o turno"
        );
    }

    #[test]
    fn a_subagent_line_does_not_speak_for_the_session() {
        let tail = "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"end_turn\"}}\n{\"type\":\"assistant\",\"isSidechain\":true,\"message\":{\"stop_reason\":\"tool_use\"}}";
        assert_eq!(turn_in(tail), Some(Turn::Finished));
    }

    #[test]
    fn a_half_line_at_the_start_is_ignored() {
        let tail = "{\"type\":\"assis\n{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\"}}";
        assert_eq!(turn_in(tail), Some(Turn::InFlight));
    }

    #[test]
    fn a_transcript_with_no_conversation_has_no_opinion() {
        assert_eq!(turn_in("{\"type\":\"system\"}"), None);
        assert_eq!(turn_in(""), None);
    }

    #[test]
    fn the_project_slug_flattens_slashes_and_dots() {
        assert_eq!(project_slug("/Users/x/app"), "-Users-x-app");
        assert_eq!(
            project_slug("/Users/x/app/.claude/worktrees/y"),
            "-Users-x-app--claude-worktrees-y"
        );
    }

    #[test]
    fn the_newest_record_wins_for_the_same_session() {
        let older =
            parse_record(r#"{"pid":1,"cwd":"/a","sessionId":"s","startedAt":100}"#).unwrap();
        let newer =
            parse_record(r#"{"pid":2,"cwd":"/a","sessionId":"s","startedAt":200}"#).unwrap();
        let kept = deduplicate(vec![older, newer]);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].pid, 2);
    }

    #[test]
    fn records_without_a_session_id_are_all_kept() {
        let a = parse_record(r#"{"pid":1,"cwd":"/a"}"#).unwrap();
        let b = parse_record(r#"{"pid":2,"cwd":"/b"}"#).unwrap();
        assert_eq!(deduplicate(vec![a, b]).len(), 2);
    }

    /// O transcript e relido so quando o arquivo muda, e o carimbo so anda
    /// quando o estado muda: linhas de servico nao renascem a animacao.
    #[test]
    fn the_transcript_reader_caches_by_mtime_and_keeps_the_entry_stamp() {
        let dir =
            std::env::temp_dir().join(format!("cialai-notch-transcript-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let projects = dir.join("projects");
        let folder = projects.join(project_slug("/Users/x/app"));
        std::fs::create_dir_all(&folder).unwrap();
        let path = folder.join("s1.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"assistant\",\"message\":{\"stop_reason\":\"tool_use\"}}\n",
        )
        .unwrap();
        let reader = TranscriptReader::default();
        assert_eq!(
            reader.activity(&projects, "s1", "/Users/x/app", 1000),
            Some((Turn::InFlight, 1000))
        );
        // Mesmo arquivo, relogio adiante: o carimbo fica.
        assert_eq!(
            reader.activity(&projects, "s1", "/Users/x/app", 2000),
            Some((Turn::InFlight, 1000))
        );
        // Sessao retomada em outra pasta: a varredura acha o arquivo.
        assert!(
            reader
                .activity(&projects, "s1", "/Users/x/outra", 3000)
                .is_some()
        );
        // Esquecer as sessoes vivas limpa o que sobrou.
        reader.forget(&[]);
        assert!(reader.seen.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A varredura de um perfil num HOME temporario: o registro do proprio
    /// processo de teste passa por vivo, um pid inexistente nao.
    #[test]
    fn scanning_a_profile_keeps_only_live_records() {
        super::super::refresh_process_table();
        let dir = std::env::temp_dir().join(format!("cialai-notch-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let sessions = dir.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let me = std::process::id();
        std::fs::write(
            sessions.join(format!("{me}.json")),
            format!(r#"{{"pid":{me},"cwd":"/Users/x/app","status":"waiting","waitingFor":"permission","name":"app"}}"#),
        )
        .unwrap();
        std::fs::write(
            sessions.join("4294967294.json"),
            r#"{"pid":4294967294,"cwd":"/Users/x/morta","status":"busy"}"#,
        )
        .unwrap();
        let reader = TranscriptReader::default();
        let found = scan(
            "claude-work",
            &dir,
            &reader,
            &[("sessao-1".to_string(), me)],
            5,
        );
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].id, format!("claude-work.{me}"));
        assert_eq!(found[0].state, SessionState::Waiting);
        assert_eq!(found[0].waiting_for.as_deref(), Some("permission"));
        assert_eq!(found[0].detail, "terminal");
        assert_eq!(found[0].pty_tag.as_deref(), Some("sessao-1"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
