// SPDX-License-Identifier: Apache-2.0
//! Visualizacao de HTML do estudio: o protocolo `preview://<raiz>/caminho`
//! serve os arquivos de um projeto como um servidor local faria, com a raiz
//! da sessao como raiz do site. Assim `/assets/css/main.css` e
//! `assets/js/app.js` resolvem os dois, o que o protocolo de assets do
//! Tauri, ancorado no caminho absoluto do arquivo, nao consegue.
//!
//! Cada raiz registrada vira um token curto e estavel, que e o host da URL.
//! Nada fora da raiz e servido: o caminho pedido e canonizado e precisa
//! continuar dentro dela.
//!
//! O mesmo protocolo toca audio e video no editor. O player pede o arquivo
//! em faixas de bytes, e a resposta parcial e o que permite pular para
//! qualquer ponto sem ler um video inteiro na memoria.

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{Request, Response, StatusCode};

use crate::i18n::t;

pub const SCHEME: &str = "preview";

/// Maior pedaco de uma resposta parcial. O player pede `bytes=0-` e segue
/// pedindo o resto; sem teto, a primeira resposta leria o arquivo inteiro.
const RANGE_CHUNK: u64 = 2 * 1024 * 1024;

#[derive(Default)]
pub struct PreviewRoots {
    roots: Mutex<HashMap<String, PathBuf>>,
}

impl PreviewRoots {
    /// Registra a raiz e devolve o token que vira o host da URL.
    pub fn register(&self, root: &str) -> Result<String, String> {
        let path = PathBuf::from(root);
        if !path.is_absolute() || !path.is_dir() {
            return Err(t("native.error.projectFolderNotFound"));
        }
        let canonical = dunce::canonicalize(&path).map_err(|error| error.to_string())?;
        let token = token_for(&canonical);
        let mut roots = self
            .roots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        roots.insert(token.clone(), canonical);
        Ok(token)
    }

    pub fn resolve(&self, token: &str) -> Option<PathBuf> {
        let roots = self
            .roots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        roots.get(token).cloned()
    }
}

/// Token curto e estavel a partir do caminho: os mesmos projetos dao os
/// mesmos hosts entre reinicios, o que ajuda o cache do webview.
fn token_for(path: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("p{hash:016x}")
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = &input[index + 1..index + 3];
            if let Ok(value) = u8::from_str_radix(hex, 16) {
                out.push(value);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") | Some("htm") | Some("xhtml") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") | Some("cjs") => "text/javascript; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("bmp") => "image/bmp",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mov") => "video/quicktime",
        Some("ogv") => "video/ogg",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") | Some("oga") | Some("opus") => "audio/ogg",
        Some("m4a") => "audio/mp4",
        Some("aac") => "audio/aac",
        Some("flac") => "audio/flac",
        Some("pdf") => "application/pdf",
        Some("xml") => "application/xml; charset=utf-8",
        Some("txt") | Some("md") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    respond_with(status, mime, body, None)
}

fn respond_with(
    status: StatusCode,
    mime: &str,
    body: Vec<u8>,
    range: Option<String>,
) -> Response<Cow<'static, [u8]>> {
    let mut builder = Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Cache-Control", "no-cache")
        .header("Access-Control-Allow-Origin", "*")
        .header("Accept-Ranges", "bytes");
    if let Some(range) = range {
        builder = builder.header("Content-Range", range);
    }
    builder
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])))
}

/// Faixa pedida em `Range: bytes=...`. So a primeira faixa e atendida, que
/// e o que os players pedem, e ela sai limitada ao fim do arquivo e ao
/// pedaco maximo. `None` quando o cabecalho nao e uma faixa valida: pela
/// regra do HTTP o pedido recebe o arquivo inteiro. `Some(None)` quando a
/// faixa comeca depois do fim.
fn byte_range(header: &str, len: u64) -> Option<Option<(u64, u64)>> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (start, end) = first.split_once('-')?;
    let (start, end) = (start.trim(), end.trim());
    let (start, end) = if start.is_empty() {
        // `bytes=-500`: os ultimos 500 bytes.
        let suffix: u64 = end.parse().ok()?;
        if suffix == 0 || len == 0 {
            return Some(None);
        }
        (len.saturating_sub(suffix), len - 1)
    } else {
        let start: u64 = start.parse().ok()?;
        let end = if end.is_empty() {
            u64::MAX
        } else {
            let end: u64 = end.parse().ok()?;
            if end < start {
                return None;
            }
            end
        };
        (start, end)
    };
    if start >= len {
        return Some(None);
    }
    let end = end.min(len - 1).min(start.saturating_add(RANGE_CHUNK - 1));
    Some(Some((start, end)))
}

