// SPDX-License-Identifier: Apache-2.0
//! Backend Linux: `sysinfo` fornece o snapshot portavel e `/proc` completa
//! filhos por thread, grupo do terminal, PSS e arquivos abertos.
//!
//! Do snapshot saem tempo de CPU, pai e inicio, alem das reservas de filhos,
//! estado e RSS. O `sysinfo` le pasta atual, executavel, argv e ambiente uma
//! unica vez por processo, e o pid mantem esses valores mesmo depois de um
//! `cd` ou de um `exec`. Por isso esses campos vem do `/proc` a cada chamada.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};

use super::{
    CommandLine, ENV_OF_INTEREST, MAX_ENV_ENTRIES, ProcInfo, ProcState, Usage, bounded_descendants,
};

#[derive(Debug)]
pub(super) struct Backend {
    system: Mutex<System>,
    proc_root: PathBuf,
}

impl Default for Backend {
    fn default() -> Self {
        Self {
            system: Mutex::new(System::new_all()),
            proc_root: PathBuf::from("/proc"),
        }
    }
}

impl Backend {
    #[cfg(test)]
    fn at(proc_root: PathBuf) -> Self {
        Self {
            system: Mutex::new(System::new_all()),
            proc_root,
        }
    }

    pub(super) fn refresh(&self) {
        lock(&self.system).refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
    }

    pub(super) fn children(&self, pid: u32) -> Vec<u32> {
        if let Some(children) = task_children(&self.proc_root, pid) {
            return children;
        }
        let system = lock(&self.system);
        let mut children = system
            .processes()
            .values()
            .filter(|process| {
                process
                    .parent()
                    .is_some_and(|parent| parent.as_u32() == pid)
            })
            .map(|process| process.pid().as_u32())
            .collect::<Vec<_>>();
        children.sort_unstable();
        children.dedup();
        children
    }

    pub(super) fn descendants(&self, pid: u32) -> Vec<u32> {
        bounded_descendants(pid, |current| self.children(current))
    }

    pub(super) fn usage(&self, pid: u32) -> Option<Usage> {
        let pss = pss_bytes(&self.proc_root.join(pid.to_string()).join("smaps_rollup"));
        let system = lock(&self.system);
        let process = system.process(Pid::from_u32(pid))?;
        Some(Usage {
            cpu_nanos: process.accumulated_cpu_time().saturating_mul(1_000_000),
            footprint: pss.unwrap_or_else(|| process.memory()),
        })
    }

    pub(super) fn info(&self, pid: u32) -> Option<ProcInfo> {
        let stat = read_stat(&self.proc_root, pid);
        let exe = read_exe(&self.proc_root, pid);
        let system = lock(&self.system);
        let process = system.process(Pid::from_u32(pid))?;
        let state = stat
            .as_ref()
            .map(|value| value.state)
            .unwrap_or_else(|| state_from_sysinfo(process.status()));
        let comm = stat
            .as_ref()
            .map(|value| value.comm.clone())
            .unwrap_or_else(|| process.name().to_string_lossy().to_string());
        let name = preferred_name(exe.as_deref(), &comm);
        Some(ProcInfo {
            pid,
            ppid: process.parent().map(Pid::as_u32).unwrap_or_default(),
            pgid: stat.as_ref().map(|value| value.pgid).unwrap_or(pid),
            state,
            comm,
            name,
            start_sec: process.start_time(),
        })
    }

    pub(super) fn name(&self, pid: u32) -> Option<String> {
        let comm = read_stat(&self.proc_root, pid)?.comm;
        Some(preferred_name(
            read_exe(&self.proc_root, pid).as_deref(),
            &comm,
        ))
    }

    pub(super) fn exe_path(&self, pid: u32) -> Option<String> {
        read_exe(&self.proc_root, pid).map(|path| path.to_string_lossy().to_string())
    }

    pub(super) fn cwd(&self, pid: u32) -> Option<String> {
        read_link_path(&self.proc_root.join(pid.to_string()).join("cwd"))
            .map(|path| path.to_string_lossy().to_string())
    }

