// SPDX-License-Identifier: Apache-2.0

use std::io;

use portable_pty::MasterPty;

use super::super::procs::ProcSource;
use crate::platform::win_job;

#[derive(Clone)]
pub(super) struct ProcessTree(win_job::JobHandle);

pub(super) fn assign_tree(pid: Option<u32>) -> io::Result<Option<ProcessTree>> {
    pid.map(win_job::assign)
        .transpose()
        .map(|job| job.map(ProcessTree))
}

pub(super) fn force_kill_tree(_pid: Option<u32>, tree: Option<&ProcessTree>) {
    if let Some(tree) = tree {
        let _ = tree.0.terminate();
    }
}

pub(super) fn foreground_pid(
    _master: &dyn MasterPty,
    shell_pid: Option<u32>,
    source: &dyn ProcSource,
) -> Option<u32> {
    shell_pid.and_then(|pid| source.foreground_pid(pid))
}
