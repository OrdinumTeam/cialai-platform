// SPDX-License-Identifier: Apache-2.0
//! Estado do turno de um agente, lido dos arquivos que o proprio agente
//! grava. Leitores puros, sem estado e sem toque no processo.
//!
//! Duas fontes, cada uma com o que sabe dizer:
//!
//! - **Claude Code** grava `<perfil>/sessions/<pid>.json` com `status` e
//!   `tempo`. E a unica fonte que sabe dizer "parei para perguntar", porque o
//!   pedido de permissao nao deixa rastro no transcript.
//! - **Codex** so tem o proprio arquivo de rollout, que recebe `event_msg` a
//!   cada passo. Dai sai trabalhando e terminou, nunca aguardando.
//!
//! Regra que vale para as duas: **nada e inferido por silencio**. Um agente
//! quieto pode estar rodando um comando longo. A Barra de IA em
//! [`crate::notch::sessions`] e o estudio em
//! [`crate::workspace::terminal`] leem daqui, para os dois dizerem a mesma
//! coisa sobre a mesma sessao.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::{Deserialize, Serialize};

/// Cauda lida do rollout do Codex.
pub const CODEX_TAIL_BYTES: u64 = 256 * 1024;
/// Cauda lida do transcript do Claude Code.
pub const CLAUDE_TAIL_BYTES: u64 = 64 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    /// Trabalhando agora.
    Busy,
    /// Parou para perguntar alguma coisa.
    Waiting,
    /// Terminou o turno.
    Success,
    /// Aberta e parada.
    Idle,
}

impl SessionState {
    /// Ordem de exibicao: quem precisa de voce primeiro.
    pub fn rank(self) -> u8 {
        match self {
            SessionState::Waiting => 0,
            SessionState::Busy => 1,
            SessionState::Success => 2,
            SessionState::Idle => 3,
        }
    }
}

/* ── turno publicado ao estudio ────────────────────────────────────── */

/// Estado do turno como o card o entende. Vem sempre de um arquivo escrito
/// pelo proprio agente, nunca de silencio nem de uso de CPU.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TurnState {
    /// Um turno esta correndo.
    Busy,
    /// O agente parou para perguntar.
    Waiting,
    /// O turno fechou e a resposta esta entregue.
    Done,
    /// Aberto, sem turno nenhum ate agora.
    Idle,
}

/// Turno do agente que roda numa sessao do estudio.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTurn {
    pub state: TurnState,
    /// Quando o estado mudou, em milissegundos do epoch.
    pub since_ms: u64,
    /// O que o agente espera de voce, quando espera, como ele mesmo gravou.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_for: Option<String>,
}

/// Turno lido do registro `<perfil>/sessions/<pid>.json` do Claude Code.
///
/// O registro nao tem estado de concluido. Um `idle` cujo carimbo de estado e
/// posterior ao inicio da sessao prova que houve pelo menos um turno, e so
/// por isso vira [`TurnState::Done`]. Um `idle` sem esse carimbo e uma sessao
/// recem aberta. Um registro que nao diz nada que se entenda nao vira turno
/// nenhum: o card cai para a evidencia de saida e de CPU.
pub fn claude_turn(path: &Path) -> Option<AgentTurn> {
    let record = claude_record(path)?;
    if !record.reports_status {
        return None;
    }
    let state = match record.state {
        SessionState::Busy => TurnState::Busy,
        SessionState::Waiting => TurnState::Waiting,
        SessionState::Success => TurnState::Done,
        SessionState::Idle => {
            let after_start = record
                .started_at_ms
                .is_some_and(|start| record.since_ms > start);
            if after_start {
                TurnState::Done
            } else {
                TurnState::Idle
            }
        }
    };
    Some(AgentTurn {
        state,
        since_ms: record.since_ms,
        waiting_for: record.waiting_for,
    })
}

/// Turno lido do rollout de uma conversa do Codex.
///
/// O Codex nunca diz que espera voce: nao ha evento para isso. Um turno
/// abortado nao e conclusao, entao a conversa volta a aberta e parada.
pub fn codex_turn(path: &Path) -> Option<AgentTurn> {
    let since_ms = modified_ms(path)?;
    let state = match state_of(path) {
        Some(SessionState::Busy) => TurnState::Busy,
        Some(SessionState::Success) => TurnState::Done,
        Some(SessionState::Waiting) => TurnState::Waiting,
        Some(SessionState::Idle) | None => TurnState::Idle,
    };
    Some(AgentTurn {
        state,
        since_ms,
        waiting_for: None,
    })
}

/* ── registro de sessao do Claude Code ─────────────────────────────── */

#[derive(Clone, Debug, PartialEq)]
pub struct SessionRecord {
    pub pid: u32,
    pub cwd: String,
    pub session_id: Option<String>,
    pub name: String,
    /// Codigo de onde a sessao roda: `terminal`, `desktop`, `vscode`, `agent`.
    pub surface: &'static str,
    pub state: SessionState,
    /// O registro disse algo que se entende. Falso para sessao do Desktop e
    /// para estado desconhecido, e so ai o transcript opina.
    pub reports_status: bool,
    pub waiting_for: Option<String>,
    pub since_ms: u64,
    pub started_at_ms: Option<u64>,
}

