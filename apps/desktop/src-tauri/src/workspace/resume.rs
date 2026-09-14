// SPDX-License-Identifier: Apache-2.0
//! Retomada dos agentes de codigo depois que o app fecha.
//!
//! O shell de uma sessao morre com o app, e o agente que rodava nele morre
//! junto. A conversa continua gravada pelo proprio agente, e cada um diz qual
//! e a sua sem precisar adivinhar:
//!
//! - **Claude Code** grava `<perfil>/sessions/<pid>.json` com o `sessionId`
//!   do processo. O perfil e a pasta de `CLAUDE_CONFIG_DIR`, lida do ambiente
//!   do proprio processo, ou `~/.claude`.
//! - **Codex** mantem aberto o `rollout-<data>-<id>.jsonl` da conversa em
//!   `<CODEX_HOME>/sessions`. O id sai do nome desse arquivo, achado entre os
//!   descritores do processo.
//!
//! [`detect`] roda a cada amostra do estado da sessao e [`resume_command`]
//! monta, na hora de reabrir e conforme o sabor do shell, `claude --resume
//! <id>` ou `codex resume <id>` com o perfil, a pasta e as opcoes de permissao
//! e modelo da linha de comando original. As opcoes passam por listas fechadas
//! tambem ao montar o comando e todo valor vai citado, entao um arquivo de
//! estado alterado nao injeta nada no shell.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::platform::ShellFlavor;

use super::procs::{self, CommandCache, CommandLine};

pub const CLAUDE: &str = "Claude Code";
pub const CODEX: &str = "Codex";

/// Maior arquivo de sessao do Claude Code que vale a pena ler.
const SESSION_FILE_LIMIT: u64 = 64 * 1024;
/// Maior valor de opcao repassado ao comando de retomada.
const VALUE_LIMIT: usize = 1024;
/// Folga entre o inicio do processo e o `startedAt` do arquivo de sessao.
const STARTED_SLACK_SECS: u64 = 5;
/// Profundidade dada a um processo cuja cadeia nao chega ao shell.
const DETACHED_DEPTH: usize = 1024;
/// Limite defensivo para uma busca de reserva nas sessoes do Codex.
const CODEX_FILE_LIMIT: usize = 4096;

/// Conversa de um agente que pode ser retomada num shell novo.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSession {
    /// [`CLAUDE`] ou [`CODEX`].
    pub agent: String,
    pub session_id: String,
    /// Pasta em que o agente rodava.
    pub cwd: Option<String>,
    /// Pasta de configuracao, so quando veio de variavel de ambiente.
    pub config_dir: Option<String>,
    /// Nome do perfil, de `CLAUDE_PROFILE` ou `CODEX_PROFILE`.
    pub profile_name: Option<String>,
    /// Opcoes da linha de comando original que valem de novo na retomada.
    pub args: Vec<String>,
}

/// Opcoes repassadas na retomada, cada uma com a forma longa usada no
/// comando. Opcao fora das listas e argumento solto, como um prompt, ficam
/// de fora.
struct FlagSpec {
    switches: &'static [(&'static str, &'static str)],
    values: &'static [(&'static str, &'static str)],
    /// Opcoes que aceitam varios valores seguidos, como `--add-dir a b`.
    lists: &'static [(&'static str, &'static str)],
}

const CLAUDE_FLAGS: FlagSpec = FlagSpec {
    switches: &[
        (
            "--dangerously-skip-permissions",
            "--dangerously-skip-permissions",
        ),
        (
            "--allow-dangerously-skip-permissions",
            "--allow-dangerously-skip-permissions",
        ),
        ("--chrome", "--chrome"),
        ("--no-chrome", "--no-chrome"),
        ("--ide", "--ide"),
        ("--verbose", "--verbose"),
        ("--strict-mcp-config", "--strict-mcp-config"),
    ],
    values: &[
        ("--permission-mode", "--permission-mode"),
        ("--model", "--model"),
        ("--effort", "--effort"),
        ("--agent", "--agent"),
        ("--fallback-model", "--fallback-model"),
        ("--settings", "--settings"),
    ],
    lists: &[("--add-dir", "--add-dir"), ("--mcp-config", "--mcp-config")],
};

