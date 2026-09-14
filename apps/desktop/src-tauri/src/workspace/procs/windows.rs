// SPDX-License-Identifier: Apache-2.0
//! Backend Windows sobre `sysinfo`, completado por Job Objects e pelo contador
//! de working set privado da API de processos.

use std::collections::{HashMap, HashSet};
use std::ffi::OsStr;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use sysinfo::{Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System};
use windows_sys::Win32::Foundation::CloseHandle;
use windows_sys::Win32::System::ProcessStatus::{
    GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS, PROCESS_MEMORY_COUNTERS_EX2,
};
use windows_sys::Win32::System::Threading::{
    OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ,
};

use crate::platform::win_job;

use super::{
    CommandLine, ENV_OF_INTEREST, MAX_ENV_ENTRIES, ProcInfo, ProcState, Usage, bounded_descendants,
};

#[derive(Debug)]
pub(super) struct Backend {
    system: Mutex<System>,
}

impl Default for Backend {
    fn default() -> Self {
        Self {
            system: Mutex::new(System::new_all()),
        }
    }
}

impl Backend {
    pub(super) fn refresh(&self) {
        lock(&self.system).refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::everything().without_tasks(),
        );
    }

    pub(super) fn children(&self, pid: u32) -> Vec<u32> {
        let system = lock(&self.system);
        child_ids(&system, pid)
    }

    pub(super) fn descendants(&self, pid: u32) -> Vec<u32> {
        let mut members = bounded_descendants(pid, |current| self.children(current));
        members.extend(
            win_job::members_for(pid)
                .into_iter()
                .filter(|member| *member != pid),
        );
        members.sort_unstable();
        members.dedup();
        members.truncate(super::MAX_TREE);
        members
    }

    pub(super) fn usage(&self, pid: u32) -> Option<Usage> {
        let system = lock(&self.system);
        let process = system.process(Pid::from_u32(pid))?;
        Some(Usage {
            cpu_nanos: process.accumulated_cpu_time().saturating_mul(1_000_000),
            footprint: private_working_set(pid).unwrap_or_else(|| process.memory()),
        })
    }

    pub(super) fn info(&self, pid: u32) -> Option<ProcInfo> {
        let system = lock(&self.system);
        let process = system.process(Pid::from_u32(pid))?;
        let name = preferred_name(process.exe(), process.name());
        Some(ProcInfo {
            pid,
            ppid: process.parent().map(Pid::as_u32).unwrap_or_default(),
            pgid: 0,
            state: state_from_sysinfo(process.status()),
            comm: process.name().to_string_lossy().to_string(),
            name,
            start_sec: process.start_time(),
        })
    }

    pub(super) fn name(&self, pid: u32) -> Option<String> {
        let system = lock(&self.system);
        let process = system.process(Pid::from_u32(pid))?;
        Some(preferred_name(process.exe(), process.name()))
    }

    pub(super) fn exe_path(&self, pid: u32) -> Option<String> {
        lock(&self.system)
            .process(Pid::from_u32(pid))?
            .exe()
            .map(|path| path.to_string_lossy().to_string())
            .filter(|path| !path.is_empty())
    }

    pub(super) fn cwd(&self, pid: u32) -> Option<String> {
        lock(&self.system)
            .process(Pid::from_u32(pid))?
            .cwd()
            .map(|path| path.to_string_lossy().to_string())
            .filter(|path| !path.is_empty())
    }

    pub(super) fn open_files(&self, _pid: u32) -> Vec<String> {
        Vec::new()
    }

    pub(super) fn command_line(&self, pid: u32) -> Option<CommandLine> {
        let system = lock(&self.system);
        let process = system.process(Pid::from_u32(pid))?;
        let exe = process
            .exe()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_default();
        let argv = process
            .cmd()
            .iter()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        if exe.is_empty() && argv.is_empty() {
            return None;
        }
        Some(CommandLine {
            exe,
            argv,
            env: allowed_environment(process.environ()),
        })
    }

    pub(super) fn foreground_pid(&self, shell_pid: u32) -> Option<u32> {
        let system = lock(&self.system);
        let mut candidates = win_job::members_for(shell_pid);
        candidates.extend(descendant_ids(&system, shell_pid));
        candidates.sort_unstable();
        candidates.dedup();
        choose_foreground(
            shell_pid,
            candidates.into_iter().filter_map(|pid| {
                let process = system.process(Pid::from_u32(pid))?;
                Some(ForegroundCandidate {
                    pid,
                    parent: process.parent().map(Pid::as_u32),
                    start_sec: process.start_time(),
                    usable: !matches!(
                        process.status(),
                        ProcessStatus::Dead | ProcessStatus::Zombie
                    ),
                })
            }),
        )
    }
}

