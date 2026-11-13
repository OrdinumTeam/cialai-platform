// SPDX-License-Identifier: Apache-2.0

#[cfg(windows)]
#[test]
fn windows_passive_probe_uses_only_profile_local_initialize_and_obeys_timeout() {
    use serde_json::{Value, json};
    use std::{
        ffi::c_void,
        fs,
        net::TcpStream,
        os::windows::io::{FromRawSocket, RawSocket},
        path::PathBuf,
        thread::{self, JoinHandle},
        time::{Duration, Instant},
    };
    use tokio_tungstenite::tungstenite::{
        Error, Message, accept as accept_websocket, error::ProtocolError,
    };

    // These declarations avoid enabling production WinSock features for a fixture.
    #[link(name = "ws2_32")]
    unsafe extern "system" {
        fn WSAStartup(version: u16, data: *mut c_void) -> i32;
        fn WSACleanup() -> i32;
        fn WSAGetLastError() -> i32;
        fn bind(socket: usize, address: *const c_void, length: i32) -> i32;
        fn listen(socket: usize, backlog: i32) -> i32;
        fn accept(socket: usize, address: *mut c_void, length: *mut i32) -> usize;
        fn ioctlsocket(socket: usize, command: i32, argument: *mut u32) -> i32;
        fn closesocket(socket: usize) -> i32;
    }

    struct Winsock;
    impl Drop for Winsock {
        fn drop(&mut self) {
            unsafe {
                WSACleanup();
            }
        }
    }
    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    struct Listener(usize);
    impl Drop for Listener {
        fn drop(&mut self) {
            unsafe {
                closesocket(self.0);
            }
        }
    }
    struct Worker(Option<JoinHandle<()>>);
    impl Worker {
        fn finish(mut self) {
            self.0.take().unwrap().join().expect("fake daemon failed");
        }
    }
    impl Drop for Worker {
        fn drop(&mut self) {
            if let Some(worker) = self.0.take() {
                // Also join during assertion unwinding before removing the fixture.
                let _ = worker.join();
            }
        }
    }
    #[repr(C)]
    struct UnixAddress {
        family: u16,
        path: [u8; 108],
    }

    // WSADATA is at most 408 bytes on supported Windows architectures;
    // this opaque buffer provides sufficient size and native pointer alignment.
    let mut startup_data = [0usize; 128];
    assert_eq!(
        unsafe { WSAStartup(0x0202, startup_data.as_mut_ptr().cast()) },
        0
    );
    let _winsock = Winsock;
    let mut nonce = [0u8; 4];
    getrandom::fill(&mut nonce).unwrap();
    let suffix: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let root = Root(std::env::temp_dir().join(format!("cd{suffix}")));
    fs::create_dir(&root.0).unwrap();
    let sentinel = root.0.join("untouched");
    fs::write(&sentinel, b"fixture-only").unwrap();
    let timeout = Duration::from_millis(100);
    assert!(matches!(
        super::check(&root.0, timeout),
        super::Health::NotObserved
    ));
    assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);

    for case in ["running", "draining", "stalled"] {
        // Successful handshakes test protocol behavior, not scheduler speed.
        // Only the unresponsive peer uses the strict 100 ms caller budget.
        let probe_timeout = if case == "stalled" {
            timeout
        } else {
            Duration::from_secs(2)
        };
        let control = root.0.join("app-server-control");
        fs::create_dir(&control).unwrap();
        let socket_path = control.join("app-server-control.sock");
        let path_text = socket_path.to_str().expect("fixture path must be UTF-8");
        assert!(
            path_text.len() < 108,
            "temporary directory is too long for AF_UNIX"
        );
        let mut address = UnixAddress {
            family: 1,
            path: [0; 108],
        };
        address.path[..path_text.len()].copy_from_slice(path_text.as_bytes());
        // Keep the fixture listener out of concurrently spawned shell tests.
        let raw = unsafe {
            use windows_sys::Win32::Networking::WinSock::{
                WSA_FLAG_NO_HANDLE_INHERIT, WSA_FLAG_OVERLAPPED, WSASocketW,
            };
            WSASocketW(
                1, // AF_UNIX.
                1, // SOCK_STREAM.
                0,
                std::ptr::null(),
                0,
                WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT,
            )
        };
        assert_ne!(
            raw,
            usize::MAX,
            "AF_UNIX socket creation failed: {}",
            unsafe { WSAGetLastError() }
        );
        let listener = Listener(raw);
        assert_eq!(
            unsafe {
                bind(
                    listener.0,
                    (&address as *const UnixAddress).cast(),
                    std::mem::size_of::<UnixAddress>() as i32,
                )
            },
            0,
            "AF_UNIX bind failed: {}",
            unsafe { WSAGetLastError() }
        );
        assert_eq!(unsafe { listen(listener.0, 1) }, 0);
        let mut nonblocking = 1u32;
        assert_eq!(
            unsafe { ioctlsocket(listener.0, 0x8004667eu32 as i32, &mut nonblocking) },
            0
        );
        assert!(socket_path.exists());

        let worker = Worker(Some(thread::spawn(move || {
            let accept_deadline = Instant::now() + Duration::from_secs(2);
            let stream = loop {
                let accepted =
                    unsafe { accept(listener.0, std::ptr::null_mut(), std::ptr::null_mut()) };
                if accepted != usize::MAX {
                    // Ownership transfers exactly once; only generic stream I/O is used.
                    break unsafe { TcpStream::from_raw_socket(accepted as RawSocket) };
                }
                assert_eq!(
                    unsafe { WSAGetLastError() },
                    10035,
                    "unexpected accept failure"
                );
                assert!(
                    Instant::now() < accept_deadline,
                    "probe never connected to its profile socket"
                );
                thread::sleep(Duration::from_millis(2));
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut websocket = accept_websocket(stream)
                .unwrap_or_else(|error| panic!("{case}: WebSocket handshake: {error:?}"));
            let first = websocket
                .read()
                .unwrap_or_else(|error| panic!("{case}: initialize request: {error:?}"));
            let Message::Text(text) = first else {
                panic!("expected initialize JSON");
            };
            let initialize: Value = serde_json::from_str(text.as_str()).unwrap();
            assert_eq!(initialize["method"], "initialize");
            assert!(initialize["id"].is_number());
            assert!(
                initialize["params"]["clientInfo"]["name"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
            );
            assert!(
                initialize["params"]["clientInfo"]["version"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
            );
            let id = initialize["id"].clone();
            match case {
                "running" => websocket.send(Message::Text(json!({
                    "id": id,
                    "result": { "userAgent": "codex_app_server_daemon/0.162.1 (Windows 11) codex_cli_rs/0.162.1" }
                }).to_string().into())).unwrap(),
                "draining" => websocket.send(Message::Text(json!({
                    "id": id,
                    "error": { "code": -32600, "message": "Server is draining; retry after reconnecting" }
                }).to_string().into())).unwrap(),
                // Longer than the caller budget: an implementation that waits
                // for peer disconnect cannot pass the elapsed-time assertion.
                "stalled" => thread::sleep(Duration::from_millis(400)),
                _ => unreachable!(),
            }
            let mut initialized = false;
            let mut closed = false;
            // A finite message count plus socket deadlines bounds the worker.
            for _ in 0..3 {
                match websocket.read() {
                    Ok(Message::Text(text)) => {
                        let notification: Value = serde_json::from_str(text.as_str()).unwrap();
                        assert_eq!(case, "running", "notification before successful initialize");
                        assert!(!initialized, "duplicate initialized notification");
                        assert_eq!(
                            notification["method"], "initialized",
                            "probe sent an active daemon command"
                        );
                        assert!(notification.get("id").is_none());
                        initialized = true;
                    }
                    Ok(Message::Close(_)) => {
                        closed = true;
                        break;
                    }
                    Err(Error::ConnectionClosed | Error::AlreadyClosed)
                    | Err(Error::Protocol(ProtocolError::ResetWithoutClosingHandshake)) => {
                        closed = true;
                        break;
                    }
                    Err(Error::Io(error))
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::UnexpectedEof
                                | std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                                | std::io::ErrorKind::BrokenPipe
                        ) =>
                    {
                        closed = true;
                        break;
                    }
                    other => panic!("{case}: unexpected passive probe frame or failure: {other:?}"),
                }
            }
            assert!(closed, "probe did not close its connection");
            assert_eq!(initialized, case == "running");
        })));

        let started = Instant::now();
        let health = super::check(&root.0, probe_timeout);
        let elapsed = started.elapsed();
        worker.finish();
        match case {
            "running" => assert!(
                matches!(health, super::Health::Running(ref version) if version == "0.162.1")
            ),
            "draining" => assert!(matches!(health, super::Health::Draining)),
            "stalled" => {
                assert!(matches!(health, super::Health::Unknown));
                assert!(
                    elapsed < Duration::from_millis(300),
                    "100 ms probe exceeded scheduling allowance: {elapsed:?}"
                );
            }
            _ => unreachable!(),
        }
        assert!(socket_path.exists(), "probe removed the daemon socket");
        assert_eq!(fs::read(&sentinel).unwrap(), b"fixture-only");
        assert_eq!(
            fs::read_dir(&root.0).unwrap().count(),
            2,
            "probe created profile artifacts"
        );
        assert_eq!(
            fs::read_dir(&control).unwrap().count(),
            1,
            "probe created daemon artifacts"
        );
        // Only the fixture removes its own closed socket and directory.
        fs::remove_file(&socket_path).unwrap();
        fs::remove_dir(&control).unwrap();
    }
}
