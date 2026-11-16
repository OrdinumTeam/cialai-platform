// SPDX-License-Identifier: Apache-2.0
// Toque curto, toque longo e mouse nos botões da barra do terminal do celular.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/terminals/keybar-gesture.js');

// Relógio manual: `advance` dispara o que venceu.
function clock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    schedule(fn, ms) { const id = next++; timers.set(id, { at: now + ms, fn }); return id; },
    cancel(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) { timers.delete(id); timer.fn(); }
      }
    },
    pending: () => timers.size,
  };
}

async function setup() {
  const { createHintGesture, HINT_HOLD_MS, HINT_HOVER_MS } = await load();
  const time = clock();
  const shown = [];
  let visible = null;
  const gesture = createHintGesture({
    show: (id, anchor) => { visible = id; shown.push({ id, anchor }); },
    hide: () => { visible = null; },
    schedule: time.schedule,
    cancel: time.cancel,
  });
  return { gesture, time, shown, visible: () => visible, HINT_HOLD_MS, HINT_HOVER_MS };
}

test('toque curto executa e nunca mostra o nome', async () => {
  const { gesture, time, shown, visible, HINT_HOLD_MS } = await setup();
  gesture.pointerDown('Enter', 'touch', { left: 0 });
  time.advance(HINT_HOLD_MS - 50);
  gesture.pointerUp('touch');
  assert.equal(gesture.click('Enter'), true, 'o click do toque curto executa');
  time.advance(HINT_HOLD_MS * 2);
  assert.equal(shown.length, 0);
  assert.equal(visible(), null);
  assert.equal(time.pending(), 0);
});

test('segurar mostra só o nome, que some ao soltar, e o click do fim não executa', async () => {
  const { gesture, time, shown, visible, HINT_HOLD_MS } = await setup();
  gesture.pointerDown('CtrlC', 'touch', { left: 10, top: 500, width: 40, bottom: 548 });
  time.advance(HINT_HOLD_MS);
  assert.equal(visible(), 'CtrlC');
  assert.deepEqual(shown, [{ id: 'CtrlC', anchor: { left: 10, top: 500, width: 40, bottom: 548 } }]);
  gesture.pointerUp('touch');
  assert.equal(visible(), null, 'o balão some quando o gesto termina');
  assert.equal(gesture.click('CtrlC'), false, 'soltar depois do toque longo não interrompe nada');
  // O toque seguinte volta a executar.
  gesture.pointerDown('CtrlC', 'touch');
  gesture.pointerUp('touch');
  assert.equal(gesture.click('CtrlC'), true);
});

test('toque longo sem click no fim não prende o próximo toque', async () => {
  const { gesture, time, HINT_HOLD_MS } = await setup();
  gesture.pointerDown('Escape', 'touch');
  time.advance(HINT_HOLD_MS);
  gesture.pointerCancel();
  // O sistema não mandou click; o próximo toque curto executa normalmente.
  gesture.pointerDown('Escape', 'touch');
  gesture.pointerUp('touch');
  assert.equal(gesture.click('Escape'), true);
});

test('dedo que sai do botão ou gesto cancelado esconde o nome e cancela a espera', async () => {
  const { gesture, time, shown, visible, HINT_HOLD_MS } = await setup();
  gesture.pointerDown('keys', 'touch');
  gesture.pointerLeave();
  time.advance(HINT_HOLD_MS);
  assert.equal(shown.length, 0);
  gesture.pointerDown('keys', 'pen');
  time.advance(HINT_HOLD_MS);
  assert.equal(visible(), 'keys', 'caneta conta como toque');
  gesture.pointerCancel();
  assert.equal(visible(), null);
});

test('mouse: o nome aparece com o cursor parado, some ao sair, e o clique executa', async () => {
  const { gesture, time, visible, HINT_HOVER_MS, HINT_HOLD_MS } = await setup();
  gesture.pointerEnter('quick', 'mouse', { left: 0 });
  time.advance(HINT_HOVER_MS - 1);
  assert.equal(visible(), null);
  time.advance(1);
  assert.equal(visible(), 'quick');
  // Segurar o botão do mouse não vira toque longo.
  gesture.pointerDown('quick', 'mouse');
  time.advance(HINT_HOLD_MS * 2);
  gesture.pointerUp('mouse');
  assert.equal(gesture.click('quick'), true);
  assert.equal(visible(), null, 'o clique esconde o nome');
  gesture.pointerEnter('compose', 'mouse');
  gesture.pointerLeave();
  time.advance(HINT_HOVER_MS);
  assert.equal(visible(), null, 'cursor que passou direto não mostra nada');
  // Toque não mostra o nome só por entrar no botão.
  gesture.pointerEnter('compose', 'touch');
  time.advance(HINT_HOVER_MS);
  assert.equal(visible(), null);
});

test('teclado e leitor de tela executam pelo click sem gesto de ponteiro', async () => {
  const { gesture } = await setup();
  assert.equal(gesture.click('Enter'), true);
});

test('o balão fica dentro da tela, centrado no botão quando cabe, e desce só sem espaço acima', async () => {
  const { placeHint, HINT_EDGE } = await load();
  const size = { width: 120, height: 30 };
  // Centrado no botão do meio.
  assert.deepEqual(placeHint({ left: 170, top: 700, width: 40, bottom: 748 }, size, 390), { left: 130, top: 662, arrow: 60, below: false });
  // Botão da borda esquerda: o balão encosta na margem e a ponta segue o botão.
  const left = placeHint({ left: 4, top: 700, width: 40, bottom: 748 }, size, 390);
  assert.equal(left.left, HINT_EDGE);
  assert.equal(left.arrow, 16);
  // Botão da borda direita.
  const right = placeHint({ left: 346, top: 700, width: 40, bottom: 748 }, size, 390);
  assert.equal(right.left, 390 - 120 - HINT_EDGE);
  assert.equal(right.arrow, 104);
  // Sem espaço acima, o balão vai para baixo do botão.
  assert.deepEqual(placeHint({ left: 170, top: 20, width: 40, bottom: 68 }, size, 390), { left: 130, top: 76, arrow: 60, below: true });
  // Tela mais estreita que o balão: fica na margem.
  assert.equal(placeHint({ left: 0, top: 700, width: 40, bottom: 748 }, { width: 400, height: 30 }, 320).left, HINT_EDGE);
});
