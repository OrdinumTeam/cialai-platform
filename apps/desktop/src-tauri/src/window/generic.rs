// SPDX-License-Identifier: Apache-2.0
//! Backend Linux, com decoracoes do gerenciador de janelas. No X11 a abertura
//! anima posicao e tamanho por `set_position` e `set_size` a cada quadro. O
//! tamanho animado e o interno, porque `set_size` pede a area do cliente sem a
//! barra de titulo; a posicao e a do quadro externo. No Wayland o compositor
//! controla a posicao: a janela salta ao tamanho final e o splash nao e
//! centralizado.

use std::env;

use tauri::{LogicalPosition, LogicalSize, WebviewWindow};

use super::{Origin, Rect, is_wayland_session, logical_rect};

pub const ORIGIN: Origin = Origin::TopLeft;

/// Falso no Wayland nativo; verdadeiro no X11 e no XWayland.
pub fn positions_window() -> bool {
    !is_wayland_session(
        env::var_os("WAYLAND_DISPLAY").as_deref(),
        env::var_os("GDK_BACKEND").as_deref(),
    )
}

/// Linux nao tem material de fundo nativo; a janela e opaca.
pub fn decorate(_window: &WebviewWindow, _backdrop: &str) {}

/// Sem material de fundo, a preferencia nao muda nada no Linux.
pub fn apply_backdrop(_window: &WebviewWindow, _backdrop: &str) {}

fn scale(window: &WebviewWindow) -> f64 {
    window.scale_factor().unwrap_or(1.0)
}

pub fn current_frame(window: &WebviewWindow) -> Option<Rect> {
    let position = window.outer_position().ok()?;
    let size = window.inner_size().ok()?;
    Some(logical_rect(
        position.x,
        position.y,
        size.width,
        size.height,
        scale(window),
    ))
}

/// Area util do monitor, descontada a altura das decoracoes, para que o
/// tamanho interno escolhido caiba com a barra de titulo.
pub fn visible_area(window: &WebviewWindow) -> Option<Rect> {
    let monitor = window.current_monitor().ok()??;
    let area = monitor.work_area();
    let decorations = match (window.outer_size(), window.inner_size()) {
        (Ok(outer), Ok(inner)) => outer.height.saturating_sub(inner.height),
        _ => 0,
    };
    Some(logical_rect(
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height.saturating_sub(decorations),
        scale(window),
    ))
}

pub fn set_frame(window: &WebviewWindow, frame: Rect, _display: bool) {
    let _ = window.set_position(LogicalPosition::new(frame.x, frame.y));
    let _ = window.set_size(LogicalSize::new(frame.width, frame.height));
}
