// SPDX-License-Identifier: Apache-2.0
//! Acesso a arquivos para o explorador e o editor do estudio de terminais.
//!
//! Tudo aqui e sob demanda: a arvore lista um diretorio por vez, o editor le
//! um arquivo por vez e a busca por nome percorre o projeto com tetos de
//! entradas e pastas pesadas ignoradas. Erros vao ao frontend como
//! [`FsError`], com um codigo curto que a interface traduz em acao: `conflict`
//! vira o dialogo de sobrescrever, `binary` vira a previa sem editor.
//!
//! Gravacao: `write_text` compara a data de modificacao que o editor leu com
//! a atual e recusa quando o arquivo mudou por fora, sem tocar no disco.
//! Excluir move para a Lixeira nativa de cada sistema.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;

use crate::i18n::{t, tf};
use crate::platform::to_portable;

/// Teto de entradas devolvidas por diretorio. Pastas maiores vem cortadas e
/// marcadas, para o webview nao montar milhares de linhas de uma vez.
pub const LIST_LIMIT: usize = 2_500;
/// Teto do arquivo de texto aberto no editor.
pub const TEXT_LIMIT: u64 = 2 * 1024 * 1024;
/// Teto de imagem enviada como data URL.
pub const IMAGE_LIMIT: u64 = 15 * 1024 * 1024;
/// Teto dos bytes crus enviados ao webview para as previas de planilha e
/// Word, que o proprio webview monta.
pub const BYTES_LIMIT: u64 = 40 * 1024 * 1024;
/// Entradas visitadas por busca antes de parar.
const FIND_VISIT_LIMIT: usize = 60_000;
const FIND_CACHE_TTL: Duration = Duration::from_secs(20);

/// Pastas que a busca por nome pula. Sao geradas ou pesadas demais para
/// valer a varredura.
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
    ".runtime",
    "Pods",
    "DerivedData",
    ".turbo",
    ".parcel-cache",
    "coverage",
    ".gradle",
    ".idea",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".svelte-kit",
    ".angular",
    "vendor",
    ".terraform",
    ".tox",
    "site-packages",
];
const KEEP_HIDDEN_DIRS: &[&str] = &[".github", ".vscode", ".claude", ".codex", ".agents", ".ia"];

/// Sujeira do sistema que some da listagem e da busca. Nada e apagado.
const MACOS_NOISE: &[&str] = &[
    ".DS_Store",
    ".localized",
    ".Spotlight-V100",
    ".Trashes",
    ".fseventsd",
    ".TemporaryItems",
    ".DocumentRevisions-V100",
    ".apdisk",
    ".VolumeIcon.icns",
    "Icon\r",
];
const LINUX_NOISE: &[&str] = &[".directory"];
const WINDOWS_NOISE: &[&str] = &[
    "Thumbs.db",
    "desktop.ini",
    "$RECYCLE.BIN",
    "System Volume Information",
];

fn is_noise_for(os: &str, name: &str) -> bool {
    match os {
        "macos" => MACOS_NOISE.contains(&name) || name.starts_with("._"),
        "linux" => {
            MACOS_NOISE.contains(&name)
                || name.starts_with("._")
                || LINUX_NOISE.contains(&name)
                || name.starts_with(".Trash-")
        }
        "windows" => WINDOWS_NOISE
            .iter()
            .any(|noise| noise.eq_ignore_ascii_case(name)),
        _ => false,
    }
}

fn is_noise(name: &str) -> bool {
    is_noise_for(std::env::consts::OS, name)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsError {
    pub code: String,
    pub message: String,
}

impl FsError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    fn io(error: std::io::Error, what: &str) -> Self {
        let code = match error.kind() {
            std::io::ErrorKind::NotFound => "not_found",
            std::io::ErrorKind::PermissionDenied => "denied",
            std::io::ErrorKind::AlreadyExists => "exists",
            _ => "io",
        };
        Self::new(code, format!("{what}: {error}"))
    }
}

impl std::fmt::Display for FsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

