// SPDX-License-Identifier: Apache-2.0
// Estado de atividade: uma linha por caso da tabela, mais amostra ausente,
// amostra de antes da reconexao e amostra velha.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/terminals/activity-state.js');

const NOW = 1_700_000_000_000;
const fresh = (extra) => ({ sampleAt: NOW - 500, evidenceSince: NOW - 10_000, ...extra });
const shell = { stopped: false };

test('o turno do agente decide sozinho, e saida e CPU nao entram', async () => {
  const { deriveActivity } = await load();
  const cases = [
    ['busy', 'agent-busy', 'busy', true],
    ['waiting', 'agent-waiting', 'warn', false],
    ['done', 'agent-done', 'ok', false],
    ['idle', 'agent-idle', 'ok', false],
  ];
  for (const [state, code, tone, animated] of cases) {
    const result = deriveActivity(fresh({
      agentTurn: { state, sinceMs: NOW - 4000 },
      foreground: shell,
      // Saida quieta e CPU alta ao mesmo tempo: nenhuma das duas pode virar o estado.
      outputAgeMs: 90_000,
      cpuPercent: 80,
    }), NOW);
    assert.equal(result.code, code, `${state} vira ${code}`);
    assert.equal(result.tone, tone);
    assert.equal(result.animated, animated);
  }
});

test('o que o agente espera acompanha o estado de aguardando', async () => {
  const { deriveActivity } = await load();
  const result = deriveActivity(fresh({
    agentTurn: { state: 'waiting', sinceMs: NOW - 2000, waitingFor: 'permission' },
    foreground: shell,
  }), NOW);
  assert.equal(result.waitingFor, 'permission');
  assert.equal(result.sinceMs, NOW - 2000);
});

test('sem sinal proprio vale a evidencia de saida recente ou de CPU', async () => {
  const { deriveActivity, OUTPUT_WINDOW_MS, CPU_FLOOR_PERCENT } = await load();
  const recent = deriveActivity(fresh({ foreground: shell, outputAgeMs: 200 }), NOW);
  assert.equal(recent.code, 'active');
  assert.equal(recent.animated, true);

  const cpu = deriveActivity(fresh({ foreground: shell, cpuPercent: CPU_FLOOR_PERCENT }), NOW);
  assert.equal(cpu.code, 'active');

  // A idade da amostra soma na conta: 2600 ms medidos ha 500 ms ja passaram da janela.
  const aged = deriveActivity(fresh({ foreground: shell, outputAgeMs: OUTPUT_WINDOW_MS - 400 }), NOW);
  assert.equal(aged.code, 'open');
});

test('silencio nunca vira concluido: processo quieto fica em processo aberto', async () => {
  const { deriveActivity } = await load();
  const sleeping = deriveActivity(fresh({ foreground: shell, outputAgeMs: 300_000, cpuPercent: 0 }), NOW);
  assert.equal(sleeping.code, 'open');
  assert.equal(sleeping.tone, 'muted');
  assert.equal(sleeping.animated, false);
});

test('processo parado por sinal e shell no prompt tem cada um o seu estado', async () => {
  const { deriveActivity } = await load();
  const stopped = deriveActivity(fresh({ foreground: { stopped: true }, cpuPercent: 90 }), NOW);
  assert.equal(stopped.code, 'stopped');
  assert.equal(stopped.tone, 'warn');
  assert.equal(stopped.animated, false);

  const prompt = deriveActivity(fresh({ foreground: null, outputAgeMs: 100 }), NOW);
  assert.equal(prompt.code, 'idle');
  assert.equal(prompt.tone, 'ok');
  assert.equal(prompt.animated, false);
});

test('amostra ausente, de antes da reconexao ou velha nunca anima', async () => {
  const { deriveActivity, SAMPLE_MAX_AGE_MS } = await load();
  const missing = deriveActivity({ agentTurn: { state: 'busy' }, foreground: shell }, NOW);
  assert.equal(missing.animated, false);

  const beforeReconnect = deriveActivity({
    agentTurn: { state: 'busy' }, foreground: shell,
    sampleAt: NOW - 20_000, evidenceSince: NOW - 5_000,
  }, NOW);
  assert.equal(beforeReconnect.animated, false, 'amostra anterior a reconexao nao sustenta animacao');

  const old = deriveActivity({
    agentTurn: { state: 'busy' }, foreground: shell,
    sampleAt: NOW - SAMPLE_MAX_AGE_MS - 1, evidenceSince: 0,
  }, NOW);
  assert.equal(old.animated, false);

  // Sem amostra utilizavel, saida recente tambem nao promove a sessao.
  const quiet = deriveActivity({ foreground: shell, outputAgeMs: 10 }, NOW);
  assert.equal(quiet.code, 'open');
  assert.equal(quiet.animated, false);
});

test('chamada sem argumento nenhum devolve o shell no prompt sem quebrar', async () => {
  const { deriveActivity, ACTIVITY_STATES } = await load();
  const result = deriveActivity(undefined, NOW);
  assert.equal(result.code, 'idle');
  assert.equal(result.animated, false);
  assert.deepEqual(
    Object.keys(ACTIVITY_STATES).sort(),
    ['active', 'agent-busy', 'agent-done', 'agent-idle', 'agent-waiting', 'idle', 'open', 'stopped'],
  );
});
