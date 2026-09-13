// SPDX-License-Identifier: Apache-2.0
//! Backend macOS: o NSWindow e movido por `setFrame_display`, em pontos com
//! origem no canto inferior esquerdo, e a vibrancy de sidebar fica atras da
//! pagina.

use objc2_app_kit::NSWindow;
use objc2_foundation::{NSPoint, NSRect, NSSize};
use tauri::WebviewWindow;

use super::{Origin, Rect};

pub const ORIGIN: Origin = Origin::BottomLeft;

/// O AppKit posiciona a janela em qualquer tela.
pub fn positions_window() -> bool {
    true
}

pub fn decorate(window: &WebviewWindow, _backdrop: &str) {
    use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState, apply_vibrancy};
    if let Err(error) = apply_vibrancy(
        window,
        NSVisualEffectMaterial::Sidebar,
        Some(NSVisualEffectState::FollowsWindowActiveState),
        None,
    ) {
        eprintln!("[window] vibrancy indisponivel: {error}");
    }
}

fn ns_window(window: &WebviewWindow) -> Option<&NSWindow> {
    let pointer = window.ns_window().ok()?;
    if pointer.is_null() {
        return None;
    }
    // SAFETY: o Tauri devolve o NSWindow vivo da janela e estas funcoes so
    // rodam na thread principal, via `on_main_thread`.
    Some(unsafe { &*(pointer as *const NSWindow) })
}

fn rect(frame: NSRect) -> Rect {
    Rect {
        x: frame.origin.x,
        y: frame.origin.y,
        width: frame.size.width,
        height: frame.size.height,
    }
}

pub fn current_frame(window: &WebviewWindow) -> Option<Rect> {
    ns_window(window).map(|ns_window| rect(ns_window.frame()))
}

/// Area visivel da tela em que a janela esta, sem menu bar e Dock.
pub fn visible_area(window: &WebviewWindow) -> Option<Rect> {
    ns_window(window)?
        .screen()
        .map(|screen| rect(screen.visibleFrame()))
}

pub fn set_frame(window: &WebviewWindow, frame: Rect, display: bool) {
    if let Some(ns_window) = ns_window(window) {
        let frame = NSRect::new(
            NSPoint::new(frame.x, frame.y),
            NSSize::new(frame.width, frame.height),
        );
        ns_window.setFrame_display(frame, display);
    }
}