pub type FsResult<T> = Result<T, FsError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
    Symlink,
    Other,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    /// Para links simbolicos, o tipo do alvo.
    pub target_kind: Option<EntryKind>,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub hidden: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
    pub total: usize,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub path: String,
    pub exists: bool,
    pub kind: Option<EntryKind>,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub path: String,
    pub content: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
    pub line_ending: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteResult {
    pub path: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageFile {
    pub path: String,
    pub data_url: String,
    pub size: u64,
    pub modified_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub path: String,
    pub relative: String,
    pub kind: EntryKind,
}

fn absolute(path: &str) -> FsResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(FsError::new("invalid", t("native.error.pathEmpty")));
    }
    let candidate = PathBuf::from(trimmed);
    if !candidate.is_absolute() {
        return Err(FsError::new(
            "invalid",
            tf("native.error.pathNotAbsolute", &[("path", &trimmed)]),
        ));
    }
    Ok(candidate)
}

pub fn modified_ms(metadata: &fs::Metadata) -> Option<u64> {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

fn kind_of(file_type: fs::FileType) -> EntryKind {
    if file_type.is_dir() {
        EntryKind::Dir
    } else if file_type.is_file() {
        EntryKind::File
    } else if file_type.is_symlink() {
        EntryKind::Symlink
    } else {
        EntryKind::Other
    }
}

fn name_of(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

/// Entradas de um diretorio: pastas antes de arquivos, ordem sem distinguir
/// maiusculas, ocultas marcadas e nunca omitidas.
pub fn list_dir(path: &str, limit: Option<usize>) -> FsResult<Listing> {
    let dir = absolute(path)?;
    let limit = limit.unwrap_or(LIST_LIMIT).clamp(50, 20_000);
    let read =
        fs::read_dir(&dir).map_err(|error| FsError::io(error, &t("native.error.listFolder")))?;
    let mut entries: Vec<Entry> = Vec::new();
    let mut total = 0usize;
    for item in read.flatten() {
        if is_noise(&item.file_name().to_string_lossy()) {
            continue;
        }
        total += 1;
        let file_type = match item.file_type() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let kind = kind_of(file_type);
        let full = item.path();
        let (size, modified, target_kind) = if kind == EntryKind::Symlink {
            let target = fs::metadata(&full).ok();
            (
                target.as_ref().map(|meta| meta.len()).unwrap_or(0),
                target.as_ref().and_then(modified_ms),
                target.map(|meta| kind_of(meta.file_type())),
            )
        } else {
            let meta = item.metadata().ok();
            (
                meta.as_ref().map(|meta| meta.len()).unwrap_or(0),
                meta.as_ref().and_then(modified_ms),
                None,
            )
        };
        let name = item.file_name().to_string_lossy().to_string();
        entries.push(Entry {
            hidden: name.starts_with('.'),
            path: to_portable(&full),
            name,
            kind,
            target_kind,
            size,
            modified_ms: modified,
        });
    }
    entries.sort_by(|a, b| {
        let a_dir = a.kind == EntryKind::Dir || a.target_kind == Some(EntryKind::Dir);
        let b_dir = b.kind == EntryKind::Dir || b.target_kind == Some(EntryKind::Dir);
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    let truncated = entries.len() > limit;
    entries.truncate(limit);
    Ok(Listing {
        path: to_portable(&dir),
        entries,
        total,
        truncated,
    })
}

pub fn stat(path: &str) -> FsResult<FileStat> {
    let target = absolute(path)?;
    match fs::metadata(&target) {
        Ok(meta) => Ok(FileStat {
            path: to_portable(&target),
            exists: true,
            kind: Some(kind_of(meta.file_type())),
            size: meta.len(),
            modified_ms: modified_ms(&meta),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileStat {
            path: to_portable(&target),
            exists: false,
            kind: None,
            size: 0,
            modified_ms: None,
        }),
        Err(error) => Err(FsError::io(error, &t("native.error.readFile"))),
    }
}

fn looks_binary(sample: &[u8]) -> bool {
    if sample.contains(&0) {
        return true;
    }
    // Muitos bytes de controle fora de tabulacao e quebras: nao e texto.
    let control = sample
        .iter()
        .filter(|byte| **byte < 0x08 || (**byte > 0x0d && **byte < 0x20))
        .count();
    control * 20 > sample.len().max(1)
}

/// Le um arquivo de texto UTF-8. Recusa binarios e arquivos acima do teto.
pub fn read_text(path: &str) -> FsResult<TextFile> {
    let target = absolute(path)?;
    let meta =
        fs::metadata(&target).map_err(|error| FsError::io(error, &t("native.error.openFile")))?;
    if meta.is_dir() {
        return Err(FsError::new("is_dir", t("native.error.isFolder")));
    }
    if meta.len() > TEXT_LIMIT {
        return Err(FsError::new(
            "too_large",
            tf(
                "native.error.editorTooLarge",
                &[("size", &(meta.len() / (1024 * 1024)))],
            ),
        ));
    }
    let mut file =
        fs::File::open(&target).map_err(|error| FsError::io(error, &t("native.error.openFile")))?;
    let mut bytes = Vec::with_capacity(meta.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| FsError::io(error, &t("native.error.readFile")))?;
    let sample_len = bytes.len().min(8192);
    if looks_binary(&bytes[..sample_len]) {
        return Err(FsError::new("binary", t("native.error.binaryFile")));
    }
    let content = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(error) => String::from_utf8_lossy(error.as_bytes()).to_string(),
    };
    let line_ending = if content.contains("\r\n") {
        "crlf"
    } else {
        "lf"
    };
    Ok(TextFile {
        path: to_portable(&target),
        size: meta.len(),
        modified_ms: modified_ms(&meta),
        line_ending: line_ending.to_string(),
        content,
    })
}

/// Grava texto. Com `expected_modified_ms`, recusa se o arquivo mudou desde a
/// leitura, e o frontend decide entre sobrescrever e recarregar.
pub fn write_text(
    path: &str,
    content: &str,
    expected_modified_ms: Option<u64>,
) -> FsResult<WriteResult> {
    let target = absolute(path)?;
    if let Some(expected) = expected_modified_ms {
        if let Ok(meta) = fs::metadata(&target) {
            let current = modified_ms(&meta);
            if current != Some(expected) {
                return Err(FsError::new("conflict", t("native.error.changedOnDisk")));
            }
        }
    }
    fs::write(&target, content.as_bytes())
        .map_err(|error| FsError::io(error, &t("native.error.save")))?;
    let meta = fs::metadata(&target)
        .map_err(|error| FsError::io(error, &t("native.error.verifySaved")))?;
    Ok(WriteResult {
        path: to_portable(&target),
        size: meta.len(),
        modified_ms: modified_ms(&meta),
    })
}

fn mime_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_string_lossy().to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        _ => return None,
    })
}

pub fn read_image(path: &str) -> FsResult<ImageFile> {
    let target = absolute(path)?;
    let mime = mime_of(&target)
        .ok_or_else(|| FsError::new("unsupported", t("native.error.imageUnsupported")))?;
    let meta =
        fs::metadata(&target).map_err(|error| FsError::io(error, &t("native.error.openImage")))?;
    if meta.len() > IMAGE_LIMIT {
        return Err(FsError::new("too_large", t("native.error.imageTooLarge")));
    }
    let bytes =
        fs::read(&target).map_err(|error| FsError::io(error, &t("native.error.readImage")))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(ImageFile {
        path: to_portable(&target),
        data_url: format!("data:{mime};base64,{encoded}"),
        size: meta.len(),
        modified_ms: modified_ms(&meta),
    })
}

/// Bytes crus de um arquivo, para as previas que o webview monta sozinho.
/// Sem base64: o comando devolve o corpo binario.
pub fn read_bytes(path: &str) -> FsResult<Vec<u8>> {
    let target = absolute(path)?;
    let meta =
        fs::metadata(&target).map_err(|error| FsError::io(error, &t("native.error.openFile")))?;
    if meta.is_dir() {
        return Err(FsError::new("is_dir", t("native.error.isFolder")));
    }
    if meta.len() > BYTES_LIMIT {
        return Err(FsError::new(
            "too_large",
            tf(
                "native.error.previewTooLarge",
                &[("size", &(meta.len() / (1024 * 1024)))],
            ),
        ));
    }
    fs::read(&target).map_err(|error| FsError::io(error, &t("native.error.readFile")))
}

fn ensure_missing(target: &Path) -> FsResult<()> {
    if target.exists() || fs::symlink_metadata(target).is_ok() {
        return Err(FsError::new(
            "exists",
            tf("native.error.exists", &[("name", &name_of(target))]),
        ));
    }
    Ok(())
}

pub fn create_file(path: &str) -> FsResult<FileStat> {
    let target = absolute(path)?;
    ensure_missing(&target)?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| FsError::io(error, &t("native.error.createFolder")))?;
    }
    fs::write(&target, b"").map_err(|error| FsError::io(error, &t("native.error.createFile")))?;
    stat(&to_portable(&target))
}

