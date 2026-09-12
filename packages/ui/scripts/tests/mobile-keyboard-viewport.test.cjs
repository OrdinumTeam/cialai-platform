// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/mobile/keyboard-viewport.js');

test('teclado aberto devolve a caixa visivel arredondada', async () => {
  const { keyboardBox } = await load();
  assert.deepEqual(keyboardBox({ height: 411.6, offsetTop: 0, scale: 1 }, 812), { top: 0, height: 412 });
  assert.deepEqual(keyboardBox({ height: 400, offsetTop: 52.4, scale: 1 }, 812), { top: 52, height: 400 });
});

test('teclado fechado, diferenca pequena ou zoom nao mudam a casca', async () => {
  const { keyboardBox, KEYBOARD_MIN_PX } = await load();
  assert.equal(keyboardBox({ height: 812, offsetTop: 0, scale: 1 }, 812), null);
  assert.equal(keyboardBox({ height: 812 - KEYBOARD_MIN_PX + 1, offsetTop: 0, scale: 1 }, 812), null);
  assert.equal(keyboardBox({ height: 406, offsetTop: 0, scale: 2 }, 812), null);
  assert.equal(keyboardBox(null, 812), null);
  assert.equal(keyboardBox({ height: Number.NaN }, 812), null);
});

test('caixas iguais sao reconhecidas para evitar redesenho', async () => {
  const { sameBox } = await load();
  assert.equal(sameBox(null, null), true);
  assert.equal(sameBox({ top: 0, height: 400 }, { top: 0, height: 400 }), true);
  assert.equal(sameBox({ top: 0, height: 400 }, { top: 10, height: 400 }), false);
  assert.equal(sameBox({ top: 0, height: 400 }, null), false);
});
