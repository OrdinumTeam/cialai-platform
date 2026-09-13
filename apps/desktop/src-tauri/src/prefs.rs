// SPDX-License-Identifier: Apache-2.0
//! Preferencias do Cialai, gravadas no diretorio de configuracao do app.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Preferences {
    pub appearance: String,
    pub terminal: TerminalPreferences,
    pub project_roots: Vec<String>,
    pub dev_browser: DevBrowserPreferences,
    pub window: WindowPreferences,
    pub network: NetworkPreferences,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            appearance: "system".into(),
            terminal: TerminalPreferences::default(),
            project_roots: vec!["~/Projects".into()],
            dev_browser: DevBrowserPreferences::default(),
            window: WindowPreferences::default(),
            network: NetworkPreferences::default(),
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TerminalPreferences {
    pub shell: Option<String>,
    pub args: Vec<String>,
    pub lang: Option<String>,
    pub path_prefix: Vec<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DevBrowserPreferences {
    pub chromium_path: Option<String>,
}

/// Fundo automatico: Mica quando o Windows permite.
pub const BACKDROP_AUTO: &str = "auto";
/// Fundo solido pintado pela pagina, sem material do sistema.
pub const BACKDROP_SOLID: &str = "solid";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WindowPreferences {
    pub backdrop: String,
}

impl Default for WindowPreferences {
    fn default() -> Self {
        Self {
            backdrop: BACKDROP_AUTO.into(),
        }
    }
}

impl WindowPreferences {
    /// Fundo valido da janela; valores desconhecidos voltam ao automatico.
    pub fn backdrop(&self) -> &str {
        if self.backdrop == BACKDROP_SOLID {
            BACKDROP_SOLID
        } else {
            BACKDROP_AUTO
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkPreferences {
    pub control_url: Option<String>,
    pub user_id: Option<String>,
    pub user_name: Option<String>,
    pub desktop_name: Option<String>,
    pub require_approval: bool,
    pub keep_awake_while_paired: bool,
}

fn prefs_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("preferences.json"))
}

impl Preferences {
    pub fn load(app: &AppHandle) -> Self {
        let Some(path) = prefs_path(app) else {
            return Self::default();
        };
        match fs::read_to_string(path) {
            Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self, app: &AppHandle) -> Result<(), String> {
        let path = prefs_path(app).ok_or_else(|| "sem diretorio de configuracao".to_string())?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        }
        let raw = serde_json::to_string_pretty(self).map_err(|error| error.to_string())?;
        fs::write(path, raw).map_err(|error| error.to_string())
    }
}

#[derive(Clone)]
pub struct PrefsState(Arc<Mutex<Preferences>>);

impl PrefsState {
    pub fn new(preferences: Preferences) -> Self {
        Self(Arc::new(Mutex::new(preferences)))
    }

    pub fn get(&self) -> Preferences {
        self.0.lock().map(|guard| guard.clone()).unwrap_or_default()
    }

    pub fn set(&self, preferences: Preferences) {
        if let Ok(mut guard) = self.0.lock() {
            *guard = preferences;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn defaults_match_the_documented_schema() {
        let prefs = Preferences::default();
        assert_eq!(prefs.appearance, "system");
        assert_eq!(prefs.project_roots, ["~/Projects"]);
        assert_eq!(prefs.window.backdrop, "auto");
        assert_eq!(prefs.terminal, TerminalPreferences::default());
        assert_eq!(prefs.network, NetworkPreferences::default());
    }

    #[test]
    fn serialization_uses_camel_case_and_excludes_removed_products() {
        let value = serde_json::to_value(Preferences::default()).unwrap();
        assert_eq!(value["projectRoots"], json!(["~/Projects"]));
        assert_eq!(value["devBrowser"]["chromiumPath"], Value::Null);
        assert_eq!(value["network"]["requireApproval"], false);
        for removed in ["repoDir", "stopStackOnQuit", "meetings"] {
            assert!(
                value.get(removed).is_none(),
                "campo removido persistido: {removed}"
            );
        }
    }

    #[test]
    fn missing_fields_receive_defaults() {
        let prefs: Preferences = serde_json::from_value(json!({
            "appearance": "dark",
            "terminal": {"shell": "/bin/fish"}
        }))
        .unwrap();
        assert_eq!(prefs.appearance, "dark");
        assert_eq!(prefs.terminal.shell.as_deref(), Some("/bin/fish"));
        assert!(prefs.terminal.args.is_empty());
        assert_eq!(prefs.project_roots, ["~/Projects"]);
    }

    #[test]
    fn window_backdrop_accepts_only_auto_and_solid() {
        let mut window = WindowPreferences::default();
        assert_eq!(window.backdrop(), BACKDROP_AUTO);
        window.backdrop = BACKDROP_SOLID.into();
        assert_eq!(window.backdrop(), BACKDROP_SOLID);
        window.backdrop = "acrylic".into();
        assert_eq!(window.backdrop(), BACKDROP_AUTO);
    }

    #[test]
    fn state_replaces_the_complete_snapshot() {
        let state = PrefsState::new(Preferences::default());
        let shared = state.clone();
        let mut next = state.get();
        next.appearance = "light".into();
        next.project_roots = vec!["~/src".into()];
        state.set(next.clone());
        assert_eq!(state.get(), next);
        assert_eq!(shared.get(), next);
    }
}
