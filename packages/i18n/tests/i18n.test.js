// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SUPPORTED_LOCALES,
  createI18n,
  dictionaries,
  normalizeLocale,
  translate,
} from '../src/index.js';

test('Portuguese, English and Spanish dictionaries have the same keys', () => {
  assert.deepEqual(SUPPORTED_LOCALES, ['pt-BR', 'en', 'es']);
  const portugueseKeys = Object.keys(dictionaries['pt-BR']).sort();
  assert.deepEqual(Object.keys(dictionaries.en).sort(), portugueseKeys);
  assert.deepEqual(Object.keys(dictionaries.es).sort(), portugueseKeys);
});

test('locale normalization keeps Portuguese as the safe fallback', () => {
  assert.equal(normalizeLocale('en-US'), 'en');
  assert.equal(normalizeLocale('es'), 'es');
  assert.equal(normalizeLocale('es-MX'), 'es');
  assert.equal(normalizeLocale('ES_es'), 'es');
  assert.equal(normalizeLocale('pt-PT'), 'pt-BR');
  assert.equal(normalizeLocale('unknown'), 'pt-BR');
});

test('language changes notify subscribers and translations fail closed', () => {
  const i18n = createI18n('pt-BR');
  let changes = 0;
  const unsubscribe = i18n.subscribe(() => { changes += 1; });
  assert.equal(i18n.t('navigation.more'), 'Mais');
  i18n.setLocale('en');
  assert.equal(i18n.t('navigation.more'), 'More');
  i18n.setLocale('es-AR');
  assert.equal(i18n.t('navigation.more'), 'Más');
  assert.equal(changes, 2);
  assert.throws(() => translate('en', 'missing.key'), /Missing i18n key/);
  assert.equal(unsubscribe(), true);
});