    pub(super) fn open_files(&self, pid: u32) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.proc_root.join(pid.to_string()).join("fd")) else {
            return Vec::new();
        };
        let mut paths = entries
            .flatten()
            .filter_map(|entry| fs::read_link(entry.path()).ok())
            .filter(|path| path.is_absolute())
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        paths.sort();
        paths.dedup();
        paths
    }

    pub(super) fn command_line(&self, pid: u32) -> Option<CommandLine> {
        let dir = self.proc_root.join(pid.to_string());
        let exe = read_exe(&self.proc_root, pid)
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();
        let argv = fs::read(dir.join("cmdline"))
            .map(|raw| nul_separated(&raw))
            .unwrap_or_default();
        if exe.is_empty() && argv.is_empty() {
            return None;
        }
        // Sem permissao, como num processo nao despejavel, o ambiente fica vazio.
        let environ = fs::read(dir.join("environ"))
            .map(|raw| nul_separated(&raw))
            .unwrap_or_default();
        let env = allowed_environment(&environ);
        Some(CommandLine { exe, argv, env })
    }

    pub(super) fn foreground_pid(&self, shell_pid: u32) -> Option<u32> {
        read_stat(&self.proc_root, shell_pid)?.foreground_pgid
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn task_children(proc_root: &Path, pid: u32) -> Option<Vec<u32>> {
    let entries = fs::read_dir(proc_root.join(pid.to_string()).join("task")).ok()?;
    let mut readable = false;
    let mut children = HashSet::new();
    for entry in entries.flatten() {
        let Ok(text) = fs::read_to_string(entry.path().join("children")) else {
            continue;
        };
        readable = true;
        children.extend(
            text.split_ascii_whitespace()
                .filter_map(|value| value.parse::<u32>().ok())
                .filter(|child| *child != pid),
        );
    }
    if !readable {
        return None;
    }
    let mut children = children.into_iter().collect::<Vec<_>>();
    children.sort_unstable();
    Some(children)
}

#[derive(Debug, PartialEq, Eq)]
struct LinuxStat {
    comm: String,
    state: ProcState,
    pgid: u32,
    foreground_pgid: Option<u32>,
}

fn read_stat(proc_root: &Path, pid: u32) -> Option<LinuxStat> {
    let text = fs::read_to_string(proc_root.join(pid.to_string()).join("stat")).ok()?;
    parse_stat(&text)
}

fn parse_stat(text: &str) -> Option<LinuxStat> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let comm = text.get(open + 1..close)?.to_string();
    let fields = text
        .get(close + 1..)?
        .split_ascii_whitespace()
        .collect::<Vec<_>>();
    let state = state_from_code(fields.first()?.chars().next()?);
    let pgid = fields.get(2)?.parse::<u32>().ok()?;
    let foreground_pgid = fields
        .get(5)
        .and_then(|value| value.parse::<i64>().ok())
        .filter(|value| *value > 0)
        .map(|value| value as u32);
    Some(LinuxStat {
        comm,
        state,
        pgid,
        foreground_pgid,
    })
}

fn state_from_code(code: char) -> ProcState {
    match code {
        'R' => ProcState::Running,
        'S' | 'D' | 'I' => ProcState::Sleeping,
        'T' | 't' => ProcState::Stopped,
        'Z' => ProcState::Zombie,
        _ => ProcState::Other,
    }
}

fn state_from_sysinfo(status: ProcessStatus) -> ProcState {
    match status {
        ProcessStatus::Run => ProcState::Running,
        ProcessStatus::Sleep | ProcessStatus::Idle => ProcState::Sleeping,
        ProcessStatus::Stop | ProcessStatus::Tracing => ProcState::Stopped,
        ProcessStatus::Zombie | ProcessStatus::Dead => ProcState::Zombie,
        _ => ProcState::Other,
    }
}

fn preferred_name(exe: Option<&Path>, comm: &str) -> String {
    exe.and_then(Path::file_name)
        .map(|name| name.to_string_lossy().to_string())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| comm.to_string())
}

fn read_link_path(link: &Path) -> Option<PathBuf> {
    let path = fs::read_link(link).ok()?;
    (!path.as_os_str().is_empty()).then_some(path)
}

/// Executavel atual. Um binario trocado em disco com o processo vivo, como
/// numa atualizacao do agente, vem com o sufixo ` (deleted)`, que sai aqui.
fn read_exe(proc_root: &Path, pid: u32) -> Option<PathBuf> {
    let path = read_link_path(&proc_root.join(pid.to_string()).join("exe"))?;
    let text = path.to_string_lossy();
    Some(match text.strip_suffix(" (deleted)") {
        Some(stripped) => PathBuf::from(stripped),
        None => path,
    })
}

/// `cmdline` e `environ` separados por NUL. Quem reescreve o proprio titulo
/// deixa NULs e espacos sobrando no fim, e essas sobras nao viram argumento.
fn nul_separated(raw: &[u8]) -> Vec<String> {
    raw.split(|byte| *byte == 0)
        .map(|part| String::from_utf8_lossy(part).trim().to_string())
        .filter(|part| !part.is_empty())
        .collect()
}