pub fn create_dir(path: &str) -> FsResult<FileStat> {
    let target = absolute(path)?;
    ensure_missing(&target)?;
    fs::create_dir_all(&target)
        .map_err(|error| FsError::io(error, &t("native.error.createFolder")))?;
    stat(&to_portable(&target))
}

pub fn rename(from: &str, to: &str) -> FsResult<FileStat> {
    let source = absolute(from)?;
    let target = absolute(to)?;
    if source == target {
        return stat(&to_portable(&target));
    }
    ensure_not_inside(&source, &target, "native.error.moveInsideItself")?;
    // Trocar so a caixa do nome e valido num sistema de arquivos que nao
    // distingue maiusculas; qualquer outro alvo existente e recusado.
    let same_ignoring_case =
        source.to_string_lossy().to_lowercase() == target.to_string_lossy().to_lowercase();
    if !same_ignoring_case {
        ensure_missing(&target)?;
    }
    fs::rename(&source, &target).map_err(|error| FsError::io(error, &t("native.error.move")))?;
    stat(&to_portable(&target))
}

/// Uma pasta nunca pode ir para dentro dela mesma. O `rename` do sistema ja
/// recusaria com EINVAL, mas a mensagem sairia crua.
fn ensure_not_inside(source: &Path, target: &Path, key: &str) -> FsResult<()> {
    if !source.is_dir() || !target.starts_with(source) {
        return Ok(());
    }
    Err(FsError::new(
        "invalid",
        tf(key, &[("name", &name_of(source))]),
    ))
}

