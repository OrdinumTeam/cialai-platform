// SPDX-License-Identifier: Apache-2.0
//! Ambiente e pasta dos processos filhos quando o app roda de um AppImage.
//!
//! O `AppRun` do AppImage e o hook do `linuxdeploy-plugin-gtk` exportam
//! variaveis que servem so ao proprio app: `PATH` e `LD_LIBRARY_PATH` com o
//! bundle na frente, `PYTHONHOME` apontando para dentro dele, o GTK embutido e
//! afins. Herdadas por um shell, quebram `python`, `git` por HTTPS, `curl`,
//! `pacman` e os agentes abertos nos terminais. O `AppRun` tambem entra em
//! `$APPDIR/usr` e guarda a pasta original em `OWD`.
//!
//! [`appimage_cleanup`] e pura: recebe o ambiente e devolve as mudancas.
//! [`sanitize`] as aplica a um comando antes do spawn. Fora de um AppImage a
//! lista volta vazia e nada muda.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

use portable_pty::CommandBuilder;

/// Marcam um processo aberto por um AppImage. O runtime define as duas; o
/// `AppRun` de um AppImage extraido define so `APPDIR`.
const MARKERS: [&str; 2] = ["APPDIR", "APPIMAGE"];

/// Saem inteiras: o `AppRun` e o hook do GTK as definem com valor fixo, sem
/// guardar o do usuario, e as quatro ultimas identificam o AppImage.
const INJECTED: &[&str] = &[
    "PYTHONHOME",
    "PYTHONDONTWRITEBYTECODE",
    "GDK_BACKEND",
    "GTK_THEME",
    "GTK_PATH",
    "GTK_EXE_PREFIX",
    "GTK_DATA_PREFIX",
    "GTK_IM_MODULE_FILE",
    "GDK_PIXBUF_MODULE_FILE",
    "GIO_EXTRA_MODULES",
    "GSETTINGS_SCHEMA_DIR",
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
];

