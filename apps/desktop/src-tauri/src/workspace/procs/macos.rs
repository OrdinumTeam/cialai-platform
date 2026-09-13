// SPDX-License-Identifier: Apache-2.0
//! Backend macOS de inspecao de processos por libproc e sysctl:
//! arvore de filhos de um pid, tempo de CPU e memoria residente, diretorio
//! atual e linha de comando. E a fonte das medicoes reais mostradas nos
//! cards de sessao. Nada aqui inventa valor: quando uma leitura falha, o
//! campo volta como `None` e a interface mostra que o dado nao esta
//! disponivel.
//!
//! Tempo de CPU: `proc_pid_rusage` devolve `ri_user_time` e `ri_system_time`
//! em unidades do relogio absoluto do Mach, que em Apple Silicon nao sao
//! nanossegundos. A conversao usa `mach_timebase_info`, como o psutil passou
//! a fazer depois do bug com os M1. Memoria: `ri_phys_footprint`, a mesma
//! coluna Memoria do Monitor de Atividade.

use std::os::raw::{c_char, c_int, c_void};
use std::sync::OnceLock;

use super::{CommandLine, ENV_OF_INTEREST, MAX_ENV_ENTRIES, ProcInfo, ProcState, Usage};

#[derive(Debug, Default)]
pub(super) struct Backend;

impl Backend {
    pub(super) fn refresh(&self) {}

    pub(super) fn children(&self, pid: u32) -> Vec<u32> {
        children(pid)
    }

    pub(super) fn descendants(&self, pid: u32) -> Vec<u32> {
        descendants(pid)
    }

    pub(super) fn usage(&self, pid: u32) -> Option<Usage> {
        usage(pid)
    }

    pub(super) fn info(&self, pid: u32) -> Option<ProcInfo> {
        info(pid)
    }

    pub(super) fn name(&self, pid: u32) -> Option<String> {
        name(pid)
    }

    pub(super) fn exe_path(&self, pid: u32) -> Option<String> {
        exe_path(pid)
    }

    pub(super) fn cwd(&self, pid: u32) -> Option<String> {
        cwd(pid)
    }

    pub(super) fn open_files(&self, pid: u32) -> Vec<String> {
        open_files(pid)
    }

    pub(super) fn command_line(&self, pid: u32) -> Option<CommandLine> {
        command_line(pid)
    }

    pub(super) fn foreground_pid(&self, _shell_pid: u32) -> Option<u32> {
        None
    }
}

#[repr(C)]
struct MachTimebaseInfo {
    numer: u32,
    denom: u32,
}

unsafe extern "C" {
    fn mach_timebase_info(info: *mut MachTimebaseInfo) -> c_int;
}

fn timebase() -> (u64, u64) {
    static TIMEBASE: OnceLock<(u64, u64)> = OnceLock::new();
    *TIMEBASE.get_or_init(|| {
        let mut info = MachTimebaseInfo { numer: 1, denom: 1 };
        // SAFETY: a struct tem o layout de mach_timebase_info_data_t.
        let status = unsafe { mach_timebase_info(&mut info) };
        if status != 0 || info.denom == 0 {
            (1, 1)
        } else {
            (u64::from(info.numer), u64::from(info.denom))
        }
    })
}

/// Converte unidades do relogio absoluto do Mach em nanossegundos.
pub(super) fn mach_to_nanos(ticks: u64) -> u64 {
    let (numer, denom) = timebase();
    ((ticks as u128 * numer as u128) / denom as u128) as u64
}

/// Filhos diretos de um pid. `proc_listchildpids` devolve a quantidade de
/// pids gravados, nao bytes, ao contrario do que a assinatura sugere.
pub(super) fn children(pid: u32) -> Vec<u32> {
    let mut capacity = 256usize;
    loop {
        let mut buffer = vec![0i32; capacity];
        let bytes = (buffer.len() * std::mem::size_of::<i32>()) as c_int;
        // SAFETY: o buffer tem `bytes` bytes validos e o kernel escreve no
        // maximo esse tanto.
        let written = unsafe {
            libc::proc_listchildpids(
                pid as libc::pid_t,
                buffer.as_mut_ptr() as *mut c_void,
                bytes,
            )
        };
        if written <= 0 {
            return Vec::new();
        }
        let count = (written as usize).min(capacity);
        if count < capacity || capacity >= 65_536 {
            buffer.truncate(count);
            return buffer
                .into_iter()
                .filter(|value| *value > 0)
                .map(|value| value as u32)
                .collect();
        }
        capacity *= 4;
    }
}

pub(super) fn descendants(pid: u32) -> Vec<u32> {
    super::bounded_descendants(pid, children)
}