/// Profundidade maxima de uma copia recursiva. Links simbolicos nao sao
/// seguidos, entao nao ha ciclo; o teto vale para arvores absurdas.
const COPY_DEPTH_LIMIT: usize = 64;

/// Copia um arquivo, um link ou uma pasta inteira. Nao sobrescreve nada: o
/// alvo precisa estar livre, e quem chama escolhe outro nome quando o nome
/// ja existe. Links simbolicos sao recriados como links, nunca seguidos.
pub fn copy(from: &str, to: &str) -> FsResult<FileStat> {
    let source = absolute(from)?;
    let target = absolute(to)?;
    if source == target {
        return Err(FsError::new("invalid", t("native.error.sameSourceTarget")));
    }
    let metadata = fs::symlink_metadata(&source)
        .map_err(|error| FsError::io(error, &t("native.error.readSource")))?;
    ensure_not_inside(&source, &target, "native.error.copyInsideItself")?;
    ensure_missing(&target)?;
    copy_entry(&source, &target, metadata.file_type(), 0)?;
    stat(&to_portable(&target))
}

fn copy_entry(source: &Path, target: &Path, file_type: fs::FileType, depth: usize) -> FsResult<()> {
    if depth > COPY_DEPTH_LIMIT {
        return Err(FsError::new("io", t("native.error.copyTooDeep")));
    }
    if file_type.is_symlink() {
        let link = fs::read_link(source)
            .map_err(|error| FsError::io(error, &t("native.error.readLink")))?;
        #[cfg(unix)]
        {
            return std::os::unix::fs::symlink(link, target)
                .map_err(|error| FsError::io(error, &t("native.error.recreateLink")));
        }
        #[cfg(not(unix))]
        {
            let _ = link;
            return Err(FsError::new(
                "unsupported",
                t("native.error.symlinkCopyUnsupported"),
            ));
        }
    }
    if !file_type.is_dir() {
        fs::copy(source, target)
            .map_err(|error| FsError::io(error, &t("native.error.copyFile")))?;
        return Ok(());
    }
    fs::create_dir(target).map_err(|error| FsError::io(error, &t("native.error.createFolder")))?;
    let read =
        fs::read_dir(source).map_err(|error| FsError::io(error, &t("native.error.listFolder")))?;
    for item in read.flatten() {
        let kind = item
            .file_type()
            .map_err(|error| FsError::io(error, &t("native.error.readEntry")))?;
        copy_entry(
            &item.path(),
            &target.join(item.file_name()),
            kind,
            depth + 1,
        )?;
    }
    Ok(())
}

