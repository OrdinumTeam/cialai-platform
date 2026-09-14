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
//! Tudo que mexe na janela nativa roda na thread principal, em giros separados
//! do loop: o tao aplica posicao e mascara de estilo em despachos assincronos,
//! e um quadro definido no mesmo giro seria sobrescrito por eles. Toda troca
//! de mascara de estilo do tao tira o teclado do webview; `focus_webview`
//! devolve.
//!
//! Cada sistema tem um backend com as mesmas funcoes: `macos` move o NSWindow
//! em pontos com origem embaixo; `windows` usa `SetWindowPos` em pixels
//! fisicos; `generic` anima posicao e tamanho no X11 e, no Wayland, onde o
//! compositor controla a posicao, salta direto ao tamanho final.

use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{LogicalSize, WebviewWindow};
use tauri_plugin_window_state::{StateFlags, WindowExt};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use self::macos as backend;

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use self::windows as backend;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod generic;
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
use self::generic as backend;

use backend::{current_frame, set_frame, visible_area};

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
/// Uma janela recem mostrada ainda esta na animacao de aparecer do sistema.
const REVEAL_SETTLE: Duration = Duration::from_millis(160);
/// Duracao e passo do crescimento ate o tamanho de trabalho.
const GROW_DURATION: Duration = Duration::from_millis(520);
const GROW_STEP: Duration = Duration::from_millis(16);
/// Primeiro build do Windows 11 22H2, a partir do qual o Mica e aplicado.
#[cfg(any(test, target_os = "windows"))]
const MICA_MIN_BUILD: u32 = 22621;

/// Aplica o material de fundo do sistema e arma a rede de seguranca da
/// abertura. O frontend pinta a janela inteira, o conteudo em branco e a
/// sidebar no gradiente da marca, entao vibrancy no macOS e Mica no Windows
/// ficam so como material de fundo, para a janela nunca aparecer vazada
/// enquanto o webview ainda nao pintou. `backdrop` vem das preferencias.
pub fn decorate(window: &WebviewWindow, backdrop: &str) {
    backend::decorate(window, backdrop);

    let _ = window.set_title("Cialai");

    // Se o webview falhar antes de montar a abertura, a janela ainda aparece e
    // cresce, para o erro ficar visivel em vez de um app invisivel.
    let handle = window.clone();
    thread::spawn(move || {
        thread::sleep(SHOW_FALLBACK);
        if !handle.is_visible().unwrap_or(true) {
            eprintln!("[window] o frontend nao sinalizou a abertura; mostrando a janela");
            grow(&handle);
        }
    });
}

