// SPDX-License-Identifier: Apache-2.0
//! Bounded, read-only CLI capability probes. Never starts/restarts a shared
//! daemon, updates a CLI, or uses --last to substitute a conversation.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use super::{AgentSession, CLAUDE, CODEX, SESSION_FILE_LIMIT};
use crate::platform::{self, ShellFlavor};
use serde::Serialize;

const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const CACHE_TTL: Duration = Duration::from_secs(300);
const SEARCH_LIMIT: usize = 16384;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Compatibility {
    pub version: String,
    pub update_available: Option<String>,
    pub daemon_status: String,
    pub app_server_version: Option<String>,
    #[serde(skip)]
    pub command: String,
}

#[derive(Clone)]
struct Capabilities {
    version: String,
    help: String,
}
type CacheKey = (
    PathBuf,
    Option<SystemTime>,
    u64,
    String,
    Option<String>,
    Option<String>,
);
type ProbeResult = Option<(Instant, Result<Capabilities, String>)>;
type ProbeCache = HashMap<CacheKey, (Instant, Arc<Mutex<ProbeResult>>)>;

/// Only capabilities are cached; cwd and conversation are checked on every
/// attempt. The cache serializes concurrent probes for the same installation.
pub fn validate(
    session: &AgentSession,
    shell_cwd: &str,
    flavor: ShellFlavor,
    home: &Path,
    search_path: &str,
) -> Result<Compatibility, String> {
    if !super::is_session_id(&session.session_id) {
        return Err("Identificador da conversa inválido. O histórico foi preservado.".into());
    }
    let program = match session.agent.as_str() {
        CODEX => "codex",
        CLAUDE => "claude",
        _ => return Err("Agente não suportado para retomada.".into()),
    };
    let cwd = session.cwd.as_deref().unwrap_or(shell_cwd);
    if !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() {
        return Err(
            "A pasta da conversa não está disponível. Restaure a pasta antes de tentar novamente."
                .into(),
        );
    }
    let config = session
        .config_dir
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            home.join(if program == "codex" {
                ".codex"
            } else {
                ".claude"
            })
        });
    if !config.is_absolute() || !config.is_dir() {
        return Err(
            "O perfil do agente não está disponível. O identificador da conversa foi preservado."
                .into(),
        );
    }
    validate_conversation(session, &config)?;
    let mut effective = session.clone();
    // The shell may now inherit a different active account. Always bind the
    // launch to the saved account, including an explicitly resolved default.
    effective.config_dir = Some(platform::to_portable(&config));
    effective.cwd = Some(cwd.to_string());
    let executable = which::which_in(program, Some(search_path), cwd)
        .map_err(|_| format!("{program} não foi encontrado no PATH do terminal. Instale ou configure o CLI e tente novamente."))?;
    let meta = fs::metadata(&executable)
        .map_err(|_| "O executável do agente não está acessível.".to_string())?;
    let key = (
        executable.clone(),
        meta.modified().ok(),
        meta.len(),
        session.agent.clone(),
        effective.config_dir.clone(),
        effective.profile_name.clone(),
    );
    static CACHE: OnceLock<Mutex<ProbeCache>> = OnceLock::new();
    let entry = {
        let mut cache = CACHE
            .get_or_init(Mutex::default)
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        cache.retain(|_, (at, value)| at.elapsed() < CACHE_TTL || Arc::strong_count(value) > 1);
        if let Some((at, entry)) = cache.get_mut(&key) {
            *at = Instant::now();
            entry.clone()
        } else {
            if cache.len() >= 64 {
                let oldest = cache
                    .iter()
                    .filter(|(_, (_, value))| Arc::strong_count(value) == 1)
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(key, _)| key.clone());
                if let Some(oldest) = oldest {
                    cache.remove(&oldest);
                }
            }
            let entry = Arc::new(Mutex::new(None));
            if cache.len() < 64 {
                cache.insert(key, (Instant::now(), entry.clone()));
            }
            entry
        }
    };
    // Never hold the global map while executing an external CLI. A broken
    // installation/profile must not serialize unrelated agents behind it.
    let mut cached = entry.lock().unwrap_or_else(|p| p.into_inner());
    let capabilities = if let Some((_, result)) = cached.as_ref().filter(|(at, result)| {
        at.elapsed()
            < if result.is_ok() {
                CACHE_TTL
            } else {
                Duration::from_secs(5)
            }
    }) {
        result.clone()
    } else {
        let result = probe(&executable, &effective, cwd);
        *cached = Some((Instant::now(), result.clone()));
        result
    }?;
    drop(cached);
    validate_help(session, &capabilities.help)?;
    let executable_text = executable.to_str().ok_or_else(|| {
        "O caminho do CLI não pode ser representado pelo shell com segurança.".to_string()
    })?;
    let command = super::resume_command_for(&effective, shell_cwd, flavor, Some(executable_text))
        .ok_or_else(|| "Os argumentos salvos da conversa são inválidos.".to_string())?;
    // Use only the CLI's existing update cache. No internet or startup update
    // check; an absent/stale cache means unknown, not 'up to date'.
    let update_available = if program == "codex" {
        read_cached_update(&config, &capabilities.version)
    } else {
        None
    };
    let (daemon_status, app_server_version) = if session.agent != CODEX {
        ("not-applicable", None)
    } else if session.args.iter().any(|arg| arg == "--no-daemon") {
        ("disabled-by-session", None)
    } else {
        match super::daemon::check(&config, Duration::from_millis(500)) {
            super::daemon::Health::NotObserved => ("not-observed", None),
            super::daemon::Health::Unknown => ("unknown", None),
            super::daemon::Health::Draining => ("draining", None),
            super::daemon::Health::Running(version) => {
                // Observable skew alone does not prove protocol incompatibility.
                let local = capabilities
                    .version
                    .split_whitespace()
                    .find(|word| word.starts_with(|c: char| c.is_ascii_digit()));
                (
                    if local == Some(version.as_str()) {
                        "running"
                    } else {
                        "version-skew"
                    },
                    Some(version),
                )
            }
        }
    };
    Ok(Compatibility {
        version: capabilities.version,
        update_available,
        daemon_status: daemon_status.into(),
        app_server_version,
        command,
    })
}

