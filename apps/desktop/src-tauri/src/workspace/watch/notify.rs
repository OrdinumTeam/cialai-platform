// SPDX-License-Identifier: Apache-2.0

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use notify::event::{AccessKind, AccessMode, CreateKind, ModifyKind, RemoveKind, RenameMode};
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
    // inotify anuncia a abertura feita pelo proprio indexador, inclusive por
    // read_dir. Repassa-la como mudanca realimenta a varredura do grafo.
    // Fechamento de escrita continua sendo uma dica de alteracao concluida.
    if matches!(event.kind, EventKind::Access(_))
        && !matches!(
            event.kind,
            EventKind::Access(AccessKind::Close(AccessMode::Write))
        )
    {
        return None;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use notify::event::{DataChange, MetadataKind};

    fn registration(dir: bool) -> Registration {
        let path = std::env::temp_dir().join("cialai-watch-classifier");
        Registration {
            root: path.clone(),
            path,
            dir,
        }
    }

    #[test]
    fn ignores_read_only_access_for_files_and_directories() {
        for dir in [false, true] {
            let registration = registration(dir);
            for kind in [
                AccessKind::Any,
                AccessKind::Read,
                AccessKind::Open(AccessMode::Any),
                AccessKind::Open(AccessMode::Read),
                AccessKind::Open(AccessMode::Write),
                AccessKind::Close(AccessMode::Read),
                AccessKind::Close(AccessMode::Any),
                AccessKind::Other,
            ] {
                let event = Event::new(EventKind::Access(kind)).add_path(registration.path.clone());
                assert!(classify(7, &registration, &event).is_none(), "{kind:?}");
                if dir {
                    let child = Event::new(EventKind::Access(kind))
                        .add_path(registration.path.join("README.md"));
                    assert!(
                        classify(7, &registration, &child).is_none(),
                        "child {kind:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn preserves_mutations_and_write_completion() {
        for dir in [false, true] {
            let registration = registration(dir);
            for kind in [
                EventKind::Create(CreateKind::File),
                EventKind::Remove(RemoveKind::File),
                EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
                EventKind::Modify(ModifyKind::Data(DataChange::Content)),
                EventKind::Modify(ModifyKind::Metadata(MetadataKind::Permissions)),
                EventKind::Access(AccessKind::Close(AccessMode::Write)),
            ] {
                let event = Event::new(kind).add_path(registration.path.clone());
                let change = classify(7, &registration, &event).expect("mutation lost");
                assert_eq!(change.id, 7);
                assert_eq!(
                    change.gone,
                    matches!(
                        kind,
                        EventKind::Create(_)
                            | EventKind::Remove(_)
                            | EventKind::Modify(ModifyKind::Name(_))
                    )
                );
                if dir {
                    let child = Event::new(kind).add_path(registration.path.join("README.md"));
                    let change = classify(7, &registration, &child).expect("child mutation lost");
                    assert!(
                        !change.gone,
                        "a child mutation must not remove its watched parent"
                    );
                }
                let unrelated =
                    Event::new(kind).add_path(registration.path.with_extension("unrelated"));
                assert!(classify(7, &registration, &unrelated).is_none());
            }
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_directory_and_file_reads_stay_quiet_but_writes_notify() {
        use std::time::{Instant, SystemTime, UNIX_EPOCH};
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("cialai-watch-read-{}-{unique}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let file = root.join("README.md");
        std::fs::write(&file, "# Fixture\n").unwrap();
        let watcher = PlatformWatcher::new();
        assert!(watcher.available());
        watcher.register(1, &root, true).unwrap();
        watcher.register(2, &file, false).unwrap();
        for _ in 0..6 {
            std::fs::read_dir(&root)
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert_eq!(std::fs::read_to_string(&file).unwrap(), "# Fixture\n");
        }
        let deadline = Instant::now() + Duration::from_millis(500);
        while Instant::now() < deadline {
            assert!(
                watcher.poll(Duration::from_millis(20)).unwrap().is_empty(),
                "reading the graph must not trigger another scan"
            );
        }
        std::fs::write(&file, "# Updated\n").unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut changed = [false; 2];
        while Instant::now() < deadline && !changed.iter().all(|value| *value) {
            for change in watcher.poll(Duration::from_millis(50)).unwrap() {
                assert!(!change.gone);
                changed[(change.id - 1) as usize] = true;
            }
        }
        watcher.unregister(2);
        watcher.unregister(1);
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(
            changed,
            [true, true],
            "file and parent must still report writes"
        );
    }
}
