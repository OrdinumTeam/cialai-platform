// SPDX-License-Identifier: Apache-2.0
//! The Linux WebView's browser clipboard API is not the system clipboard API.
//! GTK negotiates X11/Wayland formats without external wl-paste/xclip helpers.

use std::io::Write;
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, State};

const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;

#[derive(Default)]
pub struct ClipboardFiles(Mutex<Vec<tempfile::TempPath>>);

impl ClipboardFiles {
    fn save(&self, name: &str, bytes: &[u8]) -> Result<String, String> {
        if bytes.len() > MAX_FILE_BYTES {
            return Err("clipboard_file_too_large".into());
        }
        // Only preserve a short extension. Never interpret clipboard names as
        // destination paths or overwrite an existing file. tempfile uses 0600.
        let extension = name.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("bin");
        let extension = if !extension.is_empty()
            && extension.len() <= 10
            && extension.bytes().all(|byte| byte.is_ascii_alphanumeric())
        {
            extension
        } else {
            "bin"
        };
        let mut file = tempfile::Builder::new()
            .prefix("cialai-clipboard-")
            .suffix(&format!(".{extension}"))
            .tempfile()
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
        let path = file.into_temp_path();
        let result = crate::platform::to_portable(&path);
        self.0.lock().map_err(|error| error.to_string())?.push(path);
        Ok(result)
    }

    pub fn clear(&self) {
        if let Ok(mut paths) = self.0.lock() {
            paths.clear();
        }
    }
}

#[tauri::command]
pub fn clipboard_store_file(
    files: State<'_, ClipboardFiles>,
    name: String,
    data: String,
) -> Result<String, String> {
    if data.len() > MAX_FILE_BYTES.div_ceil(3) * 4 {
        return Err("clipboard_file_too_large".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| error.to_string())?;
    files.save(&name, &bytes)
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub enum ClipboardPayload {
    Text { text: String },
    Paths { paths: Vec<String> },
    Empty,
}

#[tauri::command]
pub async fn clipboard_read(app: AppHandle) -> Result<ClipboardPayload, String> {
    #[cfg(target_os = "linux")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        let owner = app.clone();
        app.run_on_main_thread(move || linux::read(owner, send))
            .map_err(|error| error.to_string())?;
        tokio::time::timeout(std::time::Duration::from_secs(5), receive)
            .await
            .map_err(|_| "clipboard_timeout".to_string())?
            .map_err(|_| "clipboard_cancelled".to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Err("clipboard_native_read_unavailable".into())
    }
}

#[tauri::command]
pub async fn clipboard_write_text(app: AppHandle, text: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        let (send, receive) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let result = linux::clipboard().map(|clipboard| clipboard.set_text(&text));
            let _ = send.send(result);
        })
        .map_err(|error| error.to_string())?;
        receive
            .await
            .map_err(|_| "clipboard_cancelled".to_string())?
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, text);
        Err("clipboard_native_write_unavailable".into())
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use gtk::gio::prelude::FileExt;
    use tauri::Manager;
    use tokio::sync::oneshot::Sender;

    pub fn clipboard() -> Result<gtk::Clipboard, String> {
        let display = gtk::gdk::Display::default().ok_or("clipboard_display_unavailable")?;
        gtk::Clipboard::default(&display).ok_or_else(|| "clipboard_unavailable".into())
    }

    pub fn read(app: AppHandle, send: Sender<Result<ClipboardPayload, String>>) {
        let clipboard = match clipboard() {
            Ok(clipboard) => clipboard,
            Err(error) => {
                let _ = send.send(Err(error));
                return;
            }
        };
        // File managers also offer plain text. Prefer their actual local file
        // URIs so spaces, Unicode and shell metacharacters are quoted once.
        clipboard.request_uris(move |clipboard, uris| {
            if send.is_closed() {
                return;
            }
            let paths: Vec<_> = uris
                .iter()
                .filter_map(|uri| gtk::gio::File::for_uri(uri).path())
                .map(crate::platform::to_portable)
                .collect();
            if !paths.is_empty() {
                let _ = send.send(Ok(ClipboardPayload::Paths { paths }));
                return;
            }
            clipboard.request_text(move |clipboard, text| {
                if send.is_closed() {
                    return;
                }
                if let Some(text) = text.filter(|text| !text.is_empty()) {
                    let _ = send.send(Ok(ClipboardPayload::Text { text: text.into() }));
                    return;
                }
                clipboard.request_image(move |_, image| {
                    if send.is_closed() {
                        return;
                    }
                    let result = match image {
                        None => Ok(ClipboardPayload::Empty),
                        Some(image) => {
                            let pixels = i64::from(image.width()) * i64::from(image.height());
                            if pixels <= 0 || pixels > (MAX_FILE_BYTES / 4) as i64 {
                                Err("clipboard_file_too_large".into())
                            } else {
                                image
                                    .save_to_bufferv("png", &[])
                                    .map_err(|error| error.to_string())
                                    .and_then(|bytes| {
                                        app.state::<ClipboardFiles>().save("clipboard.png", &bytes)
                                    })
                                    .map(|path| ClipboardPayload::Paths { paths: vec![path] })
                            }
                        }
                    };
                    let _ = send.send(result);
                });
            });
        });
    }
}
