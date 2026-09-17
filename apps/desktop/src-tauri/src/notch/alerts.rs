// SPDX-License-Identifier: Apache-2.0
//! Avisos de limite, por perfil.
//!
//! Tres regras, todas vindas do Codenotch e todas sobre **nao** repetir:
//!
//! - O aviso e por **cruzamento**, nao por estado. Parar em 91 por cento nao
//!   avisa de novo; cair abaixo de 80 rearma, e a proxima subida avisa.
//! - So a janela do anel conta. Um limite secundario estourado nao dispara o
//!   aviso do perfil.
//! - A memoria avanca mesmo com o perfil silenciado, para desmutar nao
//!   despejar os avisos que ficaram pelo caminho.
//!
//! O aviso de renovacao exige que a janela tenha sido de fato usada: renovar
//! um limite em que ninguem tocou nao e noticia.
//!
//! O texto sai daqui para a notificacao do sistema, entao ele passa pelo
//! catalogo `native.*` como o restante do nucleo.

use std::collections::BTreeMap;

use crate::i18n::{t, tf};

use super::prefs::NotchPreferences;
use super::usage::{LimitWindow, ProviderSnapshot};

/// Limiares que viram aviso, em pontos percentuais.
const THRESHOLDS: [u8; 2] = [80, 100];
/// Abaixo deste pico, a renovacao nao vale aviso.
const RESET_MIN_PEAK: f64 = 0.15;
/// Queda que denuncia uma renovacao sem mudanca de data.
const RESET_DROP: f64 = 0.20;

#[derive(Clone, Debug, PartialEq)]
pub enum Alert {
    /// Cruzou um limiar, em pontos percentuais.
    Threshold {
        profile_id: String,
        title: String,
        percent: u8,
        window: LimitWindow,
    },
    /// A janela do anel se esgotou.
    LimitReached {
        profile_id: String,
        title: String,
        window: LimitWindow,
    },
    /// A janela renovou e o limite voltou.
    Reset {
        profile_id: String,
        title: String,
        window: LimitWindow,
    },
}

impl Alert {
    pub fn profile_id(&self) -> &str {
        match self {
            Alert::Threshold { profile_id, .. }
            | Alert::LimitReached { profile_id, .. }
            | Alert::Reset { profile_id, .. } => profile_id,
        }
    }

    pub fn title(&self) -> String {
        match self {
            Alert::Threshold { title, percent, .. } => tf(
                "native.notch.alertThresholdTitle",
                &[("title", title), ("percent", percent)],
            ),
            Alert::LimitReached { title, .. } => {
                tf("native.notch.alertLimitTitle", &[("title", title)])
            }
            Alert::Reset { title, .. } => tf("native.notch.alertResetTitle", &[("title", title)]),
        }
    }

    pub fn body(&self) -> String {
        match self {
            Alert::Threshold {
                percent, window, ..
            } => tf(
                "native.notch.alertThresholdBody",
                &[("percent", percent), ("window", &window_text(window))],
            ),
            Alert::LimitReached { window, .. } => tf(
                "native.notch.alertLimitBody",
                &[("window", &window_text(window))],
            ),
            Alert::Reset { window, .. } => tf(
                "native.notch.alertResetBody",
                &[("window", &window_text(window))],
            ),
        }
    }
}

/// O rotulo da janela e um codigo para a interface; o aviso do sistema e o
/// unico texto que sai do Rust, entao ele traduz aqui, como complemento de
/// "o limite ...".
pub fn window_text(window: &LimitWindow) -> String {
    match window.label.as_str() {
        "session" => t("native.notch.windowSession"),
        "weeklyAll" => t("native.notch.windowWeeklyAll"),
        "perModel" => t("native.notch.windowPerModel"),
        "longWindow" => t("native.notch.windowLong"),
        "duration" => duration_text(window.duration_ms),
        other => other.to_string(),
    }
}