const CODEX_FLAGS: FlagSpec = FlagSpec {
    switches: &[
        ("--yolo", "--dangerously-bypass-approvals-and-sandbox"),
        (
            "--dangerously-bypass-approvals-and-sandbox",
            "--dangerously-bypass-approvals-and-sandbox",
        ),
        ("--approve-for-me", "--approve-for-me"),
        ("--search", "--search"),
        ("--no-alt-screen", "--no-alt-screen"),
        ("--oss", "--oss"),
    ],
    values: &[
        ("-m", "--model"),
        ("--model", "--model"),
        ("-p", "--profile"),
        ("--profile", "--profile"),
        ("-s", "--sandbox"),
        ("--sandbox", "--sandbox"),
        ("-a", "--ask-for-approval"),
        ("--ask-for-approval", "--ask-for-approval"),
        ("-C", "--cd"),
        ("--cd", "--cd"),
        ("-c", "--config"),
        ("--config", "--config"),
        ("--add-dir", "--add-dir"),
        ("--enable", "--enable"),
        ("--disable", "--disable"),
        ("--local-provider", "--local-provider"),
    ],
    lists: &[],
};

/// Conversa do agente mais proximo do shell na arvore da sessao. `tree`
/// inclui o proprio shell. Um Codex aberto por um Claude Code, por exemplo,
/// perde para o Claude Code.
pub fn detect(
    shell: u32,
    tree: &[u32],
    commands: &mut CommandCache,
    home: &Path,
) -> Option<AgentSession> {
    let mut parents = HashMap::new();
    let mut best: Option<(usize, AgentSession)> = None;
    let mut found = Vec::new();
    for &pid in tree {
        let Some(info) = procs::info(pid) else {
            continue;
        };
        parents.insert(pid, info.ppid);
        if pid != shell {
            found.push((pid, info.start_sec));
        }
    }
    for (pid, start_sec) in found {
        let Some(command) = commands.get(pid, start_sec) else {
            continue;
        };
        let session = match procs::agent_of(&command) {
            Some(CLAUDE) => claude_session(&command, pid, start_sec, home),
            Some(CODEX) => codex_session(&command, pid, start_sec, home),
            _ => None,
        };
        let Some(session) = session else { continue };
        let depth = depth_below(pid, shell, &parents);
        if best.as_ref().is_none_or(|(known, _)| depth < *known) {
            best = Some((depth, session));
        }
    }
    best.map(|(_, session)| session)
}

