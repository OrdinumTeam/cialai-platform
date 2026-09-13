// SPDX-License-Identifier: Apache-2.0

use std::collections::HashMap;
use std::ffi::CString;
use std::os::raw::c_void;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use super::{Backend, RawChange};

const VNODE_FLAGS: u32 = libc::NOTE_WRITE
    | libc::NOTE_DELETE
    | libc::NOTE_RENAME
    | libc::NOTE_ATTRIB
    | libc::NOTE_EXTEND;

pub(super) struct PlatformWatcher {
    kq: i32,
    descriptors: Mutex<HashMap<u64, i32>>,
}

impl PlatformWatcher {
    pub(super) fn new() -> Self {
        // SAFETY: kqueue nao recebe argumentos; -1 indica indisponibilidade.
        let kq = unsafe { libc::kqueue() };
        Self {
            kq,
            descriptors: Mutex::new(HashMap::new()),
        }
    }

    fn descriptors(&self) -> MutexGuard<'_, HashMap<u64, i32>> {
        self.descriptors
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Backend for PlatformWatcher {
    fn available(&self) -> bool {
        self.kq >= 0
    }

    fn register(&self, id: u64, path: &Path, _dir: bool) -> Result<(), String> {
        let c_path = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| "Caminho inválido".to_string())?;
        // SAFETY: caminho C valido; O_EVTONLY abre apenas para eventos.
        let fd = unsafe { libc::open(c_path.as_ptr(), libc::O_EVTONLY | libc::O_CLOEXEC) };
        if fd < 0 {
            return Err(format!("Não foi possível observar {}", path.display()));
        }
        let change = libc::kevent {
            ident: fd as libc::uintptr_t,
            filter: libc::EVFILT_VNODE,
            flags: libc::EV_ADD | libc::EV_CLEAR,
            fflags: VNODE_FLAGS,
            data: 0,
            udata: id as *mut c_void,
        };
        // SAFETY: um registro valido, sem lista de saida.
        let status = unsafe {
            libc::kevent(
                self.kq,
                &change,
                1,
                std::ptr::null_mut(),
                0,
                std::ptr::null(),
            )
        };
        if status < 0 {
            close(fd);
            return Err(format!("kqueue recusou {}", path.display()));
        }
        self.descriptors().insert(id, fd);
        Ok(())
    }

    fn unregister(&self, id: u64) {
        if let Some(fd) = self.descriptors().remove(&id) {
            close(fd);
        }
    }

    fn poll(&self, timeout: Duration) -> Result<Vec<RawChange>, String> {
        let mut events: [libc::kevent; 64] = unsafe { std::mem::zeroed() };
        let timeout = libc::timespec {
            tv_sec: timeout.as_secs() as libc::time_t,
            tv_nsec: timeout.subsec_nanos() as libc::c_long,
        };
        // SAFETY: buffer e timeout sao validos durante a chamada.
        let received = unsafe {
            libc::kevent(
                self.kq,
                std::ptr::null(),
                0,
                events.as_mut_ptr(),
                events.len() as i32,
                &timeout,
            )
        };
        if received < 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EINTR) {
                return Ok(Vec::new());
            }
            return Err(format!("kqueue falhou: {error}"));
        }
        Ok(events
            .iter()
            .take(received as usize)
            .filter(|event| event.filter == libc::EVFILT_VNODE)
            .map(|event| RawChange {
                id: event.udata as u64,
                gone: event.fflags & (libc::NOTE_DELETE | libc::NOTE_RENAME) != 0,
            })
            .collect())
    }
}

impl Drop for PlatformWatcher {
    fn drop(&mut self) {
        for fd in self.descriptors().drain().map(|(_, fd)| fd) {
            close(fd);
        }
        close(self.kq);
    }
}

fn close(fd: i32) {
    if fd >= 0 {
        // SAFETY: descritor aberto por este modulo.
        unsafe {
            libc::close(fd);
        }
    }
}
