#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use serde_json::Value;
#[cfg(any(unix, test, feature = "selftest"))]
use serde_json::json;
#[cfg(any(unix, test, feature = "selftest"))]
use std::io::Write;
#[cfg(any(unix, test))]
use std::io::{BufRead, BufReader, Read};
#[cfg(windows)]
mod windows_control;
use tauri::Manager;

#[cfg(any(unix, test))]
fn exchange<S: std::io::Read + Write>(
    mut stream: S,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let request = json!({"id":"monitor", "method":method, "params":params});
    serde_json::to_writer(&mut stream, &request).map_err(|_| "request_encoding_failed")?;
    stream
        .write_all(b"\n")
        .map_err(|_| "service_write_failed")?;
    let mut response = String::new();
    BufReader::new(stream)
        .take(1024 * 1024)
        .read_line(&mut response)
        .map_err(|_| "service_read_failed")?;
    decode_response(&response)
}

fn decode_response(response: &str) -> Result<Value, String> {
    let response: Value = serde_json::from_str(response).map_err(|_| "invalid_service_response")?;
    if response["id"] != "monitor" {
        return Err("invalid_service_response".into());
    }
    if !response["error"].is_null() {
        return Err("service_request_failed".into());
    }
    Ok(response["result"].clone())
}

#[cfg(any(windows, test))]
fn pipe_name(username: &str) -> String {
    let name = if username.is_empty() {
        "user"
    } else {
        username
    };
    format!(
        r"\\.\pipe\cialai-broto-{}",
        name.replace(['\\', '/', ' '], "_")
    )
}

fn validate_method(method: &str) -> Result<(), String> {
    if ![
        "broto.connect",
        "broto.status",
        "broto.pause",
        "broto.resume",
        "broto.disconnect",
    ]
    .contains(&method)
    {
        return Err("unsupported_method".into());
    }
    Ok(())
}

#[cfg(unix)]
fn control(method: &str, params: Value) -> Result<Value, String> {
    validate_method(method)?;
    #[cfg(unix)]
    {
        use std::os::unix::{
            fs::{FileTypeExt, MetadataExt},
            net::UnixStream,
        };
        let path = std::env::var_os("CIALAI_BROTO_SOCKET")
            .map(std::path::PathBuf::from)
            .or_else(|| dirs::config_dir().map(|path| path.join("CialaiBroto/control.sock")))
            .ok_or("config_directory_unavailable")?;
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| "service_unavailable")?;
        if !metadata.file_type().is_socket()
            || metadata.mode() & 0o077 != 0
            || metadata.uid() != unsafe { libc::geteuid() }
        {
            return Err("insecure_service_socket".into());
        }
        let stream = UnixStream::connect(path).map_err(|_| "service_unavailable")?;
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(5)))
            .map_err(|_| "service_timeout_failed")?;
        stream
            .set_write_timeout(Some(std::time::Duration::from_secs(5)))
            .map_err(|_| "service_timeout_failed")?;
        exchange(stream, method, params)
    }
}

#[tauri::command]
async fn broto_control(method: String, params: Value) -> Result<Value, String> {
    #[cfg(unix)]
    {
        tauri::async_runtime::spawn_blocking(move || control(&method, params))
            .await
            .map_err(|_| "service_task_failed")?
    }
    #[cfg(windows)]
    {
        validate_method(&method)?;
        windows_control::control(&method, params).await
    }
}

/// O WebView2 trata `navigator.clipboard` como permissão de site e abre um pedido
/// de Permitir ou Bloquear por cima da janela. No Windows, o Colar lê o texto
/// pelo sistema; nos outros, a página segue pela API do navegador.
#[tauri::command]
fn broto_clipboard_text() -> Result<String, String> {
    #[cfg(windows)]
    {
        windows_clipboard_text().ok_or_else(|| "clipboard_unavailable".into())
    }
    #[cfg(not(windows))]
    {
        Err("clipboard_unsupported".into())
    }
}

