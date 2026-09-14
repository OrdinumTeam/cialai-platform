// SPDX-License-Identifier: Apache-2.0
//! Read-only file access rooted in a subscribed terminal's project directory.

use serde::Serialize;
use std::ffi::OsStr;
#[cfg(unix)]
use std::ffi::{CStr, CString};
#[cfg(unix)]
use std::fs::File;
#[cfg(unix)]
use std::io::Read;
#[cfg(unix)]
use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
#[cfg(unix)]
use std::os::unix::ffi::OsStrExt as _;
#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::path::{Component, Path};

const MAX_ENTRIES: usize = 200;
const MAX_TEXT: u64 = 128 * 1024;

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub kind: String,
    pub size: u64,
}
#[derive(Serialize)]
pub struct Listing {
    pub path: String,
    pub entries: Vec<Entry>,
    pub truncated: bool,
}
#[derive(Serialize)]
pub struct Text {
    pub path: String,
    pub content: String,
    pub size: u64,
}

fn denied() -> String {
    crate::i18n::t("native.error.mobileFileDenied")
}

fn secret(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with('.')
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
        || name.starts_with("id_ecdsa")
        || name.starts_with("id_dsa")
        || name.contains("credential")
        || name.contains("secret")
        || name.contains("token")
        || name.contains("service-account")
        || name.contains("service_account")
        || name.contains("password")
        || name.contains("private_key")
        || name.contains("private-key")
        || ["pem", "key", "p12", "pfx", "keystore", "kdbx"]
            .iter()
            .any(|ext| name.ends_with(&format!(".{ext}")))
}

fn relative(path: &str) -> Result<Vec<&OsStr>, String> {
    if path.len() > 4096 || path.contains('\0') || path.contains('\\') {
        return Err(denied());
    }
    Path::new(path)
        .components()
        .map(|part| match part {
            Component::Normal(name) if name.to_str().is_some_and(|name| !secret(name)) => Ok(name),
            _ => Err(denied()),
        })
        .collect()
}