/// Listas em que o `AppRun` poe o bundle na frente do valor do usuario. Ficam
/// so as entradas de fora do bundle e nao vazias: o `AppRun` deixa `:` no fim
/// quando a variavel nao existia, e uma entrada vazia no `PATH` ou no
/// `LD_LIBRARY_PATH` vale a pasta atual. Qualquer outra variavel com entradas
/// dentro do bundle passa pelo mesmo filtro, como o `PWD` que o `AppRun` deixa
/// em `$APPDIR/usr`.
const PREPENDED: &[&str] = &[
    "PATH",
    "LD_LIBRARY_PATH",
    "XDG_DATA_DIRS",
    "PYTHONPATH",
    "PERLLIB",
    "QT_PLUGIN_PATH",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EnvChange {
    Set(OsString, OsString),
    Remove(OsString),
}

/// Mudancas que tiram de um ambiente o que o AppImage injetou. Vazia quando o
/// ambiente nao vem de um AppImage.
pub fn appimage_cleanup(env: &BTreeMap<OsString, OsString>) -> Vec<EnvChange> {
    let defined = |name: &str| {
        env.get(OsStr::new(name))
            .filter(|value| !value.is_empty())
            .map(Path::new)
    };
    if MARKERS.iter().all(|&name| defined(name).is_none()) {
        return Vec::new();
    }
    // Um APPDIR na raiz tiraria do filho todo caminho absoluto.
    let root = defined("APPDIR").filter(|root| root.parent().is_some());
    let bundled = |entry: &Path| root.is_some_and(|root| entry.starts_with(root));
    let named = |list: &[&str], name: &OsStr| list.iter().any(|item| OsStr::new(item) == name);

    let mut changes = Vec::new();
    for (name, value) in env {
        if named(INJECTED, name) {
            changes.push(EnvChange::Remove(name.clone()));
            continue;
        }
        let entries: Vec<PathBuf> = std::env::split_paths(value).collect();
        if !named(PREPENDED, name) && !entries.iter().any(|entry| bundled(entry)) {
            continue;
        }
        let kept: Vec<&PathBuf> = entries
            .iter()
            .filter(|entry| !entry.as_os_str().is_empty() && !bundled(entry))
            .collect();
        if kept.len() == entries.len() {
            continue;
        }
        if kept.is_empty() {
            changes.push(EnvChange::Remove(name.clone()));
        } else if let Ok(joined) = std::env::join_paths(kept) {
            changes.push(EnvChange::Set(name.clone(), joined));
        }
    }
    changes
}

/// Comando que recebe as mudancas antes do spawn.
pub trait ChildCommand {
    /// Ambiente que o filho receberia: o do app com as mudancas do comando.
    fn child_env(&self) -> BTreeMap<OsString, OsString>;
    fn apply(&mut self, change: EnvChange);
}

impl ChildCommand for Command {
    fn child_env(&self) -> BTreeMap<OsString, OsString> {
        let mut env: BTreeMap<OsString, OsString> = std::env::vars_os().collect();
        for (name, value) in self.get_envs() {
            match value {
                Some(value) => {
                    env.insert(name.to_owned(), value.to_owned());
                }
                None => {
                    env.remove(name);
                }
            }
        }
        env
    }

    fn apply(&mut self, change: EnvChange) {
        match change {
            EnvChange::Set(name, value) => {
                self.env(name, value);
            }
            EnvChange::Remove(name) => {
                self.env_remove(name);
            }
        }
    }
}

impl ChildCommand for CommandBuilder {
    fn child_env(&self) -> BTreeMap<OsString, OsString> {
        // O builder copia o ambiente do app ao nascer; `get_env` ja responde
        // com as mudancas feitas depois.
        let names: Vec<OsString> = std::env::vars_os()
            .map(|(name, _)| name)
            .chain(self.iter_extra_env_as_str().map(|(name, _)| name.into()))
            .collect();
        names
            .into_iter()
            .filter_map(|name| {
                let value = self.get_env(&name)?.to_owned();
                Some((name, value))
            })
            .collect()
    }

    fn apply(&mut self, change: EnvChange) {
        match change {
            EnvChange::Set(name, value) => self.env(name, value),
            EnvChange::Remove(name) => self.env_remove(name),
        }
    }
}

/// Tira do comando o ambiente do AppImage. Chamar depois de definir as
/// variaveis proprias do filho, para que o `PATH` montado tambem seja filtrado.
pub fn sanitize(command: &mut impl ChildCommand) {
    for change in appimage_cleanup(&command.child_env()) {
        command.apply(change);
    }
}

/// Pasta explicita de um PTY. Sem pasta pedida vale a pasta pessoal, ou `OWD`
/// sem ela. Uma pasta relativa e recusada: dependeria da pasta do app, que no
/// AppImage e `$APPDIR/usr`.
pub fn pty_cwd(requested: &str, home: &Path, owd: Option<&Path>) -> Option<PathBuf> {
    if requested.trim().is_empty() {
        return [Some(home), owd]
            .into_iter()
            .flatten()
            .find(|dir| dir.is_absolute() && dir.is_dir())
            .map(Path::to_path_buf);
    }
    let path = Path::new(requested);
    (path.is_absolute() && path.is_dir()).then(|| path.to_path_buf())
}

/// Pasta de onde o AppImage foi aberto, guardada pelo `AppRun`.
pub fn original_dir() -> Option<PathBuf> {
    std::env::var_os("OWD")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPDIR: &str = "/tmp/.mount_CialaiTeste";

    fn list(entries: &[&str]) -> OsString {
        std::env::join_paths(entries).unwrap()
    }

    fn bundle(rest: &str) -> String {
        format!("{APPDIR}{rest}")
    }

    fn apply(env: &mut BTreeMap<OsString, OsString>, changes: Vec<EnvChange>) {
        for change in changes {
            match change {
                EnvChange::Set(name, value) => {
                    env.insert(name, value);
                }
                EnvChange::Remove(name) => {
                    env.remove(&name);
                }
            }
        }
    }

    fn appimage_env() -> BTreeMap<OsString, OsString> {
        let mut env = BTreeMap::new();
        let mut put = |name: &str, value: OsString| {
            env.insert(OsString::from(name), value);
        };
        put("APPDIR", APPDIR.into());
        put("APPIMAGE", "/home/ana/Cialai_amd64.AppImage".into());
        put("ARGV0", "./Cialai_amd64.AppImage".into());
        put("OWD", "/home/ana/Downloads".into());
        put("PYTHONHOME", bundle("/usr/").into());
        put("PYTHONDONTWRITEBYTECODE", "1".into());
        put("GDK_BACKEND", "x11".into());
        put("GTK_THEME", "".into());
        put(
            "GTK_PATH",
            list(&[
                &bundle("//usr/lib/x86_64-linux-gnu/gtk-3.0"),
                "/usr/lib64/gtk-3.0",
            ]),
        );
        put("GTK_EXE_PREFIX", bundle("//usr").into());
        put("GTK_DATA_PREFIX", APPDIR.into());
        put(
            "GTK_IM_MODULE_FILE",
            bundle("//usr/lib/gtk-3.0/3.0.0/immodules.cache").into(),
        );
        put(
            "GDK_PIXBUF_MODULE_FILE",
            bundle("//usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache").into(),
        );
        put("GIO_EXTRA_MODULES", bundle("//usr/lib/gio/modules").into());
        put(
            "GSETTINGS_SCHEMA_DIR",
            list(&[
                &bundle("/usr/share/glib-2.0/schemas/"),
                &bundle("//usr/share/glib-2.0/schemas"),
            ]),
        );
        put(
            "PATH",
            list(&[
                &bundle("/usr/bin/"),
                &bundle("/usr/sbin/"),
                "",
                "/home/ana/.local/bin",
                "/usr/bin",
                "",
            ]),
        );
        put(
            "LD_LIBRARY_PATH",
            list(&[
                &bundle("/usr/lib/"),
                &bundle("/usr/lib/x86_64-linux-gnu/"),
                "",
            ]),
        );
        put(
            "XDG_DATA_DIRS",
            list(&[
                &bundle("/usr/share/"),
                &bundle("/usr/share"),
                "/usr/share",
                "",
            ]),
        );
        put(
            "PYTHONPATH",
            list(&[&bundle("/usr/share/pyshared/"), "/opt/ana/python"]),
        );
        put(
            "PERLLIB",
            list(&[&bundle("/usr/share/perl5/"), &bundle("/usr/lib/perl5/"), ""]),
        );
        put(
            "QT_PLUGIN_PATH",
            list(&[&bundle("/usr/lib/qt5/plugins/"), ""]),
        );
        put(
            "GST_PLUGIN_SYSTEM_PATH",
            list(&[&bundle("/usr/lib/gstreamer"), ""]),
        );
        put(
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            list(&[&bundle("/usr/lib/gstreamer-1.0"), ""]),
        );
        // Fora das listas conhecidas: sai pelo filtro geral.
        put("PWD", bundle("/usr").into());
        put("HOME", "/home/ana".into());
        put("DISPLAY", ":0".into());
        put("LANG", "pt_BR.UTF-8".into());
        env
    }

    #[test]
    fn injected_variables_leave_and_lists_keep_only_entries_outside_the_bundle() {
        let mut env = appimage_env();
        let changes = appimage_cleanup(&env);
        apply(&mut env, changes);

        for name in INJECTED {
            assert!(!env.contains_key(OsStr::new(name)), "{name} ficou");
        }
        for name in [
            "LD_LIBRARY_PATH",
            "PERLLIB",
            "QT_PLUGIN_PATH",
            "GST_PLUGIN_SYSTEM_PATH",
            "GST_PLUGIN_SYSTEM_PATH_1_0",
            "PWD",
        ] {
            assert!(!env.contains_key(OsStr::new(name)), "{name} ficou vazia");
        }
        let value = |name: &str| env.get(OsStr::new(name)).cloned();
        assert_eq!(
            value("PATH"),
            Some(list(&["/home/ana/.local/bin", "/usr/bin"]))
        );
        assert_eq!(value("XDG_DATA_DIRS"), Some(list(&["/usr/share"])));
        assert_eq!(value("PYTHONPATH"), Some(list(&["/opt/ana/python"])));
        assert_eq!(value("HOME"), Some("/home/ana".into()));
        assert_eq!(value("DISPLAY"), Some(":0".into()));
        assert_eq!(value("LANG"), Some("pt_BR.UTF-8".into()));
        for (name, value) in &env {
            assert!(
                !value.to_string_lossy().contains(APPDIR),
                "{name:?} ainda aponta para o bundle"
            );
        }
    }

    #[test]
    fn nothing_changes_outside_an_appimage() {
        let mut env = appimage_env();
        env.remove(OsStr::new("APPDIR"));
        env.remove(OsStr::new("APPIMAGE"));
        assert!(appimage_cleanup(&env).is_empty());

        env.insert("APPDIR".into(), OsString::new());
        assert!(appimage_cleanup(&env).is_empty());
        assert!(appimage_cleanup(&BTreeMap::new()).is_empty());
    }

    #[test]
    fn extracted_or_partial_markers_are_still_recognised() {
        let mut extracted = appimage_env();
        extracted.remove(OsStr::new("APPIMAGE"));
        let changes = appimage_cleanup(&extracted);
        assert!(changes.contains(&EnvChange::Remove("PYTHONHOME".into())));
        assert!(changes.contains(&EnvChange::Remove("LD_LIBRARY_PATH".into())));

        // Sem APPDIR nao ha como reconhecer o bundle nas listas; saem as
        // variaveis fixas e as entradas vazias.
        let mut runtime_only = BTreeMap::new();
        runtime_only.insert(OsString::from("APPIMAGE"), OsString::from("/x.AppImage"));
        runtime_only.insert(OsString::from("PYTHONHOME"), OsString::from("/y/usr/"));
        runtime_only.insert(OsString::from("PATH"), list(&["/y/usr/bin", "", "/bin"]));
        assert_eq!(
            appimage_cleanup(&runtime_only),
            [
                EnvChange::Remove("APPIMAGE".into()),
                EnvChange::Set("PATH".into(), list(&["/y/usr/bin", "/bin"])),
                EnvChange::Remove("PYTHONHOME".into()),
            ]
        );
    }

    #[test]
    fn bundle_prefix_is_matched_by_path_component_and_never_at_the_root() {
        let mut env = BTreeMap::new();
        env.insert(OsString::from("APPDIR"), OsString::from(APPDIR));
        let sibling = format!("{APPDIR}2/usr/bin");
        env.insert(OsString::from("PATH"), list(&[&sibling, "/usr/bin"]));
        assert_eq!(appimage_cleanup(&env), [EnvChange::Remove("APPDIR".into())]);

        env.insert(OsString::from("APPDIR"), OsString::from("/"));
        assert_eq!(appimage_cleanup(&env), [EnvChange::Remove("APPDIR".into())]);
    }

    #[test]
    fn sanitize_edits_std_and_pty_commands_through_their_own_environment() {
        let mut command = Command::new("git");
        command
            .env("APPDIR", APPDIR)
            .env("PYTHONHOME", bundle("/usr/"))
            .env("PATH", list(&[&bundle("/usr/bin"), "/usr/bin"]))
            .env("GIT_TERMINAL_PROMPT", "0");
        sanitize(&mut command);
        let envs: BTreeMap<_, _> = command.get_envs().collect();
        assert_eq!(envs.get(OsStr::new("APPDIR")), Some(&None));
        assert_eq!(envs.get(OsStr::new("PYTHONHOME")), Some(&None));
        assert_eq!(
            envs.get(OsStr::new("PATH")),
            Some(&Some(list(&["/usr/bin"]).as_os_str()))
        );
        assert_eq!(
            envs.get(OsStr::new("GIT_TERMINAL_PROMPT")),
            Some(&Some(OsStr::new("0")))
        );

        let mut builder = CommandBuilder::new("/bin/sh");
        builder.env("APPDIR", APPDIR);
        builder.env("LD_LIBRARY_PATH", list(&[&bundle("/usr/lib"), ""]));
        builder.env("PATH", list(&["/opt/ana/bin", &bundle("/usr/bin")]));
        builder.env("TERM_PROGRAM", "Cialai");
        sanitize(&mut builder);
        assert_eq!(builder.get_env("APPDIR"), None);
        assert_eq!(builder.get_env("LD_LIBRARY_PATH"), None);
        assert_eq!(
            builder.get_env("PATH"),
            Some(list(&["/opt/ana/bin"]).as_os_str())
        );
        assert_eq!(builder.get_env("TERM_PROGRAM"), Some(OsStr::new("Cialai")));
    }

    #[test]
    fn sanitize_leaves_commands_alone_outside_an_appimage() {
        let mut command = Command::new("git");
        command.env("PATH", list(&["", "/usr/bin"]));
        sanitize(&mut command);
        assert_eq!(command.get_envs().count(), 1);
        assert_eq!(
            command.get_envs().next(),
            Some((
                OsStr::new("PATH"),
                Some(list(&["", "/usr/bin"]).as_os_str())
            ))
        );
    }

    #[test]
    fn pty_folder_is_always_absolute_and_falls_back_to_home_then_owd() {
        let temp = std::env::temp_dir();
        let missing = temp.join(format!("cialai-sem-pasta-{}", std::process::id()));
        assert_eq!(
            pty_cwd(temp.to_str().unwrap(), &missing, None),
            Some(temp.clone())
        );
        assert_eq!(pty_cwd("", &temp, None), Some(temp.clone()));
        assert_eq!(pty_cwd("  ", &missing, Some(&temp)), Some(temp.clone()));
        assert_eq!(pty_cwd("", &missing, None), None);
        assert_eq!(
            pty_cwd("", Path::new("relativa"), Some(Path::new("."))),
            None
        );
        assert_eq!(pty_cwd(".", &temp, None), None);
        assert_eq!(pty_cwd("src", &temp, None), None);
        assert_eq!(pty_cwd(missing.to_str().unwrap(), &temp, None), None);
    }
}
