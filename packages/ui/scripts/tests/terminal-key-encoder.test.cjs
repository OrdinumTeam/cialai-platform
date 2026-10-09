// SPDX-License-Identifier: Apache-2.0
// Sequências do teclado especial: o que um terminal de verdade manda ao PTY
// para cada tecla e combinação.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/terminals/key-encoder.js');
const ESC = '\x1b';

test('Ctrl com letra sai como caractere de controle, não como copiar', async () => {
  const { encodeKey } = await load();
  assert.equal(encodeKey('c', { ctrl: true }), '\x03');
  assert.equal(encodeKey('d', { ctrl: true }), '\x04');
  assert.equal(encodeKey('l', { ctrl: true }), '\x0c');
  assert.equal(encodeKey('v', { ctrl: true }), '\x16');
  assert.equal(encodeKey('a', { ctrl: true }), '\x01');
  assert.equal(encodeKey('z', { ctrl: true }), '\x1a');
  assert.equal(encodeKey('C', { ctrl: true }), '\x03');
});

test('Ctrl Shift P sai como o Ctrl P legado dos terminais do Linux', async () => {
  const { encodeKey } = await load();
  assert.equal(encodeKey('p', { ctrl: true, shift: true }), '\x10');
});

test('Ctrl com símbolos segue o mapa legado', async () => {
  const { encodeKey } = await load();
  assert.equal(encodeKey(' ', { ctrl: true }), '\x00');
  assert.equal(encodeKey('[', { ctrl: true }), ESC);
  assert.equal(encodeKey('\\', { ctrl: true }), '\x1c');
  assert.equal(encodeKey(']', { ctrl: true }), '\x1d');
  assert.equal(encodeKey('_', { ctrl: true }), '\x1f');
  assert.equal(encodeKey('?', { ctrl: true }), '\x7f');
  assert.equal(encodeKey('2', { ctrl: true }), '\x00');
  assert.equal(encodeKey('.', { ctrl: true }), '.');
});

test('Alt e Meta prefixam ESC, com Shift na forma maiúscula', async () => {
  const { encodeKey } = await load();
  assert.equal(encodeKey('b', { alt: true }), `${ESC}b`);
  assert.equal(encodeKey('f', { alt: true }), `${ESC}f`);
  assert.equal(encodeKey('b', { alt: true, shift: true }), `${ESC}B`);
  assert.equal(encodeKey('1', { alt: true, shift: true }), `${ESC}!`);
  assert.equal(encodeKey('x', { meta: true }), `${ESC}x`);
  assert.equal(encodeKey('c', { ctrl: true, alt: true }), `${ESC}\x03`);
  assert.equal(encodeKey('é', { alt: true }), `${ESC}é`);
});

test('setas respeitam o modo de cursor e levam o modificador no parâmetro', async () => {
  const { encodeKey } = await load();
  assert.equal(encodeKey('ArrowUp'), `${ESC}[A`);
  assert.equal(encodeKey('ArrowDown'), `${ESC}[B`);
  assert.equal(encodeKey('ArrowRight'), `${ESC}[C`);
  assert.equal(encodeKey('ArrowLeft'), `${ESC}[D`);
  assert.equal(encodeKey('ArrowUp', {}, { applicationCursor: true }), `${ESC}OA`);
  assert.equal(encodeKey('ArrowLeft', {}, { applicationCursor: true }), `${ESC}OD`);
  assert.equal(encodeKey('ArrowRight', { ctrl: true }), `${ESC}[1;5C`);
  assert.equal(encodeKey('ArrowRight', { ctrl: true }, { applicationCursor: true }), `${ESC}[1;5C`);
  assert.equal(encodeKey('ArrowUp', { shift: true }), `${ESC}[1;2A`);
  assert.equal(encodeKey('ArrowLeft', { alt: true }), `${ESC}[1;3D`);
  assert.equal(encodeKey('ArrowDown', { ctrl: true, shift: true, alt: true, meta: true }), `${ESC}[1;16B`);
});

test('Home, End, Page Up e Page Down', async () => {
  const { encodeKey } = await load();
  assert.equal(encodeKey('Home'), `${ESC}[H`);
  assert.equal(encodeKey('End'), `${ESC}[F`);
  assert.equal(encodeKey('Home', {}, { applicationCursor: true }), `${ESC}OH`);
  assert.equal(encodeKey('End', {}, { applicationCursor: true }), `${ESC}OF`);
  assert.equal(encodeKey('Home', { ctrl: true }), `${ESC}[1;5H`);
  assert.equal(encodeKey('PageUp'), `${ESC}[5~`);
  assert.equal(encodeKey('PageDown'), `${ESC}[6~`);
  assert.equal(encodeKey('PageUp', { ctrl: true }), `${ESC}[5;5~`);
  assert.equal(encodeKey('Insert'), `${ESC}[2~`);
  assert.equal(encodeKey('Delete'), `${ESC}[3~`);
  assert.equal(encodeKey('Delete', { shift: true }), `${ESC}[3;2~`);
});

test('Tab, Shift Tab, Enter, Esc e Backspace', async () => {
  const { encodeKey } = await load();
  assert.equal(encodeKey('Tab'), '\t');
  assert.equal(encodeKey('Tab', { shift: true }), `${ESC}[Z`);
  assert.equal(encodeKey('Enter'), '\r');
  assert.equal(encodeKey('Enter', { alt: true }), `${ESC}\r`);
  assert.equal(encodeKey('Escape'), ESC);
  assert.equal(encodeKey('Escape', { alt: true }), `${ESC}${ESC}`);
  assert.equal(encodeKey('Backspace'), '\x7f');
  assert.equal(encodeKey('Backspace', { ctrl: true }), '\b');
  assert.equal(encodeKey('Backspace', { alt: true }), `${ESC}\x7f`);
});

test('teclas de função F1 a F12', async () => {
  const { encodeKey } = await load();
  assert.deepEqual(['F1', 'F2', 'F3', 'F4'].map((key) => encodeKey(key)), [`${ESC}OP`, `${ESC}OQ`, `${ESC}OR`, `${ESC}OS`]);
  assert.deepEqual(['F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].map((key) => encodeKey(key)), [15, 17, 18, 19, 20, 21, 23, 24].map((n) => `${ESC}[${n}~`));
  assert.equal(encodeKey('F1', { shift: true }), `${ESC}[1;2P`);
  assert.equal(encodeKey('F5', { ctrl: true }), `${ESC}[15;5~`);
});

test('modificador sozinho, tecla desconhecida ou texto longo não viram envio', async () => {
  const { encodeKey } = await load();
  for (const key of ['ctrl', 'Ctrl', 'alt', 'shift', 'meta', 'Meta', '', 'Unknown', 'ab', '\x07', null]) assert.equal(encodeKey(key, { ctrl: true }), null);
});
