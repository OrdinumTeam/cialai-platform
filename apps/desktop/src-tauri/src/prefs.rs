// SPDX-License-Identifier: Apache-2.0
//! Preferencias do Cialai, gravadas no diretorio de configuracao do app.

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, OnceLock};

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
    /// Barra de IA: visibilidade, perfis, limiares e avisos. Gravado pelos
    /// comandos `notch_*`; `set_preferences` preserva o bloco.
    pub notch: crate::notch::prefs::NotchPreferences,
    /// Perfil ativo de cada agente. Gravado pelos comandos `agent_profile_*`;
    /// `set_preferences` preserva o bloco, como faz com o da Barra de IA.
    pub agents: AgentPreferences,
}

/// Conta que os terminais novos vao usar, por agente. Valor vazio significa
/// nao interferir: o shell nasce sem as variaveis e o agente escolhe sozinho,
/// como sempre fez.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentPreferences {
    pub active_profile: ActiveProfiles,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ActiveProfiles {
    /// Id do perfil do Claude Code, como `claude` ou `claude-webrota`.
    pub claude: String,
    /// Id do perfil do Codex, como `codex` ou `codex-amorim`.
    pub codex: String,
}

impl ActiveProfiles {
    /// Perfil ativo do agente, ou `None` quando nao ha escolha.
    pub fn get(&self, agent: &str) -> Option<&str> {
        let value = match agent {
            "claude" => self.claude.as_str(),
            "codex" => self.codex.as_str(),
            _ => return None,
        };
        (!value.is_empty()).then_some(value)
    }

    pub fn set(&mut self, agent: &str, id: &str) -> bool {
        match agent {
            "claude" => self.claude = id.to_string(),
            "codex" => self.codex = id.to_string(),
            _ => return false,
        }
        true
    }
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
            notch: crate::notch::prefs::NotchPreferences::default(),
            agents: AgentPreferences::default(),
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

/// Limite do nome do computador aceito por `net.start`, em caracteres.
pub const DESKTOP_NAME_MAX_CHARS: usize = 48;
/// Nome usado quando o sistema nao informa o nome do computador.
const FALLBACK_DESKTOP_NAME: &str = "Cialai";

/// Rede do computador. A conexao sobe sozinha ao abrir o Cialai; so ficam o
/// nome mostrado no celular, a aprovacao por codigo e a vigilia. Os campos do
/// Headscale de versoes anteriores sao ignorados na leitura e somem ao salvar.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", from = "StoredNetworkPreferences")]
pub struct NetworkPreferences {
    pub desktop_name: String,
    pub require_approval: bool,
    pub keep_awake_while_paired: bool,
}

impl Default for NetworkPreferences {
    fn default() -> Self {
        StoredNetworkPreferences::default().into()
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct StoredNetworkPreferences {
    desktop_name: Option<String>,
    require_approval: bool,
    keep_awake_while_paired: bool,
}

impl From<StoredNetworkPreferences> for NetworkPreferences {
    fn from(stored: StoredNetworkPreferences) -> Self {
        Self {
            desktop_name: clean_desktop_name(stored.desktop_name.as_deref())
                .unwrap_or_else(computer_name),
            require_approval: stored.require_approval,
            keep_awake_while_paired: stored.keep_awake_while_paired,
        }
    }
}

/// Nome sem espacos nas pontas, sem caracteres de controle e com no maximo
/// 48 caracteres; vazio vira `None`.
pub fn clean_desktop_name(value: Option<&str>) -> Option<String> {
    let cleaned: String = value?
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .collect();
    let trimmed: String = cleaned
        .trim()
        .chars()
        .take(DESKTOP_NAME_MAX_CHARS)
        .collect();
    let trimmed = trimmed.trim_end();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

/// Nome deste computador, lido uma vez do sistema.
pub fn computer_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        clean_desktop_name(detect_computer_name().as_deref())
            .unwrap_or_else(|| FALLBACK_DESKTOP_NAME.into())
    })
    .clone()
}

// No macOS o nome do computador de Compartilhamento e o que a pessoa
// reconhece; o nome de host fica de reserva.
#[cfg(target_os = "macos")]
fn detect_computer_name() -> Option<String> {
    // sem CREATE_NO_WINDOW: so no macOS, onde um filho nao abre console.
    let output = std::process::Command::new("/usr/sbin/scutil")
        .args(["--get", "ComputerName"])
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .output()
        .ok();
    output
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|name| !name.is_empty())
        .or_else(host_name)
}

#[cfg(target_os = "windows")]
fn detect_computer_name() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn detect_computer_name() -> Option<String> {
    host_name()
}

