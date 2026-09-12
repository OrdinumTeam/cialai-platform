// SPDX-License-Identifier: Apache-2.0
//! Arraste nativo para fora do app: um arquivo ou pasta do explorador vira
//! uma sessao de arraste do AppKit, com o caminho no pasteboard como URL de
//! arquivo, para o Finder, outros apps e outras janelas receberem.
//!
//! Por que existe: o arraste interno do estudio e feito por eventos de
//! ponteiro, porque o wry intercepta o drag-and-drop do HTML dentro do app,
//! e esse arraste nao sai da janela. Quando o ponteiro cruza a borda com o
//! botao pressionado, o frontend chama `fs_drag_out` e aqui a sessao nativa
//! comeca na `contentView` da janela, com o evento de mouse corrente. Dali
//! em diante o AppKit conduz o gesto: soltar no Finder copia, soltar num app
//! que aceite arquivos entrega a URL, soltar de volta nesta janela chega pelo
//! evento de arraste do Tauri, como um arraste vindo do Finder.
//!
//! A fonte so oferece copia. Mover a partir daqui apagaria o original sem o
//! explorador saber, e o Finder ja e quem decide entre copiar e mover quando
//! a origem permite as duas.
//!
//! O fim da sessao e avisado pelo evento [`EVENT_DRAG_OUT_END`], com a
//! operacao que o destino escolheu, para o frontend soltar o estado.

use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;
use tauri::WebviewWindow;

use super::files::{FsError, FsResult};

/// Evento global emitido quando a sessao de arraste termina.
pub const EVENT_DRAG_OUT_END: &str = "drag-out://end";

/// Quanto esperar a thread principal comecar a sessao.
const START_TIMEOUT: Duration = Duration::from_secs(3);

/// Carga de [`EVENT_DRAG_OUT_END`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragOutEnd {
    /// `copy`, `move`, `link`, `generic`, `delete` ou `none` quando o gesto
    /// foi cancelado ou solto onde nada aceitava.
    pub operation: String,
}

/// Caminhos que podem ir ao pasteboard: absolutos, sem caracteres de
/// controle e existentes. Erro `not_found` quando nenhum sobra.
pub fn existing_paths(paths: &[String]) -> FsResult<Vec<PathBuf>> {
    let valid: Vec<PathBuf> = paths
        .iter()
        .filter(|path| !path.is_empty() && !path.chars().any(char::is_control))
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.exists())
        .collect();
    if valid.is_empty() {
        return Err(FsError {
            code: "not_found".into(),
            message: "Nada para arrastar: o item não existe mais.".into(),
        });
    }
    Ok(valid)
}

/// Nome da operacao escolhida pelo destino, a partir da mascara
/// `NSDragOperation`. Copia vence quando a mascara traz mais de um bit,
/// porque e a unica que a fonte oferece.
pub fn operation_name(mask: usize) -> &'static str {
    const COPY: usize = 1;
    const LINK: usize = 2;
    const GENERIC: usize = 4;
    const MOVE: usize = 16;
    const DELETE: usize = 32;
    if mask & COPY != 0 {
        "copy"
    } else if mask & MOVE != 0 {
        "move"
    } else if mask & LINK != 0 {
        "link"
    } else if mask & DELETE != 0 {
        "delete"
    } else if mask & GENERIC != 0 {
        "generic"
    } else {
        "none"
    }
}

/// Comeca a sessao nativa com os caminhos. Precisa ser chamado com o botao
/// do mouse ainda pressionado; devolve `gesture` quando ele ja foi solto.
pub fn start(window: &WebviewWindow, paths: Vec<String>) -> FsResult<()> {
    let paths = existing_paths(&paths)?;
    let (sender, receiver) = mpsc::channel();
    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = sender.send(platform::begin(&handle, &paths));
        })
        .map_err(|error| FsError {
            code: "io".into(),
            message: format!("Não deu para chegar à thread principal: {error}"),
        })?;
    receiver.recv_timeout(START_TIMEOUT).unwrap_or_else(|_| {
        Err(FsError {
            code: "timeout".into(),
            message: "A thread principal não respondeu ao arraste.".into(),
        })
    })
}