pub(super) fn usage(pid: u32) -> Option<Usage> {
    let mut info: libc::rusage_info_v4 = unsafe { std::mem::zeroed() };
    // SAFETY: o buffer e uma rusage_info_v4 zerada e o flavor pede essa versao.
    let status = unsafe {
        libc::proc_pid_rusage(
            pid as c_int,
            libc::RUSAGE_INFO_V4,
            &mut info as *mut libc::rusage_info_v4 as *mut libc::rusage_info_t,
        )
    };
    if status != 0 {
        return None;
    }
    Some(Usage {
        cpu_nanos: mach_to_nanos(info.ri_user_time.saturating_add(info.ri_system_time)),
        footprint: info.ri_phys_footprint,
    })
}

pub(super) fn info(pid: u32) -> Option<ProcInfo> {
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as c_int;
    // SAFETY: buffer do tamanho da struct pedida pelo flavor.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut libc::proc_bsdinfo as *mut c_void,
            size,
        )
    };
    if written != size {
        return None;
    }
    let state = match info.pbi_status {
        libc::SRUN => ProcState::Running,
        libc::SSLEEP => ProcState::Sleeping,
        libc::SSTOP => ProcState::Stopped,
        libc::SZOMB => ProcState::Zombie,
        _ => ProcState::Other,
    };
    Some(ProcInfo {
        pid: info.pbi_pid,
        ppid: info.pbi_ppid,
        pgid: info.pbi_pgid,
        state,
        comm: chars_to_string(&info.pbi_comm),
        name: chars_to_string(&info.pbi_name),
        start_sec: info.pbi_start_tvsec,
    })
}

/// Nome do executavel, como o Monitor de Atividade mostra.
pub(super) fn name(pid: u32) -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: buffer valido de 256 bytes, tamanho passado junto.
    let written = unsafe {
        libc::proc_name(
            pid as c_int,
            buffer.as_mut_ptr() as *mut c_void,
            buffer.len() as u32,
        )
    };
    if written <= 0 {
        return None;
    }
    let text = String::from_utf8_lossy(&buffer[..written as usize])
        .trim_end_matches('\0')
        .to_string();
    if text.is_empty() { None } else { Some(text) }
}

/// Caminho completo do executavel.
pub(super) fn exe_path(pid: u32) -> Option<String> {
    let mut buffer = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: buffer valido, tamanho passado junto.
    let written = unsafe {
        libc::proc_pidpath(
            pid as c_int,
            buffer.as_mut_ptr() as *mut c_void,
            buffer.len() as u32,
        )
    };
    if written <= 0 {
        return None;
    }
    Some(String::from_utf8_lossy(&buffer[..written as usize]).to_string())
}

/// Diretorio atual do processo, lido do vnode do kernel. Funciona para os
/// processos do proprio usuario sem hook no shell.
pub(super) fn cwd(pid: u32) -> Option<String> {
    let mut info: libc::proc_vnodepathinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_vnodepathinfo>() as c_int;
    // SAFETY: buffer do tamanho da struct pedida pelo flavor.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut libc::proc_vnodepathinfo as *mut c_void,
            size,
        )
    };
    if written != size {
        return None;
    }
    let flat: &[c_char] = unsafe {
        std::slice::from_raw_parts(info.pvi_cdir.vip_path.as_ptr() as *const c_char, 32 * 32)
    };
    let path = chars_to_string(flat);
    if path.is_empty() { None } else { Some(path) }
}

/// Flavor de `proc_pidfdinfo` que devolve o caminho de um descritor de vnode,
/// e a struct que ele preenche, que o crate `libc` nao traz.
const PROC_PIDFDVNODEPATHINFO: c_int = 2;

#[repr(C)]
#[allow(dead_code)]
struct ProcFileInfo {
    fi_openflags: u32,
    fi_status: u32,
    fi_offset: i64,
    fi_type: i32,
    fi_guardflags: u32,
}

#[repr(C)]
struct VnodeFdInfoWithPath {
    pfi: ProcFileInfo,
    pvip: libc::vnode_info_path,
}

