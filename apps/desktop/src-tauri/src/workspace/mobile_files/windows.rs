// SPDX-License-Identifier: Apache-2.0
//! Windows implementation that opens every target as a reparse point first,
//! then checks the final handle path before reading any bytes.

use std::fs::{self, File};
use std::io::Read;
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::io::FromRawHandle as _;
use std::path::{Path, PathBuf};

use windows_sys::Win32::Foundation::{GENERIC_READ, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
    FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_NAME_NORMALIZED, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
    GetFileInformationByHandle, GetFinalPathNameByHandleW, OPEN_EXISTING, VOLUME_NAME_DOS,
};

use super::{Entry, Listing, MAX_ENTRIES, MAX_TEXT, Text, denied, relative, secret};

struct Opened {
    file: File,
    final_path: PathBuf,
    info: BY_HANDLE_FILE_INFORMATION,
}

fn wide(path: &Path) -> Vec<u16> {
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn final_path(handle: windows_sys::Win32::Foundation::HANDLE) -> Result<PathBuf, String> {
    let mut buffer = vec![0_u16; 32_768];
    // SAFETY: the handle is open and the writable buffer has the advertised size.
    let length = unsafe {
        GetFinalPathNameByHandleW(
            handle,
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            FILE_NAME_NORMALIZED | VOLUME_NAME_DOS,
        )
    };
    if length == 0 || length as usize >= buffer.len() {
        return Err(denied());
    }
    buffer.truncate(length as usize);
    Ok(PathBuf::from(
        String::from_utf16(&buffer).map_err(|_| denied())?,
    ))
}

fn open_raw(path: &Path, directory: bool) -> Result<Opened, String> {
    let encoded = wide(path);
    // FILE_FLAG_OPEN_REPARSE_POINT is essential: the final component is
    // inspected, never followed. Intermediate traversal is checked through
    // the canonical path attached to the returned handle below.
    let handle = unsafe {
        CreateFileW(
            encoded.as_ptr(),
            GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(denied());
    }
    // SAFETY: ownership of the valid handle moves exactly once into File.
    let file = unsafe { File::from_raw_handle(handle) };
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: both the File handle and output structure are valid here.
    if unsafe { GetFileInformationByHandle(handle, &mut info) } == 0
        || info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || directory != (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0)
    {
        return Err(denied());
    }
    let final_path = final_path(handle)?;
    Ok(Opened {
        file,
        final_path,
        info,
    })
}

fn path_key(path: &Path) -> String {
    crate::platform::to_portable(path)
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn contained(root: &Path, target: &Path) -> bool {
    let root = path_key(root);
    let target = path_key(target);
    target == root
        || target
            .strip_prefix(&root)
            .is_some_and(|tail| tail.starts_with('/'))
}

fn checked_cwd(home: &Path, project_roots: &[String], cwd: &Path) -> Result<Opened, String> {
    if !cwd.is_absolute()
        || !crate::workspace::repos::project_roots(home, project_roots)
            .iter()
            .any(|root| cwd == root || cwd.starts_with(root))
    {
        return Err(denied());
    }
    let opened = open_raw(cwd, true)?;
    let permitted = crate::workspace::repos::project_roots(home, project_roots)
        .into_iter()
        .filter_map(|root| open_raw(&root, true).ok())
        .any(|root| contained(&root.final_path, &opened.final_path));
    if !permitted {
        return Err(denied());
    }
    Ok(opened)
}

fn open(
    home: &Path,
    project_roots: &[String],
    cwd: &Path,
    path: &str,
    directory: bool,
) -> Result<Opened, String> {
    let parts = relative(path)?;
    if !directory && parts.is_empty() {
        return Err(denied());
    }
    let cwd_handle = checked_cwd(home, project_roots, cwd)?;
    let mut target = cwd.to_path_buf();
    target.extend(parts);
    let opened = open_raw(&target, directory)?;
    if !contained(&cwd_handle.final_path, &opened.final_path) {
        return Err(denied());
    }
    Ok(opened)
}

pub fn read(home: &Path, project_roots: &[String], cwd: &Path, path: &str) -> Result<Text, String> {
    let opened = open(home, project_roots, cwd, path, false)?;
    let size = (u64::from(opened.info.nFileSizeHigh) << 32) | u64::from(opened.info.nFileSizeLow);
    if opened.info.nNumberOfLinks != 1 || size > MAX_TEXT {
        return Err(denied());
    }
    let mut bytes = Vec::new();
    opened
        .file
        .take(MAX_TEXT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| denied())?;
    if bytes.len() as u64 > MAX_TEXT
        || bytes
            .iter()
            .any(|&byte| byte == 0 || (byte < 32 && !matches!(byte, b'\t' | b'\n' | b'\r')))
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

pub fn list(
    home: &Path,
    project_roots: &[String],
    cwd: &Path,
    path: &str,
) -> Result<Listing, String> {
    let directory = open(home, project_roots, cwd, path, true)?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for entry in fs::read_dir(&directory.final_path)
        .map_err(|_| denied())?
        .flatten()
    {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if secret(&name) {
            continue;
        }
        let relative_path = if path.is_empty() {
            name.clone()
        } else {
            format!("{path}/{name}")
        };
        let opened = open(
            home,
            project_roots,
            cwd,
            &relative_path,
            entry.path().is_dir(),
        );
        let Ok(opened) = opened else {
            continue;
        };
        let directory = opened.info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
        if !directory && opened.info.nNumberOfLinks != 1 {
            continue;
        }
        if entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        entries.push(Entry {
            name,
            path: relative_path,
            kind: if directory { "dir" } else { "file" }.into(),
            size: (u64::from(opened.info.nFileSizeHigh) << 32)
                | u64::from(opened.info.nFileSizeLow),
        });
    }
    entries.sort_by(|left, right| {
        (left.kind.as_str(), left.name.to_lowercase())
            .cmp(&(right.kind.as_str(), right.name.to_lowercase()))
    });
    Ok(Listing {
        path: path.into(),
        entries,
        truncated,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Fixture {
        home: PathBuf,
        cwd: PathBuf,
        roots: Vec<String>,
    }

    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(1);
            let home = std::env::temp_dir().join(format!(
                "cialai-mobile-files-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            let cwd = home.join("Projects").join("project");
            fs::create_dir_all(cwd.join("src")).unwrap();
            fs::write(cwd.join("src").join("main.rs"), "fn main() {}\n").unwrap();
            Self {
                home,
                cwd,
                roots: vec!["~/Projects".into()],
            }
        }

        fn list(&self, path: &str) -> Result<Listing, String> {
            list(&self.home, &self.roots, &self.cwd, path)
        }

        fn read(&self, path: &str) -> Result<Text, String> {
            read(&self.home, &self.roots, &self.cwd, path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.home);
        }
    }

    fn names(listing: &Listing) -> Vec<(&str, &str)> {
        listing
            .entries
            .iter()
            .map(|entry| (entry.name.as_str(), entry.kind.as_str()))
            .collect()
    }

    #[test]
    fn lists_and_reads_text_inside_the_project() {
        let f = Fixture::new();
        assert_eq!(names(&f.list("").unwrap()), vec![("src", "dir")]);
        let src = f.list("src").unwrap();
        assert_eq!(names(&src), vec![("main.rs", "file")]);
        assert_eq!(src.entries[0].path, "src/main.rs");
        assert_eq!(src.entries[0].size, 13);
        let text = f.read("src/main.rs").unwrap();
        assert_eq!((text.content.as_str(), text.size), ("fn main() {}\n", 13));
        fs::write(f.cwd.join("data.bin"), [0_u8, 1, 2]).unwrap();
        assert!(f.read("data.bin").is_err());
    }

    #[test]
    fn hides_secrets_and_refuses_escapes_and_foreign_roots() {
        let f = Fixture::new();
        fs::write(f.cwd.join(".env"), "TOKEN=x\n").unwrap();
        fs::write(f.cwd.join("id_rsa"), "key\n").unwrap();
        fs::write(f.home.join("outside.txt"), "outside\n").unwrap();
        assert_eq!(names(&f.list("").unwrap()), vec![("src", "dir")]);
        for path in [
            ".env",
            "id_rsa",
            "../outside.txt",
            "src\\main.rs",
            "",
            "C:/Windows/win.ini",
        ] {
            assert!(f.read(path).is_err(), "{path} should be denied");
        }
        assert!(list(&f.home, &["~/elsewhere".into()], &f.cwd, "").is_err());
        assert!(list(&f.home, &f.roots, &f.home.join("Projects"), "").is_ok());
    }

    #[test]
    fn refuses_hard_links_and_links_that_leave_the_project() {
        let f = Fixture::new();
        let outside = f.home.join("outside.txt");
        fs::write(&outside, "outside\n").unwrap();
        fs::hard_link(&outside, f.cwd.join("linked.txt")).unwrap();
        assert!(f.read("linked.txt").is_err());
        assert_eq!(names(&f.list("").unwrap()), vec![("src", "dir")]);

        // Criar links simbolicos exige privilegio; o runner da CI tem, uma
        // maquina comum pode nao ter, e ai so os hard links sao conferidos.
        if std::os::windows::fs::symlink_file(&outside, f.cwd.join("alias.txt")).is_ok() {
            assert!(f.read("alias.txt").is_err());
        }
        let door = f.home.join("outside-dir");
        fs::create_dir_all(&door).unwrap();
        fs::write(door.join("inside.txt"), "outside\n").unwrap();
        if std::os::windows::fs::symlink_dir(&door, f.cwd.join("door")).is_ok() {
            assert!(f.list("door").is_err());
            assert!(f.read("door/inside.txt").is_err());
        }
        assert_eq!(names(&f.list("").unwrap()), vec![("src", "dir")]);
    }
}
