// SPDX-License-Identifier: Apache-2.0
//! Historico e estado das sessoes de terminal em disco.
//!
//! O PTY vive dentro do processo do app: quando o app fecha ou cai, os shells
//! morrem junto e o historico em memoria some. Para a sessao voltar, cada uma
//! grava em `<Application Support>/terminals`:
//!
//! - `<tag>.log`, a saida bruta do PTY, acrescentada a cada lote pela thread
//!   de lote. A escrita cai no cache de paginas do sistema na hora, entao
//!   sobrevive a um crash do app sem `fsync`. Passando de [`LOG_LIMIT`], o
//!   arquivo e reescrito com o ultimo [`LOG_KEEP`], a partir de uma linha.
//! - `<tag>.json`, com pasta, tamanho do terminal e, quando um agente roda
//!   nele, a conversa em uso, amostrada pela thread de estado do
//!   [`super::terminal::TerminalManager`]. O fim do shell com o app aberto
//!   apaga o agente; a saida do app e uma queda mantem.
//!
//! A `tag` e o identificador estavel da sessao no frontend, validada antes de
//! virar nome de arquivo. `pty_forget` apaga os dois arquivos de uma sessao
//! encerrada de proposito e `pty_prune` os de sessoes que o frontend nao
//! conhece mais.

use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::platform::ShellFlavor;

use super::resume::{self, AgentSession};

/// Historico mantido depois de reescrever o arquivo.
pub const LOG_KEEP: u64 = 1024 * 1024;
/// Tamanho a partir do qual o historico e reescrito.
pub const LOG_LIMIT: u64 = 2 * LOG_KEEP;
const META_VERSION: u32 = 1;
const META_LIMIT: u64 = 256 * 1024;
const TAG_LIMIT: usize = 80;
/// Trecho em que se procura a primeira quebra de linha de um corte.
const LINE_SEARCH: usize = 64 * 1024;

/// Volta o terminal ao estado padrao depois de um historico que pode ter
/// parado no meio de um programa de tela cheia: encerra a saida sincronizada,
/// sai da tela alternativa, libera a regiao de rolagem sem mover o cursor,
/// mostra o cursor, desliga teclas de aplicacao, mouse, foco, colagem entre
/// colchetes e teclado estendido, e desce ao fim da tela para a linha
/// seguinte nao cobrir nada.
pub const TERMINAL_RESET: &[u8] = b"\x1b[?2026l\x1b[?1049l\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?1l\x1b>\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l\x1b[?1004l\x1b[?2004l\x1b[<u\x1b[>4;0m\x1b[?7h\x1b[0m\x1b[999B\r\n";

/// Estado gravado de uma sessao.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedMeta {
    pub version: u32,
    pub tag: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub updated_at_ms: u64,
    /// Agente rodando na sessao na ultima amostra, com a conversa.
    pub agent: Option<AgentSession>,
}

impl SavedMeta {
    pub fn sample(tag: &str, cwd: &str, cols: u16, rows: u16, agent: Option<AgentSession>) -> Self {
        Self {
            version: META_VERSION,
            tag: tag.to_string(),
            cwd: cwd.to_string(),
            cols,
            rows,
            updated_at_ms: 0,
            agent,
        }
    }

    /// O que muda o arquivo. O instante da gravacao fica de fora, para uma
    /// sessao parada nao ser regravada a cada amostra.
    fn signature(&self) -> String {
        serde_json::to_string(&(&self.cwd, self.cols, self.rows, &self.agent)).unwrap_or_default()
    }
}

/// O que o frontend recebe para restaurar uma sessao sem PTY.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedTerminal {
    pub tag: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub updated_at_ms: u64,
    pub history_bytes: u64,
    pub resume: Option<ResumePlan>,
}

/// Comando que devolve a conversa do agente num shell novo.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumePlan {
    pub agent: String,
    pub session_id: String,
    pub command: String,
}

/// Tag que pode virar nome de arquivo: letras, numeros, `_` e `-`.
pub fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= TAG_LIMIT
        && tag
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

pub struct JournalStore {
    dir: PathBuf,
    /// Assinatura do ultimo estado gravado por tag.
    written: Mutex<HashMap<String, String>>,
    /// Sessoes encerradas de proposito: nada mais e gravado para elas.
    forgotten: Mutex<HashSet<String>>,
}