/// Degraus entre o processo e o shell, pela cadeia de pais.
fn depth_below(pid: u32, shell: u32, parents: &HashMap<u32, u32>) -> usize {
    let mut current = pid;
    let mut depth = 0;
    while current != shell {
        let Some(parent) = parents.get(&current) else {
            return DETACHED_DEPTH;
        };
        current = *parent;
        depth += 1;
        if depth >= DETACHED_DEPTH {
            return DETACHED_DEPTH;
        }
    }
    depth
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeSessionFile {
    pid: Option<u32>,
    session_id: Option<String>,
    cwd: Option<String>,
    started_at: Option<u64>,
    kind: Option<String>,
}

fn claude_session(
    command: &CommandLine,
    pid: u32,
    start_sec: u64,
    home: &Path,
) -> Option<AgentSession> {
    let profile = procs::agent_profile(command, CLAUDE, home)?;
    let path = Path::new(&profile.config_dir)
        .join("sessions")
        .join(format!("{pid}.json"));
    let file: ClaudeSessionFile = serde_json::from_str(&read_small(&path)?).ok()?;
    if file.pid.is_some_and(|value| value != pid)
        || file
            .kind
            .as_deref()
            .is_some_and(|kind| kind != "interactive")
    {
        return None;
    }
    // Arquivo deixado por um processo anterior com o mesmo pid.
    if file
        .started_at
        .is_some_and(|ms| ms / 1000 + STARTED_SLACK_SECS < start_sec)
    {
        return None;
    }
    let session_id = file.session_id.filter(|id| is_session_id(id))?;
    Some(AgentSession {
        agent: CLAUDE.to_string(),
        session_id,
        cwd: file
            .cwd
            .filter(|cwd| valid_value(cwd))
            .or_else(|| procs::cwd(pid)),
        config_dir: profile.explicit.then_some(profile.config_dir),
        profile_name: profile.name,
        args: keep_flags(program_args(&command.argv), &CLAUDE_FLAGS),
    })
}

fn codex_session(
    command: &CommandLine,
    pid: u32,
    start_sec: u64,
    home: &Path,
) -> Option<AgentSession> {
    let profile = procs::agent_profile(command, CODEX, home)?;
    let sessions = Path::new(&profile.config_dir).join("sessions");
    let cwd = procs::cwd(pid);
    let session_id = procs::open_files(pid)
        .iter()
        .filter(|path| Path::new(path.as_str()).starts_with(&sessions))
        .find_map(|path| rollout_session_id(path))
        .or_else(|| {
            cwd.as_deref()
                .and_then(|cwd| newest_codex_rollout(&sessions, cwd, start_sec))
        })?;
    Some(AgentSession {
        agent: CODEX.to_string(),
        session_id,
        cwd,
        config_dir: profile.explicit.then_some(profile.config_dir),
        profile_name: profile.name,
        args: keep_flags(program_args(&command.argv), &CODEX_FLAGS),
    })
}

#[derive(Deserialize)]
struct CodexRecord {
    #[serde(rename = "type")]
    kind: String,
    payload: CodexSessionMeta,
}

#[derive(Deserialize)]
struct CodexSessionMeta {
    id: Option<String>,
    cwd: String,
}

/// Reserva para Windows, onde enumerar handles abertos exigiria privilegios:
/// escolhe o rollout mais recente criado depois do processo e cuja primeira
/// linha `session_meta` aponta para o mesmo cwd. Dois Codex simultaneos na
/// mesma pasta continuam sendo uma ambiguidade conhecida.
fn newest_codex_rollout(sessions: &Path, cwd: &str, start_sec: u64) -> Option<String> {
    let expected_cwd = dunce::canonicalize(cwd).ok()?;
    let mut pending = vec![sessions.to_path_buf()];
    let mut inspected = 0usize;
    let mut best: Option<(u64, String)> = None;
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            inspected += 1;
            if inspected > CODEX_FILE_LIMIT {
                return best.map(|(_, id)| id);
            }
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                pending.push(path);
                continue;
            }
            if !meta.is_file() {
                continue;
            }
            let Some(id) = rollout_session_id(path.to_string_lossy().as_ref()) else {
                continue;
            };
            let Some(modified_sec) = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|elapsed| elapsed.as_secs())
                .filter(|modified| *modified >= start_sec)
            else {
                continue;
            };
            let Some(record) = first_codex_record(&path) else {
                continue;
            };
            if record.kind != "session_meta"
                || record
                    .payload
                    .id
                    .as_deref()
                    .is_some_and(|value| !is_session_id(value) || !value.eq_ignore_ascii_case(&id))
                || dunce::canonicalize(&record.payload.cwd).ok().as_deref()
                    != Some(expected_cwd.as_path())
            {
                continue;
            }
            if best
                .as_ref()
                .is_none_or(|(known_modified, _)| modified_sec > *known_modified)
            {
                best = Some((modified_sec, id));
            }
        }
    }
    best.map(|(_, id)| id)
}

fn first_codex_record(path: &Path) -> Option<CodexRecord> {
    let file = fs::File::open(path).ok()?;
    let mut line = String::new();
    BufReader::new(file)
        .take(SESSION_FILE_LIMIT)
        .read_line(&mut line)
        .ok()?;
    serde_json::from_str(&line).ok()
}

fn read_small(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > SESSION_FILE_LIMIT {
        return None;
    }
    fs::read_to_string(path).ok()
}

