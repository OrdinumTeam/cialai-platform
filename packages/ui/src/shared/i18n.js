// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import { createI18n } from '@cialai/i18n';

export const LANGUAGE_STORAGE_KEY = 'cialai_language';

function systemLocale() {
  if (typeof globalThis.document === 'undefined' || typeof globalThis.navigator === 'undefined') return 'pt-BR';
  return globalThis.navigator.languages?.[0] || globalThis.navigator.language || 'pt-BR';
}

function initialLocale() {
  const shellLocale = globalThis.__CIALAI_SHELL__?.locale;
  if (shellLocale) return shellLocale;
  try {
    const stored = globalThis.localStorage?.getItem(LANGUAGE_STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // A WebView pode negar o armazenamento antes que a origem local esteja pronta.
  }
  return systemLocale();
}

const instance = createI18n(initialLocale());

function applyLocale(locale) {
  const root = globalThis.document?.documentElement;
  if (!root) return;
  root.lang = locale;
  if (root.dataset) root.dataset.locale = locale;
  else root.setAttribute?.('data-locale', locale);
}

applyLocale(instance.getLocale());

export const getLocale = instance.getLocale;
export const translate = instance.t;

export function setLocale(value) {
  const locale = instance.setLocale(value);
  try {
    globalThis.localStorage?.setItem(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    // A escolha continua válida nesta sessão quando o armazenamento não está disponível.
  }
  applyLocale(locale);
  return locale;
}

export function useI18n() {
  const locale = useSyncExternalStore(instance.subscribe, instance.getLocale, instance.getLocale);
  return { locale, setLocale, t: translate };
}
