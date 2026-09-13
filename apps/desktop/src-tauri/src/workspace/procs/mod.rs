// SPDX-License-Identifier: Apache-2.0
//! Inspecao portavel da arvore de processos das sessoes.
//!
//! Os backends entregam os mesmos campos e deixam a politica de medicao no
//! [`TerminalManager`](crate::workspace::terminal::TerminalManager). A trait
//! existe nessa unica costura para que os calculos de CPU, memoria e agente
//! sejam testados sem depender da tabela de processos do host.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
use linux as backend;
#[cfg(target_os = "macos")]
use macos as backend;
#[cfg(target_os = "windows")]
use windows as backend;

/// Limites compartilhados pelos tres backends.
pub(super) const MAX_TREE: usize = 512;
pub(super) const MAX_DEPTH: usize = 16;
pub(super) const MAX_ENV_ENTRIES: usize = 4096;
pub(super) const ENV_OF_INTEREST: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_PROFILE",
    "CODEX_HOME",
    "CODEX_PROFILE",
];

/// Tempo de CPU acumulado em nanossegundos e memoria atribuida em bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Usage {
    pub cpu_nanos: u64,
    pub footprint: u64,
}

/// Estado portavel necessario para descrever o processo em primeiro plano.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum ProcState {
    Running,
    Sleeping,
    Stopped,
    Zombie,
    #[default]
    Other,
}

/// Informacao basica comum aos backends de processo.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: u32,
    pub state: ProcState,
    pub comm: String,
    pub name: String,
    pub start_sec: u64,
}

/// Linha de comando e apenas as variaveis que identificam perfis de agente.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CommandLine {
    pub exe: String,
    pub argv: Vec<String>,
    pub env: HashMap<String, String>,
}

/// Fonte unica consumida pelas metricas. Implementacoes devem devolver
/// ausencia quando o sistema negar acesso, sem fabricar valores.
pub trait ProcSource: Send + Sync {
    fn refresh(&self) {}

    fn children(&self, pid: u32) -> Vec<u32>;
    fn usage(&self, pid: u32) -> Option<Usage>;
    fn info(&self, pid: u32) -> Option<ProcInfo>;
    fn name(&self, pid: u32) -> Option<String>;
    fn exe_path(&self, pid: u32) -> Option<String>;
    fn cwd(&self, pid: u32) -> Option<String>;
    fn open_files(&self, pid: u32) -> Vec<String>;
    fn command_line(&self, pid: u32) -> Option<CommandLine>;

    fn foreground_pid(&self, _shell_pid: u32) -> Option<u32> {
        None
    }

    fn descendants(&self, pid: u32) -> Vec<u32> {
        bounded_descendants(pid, |current| self.children(current))
    }
}

/// Backend real selecionado em compilacao.
#[derive(Debug, Default)]
pub struct SystemProcs {
    backend: backend::Backend,
}

impl ProcSource for SystemProcs {
    fn refresh(&self) {
        self.backend.refresh();
    }

    fn children(&self, pid: u32) -> Vec<u32> {
        self.backend.children(pid)
    }

    fn descendants(&self, pid: u32) -> Vec<u32> {
        self.backend.descendants(pid)
    }

    fn usage(&self, pid: u32) -> Option<Usage> {
        self.backend.usage(pid)
    }

    fn info(&self, pid: u32) -> Option<ProcInfo> {
        self.backend.info(pid)
    }

    fn name(&self, pid: u32) -> Option<String> {
        self.backend.name(pid)
    }

    fn exe_path(&self, pid: u32) -> Option<String> {
        self.backend.exe_path(pid)
    }

    fn cwd(&self, pid: u32) -> Option<String> {
        self.backend.cwd(pid)
    }

    fn open_files(&self, pid: u32) -> Vec<String> {
        self.backend.open_files(pid)
    }

    fn command_line(&self, pid: u32) -> Option<CommandLine> {
        self.backend.command_line(pid)
    }

    fn foreground_pid(&self, shell_pid: u32) -> Option<u32> {
        self.backend.foreground_pid(shell_pid)
    }
}

pub fn system() -> &'static SystemProcs {
    static SYSTEM: std::sync::OnceLock<SystemProcs> = std::sync::OnceLock::new();
    SYSTEM.get_or_init(SystemProcs::default)
}

pub fn children(pid: u32) -> Vec<u32> {
    let source = system();
    source.refresh();
    source.children(pid)
}

