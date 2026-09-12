// SPDX-License-Identifier: Apache-2.0
use super::{Registry, lock};
use tauri::{AppHandle, EventId, Listener};
use tokio_tungstenite::tungstenite::Message;

const EVENTS: &[&str] = &["pty://exit", "pty://view", "browser://exit"];

pub(super) struct Forwarders {
    app: AppHandle,
    ids: Vec<EventId>,
}

impl Drop for Forwarders {
    fn drop(&mut self) {
        for id in &self.ids {
            self.app.unlisten(*id);
        }
    }
}

pub(super) fn forward(app: AppHandle, registry: Registry) -> Forwarders {
    let ids = EVENTS
        .iter()
        .map(|&name| {
            let registry = registry.clone();
            app.listen_any(name, move |event| {
                let frame = format!(
                    r#"{{"type":"event","name":"{name}","payload":{}}}"#,
                    event.payload()
                );
                let targets: Vec<_> = lock(&registry).values().cloned().collect();
                for conn in targets {
                    let _ = conn.send(Message::Text(frame.clone().into()));
                }
            })
        })
        .collect();
    Forwarders { app, ids }
}