fn validate_help(session: &AgentSession, help: &str) -> Result<(), String> {
    let expected = if session.agent == CODEX {
        "SESSION_ID"
    } else {
        "--resume"
    };
    if !help.contains(expected) {
        return Err("Esta versão do CLI não anuncia suporte à retomada por identificador.".into());
    }
    let spec = if session.agent == CODEX {
        &super::CODEX_FLAGS
    } else {
        &super::CLAUDE_FLAGS
    };
    let flags = super::keep_flags(&session.args, spec);
    for flag in flags.iter().filter(|arg| arg.starts_with("--")) {
        if !help
            .split_whitespace()
            .any(|word| word.trim_matches([',', '[', ']']) == flag)
        {
            return Err(format!(
                "A versão instalada não suporta a opção salva {flag}. Revise o CLI antes de retomar; as permissões não foram alteradas."
            ));
        }
    }
    Ok(())
}

fn probe(executable: &Path, session: &AgentSession, cwd: &str) -> Result<Capabilities, String> {
    let version = run_probe(executable, &["--version"], session, cwd, PROBE_TIMEOUT)?;
    let help_args: &[&str] = if session.agent == CODEX {
        &["resume", "--help"]
    } else {
        &["--help"]
    };
    let help = run_probe(executable, help_args, session, cwd, PROBE_TIMEOUT)?;
    let version = version
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_string();
    if version.is_empty() || version.len() > 160 || !version.bytes().any(|b| b.is_ascii_digit()) {
        return Err("O CLI não informou uma versão válida.".into());
    }
    Ok(Capabilities { version, help })
}

