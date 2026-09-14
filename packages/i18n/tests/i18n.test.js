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

test('translations keep the same named placeholders in all languages', () => {
  const placeholders = (value) => [...value.matchAll(/\{([A-Za-z][A-Za-z0-9]*)\}/g)].map((match) => match[1]).sort();
  for (const [key, value] of Object.entries(dictionaries['pt-BR'])) {
    assert.deepEqual(placeholders(dictionaries.en[key]), placeholders(value), `English placeholders differ for ${key}`);
    assert.deepEqual(placeholders(dictionaries.es[key]), placeholders(value), `Spanish placeholders differ for ${key}`);
  }
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
  assert.equal(i18n.t('view.terminais.label'), 'Terminais');
  i18n.setLocale('en');
  assert.equal(i18n.t('view.terminais.label'), 'Terminals');
  i18n.setLocale('es-AR');
  assert.equal(i18n.t('view.terminais.label'), 'Terminales');
  assert.equal(changes, 2);
  assert.throws(() => translate('en', 'missing.key'), /Missing i18n key/);
  assert.equal(unsubscribe(), true);
});
