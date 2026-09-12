// SPDX-License-Identifier: Apache-2.0
//! Backend Windows. A implementacao com `sysinfo` e Job Objects entra na 5.3.

use super::{CommandLine, ProcInfo, Usage};

pub(super) fn children(_pid: u32) -> Vec<u32> {
    Vec::new()
}

pub(super) fn descendants(pid: u32) -> Vec<u32> {
    super::bounded_descendants(pid, children)
}

pub(super) fn usage(_pid: u32) -> Option<Usage> {
    None
}

pub(super) fn info(_pid: u32) -> Option<ProcInfo> {
    None
}

pub(super) fn name(_pid: u32) -> Option<String> {
    None
}

pub(super) fn exe_path(_pid: u32) -> Option<String> {
    None
}

pub(super) fn cwd(_pid: u32) -> Option<String> {
    None
}

pub(super) fn open_files(_pid: u32) -> Vec<String> {
    Vec::new()
}

pub(super) fn command_line(_pid: u32) -> Option<CommandLine> {
    None
}
