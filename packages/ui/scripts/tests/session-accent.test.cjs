// SPDX-License-Identifier: Apache-2.0
// Confere o tom de destaque das sessoes sem abrir o app.
//
// A cor escolhida para um card substitui o rosa em tudo que pertence a
// sessao, e sem cor vale o rosa do Cialai. O que aqui quebra em silencio e o
// contraste: uma cor clara no tema claro, ou escura no escuro, deixaria o
// nome do agente e os percentuais ilegiveis.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/terminals/session-accent.js');
const palette = () => import('../../src/lib/organization-colors.js');

test('sem cor, ou com cor desconhecida, vale o rosa do Cialai', async () => {
  const { DEFAULT_ACCENT, resolveSessionAccent } = await load();
  for (const color of [null, undefined, '', 'nao-existe']) {
    const accent = resolveSessionAccent(color);
    assert.equal(accent.custom, false);
    assert.equal(accent.id, null);
    assert.equal(accent.light.base, DEFAULT_ACCENT.light);
    assert.equal(accent.dark.base, DEFAULT_ACCENT.dark);
  }
  assert.equal(DEFAULT_ACCENT.light, '#E23B84');
  assert.equal(DEFAULT_ACCENT.dark, '#FF7AB2');
});

test('uma cor da paleta vira a base nos dois temas', async () => {
  const { resolveSessionAccent } = await load();
  const accent = resolveSessionAccent('azul');
  assert.equal(accent.custom, true);
  assert.equal(accent.id, 'azul');
  assert.equal(accent.light.base, '#1A4FA0');
  assert.equal(accent.dark.base, '#4A8AE6');
  assert.match(accent.light.soft, /^rgba\(26,79,160,0\.1\)$/);
  assert.match(accent.dark.ring, /^rgba\(74,138,230,0\.38\)$/);
});

test('o texto de destaque passa de 4,5:1 em todas as cores e superficies', async () => {
  const { ACCENT_SURFACES, TEXT_CONTRAST, contrast, resolveSessionAccent } = await load();
  const { ORGANIZATION_COLORS } = await palette();
  for (const id of [null, ...ORGANIZATION_COLORS.map((entry) => entry.id)]) {
    const accent = resolveSessionAccent(id);
    for (const theme of ['light', 'dark']) {
      for (const surface of ACCENT_SURFACES[theme]) {
        const ratio = contrast(accent[theme].text, surface);
        assert.ok(ratio >= TEXT_CONTRAST, `${id || 'rosa'} ${theme} ${surface}: ${ratio.toFixed(2)}`);
      }
    }
  }
});

test('o texto sobre a base cheia e o mais legivel entre branco e ameixa', async () => {
  const { contrast, onAccent, resolveSessionAccent } = await load();
  const { ORGANIZATION_COLORS } = await palette();
  for (const id of [null, ...ORGANIZATION_COLORS.map((entry) => entry.id)]) {
    const accent = resolveSessionAccent(id);
    for (const theme of ['light', 'dark']) {
      const { base, onBase } = accent[theme];
      const other = onBase === '#FFFFFF' ? '#3A1B33' : '#FFFFFF';
      assert.ok(contrast(onBase, base) >= contrast(other, base), `${id || 'rosa'} ${theme}`);
    }
  }
  assert.equal(onAccent('#E23B84'), '#FFFFFF');
  assert.equal(onAccent('#FF7AB2'), '#3A1B33');
});

test('cada sessao recebe as proprias variaveis, sempre preenchidas', async () => {
  const { sessionAccentStyle } = await load();
  const blue = sessionAccentStyle({ color: 'azul' });
  const green = sessionAccentStyle({ color: 'verde' });
  const plain = sessionAccentStyle({ color: null });
  const names = Object.keys(plain).sort();
  assert.deepEqual(Object.keys(blue).sort(), names);
  assert.equal(names.length, 14);
  for (const name of ['--session-accent-light', '--session-accent-text-dark', '--session-on-accent-light', '--session-accent-soft-dark', '--session-accent-ring-light', '--session-accent-border-dark']) {
    assert.ok(names.includes(name), name);
  }
  assert.notEqual(blue['--session-accent-light'], green['--session-accent-light']);
  assert.equal(plain['--session-accent-light'], '#E23B84');
  // Mudar a cor de uma sessao nao mexe no objeto devolvido para outra.
  blue['--session-accent-light'] = '#000000';
  assert.equal(sessionAccentStyle({ color: 'azul' })['--session-accent-light'], '#1A4FA0');
  assert.equal(sessionAccentStyle(undefined)['--session-accent-dark'], '#FF7AB2');
});

test('a Barra de IA fica no tom da sessao selecionada', async () => {
  const { barAccent } = await load();
  assert.equal(barAccent({ id: 'a', color: 'verde' }), 'verde');
  assert.equal(barAccent({ id: 'b', color: 'azul' }), 'azul');
  // Sem sessao, sem cor ou com cor que a paleta nao conhece, o rosa.
  assert.equal(barAccent(null), null);
  assert.equal(barAccent({ id: 'c', color: null }), null);
  assert.equal(barAccent({ id: 'd', color: 'nao-existe' }), null);
});
