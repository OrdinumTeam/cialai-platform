// SPDX-License-Identifier: Apache-2.0
use super::*;

const MARKER: &str = "cialai-command-native-v3";
const SOURCE: &[u8] = include_bytes!("../../binaries/cialai-command-x86_64-pc-windows-msvc.exe");

fn ours(bytes: &[u8]) -> bool {
    bytes
        .windows(MARKER.len())
        .any(|part| part == MARKER.as_bytes())
}

fn descriptor_ours(bytes: &[u8]) -> bool {
    serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .is_some_and(|value| value["marker"] == MARKER)
}

fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        error.to_string()
    })
}

fn install_files(
    home: &Path,
    config: &Path,
    launcher: &Path,
    forced: bool,
) -> Result<CliReport, String> {
    let directory = command_dir(home, Target::Windows);
    let path = directory.join("cialai.exe");
    let descriptor = directory.join("cialai-command.json");
    let wanted = serde_json::to_vec_pretty(&serde_json::json!({
        "marker": MARKER,
        "launcher": launcher,
        "sidecar": sidecar_from(launcher, Target::Windows),
    }))
    .map_err(|error| error.to_string())?;
    let existing = fs::read(&path).ok();
    let old_descriptor = fs::read(&descriptor).ok();
    for (file, contents, managed) in [
        (
            &path,
            existing.as_deref(),
            existing.as_deref().is_some_and(ours),
        ),
        (
            &descriptor,
            old_descriptor.as_deref(),
            old_descriptor.as_deref().is_some_and(descriptor_ours),
        ),
    ] {
        if contents.is_some() && !managed {
            if !forced {
                return Ok(CliReport::new("kept", &path, &directory));
            }
            backup(file)?;
        }
    }
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let changed =
        existing.as_deref() != Some(SOURCE) || old_descriptor.as_deref() != Some(wanted.as_slice());
    if existing.as_deref() != Some(SOURCE) {
        write_bytes(&path, SOURCE)?;
    }
    if old_descriptor.as_deref() != Some(wanted.as_slice()) {
        write_bytes(&descriptor, &wanted)?;
    }
    // Only remove a managed legacy batch file after the native command is ready.
    let legacy = directory.join("cialai.cmd");
    if fs::read_to_string(&legacy)
        .ok()
        .is_some_and(|body| is_ours(&body))
    {
        fs::remove_file(legacy).map_err(|error| error.to_string())?;
    }
    if forced {
        let _ = fs::remove_file(config.join(TOMBSTONE));
    }
    Ok(CliReport::new(
        if changed { "installed" } else { "unchanged" },
        &path,
        &directory,
    ))
}

pub(super) fn install(
    home: &Path,
    config: &Path,
    launcher: &Path,
    forced: bool,
) -> Result<CliReport, String> {
    let mut report = install_files(home, config, launcher, forced)?;
    if report.state != "kept" {
        report.needs_new_terminal = windows_path_add(&command_dir(home, Target::Windows))?;
    }
    Ok(report)
}

pub(super) fn uninstall(home: &Path, config: &Path) -> Result<CliReport, String> {
    let directory = command_dir(home, Target::Windows);
    let path = directory.join("cialai.exe");
    if let Ok(contents) = fs::read(&path) {
        if !ours(&contents) {
            return Ok(CliReport::new("kept", &path, &directory));
        }
        fs::remove_file(&path).map_err(|error| error.to_string())?;
    }
    let descriptor = directory.join("cialai-command.json");
    if fs::read(&descriptor)
        .ok()
        .is_some_and(|contents| descriptor_ours(&contents))
    {
        fs::remove_file(descriptor).map_err(|error| error.to_string())?;
    }
    let legacy = directory.join("cialai.cmd");
    if fs::read_to_string(&legacy)
        .ok()
        .is_some_and(|body| is_ours(&body))
    {
        fs::remove_file(legacy).map_err(|error| error.to_string())?;
    }
    windows_path_remove(&directory)?;
    fs::create_dir_all(config).map_err(|error| error.to_string())?;
    fs::write(config.join(TOMBSTONE), CLI_MARKER).map_err(|error| error.to_string())?;
    Ok(CliReport::new("disabled", &path, &directory))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_command_migrates_only_managed_batch_and_preserves_custom_files() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path();
        let config = home.join("config");
        let launcher = home.join("app/cialai-desktop.exe");
        let directory = command_dir(home, Target::Windows);
        fs::create_dir_all(&directory).unwrap();
        let legacy = directory.join("cialai.cmd");
        fs::write(&legacy, "rem cialai-command v2\r\n").unwrap();
        assert_eq!(
            install_files(home, &config, &launcher, false)
                .unwrap()
                .state,
            "installed"
        );
        assert_eq!(fs::read(directory.join("cialai.exe")).unwrap(), SOURCE);
        assert!(!legacy.exists());
        assert_eq!(
            install_files(home, &config, &launcher, false)
                .unwrap()
                .state,
            "unchanged"
        );
        fs::write(&legacy, "rem custom file\r\n").unwrap();
        fs::write(directory.join("cialai.exe"), b"foreign executable").unwrap();
        assert_eq!(
            install_files(home, &config, &launcher, false)
                .unwrap()
                .state,
            "kept"
        );
        assert_eq!(
            fs::read(directory.join("cialai.exe")).unwrap(),
            b"foreign executable"
        );
        assert!(legacy.exists());
        assert_eq!(
            install_files(home, &config, &launcher, true).unwrap().state,
            "installed"
        );
        assert!(legacy.exists());
    }
}
