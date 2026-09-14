// SPDX-License-Identifier: Apache-2.0
//! Textos nativos no idioma escolhido na interface.
//!
//! O catalogo nasce de `packages/i18n` por `tools/i18n/native-catalog.mjs` e
//! fica embutido no binario, entao menu, dialogos e mensagens do nucleo nao
//! mantem dicionario proprio. A interface informa o idioma por
//! `app_set_locale`; o valor fica gravado para o menu e o dialogo de saida da
//! proxima abertura. Sem escolha gravada vale o idioma do sistema, e o
//! portugues do Brasil e o reserva, como em `@cialai/i18n`.

use std::collections::HashMap;
use std::fmt::Display;
use std::path::Path;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde::Deserialize;

pub const LOCALES: [&str; 3] = ["pt-BR", "en", "es"];
const DEFAULT_INDEX: usize = 0;
const LOCALE_FILE: &str = "language";

static CURRENT: AtomicUsize = AtomicUsize::new(DEFAULT_INDEX);

#[derive(Deserialize)]
struct Catalog {
    locales: HashMap<String, HashMap<String, String>>,
}

fn catalog() -> &'static Catalog {
    static CATALOG: OnceLock<Catalog> = OnceLock::new();
    CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../i18n/native.json"))
            .expect("catalogo nativo gerado por tools/i18n/native-catalog.mjs")
    })
}

/// Mesma regra de `normalizeLocale`: variantes regionais viram o idioma base
/// e qualquer outro valor cai no portugues do Brasil.
pub fn normalize(value: &str) -> &'static str {
    let locale = value.trim().to_ascii_lowercase().replace('_', "-");
    if locale == "en" || locale.starts_with("en-") {
        "en"
    } else if locale == "es" || locale.starts_with("es-") {
        "es"
    } else {
        LOCALES[DEFAULT_INDEX]
    }
}

pub fn locale() -> &'static str {
    LOCALES[CURRENT.load(Ordering::Relaxed)]
}

pub fn set_locale(value: &str) -> &'static str {
    let normalized = normalize(value);
    let index = LOCALES
        .iter()
        .position(|locale| *locale == normalized)
        .unwrap_or(DEFAULT_INDEX);
    CURRENT.store(index, Ordering::Relaxed);
    LOCALES[index]
}

/// Texto da chave no idioma atual.
pub fn t(key: &str) -> String {
    translate(locale(), key, &[])
}

/// Texto da chave no idioma atual com os valores nomeados.
pub fn tf(key: &str, values: &[(&str, &dyn Display)]) -> String {
    translate(locale(), key, values)
}

/// Traducao pura. Chave ausente no idioma usa o portugues do Brasil; ausente
/// no catalogo devolve a propria chave, que o check do catalogo impede.
pub fn translate(locale: &str, key: &str, values: &[(&str, &dyn Display)]) -> String {
    let locales = &catalog().locales;
    let template = locales
        .get(normalize(locale))
        .and_then(|dictionary| dictionary.get(key))
        .or_else(|| {
            locales
                .get(LOCALES[DEFAULT_INDEX])
                .and_then(|dictionary| dictionary.get(key))
        });
    let Some(template) = template else {
        return key.to_string();
    };
    values.iter().fold(template.clone(), |text, (name, value)| {
        text.replace(&format!("{{{name}}}"), &value.to_string())
    })
}

/// Idioma gravado pela interface ou, na primeira abertura, o do sistema.
pub fn preferred(config_dir: &Path, system: Option<&str>) -> &'static str {
    let saved = std::fs::read_to_string(config_dir.join(LOCALE_FILE)).ok();
    normalize(
        saved
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or(system)
            .unwrap_or(LOCALES[DEFAULT_INDEX]),
    )
}

pub fn restore(config_dir: &Path) -> &'static str {
    let system = sys_locale::get_locale();
    set_locale(preferred(config_dir, system.as_deref()))
}

pub fn persist(config_dir: &Path, locale: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(config_dir)?;
    std::fs::write(config_dir.join(LOCALE_FILE), normalize(locale))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_the_same_keys_in_every_language() {
        let locales = &catalog().locales;
        let mut base: Vec<&String> = locales["pt-BR"].keys().collect();
        base.sort();
        assert!(base.len() > 50, "catalogo nativo vazio");
        for locale in LOCALES {
            let mut keys: Vec<&String> = locales[locale].keys().collect();
            keys.sort();
            assert_eq!(keys, base, "chaves divergentes em {locale}");
            assert!(
                locales[locale]
                    .values()
                    .all(|value| !value.trim().is_empty())
            );
        }
    }

    #[test]
    fn locale_normalization_matches_the_shared_package() {
        assert_eq!(normalize("en-US"), "en");
        assert_eq!(normalize("en_GB"), "en");
        assert_eq!(normalize("es-MX"), "es");
        assert_eq!(normalize("ES_es"), "es");
        assert_eq!(normalize("pt-PT"), "pt-BR");
        assert_eq!(normalize("C.UTF-8"), "pt-BR");
        assert_eq!(normalize(""), "pt-BR");
    }

    #[test]
    fn translation_interpolates_and_falls_back() {
        assert_eq!(
            translate("es-AR", "native.quit.openMany", &[("count", &3)]),
            "Hay 3 terminales abiertos."
        );
        assert_eq!(
            translate("en", "native.error.exists", &[("name", &"notes.md")]),
            "Already exists: notes.md"
        );
        assert_eq!(translate("fr", "native.menu.quit", &[]), "Sair do Cialai");
        assert_eq!(translate("en", "missing.key", &[]), "missing.key");
    }

    #[test]
    fn saved_choice_wins_over_the_system_language() {
        let dir = std::env::temp_dir().join(format!(
            "cialai-i18n-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(preferred(&dir, Some("es_ES.UTF-8")), "es");
        assert_eq!(preferred(&dir, None), "pt-BR");
        persist(&dir, "en-US").unwrap();
        assert_eq!(preferred(&dir, Some("es_ES.UTF-8")), "en");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