#[cfg(unix)]
fn open_at(parent: i32, name: &OsStr, directory: bool) -> Result<File, String> {
    let name = CString::new(name.as_bytes()).map_err(|_| denied())?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    // SAFETY: name is NUL-terminated, parent is borrowed for this syscall;
    // ownership of a successful descriptor transfers exactly once to File.
    let fd = unsafe { libc::openat(parent, name.as_ptr(), flags) };
    if fd < 0 {
        return Err(denied());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn root(home: &Path, project_roots: &[String], cwd: &Path) -> Result<File, String> {
    if !cwd.is_absolute()
        || !crate::workspace::repos::project_roots(home, project_roots)
            .iter()
            .any(|root| cwd == root || cwd.starts_with(root))
    {
        return Err(denied());
    }
    // Open from / without canonicalizing: symlink roots and every ancestor
    // must fail instead of resolving to some other directory between checks.
    let mut dir = open_at(libc::AT_FDCWD, OsStr::new("/"), true)?;
    for part in cwd.components() {
        match part {
            Component::RootDir => {}
            Component::Normal(name) => {
                if !name.to_str().is_some_and(|name| !secret(name)) {
                    return Err(denied());
                }
                dir = open_at(dir.as_raw_fd(), name, true)?;
            }
            _ => return Err(denied()),
        }
    }
    Ok(dir)
}

#[cfg(unix)]
fn open(
    home: &Path,
    project_roots: &[String],
    cwd: &Path,
    path: &str,
    directory: bool,
) -> Result<File, String> {
    let parts = relative(path)?;
    if !directory && parts.is_empty() {
        return Err(denied());
    }
    let mut file = root(home, project_roots, cwd)?;
    for (index, name) in parts.iter().enumerate() {
        file = open_at(file.as_raw_fd(), name, directory || index + 1 < parts.len())?;
    }
    Ok(file)
}

#[cfg(unix)]
pub fn read(home: &Path, project_roots: &[String], cwd: &Path, path: &str) -> Result<Text, String> {
    let file = open(home, project_roots, cwd, path, false)?;
    let metadata = file.metadata().map_err(|_| denied())?;
    if !metadata.is_file() || metadata.nlink() != 1 || metadata.len() > MAX_TEXT {
        return Err(denied());
    }
    let mut bytes = Vec::new();
    file.take(MAX_TEXT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| denied())?;
    if bytes.len() as u64 > MAX_TEXT
        || bytes
            .iter()
            .any(|&b| b == 0 || (b < 32 && !matches!(b, b'\t' | b'\n' | b'\r')))
    {
        return Err(crate::i18n::t("native.error.mobileTextOnly"));
    }
    let content = String::from_utf8(bytes).map_err(|_| denied())?;
    if content.contains("PRIVATE KEY-----") || content.contains("PuTTY-User-Key-File:") {
        return Err(denied());
    }
    Ok(Text {
        path: path.into(),
        size: content.len() as u64,
        content,
    })
}

#[cfg(unix)]
struct Directory(*mut libc::DIR);
#[cfg(unix)]
impl Drop for Directory {
    fn drop(&mut self) {
        unsafe {
            libc::closedir(self.0);
        }
    }
}

#[cfg(unix)]
pub fn list(
    home: &Path,
    project_roots: &[String],
    cwd: &Path,
    path: &str,
) -> Result<Listing, String> {
    let file = open(home, project_roots, cwd, path, true)?;
    let fd = file.into_raw_fd();
    // SAFETY: fd is owned here. fdopendir takes it only on success.
    let raw = unsafe { libc::fdopendir(fd) };
    if raw.is_null() {
        unsafe {
            libc::close(fd);
        }
        return Err(denied());
    }
    let dir = Directory(raw);
    let mut entries = Vec::new();
    let mut truncated = false;
    loop {
        // The directory stream is local to this function, never shared.
        let entry = unsafe { libc::readdir(dir.0) };
        if entry.is_null() {
            break;
        }
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        let Ok(name) = name.to_str() else {
            continue;
        };
        if secret(name) {
            continue;
        }
        let Ok(file) = open_at(fd, OsStr::new(name), false) else {
            continue;
        };
        let Ok(metadata) = file.metadata() else {
            continue;
        };
        let kind = if metadata.is_dir() {
            "dir"
        } else if metadata.is_file() && metadata.nlink() == 1 {
            "file"
        } else {
            continue;
        };
        if entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(Entry {
            name: name.into(),
            path: if path.is_empty() {
                name.into()
            } else {
                format!("{path}/{name}")
            },
            kind: kind.into(),
            size: metadata.len(),
        });
    }
    entries.sort_by(|a, b| {
        (a.kind.as_str(), a.name.to_lowercase()).cmp(&(b.kind.as_str(), b.name.to_lowercase()))
    });
    Ok(Listing {
        path: path.into(),
        entries,
        truncated,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    use std::{fs, path::PathBuf};

    struct Fixture {
        home: PathBuf,
        cwd: PathBuf,
        roots: Vec<String>,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
            let home = std::env::temp_dir().canonicalize().unwrap().join(format!(
                "oc-mobile-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            let cwd = home.join("Projects").join("project");
            fs::create_dir_all(cwd.join("src")).unwrap();
            fs::write(cwd.join("src/main.rs"), "fn main() {}\n").unwrap();
            Self {
                home,
                cwd,
                roots: vec!["~/Projects".into()],
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.home).unwrap();
        }
    }

    #[test]
    fn mobile_files_reads_relative_text_and_blocks_escapes_and_secrets() {
        let f = Fixture::new();
        let text = read(&f.home, &f.roots, &f.cwd, "src/main.rs").unwrap();
        assert_eq!(
            (text.path.as_str(), text.content.as_str(), text.size),
            ("src/main.rs", "fn main() {}\n", 13)
        );
        fs::write(f.cwd.join(".env.local"), "synthetic fixture").unwrap();
        fs::write(f.cwd.join("credentials.json"), "synthetic fixture").unwrap();
        fs::write(f.cwd.join("id_rsa"), "synthetic fixture").unwrap();
        for path in [
            "../outside",
            "/etc/passwd",
            "src/../../outside",
            ".env.local",
            "credentials.json",
            "id_rsa",
        ] {
            assert!(
                read(&f.home, &f.roots, &f.cwd, path).is_err(),
                "accepted {path}"
            );
        }
        let listing = list(&f.home, &f.roots, &f.cwd, "").unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(
            (
                listing.entries[0].path.as_str(),
                listing.entries[0].kind.as_str()
            ),
            ("src", "dir")
        );
        assert!(read(&f.home, &f.roots, &f.home, "src/main.rs").is_err());
    }

    #[test]
    fn mobile_files_rejects_symlink_roots_components_and_leaves() {
        let f = Fixture::new();
        symlink(f.cwd.join("src"), f.cwd.join("linked")).unwrap();
        symlink(f.cwd.join("src/main.rs"), f.cwd.join("alias.rs")).unwrap();
        assert!(read(&f.home, &f.roots, &f.cwd, "linked/main.rs").is_err());
        assert!(read(&f.home, &f.roots, &f.cwd, "alias.rs").is_err());
        assert!(list(&f.home, &f.roots, &f.cwd.join("linked"), "").is_err());
        assert_eq!(
            list(&f.home, &f.roots, &f.cwd, "").unwrap().entries.len(),
            1
        );
        let root = f.cwd.parent().unwrap();
        symlink(&f.cwd, root.join("alias-project")).unwrap();
        assert!(list(&f.home, &f.roots, &root.join("alias-project"), "").is_err());
    }

    #[test]
    fn mobile_files_bounds_listing_and_text_and_rejects_binary() {
        let f = Fixture::new();
        for i in 0..205 {
            fs::write(f.cwd.join(format!("file-{i}")), "ok").unwrap();
        }
        let listing = list(&f.home, &f.roots, &f.cwd, "").unwrap();
        assert_eq!(listing.entries.len(), 200);
        assert!(listing.truncated);
        fs::write(f.cwd.join("large.txt"), vec![b'a'; 131_073]).unwrap();
        assert!(read(&f.home, &f.roots, &f.cwd, "large.txt").is_err());
        fs::write(f.cwd.join("binary.dat"), b"one\0two").unwrap();
        assert!(read(&f.home, &f.roots, &f.cwd, "binary.dat").is_err());
        fs::write(
            f.cwd.join("key.txt"),
            "-----BEGIN PRIVATE KEY-----\nfixture",
        )
        .unwrap();
        assert!(read(&f.home, &f.roots, &f.cwd, "key.txt").is_err());
    }

    #[test]
    fn mobile_files_blocks_service_account_credentials() {
        let f = Fixture::new();
        for name in [
            "service-account.json",
            "service_account.json",
            "passwords.txt",
        ] {
            fs::write(f.cwd.join(name), "synthetic fixture").unwrap();
            assert!(
                read(&f.home, &f.roots, &f.cwd, name).is_err(),
                "accepted {name}"
            );
        }
    }

    #[test]
    fn mobile_files_symlink_replacement_never_reads_outside_data() {
        let f = Fixture::new();
        let outside = f.home.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("main.rs"), "outside fixture").unwrap();
        let cwd = f.cwd.clone();
        let writer = std::thread::spawn(move || {
            for _ in 0..100 {
                fs::rename(cwd.join("src"), cwd.join("saved")).unwrap();
                symlink(&outside, cwd.join("src")).unwrap();
                fs::remove_file(cwd.join("src")).unwrap();
                fs::rename(cwd.join("saved"), cwd.join("src")).unwrap();
            }
        });
        let mut escaped = false;
        for _ in 0..200 {
            if let Ok(text) = read(&f.home, &f.roots, &f.cwd, "src/main.rs") {
                escaped |= text.content != "fn main() {}\n";
            }
        }
        writer.join().unwrap();
        assert!(!escaped);
    }

    #[test]
    fn mobile_files_follow_the_live_project_roots_list() {
        let f = Fixture::new();
        assert!(list(&f.home, &["~/elsewhere".into()], &f.cwd, "").is_err());
        assert!(list(&f.home, &f.roots, &f.home.join("Projects"), "").is_ok());
    }
}

#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
pub use windows::{list, read};