fn duration_text(duration_ms: Option<u64>) -> String {
    let Some(seconds) = duration_ms
        .map(|value| value / 1000)
        .filter(|value| *value > 0)
    else {
        return t("native.notch.windowSession");
    };
    let minutes = seconds / 60;
    if minutes < 60 {
        return tf("native.notch.windowMinutes", &[("count", &minutes)]);
    }
    let hours = minutes / 60;
    if hours < 24 {
        return tf("native.notch.windowHours", &[("count", &hours)]);
    }
    match hours / 24 {
        7 => t("native.notch.windowWeekly"),
        30 => t("native.notch.windowMonthly"),
        days => tf("native.notch.windowDays", &[("count", &days)]),
    }
}

#[derive(Clone, Debug, Default)]
struct Memory {
    crossed: u8,
    peak: f64,
    last_reset_at: Option<u64>,
    fraction: Option<f64>,
    seen: bool,
}

#[derive(Default)]
pub struct AlertWatcher {
    memory: BTreeMap<String, Memory>,
}

impl AlertWatcher {
    /// Recebe as leituras e devolve os avisos que valem agora.
    pub fn absorb(
        &mut self,
        snapshots: &[ProviderSnapshot],
        prefs: &NotchPreferences,
    ) -> Vec<Alert> {
        let mut alerts = Vec::new();
        for snapshot in snapshots {
            let Some(window) = snapshot.headline() else {
                continue;
            };
            let Some(fraction) = window.used_fraction else {
                continue;
            };
            let muted = prefs.profile_muted(&snapshot.id);
            let entry = self.memory.entry(snapshot.id.clone()).or_default();
            let first = !entry.seen;
            entry.seen = true;

            let level = if fraction >= 1.0 {
                100
            } else if fraction >= 0.8 {
                80
            } else {
                0
            };

            // Renovacao: a data andou, ou o numero caiu de um pico real.
            let rolled = window
                .resets_at_ms
                .is_some_and(|at| entry.last_reset_at.is_some_and(|before| at > before));
            let dropped = entry.fraction.is_some_and(|before| {
                fraction < before
                    && (before - fraction >= RESET_DROP || (entry.peak >= 0.30 && fraction <= 0.10))
            });
            if !first
                && (rolled || dropped)
                && entry.peak >= RESET_MIN_PEAK
                && !muted
                && prefs.alerts.reset
            {
                alerts.push(Alert::Reset {
                    profile_id: snapshot.id.clone(),
                    title: title_of(snapshot),
                    window: window.clone(),
                });
            }
            if rolled || dropped {
                entry.peak = 0.0;
                entry.crossed = 0;
            }

            // Cruzamento: so para cima, e so uma vez por limiar.
            if !first && level > entry.crossed && !muted {
                for threshold in THRESHOLDS {
                    if threshold <= entry.crossed || threshold > level {
                        continue;
                    }
                    if threshold == 100 {
                        if prefs.alerts.limit_reached {
                            alerts.push(Alert::LimitReached {
                                profile_id: snapshot.id.clone(),
                                title: title_of(snapshot),
                                window: window.clone(),
                            });
                        }
                    } else if prefs.alerts.threshold {
                        alerts.push(Alert::Threshold {
                            profile_id: snapshot.id.clone(),
                            title: title_of(snapshot),
                            percent: threshold,
                            window: window.clone(),
                        });
                    }
                }
            }

            // A memoria anda sempre, inclusive silenciada.
            entry.crossed = level;
            entry.peak = entry.peak.max(fraction);
            entry.fraction = Some(fraction);
            if let Some(at) = window.resets_at_ms {
                entry.last_reset_at = Some(at);
            }
        }
        alerts
    }
}