#[cfg(unix)]
fn host_name() -> Option<String> {
    let mut buffer = [0u8; 256];
    // SAFETY: o buffer tem o tamanho informado e o resultado termina em NUL
    // ou ocupa o buffer inteiro, tratado abaixo.
    let status = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    if status != 0 {
        return None;
    }
    let end = buffer
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(buffer.len());
    let name = String::from_utf8_lossy(&buffer[..end]).into_owned();
    let name = name.strip_suffix(".local").unwrap_or(&name).to_string();
    (!name.is_empty()).then_some(name)
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
            Ok(raw) => Self::parse(&raw),
            Err(_) => Self::default(),
        }
    }

    /// Le o arquivo gravado; conteudo invalido volta ao padrao.
    pub fn parse(raw: &str) -> Self {
        serde_json::from_str(raw).unwrap_or_default()
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

    /// O bloco de contas nasce vazio, que e nao interferir, e sobrevive a um
    /// arquivo antigo que nao o tinha.
    #[test]
    fn the_active_profile_block_defaults_to_no_choice_and_survives_an_old_file() {
        let prefs = Preferences::default();
        assert_eq!(prefs.agents, AgentPreferences::default());
        assert_eq!(prefs.agents.active_profile.get("claude"), None);
        assert_eq!(prefs.agents.active_profile.get("codex"), None);

        let old: Preferences = serde_json::from_value(json!({"appearance": "dark"})).unwrap();
        assert_eq!(old.agents, AgentPreferences::default());

        let mut active = ActiveProfiles::default();
        assert!(active.set("codex", "codex-work"));
        assert_eq!(active.get("codex"), Some("codex-work"));
        assert_eq!(active.get("claude"), None);
        assert!(
            !active.set("outro", "x"),
            "agente desconhecido nao grava nada"
        );
        // Voltar ao vazio e voltar a nao interferir.
        assert!(active.set("codex", ""));
        assert_eq!(active.get("codex"), None);

        let round: Preferences =
            serde_json::from_value(serde_json::to_value(Preferences::default()).unwrap()).unwrap();
        assert_eq!(round.agents, AgentPreferences::default());
        let wire = serde_json::to_value(Preferences::default()).unwrap();
        assert!(
            wire["agents"]["activeProfile"].is_object(),
            "camelCase no fio"
        );
    }

    #[test]
    fn defaults_match_the_documented_schema() {
        let prefs = Preferences::default();
        assert_eq!(prefs.appearance, "system");
        assert_eq!(prefs.project_roots, ["~/Projects"]);
        assert_eq!(prefs.window.backdrop, "auto");
        assert_eq!(prefs.terminal, TerminalPreferences::default());
        assert_eq!(prefs.network, NetworkPreferences::default());
        assert_eq!(
            prefs.notch,
            crate::notch::prefs::NotchPreferences::default()
        );
    }

    #[test]
    fn serialization_uses_camel_case_and_excludes_removed_products() {
        let value = serde_json::to_value(Preferences::default()).unwrap();
        assert_eq!(value["projectRoots"], json!(["~/Projects"]));
        assert_eq!(value["devBrowser"]["chromiumPath"], Value::Null);
        assert_eq!(value["network"]["requireApproval"], false);
        assert_eq!(value["notch"]["visibility"], "open");
        assert_eq!(value["notch"]["hideDefaultWhenDuplicate"], true);
        assert_eq!(value["notch"]["alerts"]["threshold"], false);
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
    fn old_preferences_file_drops_headscale_fields() {
        let prefs = Preferences::parse(
            r#"{
              "appearance": "dark",
              "projectRoots": ["~/src"],
              "network": {
                "controlUrl": "https://headscale.exemplo.com",
                "userId": "42",
                "userName": "alice",
                "desktopName": "  Mac do Estúdio  ",
                "requireApproval": true,
                "keepAwakeWhilePaired": true
              }
            }"#,
        );
        assert_eq!(prefs.appearance, "dark");
        assert_eq!(prefs.project_roots, ["~/src"]);
        assert_eq!(
            prefs.network,
            NetworkPreferences {
                desktop_name: "Mac do Estúdio".into(),
                require_approval: true,
                keep_awake_while_paired: true,
            }
        );
        let saved = serde_json::to_value(&prefs).unwrap();
        for removed in ["controlUrl", "userId", "userName"] {
            assert!(
                saved["network"].get(removed).is_none(),
                "campo do Headscale persistido: {removed}"
            );
        }
        assert_eq!(
            saved["network"],
            json!({"desktopName": "Mac do Estúdio", "requireApproval": true, "keepAwakeWhilePaired": true})
        );
        assert_eq!(Preferences::parse(&saved.to_string()), prefs);
    }

    #[test]
    fn desktop_name_defaults_to_the_computer_name() {
        let name = computer_name();
        assert!(!name.trim().is_empty());
        assert!(name.chars().count() <= DESKTOP_NAME_MAX_CHARS);
        assert_eq!(NetworkPreferences::default().desktop_name, name);
        for network in [
            json!({}),
            json!({"desktopName": null}),
            json!({"desktopName": "   "}),
        ] {
            let prefs: Preferences = serde_json::from_value(json!({ "network": network })).unwrap();
            assert_eq!(prefs.network.desktop_name, name);
            assert!(!prefs.network.require_approval);
            assert!(!prefs.network.keep_awake_while_paired);
        }
        assert_eq!(Preferences::parse("{").network.desktop_name, name);
    }

    #[test]
    fn desktop_name_is_trimmed_to_the_sidecar_limit() {
        let long = "Estúdio ".repeat(10);
        let cleaned = clean_desktop_name(Some(&long)).unwrap();
        assert_eq!(cleaned.chars().count(), 47);
        assert!(!cleaned.ends_with(' '));
        assert_eq!(
            clean_desktop_name(Some("Mac\tdo\nEstúdio")).as_deref(),
            Some("Mac do Estúdio")
        );
        assert_eq!(clean_desktop_name(Some(" \u{7} ")), None);
        assert_eq!(clean_desktop_name(None), None);
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
