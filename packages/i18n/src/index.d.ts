// SPDX-License-Identifier: Apache-2.0
export type Locale = 'pt-BR' | 'en';
export type TranslationValues = Record<string, string | number>;

export declare const DEFAULT_LOCALE: Locale;
export declare const SUPPORTED_LOCALES: readonly Locale[];
export declare const dictionaries: Readonly<Record<Locale, Readonly<Record<string, string>>>>;
export declare function normalizeLocale(value: unknown): Locale;
export declare function translate(locale: unknown, key: string, values?: TranslationValues): string;
export declare function createI18n(initialLocale?: unknown): Readonly<{
  getLocale(): Locale;
  setLocale(value: unknown): Locale;
  subscribe(listener: () => void): () => boolean;
  t(key: string, values?: TranslationValues): string;
}>;
