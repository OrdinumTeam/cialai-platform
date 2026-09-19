// SPDX-License-Identifier: Apache-2.0
//! Sessoes de agente vistas pela Barra de IA: quem esta trabalhando, quem
//! parou para perguntar e quem acabou.
//!
//! Regra que vale para tudo aqui: **nada e inferido por silencio**. Um agente
//! quieto pode estar rodando um comando longo. Uma sessao so aparece como
//! aguardando quando a propria ferramenta grava isso, e so aparece como
//! terminada quando ha evidencia de que o turno fechou. O estudio ja segue a
//! mesma regra.
//!
//! A existencia e a hora de inicio de um processo vem do `workspace::procs`,
//! que ja e portavel: `proc_pidinfo` no macOS, `sysinfo` e `/proc` no Linux
//! e no Windows.

pub mod claude;
pub mod codex;
pub mod focus;

use serde::{Deserialize, Serialize};

use crate::workspace::procs::{self, ProcInfo, ProcSource};

/// Tolerancia entre o inicio gravado no arquivo e o inicio real do processo,
/// para um pid reciclado nao passar por vivo.
const REUSE_TOLERANCE_SEC: u64 = 5 * 60;
/// Ate onde subir na arvore de processos procurando o app dono.
pub const ANCESTRY_LIMIT: usize = 8;

/// O enum e os leitores puros moram em [`crate::workspace::agent_state`],
/// para a Barra de IA e o estudio dizerem a mesma coisa sobre a mesma sessao.
pub use crate::workspace::agent_state::SessionState;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// `claude-webrota.2678`, `codex-amorim.rollout-....jsonl`.
    pub id: String,
    /// Perfil dono da sessao, o mesmo id do anel.
    pub profile_id: String,
    pub name: String,
    /// Codigo de onde a sessao roda: `terminal`, `desktop`, `vscode` ou
    /// `agent` no Claude Code, `rollout` no Codex. A pasta vem de `cwd`.
    pub detail: String,
    pub state: SessionState,
    /// O que ela espera de voce, quando espera, como a ferramenta gravou.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub waiting_for: Option<String>,
    /// Quando entrou neste estado, nao quando o arquivo mudou.
    pub since_ms: u64,
    /// So para trazer a janela dona para a frente.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Sessao do estudio de terminais que hospeda este agente, quando ele
    /// roda dentro do Cialai.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pty_tag: Option<String>,
}

/// Resumo por perfil, que vira o indicador dentro do anel.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySummary {
    pub state: SessionState,
    pub count: usize,
    pub waiting: usize,
    pub busy: usize,
}

impl ActivitySummary {
    /// `None` quando o perfil nao tem sessao: o anel fica sem indicador.
    pub fn of(sessions: &[AgentSession]) -> Option<Self> {
        if sessions.is_empty() {
            return None;
        }
        let waiting = sessions
            .iter()
            .filter(|session| session.state == SessionState::Waiting)
            .count();
        let busy = sessions
            .iter()
            .filter(|session| session.state == SessionState::Busy)
            .count();
        let success = sessions
            .iter()
            .any(|session| session.state == SessionState::Success);
        let state = if waiting > 0 {
            SessionState::Waiting
        } else if busy > 0 {
            SessionState::Busy
        } else if success {
            SessionState::Success
        } else {
            SessionState::Idle
        };
        Some(Self {
            state,
            count: sessions.len(),
            waiting,
            busy,
        })
    }
}

/// Ordena para a lista do card: estado primeiro, mais recente depois.
pub fn sort_for_display(sessions: &mut [AgentSession]) {
    sessions.sort_by(|a, b| {
        a.state
            .rank()
            .cmp(&b.state.rank())
            .then(b.since_ms.cmp(&a.since_ms))
            .then(a.id.cmp(&b.id))
    });
}

/// Atualiza a tabela de processos uma vez por varredura. No macOS nao custa
/// nada; no Linux e no Windows o `sysinfo` refaz o snapshot inteiro, e uma
/// consulta por pid a cada segundo seria cara demais.
pub fn refresh_process_table() {
    procs::system().refresh();
}

fn process_info(pid: u32) -> Option<ProcInfo> {
    procs::system().info(pid)
}

/// O processo existe e e mesmo aquele que o arquivo diz.
///
/// Sem esta checagem, o arquivo deixado por uma sessao que caiu ficaria
/// ocupado para sempre, e um pid reciclado por outro programa apareceria como
/// agente trabalhando. Onde o sistema nao expoe a hora de inicio, vale so a
/// existencia.
pub fn is_alive(pid: u32, started_at_ms: Option<u64>) -> bool {
    let Some(info) = process_info(pid) else {
        return false;
    };
    let Some(started) = started_at_ms else {
        return true;
    };
    if info.start_sec == 0 {
        return true;
    }
    (started / 1000).abs_diff(info.start_sec) <= REUSE_TOLERANCE_SEC
}

