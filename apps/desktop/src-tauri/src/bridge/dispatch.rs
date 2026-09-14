// SPDX-License-Identifier: Apache-2.0
//! Explicit command allowlist; argument parsing never executes Tauri IPC.
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use tauri::{
    AppHandle, Manager,
    ipc::{Channel, InvokeResponseBody},
};
use tokio_tungstenite::tungstenite::Message;

use super::{Connection, lock, protocol};
use crate::commands;
use crate::i18n::{t, tf};
use crate::workspace::terminal::TerminalManager;

fn arg<T: DeserializeOwned>(args: &Value, name: &str) -> Result<T, String> {
    serde_json::from_value(args.get(name).cloned().unwrap_or(Value::Null))
        .map_err(|_| tf("native.error.argumentInvalid", &[("name", &name)]))
}

fn value<T: Serialize>(result: T) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|_| t("native.error.responseEncoding"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ChannelRef {
    __channel__: u32,
}

fn channel(conn: &Connection, args: &Value) -> Result<(u32, Channel), String> {
    let reference: ChannelRef = arg(args, "onOutput")?;
    let id = reference.__channel__;
    let tx = conn.tx.clone();
    let closed = conn.closed.clone();
    let stop = conn.stop.clone();
    let channel = Channel::new(move |body| {
        let frame = match body {
            InvokeResponseBody::Raw(bytes) => {
                Message::Binary(protocol::binary_frame(id, &bytes).into())
            }
            InvokeResponseBody::Json(message) => Message::Text(
                format!(r#"{{"type":"channel","channel":{id},"message":{message}}}"#).into(),
            ),
        };
        if closed.load(std::sync::atomic::Ordering::SeqCst)
            || frame.len() > protocol::MAX_FRAME
            || tx.try_send(frame).is_err()
        {
            closed.store(true, std::sync::atomic::Ordering::SeqCst);
            stop.notify_one();
            return Err(tauri::Error::Io(std::io::Error::other(t(
                "native.error.channelUnavailable",
            ))));
        }
        Ok(())
    });
    Ok((id, channel))
}

fn prepare_binding(
    bindings: &mut std::collections::HashMap<u32, u32>,
    channel_id: u32,
    attaching: Option<u32>,
    mut is_active: impl FnMut(u32) -> bool,
) -> Result<(), String> {
    // Exit, desktop kill and lag eviction all remove the actual subscriber.
    // Release stale capacity before checking channel ownership as well.
    bindings.retain(|&session, _| is_active(session));
    if bindings
        .iter()
        .any(|(&session, &bound)| bound == channel_id && Some(session) != attaching)
    {
        return Err(t("native.error.channelOwned"));
    }
    if bindings.len() >= 128 && !attaching.is_some_and(|id| bindings.contains_key(&id)) {
        return Err(t("native.error.channelLimit"));
    }
    Ok(())
}

pub(super) fn dispatch(
    app: &AppHandle,
    conn: &Connection,
    cmd: &str,
    args: Value,
) -> Result<Value, String> {
    if !protocol::allowed_command(cmd) {
        return Err(t("native.error.desktopOnly"));
    }
    match cmd {
        "pty_spawn" | "pty_attach" => {
            let terminals = app.state::<TerminalManager>();
            let mut bindings = lock(&conn.bindings);
            if conn.closed.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(t("native.error.bridgeDisconnected"));
            }
            let (channel_id, channel) = channel(conn, &args)?;
            let attaching: Option<u32> = if cmd == "pty_attach" {
                Some(arg(&args, "id")?)
            } else {
                None
            };
            prepare_binding(&mut bindings, channel_id, attaching, |id| {
                terminals.has_subscriber(id, conn.key())
            })?;
            let info = if let Some(id) = attaching {
                terminals.attach_for(id, conn.key(), channel)?
            } else {
                let cwd: String = arg(&args, "cwd")?;
                let tag: Option<String> = arg(&args, "tag")?;
                terminals.spawn_for(
                    &cwd,
                    arg(&args, "cols")?,
                    arg(&args, "rows")?,
                    tag.as_deref().unwrap_or(""),
                    conn.key(),
                    channel,
                )?
            };
            bindings.insert(info.id, channel_id);
            if conn.closed.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = terminals.detach(info.id, conn.key());
            }
            value(info)
        }
        "pty_ack" => {
            let id = arg(&args, "id")?;
            let channel: Option<u32> = arg(&args, "channel")?;
            let bytes: usize = arg(&args, "bytes")?;
            let bindings = lock(&conn.bindings);
            if bindings
                .get(&id)
                .is_some_and(|current| channel.is_none_or(|channel| *current == channel))
            {
                app.state::<TerminalManager>()
                    .ack_for(id, conn.key(), bytes)?;
            }
            Ok(Value::Null)
        }
        "pty_list" => value(commands::pty_list(app.state())),
        "pty_view_claim" | "pty_view_renew" | "pty_view_release" => {
            let terminals = app.state::<TerminalManager>();
            let id = arg(&args, "id")?;
            let result = match cmd {
                "pty_view_claim" => {
                    terminals.view_claim(id, conn.key(), arg(&args, "cols")?, arg(&args, "rows")?)
                }
                "pty_view_renew" => terminals.view_renew(
                    id,
                    conn.key(),
                    arg(&args, "leaseId")?,
                    arg(&args, "cols")?,
                    arg(&args, "rows")?,
                ),
                _ => terminals.view_release(id, conn.key(), arg(&args, "leaseId")?),
            };
            if conn.closed.load(std::sync::atomic::Ordering::SeqCst) {
                terminals.detach_all(conn.key());
            }
            value(result?)
        }
        "pty_files_list" | "pty_file_read" => {
            let terminals = app.state::<TerminalManager>();
            let id = arg(&args, "id")?;
            let cwd = terminals.subscribed_cwd(id, conn.key())?;
            let home = app
                .path()
                .home_dir()
                .map_err(|_| t("native.error.projectsUnavailable"))?;
            let project_roots = app.state::<crate::prefs::PrefsState>().get().project_roots;
            let path: String = if cmd == "pty_files_list" {
                arg::<Option<String>>(&args, "path")?.unwrap_or_default()
            } else {
                arg(&args, "path")?
            };
            let result = if cmd == "pty_files_list" {
                value(crate::workspace::mobile_files::list(
                    &home,
                    &project_roots,
                    std::path::Path::new(&cwd),
                    &path,
                )?)
            } else {
                value(crate::workspace::mobile_files::read(
                    &home,
                    &project_roots,
                    std::path::Path::new(&cwd),
                    &path,
                )?)
            };
            // A read may finish after a disconnect or lag eviction.
            terminals.subscribed_cwd(id, conn.key())?;
            result
        }
        "pty_metrics" => value(commands::pty_metrics(app.state())),
        "ai_usage" => value(commands::ai_usage(app.clone(), app.state())),
        "pty_write" => value(commands::pty_write(
            app.state(),
            arg(&args, "id")?,
            arg(&args, "data")?,
            arg(&args, "binary")?,
        )?),
        "pty_kill" => {
            let id = arg(&args, "id")?;
            commands::pty_kill(app.state(), id)?;
            lock(&conn.bindings).remove(&id);
            Ok(Value::Null)
        }
        "list_repo_dirs" => value(commands::list_repo_dirs(app.clone(), app.state())?),
        _ => Err(t("native.error.desktopOnly")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn expired_bindings_do_not_exhaust_capacity_or_keep_old_channel_ownership() {
        let mut bindings = (1..=128).map(|id| (id, id)).collect();
        assert!(prepare_binding(&mut bindings, 1, None, |id| id == 128).is_ok());
        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings.get(&128), Some(&128));
        bindings.insert(129, 1);
        assert!(prepare_binding(&mut bindings, 1, Some(130), |_| false).is_ok());
        assert!(bindings.is_empty());
    }

    #[test]
    fn active_bindings_keep_the_capacity_limit_but_allow_same_session_reattach() {
        let mut bindings = (1..=128).map(|id| (id, id)).collect();
        assert!(prepare_binding(&mut bindings, 129, None, |_| true).is_err());
        assert!(prepare_binding(&mut bindings, 129, Some(128), |_| true).is_ok());
        assert!(prepare_binding(&mut bindings, 127, Some(128), |_| true).is_err());
        assert_eq!(bindings.len(), 128);
    }
    #[test]
    fn channel_reference_and_numeric_args_reject_wrong_types() {
        assert!(arg::<u32>(&json!({"id":-1}), "id").is_err());
        assert!(arg::<u32>(&json!({"id":"3"}), "id").is_err());
        assert!(
            arg::<ChannelRef>(
                &json!({"onOutput":{"__channel__":4294967296u64}}),
                "onOutput"
            )
            .is_err()
        );
        assert_eq!(arg::<Option<bool>>(&json!({}), "binary").unwrap(), None);
        assert_eq!(
            arg::<ChannelRef>(&json!({"onOutput":{"__channel__":5}}), "onOutput")
                .unwrap()
                .__channel__,
            5
        );
    }
}