fn run_probe(
    executable: &Path,
    args: &[&str],
    session: &AgentSession,
    cwd: &str,
    timeout: Duration,
) -> Result<String, String> {
    // A private temporary file avoids a pipe filling up while waiting for the
    // child. Output is capped on read; no reader thread/pipe can outlive timeout.
    let mut nonce = [0_u8; 16];
    getrandom::fill(&mut nonce)
        .map_err(|_| "Não foi possível preparar a verificação do CLI.".to_string())?;
    let path = std::env::temp_dir().join(format!(
        "cialai-cli-probe-{:032x}",
        u128::from_le_bytes(nonce)
    ));
    struct Scratch(PathBuf);
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let scratch = Scratch(path);
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options
        .open(&scratch.0)
        .map_err(|_| "Não foi possível abrir a verificação do CLI.".to_string())?;
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(
            file.try_clone()
                .map_err(|_| "Falha ao preparar a saída do CLI.".to_string())?,
        )
        .stderr(Stdio::null());
    for name in [
        "CLAUDE_CONFIG_DIR",
        "CLAUDE_PROFILE",
        "CODEX_HOME",
        "CODEX_PROFILE",
    ] {
        command.env_remove(name);
    }
    let (dir_key, name_key) = if session.agent == CODEX {
        ("CODEX_HOME", "CODEX_PROFILE")
    } else {
        ("CLAUDE_CONFIG_DIR", "CLAUDE_PROFILE")
    };
    if let Some(dir) = &session.config_dir {
        command.env(dir_key, dir);
    }
    if let Some(name) = &session.profile_name {
        command.env(name_key, name);
    }
    platform::child_env::sanitize(&mut command);
    platform::configure_background_command(&mut command);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        // Command drops the primary thread handle. Keep it suspended until the
        // private job owns the wrapper, so a fast CLI cannot escape with children.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    }
    let mut child = command.spawn().map_err(|_| {
        "Não foi possível executar o CLI para verificar a compatibilidade.".to_string()
    })?;
    #[cfg(target_os = "windows")]
    let probe_job = match WindowsProbeJob::attach(&child) {
        Ok(job) => job,
        Err(_) => {
            // Attachment failed before the suspended child could run. Only its
            // owned handle is used for cleanup, never a shared CLI/PID lookup.
            let _ = child.kill();
            let _ = child.wait();
            return Err("Não foi possível isolar a verificação do CLI.".into());
        }
    };
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None)
                if start.elapsed() < timeout
                    && file.metadata().is_ok_and(|m| m.len() <= 256 * 1024) =>
            {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                #[cfg(not(target_os = "windows"))]
                platform::terminate_background_process(child.id(), true);
                #[cfg(target_os = "windows")]
                drop(probe_job);
                let _ = child.kill();
                let _ = child.wait();
                return Err(
                    "O CLI não respondeu à verificação dentro do prazo. Tente novamente.".into(),
                );
            }
        }
    };
    #[cfg(target_os = "windows")]
    drop(probe_job);
    if !status.success() {
        return Err(
            "O CLI recusou a verificação de compatibilidade. O histórico foi preservado.".into(),
        );
    }
    let mut output = String::new();
    fs::File::open(&scratch.0)
        .and_then(|f| f.take(256 * 1024).read_to_string(&mut output))
        .map_err(|_| "A resposta de compatibilidade do CLI é inválida.".to_string())?;
    Ok(output)
}

#[cfg(target_os = "windows")]
struct WindowsProbeJob(platform::win_job::JobHandle);

