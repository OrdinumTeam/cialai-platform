// SPDX-License-Identifier: Apache-2.0
import { dictionaries } from './locales/index.js';

export const DEFAULT_LOCALE = 'pt-BR';
export const SUPPORTED_LOCALES = Object.freeze(['pt-BR', 'en', 'es']);
export { dictionaries };

export function normalizeLocale(value) {
  const locale = String(value ?? '').trim().toLowerCase().replaceAll('_', '-');
  if (locale === 'en' || locale.startsWith('en-')) return 'en';
  if (locale === 'es' || locale.startsWith('es-')) return 'es';
  return DEFAULT_LOCALE;
}

export function translate(locale, key, values = {}) {
  const normalized = normalizeLocale(locale);
  const template = dictionaries[normalized][key] ?? dictionaries[DEFAULT_LOCALE][key];
  if (template === undefined) throw new Error(`Missing i18n key: ${key}`);
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_, name) => {
    if (!(name in values)) throw new Error(`Missing i18n value: ${key}.${name}`);
    return String(values[name]);
  });
}

export function createI18n(initialLocale = DEFAULT_LOCALE) {
  let locale = normalizeLocale(initialLocale);
  const listeners = new Set();
  return Object.freeze({
    getLocale: () => locale,
    setLocale(value) {
      const next = normalizeLocale(value);
      if (next === locale) return locale;
      locale = next;
      for (const listener of listeners) listener();
      return locale;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    t: (key, values) => translate(locale, key, values),
  });
}
