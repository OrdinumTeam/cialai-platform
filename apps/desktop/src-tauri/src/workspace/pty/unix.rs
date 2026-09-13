// SPDX-License-Identifier: Apache-2.0

use std::io;

use portable_pty::MasterPty;

use super::super::procs::ProcSource;

#[derive(Clone)]
pub(super) struct ProcessTree;

pub(super) fn assign_tree(_pid: Option<u32>) -> io::Result<Option<ProcessTree>> {
    Ok(None)
}

pub(super) fn force_kill_tree(pid: Option<u32>, _tree: Option<&ProcessTree>) {
    if let Some(pid) = pid {
        // SAFETY: o pid veio do filho criado pelo PTY; ESRCH e ignorado.
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

pub(super) fn foreground_pid(
    master: &dyn MasterPty,
    shell_pid: Option<u32>,
    source: &dyn ProcSource,
) -> Option<u32> {
    master
        .process_group_leader()
        .filter(|pid| *pid > 0)
        .map(|pid| pid as u32)
        .or_else(|| shell_pid.and_then(|pid| source.foreground_pid(pid)))
}