#[cfg(target_os = "windows")]
impl WindowsProbeJob {
    fn attach(child: &std::process::Child) -> std::io::Result<Self> {
        let job = Self(platform::win_job::assign_private(child)?);
        resume_probe_thread(child.id())?;
        Ok(job)
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsProbeJob {
    fn drop(&mut self) {
        // This guard is declared after Child and before output is consumed. It
        // collects descendants on success, timeout and all later error paths,
        // before the output handles and Scratch are dropped.
        let _ = self.0.terminate_and_wait(Duration::from_secs(1));
    }
}

#[cfg(target_os = "windows")]
fn resume_probe_thread(pid: u32) -> std::io::Result<()> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows_sys::Win32::System::Threading::{
        GetProcessIdOfThread, OpenThread, ResumeThread, THREAD_QUERY_LIMITED_INFORMATION,
        THREAD_SUSPEND_RESUME,
    };

    // CREATE_SUSPENDED starts with one primary thread, which has not executed
    // user code. ToolHelp recovers its ID without undocumented Nt APIs.
    let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if raw == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: the successful snapshot is a newly owned kernel handle.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
    let mut entry = THREADENTRY32 {
        dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
        ..Default::default()
    };
    // SAFETY: the valid snapshot and correctly sized entry live through calls.
    let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) };
    while found != 0 {
        if entry.th32OwnerProcessID == pid {
            let raw = unsafe {
                OpenThread(
                    THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
                    0,
                    entry.th32ThreadID,
                )
            };
            if raw.is_null() {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: OpenThread returned a newly owned handle.
            let thread = unsafe { OwnedHandle::from_raw_handle(raw) };
            // Check the live handle too; a stale snapshot must never resume a
            // different process's thread if a thread ID was recycled.
            if unsafe { GetProcessIdOfThread(thread.as_raw_handle()) } != pid {
                return Err(std::io::Error::other("probe thread identity changed"));
            }
            let previous = unsafe { ResumeThread(thread.as_raw_handle()) };
            return match previous {
                1 => Ok(()),
                u32::MAX => Err(std::io::Error::last_os_error()),
                _ => Err(std::io::Error::other("unexpected probe thread suspension")),
            };
        }
        found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) };
    }
    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "suspended probe thread not found",
    ))
}

