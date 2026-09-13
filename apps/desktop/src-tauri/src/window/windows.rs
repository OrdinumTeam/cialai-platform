// SPDX-License-Identifier: Apache-2.0
//! Backend Windows: a janela sem moldura e movida por um unico `SetWindowPos`
//! por quadro, em pixels fisicos, sem mudar a ordem nem roubar o foco. O
//! quadro vem de `outer_position` e `outer_size` e a area util do monitor, de
//! `work_area`. A coreografia comum trabalha em pontos logicos; a escala da
//! janela converte nas duas pontas. Mica so a partir do build 22621, com erro
//! apenas registrado.

use tauri::WebviewWindow;
use windows_sys::Win32::UI::WindowsAndMessaging::{SWP_NOACTIVATE, SWP_NOZORDER, SetWindowPos};

use super::{Origin, Rect, logical_rect, mica_supported, physical_rect, wants_mica};

pub const ORIGIN: Origin = Origin::TopLeft;

/// O Windows posiciona a janela sem restricao do compositor.
pub fn positions_window() -> bool {
    true
}

pub fn decorate(window: &WebviewWindow, backdrop: &str) {
    apply_backdrop(window, backdrop);
}

/// Mica com o fundo automatico; o fundo solido remove o material quando o
/// sistema o suporta. Falhas ficam apenas registradas.
pub fn apply_backdrop(window: &WebviewWindow, backdrop: &str) {
    let build = os_build();
    if wants_mica(backdrop, build) {
        if let Err(error) = window_vibrancy::apply_mica(window, None) {
            eprintln!("[window] Mica indisponivel: {error}");
        }
        return;
    }
    if !mica_supported(build) {
        if backdrop == crate::prefs::BACKDROP_AUTO {
            eprintln!("[window] Mica exige o build 22621; este Windows e o build {build}");
        }
        return;
    }
    if let Err(error) = window_vibrancy::clear_mica(window) {
        eprintln!("[window] nao foi possivel remover o Mica: {error}");
    }
}

/// Build real do sistema. `RtlGetVersion` nao depende do manifesto de
/// compatibilidade, ao contrario de `GetVersionExW`.
fn os_build() -> u32 {
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    // SAFETY: OSVERSIONINFOW e uma estrutura C sem invariantes; zerada e com o
    // tamanho preenchido e a entrada exigida por RtlGetVersion.
    let mut info: OSVERSIONINFOW = unsafe { std::mem::zeroed() };
    info.dwOSVersionInfoSize = std::mem::size_of::<OSVERSIONINFOW>() as u32;
    // SAFETY: o ponteiro aponta para a estrutura local inicializada acima.
    let status = unsafe { RtlGetVersion(&mut info) };
    if status == 0 { info.dwBuildNumber } else { 0 }
}

fn scale(window: &WebviewWindow) -> f64 {
    window.scale_factor().unwrap_or(1.0)
}

pub fn current_frame(window: &WebviewWindow) -> Option<Rect> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(logical_rect(
        position.x,
        position.y,
        size.width,
        size.height,
        scale(window),
    ))
}

/// Area util do monitor da janela, sem a barra de tarefas.
pub fn visible_area(window: &WebviewWindow) -> Option<Rect> {
    let monitor = window.current_monitor().ok()??;
    let area = monitor.work_area();
    Some(logical_rect(
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
        scale(window),
    ))
}

pub fn set_frame(window: &WebviewWindow, frame: Rect, _display: bool) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let (x, y, width, height) = physical_rect(frame, scale(window));
    // SAFETY: o HWND e o da janela principal viva, e a chamada roda na thread
    // principal via `on_main_thread`. Com SWP_NOZORDER o segundo argumento e
    // ignorado.
    unsafe {
        SetWindowPos(
            hwnd.0 as _,
            std::ptr::null_mut(),
            x,
            y,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}