impl JournalStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            dir,
            written: Mutex::new(HashMap::new()),
            forgotten: Mutex::new(HashSet::new()),
        }
    }

    fn path(&self, tag: &str, extension: &str) -> PathBuf {
        self.dir.join(format!("{tag}.{extension}"))
    }

    fn accepts(&self, tag: &str) -> bool {
        valid_tag(tag) && !lock(&self.forgotten).contains(tag)
    }

    /// Abre o historico da sessao para acrescentar. Havendo historico de uma
    /// vida anterior do shell, grava a volta ao estado padrao e a data antes
    /// da saida nova.
    pub fn writer(&self, tag: &str) -> Option<JournalWriter> {
        if !self.accepts(tag) {
            return None;
        }
        if let Err(error) = fs::create_dir_all(&self.dir) {
            eprintln!(
                "[terminais] pasta do historico indisponivel em {}: {error}",
                self.dir.display()
            );
            return None;
        }
        let mut writer = JournalWriter::open(self.path(tag, "log"))?;
        if writer.size > 0 {
            let label = chrono::Local::now().format("Shell reaberto em %d/%m às %H:%M");
            let mut marker = TERMINAL_RESET.to_vec();
            marker.extend_from_slice(format!("\x1b[2m{label}\x1b[0m\r\n").as_bytes());
            writer.append(&marker);
        }
        Some(writer)
    }

    /// Grava o estado quando ele mudou. `current` confirma, ja com a vez de
    /// gravar, que a amostra ainda vale: uma amostra atrasada nao desfaz o fim
    /// da sessao gravado entre a leitura e a escrita.
    pub fn write_meta(&self, meta: &SavedMeta, current: impl FnOnce() -> bool) {
        if !self.accepts(&meta.tag) {
            return;
        }
        let signature = meta.signature();
        let mut written = lock(&self.written);
        if written.get(&meta.tag) == Some(&signature) || !current() {
            return;
        }
        let record = SavedMeta {
            version: META_VERSION,
            updated_at_ms: now_ms(),
            ..meta.clone()
        };
        let body = serde_json::to_vec(&record).unwrap_or_default();
        match write_atomic(&self.path(&meta.tag, "json"), &body) {
            Ok(()) => {
                written.insert(meta.tag.clone(), signature);
            }
            Err(error) => eprintln!(
                "[terminais] estado da sessao {} nao gravado: {error}",
                meta.tag
            ),
        }
    }

    /// Estado guardado, com o comando de retomada ja validado.
    pub fn saved(&self, tag: &str, flavor: ShellFlavor) -> Option<SavedTerminal> {
        if !self.accepts(tag) {
            return None;
        }
        let history_bytes = fs::metadata(self.path(tag, "log"))
            .map(|meta| meta.len().min(LOG_LIMIT))
            .unwrap_or(0);
        let Some(meta) = self.meta(tag) else {
            return (history_bytes > 0).then(|| SavedTerminal {
                tag: tag.to_string(),
                cwd: String::new(),
                cols: 0,
                rows: 0,
                updated_at_ms: 0,
                history_bytes,
                resume: None,
            });
        };
        let resume = meta.agent.as_ref().and_then(|agent| {
            resume::resume_command(agent, &meta.cwd, flavor).map(|command| ResumePlan {
                agent: agent.agent.clone(),
                session_id: agent.session_id.clone(),
                command,
            })
        });
        Some(SavedTerminal {
            tag: tag.to_string(),
            cwd: meta.cwd,
            cols: meta.cols,
            rows: meta.rows,
            updated_at_ms: meta.updated_at_ms,
            history_bytes,
            resume,
        })
    }

    fn meta(&self, tag: &str) -> Option<SavedMeta> {
        let path = self.path(tag, "json");
        if fs::metadata(&path).ok()?.len() > META_LIMIT {
            return None;
        }
        let meta: SavedMeta = serde_json::from_slice(&fs::read(&path).ok()?).ok()?;
        (meta.version == META_VERSION).then_some(meta)
    }

    /// Historico gravado, com a volta ao estado padrao no fim. Vazio quando
    /// nao ha.
    pub fn history(&self, tag: &str) -> Vec<u8> {
        if !self.accepts(tag) {
            return Vec::new();
        }
        let Ok((mut bytes, truncated)) = read_tail(&self.path(tag, "log"), LOG_LIMIT) else {
            return Vec::new();
        };
        if truncated {
            bytes.drain(..line_start(&bytes));
        }
        if !bytes.is_empty() {
            bytes.extend_from_slice(TERMINAL_RESET);
        }
        bytes
    }

    pub fn forget(&self, tag: &str) {
        if !valid_tag(tag) {
            return;
        }
        lock(&self.forgotten).insert(tag.to_string());
        lock(&self.written).remove(tag);
        let _ = fs::remove_file(self.path(tag, "log"));
        let _ = fs::remove_file(self.path(tag, "json"));
    }

    /// Apaga historico e estado das tags fora de `keep`. Devolve quantos
    /// arquivos saíram.
    pub fn prune(&self, keep: &HashSet<String>) -> usize {
        let Ok(entries) = fs::read_dir(&self.dir) else {
            return 0;
        };
        let mut removed = 0;
        for path in entries.flatten().map(|entry| entry.path()) {
            let Some((tag, extension)) = path
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.rsplit_once('.'))
            else {
                continue;
            };
            if !matches!(extension, "log" | "json") || !valid_tag(tag) || keep.contains(tag) {
                continue;
            }
            if fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
        lock(&self.written).retain(|tag, _| keep.contains(tag));
        removed
    }
}

