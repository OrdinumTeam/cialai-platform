// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';

import { createI18n, dictionaries, normalizeLocale, translate } from '../src/index.js';

test('Portuguese and English dictionaries have the same keys', () => {
  assert.deepEqual(Object.keys(dictionaries.en).sort(), Object.keys(dictionaries['pt-BR']).sort());
});

test('locale normalization keeps Portuguese as the safe fallback', () => {
  assert.equal(normalizeLocale('en-US'), 'en');
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
  assert.equal(changes, 1);
  assert.throws(() => translate('en', 'missing.key'), /Missing i18n key/);
  assert.equal(unsubscribe(), true);
});