/// Leitura tolerante: um campo novo nunca descarta a sessao.
pub fn parse_record(raw: &str) -> Option<SessionRecord> {
    let parsed: serde_json::Value = serde_json::from_str(raw).ok()?;
    let pid = parsed.get("pid").and_then(|value| value.as_u64())? as u32;
    let cwd = parsed
        .get("cwd")
        .and_then(|value| value.as_str())?
        .to_string();

    let status = parsed
        .get("status")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let tempo = parsed
        .get("tempo")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    // `tempo` e a forma normalizada e vence `status` quando os dois vem.
    let (state, reports_status) = match (tempo, status) {
        ("blocked", _) | (_, "waiting") => (SessionState::Waiting, true),
        ("active", _) | (_, "busy") => (SessionState::Busy, true),
        ("idle", _) | (_, "idle") => (SessionState::Idle, true),
        _ => (SessionState::Idle, false),
    };

    let started_at_ms = parsed
        .get("startedAt")
        .and_then(|value| value.as_u64())
        .or_else(|| {
            parsed
                .get("procStart")
                .and_then(|value| value.as_str())
                .and_then(parse_proc_start)
        });
    // `since` e quando o estado mudou. Sem carimbo, cai para o inicio da
    // sessao: usar o relogio faria a animacao renascer a cada varredura.
    let since_ms = parsed
        .get("statusUpdatedAt")
        .and_then(|value| value.as_u64())
        .or_else(|| parsed.get("updatedAt").and_then(|value| value.as_u64()))
        .or(started_at_ms)
        .unwrap_or(0);

    let entrypoint = parsed
        .get("entrypoint")
        .and_then(|value| value.as_str())
        .unwrap_or("cli");
    let name = parsed
        .get("name")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| folder_of(&cwd));

    Some(SessionRecord {
        pid,
        session_id: parsed
            .get("sessionId")
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        name,
        surface: surface_of(entrypoint),
        state,
        reports_status,
        waiting_for: parsed
            .get("waitingFor")
            .or_else(|| parsed.get("needs"))
            .and_then(|value| value.as_str())
            .map(|value| value.to_string()),
        since_ms,
        started_at_ms,
        cwd,
    })
}

fn surface_of(entrypoint: &str) -> &'static str {
    match entrypoint {
        "claude-desktop" | "claude-desktop-3p" => "desktop",
        "claude-vscode" => "vscode",
        "local-agent" => "agent",
        _ => "terminal",
    }
}

/// Ultimo componente da pasta, com barra de qualquer sistema.
pub fn folder_of(cwd: &str) -> String {
    cwd.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(cwd)
        .to_string()
}

/// `procStart` vem em UTC, com o dia preenchido por espaco: `Wed Sep 16
/// 17:38:53 2026` para um processo que comecou as 14:38 em Sao Paulo. Ler
/// como hora local descartaria sessoes vivas por tres horas de diferenca.
pub fn parse_proc_start(text: &str) -> Option<u64> {
    let cleaned = text.split_whitespace().collect::<Vec<&str>>().join(" ");
    let naive = chrono::NaiveDateTime::parse_from_str(&cleaned, "%a %b %d %H:%M:%S %Y").ok()?;
    Some(naive.and_utc().timestamp_millis().max(0) as u64)
}

/// Le o registro `<perfil>/sessions/<pid>.json` de uma sessao do Claude Code.
pub fn claude_record(path: &Path) -> Option<SessionRecord> {
    let raw = std::fs::read_to_string(path).ok()?;
    parse_record(&raw)
}

/* ── rollout do Codex ──────────────────────────────────────────────── */

/// Ultimo evento que diz alguma coisa sobre o turno.
///
/// `item_completed` nao conta: subitens tambem o emitem no meio do trabalho.
pub fn state_of(path: &Path) -> Option<SessionState> {
    let tail = read_tail(path, CODEX_TAIL_BYTES)?;
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

/// Ultimos `bytes` de um arquivo, como texto tolerante a corte no meio de um
/// caractere. A decisao esta sempre nas ultimas linhas.
pub fn read_tail(path: &Path, bytes: u64) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(bytes)))
        .ok()?;
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer).ok()?;
    Some(String::from_utf8_lossy(&buffer).to_string())
}

/// Instante em que o arquivo foi escrito pela ultima vez, em milissegundos.
pub fn modified_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_record_and_the_rollout_are_read_by_one_module() {
        let record = parse_record(
            r#"{"pid":321,"cwd":"/Users/ana/projeto","sessionId":"abc","status":"waiting","waitingFor":"permission","statusUpdatedAt":1700000000000,"entrypoint":"cli"}"#,
        )
        .expect("registro");
        assert_eq!(record.pid, 321);
        assert_eq!(record.surface, "terminal");
        assert_eq!(record.state, SessionState::Waiting);
        assert_eq!(record.waiting_for.as_deref(), Some("permission"));
        assert_eq!(record.since_ms, 1_700_000_000_000);
        assert_eq!(record.name, "projeto");
        assert_eq!(
            state_in(r#"{"type":"event_msg","payload":{"type":"task_complete"}}"#),
            Some(SessionState::Success)
        );
    }

    #[test]
    fn the_rank_puts_whoever_needs_you_first() {
        assert!(SessionState::Waiting.rank() < SessionState::Busy.rank());
        assert!(SessionState::Busy.rank() < SessionState::Success.rank());
        assert!(SessionState::Success.rank() < SessionState::Idle.rank());
    }

    #[test]
    fn a_tail_shorter_than_the_window_comes_back_whole() {
        let dir = std::env::temp_dir().join(format!("cialai-agent-state-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rollout.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}\n",
        )
        .unwrap();
        assert_eq!(state_of(&path), Some(SessionState::Busy));
        assert!(modified_ms(&path).is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
