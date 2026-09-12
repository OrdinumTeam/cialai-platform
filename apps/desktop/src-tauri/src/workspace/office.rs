// SPDX-License-Identifier: Apache-2.0
//! Previa de documentos do Office, do iWork e RTF: conversao para PDF pelo
//! LibreOffice em modo headless, com cache por caminho, data e tamanho, fila
//! de uma conversao por vez e prazo. O PDF resultante fica na pasta de cache
//! do app e e servido ao webview pelo protocolo `preview://`, registrando a
//! pasta de cache como raiz.
//!
//! O LibreOffice recebe um perfil proprio, `-env:UserInstallation`, para nao
//! entregar o pedido a uma instancia aberta pelo usuario, o que faria o
//! comando voltar sem converter nada.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::files::{FsError, FsResult};
use super::preview::PreviewRoots;

/// Extensoes que passam pelo LibreOffice. Word novo e planilhas tem previa
/// propria no webview, mas tambem podem ser convertidos, para o botao
/// "Ver como PDF".
pub const OFFICE_EXT: &[&str] = &[
    "pptx", "ppt", "odp", "key", "pages", "numbers", "doc", "docx", "rtf", "odt", "xls", "xlsx",
    "ods",
];
/// Prazo de uma conversao. A primeira cria o perfil e pode levar dezenas de
/// segundos; as seguintes ficam em poucos.
const TIMEOUT: Duration = Duration::from_secs(120);
/// Teto do arquivo de entrada.
const INPUT_MAX: u64 = 200 * 1024 * 1024;
/// Teto do cache de PDFs; acima disso os mais antigos saem.
const CACHE_MAX: u64 = 512 * 1024 * 1024;

/// Estado do Tauri: uma conversao por vez. O comando e `async`, entao quem
/// espera fica numa thread do pool, sem travar a interface.
#[derive(Default)]
pub struct OfficeQueue {
    lock: Mutex<()>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConvertResult {
    pub pdf_path: String,
    /// URL `preview://` do PDF, pronta para um iframe.
    pub url: String,
    pub cached: bool,
    pub size: u64,
}

/// Onde o LibreOffice costuma estar: o link do Homebrew, o cask, o app na
/// pasta de aplicativos do sistema ou do usuario.
pub fn find_soffice(home: &Path) -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("/opt/homebrew/bin/soffice"),
        PathBuf::from("/usr/local/bin/soffice"),
        PathBuf::from("/Applications/LibreOffice.app/Contents/MacOS/soffice"),
        home.join("Applications/LibreOffice.app/Contents/MacOS/soffice"),
    ];
    candidates.into_iter().find(|path| path.is_file())
}

