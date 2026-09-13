// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import { createI18n } from '@cialai/i18n';

export const LANGUAGE_STORAGE_KEY = 'cialai_language';

function initialLocale() {
  // Fora do navegador e da WebView, como nos testes em Node, o idioma do
  // processo não representa o celular: vale o padrão em português.
  if (typeof globalThis.document === 'undefined') return 'pt-BR';
  try {
    const stored = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // A WebView can deny storage before its local origin is ready.
  }
  return globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language ?? 'pt-BR';
}

const instance = createI18n(initialLocale());

function applyLocale(locale) {
  if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = locale;
}

applyLocale(instance.getLocale());

export function setLocale(locale) {
  const next = instance.setLocale(locale);
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, next);
  } catch {
    // Switching still works for the current session when storage is denied.
  }
  applyLocale(next);
  return next;
}

export const translate = (key, values) => instance.t(key, values);

export function useI18n() {
  const locale = useSyncExternalStore(instance.subscribe, instance.getLocale, instance.getLocale);
  return {
    locale,
    setLocale,
    t: translate,
    toggleLocale: () => setLocale(locale === 'en' ? 'pt-BR' : 'en'),
  };
}