#[cfg(target_os = "macos")]
mod platform {
    use std::cell::RefCell;
    use std::path::PathBuf;

    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::{
        AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send,
    };
    use objc2_app_kit::{
        NSApplication, NSDragOperation, NSDraggingContext, NSDraggingItem, NSDraggingSession,
        NSDraggingSource, NSEvent, NSEventModifierFlags, NSEventType, NSWindow, NSWorkspace,
    };
    use objc2_foundation::{
        NSArray, NSObject, NSObjectProtocol, NSPoint, NSProcessInfo, NSRect, NSSize, NSString,
        NSURL,
    };
    use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

    use super::{DragOutEnd, EVENT_DRAG_OUT_END, operation_name};
    use crate::workspace::files::{FsError, FsResult};

    /// Lado do icone que acompanha o cursor, em pontos.
    const ICON: f64 = 32.0;

    struct Ivars {
        app: AppHandle,
    }

    define_class!(
        // SAFETY: NSObject nao impoe requisitos a subclasses e DragSource nao
        // implementa Drop. So a thread principal cria e usa a fonte, que e o
        // que o AppKit exige de quem conduz um arraste.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[name = "CialaiDragOutSource"]
        #[ivars = Ivars]
        struct DragSource;

        unsafe impl NSObjectProtocol for DragSource {}

        unsafe impl NSDraggingSource for DragSource {
            #[unsafe(method(draggingSession:sourceOperationMaskForDraggingContext:))]
            fn source_operation_mask(
                &self,
                _session: &NSDraggingSession,
                _context: NSDraggingContext,
            ) -> NSDragOperation {
                NSDragOperation::Copy
            }

            #[unsafe(method(draggingSession:endedAtPoint:operation:))]
            fn ended(
                &self,
                _session: &NSDraggingSession,
                _point: NSPoint,
                operation: NSDragOperation,
            ) {
                let payload = DragOutEnd {
                    operation: operation_name(operation.bits()).to_string(),
                };
                let _ = self.ivars().app.emit(EVENT_DRAG_OUT_END, payload);
            }
        }
    );

