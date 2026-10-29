// SPDX-License-Identifier: Apache-2.0
//! Broto PTYs reuse the desktop output ring and subscriber flow control.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};

pub(super) const FIRST_ID: u32 = 0x8000_0000;
struct RemoteSession {
    remote: u32,
    calls: HashSet<u64>,
    last_was_cr: bool,
    info: TerminalInfo,
    link: Arc<OutputLink>,
    polling: bool,
    owner: SubscriberKey,
}
// Exec pipes do not perform the terminal driver's LF to CRLF conversion.
fn terminal_lines(bytes: &[u8], last_was_cr: &mut bool) -> Vec<u8> {
    let mut output = Vec::with_capacity(bytes.len());
    for &byte in bytes {
        if byte == b'\n' && !*last_was_cr {
            output.push(b'\r');
        }
        output.push(byte);
        *last_was_cr = byte == b'\r';
    }
    output
}
fn command_line(data: &Value) -> String {
    let command = data["command"].as_str().unwrap_or("");
    let args: Vec<&str> = data["args"]
        .as_array()
        .map(|items| items.iter().filter_map(Value::as_str).collect())
        .unwrap_or_default();
    if args.len() == 2 && args[0] == "-lc" {
        return args[1].into();
    }
    let program = command.rsplit(['/', '\\']).next().unwrap_or(command);
    if ["powershell.exe", "powershell", "pwsh.exe", "pwsh"]
        .iter()
        .any(|name| program.eq_ignore_ascii_case(name))
        && args.len() == 4
        && args[..3] == ["-NoProfile", "-NonInteractive", "-Command"]
    {
        return args[3].into();
    }
    std::iter::once(command)
        .chain(args)
        .collect::<Vec<_>>()
        .join(" ")
}
type RpcCall = dyn Fn(&str, Value) -> Result<Value, String> + Send + Sync;
pub(super) struct BrotoTerminals {
    rpc_call: Arc<RpcCall>,
    notify_exit: ExitNotifier,
    sessions: Mutex<HashMap<u32, RemoteSession>>,
}
impl BrotoTerminals {
    pub(super) fn new(app: AppHandle) -> Arc<Self> {
        let rpc_app = app.clone();
        Arc::new(Self {
            rpc_call: Arc::new(move |cmd, args| {
                rpc_app
                    .try_state::<crate::tunnel::Supervisor>()
                    .ok_or("broto_unavailable")?
                    .call(cmd, args)
                    .map_err(|error| error.message)
            }),
            notify_exit: Arc::new(move |exit| {
                let _ = app.emit(EVENT_PTY_EXIT, exit);
            }),
            sessions: Mutex::new(HashMap::new()),
        })
    }
    pub(super) fn event(&self, name: &str, data: &Value) {
        if name == "tunnel.state" && data["state"].as_str() != Some("running") {
            for session in lock(&self.sessions).values_mut() {
                session.calls.clear();
            }
            return;
        }
        let Some(device) = data["deviceId"].as_str() else {
            return;
        };
        if name == "devices.changed" && data["revoked"].as_bool() == Some(true) {
            lock(&self.sessions).retain(|_, session| {
                let keep = session.info.device_id.as_deref() != Some(device);
                if !keep {
                    session.link.close();
                }
                keep
            });
            return;
        }
        if name == "devices.changed" {
            if let Some(name) = data["name"].as_str() {
                for session in lock(&self.sessions)
                    .values_mut()
                    .filter(|s| s.info.device_id.as_deref() == Some(device))
                {
                    session.info.broto_name = Some(name.into());
                }
            }
        }
        if !name.starts_with("broto.exec.") {
            return;
        }
        let mut sessions = lock(&self.sessions);
        let id = sessions
            .iter()
            .find(|(_, s)| s.remote == 0 && s.info.device_id.as_deref() == Some(device))
            .map(|(id, _)| *id)
            .unwrap_or_else(|| {
                sessions
                    .keys()
                    .max()
                    .map_or(FIRST_ID, |id| id.saturating_add(1))
            });
        let session = sessions.entry(id).or_insert_with(|| {
            let link = Arc::new(OutputLink::new(Channel::new(|_| Ok(()))));
            link.detach(SubscriberKey::Webview);
            RemoteSession {
                remote: 0,
                calls: HashSet::new(),
                last_was_cr: false,
                polling: false,
                owner: SubscriberKey::Webview,
                link,
                info: TerminalInfo {
                    id,
                    tag: format!("broto:{device}:ia"),
                    cwd: String::new(),
                    shell: "broto-ai".into(),
                    shell_flavor: platform::default_shell(&Preferences::default()).flavor,
                    pid: None,
                    alive: true,
                    exit_code: None,
                    cols: 80,
                    rows: 24,
                    view: Some(TerminalView {
                        id,
                        cols: 80,
                        rows: 24,
                        owner: "local".into(),
                        lease_id: 1,
                        revision: 1,
                    }),
                    presentation: None,
                    device_id: Some(device.into()),
                    broto_name: data["brotoName"].as_str().map(str::to_owned),
                },
            }
        });
        let call = data["callId"].as_u64().unwrap_or(0);
        let bytes = match name {
            "broto.exec.queued" => {
                session.info.alive = true;
                Vec::new()
            }
            "broto.exec.started" => {
                session.info.alive = true;
                session.calls.insert(call);
                let command = command_line(data);
                format!("$ {command}\r\n").into_bytes()
            }
            "broto.exec.output" => STANDARD
                .decode(data["data"].as_str().unwrap_or(""))
                .unwrap_or_default(),
            "broto.exec.finished" => {
                session.calls.remove(&call);
                let summary = if let Some(error) = data["error"].as_str() {
                    crate::i18n::tf("native.broto.execFailed", &[("error", &error)])
                } else if data["timed_out"].as_bool() == Some(true) {
                    t("native.broto.execTimedOut")
                } else {
                    let code = data["exit_code"].as_i64().unwrap_or(-1);
                    let millis = data["duration_ms"].as_u64().unwrap_or(0);
                    let duration = if millis % 1000 == 0 {
                        (millis / 1000).to_string()
                    } else {
                        format!("{:.1}", millis as f64 / 1000.0)
                    };
                    crate::i18n::tf(
                        "native.broto.execFinished",
                        &[("code", &code), ("duration", &duration)],
                    )
                };
                format!("\r\n[{summary}]\r\n").into_bytes()
            }
            _ => Vec::new(),
        };
        let bytes = terminal_lines(&bytes, &mut session.last_was_cr);
        session.link.send(InvokeResponseBody::Raw(bytes));
    }
    fn rpc(&self, cmd: &str, args: Value) -> Result<Value, String> {
        (self.rpc_call)(cmd, args)
    }
    pub(super) fn list(&self) -> Vec<TerminalInfo> {
        if let Ok(Value::Array(items)) = self.rpc("broto.sessions", json!({})) {
            let mut sessions = lock(&self.sessions);
            let mut seen = HashSet::new();
            for item in items {
                let Some(remote) = item["id"].as_u64().and_then(|id| u32::try_from(id).ok()) else {
                    continue;
                };
                let Some(device) = item["deviceId"].as_str() else {
                    continue;
                };
                let existing = sessions
                    .iter()
                    .find(|(_, value)| {
                        value.remote == remote && value.info.device_id.as_deref() == Some(device)
                    })
                    .map(|(id, _)| *id);
                let id = existing.unwrap_or_else(|| {
                    sessions
                        .keys()
                        .max()
                        .map_or(FIRST_ID, |id| id.saturating_add(1))
                });
                seen.insert(id);
                if let Some(session) = sessions.get_mut(&id) {
                    session.info.alive = !item["exited"].as_bool().unwrap_or(false);
                    session.info.broto_name = item["brotoName"].as_str().map(str::to_owned);
                    continue;
                }
                let link = Arc::new(OutputLink::new(Channel::new(|_| Ok(()))));
                link.detach(SubscriberKey::Webview);
                sessions.insert(
                    id,
                    RemoteSession {
                        remote,
                        calls: HashSet::new(),
                        last_was_cr: false,
                        polling: false,
                        owner: SubscriberKey::Webview,
                        link,
                        info: TerminalInfo {
                            id,
                            tag: format!("broto:{device}:{remote}"),
                            cwd: item["dir"].as_str().unwrap_or("").into(),
                            shell: "broto".into(),
                            shell_flavor: platform::default_shell(&Preferences::default()).flavor,
                            pid: None,
                            alive: !item["exited"].as_bool().unwrap_or(false),
                            exit_code: None,
                            cols: 80,
                            rows: 24,
                            view: Some(TerminalView {
                                id,
                                cols: 80,
                                rows: 24,
                                owner: "local".into(),
                                lease_id: 1,
                                revision: 1,
                            }),
                            presentation: None,
                            device_id: Some(device.into()),
                            broto_name: item["brotoName"].as_str().map(str::to_owned),
                        },
                    },
                );
            }
            // Keep IDs and rings stable across temporary disconnections.
            for (id, session) in sessions.iter_mut() {
                if session.remote != 0 && !seen.contains(id) {
                    session.info.alive = false;
                }
            }
        }
        lock(&self.sessions)
            .values()
            .filter(|session| session.info.alive)
            .map(|session| session.info.clone())
            .collect()
    }
    pub(super) fn output(
        self: &Arc<Self>,
        id: u32,
    ) -> Result<(Arc<OutputLink>, TerminalInfo), String> {
        let (link, info, start) = {
            let mut guard = lock(&self.sessions);
            let session = guard.get_mut(&id).ok_or_else(closed_error)?;
            let start = !session.polling && session.remote != 0;
            session.polling = true;
            (session.link.clone(), session.info.clone(), start)
        };
        if start {
            let this = self.clone();
            thread::spawn(move || this.poll(id));
        }
        Ok((link, info))
    }
    fn call(&self, id: u32, cmd: &str, args: Value) -> Result<Value, String> {
        self.call_as(id, cmd, args, "human")
    }
    fn call_as(&self, id: u32, cmd: &str, mut args: Value, actor: &str) -> Result<Value, String> {
        let (device, remote) = {
            let guard = lock(&self.sessions);
            let session = guard.get(&id).ok_or_else(closed_error)?;
            (session.info.device_id.clone(), session.remote)
        };
        if remote == 0 {
            if cmd == "pty.kill" {
                if let Some(session) = lock(&self.sessions).get_mut(&id) {
                    session.info.alive = false;
                    let subscribers: Vec<_> = lock(&session.link.state)
                        .subscribers
                        .keys()
                        .copied()
                        .collect();
                    for key in subscribers {
                        session.link.detach(key);
                    }
                }
                return Ok(Value::Null);
            }
            if cmd == "pty.resize" {
                return Ok(Value::Null);
            }
            if cmd == "pty.write" {
                let bytes = STANDARD
                    .decode(args["data"].as_str().unwrap_or(""))
                    .unwrap_or_default();
                if !bytes.contains(&3) {
                    return Ok(Value::Null);
                }
            }
            if cmd == "pty.write" {
                let calls: Vec<u64> = lock(&self.sessions)
                    .get(&id)
                    .map(|s| s.calls.iter().copied().collect())
                    .unwrap_or_default();
                for call in calls {
                    self.rpc("broto.call", json!({"deviceId":device,"cmd":"exec.cancel","args":{"call_id":call},"actor":actor}))?;
                }
                return Ok(Value::Null);
            }
            return Err("broto_read_only".into());
        }
        args["id"] = json!(remote);
        self.rpc(
            "broto.call",
            json!({"deviceId":device,"cmd":cmd,"args":args,"actor":actor}),
        )
    }
    fn poll(self: Arc<Self>, id: u32) {
        let mut offset = 0u64;
        loop {
            let Ok((link, _)) = self.output_existing(id) else {
                return;
            };
            if link.closed.load(Ordering::SeqCst) {
                return;
            }
            match self.call(id, "pty.read", json!({"offset":offset})) {
                Ok(result) => {
                    let data = STANDARD
                        .decode(result["data"].as_str().unwrap_or(""))
                        .unwrap_or_default();
                    if !data.is_empty() {
                        if !link.wait_for_room(data.len()) {
                            return;
                        }
                        link.send(InvokeResponseBody::Raw(data));
                    }
                    offset = result["next_offset"].as_u64().unwrap_or(offset);
                    let total_offset = result["total_offset"].as_u64().unwrap_or(offset);
                    if result["exited"].as_bool().unwrap_or(false) && offset >= total_offset {
                        let code = result["exit_code"].as_i64().unwrap_or(0) as i32;
                        link.send(InvokeResponseBody::Json(
                            json!({"type":"exit","code":code}).to_string(),
                        ));
                        link.close();
                        if let Some(session) = lock(&self.sessions).get_mut(&id) {
                            session.info.alive = false;
                            session.info.exit_code = Some(code);
                        }
                        (self.notify_exit)(TerminalExit {
                            id,
                            code,
                            signal: None,
                            early: false,
                        });
                        return;
                    }
                }
                Err(_) => { /* Connection recovery keeps the same offset and ring. */ }
            }
            thread::sleep(Duration::from_millis(100));
        }
    }
    fn output_existing(&self, id: u32) -> Result<(Arc<OutputLink>, TerminalInfo), String> {
        let guard = lock(&self.sessions);
        let session = guard.get(&id).ok_or_else(closed_error)?;
        Ok((session.link.clone(), session.info.clone()))
    }
    pub(super) fn write(&self, id: u32, data: &[u8]) -> Result<(), String> {
        self.call(id, "pty.write", json!({"data":STANDARD.encode(data)}))
            .map(|_| ())
    }
    pub(super) fn write_as(&self, id: u32, data: &[u8], actor: &str) -> Result<(), String> {
        self.call_as(
            id,
            "pty.write",
            json!({"data":STANDARD.encode(data)}),
            actor,
        )
        .map(|_| ())
    }
    pub(super) fn kill_as(&self, id: u32, actor: &str) -> Result<(), String> {
        self.call_as(id, "pty.kill", json!({}), actor).map(|_| ())
    }
    pub(super) fn kill(&self, id: u32) -> Result<(), String> {
        self.call(id, "pty.kill", json!({})).map(|_| ())
    }
    pub(super) fn view(
        &self,
        id: u32,
        key: SubscriberKey,
        cols: u16,
        rows: u16,
        claim: bool,
        lease: Option<u64>,
    ) -> Result<TerminalView, String> {
        validate_view_size(cols, rows)?;
        {
            let guard = lock(&self.sessions);
            let session = guard.get(&id).ok_or_else(closed_error)?;
            let view = session.info.view.as_ref().ok_or_else(closed_error)?;
            if !lock(&session.link.state).subscribers.contains_key(&key) {
                return Err(t("native.error.subscribeBeforeControl"));
            }
            if lease.is_some_and(|lease| lease != view.lease_id || session.owner != key) {
                return Err(t("native.error.controlExpired"));
            }
        }
        let resize = {
            let guard = lock(&self.sessions);
            let session = guard.get(&id).ok_or_else(closed_error)?;
            (session.info.cols, session.info.rows) != (cols, rows)
        };
        if resize {
            self.call(id, "pty.resize", json!({"cols":cols,"rows":rows}))?;
        }
        let mut guard = lock(&self.sessions);
        let session = guard.get_mut(&id).ok_or_else(closed_error)?;
        session.owner = key;
        let view = session.info.view.as_mut().ok_or_else(closed_error)?;
        view.cols = cols;
        view.rows = rows;
        view.revision += 1;
        if claim {
            view.lease_id += 1;
        }
        view.owner = match key {
            SubscriberKey::Webview => "local".into(),
            _ => "remote".into(),
        };
        session.info.cols = cols;
        session.info.rows = rows;
        Ok(view.clone())
    }
    pub(super) fn release(
        &self,
        id: u32,
        key: SubscriberKey,
        lease: u64,
    ) -> Result<TerminalView, String> {
        let mut guard = lock(&self.sessions);
        let session = guard.get_mut(&id).ok_or_else(closed_error)?;
        let view = session.info.view.as_mut().ok_or_else(closed_error)?;
        if view.lease_id != lease || session.owner != key {
            return Err(t("native.error.controlExpired"));
        }
        session.owner = SubscriberKey::Webview;
        view.owner = "local".into();
        view.lease_id += 1;
        view.revision += 1;
        Ok(view.clone())
    }
    pub(super) fn presentation(
        &self,
        id: u32,
        mut presentation: TerminalPresentation,
    ) -> Result<u64, String> {
        let mut guard = lock(&self.sessions);
        let session = guard.get_mut(&id).ok_or_else(closed_error)?;
        presentation.revision = session
            .info
            .presentation
            .as_ref()
            .map_or(1, |value| value.revision + 1);
        let revision = presentation.revision;
        session.info.presentation = Some(presentation);
        Ok(revision)
    }
    pub(super) fn detach_all(&self, key: SubscriberKey) {
        for session in lock(&self.sessions).values() {
            session.link.detach(key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Arc<BrotoTerminals>, Arc<Mutex<Vec<Value>>>) {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let manager = Arc::new(BrotoTerminals {
            sessions: Mutex::new(HashMap::new()),
            notify_exit: Arc::new(|_| {}),
            rpc_call: Arc::new(move |cmd, args| {
                if cmd == "broto.sessions" {
                    Ok(json!([
                        {"deviceId":"alpha","brotoName":"Alpha","id":1,"dir":"/remote/alpha"},
                        {"deviceId":"beta","brotoName":"Beta","id":1,"dir":"/remote/beta"}
                    ]))
                } else {
                    lock(&recorded).push(args);
                    Ok(Value::Null)
                }
            }),
        });
        (manager, calls)
    }
    fn ai_output(manager: &BrotoTerminals) -> (u32, String) {
        let sessions = lock(&manager.sessions);
        let (id, session) = sessions.iter().find(|(_, s)| s.remote == 0).unwrap();
        let bytes: Vec<u8> = lock(&session.link.state).history.iter().copied().collect();
        (*id, String::from_utf8(bytes).unwrap())
    }
    #[test]
    fn closing_ai_card_hides_without_cancelling_and_next_command_reopens() {
        let (manager, calls) = fixture();
        manager.event(
            "broto.exec.started",
            &json!({"deviceId":"alpha","callId":1,"command":"sleep","args":["10"]}),
        );
        let (id, _) = ai_output(&manager);
        manager.kill(id).unwrap();
        assert!(
            lock(&calls).is_empty(),
            "closing the card must not cancel exec"
        );
        assert!(!manager.list().iter().any(|info| info.id == id));
        manager.event(
            "broto.exec.output",
            &json!({"deviceId":"alpha","callId":1,"data":STANDARD.encode(b"still running\n")}),
        );
        assert!(!manager.list().iter().any(|info| info.id == id));
        manager.event(
            "broto.exec.started",
            &json!({"deviceId":"alpha","callId":2,"command":"next"}),
        );
        assert!(manager.list().iter().any(|info| info.id == id));
        manager.write(id, b"\x03").unwrap();
        assert_eq!(lock(&calls).len(), 2, "Ctrl C still cancels active calls");
    }
    #[test]
    fn ai_output_normalizes_lf_without_doubling_crlf_across_frames() {
        let (manager, _) = fixture();
        manager.event(
            "broto.exec.started",
            &json!({"deviceId":"alpha","callId":1,"command":"test"}),
        );
        for bytes in [b"one\ntwo\r".as_slice(), b"\nthree\n".as_slice()] {
            manager.event(
                "broto.exec.output",
                &json!({"deviceId":"alpha","callId":1,"data":STANDARD.encode(bytes)}),
            );
        }
        assert!(ai_output(&manager).1.ends_with("one\r\ntwo\r\nthree\r\n"));
    }
    #[test]
    fn ai_card_shows_original_shell_line_and_seconds() {
        let (manager, _) = fixture();
        manager.event("broto.exec.started", &json!({"deviceId":"alpha","callId":1,"command":"powershell.exe","args":["-NoProfile","-NonInteractive","-Command","Write-Output 'hello'"]}));
        manager.event(
            "broto.exec.finished",
            &json!({"deviceId":"alpha","callId":1,"exit_code":0,"duration_ms":12345}),
        );
        let output = ai_output(&manager).1;
        assert!(output.starts_with("$ Write-Output 'hello'\r\n"));
        assert!(output.contains("12.3 s"));
        assert!(!output.contains("12345 ms"));
    }
    #[test]
    fn ai_session_keeps_output_read_only_and_cancels_all_active_calls() {
        let (manager, calls) = fixture();
        manager.event(
            "broto.exec.started",
            &json!({"deviceId":"alpha","callId":42,"command":"echo hello"}),
        );
        manager.event(
            "broto.exec.output",
            &json!({"deviceId":"alpha","callId":42,"data":STANDARD.encode(b"hello")}),
        );
        let info = manager
            .list()
            .into_iter()
            .find(|i| i.tag == "broto:alpha:ia")
            .unwrap();
        manager.write(info.id, b"do not execute").unwrap();
        assert!(lock(&calls).is_empty());
        manager.write(info.id, b"\x03").unwrap();
        assert_eq!(lock(&calls)[0]["cmd"], "exec.cancel");
        assert_eq!(lock(&calls)[0]["args"]["call_id"], 42);
        let (link, _) = manager.output_existing(info.id).unwrap();
        assert!(
            String::from_utf8_lossy(
                &lock(&link.state)
                    .history
                    .iter()
                    .copied()
                    .collect::<Vec<_>>()
            )
            .contains("hello")
        );
        manager.event(
            "broto.exec.finished",
            &json!({"deviceId":"alpha","callId":42,"exit_code":0,"duration_ms":20}),
        );
        manager.write(info.id, b"\x03").unwrap();
        assert_eq!(lock(&calls).len(), 1);
        manager.event(
            "broto.exec.started",
            &json!({"deviceId":"alpha","callId":43,"command":"run"}),
        );
        manager.event(
            "broto.exec.finished",
            &json!({"deviceId":"alpha","callId":43,"error":"broken connection"}),
        );
        assert!(
            String::from_utf8_lossy(
                &lock(&link.state)
                    .history
                    .iter()
                    .copied()
                    .collect::<Vec<_>>()
            )
            .contains("broken connection")
        );
        manager.event(
            "broto.exec.started",
            &json!({"deviceId":"alpha","callId":44,"command":"run"}),
        );
        manager.event("tunnel.state", &json!({"state":"restarting"}));
        manager.write(info.id, b"\x03").unwrap();
        assert_eq!(lock(&calls).len(), 1);
        manager.event(
            "devices.changed",
            &json!({"deviceId":"alpha","revoked":true}),
        );
        assert!(!manager.list().iter().any(|i| i.tag.ends_with(":ia")));
    }
    #[test]
    fn identities_are_stable_and_partitioned_from_local_terminals() {
        let (manager, _) = fixture();
        let first = manager.list();
        let second = manager.list();
        assert_eq!(first.len(), 2);
        assert_ne!(first[0].id, first[1].id);
        for info in first {
            assert!(info.id >= FIRST_ID);
            let same = second
                .iter()
                .find(|other| other.device_id == info.device_id)
                .unwrap();
            assert_eq!(info.id, same.id);
            assert!(info.broto_name.is_some());
        }
    }
    #[test]
    fn writes_and_kills_route_to_the_correct_device_with_binary_bytes() {
        let (manager, calls) = fixture();
        let sessions = manager.list();
        let alpha = sessions
            .iter()
            .find(|info| info.device_id.as_deref() == Some("alpha"))
            .unwrap();
        manager.write(alpha.id, b"a\xff").unwrap();
        manager.kill(alpha.id).unwrap();
        let calls = lock(&calls);
        assert_eq!(calls[0]["deviceId"], "alpha");
        assert_eq!(calls[0]["args"]["id"], 1);
        assert_eq!(calls[0]["cmd"], "pty.write");
        assert_eq!(calls[0]["args"]["data"], STANDARD.encode(b"a\xff"));
        assert_eq!(calls[1]["cmd"], "pty.kill");
    }
    #[test]
    fn renewing_an_unchanged_view_does_not_request_another_remote_mutation() {
        let (manager, calls) = fixture();
        let id = manager.list()[0].id;
        let (link, _) = manager.output_existing(id).unwrap();
        link.attach(SubscriberKey::Webview, Channel::new(|_| Ok(())));
        let view = manager
            .view(id, SubscriberKey::Webview, 80, 24, true, None)
            .unwrap();
        manager
            .view(
                id,
                SubscriberKey::Webview,
                80,
                24,
                false,
                Some(view.lease_id),
            )
            .unwrap();
        assert!(lock(&calls).is_empty());
        assert!(
            manager
                .view(
                    id,
                    SubscriberKey::Remote(4),
                    80,
                    24,
                    false,
                    Some(view.lease_id)
                )
                .is_err()
        );
    }
    #[test]
    fn exited_terminal_drains_every_page_before_sending_exit() {
        let pages = Arc::new(Mutex::new(Vec::new()));
        let observed = pages.clone();
        let manager = Arc::new(BrotoTerminals {
            sessions: Mutex::new(HashMap::new()),
            notify_exit: Arc::new(|_| {}),
            rpc_call: Arc::new(move |cmd, args| {
                if cmd == "broto.sessions" {
                    return Ok(json!([{"deviceId":"alpha","id":1,"dir":"/remote"}]));
                }
                let offset = args["args"]["offset"].as_u64().unwrap();
                lock(&observed).push(offset);
                let bytes = vec![b'a' + (offset / 65536) as u8; 65536];
                Ok(
                    json!({"data":STANDARD.encode(bytes),"offset":offset,"next_offset":offset+65536,"total_offset":262144,"exited":true,"exit_code":7}),
                )
            }),
        });
        let id = manager.list()[0].id;
        let (link, _) = manager.output_existing(id).unwrap();
        let (sender, receiver) = mpsc::channel();
        link.attach(
            SubscriberKey::Webview,
            Channel::new(move |body| {
                sender.send(body).unwrap();
                Ok(())
            }),
        );
        let worker = {
            let manager = manager.clone();
            thread::spawn(move || manager.poll(id))
        };
        let mut output = Vec::new();
        loop {
            match receiver.recv_timeout(Duration::from_secs(3)).unwrap() {
                InvokeResponseBody::Raw(bytes) => {
                    let count = bytes.len();
                    output.extend(bytes);
                    link.ack(count);
                }
                InvokeResponseBody::Json(payload) => {
                    let event = serde_json::from_str::<Value>(&payload).unwrap();
                    if event["type"] == "exit" {
                        assert_eq!(event["code"], 7);
                        break;
                    }
                }
            }
        }
        worker.join().unwrap();
        assert_eq!(output.len(), 262144);
        for (page, byte) in output.chunks(65536).zip(b"abcd") {
            assert!(page.iter().all(|value| value == byte));
        }
        assert_eq!(*lock(&pages), vec![0, 65536, 131072, 196608]);
        assert!(link.closed.load(Ordering::SeqCst));
    }
}
