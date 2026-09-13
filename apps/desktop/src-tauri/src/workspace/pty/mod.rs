// SPDX-License-Identifier: Apache-2.0
//! Costura portavel do PTY: spawn, primeiro plano e encerramento da arvore.

#[cfg(test)]
use std::path::PathBuf;

use portable_pty::{
    Child, ChildKiller, CommandBuilder, MasterPty, PtyPair, PtySize, native_pty_system,
};

use super::procs::ProcSource;
pub use crate::platform::ShellFlavor;
#[cfg(test)]
use crate::platform::ShellSpec;

#[cfg(unix)]
mod unix;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(unix)]
use unix as backend;
#[cfg(target_os = "windows")]
use windows as backend;

#[derive(Clone)]
pub(crate) struct ProcessTree(backend::ProcessTree);

pub(crate) struct SpawnedShell {
    pub pair: PtyPair,
    pub child: Box<dyn Child + Send + Sync>,
    pub tree: Option<ProcessTree>,
}

pub(crate) fn spawn_shell(command: CommandBuilder, size: PtySize) -> Result<SpawnedShell, String> {
    let pair = native_pty_system()
        .openpty(size)
        .map_err(|error| format!("Não foi possível abrir o PTY: {error}"))?;
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("Não foi possível iniciar o shell: {error}"))?;
    let tree = match backend::assign_tree(child.process_id()) {
        Ok(tree) => tree.map(ProcessTree),
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Não foi possível isolar a árvore do terminal: {error}"
            ));
        }
    };
    Ok(SpawnedShell { pair, child, tree })
}

pub(crate) fn graceful_kill(killer: &mut dyn ChildKiller) {
    let _ = killer.kill();
}

pub(crate) fn force_kill_tree(pid: Option<u32>, tree: Option<&ProcessTree>) {
    backend::force_kill_tree(pid, tree.map(|tree| &tree.0));
}

pub(crate) fn foreground_pid(
    master: &dyn MasterPty,
    shell_pid: Option<u32>,
    source: &dyn ProcSource,
) -> Option<u32> {
    backend::foreground_pid(master, shell_pid, source)
}

/// Shell minimo e sem arquivos de inicializacao para testes por sistema.
#[cfg(test)]
#[derive(Clone, Debug)]
pub(crate) struct TestShell {
    spec: ShellSpec,
    cwd: PathBuf,
}

#[cfg(test)]
impl TestShell {
    pub(crate) fn isolated() -> Self {
        #[cfg(unix)]
        let spec = ShellSpec::new("/bin/sh", Vec::new());
        #[cfg(target_os = "windows")]
        let spec = ShellSpec::new(
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into()),
            vec!["/Q".into()],
        );
        Self {
            spec,
            cwd: std::env::temp_dir(),
        }
    }

    pub(crate) fn spec(&self) -> &ShellSpec {
        &self.spec
    }

    pub(crate) fn cwd(&self) -> &str {
        self.cwd.to_str().expect("pasta temporaria em UTF-8")
    }

    pub(crate) fn print_and_exit(&self, text: &str, code: u8) -> Vec<u8> {
        match self.spec.flavor {
            ShellFlavor::Posix => format!(
                "printf '%s\\n' '{}'; exit {code}\n",
                text.replace('\'', "'\\''")
            )
            .into_bytes(),
            ShellFlavor::Powershell => format!(
                "Write-Output '{}'; exit {code}\r\n",
                text.replace('\'', "''")
            )
            .into_bytes(),
            ShellFlavor::Cmd => format!("echo {text} & exit /b {code}\r\n").into_bytes(),
        }
    }

    pub(crate) fn print(&self, text: &str) -> Vec<u8> {
        match self.spec.flavor {
            ShellFlavor::Posix => {
                format!("printf '%s\\n' '{}'\n", text.replace('\'', "'\\''")).into_bytes()
            }
            ShellFlavor::Powershell => {
                format!("Write-Output '{}'\r\n", text.replace('\'', "''")).into_bytes()
            }
            ShellFlavor::Cmd => format!("echo {text}\r\n").into_bytes(),
        }
    }

    pub(crate) fn exit(&self) -> Vec<u8> {
        match self.spec.flavor {
            ShellFlavor::Posix => b"exit\n".to_vec(),
            ShellFlavor::Powershell => b"exit\r\n".to_vec(),
            ShellFlavor::Cmd => b"exit /b\r\n".to_vec(),
        }
    }

    pub(crate) fn burn_cpu(&self) -> Vec<u8> {
        match self.spec.flavor {
            ShellFlavor::Posix => b"yes > /dev/null\n".to_vec(),
            ShellFlavor::Powershell | ShellFlavor::Cmd => b"powershell.exe -NoLogo -NoProfile -Command \"while ($true) { [void][Math]::Sqrt(144) }\"\r\n".to_vec(),
        }
    }

    pub(crate) fn cpu_process(&self, command: &str) -> bool {
        match self.spec.flavor {
            ShellFlavor::Posix => command == "yes",
            ShellFlavor::Powershell | ShellFlavor::Cmd => {
                command.eq_ignore_ascii_case("powershell.exe")
                    || command.eq_ignore_ascii_case("powershell")
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shell_matches_the_host_and_has_portable_commands() {
        let shell = TestShell::isolated();
        assert!(std::path::Path::new(shell.cwd()).is_dir());
        assert_eq!(
            shell.spec().flavor,
            ShellFlavor::from_path(&shell.spec().path)
        );
        let command = String::from_utf8(shell.print_and_exit("cialai", 7)).unwrap();
        assert!(command.contains("cialai"));
        assert!(command.contains('7'));
        assert!(!shell.print("cialai").is_empty());
        assert!(!shell.exit().is_empty());
        assert!(!shell.burn_cpu().is_empty());
        assert!(shell.cpu_process(if cfg!(windows) {
            "powershell.exe"
        } else {
            "yes"
        }));
    }
}