    impl DragSource {
        fn new(mtm: MainThreadMarker, app: AppHandle) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars { app });
            // SAFETY: init de NSObject sobre uma alocacao com os ivars postos.
            unsafe { msg_send![super(this), init] }
        }
    }

    thread_local! {
        // A fonte precisa viver ate o fim da sessao, e o AppKit nao promete
        // rete-la. Fica guardada aqui ate a proxima sessao substitui-la; o
        // ultimo objeto sobra ate o app fechar, e e um objeto so.
        static HELD: RefCell<Option<Retained<DragSource>>> = const { RefCell::new(None) };
    }

    fn ns_window(window: &WebviewWindow) -> Option<&NSWindow> {
        let pointer = window.ns_window().ok()?;
        if pointer.is_null() {
            return None;
        }
        // SAFETY: o Tauri devolve o NSWindow vivo da janela, e isto so roda na
        // thread principal, onde o AppKit o manipula.
        Some(unsafe { &*(pointer as *const NSWindow) })
    }

    fn gesture_error() -> FsError {
        FsError {
            code: "gesture".into(),
            message: "O botão do mouse já foi solto.".into(),
        }
    }

    /// Evento que representa o gesto em curso. O corrente serve quando ainda
    /// e o arraste do mouse; entre o `mousemove` da pagina e esta chamada
    /// outro evento pode ter passado pela fila, e ai um evento de arraste
    /// montado na posicao atual do cursor faz o mesmo papel.
    fn gesture_event(mtm: MainThreadMarker, ns_window: &NSWindow) -> Option<Retained<NSEvent>> {
        let app = NSApplication::sharedApplication(mtm);
        if let Some(event) = app.currentEvent() {
            let kind = event.r#type();
            if kind == NSEventType::LeftMouseDragged || kind == NSEventType::LeftMouseDown {
                return Some(event);
            }
        }
        let location = ns_window.convertPointFromScreen(NSEvent::mouseLocation());
        let uptime = NSProcessInfo::processInfo().systemUptime();
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDragged,
            location,
            NSEventModifierFlags::empty(),
            uptime,
            ns_window.windowNumber(),
            None,
            0,
            1,
            1.0,
        )
    }

    pub fn begin(window: &WebviewWindow, paths: &[PathBuf]) -> FsResult<()> {
        let mtm = MainThreadMarker::new().ok_or_else(|| FsError {
            code: "io".into(),
            message: "O arraste precisa começar na thread principal.".into(),
        })?;
        if NSEvent::pressedMouseButtons() & 1 == 0 {
            return Err(gesture_error());
        }
        let ns_window = ns_window(window).ok_or_else(|| FsError {
            code: "io".into(),
            message: "Janela sem NSWindow.".into(),
        })?;
        let view = ns_window.contentView().ok_or_else(|| FsError {
            code: "io".into(),
            message: "Janela sem contentView.".into(),
        })?;
        let event = gesture_event(mtm, ns_window).ok_or_else(gesture_error)?;
        let point = view.convertPoint_fromView(event.locationInWindow(), None);
        let workspace = NSWorkspace::sharedWorkspace();

        let items: Vec<Retained<NSDraggingItem>> = paths
            .iter()
            .enumerate()
            .map(|(index, path)| {
                let text = NSString::from_str(&path.to_string_lossy());
                let url = NSURL::fileURLWithPath(&text);
                let item = NSDraggingItem::initWithPasteboardWriter(
                    NSDraggingItem::alloc(),
                    ProtocolObject::from_ref(&*url),
                );
                let icon = workspace.iconForFile(&text);
                let contents: &AnyObject = &icon;
                // Icone centrado no cursor; varios itens ficam em leque.
                let shift = index as f64 * 6.0;
                let frame = NSRect::new(
                    NSPoint::new(point.x - ICON / 2.0 + shift, point.y - ICON / 2.0 - shift),
                    NSSize::new(ICON, ICON),
                );
                // SAFETY: frame e imagem validos; o item guarda a imagem.
                unsafe { item.setDraggingFrame_contents(frame, Some(contents)) };
                item
            })
            .collect();

        let source = DragSource::new(mtm, window.app_handle().clone());
        let session = view.beginDraggingSessionWithItems_event_source(
            &NSArray::from_retained_slice(&items),
            &event,
            ProtocolObject::from_ref(&*source),
        );
        session.setAnimatesToStartingPositionsOnCancelOrFail(true);
        HELD.with(|held| held.replace(Some(source)));
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod platform {
    use std::path::PathBuf;

    use tauri::WebviewWindow;

    use crate::workspace::files::{FsError, FsResult};

    pub fn begin(_window: &WebviewWindow, _paths: &[PathBuf]) -> FsResult<()> {
        Err(FsError {
            code: "unsupported".into(),
            message: "Arraste nativo só existe no macOS.".into(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_existing_absolute_paths() {
        let dir = std::env::temp_dir().join(format!("oc-dragout-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("um.txt");
        std::fs::write(&file, "1").unwrap();
        let got = existing_paths(&[
            file.to_string_lossy().into_owned(),
            dir.join("nao-existe.txt").to_string_lossy().into_owned(),
            "relativo.txt".into(),
            "com\ncontrole".into(),
            String::new(),
        ])
        .unwrap();
        assert_eq!(got, vec![file.clone()]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn refuses_when_nothing_exists() {
        let error = existing_paths(&["/nao/existe/mesmo.txt".into(), String::new()]).unwrap_err();
        assert_eq!(error.code, "not_found");
    }

    #[test]
    fn names_the_operation_from_the_mask() {
        assert_eq!(operation_name(0), "none");
        assert_eq!(operation_name(1), "copy");
        assert_eq!(operation_name(16), "move");
        assert_eq!(operation_name(1 | 16), "copy");
        assert_eq!(operation_name(2), "link");
        assert_eq!(operation_name(4), "generic");
        assert_eq!(operation_name(32), "delete");
    }
}