/// Texto Unicode da área de transferência, cortado num tamanho muito maior
/// que o de um código de Broto.
#[cfg(windows)]
fn windows_clipboard_text() -> Option<String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalUnlock};
    const CF_UNICODETEXT: u32 = 13;
    const LIMIT: usize = 16 * 1024;
    unsafe {
        if OpenClipboard(std::ptr::null_mut()) == 0 {
            return None;
        }
        let handle = GetClipboardData(CF_UNICODETEXT);
        let data = if handle.is_null() {
            std::ptr::null()
        } else {
            GlobalLock(handle) as *const u16
        };
        let text = (!data.is_null()).then(|| {
            let mut length = 0;
            while length < LIMIT && *data.add(length) != 0 {
                length += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(data, length));
            GlobalUnlock(handle);
            text
        });
        CloseClipboard();
        text
    }
}

fn service_install_command(
    binary: &std::path::Path,
    payload: &std::path::Path,
    key: &str,
) -> std::process::Command {
    let mut command = std::process::Command::new(binary);
    command
        .arg("instalar")
        .arg("--payload")
        .arg(payload)
        .arg("--key")
        .arg(key);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    command
}

/// O instalador recusa conta de administrador. A janela confere antes, para não
/// abrir o UAC e o pedido de senha que terminariam na mesma recusa. Um
/// administrador com UAC aparece como token limitado; sem UAC, como elevado.
#[cfg(windows)]
fn account_is_administrator() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{
        GetTokenInformation, TOKEN_ELEVATION, TOKEN_QUERY, TokenElevation, TokenElevationType,
        TokenElevationTypeLimited,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
            return false;
        }
        let mut size = 0u32;
        let mut kind = 0i32;
        let limited = GetTokenInformation(
            token,
            TokenElevationType,
            (&mut kind as *mut i32).cast(),
            size_of::<i32>() as u32,
            &mut size,
        ) != 0
            && kind == TokenElevationTypeLimited;
        let mut elevation = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let elevated = GetTokenInformation(
            token,
            TokenElevation,
            (&mut elevation as *mut TOKEN_ELEVATION).cast(),
            size_of::<TOKEN_ELEVATION>() as u32,
            &mut size,
        ) != 0
            && elevation.TokenIsElevated != 0;
        CloseHandle(token);
        limited || elevated
    }
}

#[tauri::command]
async fn broto_service_install(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    if account_is_administrator() {
        return Err("service_account_privileged".into());
    }
    let payload = app
        .path()
        .resource_dir()
        .map_err(|_| "service_resources_unavailable")?
        .join("service");
    let key = option_env!("CIALAI_BROTO_SERVICE_PUBLIC_KEY")
        .filter(|key| !key.trim().is_empty())
        .ok_or("service_trust_key_unavailable")?;
    let binary = payload.join(if cfg!(windows) {
        "cialai-broto.exe"
    } else {
        "cialai-broto"
    });
    if !binary.is_file() {
        return Err("service_payload_unavailable".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = service_install_command(&binary, &payload, key)
            .status()
            .map_err(|_| "service_install_failed")?;
        if result.success() {
            Ok(())
        } else {
            Err("service_install_failed".into())
        }
    })
    .await
    .map_err(|_| "service_task_failed")?
}

#[cfg(feature = "selftest")]
#[tauri::command]
fn broto_selftest_pairing() -> Result<Option<String>, String> {
    if std::env::var_os("CIALAI_BROTO_SELFTEST_RESULT").is_none() {
        return Err("selftest_not_enabled".into());
    }
    std::env::var_os("CIALAI_BROTO_SELFTEST_PAIRING_FILE")
        .map(|path| {
            std::fs::read_to_string(path)
                .map(|value| value.trim().to_owned())
                .map_err(|_| "selftest_pairing_unavailable".into())
        })
        .transpose()
}