/// Id da conversa no nome `rollout-<data>-<uuid>.jsonl` do Codex.
fn rollout_session_id(path: &str) -> Option<String> {
    let name = Path::new(path).file_name()?.to_str()?;
    let stem = name.strip_prefix("rollout-")?.strip_suffix(".jsonl")?;
    let id = stem.get(stem.len().checked_sub(36)?..)?;
    is_session_id(id).then(|| id.to_ascii_lowercase())
}

/// UUID no formato 8-4-4-4-12, o unico aceito como id de conversa.
pub fn is_session_id(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
}

fn valid_value(value: &str) -> bool {
    !value.is_empty() && value.len() <= VALUE_LIMIT && !value.chars().any(char::is_control)
}

/// Argumentos depois do programa: pula o executavel e, quando ele e um
/// interpretador como o node do `cli-wrapper.cjs`, tambem o script.
fn program_args(argv: &[String]) -> &[String] {
    let first = argv
        .first()
        .map(|value| procs::basename(value))
        .unwrap_or_default()
        .to_ascii_lowercase();
    let first = first
        .strip_suffix(".exe")
        .or_else(|| first.strip_suffix(".cmd"))
        .unwrap_or(&first);
    let skip = if matches!(first, "node" | "bun" | "deno" | "python" | "python3") {
        2
    } else {
        1
    };
    argv.get(skip..).unwrap_or(&[])
}

fn keep_flags(args: &[String], spec: &FlagSpec) -> Vec<String> {
    let lookup = |table: &[(&str, &'static str)], name: &str| {
        table
            .iter()
            .find(|(alias, _)| *alias == name)
            .map(|(_, long)| *long)
    };
    let mut kept: Vec<String> = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let raw = args[index].as_str();
        index += 1;
        if !raw.starts_with('-') {
            continue;
        }
        let (name, inline) = match raw.split_once('=') {
            Some((name, value)) if name.starts_with("--") => (name, Some(value)),
            _ => (raw, None),
        };
        if let Some(long) = lookup(spec.switches, name) {
            if inline.is_none() && !kept.iter().any(|value| value == long) {
                kept.push(long.to_string());
            }
        } else if let Some(long) = lookup(spec.values, name) {
            let value = match inline {
                Some(value) => Some(value.to_string()),
                None => {
                    let next = args
                        .get(index)
                        .filter(|next| !next.starts_with('-'))
                        .cloned();
                    if next.is_some() {
                        index += 1;
                    }
                    next
                }
            };
            if let Some(value) = value.filter(|value| valid_value(value)) {
                kept.push(long.to_string());
                kept.push(value);
            }
        } else if let Some(long) = lookup(spec.lists, name) {
            let mut values: Vec<String> = inline
                .map(|value| vec![value.to_string()])
                .unwrap_or_default();
            if inline.is_none() {
                while let Some(next) = args.get(index).filter(|next| !next.starts_with('-')) {
                    values.push(next.clone());
                    index += 1;
                }
            }
            for value in values.into_iter().filter(|value| valid_value(value)) {
                kept.push(long.to_string());
                kept.push(value);
            }
        }
    }
    kept
}

