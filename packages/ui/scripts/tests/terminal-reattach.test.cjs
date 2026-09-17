// SPDX-License-Identifier: Apache-2.0
// Agendador do reattach: escada com teto e a decisao do poll de 3 s.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/terminals/reattach.js');

test('a escada de backoff dobra ate o teto de 8 s', async () => {
  const { reattachDelay, REATTACH_DELAYS_MS } = await load();
  assert.deepEqual(REATTACH_DELAYS_MS, [500, 1000, 2000, 4000, 8000]);
  assert.deepEqual([0, 1, 2, 3, 4].map(reattachDelay), [500, 1000, 2000, 4000, 8000]);
});

test('acima do fim da escada o intervalo fica no teto', async () => {
  const { reattachDelay } = await load();
  assert.equal(reattachDelay(5), 8000);
  assert.equal(reattachDelay(50), 8000);
});

test('uma contagem invalida ou negativa cai na primeira tentativa', async () => {
  const { reattachDelay } = await load();
  assert.equal(reattachDelay(0), 500);
  assert.equal(reattachDelay(-3), 500);
  assert.equal(reattachDelay(undefined), 500);
  assert.equal(reattachDelay(NaN), 500);
});

test('o poll nunca reattacha sessao em erro', async () => {
  const { shouldReattachOnPoll } = await load();
  assert.equal(shouldReattachOnPoll({ status: 'error', visible: true }), false);
  assert.equal(shouldReattachOnPoll({ status: 'error', visible: false }), false);
});

test('sessao estacionada fora da tela espera ser exibida', async () => {
  const { shouldReattachOnPoll } = await load();
  assert.equal(shouldReattachOnPoll({ status: 'disconnected', visible: false }), false);
  assert.equal(shouldReattachOnPoll({ status: 'disconnected', visible: true }), true);
});

test('sessao recem descoberta entra mesmo fora da tela', async () => {
  const { shouldReattachOnPoll } = await load();
  assert.equal(shouldReattachOnPoll({ status: 'starting', visible: false }), true);
  assert.equal(shouldReattachOnPoll({ status: 'running', visible: false }), true);
});
