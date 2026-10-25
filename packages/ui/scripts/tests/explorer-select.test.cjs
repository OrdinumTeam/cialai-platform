// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/terminals/explorer-select.js');
const ORDER = ['/p/a', '/p/b', '/p/c', '/p/d'];

test('a faixa do Shift pega os caminhos entre a âncora e o alvo, em qualquer sentido', async () => {
  const { rangeBetween } = await load();
  assert.deepEqual(rangeBetween(ORDER, '/p/b', '/p/d'), ['/p/b', '/p/c', '/p/d']);
  assert.deepEqual(rangeBetween(ORDER, '/p/d', '/p/b'), ['/p/b', '/p/c', '/p/d']);
  assert.deepEqual(rangeBetween(ORDER, '/p/b', '/p/b'), ['/p/b']);
  // Sem âncora, ou com âncora que saiu de vista, vale só o alvo.
  assert.deepEqual(rangeBetween(ORDER, null, '/p/c'), ['/p/c']);
  assert.deepEqual(rangeBetween(ORDER, '/fora', '/p/c'), ['/p/c']);
  assert.deepEqual(rangeBetween(ORDER, '/p/a', null), []);
});

test('o clique decide a seleção como no VS Code', async () => {
  const { clickSelection } = await load();
  // Clique simples seleciona só um e abre.
  let out = clickSelection(new Set(['/p/a']), ORDER, '/p/c', {});
  assert.deepEqual([...out.selection], ['/p/c']);
  assert.equal(out.anchor, '/p/c');
  assert.equal(out.open, true);
  // Mod adiciona sem abrir e, repetido, remove.
  out = clickSelection(new Set(['/p/a']), ORDER, '/p/c', { meta: true });
  assert.deepEqual([...out.selection].sort(), ['/p/a', '/p/c']);
  assert.equal(out.open, false);
  out = clickSelection(new Set(['/p/a', '/p/c']), ORDER, '/p/c', { meta: true });
  assert.deepEqual([...out.selection], ['/p/a']);
  // Shift estende a faixa desde a âncora, sem abrir.
  out = clickSelection(new Set(['/p/a']), ORDER, '/p/d', { shift: true, anchor: '/p/b' });
  assert.deepEqual([...out.selection], ['/p/b', '/p/c', '/p/d']);
  assert.equal(out.anchor, '/p/b');
  assert.equal(out.open, false);
});

test('a ação mira a seleção quando a entrada faz parte dela, senão só a entrada', async () => {
  const { actionPaths } = await load();
  const sel = new Set(['/p/c', '/p/a']);
  // Entrada dentro de uma seleção múltipla: a seleção inteira, na ordem da árvore.
  assert.deepEqual(actionPaths(ORDER, sel, '/p/a'), ['/p/a', '/p/c']);
  // Entrada fora da seleção: só ela.
  assert.deepEqual(actionPaths(ORDER, sel, '/p/d'), ['/p/d']);
  // Seleção de um só item não vira lote.
  assert.deepEqual(actionPaths(ORDER, new Set(['/p/a']), '/p/b'), ['/p/b']);
});
