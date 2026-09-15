// SPDX-License-Identifier: Apache-2.0
//! Vigília do computador enquanto um celular usa o túnel.
//!
//! Com `network.keepAwakeWhilePaired` ligado, o Cialai pede ao sistema que não
//! durma por inatividade enquanto houver pelo menos uma sessão móvel aberta. A
//! tela pode apagar e a tampa, o botão de energia e o comando de repouso
//! continuam valendo. Com a preferência desligada, que é o padrão, nenhuma
//! assertiva é criada e a política de energia do sistema fica inalterada.
//!
//! Contrato dos eventos do sidecar consumidos aqui:
//!
//! - `session.opened {deviceId}`: abriu uma conexão móvel autenticada do
//!   aparelho. Cada evento conta uma sessão; o mesmo aparelho pode ter várias.
//! - `session.closed {deviceId}`: fechou uma sessão aberta antes com o mesmo
//!   `deviceId`. O sidecar emite exatamente um fechamento por abertura, também
//!   quando a conexão cai ou o aparelho é revogado. Fechamento sem abertura
//!   correspondente é ignorado.
//! - `devices.changed {deviceId, revoked: true}`: descarta as sessões que
//!   restarem do aparelho revogado.
//!
//! Campos extras, como `transport`, `remoteAddr`, `nodeKey`, `deviceKey` e
//! `reason`, não mudam a contagem, e a borda v1 e a v2 seguem o mesmo contrato.
//! Quando o processo do sidecar sai, todas as sessões dele deixam de existir.

use std::collections::HashMap;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde_json::Value;

use super::protocol::EventFrame;

/// Nome da assertiva mostrado por `pmset -g assertions` e pelos inibidores do
/// Linux. Fica em ASCII porque o `pmset` não imprime acentos em UTF-8.
const ASSERTION_REASON: &str = "Cialai com celular conectado";
const APP_NAME: &str = "Cialai";
const APP_ID: &str = "br.com.ordinum.cialai";
/// A saída do app não espera mais que isto por um barramento travado; o fim
/// do processo libera a assertiva de qualquer forma.
const STOP_TIMEOUT: Duration = Duration::from_secs(2);

/// Assertiva de vigília de um sistema. `acquire` só é chamado sem assertiva
/// ativa e `release` só depois de um `acquire` bem-sucedido.
pub trait AwakeBackend {
    fn acquire(&mut self) -> Result<(), String>;
    fn release(&mut self);
}

/// Mudança que pode alterar a necessidade de manter o computador acordado.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AwakeChange {
    Preference(bool),
    SessionOpened(String),
    SessionClosed(String),
    DeviceRevoked(String),
    SidecarExited,
    Shutdown,
}

impl AwakeChange {
    /// Traduz um evento do sidecar segundo o contrato descrito no módulo.
    pub fn from_event(event: &EventFrame) -> Option<Self> {
        let device = || {
            event
                .data
                .get("deviceId")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        };
        match event.name.as_str() {
            "session.opened" => device().map(Self::SessionOpened),
            "session.closed" => device().map(Self::SessionClosed),
            "devices.changed"
                if event.data.get("revoked").and_then(Value::as_bool) == Some(true) =>
            {
                device().map(Self::DeviceRevoked)
            }
            _ => None,
        }
    }
}

/// Contagem pura de sessões por aparelho e da preferência.
#[derive(Debug, Default)]
pub struct AwakeState {
    enabled: bool,
    stopped: bool,
    sessions: HashMap<String, usize>,
}

impl AwakeState {
    pub fn new(enabled: bool) -> Self {
        Self {
            enabled,
            ..Self::default()
        }
    }

