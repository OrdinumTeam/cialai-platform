// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/terminals/touch-scroll.js');

async function harness({ rowHeight = 16, scrollback = true } = {}) {
  const { createTouchScroll, ...constants } = await load();
  const calls = { scrolled: [], keys: [], wheel: [], frames: [] }; let nextFrame = 1;
  const scroll = createTouchScroll({
    rowHeight: () => rowHeight,
    scrollLines: (rows) => calls.scrolled.push(rows),
    sendKeys: (data) => calls.keys.push(data),
    sendWheel: (direction, count) => calls.wheel.push([direction, count]),
    hasScrollback: () => scrollback,
    requestFrame: (callback) => { const id = nextFrame++; calls.frames.push({ id, callback }); return id; },
    cancelFrame: (id) => { calls.frames = calls.frames.filter((frame) => frame.id !== id); },
  });
  const runFrame = (time) => { const frame = calls.frames.shift(); assert.ok(frame, 'quadro agendado'); frame.callback(time); };
  return { scroll, calls, runFrame, ...constants };
}

test('arrastar para cima rola o buffer para baixo em linhas inteiras', async () => {
  const { scroll, calls } = await harness({ rowHeight: 16 }); scroll.start(300, 0); assert.equal(scroll.move(268, 16), 2); assert.deepEqual(calls.scrolled, [2]); assert.equal(calls.keys.length, 0);
});
test('arrastar para baixo rola o buffer para cima', async () => {
  const { scroll, calls } = await harness({ rowHeight: 16 }); scroll.start(100, 0); scroll.move(148, 16); assert.deepEqual(calls.scrolled, [-3]);
});
test('movimentos menores acumulam ate completar uma linha', async () => {
  const { scroll, calls } = await harness({ rowHeight: 20 }); scroll.start(200, 0); assert.equal(scroll.move(192, 16), 0); assert.equal(scroll.move(184, 32), 0); assert.equal(scroll.move(176, 48), 1); assert.deepEqual(calls.scrolled, [1]);
});
test('um toque parado nao rola nem dispara inercia', async () => {
  const { scroll, calls } = await harness(); scroll.start(200, 0); scroll.move(200, 16); assert.equal(scroll.end(40), false); assert.deepEqual(calls.scrolled, []); assert.equal(scroll.flinging, false);
});
test('um arrasto rapido continua rolando e desacelera', async () => {
  const { scroll, calls, runFrame } = await harness({ rowHeight: 16 }); scroll.start(500, 0);
  for (let i = 1; i <= 5; i += 1) scroll.move(500 - i * 40, i * 16);
  const dragged = calls.scrolled.reduce((sum, rows) => sum + rows, 0); assert.equal(scroll.end(80), true); assert.equal(scroll.flinging, true);
  let time = 80; let guard = 0; while (scroll.flinging && guard < 1000) { time += 16; runFrame(time); guard += 1; }
  assert.ok(guard < 1000); assert.ok(calls.scrolled.reduce((sum, rows) => sum + rows, 0) > dragged); assert.ok(calls.scrolled.every((rows) => rows > 0));
});
test('segurar o dedo parado impede a inercia', async () => {
  const { scroll, calls, FLING_HOLD_MS } = await harness({ rowHeight: 16 }); scroll.start(500, 0); for (let i = 1; i <= 5; i += 1) scroll.move(500 - i * 40, i * 16); assert.equal(scroll.end(80 + FLING_HOLD_MS + 1), false); assert.equal(scroll.flinging, false); assert.equal(calls.frames.length, 0);
});
test('um novo toque interrompe a inercia', async () => {
  const { scroll, calls } = await harness({ rowHeight: 16 }); scroll.start(500, 0); for (let i = 1; i <= 5; i += 1) scroll.move(500 - i * 40, i * 16); assert.equal(scroll.end(80), true); scroll.start(300, 200); assert.equal(scroll.flinging, false); assert.equal(calls.frames.length, 0);
});
test('no buffer alternativo o arrasto vira roda do mouse com teto e nunca setas', async () => {
  const { scroll, calls, MAX_WHEEL_PER_MOVE } = await harness({ rowHeight: 16, scrollback: false }); scroll.start(400, 0); scroll.move(240, 16); assert.deepEqual(calls.scrolled, []); assert.deepEqual(calls.keys, []); assert.deepEqual(calls.wheel, [[1, MAX_WHEEL_PER_MOVE]]); scroll.move(256, 32); assert.deepEqual(calls.wheel.at(-1), [-1, 1]); assert.equal(scroll.end(40), false); assert.deepEqual(calls.keys, []);
});
test('a inercia no buffer alternativo nao manda roda nem setas', async () => {
  const { scroll, calls } = await harness({ rowHeight: 16, scrollback: false }); scroll.start(500, 0); for (let i = 1; i <= 5; i += 1) scroll.move(500 - i * 40, i * 16); assert.equal(scroll.end(80), false); assert.equal(scroll.flinging, false); assert.deepEqual(calls.keys, []);
});