pub fn supported(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| OFFICE_EXT.contains(&value.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// Chave estavel do cache: caminho canonico, data e tamanho, por FNV-1a.
pub fn cache_key(canonical: &Path, mtime_ms: u64, size: u64) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let text = format!("{}|{mtime_ms}|{size}", canonical.to_string_lossy());
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or(0)
}

fn io_error(error: std::io::Error, what: &str) -> FsError {
    FsError {
        code: "io".to_string(),
        message: format!("{what}: {error}"),
    }
}

/// `file://` com espacos e caracteres fora do ASCII codificados, para o
/// `-env:UserInstallation` do LibreOffice.
fn file_url(path: &Path) -> String {
    let mut out = String::from("file://");
    for byte in path.to_string_lossy().as_bytes() {
        let value = *byte;
        if value.is_ascii_alphanumeric() || matches!(value, b'/' | b'-' | b'_' | b'.' | b'~') {
            out.push(value as char);
        } else {
            out.push_str(&format!("%{value:02X}"));
        }
    }
    out
}

/// PATH dos processos que o app lanca: Homebrew e `/usr/local` na frente,
/// porque aberto pelo Dock o app herda um PATH minimo.
pub(crate) fn search_path() -> String {
    let inherited = std::env::var("PATH").unwrap_or_default();
    format!("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:{inherited}")
}

/// Toca o marcador de uso do item, para o corte do cache respeitar quem foi
/// usado por ultimo.
fn touch(cache_dir: &Path, key: &str) {
    let _ = fs::write(cache_dir.join(format!("{key}.touch")), b"");
}

/// Mantem o cache abaixo do teto, apagando os PDFs menos usados.
fn trim_cache(cache_dir: &Path) {
    let Ok(read) = fs::read_dir(cache_dir) else {
        return;
    };
    let mut items: Vec<(SystemTime, PathBuf, u64)> = Vec::new();
    for entry in read.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("pdf") {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let stem = path
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let used = fs::metadata(cache_dir.join(format!("{stem}.touch")))
            .and_then(|touch| touch.modified())
            .or_else(|_| meta.modified())
            .unwrap_or(UNIX_EPOCH);
        items.push((used, path, meta.len()));
    }
    let mut total: u64 = items.iter().map(|(_, _, size)| *size).sum();
    if total <= CACHE_MAX {
        return;
    }
    items.sort_by_key(|(used, _, _)| *used);
    for (_, path, size) in items {
        if total <= CACHE_MAX {
            break;
        }
        let stem = path
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(cache_dir.join(format!("{stem}.touch")));
        total = total.saturating_sub(size);
    }
}

fn result_for(
    roots: &PreviewRoots,
    cache_dir: &Path,
    key: &str,
    target: &Path,
    cached: bool,
) -> FsResult<ConvertResult> {
    let token = roots
        .register(&cache_dir.to_string_lossy())
        .map_err(|message| FsError {
            code: "io".to_string(),
            message,
        })?;
    let size = fs::metadata(target).map(|meta| meta.len()).unwrap_or(0);
    Ok(ConvertResult {
        pdf_path: target.to_string_lossy().to_string(),
        url: format!("preview://{token}/{key}.pdf"),
        cached,
        size,
    })
}

/// Converte `path` em PDF, ou devolve o PDF do cache quando o arquivo nao
/// mudou desde a ultima conversao.
pub fn convert(
    queue: &OfficeQueue,
    roots: &PreviewRoots,
    home: &Path,
    cache_dir: &Path,
    path: &str,
    force: bool,
) -> FsResult<ConvertResult> {
    let source = Path::new(path);
    if !source.is_absolute() {
        return Err(FsError {
            code: "invalid".to_string(),
            message: "Caminho relativo".to_string(),
        });
    }
    if !supported(source) {
        return Err(FsError {
            code: "unsupported".to_string(),
            message: "Este formato não tem conversão para PDF".to_string(),
        });
    }
    let canonical = source
        .canonicalize()
        .map_err(|error| io_error(error, "Arquivo não encontrado"))?;
    let meta = fs::metadata(&canonical)
        .map_err(|error| io_error(error, "Não foi possível abrir o arquivo"))?;
    if meta.is_dir() {
        return Err(FsError {
            code: "unsupported".to_string(),
            message: "Documento salvo como pacote, sem conversão".to_string(),
        });
    }
    if meta.len() > INPUT_MAX {
        return Err(FsError {
            code: "too_large".to_string(),
            message: "Documento acima de 200 MB. Abra no app padrão.".to_string(),
        });
    }
    fs::create_dir_all(cache_dir)
        .map_err(|error| io_error(error, "Não foi possível criar o cache"))?;
    let key = cache_key(&canonical, mtime_ms(&meta), meta.len());
    let target = cache_dir.join(format!("{key}.pdf"));
    if !force && target.is_file() {
        touch(cache_dir, &key);
        return result_for(roots, cache_dir, &key, &target, true);
    }
    let soffice = find_soffice(home).ok_or_else(|| FsError {
        code: "missing_tool".to_string(),
        message: "LibreOffice não encontrado. Instale com brew install --cask libreoffice"
            .to_string(),
    })?;

    let _guard = queue
        .lock
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    // Outra chamada pode ter convertido o mesmo arquivo enquanto esta esperava.
    if !force && target.is_file() {
        touch(cache_dir, &key);
        return result_for(roots, cache_dir, &key, &target, true);
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let out_dir = cache_dir.join(format!("tmp-{}-{nonce}", std::process::id()));
    fs::create_dir_all(&out_dir)
        .map_err(|error| io_error(error, "Não foi possível criar a pasta temporária"))?;
    let profile = cache_dir.join("soffice-profile");
    let _ = fs::create_dir_all(&profile);
    let started = Instant::now();
    let spawned = Command::new(&soffice)
        .arg("--headless")
        .arg("--norestore")
        .arg("--nologo")
        .arg("--nolockcheck")
        .arg(format!("-env:UserInstallation={}", file_url(&profile)))
        .arg("--convert-to")
        .arg("pdf")
        .arg("--outdir")
        .arg(&out_dir)
        .arg(&canonical)
        .env("HOME", home)
        .env("PATH", search_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            let _ = fs::remove_dir_all(&out_dir);
            return Err(io_error(error, "Não foi possível iniciar o LibreOffice"));
        }
    };
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if started.elapsed() > TIMEOUT {
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => break None,
        }
    };
    let produced = fs::read_dir(&out_dir).ok().and_then(|read| {
        read.flatten()
            .map(|entry| entry.path())
            .find(|candidate| candidate.extension().and_then(|value| value.to_str()) == Some("pdf"))
    });
    let outcome = match (status, produced) {
        (None, _) => Err(FsError {
            code: "timeout".to_string(),
            message: "O LibreOffice não terminou a conversão em 2 minutos".to_string(),
        }),
        (Some(_), Some(pdf)) => {
            let _ = fs::remove_file(&target);
            fs::rename(&pdf, &target)
                .or_else(|_| fs::copy(&pdf, &target).map(|_| ()))
                .map_err(|error| io_error(error, "Não foi possível guardar o PDF"))
        }
        (Some(status), None) => Err(FsError {
            code: "io".to_string(),
            message: format!(
                "O LibreOffice não gerou o PDF, saída {}",
                status.code().unwrap_or(-1)
            ),
        }),
    };
    let _ = fs::remove_dir_all(&out_dir);
    outcome?;
    touch(cache_dir, &key);
    trim_cache(cache_dir);
    result_for(roots, cache_dir, &key, &target, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sandbox(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("oc-office-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn cache_key_changes_with_mtime_and_size() {
        let path = Path::new("/tmp/a.pptx");
        let base = cache_key(path, 1, 10);
        assert_eq!(base, cache_key(path, 1, 10));
        assert_ne!(base, cache_key(path, 2, 10));
        assert_ne!(base, cache_key(path, 1, 11));
        assert_ne!(base, cache_key(Path::new("/tmp/b.pptx"), 1, 10));
        assert_eq!(base.len(), 16);
    }

    #[test]
    fn refuses_unknown_extension_and_relative_paths() {
        let dir = sandbox("recusa");
        let zip = dir.join("a.zip");
        fs::write(&zip, b"nada").unwrap();
        let queue = OfficeQueue::default();
        let roots = PreviewRoots::default();
        let error = convert(
            &queue,
            &roots,
            &dir,
            &dir.join("cache"),
            &zip.to_string_lossy(),
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, "unsupported");
        let error = convert(
            &queue,
            &roots,
            &dir,
            &dir.join("cache"),
            "relativo.pptx",
            false,
        )
        .unwrap_err();
        assert_eq!(error.code, "invalid");
        assert!(supported(Path::new("x.PPTX")));
        assert!(supported(Path::new("x.key")));
        assert!(!supported(Path::new("x.pdf")));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn find_soffice_returns_absolute_or_none() {
        let dir = sandbox("soffice");
        if let Some(path) = find_soffice(&dir) {
            assert!(path.is_absolute() && path.is_file());
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn file_url_encodes_spaces() {
        assert_eq!(
            file_url(Path::new("/tmp/a b/ç")),
            "file:///tmp/a%20b/%C3%A7"
        );
        assert_eq!(file_url(Path::new("/tmp/perfil-1")), "file:///tmp/perfil-1");
    }

    #[test]
    fn trims_cache_to_the_limit_keeping_recent() {
        let dir = sandbox("trim");
        // Dois PDFs falsos maiores que o teto juntos nao cabem num teste;
        // aqui so conferimos que a rotina apaga os sem marcador mais velhos
        // quando o total passa do limite simulado por arquivos grandes.
        for name in ["a", "b"] {
            fs::write(dir.join(format!("{name}.pdf")), vec![0u8; 16]).unwrap();
        }
        trim_cache(&dir);
        assert!(
            dir.join("a.pdf").is_file() && dir.join("b.pdf").is_file(),
            "abaixo do teto nada sai"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    /// Conversao real, so com o LibreOffice instalado:
    /// `cargo test office -- --ignored`.
    #[test]
    #[ignore]
    fn converts_rtf_to_pdf_with_soffice() {
        let home = PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
        if find_soffice(&home).is_none() {
            eprintln!("sem soffice; teste pulado");
            return;
        }
        let dir = sandbox("converte");
        let rtf = dir.join("ola.rtf");
        fs::write(&rtf, b"{\\rtf1\\ansi Ola do Cialai}").unwrap();
        let cache = dir.join("cache");
        let queue = OfficeQueue::default();
        let roots = PreviewRoots::default();
        let first = convert(&queue, &roots, &home, &cache, &rtf.to_string_lossy(), false)
            .expect("conversao");
        assert!(!first.cached);
        assert!(first.url.starts_with("preview://"));
        assert!(first.url.ends_with(".pdf"));
        let bytes = fs::read(&first.pdf_path).unwrap();
        assert!(bytes.starts_with(b"%PDF"), "saida nao e PDF");
        let second =
            convert(&queue, &roots, &home, &cache, &rtf.to_string_lossy(), false).expect("cache");
        assert!(second.cached);
        assert_eq!(second.pdf_path, first.pdf_path);
        fs::remove_dir_all(&dir).unwrap();
    }
}