/// Cadeia de processos ate o topo, comecando no proprio pid.
pub fn ancestry(pid: u32) -> Vec<u32> {
    let mut chain = vec![pid];
    let mut current = pid;
    for _ in 0..ANCESTRY_LIMIT {
        let Some(info) = process_info(current) else {
            break;
        };
        let parent = info.ppid;
        if parent <= 1 || parent == current || chain.contains(&parent) {
            break;
        }
        chain.push(parent);
        current = parent;
    }
    chain
}

/// Sessao do estudio que hospeda este pid, quando o agente roda dentro do
/// Cialai. Casa pela arvore de processos: o agente e neto do shell do PTY.
pub fn pty_tag_for(pid: u32, terminals: &[(String, u32)]) -> Option<String> {
    let chain = ancestry(pid);
    terminals
        .iter()
        .find(|(_, shell)| chain.contains(shell))
        .map(|(tag, _)| tag.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, state: SessionState, since: u64) -> AgentSession {
        AgentSession {
            id: id.to_string(),
            profile_id: "claude-webrota".to_string(),
            name: id.to_string(),
            detail: "terminal".to_string(),
            state,
            waiting_for: None,
            since_ms: since,
            pid: None,
            cwd: None,
            pty_tag: None,
        }
    }

    #[test]
    fn a_profile_without_sessions_has_no_indicator() {
        assert!(ActivitySummary::of(&[]).is_none());
    }

    #[test]
    fn waiting_wins_over_working() {
        let sessions = vec![
            session("a", SessionState::Busy, 1),
            session("b", SessionState::Waiting, 2),
            session("c", SessionState::Success, 3),
        ];
        let summary = ActivitySummary::of(&sessions).unwrap();
        assert_eq!(summary.state, SessionState::Waiting);
        assert_eq!(summary.count, 3);
        assert_eq!(summary.waiting, 1);
        assert_eq!(summary.busy, 1);
    }

    #[test]
    fn working_wins_over_finished() {
        let sessions = vec![
            session("a", SessionState::Success, 1),
            session("b", SessionState::Busy, 2),
        ];
        assert_eq!(
            ActivitySummary::of(&sessions).unwrap().state,
            SessionState::Busy
        );
    }

    #[test]
    fn only_idle_sessions_leave_the_ring_quiet() {
        let sessions = vec![session("a", SessionState::Idle, 1)];
        assert_eq!(
            ActivitySummary::of(&sessions).unwrap().state,
            SessionState::Idle
        );
    }

    #[test]
    fn the_list_puts_the_ones_that_need_you_first() {
        let mut sessions = vec![
            session("idle", SessionState::Idle, 10),
            session("busy", SessionState::Busy, 20),
            session("waiting", SessionState::Waiting, 5),
            session("done", SessionState::Success, 30),
        ];
        sort_for_display(&mut sessions);
        let ids: Vec<&str> = sessions.iter().map(|session| session.id.as_str()).collect();
        assert_eq!(ids, vec!["waiting", "busy", "done", "idle"]);
    }

    #[test]
    fn the_newest_comes_first_inside_a_state() {
        let mut sessions = vec![
            session("velha", SessionState::Busy, 10),
            session("nova", SessionState::Busy, 99),
        ];
        sort_for_display(&mut sessions);
        assert_eq!(sessions[0].id, "nova");
    }

    #[test]
    fn the_session_json_uses_the_contract_names() {
        let mut item = session("claude-webrota.1", SessionState::Waiting, 5);
        item.waiting_for = Some("permission".to_string());
        item.pty_tag = Some("sessao-1".to_string());
        let value = serde_json::to_value(&item).unwrap();
        assert_eq!(value["profileId"], "claude-webrota");
        assert_eq!(value["waitingFor"], "permission");
        assert_eq!(value["sinceMs"], 5);
        assert_eq!(value["ptyTag"], "sessao-1");
        assert_eq!(value["state"], "waiting");
        assert!(value.get("pid").is_none());
    }

    #[test]
    fn a_pid_that_does_not_exist_is_not_alive() {
        refresh_process_table();
        assert!(!is_alive(u32::MAX - 1, None));
    }

    #[test]
    fn this_very_process_is_alive() {
        refresh_process_table();
        assert!(is_alive(std::process::id(), None));
    }

    #[test]
    fn a_start_time_far_from_the_record_means_a_recycled_pid() {
        refresh_process_table();
        let pid = std::process::id();
        assert!(
            !is_alive(pid, Some(1_000)),
            "1970 nao pode ser o inicio deste processo"
        );
        let info = process_info(pid).unwrap();
        assert!(is_alive(pid, Some(info.start_sec * 1000)));
    }

    #[test]
    fn the_ancestry_starts_at_the_process_itself() {
        refresh_process_table();
        let chain = ancestry(std::process::id());
        assert_eq!(chain[0], std::process::id());
        assert!(chain.len() <= ANCESTRY_LIMIT + 1);
    }

    #[test]
    fn a_session_is_linked_to_the_studio_by_its_ancestry() {
        refresh_process_table();
        let me = std::process::id();
        let terminals = vec![("sessao-1".to_string(), me)];
        assert_eq!(pty_tag_for(me, &terminals).as_deref(), Some("sessao-1"));
        assert!(pty_tag_for(me, &[("outra".to_string(), 999_999)]).is_none());
    }
}
