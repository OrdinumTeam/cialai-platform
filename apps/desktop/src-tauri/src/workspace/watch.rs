// SPDX-License-Identifier: Apache-2.0
//! Observador de arquivos por kqueue, sem crate extra. Cada pasta expandida
//! no explorador e cada arquivo aberto no editor viram um descritor aberto
//! com `O_EVTONLY` e um filtro `EVFILT_VNODE`. Uma thread espera os eventos,
//! junta os que chegam em 80 ms e avisa o webview pelo evento `fs://change`.
//!
//! Observar o mesmo caminho duas vezes reaproveita o mesmo descritor, com
//! contagem de referencias, entao duas sessoes na mesma pasta nao dobram o
//! custo. Um arquivo salvo por troca atomica, como fazem muitos editores,
//! chega como `NOTE_RENAME` ou `NOTE_DELETE` no inode antigo: se o caminho
//! continua existindo, o descritor e reaberto por baixo e o evento sai como
//! `replaced`; se sumiu, sai como `removed` e a observacao termina.

use std::collections::HashMap;
use std::ffi::CString;
use std::os::raw::c_void;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const EVENT_FS_CHANGE: &str = "fs://change";
const DEBOUNCE: Duration = Duration::from_millis(80);
const MAX_GATHER: Duration = Duration::from_millis(400);
const IDLE_TIMEOUT: Duration = Duration::from_millis(500);
const VNODE_FLAGS: u32 = libc::NOTE_WRITE
    | libc::NOTE_DELETE
    | libc::NOTE_RENAME
    | libc::NOTE_ATTRIB
    | libc::NOTE_EXTEND;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub id: u64,
    pub path: String,
    /// `changed`, `replaced` ou `removed`.
    pub kind: String,
    pub dir: bool,
}

struct Watched {
    path: PathBuf,
    fd: i32,
    refs: u32,
    dir: bool,
}

struct Inner {
    next_id: u64,
    by_id: HashMap<u64, Watched>,
    by_path: HashMap<PathBuf, u64>,
}

type Notifier = Arc<dyn Fn(ChangeEvent) + Send + Sync>;

#[derive(Clone)]
pub struct Watcher {
    kq: i32,
    inner: Arc<Mutex<Inner>>,
    notify: Notifier,
}

impl Watcher {
    pub fn new(app: AppHandle) -> Self {
        Self::with_notifier(Arc::new(move |event| {
            let _ = app.emit(EVENT_FS_CHANGE, event);
        }))
    }

    fn with_notifier(notify: Notifier) -> Self {
        // SAFETY: kqueue() nao recebe argumentos; -1 e tratado abaixo.
        let kq = unsafe { libc::kqueue() };
        let watcher = Self {
            kq,
            inner: Arc::new(Mutex::new(Inner {
                next_id: 0,
                by_id: HashMap::new(),
                by_path: HashMap::new(),
            })),
            notify,
        };
        if kq >= 0 {
            let runner = watcher.clone();
            thread::Builder::new()
                .name("fs-watch".into())
                .spawn(move || runner.run())
                .expect("thread do observador de arquivos");
        }
        watcher
    }

    pub fn available(&self) -> bool {
        self.kq >= 0
    }

    /// Passa a observar um caminho. Devolve o identificador, reaproveitado
    /// quando o caminho ja estava sendo observado.
    pub fn watch(&self, path: &str) -> Result<u64, String> {
        if !self.available() {
            return Err("Observador de arquivos indisponível".to_string());
        }
        let target = PathBuf::from(path);
        if !target.is_absolute() {
            return Err("Caminho precisa ser absoluto".to_string());
        }
        let mut guard = self.lock();
        if let Some(id) = guard.by_path.get(&target).copied() {
            if let Some(entry) = guard.by_id.get_mut(&id) {
                entry.refs += 1;
                return Ok(id);
            }
        }
        let dir = target.is_dir();
        guard.next_id += 1;
        let id = guard.next_id;
        let fd = self.register(&target, id)?;
        guard.by_id.insert(
            id,
            Watched {
                path: target.clone(),
                fd,
                refs: 1,
                dir,
            },
        );
        guard.by_path.insert(target, id);
        Ok(id)
    }

    pub fn unwatch(&self, id: u64) {
        let mut guard = self.lock();
        let Some(entry) = guard.by_id.get_mut(&id) else {
            return;
        };
        entry.refs = entry.refs.saturating_sub(1);
        if entry.refs > 0 {
            return;
        }
        if let Some(entry) = guard.by_id.remove(&id) {
            guard.by_path.remove(&entry.path);
            close(entry.fd);
        }
    }

    pub fn count(&self) -> usize {
        self.lock().by_id.len()
    }

    fn register(&self, path: &Path, id: u64) -> Result<i32, String> {
        let c_path = CString::new(path.to_string_lossy().as_bytes())
            .map_err(|_| "Caminho inválido".to_string())?;
        // SAFETY: caminho C valido; O_EVTONLY abre so para receber eventos.
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
        // SAFETY: um unico registro valido, sem lista de saida.
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
        Ok(fd)
    }