pub fn descendants(pid: u32) -> Vec<u32> {
    let source = system();
    source.refresh();
    source.descendants(pid)
}

pub fn usage(pid: u32) -> Option<Usage> {
    let source = system();
    source.refresh();
    source.usage(pid)
}

pub fn info(pid: u32) -> Option<ProcInfo> {
    let source = system();
    source.refresh();
    source.info(pid)
}

pub fn name(pid: u32) -> Option<String> {
    let source = system();
    source.refresh();
    source.name(pid)
}

pub fn exe_path(pid: u32) -> Option<String> {
    let source = system();
    source.refresh();
    source.exe_path(pid)
}

pub fn cwd(pid: u32) -> Option<String> {
    let source = system();
    source.refresh();
    source.cwd(pid)
}

pub fn open_files(pid: u32) -> Vec<String> {
    let source = system();
    source.refresh();
    source.open_files(pid)
}

pub fn command_line(pid: u32) -> Option<CommandLine> {
    let source = system();
    source.refresh();
    source.command_line(pid)
}

pub(super) fn bounded_descendants(pid: u32, mut children: impl FnMut(u32) -> Vec<u32>) -> Vec<u32> {
    let mut result = Vec::new();
    let mut frontier = vec![(pid, 0usize)];
    while let Some((current, depth)) = frontier.pop() {
        if depth >= MAX_DEPTH {
            continue;
        }
        for child in children(current) {
            if result.len() >= MAX_TREE {
                return result;
            }
            if child == pid || result.contains(&child) {
                continue;
            }
            result.push(child);
            frontier.push((child, depth + 1));
        }
    }
    result
}