/// Historico aberto de uma sessao, de posse da thread de lote.
pub struct JournalWriter {
    path: PathBuf,
    file: Option<File>,
    size: u64,
}

impl JournalWriter {
    fn open(path: PathBuf) -> Option<Self> {
        match OpenOptions::new().create(true).append(true).open(&path) {
            Ok(file) => {
                let size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
                Some(Self {
                    path,
                    file: Some(file),
                    size,
                })
            }
            Err(error) => {
                eprintln!(
                    "[terminais] historico indisponivel em {}: {error}",
                    path.display()
                );
                None
            }
        }
    }

    /// Acrescenta um lote. Falha de disco desliga o historico desta sessao,
    /// nunca o terminal.
    pub fn append(&mut self, bytes: &[u8]) {
        let Some(file) = self.file.as_mut() else {
            return;
        };
        if let Err(error) = file.write_all(bytes) {
            eprintln!(
                "[terminais] historico interrompido em {}: {error}",
                self.path.display()
            );
            self.file = None;
            return;
        }
        self.size += bytes.len() as u64;
        if self.size > LOG_LIMIT {
            match compact(&self.path) {
                Ok((file, size)) => {
                    self.file = Some(file);
                    self.size = size;
                }
                Err(error) => {
                    eprintln!(
                        "[terminais] historico interrompido em {}: {error}",
                        self.path.display()
                    );
                    self.file = None;
                }
            }
        }
    }
}

/// Reescreve o arquivo com o ultimo [`LOG_KEEP`], a partir de uma linha, e
/// devolve o arquivo reaberto para acrescentar.
fn compact(path: &Path) -> io::Result<(File, u64)> {
    let (tail, _) = read_tail(path, LOG_KEEP)?;
    let kept = &tail[line_start(&tail)..];
    write_atomic(path, kept)?;
    let file = OpenOptions::new().append(true).open(path)?;
    Ok((file, kept.len() as u64))
}

/// Ultimos `limit` bytes do arquivo e se houve corte.
fn read_tail(path: &Path, limit: u64) -> io::Result<(Vec<u8>, bool)> {
    let mut file = File::open(path)?;
    let size = file.metadata()?.len();
    let start = size.saturating_sub(limit);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::with_capacity((size - start) as usize);
    file.take(limit).read_to_end(&mut bytes)?;
    Ok((bytes, start > 0))
}

