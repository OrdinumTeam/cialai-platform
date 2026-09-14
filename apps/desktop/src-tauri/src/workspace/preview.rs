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

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::http::{Request, Response, StatusCode};

use crate::i18n::t;

pub const SCHEME: &str = "preview";

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
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("pdf") => "application/pdf",
        Some("xml") => "application/xml; charset=utf-8",
        Some("txt") | Some("md") => "text/plain; charset=utf-8",
        Some("wasm") => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn respond(status: StatusCode, mime: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header("Content-Type", mime)
        .header("Cache-Control", "no-cache")
        .header("Access-Control-Allow-Origin", "*")
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Borrowed(&[][..])))
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
    match fs::read(&canonical) {
        Ok(bytes) => respond(StatusCode::OK, mime_for(&canonical), bytes),
        Err(_) => respond(
            StatusCode::NOT_FOUND,
            "text/plain; charset=utf-8",
            b"nao encontrado".to_vec(),
        ),
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
    fn decodes_percent_paths() {
        assert_eq!(
            percent_decode("/pasta%20com%20espa%C3%A7o/a.css"),
            "/pasta com espaço/a.css"
        );
        assert_eq!(percent_decode("/x%zz"), "/x%zz");
    }
}
