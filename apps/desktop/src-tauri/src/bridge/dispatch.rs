// SPDX-License-Identifier: Apache-2.0
//! Explicit command allowlist; argument parsing never executes Tauri IPC.
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tauri::{
    AppHandle, Manager,
    ipc::{Channel, InvokeResponseBody},
};
use tokio_tungstenite::tungstenite::Message;

use super::{Connection, lock, protocol};
use crate::commands;
use crate::i18n::{t, tf};
use crate::tunnel::{RpcProblem, Supervisor};
use crate::workspace::pty::CursorPosition;
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

pub(super) fn channel(conn: &Connection, args: &Value) -> Result<(u32, Channel), String> {
    let reference: ChannelRef = arg(args, "onOutput")?;
    let id = reference.__channel__;
    let tx = conn.tx.clone();
    let closed = conn.closed.clone();
    let lagged = conn.lagged.clone();
    let channel = Channel::new(move |body| {
        if closed.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(channel_unavailable());
        }
        // Saida maior que um quadro sai em pedacos; a pagina cola os bytes
        // pelo deslocamento. Fila cheia: so este canal sai, com o aviso de
        // atraso que o serve manda, e a conexao continua para o resto.
        let frames: Vec<Message> = match body {
            InvokeResponseBody::Raw(bytes) => bytes
                .chunks(MAX_CHUNK)
                .map(|chunk| Message::Binary(protocol::binary_frame(id, chunk).into()))
                .collect(),
            InvokeResponseBody::Json(message) => vec![Message::Text(
                format!(r#"{{"type":"channel","channel":{id},"message":{message}}}"#).into(),
            )],
        };
        for frame in frames {
            if frame.len() > protocol::MAX_FRAME || tx.try_send(frame).is_err() {
                lock(&lagged).push(id);
                return Err(channel_unavailable());
            }
        }
        Ok(())
    });
    Ok((id, channel))
}

/// Maior pedaco de saida por quadro binario, com folga para o cabecalho.
const MAX_CHUNK: usize = protocol::MAX_FRAME - 64;

