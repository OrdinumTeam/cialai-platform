// SPDX-License-Identifier: Apache-2.0
// Gera o catálogo dos textos nativos do desktop a partir de @cialai/i18n. O
// Rust embute o arquivo e escolhe o idioma enviado pela interface, então menu,
// diálogos e mensagens do núcleo não mantêm dicionário próprio.
//
//   node tools/i18n/native-catalog.mjs          grava o catálogo
//   node tools/i18n/native-catalog.mjs --check  falha se o arquivo divergir
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { DEFAULT_LOCALE, SUPPORTED_LOCALES, dictionaries } from '@cialai/i18n';

export const NATIVE_PREFIX = 'native.';
const root = fileURLToPath(new URL('../../', import.meta.url));
export const CATALOG_PATH = 'apps/desktop/src-tauri/i18n/native.json';

export function nativeCatalog(source = dictionaries) {
  const locales = {};
  for (const locale of SUPPORTED_LOCALES) {
    locales[locale] = Object.fromEntries(Object.entries(source[locale])
      .filter(([key]) => key.startsWith(NATIVE_PREFIX))
      .sort(([left], [right]) => left.localeCompare(right, 'en')));
  }
  return { generatedBy: 'tools/i18n/native-catalog.mjs', defaultLocale: DEFAULT_LOCALE, locales };
}

export const renderCatalog = (catalog = nativeCatalog()) => `${JSON.stringify(catalog, null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = `${root}${CATALOG_PATH}`;
  const expected = renderCatalog();
  if (process.argv.includes('--check')) {
    let current = '';
    try { current = readFileSync(target, 'utf8'); } catch { /* ausente conta como divergente */ }
    if (current !== expected) {
      console.error(`FAIL native i18n: ${CATALOG_PATH} diverge de packages/i18n; rode npm run i18n:native`);
      process.exitCode = 1;
    } else {
      console.log(`PASS native i18n catalog: ${Object.keys(nativeCatalog().locales[DEFAULT_LOCALE]).length} chaves em ${SUPPORTED_LOCALES.length} idiomas`);
    }
  } else {
    writeFileSync(target, expected);
    console.log(`wrote ${CATALOG_PATH}`);
  }
}
