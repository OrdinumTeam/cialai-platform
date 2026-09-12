// SPDX-License-Identifier: Apache-2.0
//! Aparencia, tamanho e coreografia de abertura da janela principal.
//!
//! A janela nasce pequena e invisivel. O frontend monta a tela de abertura e
//! chama `splash_ready`: a janela aparece centrada no lugar em que a janela de
//! trabalho ficou na sessao anterior. Quando os dados chegam, o frontend
//! chama `window_grow` e a janela cresce ate o tamanho de trabalho num laco
//! de quadros proprio, com ease-out, como o Claude Desktop faz ao abrir. So
//! entao o tamanho minimo e o redimensionamento sao liberados e a tela cheia
//! lembrada e devolvida.
//!
//! Tudo que mexe no NSWindow roda na thread principal, em giros separados do
//! loop: o tao aplica posicao e mascara de estilo em despachos assincronos, e
//! um quadro definido no mesmo giro seria sobrescrito por eles. Toda troca de
//! mascara de estilo do tao tira o teclado do webview; `focus_webview` devolve.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{LogicalSize, WebviewWindow};
use tauri_plugin_window_state::{StateFlags, WindowExt};

/// Tamanho da janela de abertura, em pontos. O mesmo de `tauri.conf.json`.
pub const SPLASH_WIDTH: f64 = 440.0;
pub const SPLASH_HEIGHT: f64 = 320.0;
const MIN_WIDTH: f64 = 1040.0;
const MIN_HEIGHT: f64 = 680.0;
const DEFAULT_WIDTH: f64 = 1380.0;
const DEFAULT_HEIGHT: f64 = 880.0;
/// Se o frontend nao sinalizar a abertura ate aqui, a janela aparece mesmo assim.
const SHOW_FALLBACK: Duration = Duration::from_secs(6);
/// Espera maxima por um giro da thread principal.
const MAIN_THREAD_TIMEOUT: Duration = Duration::from_millis(2500);
/// A posicao lembrada e aplicada pelo tao no giro seguinte do loop principal.
const RESTORE_SETTLE: Duration = Duration::from_millis(40);
/// Uma janela recem mostrada ainda esta na animacao de aparecer do macOS.
const REVEAL_SETTLE: Duration = Duration::from_millis(160);
/// Duracao e passo do crescimento ate o tamanho de trabalho.
const GROW_DURATION: Duration = Duration::from_millis(520);
const GROW_STEP: Duration = Duration::from_millis(16);

/// Aplica o material translucido de sidebar do macOS atras de toda a janela e
/// arma a rede de seguranca da abertura. O frontend pinta a janela inteira, o
/// conteudo em branco e a sidebar no gradiente da marca, entao a vibrancy fica
/// so como material de fundo, para a janela nunca aparecer vazada enquanto o
/// webview ainda nao pintou.
pub fn decorate(window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
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

    let _ = window.set_title("Cialai");

    // Se o webview falhar antes de montar a abertura, a janela ainda aparece e
    // cresce, para o erro ficar visivel em vez de um app invisivel no Dock.
    let handle = window.clone();
    thread::spawn(move || {
        thread::sleep(SHOW_FALLBACK);
        if !handle.is_visible().unwrap_or(true) {
            eprintln!("[window] o frontend nao sinalizou a abertura; mostrando a janela");
            grow(&handle);
        }
    });
}

/// Mostra a janela de abertura. Chamado quando a tela de abertura ja esta
/// montada, para nao piscar uma janela vazia. Bloqueia; nunca na thread
/// principal.
pub fn show_splash(window: &WebviewWindow) {
    reveal(window);
}