/// Troca o material de fundo com a janela aberta, quando a preferencia muda.
/// So o Windows tem escolha; nos outros sistemas nada acontece.
pub fn apply_backdrop(window: &WebviewWindow, backdrop: &str) {
    backend::apply_backdrop(window, backdrop);
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

    // Sem controle de posicao, como no Wayland, a abertura fica onde o
    // compositor decidir.
    if !backend::positions_window() {
        on_main_thread(window, |handle| {
            let _ = handle.show();
            let _ = handle.set_focus();
        });
        return true;
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
                let frame = splash_frame(after, remembered, visible_area(handle), backend::ORIGIN);
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

    if !backend::positions_window() {
        return jump(window);
    }

    let plan = on_main_thread(window, |handle| {
        let Some(current) = current_frame(handle) else {
            eprintln!("[window] quadro atual indisponivel; a janela nao cresce");
            return None;
        };
        if !is_splash_sized(current) {
            eprintln!("[window] a janela ja saiu do tamanho de abertura: {current:?}");
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

/// Crescimento sem animacao nem posicao, para quem nao pode mover a janela:
/// um unico pedido de tamanho, com o minimo calculado sobre o alvo, porque o
/// compositor confirma o tamanho de forma assincrona. Chamar de novo com a
/// janela ja grande so reaplica o minimo e a tela cheia lembrada.
fn jump(window: &WebviewWindow) -> bool {
    let resized = on_main_thread(window, |handle| {
        let _ = handle.set_resizable(true);
        let scale = handle.scale_factor().unwrap_or(1.0);
        let mut working = handle
            .inner_size()
            .map(|size| size.to_logical::<f64>(scale))
            .map(|size| (size.width, size.height))
            .unwrap_or((MIN_WIDTH, MIN_HEIGHT));
        let resized = is_splash_sized_size(working.0, working.1);
        if resized {
            working = fit_working_size(visible_area(handle));
            let _ = handle.set_size(LogicalSize::new(working.0, working.1));
            eprintln!(
                "[window] tamanho de trabalho {}x{} sem animacao",
                working.0, working.1
            );
        }
        let (min_width, min_height) = working_min_size(working);
        let _ = handle.set_min_size(Some(LogicalSize::new(min_width, min_height)));
        let _ = handle.restore_state(StateFlags::FULLSCREEN);
        resized
    })
    .unwrap_or(false);
    focus_webview(window);
    resized
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
            (min_width, min_height) = working_min_size((logical.width, logical.height));
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
        eprintln!("[window] nao foi possivel agendar tarefa na thread principal");
        return None;
    }
    let result = receiver.recv_timeout(MAIN_THREAD_TIMEOUT).ok();
    if result.is_none() {
        eprintln!(
            "[window] a thread principal nao respondeu em {} ms",
            MAIN_THREAD_TIMEOUT.as_millis()
        );
    }
    result
}

fn is_splash_sized(frame: Rect) -> bool {
    is_splash_sized_size(frame.width, frame.height)
}

fn is_splash_sized_size(width: f64, height: f64) -> bool {
    width <= SPLASH_WIDTH + 2.0 && height <= SPLASH_HEIGHT + 2.0
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
fn splash_frame(current: Rect, remembered: bool, visible: Option<Rect>, origin: Origin) -> Rect {
    let (center_x, center_y) = if remembered {
        let (width, height) = fit_working_size(visible);
        let top = origin.top(current);
        let target = clamp_into(
            Rect {
                x: current.x,
                y: origin.y_below(top, height),
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

/// Minimo utilizavel para uma janela do tamanho dado.
fn working_min_size((width, height): (f64, f64)) -> (f64, f64) {
    (MIN_WIDTH.min(width), MIN_HEIGHT.min(height))
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

/// Sentido do eixo vertical no sistema de coordenadas do backend. Cada
/// sistema constroi so a sua variante.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Origin {
    /// AppKit: y cresce para cima a partir do canto inferior esquerdo.
    #[cfg_attr(not(any(test, target_os = "macos")), allow(dead_code))]
    BottomLeft,
    /// Windows, X11 e Wayland: y cresce para baixo a partir do topo.
    #[cfg_attr(all(target_os = "macos", not(test)), allow(dead_code))]
    TopLeft,
}

impl Origin {
    /// Coordenada da borda de cima do retangulo.
    fn top(self, frame: Rect) -> f64 {
        match self {
            Self::BottomLeft => frame.y + frame.height,
            Self::TopLeft => frame.y,
        }
    }

    /// `y` de um retangulo de altura `height` cuja borda de cima fica em `top`.
    fn y_below(self, top: f64, height: f64) -> f64 {
        match self {
            Self::BottomLeft => top - height,
            Self::TopLeft => top,
        }
    }
}

/// Retangulo em pontos logicos, no sistema de coordenadas do backend.
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

/// Converte um retangulo em pixels fisicos para pontos logicos.
#[cfg(any(test, not(target_os = "macos")))]
fn logical_rect(x: i32, y: i32, width: u32, height: u32, scale: f64) -> Rect {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    Rect {
        x: f64::from(x) / scale,
        y: f64::from(y) / scale,
        width: f64::from(width) / scale,
        height: f64::from(height) / scale,
    }
}

/// Converte um retangulo logico para pixels fisicos inteiros.
#[cfg(any(test, target_os = "windows"))]
fn physical_rect(frame: Rect, scale: f64) -> (i32, i32, i32, i32) {
    let scale = if scale > 0.0 { scale } else { 1.0 };
    let pixels = |value: f64| (value * scale).round() as i32;
    (
        pixels(frame.x),
        pixels(frame.y),
        pixels(frame.width),
        pixels(frame.height),
    )
}

/// Sessao Wayland: `WAYLAND_DISPLAY` presente e o GTK sem `GDK_BACKEND`
/// pedindo X11 como primeira opcao. Pelo XWayland a janela volta a ser
/// posicionavel.
#[cfg(any(test, not(any(target_os = "macos", target_os = "windows"))))]
fn is_wayland_session(
    wayland_display: Option<&std::ffi::OsStr>,
    gdk_backend: Option<&std::ffi::OsStr>,
) -> bool {
    let has_display = wayland_display.is_some_and(|value| !value.is_empty());
    let prefers_x11 = gdk_backend
        .and_then(|value| value.to_str())
        .and_then(|value| value.split(',').next())
        .is_some_and(|first| first.trim().eq_ignore_ascii_case("x11"));
    has_display && !prefers_x11
}

/// Mica so a partir do Windows 11 22H2; antes disso a pagina pinta o fundo.
#[cfg(any(test, target_os = "windows"))]
fn mica_supported(build: u32) -> bool {
    build >= MICA_MIN_BUILD
}

/// Mica com o fundo automatico num Windows que o suporta; o fundo solido e
/// valores desconhecidos nunca aplicam o material.
#[cfg(any(test, target_os = "windows"))]
fn wants_mica(backdrop: &str, build: u32) -> bool {
    backdrop == crate::prefs::BACKDROP_AUTO && mica_supported(build)
}

#[cfg(test)]
mod tests {
    use std::ffi::OsStr;

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
        let splash = splash_frame(restored, true, Some(SCREEN), Origin::BottomLeft);
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
        assert_eq!(
            splash_frame(centered, false, Some(SCREEN), Origin::BottomLeft),
            centered
        );
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

    #[test]
    fn splash_frame_with_top_left_origin_returns_to_the_remembered_corner() {
        // Windows e X11 contam y de cima para baixo: a posicao restaurada deixa
        // o canto superior esquerdo da janela de trabalho em (200, 120).
        let screen = Rect {
            x: 0.0,
            y: 0.0,
            width: 1920.0,
            height: 1040.0,
        };
        let restored = Rect {
            x: 200.0,
            y: 120.0,
            width: SPLASH_WIDTH,
            height: SPLASH_HEIGHT,
        };
        let splash = splash_frame(restored, true, Some(screen), Origin::TopLeft);
        let grown = working_frame(splash, Some(screen));
        assert_eq!((grown.x, grown.y), (200.0, 120.0));
        assert_eq!((grown.width, grown.height), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
    }

    #[test]
    fn logical_and_physical_frames_round_trip_with_the_scale() {
        let frame = logical_rect(300, 150, 660, 480, 1.5);
        assert_eq!(
            frame,
            Rect {
                x: 200.0,
                y: 100.0,
                width: SPLASH_WIDTH,
                height: SPLASH_HEIGHT,
            }
        );
        assert_eq!(physical_rect(frame, 1.5), (300, 150, 660, 480));
        assert_eq!(
            physical_rect(logical_rect(-1920, 0, 1920, 1040, 1.0), 1.0),
            (-1920, 0, 1920, 1040)
        );
    }

    #[test]
    fn wayland_is_detected_without_the_x11_override() {
        let wayland = Some(OsStr::new("wayland-0"));
        assert!(is_wayland_session(wayland, None));
        assert!(is_wayland_session(wayland, Some(OsStr::new("wayland,x11"))));
        assert!(!is_wayland_session(wayland, Some(OsStr::new("x11"))));
        assert!(!is_wayland_session(
            wayland,
            Some(OsStr::new(" x11,wayland"))
        ));
        assert!(!is_wayland_session(None, None));
        assert!(!is_wayland_session(Some(OsStr::new("")), None));
    }

    #[test]
    fn mica_follows_the_backdrop_preference() {
        assert!(wants_mica("auto", MICA_MIN_BUILD));
        assert!(!wants_mica("solid", MICA_MIN_BUILD));
        assert!(!wants_mica("auto", 19045));
        assert!(!wants_mica("acrylic", 26100));
    }

    #[test]
    fn mica_starts_at_windows_11_22h2() {
        assert!(!mica_supported(0));
        assert!(!mica_supported(19045));
        assert!(!mica_supported(22000));
        assert!(mica_supported(MICA_MIN_BUILD));
        assert!(mica_supported(26100));
    }

    #[test]
    fn jump_size_fills_the_screen_up_to_the_working_size() {
        assert_eq!(fit_working_size(None), (DEFAULT_WIDTH, DEFAULT_HEIGHT));
        let small = Rect {
            x: 0.0,
            y: 0.0,
            width: 1280.0,
            height: 700.0,
        };
        assert_eq!(fit_working_size(Some(small)), (1280.0, 700.0));
        assert_eq!(working_min_size((1280.0, 700.0)), (MIN_WIDTH, 680.0));
        assert_eq!(working_min_size((900.0, 600.0)), (900.0, 600.0));
    }
}