fn pss_bytes(path: &Path) -> Option<u64> {
    let text = fs::read_to_string(path).ok()?;
    text.lines().find_map(|line| {
        let mut fields = line.split_ascii_whitespace();
        (fields.next()? == "Pss:").then(|| fields.next()?.parse::<u64>().ok()?.checked_mul(1024))?
    })
}

fn allowed_environment(values: &[String]) -> HashMap<String, String> {
    values
        .iter()
        .take(MAX_ENV_ENTRIES)
        .filter_map(|text| {
            let (name, value) = text.split_once('=')?;
            ENV_OF_INTEREST
                .contains(&name)
                .then(|| (name.to_string(), value.to_string()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "cialai-linux-procs-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn parses_stat_with_spaces_and_stopped_states() {
        let stat = parse_stat("42 (agente com espacos) T 1 40 40 34816 41 0 0").unwrap();
        assert_eq!(stat.comm, "agente com espacos");
        assert_eq!(stat.state, ProcState::Stopped);
        assert_eq!(stat.pgid, 40);
        assert_eq!(stat.foreground_pgid, Some(41));
        assert_eq!(state_from_code('t'), ProcState::Stopped);
    }

    #[test]
    fn reads_pss_in_bytes_and_task_children_without_duplicates() {
        let root = sandbox("proc");
        let process = root.join("42");
        fs::create_dir_all(process.join("task/42")).unwrap();
        fs::create_dir_all(process.join("task/43")).unwrap();
        fs::write(process.join("smaps_rollup"), "Rss: 99 kB\nPss: 17 kB\n").unwrap();
        fs::write(process.join("task/42/children"), "7 8\n").unwrap();
        fs::write(process.join("task/43/children"), "8 9\n").unwrap();
        assert_eq!(pss_bytes(&process.join("smaps_rollup")), Some(17 * 1024));
        assert_eq!(task_children(&root, 42), Some(vec![7, 8, 9]));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rereads_cwd_executable_argv_and_environment_of_the_same_pid() {
        let root = sandbox("fresco");
        let process = root.join("42");
        fs::create_dir_all(&process).unwrap();
        let link = |target: &str, name: &str| {
            let _ = fs::remove_file(process.join(name));
            std::os::unix::fs::symlink(target, process.join(name)).unwrap();
        };
        link("/projeto/antes", "cwd");
        link("/usr/bin/bash", "exe");
        fs::write(process.join("cmdline"), b"-bash\0").unwrap();
        fs::write(process.join("environ"), b"HOME=/h\0").unwrap();
        let backend = Backend::at(root.clone());
        backend.refresh();
        assert_eq!(backend.cwd(42).as_deref(), Some("/projeto/antes"));
        assert_eq!(backend.command_line(42).unwrap().argv, vec!["-bash"]);

        // `cd` no shell e `exec` do lancador mantem o pid; a leitura seguinte ve os dois.
        link("/projeto/depois", "cwd");
        link("/opt/codex/bin/codex (deleted)", "exe");
        fs::write(process.join("cmdline"), b"codex\0resume\0\0  \0").unwrap();
        fs::write(
            process.join("environ"),
            b"CODEX_HOME=/h/.local/share/webrota-ai/codex/7\0SEGREDO_QUALQUER=x\0",
        )
        .unwrap();
        backend.refresh();
        assert_eq!(backend.cwd(42).as_deref(), Some("/projeto/depois"));
        assert_eq!(
            backend.exe_path(42).as_deref(),
            Some("/opt/codex/bin/codex")
        );
        let command = backend.command_line(42).unwrap();
        assert_eq!(command.exe, "/opt/codex/bin/codex");
        assert_eq!(command.argv, vec!["codex", "resume"]);
        assert_eq!(
            command.env.get("CODEX_HOME").map(String::as_str),
            Some("/h/.local/share/webrota-ai/codex/7")
        );
        assert_eq!(command.env.len(), 1);
        assert!(backend.command_line(43).is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_the_current_linux_process() {
        let backend = Backend::at(PathBuf::from("/proc"));
        backend.refresh();
        let pid = std::process::id();
        let info = backend.info(pid).expect("processo atual");
        assert_eq!(info.pid, pid);
        assert!(!backend.name(pid).unwrap().is_empty());
        assert!(backend.cwd(pid).is_some());
        assert!(backend.usage(pid).is_some());
        assert!(backend.command_line(pid).is_some());
    }
}