fn channel_unavailable() -> tauri::Error {
    tauri::Error::Io(std::io::Error::other(t("native.error.channelUnavailable")))
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

/// Maior texto de QR do Broto que a pagina repassa, em bytes.
const BROTO_QR_MAX_BYTES: usize = 1200;
const BROTO_QR_PREFIX: &str = "CIALAIQ1.";

/// Ligar um Broto pelo QR lido no celular. A pagina so manda o texto lido, o
/// id do pedido e a resposta. Quem pede e o aparelho que a borda provou nesta
/// conexao: um `requester` vindo da pagina nunca chega ao sidecar.
fn broto_qr_request(
    cmd: &str,
    args: &Value,
    device_id: Option<&str>,
) -> Result<(&'static str, Value), String> {
    let requester = || {
        device_id
            .map(str::to_owned)
            .ok_or_else(|| t("native.error.pairedPhoneOnly"))
    };
    match cmd {
        "broto_qr_begin" => {
            let payload: String = arg(args, "payload")?;
            if payload.len() > BROTO_QR_MAX_BYTES || !payload.starts_with(BROTO_QR_PREFIX) {
                return Err(tf("native.error.argumentInvalid", &[("name", &"payload")]));
            }
            Ok((
                "broto.qr.begin",
                json!({"payload": payload, "requester": requester()?}),
            ))
        }
        "broto_qr_state" => Ok(("broto.qr.state", json!({"qrId": broto_qr_id(args)?}))),
        "broto_qr_decide" => {
            let qr_id = broto_qr_id(args)?;
            let approve: bool = arg(args, "approve")?;
            Ok((
                "broto.qr.decide",
                json!({"qrId": qr_id, "approve": approve, "requester": requester()?}),
            ))
        }
        _ => Err(t("native.error.desktopOnly")),
    }
}

/// Id do pedido: `q_` e de 1 a 64 letras, digitos, `_` ou `-`.
fn broto_qr_id(args: &Value) -> Result<String, String> {
    let id: String = arg(args, "qrId")?;
    let valid = id.strip_prefix("q_").is_some_and(|rest| {
        (1..=64).contains(&rest.len())
            && rest
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    });
    if valid {
        Ok(id)
    } else {
        Err(tf("native.error.argumentInvalid", &[("name", &"qrId")]))
    }
}

/// O celular traduz o codigo estavel do sidecar. Um erro generico cujo texto
/// traz um codigo de QR vale por esse codigo.
fn broto_qr_error(problem: RpcProblem) -> String {
    if problem.code.starts_with("qr_") {
        return problem.code;
    }
    problem
        .message
        .split(|ch: char| !(ch.is_ascii_lowercase() || ch == '_'))
        .find(|word| word.len() > 3 && word.starts_with("qr_"))
        .map_or(problem.code, str::to_owned)
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
                // `have` e opcional: paginas antigas nao mandam e recebem o
                // historico inteiro, como antes.
                let have: Option<u64> = arg(&args, "have")?;
                terminals.resume_for(id, conn.key(), channel, have)?
            } else {
                let cwd: String = arg(&args, "cwd")?;
                let tag: Option<String> = arg(&args, "tag")?;
                terminals.spawn_for(
                    &cwd,
                    arg(&args, "cols")?,
                    arg(&args, "rows")?,
                    CursorPosition::from_client(arg(&args, "cursorRow")?, arg(&args, "cursorCol")?),
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
        "ai_usage" => value(commands::ai_usage(app.clone(), app.state(), app.state())),
        "pty_write" => {
            let data: String = arg(&args, "data")?;
            let binary: Option<bool> = arg(&args, "binary")?;
            let bytes = if binary.unwrap_or(false) {
                commands::binary_bytes(&data)?
            } else {
                data.into_bytes()
            };
            app.state::<TerminalManager>()
                .write_as(arg(&args, "id")?, &bytes, "phone")?;
            Ok(Value::Null)
        }
        "pty_kill" => {
            let id = arg(&args, "id")?;
            app.state::<TerminalManager>().kill_as(id, "phone")?;
            lock(&conn.bindings).remove(&id);
            Ok(Value::Null)
        }
        "list_repo_dirs" => value(commands::list_repo_dirs(app.clone(), app.state())?),
        // A apresentacao e do card, nao do processo: renomear ou mudar a cor
        // pelo celular nao toca em nada que esteja rodando.
        // Navegacao de pastas: o servidor decide os limites, e o cliente so
        // pede um caminho absoluto que precisa cair dentro deles.
        "list_dirs" => value(commands::list_dirs(
            app.clone(),
            app.state(),
            arg(&args, "path")?,
        )?),
        // Contas dos agentes. Nenhum caminho de credencial trafega: o cliente
        // manda o id do perfil e o servidor resolve o resto.
        "agent_profiles" => value(commands::agent_profiles(
            app.clone(),
            app.state(),
            app.state(),
        )?),
        "agent_profiles_refresh" => {
            commands::agent_profiles_refresh(app.state());
            value(serde_json::Value::Null)
        }
        "agent_profile_select" => value(commands::agent_profile_select(
            app.clone(),
            app.state(),
            arg(&args, "agent")?,
            arg(&args, "id")?,
        )?),
        "agent_profile_create" => value(commands::agent_profile_create(
            app.clone(),
            arg(&args, "agent")?,
            arg(&args, "name")?,
        )?),
        "pty_launch_agent" => value(commands::pty_launch_agent(
            app.state(),
            arg(&args, "id")?,
            arg(&args, "agent")?,
            arg(&args, "profile")?,
            arg(&args, "login")?,
        )?),
        "pty_presentation" => value(commands::pty_presentation(
            app.state(),
            arg(&args, "id")?,
            arg(&args, "presentation")?,
        )?),
        // Cada chamada e curta: o prazo do sidecar e de 30 s e estourar reinicia
        // o processo, entao a pagina pergunta o estado de novo em vez de esperar.
        "broto_qr_begin" | "broto_qr_state" | "broto_qr_decide" => {
            let (command, request) = broto_qr_request(cmd, &args, conn.device_id.as_deref())?;
            app.try_state::<Supervisor>()
                .ok_or("network_setup")?
                .call(command, request)
                .map_err(broto_qr_error)
        }
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

    #[test]
    fn broto_qr_requests_name_the_connection_device_and_never_the_page_requester() {
        let payload = format!("CIALAIQ1.{}", "A".repeat(32));
        let page = |cmd: &str, args: Value| broto_qr_request(cmd, &args, Some("dev_phone"));
        assert_eq!(
            page(
                "broto_qr_begin",
                json!({"payload": payload, "requester": "dev_page"})
            )
            .unwrap(),
            (
                "broto.qr.begin",
                json!({"payload": payload, "requester": "dev_phone"})
            )
        );
        assert_eq!(
            page(
                "broto_qr_state",
                json!({"qrId": "q_AbC-1_x", "requester": "dev_page"})
            )
            .unwrap(),
            ("broto.qr.state", json!({"qrId": "q_AbC-1_x"}))
        );
        assert_eq!(
            page(
                "broto_qr_decide",
                json!({"qrId": "q_AbC-1_x", "approve": true, "requester": "dev_page"})
            )
            .unwrap(),
            (
                "broto.qr.decide",
                json!({"qrId": "q_AbC-1_x", "approve": true, "requester": "dev_phone"})
            )
        );
        // Sem o aparelho provado pela borda, nada comeca nem e respondido.
        assert!(broto_qr_request("broto_qr_begin", &json!({"payload": payload}), None).is_err());
        assert!(
            broto_qr_request(
                "broto_qr_decide",
                &json!({"qrId": "q_x", "approve": false}),
                None
            )
            .is_err()
        );
        assert!(broto_qr_request("broto_qr_state", &json!({"qrId": "q_x"}), None).is_ok());
        assert!(page("pty_list", json!({})).is_err());
    }

    #[test]
    fn broto_qr_arguments_are_bounded_before_reaching_the_sidecar() {
        let begin = |payload: Value| {
            broto_qr_request(
                "broto_qr_begin",
                &json!({"payload": payload}),
                Some("dev_phone"),
            )
        };
        let longest = format!("CIALAIQ1.{}", "A".repeat(BROTO_QR_MAX_BYTES - 9));
        assert_eq!(longest.len(), BROTO_QR_MAX_BYTES);
        assert!(begin(json!(longest)).is_ok());
        assert!(begin(json!(format!("{longest}A"))).is_err());
        for bad in [
            json!("CIALAIB2.abc"),
            json!("cialaiq1.abc"),
            json!(" CIALAIQ1.abc"),
            json!(42),
            json!(null),
        ] {
            assert!(begin(bad.clone()).is_err(), "{bad}");
        }
        let state =
            |id: Value| broto_qr_request("broto_qr_state", &json!({"qrId": id}), Some("dev_phone"));
        assert!(state(json!(format!("q_{}", "a".repeat(64)))).is_ok());
        for bad in [
            json!("q_"),
            json!(format!("q_{}", "a".repeat(65))),
            json!("x_abc"),
            json!("q_ab/c"),
            json!("q_ab c"),
            json!("q_\u{e1}bc"),
            json!(7),
        ] {
            assert!(state(bad.clone()).is_err(), "{bad}");
        }
        let decide = |approve: Value| {
            broto_qr_request(
                "broto_qr_decide",
                &json!({"qrId": "q_abc", "approve": approve}),
                Some("dev_phone"),
            )
        };
        assert!(decide(json!(false)).is_ok());
        for bad in [json!("true"), json!(1), json!(null)] {
            assert!(decide(bad.clone()).is_err(), "{bad}");
        }
    }

    #[test]
    fn sidecar_qr_failures_reach_the_phone_as_stable_codes() {
        let problem = |code: &str, message: &str| RpcProblem {
            code: code.into(),
            message: message.into(),
            retryable: false,
        };
        assert_eq!(
            broto_qr_error(problem("qr_expired", "O QR expirou.")),
            "qr_expired"
        );
        assert_eq!(
            broto_qr_error(problem("internal", "qr_used: o QR ja foi usado")),
            "qr_used"
        );
        assert_eq!(
            broto_qr_error(problem(
                "command_unknown",
                "O comando solicitado não existe neste sidecar."
            )),
            "command_unknown"
        );
        assert_eq!(
            broto_qr_error(problem("tunnel_timeout", "O túnel não respondeu.")),
            "tunnel_timeout"
        );
    }
}
