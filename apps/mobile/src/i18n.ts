// SPDX-License-Identifier: Apache-2.0
import { useSyncExternalStore } from 'react';
import * as SecureStore from 'expo-secure-store';
import { createI18n, type Locale } from '@cialai/i18n';

export const LANGUAGE_STORAGE_KEY = 'cialai.language';

function deviceLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'pt-BR';
  }
}

export const i18n = createI18n(deviceLocale());
export const getLocale = i18n.getLocale;
export const subscribeLocale = i18n.subscribe;
export const t = i18n.t;

const SENSITIVE_REASON_KEYS = Object.freeze<Record<string, string>>({
  'Autorizar digitação neste terminal': 'mobile.biometric.authorizeTyping',
  'Encerrar este terminal': 'mobile.biometric.closeTerminal',
  'Autorizar alteração no computador': 'mobile.biometric.changeComputer',
});

export function localizeSensitiveReason(reason: string): string {
  const key = SENSITIVE_REASON_KEYS[reason];
  return key ? t(key) : reason;
}

export async function hydrateLocale(): Promise<Locale> {
  try {
    const stored = await SecureStore.getItemAsync(LANGUAGE_STORAGE_KEY);
    if (stored) return i18n.setLocale(stored);
  } catch {
    // O idioma do aparelho continua ativo quando o armazenamento não responde.
  }
  return i18n.getLocale();
}

export async function setLocale(value: unknown): Promise<Locale> {
  const locale = i18n.setLocale(value);
  try {
    await SecureStore.setItemAsync(LANGUAGE_STORAGE_KEY, locale);
  } catch {
    // A seleção continua válida na sessão atual quando a persistência falha.
  }
  return locale;
}

export function useI18n() {
  const locale = useSyncExternalStore(i18n.subscribe, i18n.getLocale, i18n.getLocale);
  return { locale, setLocale, t };
}
