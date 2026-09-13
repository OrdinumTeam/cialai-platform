// SPDX-License-Identifier: Apache-2.0

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use notify::event::{CreateKind, ModifyKind, RemoveKind, RenameMode};
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use super::{Backend, RawChange};

struct Registration {
    path: PathBuf,
    root: PathBuf,
    dir: bool,
}

#[derive(Default)]
struct Registrations {
    by_id: HashMap<u64, Registration>,
    root_refs: HashMap<PathBuf, u32>,
}

pub(super) struct PlatformWatcher {
    watcher: Mutex<Option<RecommendedWatcher>>,
    receiver: Mutex<Receiver<notify::Result<Event>>>,
    registrations: Mutex<Registrations>,
}

impl PlatformWatcher {
    pub(super) fn new() -> Self {
        let (sender, receiver) = channel();
        let watcher = notify::recommended_watcher(move |event| {
            let _ = sender.send(event);
        })
        .ok();
        Self {
            watcher: Mutex::new(watcher),
            receiver: Mutex::new(receiver),
            registrations: Mutex::new(Registrations::default()),
        }
    }

    fn watcher(&self) -> MutexGuard<'_, Option<RecommendedWatcher>> {
        self.watcher
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn receiver(&self) -> MutexGuard<'_, Receiver<notify::Result<Event>>> {
        self.receiver
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn registrations(&self) -> MutexGuard<'_, Registrations> {
        self.registrations
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Backend for PlatformWatcher {
    fn available(&self) -> bool {
        self.watcher().is_some()
    }

    fn register(&self, id: u64, path: &Path, dir: bool) -> Result<(), String> {
        let root = watch_root(path, dir)?;
        let mut registrations = self.registrations();
        if !registrations.root_refs.contains_key(&root) {
            self.watcher()
                .as_mut()
                .ok_or_else(|| "Observador de arquivos indisponível".to_string())?
                .watch(&root, RecursiveMode::NonRecursive)
                .map_err(|error| {
                    format!("Não foi possível observar {}: {error}", root.display())
                })?;
        }
        *registrations.root_refs.entry(root.clone()).or_default() += 1;
        registrations.by_id.insert(
            id,
            Registration {
                path: path.to_path_buf(),
                root,
                dir,
            },
        );
        Ok(())
    }

    fn unregister(&self, id: u64) {
        let mut registrations = self.registrations();
        let Some(registration) = registrations.by_id.remove(&id) else {
            return;
        };
        let remove_root = match registrations.root_refs.get_mut(&registration.root) {
            Some(references) if *references > 1 => {
                *references -= 1;
                false
            }
            Some(_) => true,
            None => false,
        };
        if remove_root {
            registrations.root_refs.remove(&registration.root);
            if let Some(watcher) = self.watcher().as_mut() {
                let _ = watcher.unwatch(&registration.root);
            }
        }
    }

    fn poll(&self, timeout: Duration) -> Result<Vec<RawChange>, String> {
        let event = match self.receiver().recv_timeout(timeout) {
            Ok(event) => {
                event.map_err(|error| format!("observador de arquivos falhou: {error}"))?
            }
            Err(RecvTimeoutError::Timeout) => return Ok(Vec::new()),
            Err(RecvTimeoutError::Disconnected) => {
                return Err("observador de arquivos encerrou".to_string());
            }
        };
        let registrations = self.registrations();
        Ok(registrations
            .by_id
            .iter()
            .filter_map(|(id, registration)| classify(*id, registration, &event))
            .collect())
    }
}

fn watch_root(path: &Path, dir: bool) -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    if !dir {
        return path
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| "Arquivo sem pasta pai".to_string());
    }
    let _ = dir;
    Ok(path.to_path_buf())
}

fn classify(id: u64, registration: &Registration, event: &Event) -> Option<RawChange> {
    let relevant = if registration.dir {
        event.paths.iter().any(|path| {
            path == &registration.path || path.parent() == Some(registration.path.as_path())
        })
    } else {
        event.paths.iter().any(|path| path == &registration.path)
    };
    if !relevant {
        return None;
    }
    let gone = matches!(
        event.kind,
        EventKind::Remove(RemoveKind::Any | RemoveKind::File | RemoveKind::Folder)
            | EventKind::Create(CreateKind::File | CreateKind::Any)
            | EventKind::Modify(ModifyKind::Name(
                RenameMode::Any
                    | RenameMode::From
                    | RenameMode::To
                    | RenameMode::Both
                    | RenameMode::Other
            ))
    ) && (!registration.dir
        || event.paths.iter().any(|path| path == &registration.path));
    Some(RawChange { id, gone })
}
