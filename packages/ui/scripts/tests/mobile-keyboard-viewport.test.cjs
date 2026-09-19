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
  assert.equal(sameBox({ top: 0, height: 400, keyboard: true }, { top: 0, height: 400, keyboard: false }), false);
});

test('a area visivel e medida com o teclado fechado, e nao so com ele aberto', async () => {
  const { viewportBox } = await load();
  // Sem teclado a casca continua com uma medida propria, a da tela inteira.
  assert.deepEqual(viewportBox({ height: 812, offsetTop: 0, scale: 1 }, 812), { top: 0, height: 812, keyboard: false });
  // Com teclado a medida encolhe e o estado do teclado vira verdadeiro.
  assert.deepEqual(viewportBox({ height: 400, offsetTop: 0, scale: 1 }, 812), { top: 0, height: 400, keyboard: true });
});

test('sem medida confiavel a casca cai na folha, que usa 100dvh', async () => {
  const { viewportBox } = await load();
  assert.equal(viewportBox(null, 812), null);
  assert.equal(viewportBox({ height: 406, offsetTop: 0, scale: 2 }, 812), null, 'zoom por pincar nao encolhe a casca');
  assert.equal(viewportBox({ height: 0, offsetTop: 0, scale: 1 }, 812), null);
  assert.equal(viewportBox({ height: 400, offsetTop: 0, scale: 1 }, 0), null);
});

test('a altura nunca passa da pagina, mesmo com o visualViewport maior', async () => {
  const { viewportBox } = await load();
  assert.deepEqual(viewportBox({ height: 900, offsetTop: 0, scale: 1 }, 812), { top: 0, height: 812, keyboard: false });
});

// A regressao de 19/09/2026: o botao nativo de concluir recolhia o teclado e a
// pagina ficava com a altura dele, com uma faixa vazia embaixo. Acontecia
// porque a altura so era escrita enquanto o encolhimento passava do limiar.
// Aqui a ultima medida de cada passo e sempre a altura visivel daquele
// momento, entao uma medida intermediaria perdida nao deixa resto.
test('o ciclo de abrir e recolher o teclado devolve a pagina inteira em cada passo', async () => {
  const { viewportBox } = await load();
  const page = 812;
  const passos = [812, 400, 400, 640, 812];
  const alturas = passos.map((height) => viewportBox({ height, offsetTop: 0, scale: 1 }, page).height);
  assert.deepEqual(alturas, [812, 400, 400, 640, 812]);
  // Mesmo pulando os passos do meio, o primeiro evento que chegar depois do
  // fechamento ja devolve a pagina inteira.
  assert.equal(viewportBox({ height: 812, offsetTop: 0, scale: 1 }, page).height, page);
  assert.equal(viewportBox({ height: 812, offsetTop: 0, scale: 1 }, page).keyboard, false);
});

test('a casca desce junto quando o iOS rola a pagina para revelar o campo', async () => {
  const { viewportBox } = await load();
  assert.deepEqual(viewportBox({ height: 400, offsetTop: 120, scale: 1 }, 812), { top: 120, height: 400, keyboard: true });
  // Rolagem negativa nao existe para a casca.
  assert.equal(viewportBox({ height: 400, offsetTop: -8, scale: 1 }, 812).top, 0);
});