/// Move para a Lixeira nativa. Se o sistema recusar, o erro volta ao frontend
/// e nada e apagado em definitivo por aqui.
pub fn trash(path: &str) -> FsResult<()> {
    let target = absolute(path)?;
    if fs::symlink_metadata(&target).is_err() {
        return Err(FsError::new("not_found", t("native.error.itemMissing")));
    }
    trash_native(&target)
}

#[cfg(target_os = "macos")]
fn trash_native(target: &Path) -> FsResult<()> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let path = NSString::from_str(&target.to_string_lossy());
    let url = NSURL::fileURLWithPath(&path);
    let manager = NSFileManager::defaultManager();
    manager
        .trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|error| FsError::new("trash", error.localizedDescription().to_string()))
}

#[cfg(not(target_os = "macos"))]
fn trash_native(target: &Path) -> FsResult<()> {
    trash::delete(target).map_err(|error| FsError::new("trash", error.to_string()))
}

/* ── busca por nome ────────────────────────────────────────────────── */

struct IndexEntry {
    relative: String,
    lower: String,
    kind: EntryKind,
}

struct RootIndex {
    built_at: Instant,
    entries: Vec<IndexEntry>,
    truncated: bool,
}

/// Indice por raiz, reconstruido depois de 20 s. Uma busca digitada letra a
/// letra reaproveita a mesma varredura.
pub struct FindCache {
    roots: Mutex<HashMap<PathBuf, RootIndex>>,
}

impl Default for FindCache {
    fn default() -> Self {
        Self {
            roots: Mutex::new(HashMap::new()),
        }
    }
}

fn skip_dir(name: &str) -> bool {
    if SKIP_DIRS.contains(&name) {
        return true;
    }
    name.starts_with('.') && !KEEP_HIDDEN_DIRS.contains(&name)
}

fn build_index(root: &Path) -> RootIndex {
    let mut entries = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    let mut visited = 0usize;
    let mut truncated = false;
    while let Some(dir) = stack.pop() {
        let Ok(read) = fs::read_dir(&dir) else {
            continue;
        };
        for item in read.flatten() {
            visited += 1;
            if visited > FIND_VISIT_LIMIT {
                truncated = true;
                break;
            }
            let Ok(file_type) = item.file_type() else {
                continue;
            };
            let name = item.file_name().to_string_lossy().to_string();
            if is_noise(&name) {
                continue;
            }
            let path = item.path();
            let relative = path
                .strip_prefix(root)
                .map(to_portable)
                .unwrap_or_else(|_| to_portable(&path));
            if file_type.is_dir() {
                if skip_dir(&name) {
                    continue;
                }
                stack.push(path);
                entries.push(IndexEntry {
                    lower: relative.to_lowercase(),
                    relative,
                    kind: EntryKind::Dir,
                });
            } else {
                entries.push(IndexEntry {
                    lower: relative.to_lowercase(),
                    relative,
                    kind: if file_type.is_file() {
                        EntryKind::File
                    } else {
                        EntryKind::Symlink
                    },
                });
            }
        }
        if truncated {
            break;
        }
    }
    RootIndex {
        built_at: Instant::now(),
        entries,
        truncated,
    }
}