    fn run(&self) {
        let mut events: Vec<libc::kevent> =
            (0..64).map(|_| unsafe { std::mem::zeroed() }).collect();
        let mut pending: HashMap<u64, u32> = HashMap::new();
        let mut gather_started: Option<Instant> = None;
        loop {
            let wait = if pending.is_empty() {
                IDLE_TIMEOUT
            } else {
                DEBOUNCE
            };
            let timeout = libc::timespec {
                tv_sec: wait.as_secs() as libc::time_t,
                tv_nsec: wait.subsec_nanos() as libc::c_long,
            };
            // SAFETY: buffer de 64 eventos zerados e timeout valido.
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
                let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
                if errno == libc::EINTR {
                    continue;
                }
                break;
            }
            for event in events.iter().take(received as usize) {
                if event.filter != libc::EVFILT_VNODE {
                    continue;
                }
                let id = event.udata as u64;
                *pending.entry(id).or_insert(0) |= event.fflags;
                gather_started.get_or_insert_with(Instant::now);
            }
            let quiet = received == 0;
            let long_enough = gather_started
                .map(|at| at.elapsed() >= MAX_GATHER)
                .unwrap_or(false);
            if !pending.is_empty() && (quiet || long_enough) {
                let batch = std::mem::take(&mut pending);
                gather_started = None;
                self.flush(batch);
            }
        }
    }

    fn flush(&self, batch: HashMap<u64, u32>) {
        let mut out = Vec::new();
        {
            let mut guard = self.lock();
            for (id, flags) in batch {
                let Some(entry) = guard.by_id.get_mut(&id) else {
                    continue;
                };
                let gone = flags & (libc::NOTE_DELETE | libc::NOTE_RENAME) != 0;
                let path = entry.path.clone();
                let dir = entry.dir;
                if gone {
                    if std::fs::symlink_metadata(&path).is_ok() {
                        // Trocado por outro inode: reabre por baixo.
                        close(entry.fd);
                        match self.register(&path, id) {
                            Ok(fd) => {
                                entry.fd = fd;
                                out.push(ChangeEvent {
                                    id,
                                    path: path.to_string_lossy().to_string(),
                                    kind: "replaced".into(),
                                    dir,
                                });
                            }
                            Err(_) => {
                                guard.by_id.remove(&id);
                                guard.by_path.remove(&path);
                                out.push(ChangeEvent {
                                    id,
                                    path: path.to_string_lossy().to_string(),
                                    kind: "removed".into(),
                                    dir,
                                });
                            }
                        }
                    } else {
                        let removed = guard.by_id.remove(&id);
                        guard.by_path.remove(&path);
                        if let Some(removed) = removed {
                            close(removed.fd);
                        }
                        out.push(ChangeEvent {
                            id,
                            path: path.to_string_lossy().to_string(),
                            kind: "removed".into(),
                            dir,
                        });
                    }
                } else {
                    out.push(ChangeEvent {
                        id,
                        path: path.to_string_lossy().to_string(),
                        kind: "changed".into(),
                        dir,
                    });
                }
            }
        }
        for event in out {
            (self.notify)(event);
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn close(fd: i32) {
    if fd >= 0 {
        // SAFETY: descritor aberto por este modulo; fechar remove o knote.
        unsafe {
            libc::close(fd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn reports_changes_replacements_and_removals() {
        let dir = std::env::temp_dir().join(format!("oc-watch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (tx, rx) = channel::<ChangeEvent>();
        let watcher = Watcher::with_notifier(Arc::new(move |event| {
            let _ = tx.send(event);
        }));
        assert!(watcher.available());

        let dir_id = watcher.watch(&dir.to_string_lossy()).unwrap();
        assert_eq!(
            watcher.watch(&dir.to_string_lossy()).unwrap(),
            dir_id,
            "mesmo caminho, mesmo id"
        );
        assert_eq!(watcher.count(), 1);

        std::fs::write(dir.join("novo.txt"), "a").unwrap();
        let event = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("criacao na pasta");
        assert_eq!(event.id, dir_id);
        assert_eq!(event.kind, "changed");
        assert!(event.dir);

        let file = dir.join("novo.txt");
        let file_id = watcher.watch(&file.to_string_lossy()).unwrap();
        std::fs::write(&file, "ab").unwrap();
        let mut saw_file_change = false;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(event) = rx.recv_timeout(Duration::from_millis(500)) {
                if event.id == file_id && event.kind == "changed" {
                    saw_file_change = true;
                    break;
                }
            }
        }
        assert!(saw_file_change, "escrita no arquivo observado");

        // Troca atomica: o caminho continua existindo com outro inode.
        std::fs::write(dir.join("tmp.txt"), "abc").unwrap();
        std::fs::rename(dir.join("tmp.txt"), &file).unwrap();
        let mut saw_replaced = false;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(event) = rx.recv_timeout(Duration::from_millis(500)) {
                if event.id == file_id && event.kind == "replaced" {
                    saw_replaced = true;
                    break;
                }
            }
        }
        assert!(saw_replaced, "troca atomica vira replaced");

        std::fs::remove_file(&file).unwrap();
        let mut saw_removed = false;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(event) = rx.recv_timeout(Duration::from_millis(500)) {
                if event.id == file_id && event.kind == "removed" {
                    saw_removed = true;
                    break;
                }
            }
        }
        assert!(saw_removed, "arquivo apagado vira removed");
        assert_eq!(
            watcher.count(),
            1,
            "a observacao do arquivo termina sozinha"
        );

        watcher.unwatch(dir_id);
        assert_eq!(watcher.count(), 1, "a segunda referencia segura a pasta");
        watcher.unwatch(dir_id);
        assert_eq!(watcher.count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
