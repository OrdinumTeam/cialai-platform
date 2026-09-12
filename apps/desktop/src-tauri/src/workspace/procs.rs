// SPDX-License-Identifier: Apache-2.0
//! Inspecao de processos no macOS por libproc e sysctl, sem crate extra:
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

use std::collections::HashMap;
use std::os::raw::{c_char, c_int, c_void};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Limite de processos percorridos por arvore, para uma sessao com muitos
/// filhos nao custar um tick inteiro.
const MAX_TREE: usize = 512;
const MAX_DEPTH: usize = 16;
/// Teto de entradas do ambiente lidas de um processo.
const MAX_ENV_ENTRIES: usize = 4096;
/// Variaveis de ambiente que o estudio guarda de um processo: as que dizem
/// qual perfil de agente ele usa. Lista fechada, porque o bloco de ambiente
/// traz chaves e segredos de outros programas, e nada fora daqui e retido.
const ENV_OF_INTEREST: &[&str] = &[
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_PROFILE",
    "CODEX_HOME",
    "CODEX_PROFILE",
];

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
pub fn mach_to_nanos(ticks: u64) -> u64 {
    let (numer, denom) = timebase();
    ((ticks as u128 * numer as u128) / denom as u128) as u64
}

/// Filhos diretos de um pid. `proc_listchildpids` devolve a quantidade de
/// pids gravados, nao bytes, ao contrario do que a assinatura sugere.
pub fn children(pid: u32) -> Vec<u32> {
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

/// Arvore inteira abaixo de um pid, em largura, sem o proprio pid.
pub fn descendants(pid: u32) -> Vec<u32> {
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
            result.push(child);
            frontier.push((child, depth + 1));
        }
    }
    result
}

/// Tempo de CPU acumulado em nanossegundos e memoria fisica em bytes.
#[derive(Clone, Copy, Debug)]
pub struct Usage {
    pub cpu_nanos: u64,
    pub footprint: u64,
}