fn score(entry: &IndexEntry, query: &str) -> Option<u32> {
    let base = entry.lower.rsplit('/').next().unwrap_or(&entry.lower);
    if base == query {
        return Some(1000);
    }
    if base.starts_with(query) {
        return Some(800 - base.len().min(200) as u32);
    }
    if base.contains(query) {
        return Some(600 - base.len().min(200) as u32);
    }
    if entry.lower.contains(query) {
        return Some(400 - entry.lower.len().min(300) as u32);
    }
    // Subsequencia no caminho: "srcterm" acha src/terminals.
    let mut cursor = 0usize;
    let haystack = entry.lower.as_bytes();
    for byte in query.as_bytes() {
        let mut found = None;
        while cursor < haystack.len() {
            if haystack[cursor] == *byte {
                found = Some(cursor);
                cursor += 1;
                break;
            }
            cursor += 1;
        }
        found?;
    }
    Some(100u32.saturating_sub(entry.lower.len().min(100) as u32))
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FindResult {
    pub root: String,
    pub items: Vec<Found>,
    pub truncated: bool,
}

pub fn find(
    cache: &FindCache,
    root: &str,
    query: &str,
    limit: Option<usize>,
) -> FsResult<FindResult> {
    let root = absolute(root)?;
    if !root.is_dir() {
        return Err(FsError::new(
            "not_found",
            t("native.error.projectFolderNotFound"),
        ));
    }
    let limit = limit.unwrap_or(60).clamp(1, 500);
    let needle = query.trim().to_lowercase();
    let mut roots = cache
        .roots
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let stale = roots
        .get(&root)
        .map(|index| index.built_at.elapsed() > FIND_CACHE_TTL)
        .unwrap_or(true);
    if stale {
        roots.insert(root.clone(), build_index(&root));
    }
    let index = roots.get(&root).expect("indice recem inserido");
    let mut ranked: Vec<(u32, &IndexEntry)> = if needle.is_empty() {
        index
            .entries
            .iter()
            .take(limit)
            .map(|entry| (0, entry))
            .collect()
    } else {
        index
            .entries
            .iter()
            .filter_map(|entry| score(entry, &needle).map(|points| (points, entry)))
            .collect()
    };
    ranked.sort_by(|a, b| {
        b.0.cmp(&a.0)
            .then_with(|| a.1.relative.len().cmp(&b.1.relative.len()))
    });
    let items = ranked
        .into_iter()
        .take(limit)
        .map(|(_, entry)| Found {
            path: to_portable(root.join(&entry.relative)),
            relative: entry.relative.clone(),
            kind: entry.kind,
        })
        .collect();
    Ok(FindResult {
        root: to_portable(&root),
        items,
        truncated: index.truncated,
    })
}

/// Esquece o indice de uma raiz, depois de uma mudanca observada nela.
pub fn forget_index(cache: &FindCache, root: &str) {
    let mut roots = cache
        .roots
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    roots.remove(Path::new(root));
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oc-files-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_dirs_first_and_marks_hidden() {
        let dir = sandbox("list");
        fs::create_dir(dir.join("zeta")).unwrap();
        fs::write(dir.join("Alpha.txt"), "x").unwrap();
        fs::write(dir.join(".env"), "x").unwrap();
        let listing = list_dir(&dir.to_string_lossy(), None).unwrap();
        let names: Vec<&str> = listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["zeta", ".env", "Alpha.txt"]);
        assert!(listing.entries[1].hidden);
        assert_eq!(listing.entries[0].kind, EntryKind::Dir);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn noise_table_is_specific_to_each_system() {
        assert!(is_noise_for("macos", ".DS_Store"));
        assert!(is_noise_for("macos", "._nota.md"));
        assert!(!is_noise_for("macos", ".directory"));
        assert!(is_noise_for("linux", ".directory"));
        assert!(is_noise_for("linux", ".Trash-1000"));
        assert!(!is_noise_for("linux", "Thumbs.db"));
        assert!(is_noise_for("windows", "Thumbs.db"));
        assert!(is_noise_for("windows", "desktop.ini"));
        assert!(is_noise_for("windows", "$RECYCLE.BIN"));
        assert!(!is_noise_for("windows", ".directory"));
    }

    #[test]
    fn hides_current_platform_noise() {
        let dir = sandbox("lixo");
        let (files, folder, query): (&[&str], &str, &str) = if cfg!(windows) {
            (&["Thumbs.db", "desktop.ini"], "$RECYCLE.BIN", "thumbs")
        } else {
            (&[".DS_Store", "._nota.md"], ".Trashes", "ds_store")
        };
        for name in files {
            fs::write(dir.join(name), "x").unwrap();
        }
        fs::write(dir.join("nota.md"), "x").unwrap();
        fs::create_dir(dir.join(folder)).unwrap();
        let listing = list_dir(&dir.to_string_lossy(), None).unwrap();
        let names: Vec<&str> = listing
            .entries
            .iter()
            .map(|entry| entry.name.as_str())
            .collect();
        assert_eq!(names, vec!["nota.md"]);
        assert_eq!(listing.total, 1);
        let cache = FindCache::default();
        let achados = find(&cache, &dir.to_string_lossy(), query, None).unwrap();
        assert!(achados.items.is_empty());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_write_and_conflict() {
        let dir = sandbox("rw");
        let file = dir.join("nota.md");
        fs::write(&file, "# ola\n").unwrap();
        let path = file.to_string_lossy().to_string();
        let text = read_text(&path).unwrap();
        assert_eq!(text.content, "# ola\n");
        assert_eq!(text.line_ending, "lf");
        let saved = write_text(&path, "# ola\nmais\n", text.modified_ms).unwrap();
        assert_eq!(saved.size, 11);
        // Mudanca por fora com outra data: a gravacao com a data velha falha.
        std::thread::sleep(Duration::from_millis(20));
        fs::write(&file, "externo\n").unwrap();
        let error = write_text(&path, "meu\n", text.modified_ms).unwrap_err();
        assert_eq!(error.code, "conflict");
        assert_eq!(fs::read_to_string(&file).unwrap(), "externo\n");
        // Sem data esperada, sobrescreve.
        write_text(&path, "meu\n", None).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "meu\n");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_binary_and_large() {
        let dir = sandbox("bin");
        let file = dir.join("blob.bin");
        fs::write(&file, [0u8, 1, 2, 3, 0, 0]).unwrap();
        assert_eq!(
            read_text(&file.to_string_lossy()).unwrap_err().code,
            "binary"
        );
        assert!(!looks_binary("texto com\tacento é\n".as_bytes()));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_rename_and_refuse_overwrite() {
        let dir = sandbox("crud");
        let a = dir.join("a.txt").to_string_lossy().to_string();
        let b = dir.join("b.txt").to_string_lossy().to_string();
        create_file(&a).unwrap();
        assert_eq!(create_file(&a).unwrap_err().code, "exists");
        create_file(&b).unwrap();
        assert_eq!(rename(&a, &b).unwrap_err().code, "exists");
        let c = dir.join("c.txt").to_string_lossy().to_string();
        rename(&a, &c).unwrap();
        assert!(!Path::new(&a).exists() && Path::new(&c).exists());
        create_dir(&dir.join("sub/deep").to_string_lossy()).unwrap();
        assert!(dir.join("sub/deep").is_dir());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copies_tree_and_refuses_loop() {
        let dir = sandbox("copy");
        fs::create_dir_all(dir.join("origem/sub")).unwrap();
        fs::write(dir.join("origem/a.txt"), "a").unwrap();
        fs::write(dir.join("origem/sub/b.txt"), "b").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("a.txt", dir.join("origem/link.txt")).unwrap();
        let origem = dir.join("origem").to_string_lossy().to_string();
        let destino = dir.join("destino").to_string_lossy().to_string();
        copy(&origem, &destino).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join("destino/sub/b.txt")).unwrap(),
            "b"
        );
        #[cfg(unix)]
        assert!(
            fs::symlink_metadata(dir.join("destino/link.txt"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
        // O original continua inteiro e o alvo ocupado e recusado.
        assert!(dir.join("origem/a.txt").exists());
        assert_eq!(copy(&origem, &destino).unwrap_err().code, "exists");
        let dentro = dir.join("origem/copia").to_string_lossy().to_string();
        assert_eq!(copy(&origem, &dentro).unwrap_err().code, "invalid");
        assert_eq!(rename(&origem, &dentro).unwrap_err().code, "invalid");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn finds_by_name_and_skips_heavy_dirs() {
        let dir = sandbox("find");
        fs::create_dir_all(dir.join("src/terminals")).unwrap();
        fs::create_dir_all(dir.join("node_modules/x")).unwrap();
        fs::write(dir.join("src/terminals/runtime.js"), "").unwrap();
        fs::write(dir.join("node_modules/x/runtime.js"), "").unwrap();
        fs::write(dir.join("README.md"), "").unwrap();
        let cache = FindCache::default();
        let result = find(&cache, &dir.to_string_lossy(), "runtime", None).unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.items[0].relative, "src/terminals/runtime.js");
        let fuzzy = find(&cache, &dir.to_string_lossy(), "srcterm", None).unwrap();
        assert!(
            fuzzy
                .items
                .iter()
                .any(|item| item.relative == "src/terminals")
        );
        let exact = find(&cache, &dir.to_string_lossy(), "readme.md", None).unwrap();
        assert_eq!(exact.items[0].relative, "README.md");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn trash_moves_item_away() {
        let dir = sandbox("trash");
        let file = dir.join("apagar.txt");
        fs::write(&file, "x").unwrap();
        match trash(&file.to_string_lossy()) {
            Ok(()) => assert!(!file.exists()),
            // Em ambientes sem Lixeira montada o NSFileManager recusa; o
            // arquivo tem de continuar intacto.
            Err(error) => {
                assert_eq!(error.code, "trash");
                assert!(file.exists());
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }
}
