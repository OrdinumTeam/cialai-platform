// SPDX-License-Identifier: Apache-2.0
//! Observador de arquivos com uma API comum para as tres plataformas desktop.
//!
//! O macOS usa kqueue diretamente. Linux e Windows usam `notify`, que escolhe
//! inotify e ReadDirectoryChangesW, respectivamente. A camada comum mantem a
//! contagem de referencias, junta rajadas em 80 ms e reconhece trocas atomicas
//! do inode como `replaced`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[cfg(target_os = "macos")]
mod kqueue;
#[cfg(not(target_os = "macos"))]
mod notify;

#[cfg(target_os = "macos")]
use kqueue::PlatformWatcher;
#[cfg(not(target_os = "macos"))]
use notify::PlatformWatcher;

pub const EVENT_FS_CHANGE: &str = "fs://change";
const DEBOUNCE: Duration = Duration::from_millis(80);
const MAX_GATHER: Duration = Duration::from_millis(400);
const IDLE_TIMEOUT: Duration = Duration::from_millis(500);

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeEvent {
    pub id: u64,
    pub path: String,
    /// `changed`, `replaced` ou `removed`.
    pub kind: String,
    pub dir: bool,
}

#[derive(Clone, Copy, Debug)]
struct RawChange {
    id: u64,
    gone: bool,
}

trait Backend: Send + Sync {
    fn available(&self) -> bool;
    fn register(&self, id: u64, path: &Path, dir: bool) -> Result<(), String>;
    fn unregister(&self, id: u64);
    fn poll(&self, timeout: Duration) -> Result<Vec<RawChange>, String>;
}

struct Watched {
    path: PathBuf,
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
    backend: Arc<PlatformWatcher>,
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
        let watcher = Self {
            backend: Arc::new(PlatformWatcher::new()),
            inner: Arc::new(Mutex::new(Inner {
                next_id: 0,
                by_id: HashMap::new(),
                by_path: HashMap::new(),
            })),
            notify,
        };
        if watcher.available() {
            let runner = watcher.clone();
            thread::Builder::new()
                .name("fs-watch".into())
                .spawn(move || runner.run())
                .expect("thread do observador de arquivos");
        }
        watcher
    }

    pub fn available(&self) -> bool {
        self.backend.available()
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
        self.backend.register(id, &target, dir)?;
        guard.by_id.insert(
            id,
            Watched {
                path: target.clone(),
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
            self.backend.unregister(id);
        }
    }

    pub fn count(&self) -> usize {
        self.lock().by_id.len()
    }

    fn run(&self) {
        let mut pending = Coalescer::default();
        loop {
            let wait = if pending.is_empty() {
                IDLE_TIMEOUT
            } else {
                DEBOUNCE
            };
            let changes = match self.backend.poll(wait) {
                Ok(changes) => changes,
                Err(_) => return,
            };
            let quiet = changes.is_empty();
            for change in changes {
                pending.push(change);
            }
            if pending.ready(quiet) {
                self.flush(pending.take());
            }
        }
    }

    fn flush(&self, batch: HashMap<u64, bool>) {
        let mut out = Vec::new();
        {
            let mut guard = self.lock();
            for (id, gone) in batch {
                let Some(entry) = guard.by_id.get(&id) else {
                    continue;
                };
                let path = entry.path.clone();
                let dir = entry.dir;
                if gone {
                    self.backend.unregister(id);
                    if std::fs::symlink_metadata(&path).is_ok()
                        && self.backend.register(id, &path, dir).is_ok()
                    {
                        out.push(event(id, &path, "replaced", dir));
                    } else {
                        guard.by_id.remove(&id);
                        guard.by_path.remove(&path);
                        out.push(event(id, &path, "removed", dir));
                    }
                } else {
                    out.push(event(id, &path, "changed", dir));
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

fn event(id: u64, path: &Path, kind: &str, dir: bool) -> ChangeEvent {
    ChangeEvent {
        id,
        path: path.to_string_lossy().to_string(),
        kind: kind.into(),
        dir,
    }
}

#[derive(Default)]
struct Coalescer {
    pending: HashMap<u64, bool>,
    started: Option<Instant>,
}

impl Coalescer {
    fn is_empty(&self) -> bool {
        self.pending.is_empty()
    }

    fn push(&mut self, change: RawChange) {
        self.pending
            .entry(change.id)
            .and_modify(|gone| *gone |= change.gone)
            .or_insert(change.gone);
        self.started.get_or_insert_with(Instant::now);
    }

    fn ready(&self, quiet: bool) -> bool {
        !self.pending.is_empty()
            && (quiet
                || self
                    .started
                    .is_some_and(|started| started.elapsed() >= MAX_GATHER))
    }

    fn take(&mut self) -> HashMap<u64, bool> {
        self.started = None;
        std::mem::take(&mut self.pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn coalesces_changes_and_preserves_removal() {
        let mut pending = Coalescer::default();
        pending.push(RawChange { id: 4, gone: false });
        pending.push(RawChange { id: 4, gone: true });
        pending.push(RawChange { id: 7, gone: false });

        assert!(!pending.ready(false));
        assert!(pending.ready(true));
        let batch = pending.take();
        assert_eq!(batch.get(&4), Some(&true));
        assert_eq!(batch.get(&7), Some(&false));
        assert!(pending.is_empty());
    }

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
        assert_eq!(watcher.watch(&dir.to_string_lossy()).unwrap(), dir_id);
        assert_eq!(watcher.count(), 1);

        std::fs::write(dir.join("novo.txt"), "a").unwrap();
        let event = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(event.id, dir_id);
        assert_eq!(event.kind, "changed");
        assert!(event.dir);

        let file = dir.join("novo.txt");
        let file_id = watcher.watch(&file.to_string_lossy()).unwrap();
        std::fs::write(&file, "ab").unwrap();
        assert!(wait_for(&rx, file_id, "changed"));

        std::fs::write(dir.join("tmp.txt"), "abc").unwrap();
        std::fs::rename(dir.join("tmp.txt"), &file).unwrap();
        assert!(wait_for(&rx, file_id, "replaced"));

        std::fs::remove_file(&file).unwrap();
        assert!(wait_for(&rx, file_id, "removed"));
        assert_eq!(watcher.count(), 1);

        watcher.unwatch(dir_id);
        assert_eq!(watcher.count(), 1);
        watcher.unwatch(dir_id);
        assert_eq!(watcher.count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn wait_for(rx: &std::sync::mpsc::Receiver<ChangeEvent>, id: u64, kind: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(event) = rx.recv_timeout(Duration::from_millis(500))
                && event.id == id
                && event.kind == kind
            {
                return true;
            }
        }
        false
    }
}