/// Caminhos dos arquivos que o processo mantem abertos, lidos dos
/// descritores de vnode. E como o estudio acha a conversa de um agente que
/// segura o proprio arquivo, como o Codex.
pub(super) fn open_files(pid: u32) -> Vec<String> {
    let entry = std::mem::size_of::<libc::proc_fdinfo>();
    // SAFETY: com buffer nulo o kernel so devolve o tamanho necessario.
    let needed = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDLISTFDS,
            0,
            std::ptr::null_mut(),
            0,
        )
    };
    if needed <= 0 {
        return Vec::new();
    }
    let capacity = needed as usize / entry + 16;
    // SAFETY: proc_fdinfo e so inteiros; zerada e um valor valido.
    let mut fds: Vec<libc::proc_fdinfo> = vec![unsafe { std::mem::zeroed() }; capacity];
    // SAFETY: o buffer tem `capacity` entradas e o tamanho em bytes vai junto.
    let written = unsafe {
        libc::proc_pidinfo(
            pid as c_int,
            libc::PROC_PIDLISTFDS,
            0,
            fds.as_mut_ptr() as *mut c_void,
            (capacity * entry) as c_int,
        )
    };
    if written <= 0 {
        return Vec::new();
    }
    let count = (written as usize / entry).min(capacity);
    let mut paths = Vec::new();
    for fd in &fds[..count] {
        if fd.proc_fdtype != libc::PROX_FDTYPE_VNODE as u32 {
            continue;
        }
        let mut info: VnodeFdInfoWithPath = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<VnodeFdInfoWithPath>() as c_int;
        // SAFETY: buffer do tamanho da struct pedida pelo flavor.
        let got = unsafe {
            libc::proc_pidfdinfo(
                pid as c_int,
                fd.proc_fd,
                PROC_PIDFDVNODEPATHINFO,
                &mut info as *mut VnodeFdInfoWithPath as *mut c_void,
                size,
            )
        };
        if got != size {
            continue;
        }
        let flat: &[c_char] = unsafe {
            std::slice::from_raw_parts(info.pvip.vip_path.as_ptr() as *const c_char, 32 * 32)
        };
        let path = chars_to_string(flat);
        if !path.is_empty() {
            paths.push(path);
        }
    }
    paths
}

/// Linha de comando e ambiente permitido por `KERN_PROCARGS2`.
pub(super) fn command_line(pid: u32) -> Option<CommandLine> {
    let argmax = {
        let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
        let mut value: c_int = 0;
        let mut size = std::mem::size_of::<c_int>();
        // SAFETY: sysctl de leitura num inteiro do tamanho informado.
        let status = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                2,
                &mut value as *mut c_int as *mut c_void,
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if status != 0 || value <= 0 {
            return None;
        }
        value as usize
    };
    let mut buffer = vec![0u8; argmax];
    let mut size = argmax;
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as c_int];
    // SAFETY: buffer de `argmax` bytes, o kernel devolve o tamanho usado.
    let status = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr() as *mut c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if status != 0 || size < 4 {
        return None;
    }
    buffer.truncate(size);
    parse_procargs(&buffer)
}

fn parse_procargs(buffer: &[u8]) -> Option<CommandLine> {
    let argc = i32::from_ne_bytes([buffer[0], buffer[1], buffer[2], buffer[3]]).max(0) as usize;
    let mut cursor = 4usize;
    let exe_end = buffer[cursor..].iter().position(|byte| *byte == 0)? + cursor;
    let exe = String::from_utf8_lossy(&buffer[cursor..exe_end]).to_string();
    cursor = exe_end;
    while cursor < buffer.len() && buffer[cursor] == 0 {
        cursor += 1;
    }
    let mut argv = Vec::with_capacity(argc);
    while argv.len() < argc && cursor < buffer.len() {
        let end = buffer[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| offset + cursor)
            .unwrap_or(buffer.len());
        argv.push(String::from_utf8_lossy(&buffer[cursor..end]).to_string());
        cursor = end + 1;
    }
    // Depois do argv vem o ambiente, `NOME=valor` com NUL, ate uma string
    // vazia; depois dela ficam as "apple strings" do carregador, que nao
    // interessam. So as chaves da lista fechada sao guardadas.
    let mut env = std::collections::HashMap::new();
    let mut seen = 0usize;
    while cursor < buffer.len() && seen < MAX_ENV_ENTRIES {
        let end = buffer[cursor..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| offset + cursor)
            .unwrap_or(buffer.len());
        if end == cursor {
            break;
        }
        let entry = &buffer[cursor..end];
        cursor = end + 1;
        seen += 1;
        let Some(equals) = entry.iter().position(|byte| *byte == b'=') else {
            continue;
        };
        let Ok(key) = std::str::from_utf8(&entry[..equals]) else {
            continue;
        };
        if ENV_OF_INTEREST.contains(&key) {
            env.insert(
                key.to_string(),
                String::from_utf8_lossy(&entry[equals + 1..]).to_string(),
            );
        }
    }
    Some(CommandLine { exe, argv, env })
}