fn read_range(path: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let mut file = fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let wanted = end - start + 1;
    let mut body = Vec::with_capacity(usize::try_from(wanted).unwrap_or(0));
    file.take(wanted).read_to_end(&mut body)?;
    Ok(body)
}

/// Atende `preview://<token>/<caminho>` e a forma que o WebView2 entrega no
/// Windows, `http://preview.localhost/<token>/<caminho>`. Pasta vira
/// `index.html`.
pub fn handle(roots: &PreviewRoots, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let uri = request.uri();
    let route = if uri.scheme_str() == Some(SCHEME) {
        uri.host().map(|token| (token, uri.path()))
    } else if uri.scheme_str() == Some("http") && uri.host() == Some("preview.localhost") {
        let mut parts = uri.path().trim_start_matches('/').splitn(2, '/');
        parts.next().filter(|token| !token.is_empty()).map(|token| {
            let path = parts.next().unwrap_or_default();
            (token, path)
        })
    } else {
        None
    };
    let Some((token, request_path)) = route else {
        return respond(
            StatusCode::BAD_REQUEST,
            "text/plain; charset=utf-8",
            b"origem invalida".to_vec(),
        );
    };
    let Some(root) = roots.resolve(token) else {
        return respond(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"projeto nao registrado".to_vec(),
        );
    };
    let raw_path = percent_decode(request_path);
    let relative = raw_path.trim_start_matches('/');
    let mut target = root.join(relative);
    if relative.is_empty() || raw_path.ends_with('/') || target.is_dir() {
        target = target.join("index.html");
    }
    let Ok(canonical) = dunce::canonicalize(&target) else {
        return respond(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"nao encontrado".to_vec(),
        );
    };
    if !canonical.starts_with(&root) {
        return respond(
            StatusCode::FORBIDDEN,
            "text/plain; charset=utf-8",
            b"fora do projeto".to_vec(),
        );
    }
    let mime = mime_for(&canonical);
    let not_found = || {
        respond(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"nao encontrado".to_vec(),
        )
    };
    let range = request
        .headers()
        .get("range")
        .and_then(|value| value.to_str().ok());
    if let Some(header) = range {
        let Ok(meta) = fs::metadata(&canonical) else {
            return not_found();
        };
        let len = meta.len();
        match byte_range(header, len) {
            Some(Some((start, end))) => {
                return match read_range(&canonical, start, end) {
                    Ok(body) if !body.is_empty() => {
                        let last = start + body.len() as u64 - 1;
                        respond_with(
                            StatusCode::PARTIAL_CONTENT,
                            mime,
                            body,
                            Some(format!("bytes {start}-{last}/{len}")),
                        )
                    }
                    _ => not_found(),
                };
            }
            Some(None) => {
                return respond_with(
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    "text/plain; charset=utf-8",
                    Vec::new(),
                    Some(format!("bytes */{len}")),
                );
            }
            None => {}
        }
    }
    match fs::read(&canonical) {
        Ok(bytes) => respond(StatusCode::OK, mime, bytes),
        Err(_) => not_found(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_files_inside_the_root_and_refuses_outside() {
        let dir = std::env::temp_dir().join(format!("oc-preview-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("site/assets/css")).unwrap();
        fs::write(dir.join("site/index.html"), "<html>oi</html>").unwrap();
        fs::write(dir.join("site/assets/css/main.css"), "body{}").unwrap();
        fs::write(dir.join("segredo.txt"), "x").unwrap();
        let roots = PreviewRoots::default();
        let token = roots.register(&dir.join("site").to_string_lossy()).unwrap();
        assert_eq!(
            token,
            roots.register(&dir.join("site").to_string_lossy()).unwrap(),
            "token estavel"
        );

        let get = |path: &str| {
            let request = Request::builder()
                .uri(format!("preview://{token}{path}"))
                .body(Vec::new())
                .unwrap();
            handle(&roots, request)
        };
        let index = get("/");
        assert_eq!(index.status(), StatusCode::OK);
        assert_eq!(index.headers()["Content-Type"], "text/html; charset=utf-8");
        let css = get("/assets/css/main.css");
        assert_eq!(css.status(), StatusCode::OK);
        assert_eq!(css.headers()["Content-Type"], "text/css; charset=utf-8");
        assert_eq!(&css.body()[..], b"body{}");
        let windows_request = Request::builder()
            .uri(format!(
                "http://preview.localhost/{token}/assets/css/main.css"
            ))
            .body(Vec::new())
            .unwrap();
        assert_eq!(handle(&roots, windows_request).status(), StatusCode::OK);
        assert_ne!(
            get("/../segredo.txt").status(),
            StatusCode::OK,
            "nada fora da raiz"
        );
        assert_eq!(get("/nada.html").status(), StatusCode::NOT_FOUND);
        let unknown = Request::builder()
            .uri("preview://pzz/index.html")
            .body(Vec::new())
            .unwrap();
        assert_eq!(handle(&roots, unknown).status(), StatusCode::NOT_FOUND);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn byte_ranges_follow_http_rules() {
        assert_eq!(byte_range("bytes=0-1", 10), Some(Some((0, 1))));
        assert_eq!(byte_range("bytes=4-", 10), Some(Some((4, 9))));
        assert_eq!(byte_range("bytes=-3", 10), Some(Some((7, 9))));
        assert_eq!(byte_range("bytes=-30", 10), Some(Some((0, 9))));
        assert_eq!(byte_range("bytes=2-500", 10), Some(Some((2, 9))));
        assert_eq!(byte_range("bytes=3-5, 7-8", 10), Some(Some((3, 5))));
        assert_eq!(byte_range("bytes=10-", 10), Some(None), "comeca no fim");
        assert_eq!(byte_range("bytes=-0", 10), Some(None));
        assert_eq!(byte_range("bytes=0-", 0), Some(None), "arquivo vazio");
        assert_eq!(
            byte_range("bytes=5-3", 10),
            None,
            "faixa invertida e ignorada"
        );
        assert_eq!(byte_range("items=0-1", 10), None);
        assert_eq!(byte_range("bytes=a-b", 10), None);
        let big = 10 * RANGE_CHUNK;
        assert_eq!(
            byte_range("bytes=0-", big),
            Some(Some((0, RANGE_CHUNK - 1))),
            "o pedaco tem teto"
        );
    }

    #[test]
    fn serves_media_in_ranges() {
        let dir = std::env::temp_dir().join(format!("oc-preview-range-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("som.mp3"), b"0123456789").unwrap();
        let roots = PreviewRoots::default();
        let token = roots.register(&dir.to_string_lossy()).unwrap();
        let get = |range: Option<&str>| {
            let mut request = Request::builder().uri(format!("preview://{token}/som.mp3"));
            if let Some(range) = range {
                request = request.header("Range", range);
            }
            handle(&roots, request.body(Vec::new()).unwrap())
        };

        let whole = get(None);
        assert_eq!(whole.status(), StatusCode::OK);
        assert_eq!(whole.headers()["Content-Type"], "audio/mpeg");
        assert_eq!(whole.headers()["Accept-Ranges"], "bytes");
        assert_eq!(&whole.body()[..], b"0123456789");

        let probe = get(Some("bytes=0-1"));
        assert_eq!(probe.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(probe.headers()["Content-Range"], "bytes 0-1/10");
        assert_eq!(&probe.body()[..], b"01");

        let tail = get(Some("bytes=7-"));
        assert_eq!(tail.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(tail.headers()["Content-Range"], "bytes 7-9/10");
        assert_eq!(&tail.body()[..], b"789");

        let beyond = get(Some("bytes=10-"));
        assert_eq!(beyond.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(beyond.headers()["Content-Range"], "bytes */10");

        let invalid = get(Some("bytes=9-2"));
        assert_eq!(
            invalid.status(),
            StatusCode::OK,
            "faixa invalida recebe tudo"
        );
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn decodes_percent_paths() {
        assert_eq!(
            percent_decode("/pasta%20com%20espa%C3%A7o/a.css"),
            "/pasta com espaço/a.css"
        );
        assert_eq!(percent_decode("/x%zz"), "/x%zz");
    }
}