fn validate_conversation(session: &AgentSession, config: &Path) -> Result<(), String> {
    let root = config.join(if session.agent == CODEX {
        "sessions"
    } else {
        "projects"
    });
    let mut pending = vec![root];
    let mut visited = 0;
    while let Some(dir) = pending.pop() {
        let Ok(entries) = fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            visited += 1;
            if visited > SEARCH_LIMIT {
                return Err("O índice de conversas excedeu o limite da verificação. Retome manualmente pelo identificador salvo.".into());
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            if kind.is_dir() {
                pending.push(entry.path());
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let matches = if session.agent == CODEX {
                super::rollout_session_id(&name)
                    .is_some_and(|id| id.eq_ignore_ascii_case(&session.session_id))
            } else {
                name.eq_ignore_ascii_case(&format!("{}.jsonl", session.session_id))
            };
            if !matches || !kind.is_file() {
                continue;
            }
            if session.agent == CODEX {
                let record = super::first_codex_record(&entry.path());
                if record.is_some_and(|r| {
                    r.kind == "session_meta"
                        && r.payload
                            .id
                            .as_deref()
                            .is_some_and(|id| id.eq_ignore_ascii_case(&session.session_id))
                }) {
                    return Ok(());
                }
            } else {
                let mut prefix = String::new();
                if fs::File::open(entry.path())
                    .and_then(|f| f.take(SESSION_FILE_LIMIT).read_to_string(&mut prefix))
                    .is_ok()
                    && prefix
                        .lines()
                        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
                        .any(|row| {
                            row.get("sessionId")
                                .and_then(|v| v.as_str())
                                .is_some_and(|id| id.eq_ignore_ascii_case(&session.session_id))
                        })
                {
                    return Ok(());
                }
            }
            return Err("O arquivo da conversa está incompleto ou inválido. O histórico do Cialai foi preservado.".into());
        }
    }
    Err("A conversa não foi encontrada neste perfil. O identificador e o histórico foram preservados para recuperação manual.".into())
}

fn read_cached_update(config: &Path, current: &str) -> Option<String> {
    let path = config.join("version.json");
    let meta = fs::metadata(&path).ok()?;
    if meta.len() > 4096 || meta.modified().ok()?.elapsed().ok()? > Duration::from_secs(24 * 3600) {
        return None;
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    let latest = value.get("latest_version")?.as_str()?;
    if latest.len() > 64
        || !latest
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | 'a'..='z'))
    {
        return None;
    }
    let numeric = |s: &str| {
        s.split('.')
            .map(str::parse::<u64>)
            .collect::<Result<Vec<_>, _>>()
            .ok()
    };
    let installed = current.split_whitespace().find_map(numeric)?;
    (numeric(latest)? > installed).then(|| latest.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    const ID: &str = "12345678-1234-1234-1234-123456789abc";
    struct Fixture {
        root: PathBuf,
        session: AgentSession,
    }
    impl Fixture {
        fn new(agent: &str) -> Self {
            let mut random = [0u8; 8];
            getrandom::fill(&mut random).unwrap();
            let root = std::env::temp_dir().join(format!(
                "cialai-compat-test-{:x}",
                u64::from_le_bytes(random)
            ));
            fs::create_dir_all(root.join("bin")).unwrap();
            let config = root.join("profile");
            let logs = config.join(if agent == CODEX {
                "sessions/2026/10/15"
            } else {
                "projects/project"
            });
            fs::create_dir_all(&logs).unwrap();
            if agent == CODEX {
                fs::write(
                    logs.join(format!("rollout-2026-10-15-{ID}.jsonl")),
                    serde_json::json!({"type":"session_meta","payload":{"id":ID,"cwd":root}})
                        .to_string(),
                )
                .unwrap();
            } else {
                fs::write(
                    logs.join(format!("{ID}.jsonl")),
                    serde_json::json!({"sessionId":ID,"type":"user"}).to_string(),
                )
                .unwrap();
            }
            let session = AgentSession {
                agent: agent.into(),
                session_id: ID.into(),
                cwd: Some(root.to_string_lossy().into_owned()),
                config_dir: Some(config.to_string_lossy().into_owned()),
                profile_name: Some("fixture".into()),
                args: vec![],
            };
            Self { root, session }
        }
        fn executable(&self, body: &str) -> PathBuf {
            let path = self.root.join("bin").join(if self.session.agent == CODEX {
                "codex"
            } else {
                "claude"
            });
            fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
            path
        }
        fn validate(&self) -> Result<Compatibility, String> {
            validate(
                &self.session,
                self.root.to_str().unwrap(),
                ShellFlavor::Posix,
                &self.root,
                self.root.join("bin").to_str().unwrap(),
            )
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn validates_exact_conversation_for_both_agents_without_network_and_caches_probes() {
        for agent in [CODEX, CLAUDE] {
            let fixture = Fixture::new(agent);
            fixture.executable("printf x >> probes\ncase \"$1\" in --version) echo 'fixture-cli 1.2.3';; *) echo 'SESSION_ID --resume --model --no-daemon';; esac");
            for _ in 0..20 {
                let checked = fixture.validate().unwrap();
                assert!(checked.command.contains(ID));
                assert!(!checked.command.contains("--last"));
                assert!(!checked.command.contains("--no-daemon"));
                assert_eq!(checked.version, "fixture-cli 1.2.3");
                assert_eq!(checked.update_available, None);
                assert_eq!(
                    checked.daemon_status,
                    if agent == CODEX {
                        "not-observed"
                    } else {
                        "not-applicable"
                    }
                );
            }
            assert_eq!(fs::read(fixture.root.join("probes")).unwrap().len(), 2);
        }
    }

    #[test]
    fn rejects_missing_cli_missing_session_cwd_and_incompatible_flags() {
        let mut fixture = Fixture::new(CODEX);
        assert!(fixture.validate().unwrap_err().contains("PATH"));
        fixture.executable(
            "case \"$1\" in --version) echo 'codex-cli 1.0.0';; *) echo SESSION_ID;; esac",
        );
        fixture.session.args = vec!["--sandbox".into(), "read-only".into()];
        assert!(fixture.validate().unwrap_err().contains("--sandbox"));
        fixture.session.args.clear();
        fixture.session.session_id = "ffffffff-ffff-ffff-ffff-ffffffffffff".into();
        assert!(
            fixture
                .validate()
                .unwrap_err()
                .contains("não foi encontrada")
        );
        fixture.session.cwd = Some(fixture.root.join("missing").to_string_lossy().into_owned());
        assert!(fixture.validate().unwrap_err().contains("pasta"));
    }

    #[test]
    fn probe_timeout_reaps_only_its_isolated_child() {
        let fixture = Fixture::new(CODEX);
        let exe = fixture.executable("while :; do :; done");
        let at = Instant::now();
        assert!(
            run_probe(
                &exe,
                &["--version"],
                &fixture.session,
                fixture.root.to_str().unwrap(),
                Duration::from_millis(50)
            )
            .is_err()
        );
        assert!(at.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn no_daemon_is_preserved_only_when_explicit_in_original_session() {
        let mut fixture = Fixture::new(CODEX);
        fixture.executable("case \"$1\" in --version) echo 'codex-cli 1.0.0';; *) echo 'SESSION_ID --no-daemon';; esac");
        fixture.session.args.push("--no-daemon".into());
        assert!(fixture.validate().unwrap().command.contains("--no-daemon"));
    }

    #[test]
    fn an_unresponsive_codex_probe_does_not_block_a_claude_profile() {
        let slow = Fixture::new(CODEX);
        slow.executable("touch entered; sleep 4");
        let fast = Fixture::new(CLAUDE);
        fast.executable(
            "case \"$1\" in --version) echo 'claude 2.1.301';; *) echo '--resume';; esac",
        );
        std::thread::scope(|scope| {
            let running = scope.spawn(|| slow.validate());
            let start = Instant::now();
            while !slow.root.join("entered").exists() {
                assert!(start.elapsed() < Duration::from_secs(5));
                std::thread::sleep(Duration::from_millis(10));
            }
            let start = Instant::now();
            assert!(fast.validate().is_ok());
            let latency = start.elapsed();
            assert!(running.join().unwrap().is_err());
            assert!(
                latency < Duration::from_secs(1),
                "unrelated profile blocked for {latency:?}"
            );
        });
    }

    #[test]
    fn default_profile_resume_overrides_a_named_profile_inherited_by_the_new_shell() {
        let mut fixture = Fixture::new(CODEX);
        let default = fixture.root.join(".codex");
        fs::rename(fixture.root.join("profile"), &default).unwrap();
        fixture.session.config_dir = None;
        fixture.session.profile_name = None;
        fixture.executable("case \"$*\" in --version) echo 'codex-cli 0.162.1';; 'resume --help') echo SESSION_ID;; *) printf '%s|%s' \"$CODEX_HOME\" \"${CODEX_PROFILE-unset}\";; esac");
        let checked = fixture.validate().unwrap();
        let result = Command::new("/bin/sh")
            .args(["-c", &checked.command])
            .env("CODEX_HOME", fixture.root.join("unrelated-profile"))
            .env("CODEX_PROFILE", "unrelated-name")
            .output()
            .unwrap();
        assert!(result.status.success());
        assert_eq!(
            String::from_utf8(result.stdout).unwrap(),
            format!("{}|unset", default.display())
        );
    }
}

#[cfg(all(test, target_os = "windows"))]
mod windows_tests {
    use super::*;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use std::process::Child;
    use sysinfo::{Pid, ProcessesToUpdate, System};
    use windows_sys::Win32::Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
        TerminateProcess, WaitForSingleObject,
    };

    const ROOT_ENV: &str = "CIALAI_COMPAT_FIXTURE_ROOT";
    const ROLE_ENV: &str = "CIALAI_COMPAT_FIXTURE_ROLE";
    const WORKER_TEST: &str = "workspace::resume::compatibility::windows_tests::probe_timeout_collects_wrapper_and_descendant";
    const CHILD_TEST: &str =
        "workspace::resume::compatibility::windows_tests::probe_fixture_process";

    struct FixtureRoot(PathBuf);

    impl Drop for FixtureRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct ChildGuard(Child);

    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    // Hold a handle to the observed process, so cleanup cannot kill a reused PID.
    struct ObservedProcess(OwnedHandle);

    impl ObservedProcess {
        fn open(pid: u32) -> Self {
            let raw = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE | PROCESS_TERMINATE,
                    0,
                    pid,
                )
            };
            assert!(!raw.is_null(), "cannot observe fixture PID {pid}");
            Self(unsafe { OwnedHandle::from_raw_handle(raw) })
        }

        fn exited(&self, timeout_ms: u32) -> bool {
            let status = unsafe { WaitForSingleObject(self.0.as_raw_handle(), timeout_ms) };
            assert!(
                status == WAIT_OBJECT_0 || status == WAIT_TIMEOUT,
                "fixture process wait failed: {status}"
            );
            status == WAIT_OBJECT_0
        }
    }

    impl Drop for ObservedProcess {
        fn drop(&mut self) {
            unsafe {
                // These handles were opened only after verifying the fixture ancestry.
                TerminateProcess(self.0.as_raw_handle(), 1);
                WaitForSingleObject(self.0.as_raw_handle(), 2_000);
            }
        }
    }

    fn marker(root: &Path, role: &str) -> (u32, u32) {
        let started = Instant::now();
        loop {
            if let Ok(bytes) = fs::read(root.join(format!("{role}.json"))) {
                if let Ok(ids) = serde_json::from_slice::<(u32, u32)>(&bytes) {
                    return ids;
                }
            }
            assert!(
                started.elapsed() < Duration::from_secs(3),
                "fixture {role} did not publish its owned process IDs"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    #[test]
    fn probe_fixture_process() {
        let Ok(role) = std::env::var(ROLE_ENV) else {
            return;
        };
        if role != "descendant" && role != "sentinel" {
            return;
        }
        let root = PathBuf::from(std::env::var_os(ROOT_ENV).unwrap());
        let pid = Pid::from_u32(std::process::id());
        let mut system = System::new();
        system.refresh_processes(ProcessesToUpdate::Some(&[pid]), true);
        let parent = system.process(pid).unwrap().parent().unwrap().as_u32();
        fs::write(
            root.join(format!("{role}.json")),
            serde_json::to_vec(&(std::process::id(), parent)).unwrap(),
        )
        .unwrap();
        // Even if the enclosing test process crashes, no fixture lives indefinitely.
        std::thread::sleep(Duration::from_secs(20));
    }

    #[test]
    fn probe_timeout_collects_wrapper_and_descendant() {
        if std::env::var(ROLE_ENV).as_deref() == Ok("worker") {
            let root = PathBuf::from(std::env::var_os(ROOT_ENV).unwrap());
            check_timeout_in_isolated_worker(&root);
            return;
        }

        let mut random = [0u8; 16];
        getrandom::fill(&mut random).unwrap();
        let root = FixtureRoot(std::env::temp_dir().join(format!(
            "cialai-compat-windows-{:032x}",
            u128::from_le_bytes(random)
        )));
        fs::create_dir(&root.0).unwrap();
        let scratch = root.0.join("scratch");
        fs::create_dir(&scratch).unwrap();
        let helper = root.0.join("fixture.exe");
        let current = std::env::current_exe().unwrap();
        if fs::hard_link(&current, &helper).is_err() {
            fs::copy(&current, &helper).unwrap();
        }
        // All paths come from %~dp0, with no interpolation into cmd syntax.
        fs::write(
            root.0.join("codex.cmd"),
            format!(
                "@echo off\r\nset \"{ROLE_ENV}=descendant\"\r\n\"%~dp0fixture.exe\" --exact {CHILD_TEST} --nocapture\r\n"
            ),
        )
        .unwrap();

        // Scope TEMP/TMP to this owned subprocess, without mutating the parallel
        // test runner's environment or inspecting other tests' scratch files.
        let mut worker = ChildGuard(
            Command::new(&helper)
                .args(["--exact", WORKER_TEST, "--nocapture"])
                .env(ROOT_ENV, &root.0)
                .env(ROLE_ENV, "worker")
                .env("TEMP", &scratch)
                .env("TMP", &scratch)
                .stdin(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let started = Instant::now();
        loop {
            if let Some(status) = worker.0.try_wait().unwrap() {
                assert!(status.success(), "isolated Windows probe regression failed");
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "isolated Windows probe regression exceeded its deadline"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn check_timeout_in_isolated_worker(root: &Path) {
        let mut sentinel = ChildGuard(
            Command::new(root.join("fixture.exe"))
                .args(["--exact", CHILD_TEST, "--nocapture"])
                .env(ROLE_ENV, "sentinel")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );
        let (sentinel_pid, sentinel_parent) = marker(root, "sentinel");
        assert_eq!(sentinel_pid, sentinel.0.id(), "sentinel identity changed");
        assert_eq!(sentinel_parent, std::process::id(), "sentinel is not owned");
        let session = AgentSession {
            agent: CODEX.into(),
            session_id: "12345678-1234-1234-1234-123456789abc".into(),
            cwd: Some(root.to_string_lossy().into_owned()),
            config_dir: None,
            profile_name: None,
            args: vec![],
        };

        std::thread::scope(|scope| {
            let started = Instant::now();
            let probe = scope.spawn(|| {
                run_probe(
                    &root.join("codex.cmd"),
                    &["--version"],
                    &session,
                    root.to_str().unwrap(),
                    Duration::from_secs(5),
                )
            });
            let (child_pid, wrapper_pid) = marker(root, "descendant");
            let mut system = System::new();
            let ids = [Pid::from_u32(child_pid), Pid::from_u32(wrapper_pid)];
            system.refresh_processes(ProcessesToUpdate::Some(&ids), true);
            let child = system
                .process(ids[0])
                .expect("fixture child vanished before timeout");
            let wrapper = system
                .process(ids[1])
                .expect("fixture wrapper vanished before timeout");
            assert_eq!(
                fs::canonicalize(child.exe().unwrap()).unwrap(),
                fs::canonicalize(root.join("fixture.exe")).unwrap(),
                "descendant executable is outside the fixture"
            );
            assert_eq!(
                child.parent(),
                Some(ids[1]),
                "child is outside the wrapper tree"
            );
            assert_eq!(
                wrapper.parent(),
                Some(Pid::from_u32(std::process::id())),
                "wrapper is outside the owned probe tree"
            );
            assert!(
                wrapper
                    .exe()
                    .unwrap()
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("cmd.exe"),
                "fixture wrapper is not cmd.exe"
            );
            let wrapper = ObservedProcess::open(wrapper_pid);
            let child = ObservedProcess::open(child_pid);
            assert!(!wrapper.exited(0), "wrapper did not remain blocked");
            assert!(!child.exited(0), "descendant did not remain blocked");

            let result = probe.join().unwrap();
            assert!(result.is_err(), "blocked probe must time out");
            assert!(
                started.elapsed() < Duration::from_secs(8),
                "probe timeout was unbounded"
            );
            assert!(
                wrapper.exited(1_000),
                "timed-out probe left its cmd wrapper alive"
            );
            assert!(
                child.exited(1_000),
                "timed-out probe left its descendant alive"
            );
            assert!(
                sentinel.0.try_wait().unwrap().is_none(),
                "probe killed an unrelated process"
            );
            assert_eq!(
                fs::read_dir(root.join("scratch")).unwrap().count(),
                0,
                "timed-out probe left scratch files behind"
            );
        });
    }
}
