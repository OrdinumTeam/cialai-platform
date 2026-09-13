// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import { createI18n } from '@cialai/i18n';

export const LANGUAGE_STORAGE_KEY = 'cialai_language';

function systemLocale() {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return 'pt-BR';
  return navigator.languages?.[0] || navigator.language || 'pt-BR';
}

function initialLocale() {
  try { return localStorage.getItem(LANGUAGE_STORAGE_KEY) || systemLocale(); }
  catch (_error) { return systemLocale(); }
}

const i18n = createI18n(initialLocale());

function applyDocumentLocale(locale) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale;
  document.documentElement.dataset.locale = locale;
}

applyDocumentLocale(i18n.getLocale());

export const getLocale = i18n.getLocale;
export const translate = i18n.t;

export function setLocale(value) {
  const locale = i18n.setLocale(value);
  try { localStorage.setItem(LANGUAGE_STORAGE_KEY, locale); } catch (_error) { /* storage unavailable */ }
  applyDocumentLocale(locale);
  return locale;
}

export function useI18n() {
  const locale = useSyncExternalStore(i18n.subscribe, i18n.getLocale, i18n.getLocale);
  return { locale, setLocale, t: translate };
}