#[cfg(feature = "selftest")]
#[tauri::command]
async fn broto_selftest_stage(stage: String, digits: Option<String>) -> Result<(), String> {
    if !["waiting", "connected", "paused", "resumed", "disconnected"].contains(&stage.as_str()) {
        return Err("invalid_selftest_stage".into());
    }
    let result = std::env::var_os("CIALAI_BROTO_SELFTEST_RESULT").ok_or("selftest_not_enabled")?;
    let parent = std::path::Path::new(&result)
        .parent()
        .ok_or("selftest_directory_unavailable")?
        .to_path_buf();
    tauri::async_runtime::spawn_blocking(move || {
        let progress = serde_json::to_vec(&json!({"stage":stage,"digits":digits}))
            .map_err(|_| "selftest_encoding_failed")?;
        // Each stage is immutable. Replacing a shared file races readers on
        // Windows that keep the old file open without delete sharing.
        std::fs::write(parent.join(format!("native-stage-{stage}.json")), progress)
            .map_err(|_| "selftest_stage_failed")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !parent.join(format!("continue-{stage}")).is_file() {
            if std::time::Instant::now() > deadline {
                return Err("selftest_stage_timeout".into());
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        Ok(())
    })
    .await
    .map_err(|_| "selftest_task_failed")?
}

#[cfg(feature = "selftest")]
#[tauri::command]
async fn broto_selftest_done(app: tauri::AppHandle, report: Value) -> Result<(), String> {
    let path = std::env::var_os("CIALAI_BROTO_SELFTEST_RESULT").ok_or("selftest_not_enabled")?;
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&report).map_err(|_| "selftest_encoding_failed")?,
    )
    .map_err(|_| "selftest_write_failed")?;
    // The IPC reply must return to WebView2 before its COM window is destroyed.
    // Calling exit inside a synchronous WebView callback can stall its teardown.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(150));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.close();
        }
        // Closing the last window already requests normal runtime exit.
        // A second app.exit request can re-enter teardown on WebView2.
    });
    Ok(())
}

#[cfg(feature = "selftest")]
fn record_selftest_lifecycle(event: &str) {
    if let Some(path) = std::env::var_os("CIALAI_BROTO_SELFTEST_RESULT") {
        if let Some(parent) = std::path::Path::new(&path).parent() {
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(parent.join("native-lifecycle.jsonl"))
            {
                let _ = writeln!(file, "{}", json!({"event":event}));
            }
        }
    }
}

#[cfg(all(windows, feature = "selftest"))]
fn record_selftest_desktop() {
    use std::ffi::c_void;
    #[link(name = "user32")]
    unsafe extern "system" {
        fn GetProcessWindowStation() -> *mut c_void;
        fn GetThreadDesktop(thread: u32) -> *mut c_void;
        fn GetUserObjectInformationW(
            handle: *mut c_void,
            index: i32,
            buffer: *mut c_void,
            length: u32,
            needed: *mut u32,
        ) -> i32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentThreadId() -> u32;
    }
    fn name(handle: *mut c_void) -> String {
        let mut text = [0u16; 256];
        let mut needed = 0;
        let ok = unsafe {
            GetUserObjectInformationW(handle, 2, text.as_mut_ptr().cast(), 512, &mut needed)
        };
        if ok == 0 {
            return "unavailable".into();
        }
        String::from_utf16_lossy(&text[..text.iter().position(|ch| *ch == 0).unwrap_or(text.len())])
    }
    #[repr(C)]
    struct Flags {
        inherit: i32,
        reserved: i32,
        flags: u32,
    }
    let station = unsafe { GetProcessWindowStation() };
    let desktop = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
    let mut flags = Flags {
        inherit: 0,
        reserved: 0,
        flags: 0,
    };
    let mut needed = 0;
    let ok = unsafe {
        GetUserObjectInformationW(
            station,
            1,
            (&mut flags as *mut Flags).cast(),
            std::mem::size_of::<Flags>() as u32,
            &mut needed,
        )
    };
    record_selftest_lifecycle(&format!(
        "desktop:{}|{}|visible:{}",
        name(station),
        name(desktop),
        ok != 0 && flags.flags & 1 != 0
    ));
}

