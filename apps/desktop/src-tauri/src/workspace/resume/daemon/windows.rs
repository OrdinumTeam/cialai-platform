// SPDX-License-Identifier: Apache-2.0
//! Read-only Windows AF_UNIX transport for the passive compatibility probe.

use super::Health;
use serde_json::{Value, json};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    net::TcpStream,
    os::windows::{
        fs::{MetadataExt, OpenOptionsExt},
        io::{AsRawHandle, AsRawSocket, FromRawSocket, RawSocket},
    },
    path::Path,
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::{
    Message, client::client_with_config, protocol::WebSocketConfig,
};
use windows_sys::Win32::{
    Networking::WinSock::*,
    Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_READ,
        FILE_SHARE_WRITE, FileAttributeTagInfo, GetFileInformationByHandleEx,
    },
};

pub(super) fn check(config: &Path, timeout: Duration) -> Health {
    let Some(deadline) = Instant::now().checked_add(timeout) else {
        return Health::Unknown;
    };
    probe(config, deadline).unwrap_or_else(|error| {
        if error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(WSAECONNREFUSED)
        {
            Health::NotObserved
        } else {
            Health::Unknown
        }
    })
}

fn probe(config: &Path, deadline: Instant) -> io::Result<Health> {
    // Resolve the saved profile once. Open directory handles without delete
    // sharing so a directory cannot be replaced during the connection.
    let config = dunce::canonicalize(config).map_err(|_| io::Error::other("invalid profile"))?;
    let _profile = pin_directory(&config)?;
    let control = config.join("app-server-control");
    let _control = pin_directory(&control)?;
    let path = control.join("app-server-control.sock");
    let socket_file = open_without_redirection(&path, FILE_READ_ATTRIBUTES)?;
    let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: socket_file remains open; tag is a writable, correctly sized
    // FILE_ATTRIBUTE_TAG_INFO. OPEN_REPARSE_POINT prevents following links.
    if unsafe {
        GetFileInformationByHandleEx(
            socket_file.as_raw_handle(),
            FileAttributeTagInfo,
            (&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            std::mem::size_of_val(&tag) as u32,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    // AF_UNIX sockets are reparse points themselves, but must never be a
    // symlink, junction or another redirecting reparse tag (winnt.h).
    const IO_REPARSE_TAG_AF_UNIX: u32 = 0x8000_0023;
    if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
        || tag.ReparseTag != IO_REPARSE_TAG_AF_UNIX
    {
        return Err(io::Error::other("not an AF_UNIX socket"));
    }
    let path_text = path
        .to_str()
        .filter(|path| !path.as_bytes().contains(&0) && path.len() < 108)
        .ok_or_else(|| io::Error::other("unsupported AF_UNIX path"))?;

    let _winsock = Winsock::start()?;
    let stream = connect_local(path_text, deadline)?;
    let config = WebSocketConfig::default()
        .max_message_size(Some(64 * 1024))
        .max_frame_size(Some(64 * 1024));
    let Ok((mut ws, _)) = client_with_config("ws://localhost/", stream, Some(config)) else {
        return Ok(Health::Unknown);
    };
    let request = json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"cialai_compatibility","version":env!("CARGO_PKG_VERSION")}}});
    if ws.send(Message::Text(request.to_string().into())).is_err() {
        return Ok(Health::Unknown);
    }
    for _ in 0..16 {
        let Ok(message) = ws.read() else {
            return Ok(Health::Unknown);
        };
        let Ok(text) = message.to_text() else {
            continue;
        };
        let Ok(frame) = serde_json::from_str::<Value>(text) else {
            return Ok(Health::Unknown);
        };
        if frame.get("id") != Some(&json!(1)) {
            continue;
        }
        if frame.get("error").is_some_and(|error| {
            error.get("code").and_then(Value::as_i64) == Some(-32600)
                && error
                    .get("message")
                    .and_then(Value::as_str)
                    .is_some_and(|s| s.to_ascii_lowercase().contains("draining"))
        }) {
            let _ = ws.close(None);
            return Ok(Health::Draining);
        }
        let version = frame
            .get("result")
            .and_then(|r| r.get("userAgent"))
            .and_then(Value::as_str)
            .and_then(|agent| agent.split_once('/'))
            .and_then(|(_, rest)| rest.split_whitespace().next())
            .filter(|v| !v.is_empty() && v.len() <= 160 && v.bytes().any(|b| b.is_ascii_digit()))
            .map(str::to_owned);
        if version.is_some() {
            let _ = ws.send(Message::Text(
                json!({"method":"initialized"}).to_string().into(),
            ));
        }
        let _ = ws.close(None);
        return Ok(version.map(Health::Running).unwrap_or(Health::Unknown));
    }
    Ok(Health::Unknown)
}

fn open_without_redirection(path: &Path, access: u32) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

fn pin_directory(path: &Path) -> io::Result<File> {
    // Metadata-only access bypasses share-delete checks. Directory-list access
    // makes omitting FILE_SHARE_DELETE pin this directory against replacement.
    let file = open_without_redirection(path, FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY)?;
    let metadata = file.metadata()?;
    if !metadata.is_dir()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || dunce::canonicalize(path)?.as_path() != path
    {
        return Err(io::Error::other("redirected control directory"));
    }
    Ok(file)
}

struct Winsock;

