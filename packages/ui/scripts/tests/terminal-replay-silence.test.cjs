// SPDX-License-Identifier: Apache-2.0
// Replay nunca gera entrada. Um xterm de verdade responde sozinho a ESC[6n e
// ESC[c ao reparsear o historico; a marca de replay de replay.js cala essas
// respostas ate o xterm terminar de processar os bytes. O teste usa o
// @xterm/xterm instalado, escreve um historico com as consultas e afirma que
// nada sai por onData durante o replay, e que a digitacao volta depois.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Terminal } = require('@xterm/xterm');
const load = () => import('../../src/terminals/replay.js');

function newTerm() {
  return new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
}

// Reproduz o caminho binario de runtime.js: consumeOutput corta o que a pagina
// ja tinha, a marca fica ligada ate o callback do term.write e onData so deixa
// passar quando a marca esta desligada.
function attachReplay(term, { offset, length }, bytes, { beginReplay, consumeOutput }) {
  const session = { term, replaying: false, replayRemaining: 0, outputOffset: 0, receivedOffset: 0 };
  const leaked = [];
  term.onData((data) => { if (session.replaying) return; leaked.push(data); });
  beginReplay(session, { offset, length });
  const output = consumeOutput(session, bytes);
  const closesReplay = session.replaying && (session.replayRemaining -= bytes.byteLength) <= 0;
  return new Promise((resolve) => {
    term.write(output, () => {
      if (closesReplay) { session.replaying = false; session.replayRemaining = 0; }
      resolve();
    });
  }).then(() => ({ session, leaked }));
}

test('o historico com ESC[6n e ESC[c nao vaza nada por onData durante o replay', async () => {
  const api = await load();
  const term = newTerm();
  const history = Buffer.from('linha antiga\r\nprompt$ \x1b[6n\x1b[c\x1b[>c');
  const { session, leaked } = await attachReplay(term, { offset: 0, length: history.length }, new Uint8Array(history), api);
  assert.deepEqual(leaked, [], 'nenhuma resposta do xterm pode sair como digitacao');
  assert.equal(session.replaying, false, 'a marca desliga depois que o xterm processou o replay');
});

test('sem a marca um xterm de verdade responde as consultas do historico', async () => {
  const term = newTerm();
  const history = Buffer.from('prompt$ \x1b[6n\x1b[c\x1b[>c');
  const echoed = [];
  term.onData((data) => echoed.push(data));
  await new Promise((resolve) => term.write(history, resolve));
  assert.ok(echoed.length >= 2, 'o xterm responde a ESC[6n e ESC[c quando nada o cala');
});

test('a digitacao volta a sair por onData depois do replay', async () => {
  const api = await load();
  const term = newTerm();
  const history = Buffer.from('antes \x1b[6n');
  const { session, leaked } = await attachReplay(term, { offset: 0, length: history.length }, new Uint8Array(history), api);
  assert.deepEqual(leaked, []);
  // Mesma guarda de onData de runtime.js: com a marca desligada, term.input sai.
  term.input('ls\r', true);
  await new Promise((resolve) => term.write('', resolve));
  assert.equal(session.replaying, false);
  assert.deepEqual(leaked, ['ls\r'], 'a digitacao depois do replay chega por onData');
});

test('replay de historico vazio nao deixa a marca presa', async () => {
  const { beginReplay } = await load();
  const session = { replaying: false, replayRemaining: 0, outputOffset: 5, receivedOffset: 0 };
  beginReplay(session, { offset: 5, length: 0 });
  assert.equal(session.replaying, false, 'sem quadro de replay a marca nunca liga, senao ficaria presa');
  assert.equal(session.outputOffset, 5);
});