fn main() {
    #[cfg(feature = "selftest")]
    record_selftest_lifecycle("main-entry");
    #[cfg(all(windows, feature = "selftest"))]
    record_selftest_desktop();
    let builder = tauri::Builder::default();
    #[cfg(not(feature = "selftest"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        broto_control,
        broto_service_install,
        broto_clipboard_text
    ]);
    #[cfg(feature = "selftest")]
    let builder = builder
        .invoke_handler(tauri::generate_handler![
            broto_control,
            broto_service_install,
            broto_clipboard_text,
            broto_selftest_pairing,
            broto_selftest_stage,
            broto_selftest_done
        ])
        .on_page_load(|webview, payload| {
            record_selftest_lifecycle(
                if payload.event() == tauri::webview::PageLoadEvent::Finished {
                    "page-finished"
                } else {
                    "page-started"
                },
            );
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && std::env::var_os("CIALAI_BROTO_SELFTEST_RESULT").is_some()
            {
                let _ = webview.eval(include_str!("selftest.js"));
            }
        });
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    #[cfg(feature = "selftest")]
    if std::env::var_os("CIALAI_BROTO_SELFTEST_RESULT").is_some() {
        let result = std::env::var_os("CIALAI_BROTO_SELFTEST_RESULT").unwrap();
        for window in &mut context.config_mut().app.windows {
            window.incognito = true;
            #[cfg(windows)]
            if let Some(name) = std::path::Path::new(&result)
                .parent()
                .and_then(|path| path.file_name())
            {
                // WebView2 environments cannot share a profile across sessions.
                window.data_directory = Some(std::path::PathBuf::from(name));
            }
        }
        #[cfg(not(windows))]
        let _ = result;
    }
    #[cfg(feature = "selftest")]
    record_selftest_lifecycle("build-start");
    let app = builder.build(context).expect("Broto monitor failed");
    #[cfg(feature = "selftest")]
    record_selftest_lifecycle("build-complete");
    app.run(|_app, event| {
        #[cfg(feature = "selftest")]
        match event {
            tauri::RunEvent::Ready => {
                record_selftest_lifecycle("ready");
                if let Some(window) = _app.get_webview_window("main") {
                    if let Ok(url) = window.url() {
                        record_selftest_lifecycle(&format!("url:{url}"));
                    }
                }
            }
            tauri::RunEvent::ExitRequested { .. } => record_selftest_lifecycle("exit-requested"),
            tauri::RunEvent::Exit => record_selftest_lifecycle("exit"),
            tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } => record_selftest_lifecycle("window-destroyed"),
            _ => {}
        }
        #[cfg(not(feature = "selftest"))]
        let _ = event;
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Service {
        response: std::io::Cursor<Vec<u8>>,
        request: Vec<u8>,
    }
    impl std::io::Read for Service {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            self.response.read(bytes)
        }
    }
    impl std::io::Write for Service {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.request.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    fn service(response: &str) -> Service {
        Service {
            response: std::io::Cursor::new(response.as_bytes().to_vec()),
            request: Vec::new(),
        }
    }
    #[test]
    fn installation_uses_bundled_executable_and_literal_arguments_without_shell() {
        let command = service_install_command(
            std::path::Path::new("/trusted app/cialai-broto"),
            std::path::Path::new("/trusted app/service"),
            "trusted-key",
        );
        assert_eq!(command.get_program(), "/trusted app/cialai-broto");
        assert_eq!(
            command
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect::<Vec<_>>(),
            vec![
                "instalar",
                "--payload",
                "/trusted app/service",
                "--key",
                "trusted-key"
            ]
        );
        assert_eq!(pipe_name("John Doe"), r"\\.\pipe\cialai-broto-John_Doe");
        assert_eq!(pipe_name(""), r"\\.\pipe\cialai-broto-user");
    }
    #[test]
    fn local_exchange_accepts_only_the_matching_reply() {
        assert_eq!(
            exchange(
                service("{\"id\":\"monitor\",\"result\":{\"state\":\"paused\"}}\n"),
                "broto.status",
                json!({})
            )
            .unwrap()["state"],
            "paused"
        );
        assert!(
            exchange(
                service("{\"id\":\"other\",\"result\":{}}\n"),
                "broto.status",
                json!({})
            )
            .is_err()
        );
    }
    #[test]
    fn service_errors_and_malformed_replies_fail_closed() {
        assert!(
            exchange(
                service("{\"id\":\"monitor\",\"error\":{\"message\":\"denied\"}}\n"),
                "broto.pause",
                json!({})
            )
            .is_err()
        );
        assert!(exchange(service("garbage\n"), "broto.status", json!({})).is_err());
        assert!(validate_method("shell.execute").is_err());
    }
}