    pub fn apply(&mut self, change: AwakeChange) {
        if self.stopped {
            return;
        }
        match change {
            AwakeChange::Preference(enabled) => self.enabled = enabled,
            AwakeChange::SessionOpened(device) => *self.sessions.entry(device).or_default() += 1,
            AwakeChange::SessionClosed(device) => {
                if let Some(count) = self.sessions.get_mut(&device) {
                    *count -= 1;
                    if *count == 0 {
                        self.sessions.remove(&device);
                    }
                }
            }
            AwakeChange::DeviceRevoked(device) => {
                self.sessions.remove(&device);
            }
            AwakeChange::SidecarExited => self.sessions.clear(),
            AwakeChange::Shutdown => {
                self.stopped = true;
                self.sessions.clear();
            }
        }
    }

    /// Há celular conectado, a preferência está ligada e o app não saiu.
    pub fn wants_awake(&self) -> bool {
        self.enabled && !self.stopped && !self.sessions.is_empty()
    }
}

/// Aplica as mudanças ao estado e mantém o sistema coerente com ele.
pub struct AwakeGuard<B: AwakeBackend> {
    state: AwakeState,
    backend: B,
    held: bool,
}

impl<B: AwakeBackend> AwakeGuard<B> {
    pub fn new(backend: B, enabled: bool) -> Self {
        Self {
            state: AwakeState::new(enabled),
            backend,
            held: false,
        }
    }

    /// Uma falha ao criar a assertiva deixa a política normal de energia e é
    /// tentada de novo na próxima mudança.
    pub fn apply(&mut self, change: AwakeChange) -> Result<(), String> {
        self.state.apply(change);
        let wanted = self.state.wants_awake();
        if wanted && !self.held {
            self.backend.acquire()?;
            self.held = true;
        } else if !wanted && self.held {
            self.backend.release();
            self.held = false;
        }
        Ok(())
    }

    pub fn is_held(&self) -> bool {
        self.held
    }
}

enum Command {
    Apply(AwakeChange),
    Stop(mpsc::SyncSender<()>),
}

/// Vigília do app. Uma única thread cria e libera a assertiva: no Windows,
/// `SetThreadExecutionState` vale só para a thread que chamou e se perde quando
/// ela termina, e no Linux o D-Bus não trava a leitura dos eventos do sidecar.
#[derive(Clone)]
pub struct Awake {
    commands: Option<mpsc::Sender<Command>>,
}

impl Awake {
    pub fn start(enabled: bool) -> Self {
        Self::spawn(system::SystemBackend::default, enabled)
    }