/// Primeiro byte depois da primeira quebra de linha, para um historico
/// cortado nao comecar no meio de uma sequencia de escape. Sem quebra no
/// comeco do trecho, o corte fica como esta.
fn line_start(bytes: &[u8]) -> usize {
    bytes
        .iter()
        .take(LINE_SEARCH)
        .position(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("estado");
    let temporary = dir.join(format!(
        ".{name}.{}.{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let written = File::create(&temporary)
        .and_then(|mut file| file.write_all(bytes))
        .and_then(|()| fs::rename(&temporary, path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::resume::CLAUDE;

    const ID: &str = "ef374958-11c4-4e44-8fce-798df3af068e";

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oc-journal-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack
            .windows(needle.len())
            .position(|window| window == needle)
    }

    #[test]
    fn tags_are_plain_names() {
        let long = "x".repeat(TAG_LIMIT + 1);
        assert!(valid_tag("s_mtvmbuj4c40nxp"));
        for bad in ["", "../x", "a/b", "a.b", "a b", long.as_str()] {
            assert!(!valid_tag(bad), "{bad}");
        }
    }

    #[test]
    fn long_history_keeps_the_tail_from_a_line_start() {
        let dir = scratch("tail");
        let store = JournalStore::new(dir.clone());
        let mut writer = store.writer("s_tail").unwrap();
        let mut total = 0u64;
        let mut number = 0u32;
        while total < LOG_LIMIT + LOG_KEEP {
            let line = format!("linha-{number:08}\r\n");
            writer.append(line.as_bytes());
            total += line.len() as u64;
            number += 1;
        }
        let size = fs::metadata(dir.join("s_tail.log")).unwrap().len();
        assert!(size <= LOG_LIMIT, "tamanho {size}");
        let history = store.history("s_tail");
        assert!(history.starts_with(b"linha-"));
        assert!(contains(&history, format!("linha-{:08}\r\n", number - 1).as_bytes()).is_some());
        assert!(history.ends_with(TERMINAL_RESET));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn reopening_marks_the_boundary_between_lives() {
        let dir = scratch("boundary");
        let store = JournalStore::new(dir.clone());
        store.writer("s_b").unwrap().append(b"primeira vida\r\n");
        assert!(contains(&store.history("s_b"), b"Shell reaberto").is_none());
        store.writer("s_b").unwrap().append(b"segunda vida\r\n");
        let history = store.history("s_b");
        let first = contains(&history, b"primeira vida").unwrap();
        let marker = contains(&history, "Shell reaberto".as_bytes()).unwrap();
        let second = contains(&history, b"segunda vida").unwrap();
        assert!(first < marker && marker < second);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn state_builds_the_resume_plan_and_skips_repeated_or_stale_samples() {
        let dir = scratch("meta");
        let store = JournalStore::new(dir.clone());
        let agent = AgentSession {
            agent: CLAUDE.into(),
            session_id: ID.into(),
            cwd: None,
            config_dir: None,
            profile_name: None,
            args: vec!["--dangerously-skip-permissions".into()],
        };
        store.write_meta(
            &SavedMeta::sample("s_m", "/tmp", 120, 40, Some(agent.clone())),
            || true,
        );
        let saved = store.saved("s_m", ShellFlavor::Posix).unwrap();
        assert_eq!((saved.cols, saved.rows, saved.history_bytes), (120, 40, 0));
        assert!(saved.updated_at_ms > 0);
        let plan = saved.resume.unwrap();
        assert_eq!(plan.agent, CLAUDE);
        assert_eq!(
            plan.command,
            format!("claude --resume {ID} --dangerously-skip-permissions")
        );

        // A mesma amostra nao regrava, e uma amostra que perdeu a sessao tambem nao.
        fs::remove_file(dir.join("s_m.json")).unwrap();
        store.write_meta(
            &SavedMeta::sample("s_m", "/tmp", 120, 40, Some(agent)),
            || true,
        );
        assert!(store.saved("s_m", ShellFlavor::Posix).is_none());
        store.write_meta(&SavedMeta::sample("s_m", "/tmp", 120, 40, None), || false);
        assert!(store.saved("s_m", ShellFlavor::Posix).is_none());
        store.write_meta(&SavedMeta::sample("s_m", "/tmp", 120, 40, None), || true);
        assert!(
            store
                .saved("s_m", ShellFlavor::Posix)
                .unwrap()
                .resume
                .is_none()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn tampered_state_never_becomes_a_command() {
        let dir = scratch("tamper");
        fs::create_dir_all(&dir).unwrap();
        let body = serde_json::json!({
            "version": 1, "tag": "s_t", "cwd": "/tmp", "cols": 80, "rows": 24, "updatedAtMs": 1,
            "agent": {"agent": CLAUDE, "sessionId": "x; rm -rf ~", "cwd": null, "configDir": null, "profileName": null, "args": []}
        });
        fs::write(dir.join("s_t.json"), body.to_string()).unwrap();
        let store = JournalStore::new(dir.clone());
        assert!(
            store
                .saved("s_t", ShellFlavor::Posix)
                .unwrap()
                .resume
                .is_none()
        );
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn forget_and_prune_touch_only_other_sessions() {
        let dir = scratch("prune");
        let store = JournalStore::new(dir.clone());
        for tag in ["s_keep", "s_gone", "s_closed"] {
            store.writer(tag).unwrap().append(b"x\r\n");
            store.write_meta(&SavedMeta::sample(tag, "/tmp", 80, 24, None), || true);
        }
        store.forget("s_closed");
        assert!(store.saved("s_closed", ShellFlavor::Posix).is_none());
        store.write_meta(
            &SavedMeta::sample("s_closed", "/tmp", 100, 30, None),
            || true,
        );
        assert!(store.writer("s_closed").is_none());
        assert!(store.saved("s_closed", ShellFlavor::Posix).is_none());
        let keep: HashSet<String> = ["s_keep".to_string()].into_iter().collect();
        assert_eq!(store.prune(&keep), 2);
        assert!(store.saved("s_keep", ShellFlavor::Posix).is_some());
        assert!(store.saved("s_gone", ShellFlavor::Posix).is_none());
        assert!(store.writer("../fora").is_none());
        let _ = fs::remove_dir_all(dir);
    }
}