/// Comando que devolve a conversa num shell novo aberto em `shell_cwd`, ou
/// `None` quando o registro nao passa na validacao. O shell interpreta o
/// comando, entao a funcao `claude` do usuario continua valendo.
pub fn resume_command(
    session: &AgentSession,
    shell_cwd: &str,
    flavor: ShellFlavor,
) -> Option<String> {
    if !is_session_id(&session.session_id) {
        return None;
    }
    let (spec, program, dir_key, name_key): (&FlagSpec, &[&str], &str, &str) =
        match session.agent.as_str() {
            CLAUDE => (
                &CLAUDE_FLAGS,
                &["claude", "--resume"],
                "CLAUDE_CONFIG_DIR",
                "CLAUDE_PROFILE",
            ),
            CODEX => (
                &CODEX_FLAGS,
                &["codex", "resume"],
                "CODEX_HOME",
                "CODEX_PROFILE",
            ),
            _ => return None,
        };
    let cwd = session
        .cwd
        .as_deref()
        .filter(|cwd| *cwd != shell_cwd && valid_value(cwd) && Path::new(cwd).is_dir());
    let mut environment = Vec::new();
    if let Some(dir) = session.config_dir.as_deref() {
        if !valid_value(dir) || !Path::new(dir).is_absolute() {
            return None;
        }
        environment.push((dir_key, dir));
    }
    if let Some(name) = session
        .profile_name
        .as_deref()
        .filter(|name| valid_value(name))
    {
        environment.push((name_key, name));
    }
    let mut command = program
        .iter()
        .map(|word| word.to_string())
        .collect::<Vec<_>>();
    command.push(session.session_id.to_ascii_lowercase());
    command.extend(keep_flags(&session.args, spec).iter().map(|value| {
        if value.starts_with("--") {
            value.clone()
        } else {
            shell_quote(value, flavor)
        }
    }));
    let command = command.join(" ");

    let mut parts = Vec::new();
    match flavor {
        ShellFlavor::Posix => {
            if let Some(cwd) = cwd {
                parts.push(format!("cd {} &&", shell_quote(cwd, flavor)));
            }
            parts.extend(
                environment
                    .iter()
                    .map(|(key, value)| format!("{key}={}", shell_quote(value, flavor))),
            );
        }
        ShellFlavor::Powershell => {
            if let Some(cwd) = cwd {
                parts.push(format!(
                    "Set-Location -LiteralPath {};",
                    shell_quote_always(cwd, flavor)
                ));
            }
            parts.extend(
                environment.iter().map(|(key, value)| {
                    format!("$env:{key}={};", shell_quote_always(value, flavor))
                }),
            );
        }
        ShellFlavor::Cmd => {
            if let Some(cwd) = cwd {
                parts.push(format!("cd /d {} &&", shell_quote_always(cwd, flavor)));
            }
            parts.extend(environment.iter().map(|(key, value)| {
                // `set` altera o ambiente deste cmd; isso e intencional e a
                // variavel permanece no shell depois que o agente encerra.
                format!("set \"{key}={}\" &&", cmd_inner(value))
            }));
        }
    }
    parts.push(command);
    Some(parts.join(" "))
}

/// Cita um argumento para o sabor do shell. `=` no inicio viraria expansao
/// de comando no zsh; PowerShell dobra apostrofos em literais; cmd usa aspas
/// duplas e dobra as aspas internas, o mesmo contrato do frontend.
pub fn shell_quote(value: &str, flavor: ShellFlavor) -> String {
    let punctuation: &[u8] = match flavor {
        ShellFlavor::Cmd => b"_./\\~+@%:,=-",
        ShellFlavor::Posix | ShellFlavor::Powershell => b"_./~+@%:,=-",
    };
    let starts_special = value
        .as_bytes()
        .first()
        .is_some_and(|byte| matches!(byte, b'=' | b'~' | b'-'));
    let plain = !value.is_empty()
        && !starts_special
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || punctuation.contains(&byte));
    if plain {
        value.to_string()
    } else {
        shell_quote_always(value, flavor)
    }
}

fn shell_quote_always(value: &str, flavor: ShellFlavor) -> String {
    match flavor {
        ShellFlavor::Posix => format!("'{}'", value.replace('\'', "'\\''")),
        ShellFlavor::Powershell => format!("'{}'", value.replace('\'', "''")),
        ShellFlavor::Cmd => format!("\"{}\"", cmd_inner(value)),
    }
}

