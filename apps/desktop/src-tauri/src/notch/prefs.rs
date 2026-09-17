// SPDX-License-Identifier: Apache-2.0
//! Preferencias da Barra de IA, gravadas no bloco `notch` do
//! `preferences.json` do app.
//!
//! A barra e um painel reto na direita da area de conteudo. O que se ajusta e
//! pouco de proposito: se ela esta aberta, recolhida ou escondida, quais
//! perfis aparecem e em que ordem, os limiares de cor e os avisos de limite.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotchVisibility {
    /// Painel aberto, com os aneis a vista.
    #[default]
    Open,
    /// Uma tira fina com um ponto por perfil.
    Collapsed,
    /// Fora do layout; o botao da toolbar traz de volta.
    Hidden,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResetTimeFormat {
    /// Data e hora do reset.
    #[default]
    Automatic,
    /// Contagem regressiva.
    Remaining,
}

/// Ajuste por perfil. Um perfil desligado nao vira anel e para de ser lido.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfilePreference {
    pub enabled: bool,
    /// Nome dado pelo usuario, que vence o slug e a conta no rotulo.
    pub alias: Option<String>,
    /// Sem avisos de limite para este perfil.
    pub muted: bool,
}

impl Default for ProfilePreference {
    fn default() -> Self {
        Self {
            enabled: true,
            alias: None,
            muted: false,
        }
    }
}

/// Avisos do sistema. Desligados por padrao: a barra ja mostra o numero, e um
/// aviso so vale para quem pediu.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AlertPreference {
    /// Aviso ao cruzar 80 por cento.
    pub threshold: bool,
    /// Aviso quando a janela principal se esgota.
    pub limit_reached: bool,
    /// Aviso quando a janela vira.
    pub reset: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotchPreferences {
    pub visibility: NotchVisibility,
    pub profiles: BTreeMap<String, ProfilePreference>,
    /// Ordem dos aneis por id de perfil. Ids ausentes ficam no fim.
    pub order: Vec<String>,
    /// Esconder `~/.claude` e `~/.codex` quando a conta ja aparece num perfil
    /// nomeado.
    pub hide_default_when_duplicate: bool,
    pub watch_limit: f64,
    pub critical_limit: f64,
    pub alerts: AlertPreference,
    pub reset_time_format: ResetTimeFormat,
}

impl Default for NotchPreferences {
    fn default() -> Self {
        Self {
            visibility: NotchVisibility::Open,
            profiles: BTreeMap::new(),
            order: Vec::new(),
            hide_default_when_duplicate: true,
            watch_limit: 0.5,
            critical_limit: 0.7,
            alerts: AlertPreference::default(),
            reset_time_format: ResetTimeFormat::default(),
        }
    }
}

impl NotchPreferences {
    /// Um perfil novo entra ligado; so um desligamento explicito o remove.
    pub fn profile_enabled(&self, id: &str) -> bool {
        self.profiles
            .get(id)
            .map(|value| value.enabled)
            .unwrap_or(true)
    }

    pub fn profile_alias(&self, id: &str) -> Option<String> {
        self.profiles
            .get(id)
            .and_then(|value| value.alias.clone())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    pub fn profile_muted(&self, id: &str) -> bool {
        self.profiles
            .get(id)
            .map(|value| value.muted)
            .unwrap_or(false)
    }

    /// Limiares validados: a faixa de atencao sempre abaixo da critica.
    pub fn limits(&self) -> (f64, f64) {
        let critical = self.critical_limit.clamp(0.02, 1.0);
        let watch = self.watch_limit.clamp(0.01, critical - 0.01);
        (watch, critical)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_by_default_and_stays_quiet() {
        let prefs = NotchPreferences::default();
        assert_eq!(prefs.visibility, NotchVisibility::Open);
        assert!(!prefs.alerts.threshold, "aviso e opcional, nao padrao");
        assert!(!prefs.alerts.limit_reached);
    }

    #[test]
    fn clamps_the_limits() {
        let prefs = NotchPreferences {
            watch_limit: 0.9,
            critical_limit: 0.7,
            ..NotchPreferences::default()
        };
        let (watch, critical) = prefs.limits();
        assert!(watch < critical);
    }

    #[test]
    fn a_profile_without_a_row_is_on() {
        let prefs = NotchPreferences::default();
        assert!(prefs.profile_enabled("codex-amorim"));
        assert!(!prefs.profile_muted("codex-amorim"));
    }

    #[test]
    fn the_json_matches_the_documented_block() {
        let value = serde_json::to_value(NotchPreferences::default()).unwrap();
        assert_eq!(value["visibility"], "open");
        assert_eq!(value["hideDefaultWhenDuplicate"], true);
        assert_eq!(value["watchLimit"], 0.5);
        assert_eq!(value["criticalLimit"], 0.7);
        assert_eq!(value["alerts"]["limitReached"], false);
        assert_eq!(value["resetTimeFormat"], "automatic");
        let parsed: NotchPreferences = serde_json::from_value(serde_json::json!({
            "visibility": "collapsed",
            "profiles": { "codex-amorim": { "enabled": true, "alias": null, "muted": false } },
            "order": ["claude-ordinum", "codex-amorim"]
        }))
        .unwrap();
        assert_eq!(parsed.visibility, NotchVisibility::Collapsed);
        assert_eq!(parsed.order, ["claude-ordinum", "codex-amorim"]);
        assert!(parsed.profile_enabled("codex-amorim"));
        assert_eq!(parsed.watch_limit, 0.5, "campo ausente recebe o padrao");
    }
}