pub fn usage(pid: u32) -> Option<Usage> {
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

/// Informacao basica do BSD: grupo de processos, estado e nome curto.
#[derive(Clone, Debug)]
pub struct BsdInfo {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: u32,
    pub status: u32,
    pub comm: String,
    pub name: String,
    pub start_sec: u64,
}

pub fn bsd_info(pid: u32) -> Option<BsdInfo> {
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
    Some(BsdInfo {
        pid: info.pbi_pid,
        ppid: info.pbi_ppid,
        pgid: info.pbi_pgid,
        status: info.pbi_status,
        comm: chars_to_string(&info.pbi_comm),
        name: chars_to_string(&info.pbi_name),
        start_sec: info.pbi_start_tvsec,
    })
}

/// Nome do executavel, como o Monitor de Atividade mostra.
pub fn name(pid: u32) -> Option<String> {
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
pub fn exe_path(pid: u32) -> Option<String> {
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
pub fn cwd(pid: u32) -> Option<String> {
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
pub fn open_files(pid: u32) -> Vec<String> {
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

/// Linha de comando: caminho do executavel e argv, por `KERN_PROCARGS2`,
/// mais as variaveis de ambiente de [`ENV_OF_INTEREST`] que o processo
/// recebeu no exec.
#[derive(Clone, Debug, Default)]
pub struct CommandLine {
    pub exe: String,
    pub argv: Vec<String>,
    pub env: HashMap<String, String>,
}

pub fn command_line(pid: u32) -> Option<CommandLine> {
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
    let mut env = HashMap::new();
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

/// Slug do perfil a partir da pasta de configuracao: `~/.claude` vira
/// `claude`, `~/.claude-webrota` vira `claude-webrota`, `~/.codex-amorim`
/// vira `codex-amorim`. A mesma regra vale no hook de linha de estado em
/// Python, para os dois lados baterem.
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

/// Perfil de conta que um agente esta usando, lido do ambiente do processo.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentProfile {
    /// Pasta de configuracao resolvida: `~/.claude-webrota` ou `~/.codex`.
    pub config_dir: String,
    /// Slug estavel, o mesmo do arquivo publicado pelo hook.
    pub slug: String,
    /// Nome dado pelo usuario, como `WebRota`, quando a variavel existe.
    pub name: Option<String>,
    /// A pasta veio de uma variavel de ambiente; falso no padrao.
    pub explicit: bool,
}

/// Claude Code le `CLAUDE_CONFIG_DIR` e o Codex `CODEX_HOME`; sem a
/// variavel, cada um usa a pasta padrao na home. Outros agentes nao tem
/// perfil conhecido.
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

/// Agentes de codigo conhecidos, pelo nome com que aparecem na linha de
/// comando: o binario, o script executado pelo node ou o modulo do python.
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

/// Interpretadores cujo primeiro argumento e o programa de verdade.
const RUNTIMES: &[&str] = &[
    "node", "bun", "deno", "python", "python3", "npx", "uv", "uvx", "tsx", "ts-node",
];

fn segment_key(segment: &str) -> String {
    let lower = segment.to_ascii_lowercase();
    lower
        .rsplit_once('.')
        .filter(|(_, ext)| matches!(*ext, "js" | "mjs" | "cjs" | "py" | "ts" | "sh"))
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

/// Nome do agente quando a linha de comando e de um agente conhecido.
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
    // node .../@anthropic-ai/claude-code/cli.js, python -m aider, uv run codex
    for argument in command.argv.iter().skip(1).take(4) {
        if argument.starts_with('-') && !argument.starts_with("--") {
            continue;
        }
        for segment in argument.split('/').filter(|segment| !segment.is_empty()) {
            if let Some(agent) = agent_for_segment(segment) {
                return Some(agent);
            }
        }
    }
    None
}

pub fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

fn chars_to_string(chars: &[c_char]) -> String {
    let bytes: Vec<u8> = chars
        .iter()
        .map(|value| *value as u8)
        .take_while(|byte| *byte != 0)
        .collect();
    String::from_utf8_lossy(&bytes).to_string()
}

/// Cache de linhas de comando por pid e instante de inicio. A linha nao
/// muda durante a vida do processo, e o instante de inicio evita confundir
/// um pid reaproveitado com o anterior.
#[derive(Default)]
pub struct CommandCache {
    entries: HashMap<u32, (u64, Option<CommandLine>)>,
}

impl CommandCache {
    pub fn get(&mut self, pid: u32, start_sec: u64) -> Option<CommandLine> {
        if let Some((known_start, command)) = self.entries.get(&pid) {
            if *known_start == start_sec {
                return command.clone();
            }
        }
        let command = command_line(pid);
        self.entries.insert(pid, (start_sec, command.clone()));
        command
    }

    pub fn retain(&mut self, alive: &[u32]) {
        self.entries.retain(|pid, _| alive.contains(pid));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let info = bsd_info(pid).expect("bsd info do proprio processo");
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
        let sleep_pid = tree
            .iter()
            .copied()
            .find(|pid| name(*pid).as_deref() == Some("sleep"));
        assert!(sleep_pid.is_some(), "sleep na arvore: {tree:?}");
        assert_eq!(bsd_info(sleep_pid.unwrap()).unwrap().ppid, child.id());
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
        assert_eq!(agent_of(&parsed), Some("Claude Code"));
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
        let profile = agent_profile(&parsed, "Claude Code", Path::new("/x")).unwrap();
        assert_eq!(profile.slug, "claude-webrota");
        assert_eq!(profile.config_dir, "/x/.claude-webrota");
        assert_eq!(profile.name.as_deref(), Some("WebRota"));
        assert!(profile.explicit);
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
    fn agent_profile_defaults_to_home_dirs() {
        let plain = CommandLine {
            exe: "/opt/homebrew/bin/claude".into(),
            argv: vec!["claude".into()],
            env: HashMap::new(),
        };
        let claude = agent_profile(&plain, "Claude Code", Path::new("/Users/x")).unwrap();
        assert_eq!(claude.slug, "claude");
        assert_eq!(claude.config_dir, "/Users/x/.claude");
        assert!(!claude.explicit);
        assert_eq!(claude.name, None);
        let codex = agent_profile(&plain, "Codex", Path::new("/Users/x")).unwrap();
        assert_eq!(codex.slug, "codex");
        assert_eq!(codex.config_dir, "/Users/x/.codex");
        assert!(agent_profile(&plain, "Gemini CLI", Path::new("/Users/x")).is_none());
        let mut env = HashMap::new();
        env.insert(
            "CODEX_HOME".to_string(),
            "/Users/x/.codex-amorim".to_string(),
        );
        env.insert("CODEX_PROFILE".to_string(), "amorim".to_string());
        let with_env = CommandLine {
            exe: "/usr/bin/codex".into(),
            argv: vec!["codex".into()],
            env,
        };
        let codex = agent_profile(&with_env, "Codex", Path::new("/Users/x")).unwrap();
        assert_eq!(codex.slug, "codex-amorim");
        assert_eq!(codex.name.as_deref(), Some("amorim"));
        assert!(codex.explicit);
    }

    #[test]
    fn profile_slug_rules() {
        assert_eq!(profile_slug(Path::new("/Users/x/.claude")), "claude");
        assert_eq!(
            profile_slug(Path::new("/Users/x/.claude-webrota")),
            "claude-webrota"
        );
        assert_eq!(
            profile_slug(Path::new("/Users/x/.codex-aamorim/")),
            "codex-aamorim"
        );
        assert_eq!(
            profile_slug(Path::new("/Users/x/.Claude Teste!")),
            "claudeteste"
        );
        assert_eq!(profile_slug(Path::new("/")), "perfil");
    }

    #[test]
    fn detects_agents_by_command_line() {
        let direct = CommandLine {
            exe: "/opt/homebrew/bin/claude".into(),
            argv: vec!["claude".into(), "--resume".into()],
            ..Default::default()
        };
        assert_eq!(agent_of(&direct), Some("Claude Code"));
        let python = CommandLine {
            exe: "/usr/bin/python3".into(),
            argv: vec!["python3".into(), "-m".into(), "aider".into()],
            ..Default::default()
        };
        assert_eq!(agent_of(&python), Some("Aider"));
        let plain = CommandLine {
            exe: "/usr/bin/vim".into(),
            argv: vec!["vim".into(), "claude.txt".into()],
            ..Default::default()
        };
        assert_eq!(agent_of(&plain), None);
        let server = CommandLine {
            exe: "/usr/local/bin/node".into(),
            argv: vec!["node".into(), "server.js".into()],
            ..Default::default()
        };
        assert_eq!(agent_of(&server), None);
    }

    #[test]
    fn mach_conversion_is_monotonic() {
        assert!(mach_to_nanos(1000) > 0);
        assert!(mach_to_nanos(2000) >= mach_to_nanos(1000));
    }
}