fn cmd_inner(value: &str) -> String {
    value.replace('"', "\"\"")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    const ID: &str = "ef374958-11c4-4e44-8fce-798df3af068e";

    fn strings(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oc-resume-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir.canonicalize().unwrap()
    }

    #[test]
    fn session_ids_are_strict_uuids() {
        assert!(is_session_id(ID));
        assert!(is_session_id("01A08CAD-1DFF-75C1-9219-394E47EEF8D1"));
        for bad in [
            "",
            "ef374958",
            "ef374958-11c4-4e44-8fce-798df3af068",
            "ef374958-11c4-4e44-8fce-798df3af068g",
            "ef374958_11c4-4e44-8fce-798df3af068e",
            "ef374958-11c4-4e44-8fce-798df3af068e; rm",
        ] {
            assert!(!is_session_id(bad), "{bad}");
        }
    }

    #[test]
    fn rollout_names_give_the_codex_conversation() {
        assert_eq!(
            rollout_session_id("/h/.codex/sessions/2026/09/10/rollout-2026-09-10T15-55-50-01a08cad-1dff-75c1-9219-394e47eef8d1.jsonl").as_deref(),
            Some("01a08cad-1dff-75c1-9219-394e47eef8d1")
        );
        assert!(rollout_session_id("/h/.codex/sessions/rollout-2026.jsonl").is_none());
        assert!(rollout_session_id("/h/.codex/history.jsonl").is_none());
        assert!(
            rollout_session_id("/h/rollout-x-01a08cad-1dff-75c1-9219-394e47eef8d1.json").is_none()
        );
    }

    #[test]
    fn claude_keeps_permissions_model_and_dirs_only() {
        let argv = strings(&[
            "/x/claude",
            "--dangerously-skip-permissions",
            "-r",
            "--model=opus",
            "--add-dir",
            "/a",
            "/b",
            "--print",
            "oi",
            "--dangerously-skip-permissions",
            "--output-format",
            "json",
        ]);
        assert_eq!(
            keep_flags(program_args(&argv), &CLAUDE_FLAGS),
            strings(&[
                "--dangerously-skip-permissions",
                "--model",
                "opus",
                "--add-dir",
                "/a",
                "--add-dir",
                "/b"
            ])
        );
        let wrapper = strings(&[
            "node",
            "/x/cli-wrapper.cjs",
            "--verbose",
            "continue o trabalho",
        ]);
        assert_eq!(
            keep_flags(program_args(&wrapper), &CLAUDE_FLAGS),
            strings(&["--verbose"])
        );
        let windows_wrapper = strings(&[
            "node.exe",
            r"C:\\tools\\claude.cmd",
            "--verbose",
            "continue o trabalho",
        ]);
        assert_eq!(
            keep_flags(program_args(&windows_wrapper), &CLAUDE_FLAGS),
            strings(&["--verbose"])
        );
        let windows_command = strings(&["claude.cmd", "--model", "opus"]);
        assert_eq!(
            keep_flags(program_args(&windows_command), &CLAUDE_FLAGS),
            strings(&["--model", "opus"])
        );
    }

    #[test]
    fn codex_normalises_yolo_and_short_options() {
        let argv = strings(&[
            "codex",
            "--yolo",
            "-m",
            "gpt-5",
            "resume",
            ID,
            "-c",
            "model_reasoning_effort=high",
            "--last",
        ]);
        assert_eq!(
            keep_flags(program_args(&argv), &CODEX_FLAGS),
            strings(&[
                "--dangerously-bypass-approvals-and-sandbox",
                "--model",
                "gpt-5",
                "--config",
                "model_reasoning_effort=high"
            ])
        );
    }

    #[test]
    fn resume_command_quotes_values_and_restores_the_profile() {
        let cwd = scratch("command");
        let cwd_text = cwd.to_string_lossy().to_string();
        let profile = cwd.join("claude profile");
        fs::create_dir_all(&profile).unwrap();
        let profile_text = profile.to_string_lossy().to_string();
        let session = AgentSession {
            agent: CLAUDE.into(),
            session_id: ID.into(),
            cwd: Some(cwd_text.clone()),
            config_dir: Some(profile_text.clone()),
            profile_name: Some("Work".into()),
            args: strings(&[
                "--dangerously-skip-permissions",
                "--model",
                "opus; rm -rf ~",
                "--print",
                "$(touch /tmp/x)",
            ]),
        };
        assert_eq!(
            resume_command(&session, "/", ShellFlavor::Posix).unwrap(),
            format!(
                "cd {} && CLAUDE_CONFIG_DIR={} CLAUDE_PROFILE=Work claude --resume {ID} --dangerously-skip-permissions --model 'opus; rm -rf ~'",
                shell_quote(&cwd_text, ShellFlavor::Posix),
                shell_quote(&profile_text, ShellFlavor::Posix),
            )
        );
        assert!(
            resume_command(&session, &cwd_text, ShellFlavor::Posix)
                .unwrap()
                .starts_with("CLAUDE_CONFIG_DIR=")
        );
        let _ = fs::remove_dir_all(cwd);
    }

    #[test]
    fn resume_command_uses_powershell_and_cmd_syntax() {
        let cwd = scratch("command-flavors");
        let cwd_text = cwd.to_string_lossy().to_string();
        let profile = cwd.join("perfil d'agua");
        fs::create_dir_all(&profile).unwrap();
        let profile_text = profile.to_string_lossy().to_string();
        let session = AgentSession {
            agent: CLAUDE.into(),
            session_id: ID.into(),
            cwd: Some(cwd_text.clone()),
            config_dir: Some(profile_text.clone()),
            profile_name: Some("Web Rota".into()),
            args: strings(&["--model", "opus max"]),
        };
        assert_eq!(
            resume_command(&session, "", ShellFlavor::Powershell).unwrap(),
            format!(
                "Set-Location -LiteralPath {}; $env:CLAUDE_CONFIG_DIR={}; $env:CLAUDE_PROFILE='Web Rota'; claude --resume {ID} --model 'opus max'",
                shell_quote_always(&cwd_text, ShellFlavor::Powershell),
                shell_quote_always(&profile_text, ShellFlavor::Powershell),
            )
        );
        assert_eq!(
            resume_command(&session, "", ShellFlavor::Cmd).unwrap(),
            format!(
                "cd /d {} && set \"CLAUDE_CONFIG_DIR={}\" && set \"CLAUDE_PROFILE=Web Rota\" && claude --resume {ID} --model \"opus max\"",
                shell_quote_always(&cwd_text, ShellFlavor::Cmd),
                cmd_inner(&profile_text),
            )
        );
        let _ = fs::remove_dir_all(cwd);
    }

    #[test]
    fn resume_command_rejects_tampered_records() {
        let base = AgentSession {
            agent: CODEX.into(),
            session_id: ID.into(),
            cwd: None,
            config_dir: None,
            profile_name: None,
            args: Vec::new(),
        };
        assert_eq!(
            resume_command(&base, "/", ShellFlavor::Posix),
            Some(format!("codex resume {ID}"))
        );
        assert!(
            resume_command(
                &AgentSession {
                    session_id: format!("{ID}; rm -rf ~"),
                    ..base.clone()
                },
                "/",
                ShellFlavor::Posix
            )
            .is_none()
        );
        assert!(
            resume_command(
                &AgentSession {
                    agent: "Aider".into(),
                    ..base.clone()
                },
                "/",
                ShellFlavor::Posix
            )
            .is_none()
        );
        assert!(
            resume_command(
                &AgentSession {
                    config_dir: Some("relativo".into()),
                    ..base.clone()
                },
                "/",
                ShellFlavor::Posix
            )
            .is_none()
        );
        let missing_dir = AgentSession {
            cwd: Some("/definitivamente/nao/existe".into()),
            ..base.clone()
        };
        assert_eq!(
            resume_command(&missing_dir, "/", ShellFlavor::Posix),
            Some(format!("codex resume {ID}"))
        );
        assert_eq!(shell_quote("it's", ShellFlavor::Posix), "'it'\\''s'");
        assert_eq!(shell_quote("=cmd", ShellFlavor::Posix), "'=cmd'");
        assert_eq!(shell_quote("", ShellFlavor::Posix), "''");
    }

    #[test]
    fn claude_session_file_maps_the_process_to_its_conversation() {
        let home = scratch("claude");
        let sessions = home.join(".claude/sessions");
        fs::create_dir_all(&sessions).unwrap();
        let pid = 424_242;
        let started = 1_789_067_171_690u64;
        let start_sec = started / 1000;
        let command = CommandLine {
            exe: "/x/claude".into(),
            argv: strings(&["/x/claude", "--dangerously-skip-permissions", "-r"]),
            env: HashMap::new(),
        };
        let write = |body: serde_json::Value| {
            fs::write(sessions.join(format!("{pid}.json")), body.to_string()).unwrap()
        };
        write(
            serde_json::json!({"pid": pid, "sessionId": ID, "cwd": "/projeto", "startedAt": started, "kind": "interactive"}),
        );
        assert_eq!(
            claude_session(&command, pid, start_sec, &home),
            Some(AgentSession {
                agent: CLAUDE.into(),
                session_id: ID.into(),
                cwd: Some("/projeto".into()),
                config_dir: None,
                profile_name: None,
                args: strings(&["--dangerously-skip-permissions"]),
            })
        );
        assert!(claude_session(&command, pid, start_sec + 3600, &home).is_none());
        write(serde_json::json!({"pid": pid + 1, "sessionId": ID, "startedAt": started}));
        assert!(claude_session(&command, pid, start_sec, &home).is_none());
        write(
            serde_json::json!({"pid": pid, "sessionId": ID, "startedAt": started, "kind": "print"}),
        );
        assert!(claude_session(&command, pid, start_sec, &home).is_none());
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn codex_session_comes_from_the_rollout_the_process_keeps_open() {
        let home = scratch("codex");
        let codex_home = home.join(".codex-perfil");
        let day = codex_home.join("sessions/2026/09/10");
        fs::create_dir_all(&day).unwrap();
        let open_rollout =
            fs::File::create(day.join(format!("rollout-2026-09-10T15-55-50-{ID}.jsonl"))).unwrap();
        let mut env = HashMap::new();
        env.insert(
            "CODEX_HOME".to_string(),
            codex_home.to_string_lossy().to_string(),
        );
        env.insert("CODEX_PROFILE".to_string(), "Work".to_string());
        let command = CommandLine {
            exe: "/x/codex".into(),
            argv: strings(&["codex", "--yolo"]),
            env,
        };
        let found = codex_session(&command, std::process::id(), 0, &home)
            .expect("rollout aberto pelo proprio teste");
        assert_eq!(found.session_id, ID);
        assert_eq!(
            found.config_dir.as_deref(),
            Some(codex_home.to_string_lossy().as_ref())
        );
        assert_eq!(found.profile_name.as_deref(), Some("Work"));
        assert_eq!(
            found.args,
            strings(&["--dangerously-bypass-approvals-and-sandbox"])
        );
        drop(open_rollout);
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn codex_fallback_matches_cwd_and_process_time() {
        let home = scratch("codex-fallback");
        let project = home.join("projeto");
        let other = home.join("outro");
        let day = home.join("sessions/2026/09/12");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::create_dir_all(&day).unwrap();
        let rollout = day.join(format!("rollout-2026-09-12T10-00-00-{ID}.jsonl"));
        fs::write(
            &rollout,
            format!(
                "{}\n{{\"type\":\"response_item\"}}\n",
                serde_json::json!({
                    "type": "session_meta",
                    "payload": {"id": ID, "cwd": project.to_string_lossy()}
                })
            ),
        )
        .unwrap();
        assert_eq!(
            newest_codex_rollout(
                &home.join("sessions"),
                project.to_string_lossy().as_ref(),
                0
            )
            .as_deref(),
            Some(ID)
        );
        assert!(
            newest_codex_rollout(&home.join("sessions"), other.to_string_lossy().as_ref(), 0)
                .is_none()
        );
        assert!(
            newest_codex_rollout(
                &home.join("sessions"),
                project.to_string_lossy().as_ref(),
                u64::MAX
            )
            .is_none()
        );
        let _ = fs::remove_dir_all(home);
    }

    #[test]
    fn the_agent_closest_to_the_shell_wins() {
        let parents: HashMap<u32, u32> = [(10, 1), (11, 10), (12, 11), (20, 99)]
            .into_iter()
            .collect();
        assert_eq!(depth_below(1, 1, &parents), 0);
        assert_eq!(depth_below(11, 1, &parents), 2);
        assert_eq!(depth_below(12, 1, &parents), 3);
        assert_eq!(depth_below(20, 1, &parents), DETACHED_DEPTH);
    }
}