fn child_ids(system: &System, pid: u32) -> Vec<u32> {
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

fn descendant_ids(system: &System, pid: u32) -> Vec<u32> {
    bounded_descendants(pid, |current| child_ids(system, current))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ForegroundCandidate {
    pid: u32,
    parent: Option<u32>,
    start_sec: u64,
    usable: bool,
}

fn choose_foreground(
    shell_pid: u32,
    candidates: impl IntoIterator<Item = ForegroundCandidate>,
) -> Option<u32> {
    let candidates = candidates
        .into_iter()
        .filter(|candidate| candidate.pid != shell_pid && candidate.usable)
        .collect::<Vec<_>>();
    let parents = candidates
        .iter()
        .filter_map(|candidate| candidate.parent)
        .collect::<HashSet<_>>();
    candidates
        .iter()
        .filter(|candidate| !parents.contains(&candidate.pid))
        .max_by_key(|candidate| (candidate.start_sec, candidate.pid))
        .map(|candidate| candidate.pid)
}

fn private_working_set(pid: u32) -> Option<u64> {
    // SAFETY: o handle e usado apenas durante a consulta e fechado abaixo.
    let process = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, 0, pid) };
    if process.is_null() {
        return None;
    }
    let mut counters = PROCESS_MEMORY_COUNTERS_EX2 {
        cb: std::mem::size_of::<PROCESS_MEMORY_COUNTERS_EX2>() as u32,
        ..Default::default()
    };
    // SAFETY: PROCESS_MEMORY_COUNTERS_EX2 com `cb` correto estende o prefixo
    // PROCESS_MEMORY_COUNTERS aceito pela API.
    let ok = unsafe {
        GetProcessMemoryInfo(
            process,
            &mut counters as *mut _ as *mut PROCESS_MEMORY_COUNTERS,
            counters.cb,
        )
    };
    // SAFETY: o handle nao e guardado.
    unsafe {
        CloseHandle(process);
    }
    // `PrivateWorkingSetSize` so e preenchido a partir do Windows 11; nas versoes
    // anteriores a chamada funciona e o campo fica zerado. Sem o valor, quem chama
    // usa o working set do sysinfo em vez de somar zero.
    (ok != 0 && counters.PrivateWorkingSetSize > 0).then_some(counters.PrivateWorkingSetSize as u64)
}

fn state_from_sysinfo(status: ProcessStatus) -> ProcState {
    match status {
        ProcessStatus::Run => ProcState::Running,
        ProcessStatus::Sleep | ProcessStatus::Idle => ProcState::Sleeping,
        ProcessStatus::Zombie | ProcessStatus::Dead => ProcState::Zombie,
        _ => ProcState::Other,
    }
}

fn preferred_name(exe: Option<&Path>, comm: &OsStr) -> String {
    exe.and_then(Path::file_name)
        .filter(|name| !name.is_empty())
        .unwrap_or(comm)
        .to_string_lossy()
        .to_string()
}

fn allowed_environment(values: &[std::ffi::OsString]) -> HashMap<String, String> {
    values
        .iter()
        .take(MAX_ENV_ENTRIES)
        .filter_map(|value| {
            let text = value.to_string_lossy();
            let (name, value) = text.split_once('=')?;
            ENV_OF_INTEREST
                .contains(&name)
                .then(|| (name.to_string(), value.to_string()))
        })
        .collect()
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn foreground_is_the_newest_live_leaf() {
        let candidates = [
            ForegroundCandidate {
                pid: 11,
                parent: Some(10),
                start_sec: 100,
                usable: true,
            },
            ForegroundCandidate {
                pid: 12,
                parent: Some(11),
                start_sec: 101,
                usable: true,
            },
            ForegroundCandidate {
                pid: 13,
                parent: Some(10),
                start_sec: 102,
                usable: false,
            },
        ];
        assert_eq!(choose_foreground(10, candidates), Some(12));
    }

    #[test]
    fn reads_the_current_windows_process() {
        let backend = Backend::default();
        backend.refresh();
        let pid = std::process::id();
        assert_eq!(backend.info(pid).unwrap().pid, pid);
        assert!(backend.usage(pid).is_some());
        assert!(backend.cwd(pid).is_some());
        assert!(backend.command_line(pid).is_some());
    }
}