/// Posiciona e mostra a janela de abertura se ela ainda esta escondida.
/// Devolve `true` quando precisou mostrar.
fn reveal(window: &WebviewWindow) -> bool {
    let hidden =
        on_main_thread(window, |handle| !handle.is_visible().unwrap_or(false)).unwrap_or(false);
    if !hidden {
        return false;
    }

    // Primeiro giro: pede a posicao lembrada. O tao aplica no giro seguinte.
    let before = on_main_thread(window, |handle| {
        let before = current_frame(handle);
        let _ = handle.restore_state(StateFlags::POSITION);
        before
    })
    .flatten();
    thread::sleep(RESTORE_SETTLE);

    // Segundo giro: centra a abertura na janela de trabalho que vai nascer e mostra.
    on_main_thread(window, move |handle| {
        if handle.is_visible().unwrap_or(false) {
            return;
        }
        if let (Some(before), Some(after)) = (before, current_frame(handle)) {
            if is_splash_sized(after) {
                let remembered =
                    (after.x - before.x).abs() > 1.0 || (after.y - before.y).abs() > 1.0;
                let frame = splash_frame(after, remembered, visible_area(handle));
                set_frame(handle, frame, false);
            }
        }
        let _ = handle.show();
        let _ = handle.set_focus();
        eprintln!("[window] abertura em {:?}", current_frame(handle));
    });
    true
}

/// Cresce a janela ate o tamanho de trabalho, libera o redimensionamento e
/// devolve a tela cheia da sessao anterior. Bloqueia quem chama ate a
/// animacao terminar, entao nunca deve rodar na thread principal. Chamar de
/// novo com a janela ja grande nao faz nada.
pub fn grow(window: &WebviewWindow) -> bool {
    if reveal(window) {
        thread::sleep(REVEAL_SETTLE);
    }

    let plan = on_main_thread(window, |handle| {
        let current = current_frame(handle)?;
        if !is_splash_sized(current) {
            return None;
        }
        let visible = visible_area(handle);
        let target = working_frame(current, visible);
        eprintln!("[window] crescendo de {current:?} para {target:?}, area visivel {visible:?}");
        Some((current, target))
    })
    .flatten();

    let Some((from, target)) = plan else {
        release_working_size(window);
        return false;
    };

    let started = Instant::now();
    let mut frames = 0u32;
    loop {
        let progress = (started.elapsed().as_secs_f64() / GROW_DURATION.as_secs_f64()).min(1.0);
        let frame = from.towards(target, ease_out(progress));
        on_main_thread(window, move |handle| set_frame(handle, frame, true));
        frames += 1;
        if progress >= 1.0 {
            break;
        }
        thread::sleep(GROW_STEP);
    }
    eprintln!(
        "[window] tamanho de trabalho {:?} em {} ms e {} quadros",
        on_main_thread(window, current_frame).flatten(),
        started.elapsed().as_millis(),
        frames
    );

    release_working_size(window);
    true
}

/// Depois de crescer, a janela volta a ser redimensionavel, ganha o minimo
/// utilizavel e volta a tela cheia se estava nela ao sair. Em telas menores
/// que o minimo, o minimo vira o proprio tamanho.
fn release_working_size(window: &WebviewWindow) {
    on_main_thread(window, |handle| {
        let _ = handle.set_resizable(true);
        let (mut min_width, mut min_height) = (MIN_WIDTH, MIN_HEIGHT);
        if let (Ok(scale), Ok(size)) = (handle.scale_factor(), handle.inner_size()) {
            let logical = size.to_logical::<f64>(scale);
            min_width = min_width.min(logical.width);
            min_height = min_height.min(logical.height);
        }
        let _ = handle.set_min_size(Some(LogicalSize::new(min_width, min_height)));
        let _ = handle.restore_state(StateFlags::FULLSCREEN);
    });
    focus_webview(window);
}

/// Devolve o teclado ao webview. O tao, ao trocar a mascara de estilo da
/// janela em `set_resizable` e nas transicoes de tela cheia, torna a propria
/// NSView o primeiro respondedor. Com isso o teclado passa por fora do
/// WKWebView: Esc sai da tela cheia sem a pagina poder impedir e a digitacao
/// so volta depois de um clique. Chamar com o webview ja em foco nao faz nada.
pub fn focus_webview(window: &WebviewWindow) {
    let webview: &tauri::Webview = window.as_ref();
    let _ = webview.set_focus();
}