/// Slug do perfil a partir da pasta de configuracao.
pub fn profile_slug(dir: &Path) -> String {
    let name = dir
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    let slug: String = name
        .trim_start_matches('.')
        .to_ascii_lowercase()
        .chars()
        .filter(|value| value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-'))
        .collect();
    if slug.is_empty() {
        "perfil".to_string()
    } else {
        slug
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentProfile {
    pub config_dir: String,
    pub slug: String,
    pub name: Option<String>,
    pub explicit: bool,
}

pub fn agent_profile(command: &CommandLine, agent: &str, home: &Path) -> Option<AgentProfile> {
    let (dir_key, name_key, default) = match agent {
        "Claude Code" => ("CLAUDE_CONFIG_DIR", "CLAUDE_PROFILE", ".claude"),
        "Codex" => ("CODEX_HOME", "CODEX_PROFILE", ".codex"),
        _ => return None,
    };
    let configured = command
        .env
        .get(dir_key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let explicit = configured.is_some();
    let dir = configured.unwrap_or_else(|| home.join(default));
    let resolved = dir.canonicalize().unwrap_or(dir);
    Some(AgentProfile {
        config_dir: resolved.to_string_lossy().to_string(),
        slug: profile_slug(&resolved),
        name: command
            .env
            .get(name_key)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        explicit,
    })
}

const AGENTS: &[(&str, &[&str])] = &[
    ("Claude Code", &["claude", "claude-code"]),
    ("Codex", &["codex", "codex-cli"]),
    ("Gemini CLI", &["gemini", "gemini-cli"]),
    ("Aider", &["aider", "aider-chat"]),
    ("OpenCode", &["opencode", "opencode-ai"]),
    ("Cursor Agent", &["cursor-agent"]),
    ("Copilot CLI", &["copilot", "github-copilot-cli"]),
    ("Goose", &["goose"]),
    ("Amp", &["amp", "amp-cli"]),
    ("Crush", &["crush"]),
    ("Kiro", &["kiro", "kiro-cli"]),
    ("Droid", &["droid"]),
    ("Cline", &["cline"]),
    ("Qwen Code", &["qwen", "qwen-code"]),
    ("Ollama", &["ollama"]),
];

const RUNTIMES: &[&str] = &[
    "node", "bun", "deno", "python", "python3", "npx", "uv", "uvx", "tsx", "ts-node",
];

fn segment_key(segment: &str) -> String {
    let lower = segment.to_ascii_lowercase();
    lower
        .rsplit_once('.')
        .filter(|(_, ext)| {
            matches!(
                *ext,
                "js" | "mjs" | "cjs" | "py" | "ts" | "sh" | "exe" | "cmd" | "bat"
            )
        })
        .map(|(stem, _)| stem.to_string())
        .unwrap_or(lower)
}

fn agent_for_segment(segment: &str) -> Option<&'static str> {
    let key = segment_key(segment);
    AGENTS
        .iter()
        .find(|(_, names)| names.iter().any(|name| *name == key))
        .map(|(label, _)| *label)
}

pub fn agent_of(command: &CommandLine) -> Option<&'static str> {
    let first = command
        .argv
        .first()
        .map(|value| basename(value))
        .unwrap_or_default();
    if let Some(agent) =
        agent_for_segment(&basename(&command.exe)).or_else(|| agent_for_segment(&first))
    {
        return Some(agent);
    }
    let runtime = RUNTIMES.contains(&segment_key(&first).as_str())
        || RUNTIMES.contains(&segment_key(&basename(&command.exe)).as_str());
    if !runtime {
        return None;
    }
    for argument in command.argv.iter().skip(1).take(4) {
        if argument.starts_with('-') && !argument.starts_with("--") {
            continue;
        }
        for segment in argument
            .split(['/', '\\'])
            .filter(|segment| !segment.is_empty())
        {
            if let Some(agent) = agent_for_segment(segment) {
                return Some(agent);
            }
        }
    }
    None
}

pub fn basename(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(path)
        .to_string()
}

#[derive(Default)]
pub struct CommandCache {
    entries: HashMap<u32, (u64, Option<CommandLine>)>,
}

impl CommandCache {
    pub fn get(&mut self, pid: u32, start_sec: u64) -> Option<CommandLine> {
        self.get_from(system(), pid, start_sec)
    }

    pub fn get_from(
        &mut self,
        source: &dyn ProcSource,
        pid: u32,
        start_sec: u64,
    ) -> Option<CommandLine> {
        if let Some((known_start, command)) = self.entries.get(&pid) {
            if *known_start == start_sec {
                return command.clone();
            }
        }
        let command = source.command_line(pid);
        self.entries.insert(pid, (start_sec, command.clone()));
        command
    }

    pub fn retain(&mut self, alive: &[u32]) {
        self.entries.retain(|pid, _| alive.contains(pid));
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct FakeProcs {
    children: std::sync::Mutex<HashMap<u32, Vec<u32>>>,
    usages: std::sync::Mutex<HashMap<u32, std::collections::VecDeque<Usage>>>,
    infos: std::sync::Mutex<HashMap<u32, ProcInfo>>,
    names: std::sync::Mutex<HashMap<u32, String>>,
    executables: std::sync::Mutex<HashMap<u32, String>>,
    directories: std::sync::Mutex<HashMap<u32, String>>,
    files: std::sync::Mutex<HashMap<u32, Vec<String>>>,
    commands: std::sync::Mutex<HashMap<u32, CommandLine>>,
}

#[cfg(test)]
impl FakeProcs {
    pub fn set_children(&self, pid: u32, children: Vec<u32>) {
        self.children.lock().unwrap().insert(pid, children);
    }

    pub fn set_usages(&self, pid: u32, usages: impl IntoIterator<Item = Usage>) {
        self.usages
            .lock()
            .unwrap()
            .insert(pid, usages.into_iter().collect());
    }

    pub fn set_info(&self, info: ProcInfo) {
        self.infos.lock().unwrap().insert(info.pid, info);
    }

    pub fn set_name(&self, pid: u32, name: impl Into<String>) {
        self.names.lock().unwrap().insert(pid, name.into());
    }

    pub fn set_cwd(&self, pid: u32, cwd: impl Into<String>) {
        self.directories.lock().unwrap().insert(pid, cwd.into());
    }

    pub fn set_command(&self, pid: u32, command: CommandLine) {
        self.commands.lock().unwrap().insert(pid, command);
    }
}

#[cfg(test)]
impl ProcSource for FakeProcs {
    fn children(&self, pid: u32) -> Vec<u32> {
        self.children
            .lock()
            .unwrap()
            .get(&pid)
            .cloned()
            .unwrap_or_default()
    }

    fn usage(&self, pid: u32) -> Option<Usage> {
        let mut usages = self.usages.lock().unwrap();
        let values = usages.get_mut(&pid)?;
        if values.len() > 1 {
            values.pop_front()
        } else {
            values.front().copied()
        }
    }

    fn info(&self, pid: u32) -> Option<ProcInfo> {
        self.infos.lock().unwrap().get(&pid).cloned()
    }

    fn name(&self, pid: u32) -> Option<String> {
        self.names.lock().unwrap().get(&pid).cloned()
    }

    fn exe_path(&self, pid: u32) -> Option<String> {
        self.executables.lock().unwrap().get(&pid).cloned()
    }

    fn cwd(&self, pid: u32) -> Option<String> {
        self.directories.lock().unwrap().get(&pid).cloned()
    }

    fn open_files(&self, pid: u32) -> Vec<String> {
        self.files
            .lock()
            .unwrap()
            .get(&pid)
            .cloned()
            .unwrap_or_default()
    }

    fn command_line(&self, pid: u32) -> Option<CommandLine> {
        self.commands.lock().unwrap().get(&pid).cloned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestChild(std::process::Child);

    impl TestChild {
        fn sleeping() -> Self {
            let child = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "workspace::procs::tests::test_child_waits_until_parent_finishes",
                    "--nocapture",
                ])
                .env("CIALAI_TEST_CHILD", "wait")
                .env("CLAUDE_PROFILE", "Teste nativo")
                .env("SEGREDO_QUALQUER", "nao-deve-aparecer")
                .current_dir(std::env::temp_dir())
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            Self(child)
        }

        fn id(&self) -> u32 {
            self.0.id()
        }
    }

    impl Drop for TestChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[test]
    fn test_child_waits_until_parent_finishes() {
        if std::env::var("CIALAI_TEST_CHILD").as_deref() == Ok("wait") {
            std::thread::sleep(std::time::Duration::from_secs(30));
        }
    }

    #[test]
    fn system_source_reads_a_native_test_child() {
        let child = TestChild::sleeping();
        let source = SystemProcs::default();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let command = loop {
            source.refresh();
            if let Some(command) = source.command_line(child.id()) {
                break command;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "o processo filho não apareceu no backend"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        };
        assert!(source.children(std::process::id()).contains(&child.id()));
        assert!(source.descendants(std::process::id()).contains(&child.id()));
        assert_eq!(source.info(child.id()).unwrap().ppid, std::process::id());
        assert!(source.usage(child.id()).is_some());
        assert!(source.cwd(child.id()).is_some());
        assert_eq!(
            command.env.get("CLAUDE_PROFILE").map(String::as_str),
            Some("Teste nativo")
        );
        assert!(!command.env.contains_key("SEGREDO_QUALQUER"));
    }

    #[test]
    fn fake_source_obeys_tree_limits_and_breaks_cycles() {
        let fake = FakeProcs::default();
        fake.set_children(1, vec![2]);
        fake.set_children(2, vec![1, 3]);
        assert_eq!(fake.descendants(1), vec![2, 3]);
    }

    #[test]
    fn agent_profile_defaults_to_home_dirs() {
        let plain = CommandLine {
            exe: "/opt/bin/claude".into(),
            argv: vec!["claude".into()],
            env: HashMap::new(),
        };
        let claude = agent_profile(&plain, "Claude Code", Path::new("/Users/x")).unwrap();
        assert_eq!(claude.slug, "claude");
        assert_eq!(claude.config_dir, "/Users/x/.claude");
        assert!(!claude.explicit);
        assert_eq!(
            agent_profile(&plain, "Gemini CLI", Path::new("/Users/x")),
            None
        );
    }

    #[test]
    fn profile_slug_rules() {
        assert_eq!(profile_slug(Path::new("/Users/x/.claude")), "claude");
        assert_eq!(
            profile_slug(Path::new("/Users/x/.codex-aamorim")),
            "codex-aamorim"
        );
        assert_eq!(profile_slug(Path::new("/")), "perfil");
    }

    #[test]
    fn detects_agents_on_posix_and_windows_command_lines() {
        let direct = CommandLine {
            exe: r"C:\\Users\\x\\AppData\\Roaming\\npm\\claude.cmd".into(),
            argv: vec!["claude.cmd".into(), "--resume".into()],
            ..Default::default()
        };
        assert_eq!(agent_of(&direct), Some("Claude Code"));
        let python = CommandLine {
            exe: "/usr/bin/python3".into(),
            argv: vec!["python3".into(), "-m".into(), "aider".into()],
            ..Default::default()
        };
        assert_eq!(agent_of(&python), Some("Aider"));
    }
}