impl Winsock {
    fn start() -> io::Result<Self> {
        let mut data = WSADATA::default();
        // SAFETY: data is valid WSADATA storage. This guard balances only
        // this successful startup, after all sockets have been dropped.
        let error = unsafe { WSAStartup(0x0202, &mut data) };
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
        Ok(Self)
    }
}

impl Drop for Winsock {
    fn drop(&mut self) {
        // SAFETY: this guard owns one successful WSAStartup reference.
        unsafe { WSACleanup() };
    }
}

struct DeadlineStream {
    // AF_UNIX socket ownership uses TcpStream only for generic socket I/O;
    // no TCP-specific operations are called on this stream.
    stream: TcpStream,
    deadline: Instant,
}

fn local_socket() -> io::Result<TcpStream> {
    // Allocate without inheritance atomically: concurrently launched shells
    // must not retain this profile's control connection after the probe ends.
    // SAFETY: Winsock is initialized and no protocol-info pointer is supplied.
    let raw = unsafe {
        WSASocketW(
            AF_UNIX as i32,
            SOCK_STREAM,
            0,
            std::ptr::null(),
            0,
            WSA_FLAG_OVERLAPPED | WSA_FLAG_NO_HANDLE_INHERIT,
        )
    };
    if raw == INVALID_SOCKET {
        return Err(winsock_error());
    }
    // SAFETY: raw is a new valid stream socket transferred exactly once.
    // Keeping it owned from here closes it on every subsequent error path.
    Ok(unsafe { TcpStream::from_raw_socket(raw as RawSocket) })
}

fn connect_local(path: &str, deadline: Instant) -> io::Result<DeadlineStream> {
    remaining(deadline)?;
    let stream = local_socket()?;
    let raw = stream.as_raw_socket() as SOCKET;
    stream.set_nonblocking(true)?;
    let mut address = SOCKADDR_UN {
        sun_family: AF_UNIX,
        ..Default::default()
    };
    for (target, source) in address.sun_path.iter_mut().zip(path.bytes()) {
        *target = source as i8;
    }
    // SAFETY: address is a fully initialized, NUL-terminated SOCKADDR_UN;
    // its storage remains live for the synchronous nonblocking call.
    if unsafe {
        connect(
            raw,
            (&address as *const SOCKADDR_UN).cast(),
            std::mem::size_of_val(&address) as i32,
        )
    } != 0
    {
        let error = winsock_error();
        if !matches!(
            error.raw_os_error(),
            Some(WSAEWOULDBLOCK | WSAEINPROGRESS | WSAEALREADY)
        ) {
            return Err(error);
        }
        poll(raw, POLLWRNORM, deadline)?;
        let mut error = 0i32;
        let mut size = std::mem::size_of_val(&error) as i32;
        // SAFETY: socket is owned by stream; both output pointers refer to
        // correctly sized writable i32 storage for SO_ERROR.
        if unsafe {
            getsockopt(
                raw,
                SOL_SOCKET,
                SO_ERROR,
                (&mut error as *mut i32).cast(),
                &mut size,
            )
        } != 0
        {
            return Err(winsock_error());
        }
        if error != 0 {
            return Err(io::Error::from_raw_os_error(error));
        }
    }
    Ok(DeadlineStream { stream, deadline })
}

fn winsock_error() -> io::Error {
    // SAFETY: WSAGetLastError takes no pointers and reads thread-local state.
    io::Error::from_raw_os_error(unsafe { WSAGetLastError() })
}

fn remaining(deadline: Instant) -> io::Result<Duration> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "passive probe deadline"))
}

fn poll(socket: SOCKET, events: WSAPOLL_EVENT_FLAGS, deadline: Instant) -> io::Result<()> {
    loop {
        // Round up sub-millisecond budgets; never restart the caller's budget.
        let millis = remaining(deadline)?.as_millis().saturating_add(1);
        let timeout = millis.min(i32::MAX as u128) as i32;
        let mut fd = WSAPOLLFD {
            fd: socket,
            events,
            revents: 0,
        };
        // SAFETY: fd is one writable descriptor, referring to our live socket.
        let result = unsafe { WSAPoll(&mut fd, 1, timeout) };
        if result > 0 {
            if fd.revents & POLLNVAL != 0 {
                return Err(io::Error::other("invalid probe socket"));
            }
            return Ok(());
        }
        if result < 0 {
            let error = winsock_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
}

impl Read for DeadlineStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            remaining(self.deadline)?;
            match self.stream.read(buffer) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    poll(
                        self.stream.as_raw_socket() as SOCKET,
                        POLLRDNORM,
                        self.deadline,
                    )?;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => return result,
            }
        }
    }
}

impl Write for DeadlineStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        loop {
            remaining(self.deadline)?;
            match self.stream.write(buffer) {
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    poll(
                        self.stream.as_raw_socket() as SOCKET,
                        POLLWRNORM,
                        self.deadline,
                    )?;
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                result => return result,
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        remaining(self.deadline)?;
        self.stream.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::{GetHandleInformation, HANDLE_FLAG_INHERIT};

    #[test]
    fn passive_socket_is_not_inheritable_by_child_processes() {
        let _winsock = Winsock::start().unwrap();
        let stream = local_socket().unwrap();
        let mut flags = 0;
        // SAFETY: stream owns this live socket and flags is writable storage.
        assert_ne!(
            unsafe { GetHandleInformation(stream.as_raw_socket() as _, &mut flags) },
            0
        );
        assert_eq!(
            flags & HANDLE_FLAG_INHERIT,
            0,
            "probe socket leaks into child processes"
        );
    }
}
