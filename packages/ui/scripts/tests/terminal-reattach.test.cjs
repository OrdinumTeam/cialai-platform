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

test('sessao recem descoberta entra mesmo fora da tela no computador', async () => {
  const { shouldReattachOnPoll } = await load();
  assert.equal(shouldReattachOnPoll({ status: 'starting', visible: false }), true);
  assert.equal(shouldReattachOnPoll({ status: 'running', visible: false }), true);
});

test('no celular a sessao recem descoberta fora da tela espera ser exibida', async () => {
  const { shouldReattachOnPoll } = await load();
  assert.equal(shouldReattachOnPoll({ status: 'starting', visible: false, phone: true }), false);
  assert.equal(shouldReattachOnPoll({ status: 'starting', visible: true, phone: true }), true);
  assert.equal(shouldReattachOnPoll({ status: 'running', visible: false, phone: true }), true);
});

test('a contagem de tentativas so zera depois de a sessao ficar anexada', async () => {
  const { settledAttempt, REATTACH_STABLE_MS, reattachDelay } = await load();
  // O detached por atraso chega uns 3 s depois do attach: a escada continua.
  assert.equal(settledAttempt(3, 3000), 3);
  assert.equal(settledAttempt(3, REATTACH_STABLE_MS - 1), 3);
  assert.equal(settledAttempt(3, REATTACH_STABLE_MS), 0);
  assert.equal(settledAttempt(3, NaN), 3);
  assert.equal(settledAttempt(undefined, 1000), 0);
  // Um ciclo de quedas a cada 3 s sobe a escada em vez de ficar em 500 ms.
  let attempt = 0;
  const delays = [];
  for (let round = 0; round < 6; round += 1) {
    attempt = settledAttempt(attempt, 3000);
    delays.push(reattachDelay(attempt));
    attempt += 1;
  }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000, 8000]);
});

test('o deslocamento de retomada so vai quando a pagina ja recebeu saida', async () => {
  const { resumeOffset } = await load();
  assert.equal(resumeOffset(0), null);
  assert.equal(resumeOffset(undefined), null);
  assert.equal(resumeOffset(-5), null);
  assert.equal(resumeOffset(1.5), null);
  assert.equal(resumeOffset(300000), 300000);
});