/// `Claude · webrota`, para o aviso dizer de qual conta se trata.
fn title_of(snapshot: &ProviderSnapshot) -> String {
    let provider = if snapshot.provider == "claude" {
        "Claude"
    } else {
        "Codex"
    };
    format!("{provider} · {}", snapshot.label)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notch::usage::{Fidelity, ProviderStatus};

    /// Os avisos sao opcionais e nascem desligados; os testes os ligam.
    fn alerting() -> NotchPreferences {
        NotchPreferences {
            alerts: crate::notch::prefs::AlertPreference {
                threshold: true,
                limit_reached: true,
                reset: true,
            },
            ..NotchPreferences::default()
        }
    }

    fn snapshot(id: &str, fraction: f64, resets: Option<u64>) -> ProviderSnapshot {
        ProviderSnapshot {
            id: id.to_string(),
            provider: "claude".to_string(),
            label: "webrota".to_string(),
            account: None,
            config_dir: String::new(),
            plan: None,
            fidelity: Fidelity::Official,
            status: ProviderStatus::Ok,
            windows: vec![LimitWindow {
                id: "session".to_string(),
                group: None,
                label: "session".to_string(),
                used_fraction: Some(fraction),
                resets_at_ms: resets,
                duration_ms: None,
            }],
            headline_id: Some("session".to_string()),
            weekly_id: None,
            fetched_at_ms: 1,
            source: None,
        }
    }

    #[test]
    fn alerts_are_off_unless_asked_for() {
        let mut watcher = AlertWatcher::default();
        let prefs = NotchPreferences::default();
        watcher.absorb(&[snapshot("a", 0.1, None)], &prefs);
        assert!(
            watcher
                .absorb(&[snapshot("a", 1.0, None)], &prefs)
                .is_empty(),
            "sem pedir, nenhum aviso"
        );
    }

    #[test]
    fn the_first_reading_never_alerts() {
        let mut watcher = AlertWatcher::default();
        let prefs = alerting();
        assert!(
            watcher
                .absorb(&[snapshot("a", 0.95, None)], &prefs)
                .is_empty()
        );
    }

    #[test]
    fn crossing_eighty_alerts_once() {
        let mut watcher = AlertWatcher::default();
        let prefs = alerting();
        watcher.absorb(&[snapshot("a", 0.5, None)], &prefs);
        let alerts = watcher.absorb(&[snapshot("a", 0.85, None)], &prefs);
        assert_eq!(alerts.len(), 1);
        assert!(matches!(alerts[0], Alert::Threshold { percent: 80, .. }));
        assert_eq!(alerts[0].profile_id(), "a");
        assert!(
            watcher
                .absorb(&[snapshot("a", 0.91, None)], &prefs)
                .is_empty(),
            "parar acima nao repete"
        );
    }

    #[test]
    fn falling_below_rearms_the_alert() {
        let mut watcher = AlertWatcher::default();
        let prefs = alerting();
        watcher.absorb(&[snapshot("a", 0.5, None)], &prefs);
        watcher.absorb(&[snapshot("a", 0.85, None)], &prefs);
        watcher.absorb(&[snapshot("a", 0.4, None)], &prefs);
        assert_eq!(
            watcher.absorb(&[snapshot("a", 0.85, None)], &prefs).len(),
            1
        );
    }

    #[test]
    fn a_jump_past_both_thresholds_alerts_twice() {
        let mut watcher = AlertWatcher::default();
        let prefs = alerting();
        watcher.absorb(&[snapshot("a", 0.1, None)], &prefs);
        let alerts = watcher.absorb(&[snapshot("a", 1.0, None)], &prefs);
        assert_eq!(alerts.len(), 2);
        assert!(matches!(alerts[0], Alert::Threshold { percent: 80, .. }));
        assert!(matches!(alerts[1], Alert::LimitReached { .. }));
    }

    #[test]
    fn a_muted_profile_stays_quiet_and_does_not_replay() {
        let mut watcher = AlertWatcher::default();
        let mut prefs = alerting();
        prefs.profiles.insert(
            "a".to_string(),
            crate::notch::prefs::ProfilePreference {
                enabled: true,
                alias: None,
                muted: true,
            },
        );
        watcher.absorb(&[snapshot("a", 0.1, None)], &prefs);
        assert!(
            watcher
                .absorb(&[snapshot("a", 0.85, None)], &prefs)
                .is_empty()
        );
        // Desmutar nao despeja o aviso que ficou para tras.
        prefs.profiles.clear();
        assert!(
            watcher
                .absorb(&[snapshot("a", 0.9, None)], &prefs)
                .is_empty()
        );
    }

    #[test]
    fn a_rolled_window_with_real_usage_alerts() {
        let mut watcher = AlertWatcher::default();
        let prefs = alerting();
        watcher.absorb(&[snapshot("a", 0.6, Some(1000))], &prefs);
        let alerts = watcher.absorb(&[snapshot("a", 0.02, Some(9000))], &prefs);
        assert_eq!(alerts.len(), 1);
        assert!(matches!(alerts[0], Alert::Reset { .. }));
    }

    #[test]
    fn a_window_nobody_used_does_not_announce_its_reset() {
        let mut watcher = AlertWatcher::default();
        let prefs = alerting();
        watcher.absorb(&[snapshot("a", 0.05, Some(1000))], &prefs);
        assert!(
            watcher
                .absorb(&[snapshot("a", 0.0, Some(9000))], &prefs)
                .is_empty()
        );
    }

    #[test]
    fn a_secondary_window_never_triggers_the_profile_alert() {
        let mut watcher = AlertWatcher::default();
        let prefs = alerting();
        let mut first = snapshot("a", 0.1, None);
        first.windows.push(LimitWindow {
            id: "spark".to_string(),
            group: Some("Spark".to_string()),
            label: "duration".to_string(),
            used_fraction: Some(1.0),
            resets_at_ms: None,
            duration_ms: None,
        });
        watcher.absorb(&[first.clone()], &prefs);
        assert!(watcher.absorb(&[first], &prefs).is_empty());
    }

    #[test]
    fn a_profile_without_a_headline_window_is_skipped() {
        let mut watcher = AlertWatcher::default();
        let prefs = alerting();
        let mut empty = snapshot("a", 0.9, None);
        empty.headline_id = Some("outra".to_string());
        assert!(watcher.absorb(&[empty], &prefs).is_empty());
    }

    #[test]
    fn the_title_names_the_profile_not_just_the_provider() {
        let alert = Alert::Threshold {
            profile_id: "claude-webrota".to_string(),
            title: title_of(&snapshot("claude-webrota", 0.9, None)),
            percent: 80,
            window: snapshot("claude-webrota", 0.9, None).windows[0].clone(),
        };
        let title = alert.title();
        assert!(title.contains("Claude · webrota"), "{title}");
        assert!(title.contains("80"), "{title}");
        let body = alert.body();
        assert!(body.contains("80"), "{body}");
        assert!(
            !body.contains("session"),
            "o codigo da janela vira texto: {body}"
        );
    }

    #[test]
    fn the_window_text_follows_the_code_and_the_duration() {
        let window = |label: &str, duration: Option<u64>| LimitWindow {
            id: "x".to_string(),
            group: None,
            label: label.to_string(),
            used_fraction: None,
            resets_at_ms: None,
            duration_ms: duration,
        };
        assert_ne!(window_text(&window("session", None)), "session");
        assert_ne!(window_text(&window("weeklyAll", None)), "weeklyAll");
        assert!(window_text(&window("duration", Some(30 * 60 * 1000))).contains("30"));
        assert!(window_text(&window("duration", Some(5 * 3600 * 1000))).contains('5'));
        assert!(window_text(&window("duration", Some(3 * 86_400 * 1000))).contains('3'));
        assert_ne!(
            window_text(&window("duration", Some(7 * 86_400 * 1000))),
            "duration"
        );
        assert_ne!(
            window_text(&window("duration", Some(30 * 86_400 * 1000))),
            "duration"
        );
        assert_eq!(
            window_text(&window("Fable", None)),
            "Fable",
            "nome proprio fica como esta"
        );
    }
}