fn chars_to_string(chars: &[c_char]) -> String {
    let bytes: Vec<u8> = chars
        .iter()
        .map(|value| *value as u8)
        .take_while(|byte| *byte != 0)
        .collect();
    String::from_utf8_lossy(&bytes).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn lists_the_files_the_process_keeps_open() {
        let dir = std::env::temp_dir().join(format!("oc-procs-open-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("aberto pelo teste.jsonl");
        let file = std::fs::File::create(&path).unwrap();
        let canonical = path.canonicalize().unwrap().to_string_lossy().to_string();
        assert!(
            open_files(std::process::id()).contains(&canonical),
            "{canonical}"
        );
        drop(file);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn reads_own_process() {
        let pid = std::process::id();
        let info = info(pid).expect("bsd info do proprio processo");
        assert_eq!(info.pid, pid);
        assert!(usage(pid).is_some());
        assert!(cwd(pid).is_some());
        let command = command_line(pid).expect("linha de comando");
        assert!(!command.exe.is_empty());
        assert!(!command.argv.is_empty());
        assert!(name(pid).is_some());
    }

    #[test]
    fn lists_children_and_descendants() {
        use std::process::{Command, Stdio};
        // O `; true` impede o sh de trocar-se pelo sleep sem criar filho.
        let mut child = Command::new("/bin/sh")
            .args(["-c", "/bin/sleep 5; true"])
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(150));
        let me = std::process::id();
        let direct = children(me);
        assert!(direct.contains(&child.id()), "filho direto: {direct:?}");
        let tree = descendants(me);
        assert!(tree.len() >= 2, "sh e sleep na arvore: {tree:?}");
        // Outros testes do mesmo processo também criam sleep; procura o do próprio sh.
        let sleep_pid = children(child.id())
            .into_iter()
            .find(|pid| name(*pid).as_deref() == Some("sleep"));
        assert!(
            sleep_pid.is_some_and(|pid| tree.contains(&pid)),
            "sleep na arvore: {tree:?}"
        );
        assert_eq!(info(sleep_pid.unwrap()).unwrap().ppid, child.id());
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn parses_procargs_layout() {
        let mut raw = Vec::new();
        raw.extend_from_slice(&2i32.to_ne_bytes());
        raw.extend_from_slice(b"/usr/bin/node\0\0\0");
        raw.extend_from_slice(b"node\0/x/@anthropic-ai/claude-code/cli.js\0HOME=/x\0");
        raw.extend_from_slice(b"CLAUDE_CONFIG_DIR=/x/.claude-webrota\0OPENAI_API_KEY=segredo\0CLAUDE_PROFILE=WebRota\0\0\0");
        raw.extend_from_slice(b"executable_path=/usr/bin/node\0ptr_munge=abc\0");
        let parsed = parse_procargs(&raw).unwrap();
        assert_eq!(parsed.exe, "/usr/bin/node");
        assert_eq!(
            parsed.argv,
            vec!["node", "/x/@anthropic-ai/claude-code/cli.js"]
        );
        assert_eq!(
            crate::workspace::procs::agent_of(&parsed),
            Some("Claude Code")
        );
        // So as chaves de interesse ficam; o segredo e as apple strings nao.
        assert_eq!(
            parsed.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some("/x/.claude-webrota")
        );
        assert_eq!(
            parsed.env.get("CLAUDE_PROFILE").map(String::as_str),
            Some("WebRota")
        );
        assert_eq!(parsed.env.len(), 2, "{:?}", parsed.env);
    }

    #[test]
    fn reads_env_of_child_process() {
        use std::process::{Command, Stdio};
        // O kernel esconde o ambiente dos binarios restritos da Apple, como
        // /bin/sleep e /bin/sh, mesmo para o proprio usuario; o python3 e os
        // programas dos agentes, node e afins, mostram. O filho aqui e um
        // python3 dormindo, que e o caso dos agentes de verdade.
        if !Path::new("/usr/bin/python3").exists() {
            eprintln!("sem /usr/bin/python3; teste pulado");
            return;
        }
        let mut child = Command::new("/usr/bin/python3")
            .args(["-c", "import time; time.sleep(5)"])
            .env("CLAUDE_PROFILE", "Teste")
            .env("CLAUDE_CONFIG_DIR", "/tmp/oc-perfil-teste")
            .env("SEGREDO_QUALQUER", "nao-deve-aparecer")
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));
        let command = command_line(child.id()).expect("linha de comando do filho");
        assert_eq!(
            command.env.get("CLAUDE_PROFILE").map(String::as_str),
            Some("Teste"),
            "{:?}",
            command
        );
        assert_eq!(
            command.env.get("CLAUDE_CONFIG_DIR").map(String::as_str),
            Some("/tmp/oc-perfil-teste")
        );
        assert!(!command.env.contains_key("SEGREDO_QUALQUER"));
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn mach_conversion_is_monotonic() {
        assert!(mach_to_nanos(1000) > 0);
        assert!(mach_to_nanos(2000) >= mach_to_nanos(1000));
    }
}