/// Roda `task` na thread principal e espera o resultado.
fn on_main_thread<T: Send + 'static>(
    window: &WebviewWindow,
    task: impl FnOnce(&WebviewWindow) -> T + Send + 'static,
) -> Option<T> {
    let (sender, receiver) = mpsc::channel();
    let handle = window.clone();
    let queued = window.run_on_main_thread(move || {
        let _ = sender.send(task(&handle));
    });
    if queued.is_err() {
        return None;
    }
    receiver.recv_timeout(MAIN_THREAD_TIMEOUT).ok()
}

fn is_splash_sized(frame: Rect) -> bool {
    frame.width <= SPLASH_WIDTH + 2.0 && frame.height <= SPLASH_HEIGHT + 2.0
}

fn ease_out(progress: f64) -> f64 {
    1.0 - (1.0 - progress).powi(3)
}

/// Retangulo em que a janela vai trabalhar: tamanho padrao limitado pela area
/// visivel da tela, centrado no mesmo ponto do retangulo atual e trazido para
/// dentro da tela quando encosta na borda.
fn working_frame(current: Rect, visible: Option<Rect>) -> Rect {
    let (width, height) = fit_working_size(visible);
    let center_x = current.x + current.width / 2.0;
    let center_y = current.y + current.height / 2.0;
    let frame = Rect {
        x: center_x - width / 2.0,
        y: center_y - height / 2.0,
        width,
        height,
    };
    clamp_into(frame, visible)
}

/// Retangulo da janela de abertura. Quando a posicao da sessao anterior foi
/// restaurada, `current` guarda o canto superior esquerdo da janela de
/// trabalho: a abertura fica no centro dela, e o crescimento devolve a janela
/// ao lugar lembrado. Sem posicao lembrada, a abertura fica onde o sistema a
/// centralizou.
fn splash_frame(current: Rect, remembered: bool, visible: Option<Rect>) -> Rect {
    let (center_x, center_y) = if remembered {
        let (width, height) = fit_working_size(visible);
        let top = current.y + current.height;
        let target = clamp_into(
            Rect {
                x: current.x,
                y: top - height,
                width,
                height,
            },
            visible,
        );
        (
            target.x + target.width / 2.0,
            target.y + target.height / 2.0,
        )
    } else {
        (
            current.x + current.width / 2.0,
            current.y + current.height / 2.0,
        )
    };
    let frame = Rect {
        x: center_x - SPLASH_WIDTH / 2.0,
        y: center_y - SPLASH_HEIGHT / 2.0,
        width: SPLASH_WIDTH,
        height: SPLASH_HEIGHT,
    };
    clamp_into(frame, visible)
}

fn fit_working_size(visible: Option<Rect>) -> (f64, f64) {
    match visible {
        Some(area) => (
            DEFAULT_WIDTH.min(area.width).max(SPLASH_WIDTH),
            DEFAULT_HEIGHT.min(area.height).max(SPLASH_HEIGHT),
        ),
        None => (DEFAULT_WIDTH, DEFAULT_HEIGHT),
    }
}

fn clamp_into(frame: Rect, visible: Option<Rect>) -> Rect {
    let Some(area) = visible else {
        return frame.rounded();
    };
    let max_x = (area.x + area.width - frame.width).max(area.x);
    let max_y = (area.y + area.height - frame.height).max(area.y);
    Rect {
        x: frame.x.min(max_x).max(area.x),
        y: frame.y.min(max_y).max(area.y),
        width: frame.width,
        height: frame.height,
    }
    .rounded()
}

/// Retangulo em pontos, origem no canto inferior esquerdo como no AppKit.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

impl Rect {
    fn rounded(self) -> Self {
        Self {
            x: self.x.round(),
            y: self.y.round(),
            width: self.width.round(),
            height: self.height.round(),
        }
    }