    pub(super) fn spawn<B, F>(backend: F, enabled: bool) -> Self
    where
        B: AwakeBackend,
        F: FnOnce() -> B + Send + 'static,
    {
        let (commands, receiver) = mpsc::channel();
        let worker = thread::Builder::new()
            .name("cialai-awake".into())
            .spawn(move || run(AwakeGuard::new(backend(), enabled), receiver));
        match worker {
            Ok(_) => Self {
                commands: Some(commands),
            },
            Err(error) => {
                crate::diagnostics::note(&format!("vigília indisponível: {error}"));
                Self { commands: None }
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn disabled() -> Self {
        Self { commands: None }
    }

    /// Aplica a preferência `keepAwakeWhilePaired` em tempo de execução.
    pub fn set_enabled(&self, enabled: bool) {
        self.send(AwakeChange::Preference(enabled));
    }

    pub(super) fn observe(&self, event: &EventFrame) {
        if let Some(change) = AwakeChange::from_event(event) {
            self.send(change);
        }
    }

    pub(super) fn sidecar_exited(&self) {
        self.send(AwakeChange::SidecarExited);
    }

    /// Libera a assertiva na saída do app e ignora eventos posteriores.
    pub fn shutdown_blocking(&self) {
        let Some(commands) = &self.commands else {
            return;
        };
        let (done, finished) = mpsc::sync_channel(1);
        if commands.send(Command::Stop(done)).is_ok() {
            let _ = finished.recv_timeout(STOP_TIMEOUT);
        }
    }

    fn send(&self, change: AwakeChange) {
        if let Some(commands) = &self.commands {
            let _ = commands.send(Command::Apply(change));
        }
    }
}

fn run<B: AwakeBackend>(mut guard: AwakeGuard<B>, commands: mpsc::Receiver<Command>) {
    while let Ok(command) = commands.recv() {
        match command {
            Command::Apply(change) => apply_and_report(&mut guard, change),
            Command::Stop(done) => {
                apply_and_report(&mut guard, AwakeChange::Shutdown);
                let _ = done.send(());
                return;
            }
        }
    }
    apply_and_report(&mut guard, AwakeChange::Shutdown);
}

fn apply_and_report<B: AwakeBackend>(guard: &mut AwakeGuard<B>, change: AwakeChange) {
    let was_held = guard.is_held();
    match guard.apply(change) {
        Err(problem) => crate::diagnostics::note(&format!("vigília indisponível: {problem}")),
        Ok(()) if !was_held && guard.is_held() => {
            crate::diagnostics::note("vigília ativa: celular conectado")
        }
        Ok(()) if was_held && !guard.is_held() => crate::diagnostics::note("vigília liberada"),
        Ok(()) => {}
    }
}

/// macOS usa `IOPMAssertionCreateWithName` com `PreventUserIdleSystemSleep` e
/// Windows usa `SetThreadExecutionState` com `ES_SYSTEM_REQUIRED`, ambos pela
/// crate `keepawake`.
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod system {
    use super::{APP_ID, APP_NAME, ASSERTION_REASON, AwakeBackend};

    #[derive(Default)]
    pub struct SystemBackend {
        assertion: Option<keepawake::KeepAwake>,
    }

    impl AwakeBackend for SystemBackend {
        fn acquire(&mut self) -> Result<(), String> {
            let assertion = keepawake::Builder::default()
                .idle(true)
                .reason(ASSERTION_REASON)
                .app_name(APP_NAME)
                .app_reverse_domain(APP_ID)
                .create()
                .map_err(|error| error.to_string())?;
            self.assertion = Some(assertion);
            Ok(())
        }

        fn release(&mut self) {
            self.assertion = None;
        }
    }
}

/// Linux pede inibidores por D-Bus. O `keepawake` só registra o bloqueio
/// `idle` do logind, que o GNOME não consulta para a suspensão automática;
/// por isso o Cialai registra também os inibidores de suspensão do GNOME e do
/// `org.freedesktop.PowerManagement`, sem manter a tela acesa. Basta um deles
/// ser aceito.
#[cfg(target_os = "linux")]
mod system {
    use zbus::blocking::Connection;
    use zbus::zvariant::OwnedFd;

    use super::{APP_ID, APP_NAME, ASSERTION_REASON, AwakeBackend};

    /// Sinalizador de suspensão em `org.gnome.SessionManager.Inhibit`.
    const GNOME_INHIBIT_SUSPEND: u32 = 4;

    struct Cookie {
        connection: Connection,
        service: &'static str,
        path: &'static str,
        interface: &'static str,
        release: &'static str,
        value: u32,
    }

    #[derive(Default)]
    pub struct SystemBackend {
        /// Fechar o descritor do logind libera o bloqueio.
        logind: Option<OwnedFd>,
        cookies: Vec<Cookie>,
    }

    impl AwakeBackend for SystemBackend {
        fn acquire(&mut self) -> Result<(), String> {
            let mut problems = Vec::new();
            match logind_idle() {
                Ok(descriptor) => self.logind = Some(descriptor),
                Err(error) => problems.push(format!("logind: {error}")),
            }
            match Connection::session() {
                Ok(connection) => {
                    match gnome_suspend(&connection) {
                        Ok(cookie) => self.cookies.push(cookie),
                        Err(error) => problems.push(format!("GNOME: {error}")),
                    }
                    match power_management(&connection) {
                        Ok(cookie) => self.cookies.push(cookie),
                        Err(error) => problems.push(format!("PowerManagement: {error}")),
                    }
                }
                Err(error) => problems.push(format!("sessão D-Bus: {error}")),
            }
            if self.logind.is_none() && self.cookies.is_empty() {
                return Err(problems.join("; "));
            }
            Ok(())
        }

        fn release(&mut self) {
            self.logind = None;
            for cookie in self.cookies.drain(..) {
                let _ = cookie.connection.call_method(
                    Some(cookie.service),
                    cookie.path,
                    Some(cookie.interface),
                    cookie.release,
                    &cookie.value,
                );
            }
        }
    }

    fn logind_idle() -> zbus::Result<OwnedFd> {
        let connection = Connection::system()?;
        let reply = connection.call_method(
            Some("org.freedesktop.login1"),
            "/org/freedesktop/login1",
            Some("org.freedesktop.login1.Manager"),
            "Inhibit",
            &("idle", APP_NAME, ASSERTION_REASON, "block"),
        )?;
        reply.body().deserialize::<OwnedFd>()
    }

    fn gnome_suspend(connection: &Connection) -> zbus::Result<Cookie> {
        let (service, path, interface) = (
            "org.gnome.SessionManager",
            "/org/gnome/SessionManager",
            "org.gnome.SessionManager",
        );
        let reply = connection.call_method(
            Some(service),
            path,
            Some(interface),
            "Inhibit",
            &(APP_ID, 0_u32, ASSERTION_REASON, GNOME_INHIBIT_SUSPEND),
        )?;
        Ok(Cookie {
            connection: connection.clone(),
            service,
            path,
            interface,
            release: "Uninhibit",
            value: reply.body().deserialize::<u32>()?,
        })
    }

    fn power_management(connection: &Connection) -> zbus::Result<Cookie> {
        let (service, path, interface) = (
            "org.freedesktop.PowerManagement",
            "/org/freedesktop/PowerManagement/Inhibit",
            "org.freedesktop.PowerManagement.Inhibit",
        );
        let reply = connection.call_method(
            Some(service),
            path,
            Some(interface),
            "Inhibit",
            &(APP_NAME, ASSERTION_REASON),
        )?;
        Ok(Cookie {
            connection: connection.clone(),
            service,
            path,
            interface,
            release: "UnInhibit",
            value: reply.body().deserialize::<u32>()?,
        })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
mod system {
    use super::AwakeBackend;

    #[derive(Default)]
    pub struct SystemBackend;

    impl AwakeBackend for SystemBackend {
        fn acquire(&mut self) -> Result<(), String> {
            Err("este sistema não tem vigília implementada".into())
        }

        fn release(&mut self) {}
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};
    use std::thread::ThreadId;

    use serde_json::json;

    use super::*;

    #[derive(Clone, Debug, PartialEq, Eq)]
    enum Call {
        Acquire,
        Release,
    }

    #[derive(Clone, Default)]
    struct Recording {
        calls: Arc<Mutex<Vec<(Call, ThreadId)>>>,
        failures: Arc<Mutex<usize>>,
    }

    impl Recording {
        fn calls(&self) -> Vec<Call> {
            self.calls
                .lock()
                .unwrap()
                .iter()
                .map(|(call, _)| call.clone())
                .collect()
        }

        fn fail_next(&self, times: usize) {
            *self.failures.lock().unwrap() = times;
        }
    }

    impl AwakeBackend for Recording {
        fn acquire(&mut self) -> Result<(), String> {
            let mut failures = self.failures.lock().unwrap();
            if *failures > 0 {
                *failures -= 1;
                return Err("barramento indisponível".into());
            }
            self.calls
                .lock()
                .unwrap()
                .push((Call::Acquire, thread::current().id()));
            Ok(())
        }

        fn release(&mut self) {
            self.calls
                .lock()
                .unwrap()
                .push((Call::Release, thread::current().id()));
        }
    }

    fn opened(device: &str) -> AwakeChange {
        AwakeChange::SessionOpened(device.into())
    }

    fn closed(device: &str) -> AwakeChange {
        AwakeChange::SessionClosed(device.into())
    }

    fn guard(enabled: bool) -> (AwakeGuard<Recording>, Recording) {
        let backend = Recording::default();
        (AwakeGuard::new(backend.clone(), enabled), backend)
    }

    fn event(name: &str, data: Value) -> EventFrame {
        EventFrame {
            name: name.into(),
            data,
            ts: "2026-09-14T12:00:00Z".into(),
        }
    }

    #[test]
    fn without_sessions_the_power_policy_is_untouched() {
        let (mut guard, backend) = guard(true);
        guard.apply(AwakeChange::Preference(false)).unwrap();
        guard.apply(AwakeChange::Preference(true)).unwrap();
        guard.apply(closed("dev_unknown")).unwrap();
        guard.apply(AwakeChange::SidecarExited).unwrap();
        assert!(!guard.is_held());
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn the_default_preference_never_creates_an_assertion() {
        let (mut guard, backend) = guard(false);
        guard.apply(opened("dev_phone")).unwrap();
        guard.apply(opened("dev_tablet")).unwrap();
        guard.apply(closed("dev_phone")).unwrap();
        assert!(!guard.is_held());
        assert!(backend.calls().is_empty());
    }

    #[test]
    fn one_session_holds_the_assertion_until_it_closes() {
        let (mut guard, backend) = guard(true);
        guard.apply(opened("dev_phone")).unwrap();
        assert!(guard.is_held());
        assert_eq!(backend.calls(), [Call::Acquire]);
        guard.apply(closed("dev_phone")).unwrap();
        assert!(!guard.is_held());
        assert_eq!(backend.calls(), [Call::Acquire, Call::Release]);
    }

    #[test]
    fn two_phones_keep_one_assertion_until_the_last_disconnects() {
        let (mut guard, backend) = guard(true);
        guard.apply(opened("dev_phone")).unwrap();
        guard.apply(opened("dev_tablet")).unwrap();
        guard.apply(opened("dev_tablet")).unwrap();
        assert_eq!(backend.calls(), [Call::Acquire]);
        guard.apply(closed("dev_phone")).unwrap();
        guard.apply(closed("dev_tablet")).unwrap();
        assert!(guard.is_held(), "o tablet ainda tem uma sessão aberta");
        guard.apply(closed("dev_tablet")).unwrap();
        guard.apply(closed("dev_tablet")).unwrap();
        assert!(!guard.is_held());
        assert_eq!(backend.calls(), [Call::Acquire, Call::Release]);
    }

    #[test]
    fn revoked_device_and_sidecar_exit_discard_sessions() {
        let (mut guard, backend) = guard(true);
        guard.apply(opened("dev_phone")).unwrap();
        guard.apply(opened("dev_phone")).unwrap();
        guard.apply(opened("dev_tablet")).unwrap();
        guard
            .apply(AwakeChange::DeviceRevoked("dev_phone".into()))
            .unwrap();
        assert!(guard.is_held());
        guard.apply(closed("dev_phone")).unwrap();
        guard.apply(AwakeChange::SidecarExited).unwrap();
        assert!(!guard.is_held());
        guard.apply(closed("dev_tablet")).unwrap();
        assert_eq!(backend.calls(), [Call::Acquire, Call::Release]);
    }

    #[test]
    fn preference_changes_in_the_middle_of_a_session() {
        let (mut guard, backend) = guard(true);
        guard.apply(opened("dev_phone")).unwrap();
        guard.apply(AwakeChange::Preference(false)).unwrap();
        assert!(!guard.is_held());
        guard.apply(opened("dev_tablet")).unwrap();
        assert!(!guard.is_held());
        guard.apply(AwakeChange::Preference(true)).unwrap();
        assert!(guard.is_held());
        guard.apply(closed("dev_phone")).unwrap();
        guard.apply(closed("dev_tablet")).unwrap();
        assert_eq!(
            backend.calls(),
            [Call::Acquire, Call::Release, Call::Acquire, Call::Release]
        );
    }

    #[test]
    fn shutdown_releases_and_ignores_later_changes() {
        let (mut guard, backend) = guard(true);
        guard.apply(opened("dev_phone")).unwrap();
        guard.apply(AwakeChange::Shutdown).unwrap();
        assert!(!guard.is_held());
        guard.apply(AwakeChange::Preference(true)).unwrap();
        guard.apply(opened("dev_tablet")).unwrap();
        assert!(!guard.is_held());
        assert_eq!(backend.calls(), [Call::Acquire, Call::Release]);
    }

    #[test]
    fn failed_assertion_is_retried_on_the_next_change() {
        let (mut guard, backend) = guard(true);
        backend.fail_next(1);
        assert!(guard.apply(opened("dev_phone")).is_err());
        assert!(!guard.is_held());
        guard.apply(opened("dev_phone")).unwrap();
        assert!(guard.is_held());
        guard.apply(closed("dev_phone")).unwrap();
        assert!(guard.is_held(), "a segunda sessão continua aberta");
        guard.apply(closed("dev_phone")).unwrap();
        assert_eq!(backend.calls(), [Call::Acquire, Call::Release]);
    }

    #[test]
    fn sidecar_events_follow_the_session_contract() {
        assert_eq!(
            AwakeChange::from_event(&event(
                "session.opened",
                json!({"deviceId":"dev_phone", "remoteAddr":"100.64.0.2:50000", "nodeKey":"nodekey:a"}),
            )),
            Some(opened("dev_phone"))
        );
        assert_eq!(
            AwakeChange::from_event(&event(
                "session.closed",
                json!({"deviceId":"dev_phone", "transport":"onion", "reason":"revoked"}),
            )),
            Some(closed("dev_phone"))
        );
        assert_eq!(
            AwakeChange::from_event(&event(
                "devices.changed",
                json!({"deviceId":"dev_phone", "revoked":true}),
            )),
            Some(AwakeChange::DeviceRevoked("dev_phone".into()))
        );
        for ignored in [
            event("session.opened", json!({"remoteAddr":"100.64.0.2:50000"})),
            event("session.closed", json!({"deviceId":""})),
            event(
                "devices.changed",
                json!({"deviceId":"dev_phone", "name":"iPhone"}),
            ),
            event("edge.state", json!({"state":"stopped"})),
        ] {
            assert_eq!(AwakeChange::from_event(&ignored), None, "{}", ignored.name);
        }
    }

    #[test]
    fn one_worker_thread_creates_and_releases_the_assertion() {
        let backend = Recording::default();
        let shared = backend.clone();
        let awake = Awake::spawn(move || shared, false);
        let events = awake.clone();
        events.observe(&event("session.opened", json!({"deviceId":"dev_phone"})));
        awake.set_enabled(true);
        events.observe(&event("session.opened", json!({"deviceId":"dev_tablet"})));
        awake.shutdown_blocking();
        awake.shutdown_blocking();
        events.observe(&event("session.opened", json!({"deviceId":"dev_other"})));

        assert_eq!(backend.calls(), [Call::Acquire, Call::Release]);
        let calls = backend.calls.lock().unwrap().clone();
        assert_eq!(calls[0].1, calls[1].1);
        assert_ne!(calls[0].1, thread::current().id());
    }

    /// Verificação manual no macOS:
    /// `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --locked
    /// real_assertion -- --ignored --nocapture`.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "cria uma assertiva real de energia no macOS"]
    fn real_assertion_appears_in_pmset_and_disappears_on_release() {
        fn assertions() -> String {
            let output = std::process::Command::new("pmset")
                .args(["-g", "assertions"])
                .output()
                .expect("pmset disponível");
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
        fn ours(listing: &str) -> Vec<&str> {
            listing
                .lines()
                .filter(|line| line.contains(ASSERTION_REASON))
                .collect()
        }

        let mut backend = system::SystemBackend::default();
        backend.acquire().unwrap();
        let active = assertions();
        println!("ativa:\n{}", ours(&active).join("\n"));
        assert!(
            ours(&active)
                .iter()
                .any(|line| line.contains("PreventUserIdleSystemSleep")),
            "{active}"
        );
        backend.release();
        let released = assertions();
        println!("liberada: {} linhas do Cialai", ours(&released).len());
        assert!(ours(&released).is_empty(), "{released}");
    }
}