    /// Ponto entre este retangulo e `other`, com `progress` de 0 a 1.
    fn towards(self, other: Self, progress: f64) -> Self {
        Self {
            x: self.x + (other.x - self.x) * progress,
            y: self.y + (other.y - self.y) * progress,
            width: self.width + (other.width - self.width) * progress,
            height: self.height + (other.height - self.height) * progress,
        }
        .rounded()
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use tauri::WebviewWindow;

    use super::Rect;

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
}

#[cfg(target_os = "macos")]
use platform::{current_frame, set_frame, visible_area};

#[cfg(not(target_os = "macos"))]
fn current_frame(_window: &WebviewWindow) -> Option<Rect> {
    None
}

#[cfg(not(target_os = "macos"))]
fn visible_area(_window: &WebviewWindow) -> Option<Rect> {
    None
}

#[cfg(not(target_os = "macos"))]
fn set_frame(window: &WebviewWindow, frame: Rect, _display: bool) {
    let _ = window.set_size(LogicalSize::new(frame.width, frame.height));
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: Rect = Rect {
        x: 0.0,
        y: 25.0,
        width: 1728.0,
        height: 1055.0,
    };

    #[test]
    fn working_frame_keeps_the_center_of_the_splash() {
        let splash = Rect {
            x: 644.0,
            y: 392.0,
            width: SPLASH_WIDTH,
            height: SPLASH_HEIGHT,
        };
        let frame = working_frame(splash, Some(SCREEN));
        assert_eq!(frame.width, DEFAULT_WIDTH);
        assert_eq!(frame.height, DEFAULT_HEIGHT);
        assert_eq!(frame.x + frame.width / 2.0, splash.x + splash.width / 2.0);
        assert_eq!(frame.y + frame.height / 2.0, splash.y + splash.height / 2.0);
    }

    #[test]
    fn working_frame_stays_inside_the_screen() {
        let splash = Rect {
            x: 10.0,
            y: 30.0,
            width: SPLASH_WIDTH,
            height: SPLASH_HEIGHT,
        };
        let frame = working_frame(splash, Some(SCREEN));
        assert_eq!(frame.x, SCREEN.x);
        assert_eq!(frame.y, SCREEN.y);
    }

    #[test]
    fn working_frame_shrinks_to_small_screens() {
        let small = Rect {
            x: 0.0,
            y: 0.0,
            width: 1280.0,
            height: 775.0,
        };
        let frame = working_frame(
            Rect {
                x: 400.0,
                y: 200.0,
                width: SPLASH_WIDTH,
                height: SPLASH_HEIGHT,
            },
            Some(small),
        );
        assert_eq!(frame.width, 1280.0);
        assert_eq!(frame.height, 775.0);
        assert_eq!((frame.x, frame.y), (0.0, 0.0));
    }

    #[test]
    fn splash_frame_centers_on_the_remembered_working_window() {
        // A posicao restaurada deixa o canto superior esquerdo da janela de
        // trabalho em (200, 1000). A abertura fica no centro dessa janela e o
        // crescimento devolve exatamente o mesmo retangulo.
        let restored = Rect {
            x: 200.0,
            y: 1000.0 - SPLASH_HEIGHT,
            width: SPLASH_WIDTH,
            height: SPLASH_HEIGHT,
        };
        let splash = splash_frame(restored, true, Some(SCREEN));
        let grown = working_frame(splash, Some(SCREEN));
        assert_eq!(grown.x, 200.0);
        assert_eq!(grown.y + grown.height, 1000.0);
    }

    #[test]
    fn splash_frame_without_memory_keeps_the_current_center() {
        let centered = Rect {
            x: 644.0,
            y: 392.0,
            width: SPLASH_WIDTH,
            height: SPLASH_HEIGHT,
        };
        assert_eq!(splash_frame(centered, false, Some(SCREEN)), centered);
    }

    #[test]
    fn towards_interpolates_and_lands_on_the_target() {
        let from = Rect {
            x: 0.0,
            y: 0.0,
            width: 100.0,
            height: 100.0,
        };
        let to = Rect {
            x: 100.0,
            y: 50.0,
            width: 300.0,
            height: 200.0,
        };
        assert_eq!(from.towards(to, 0.0), from);
        assert_eq!(from.towards(to, 1.0), to);
        let half = from.towards(to, 0.5);
        assert_eq!(
            (half.x, half.y, half.width, half.height),
            (50.0, 25.0, 200.0, 150.0)
        );
        assert!(ease_out(0.5) > 0.5 && ease_out(1.0) == 1.0 && ease_out(0.0) == 0.0);
    }
}
