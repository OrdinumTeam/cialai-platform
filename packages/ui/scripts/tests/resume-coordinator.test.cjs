// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');

for (const count of [1, 5, 10, 20]) test(`retoma ${count} conversas uma vez com concorrencia limitada e perfis isolados`, async () => {
  const { createResumeCoordinator } = await import('../../src/terminals/restore.js');
  const coordinator = createResumeCoordinator({ concurrency: 2 });
  let active = 0, peak = 0;
  const profiles = new Set(), calls = [], jobs = [];
  for (let i = 0; i < count; i++) {
    const profile = `profile-${i % 3}`;
    const run = async () => {
      assert.equal(profiles.has(profile), false);
      profiles.add(profile); peak = Math.max(peak, ++active); calls.push(i);
      await new Promise((resolve) => setImmediate(resolve));
      profiles.delete(profile); active--;
      if (i === 3) throw new Error('daemon draining');
      return i;
    };
    const first = coordinator.run(i, profile, run);
    assert.equal(coordinator.run(i, profile, run), first, 'duplicate must share the same operation');
    jobs.push(first);
  }
  const results = await Promise.allSettled(jobs);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(new Set(calls).size, count);
  assert.ok(peak <= 2);
  assert.equal(results.filter((r) => r.status === 'rejected').length, count > 3 ? 1 : 0);
  assert.equal(coordinator.size, 0, 'completed jobs must not retain sessions');
});

test('fechar uma sessao enfileirada cancela sem executar no PTY', async () => {
  const { createResumeCoordinator } = await import('../../src/terminals/restore.js');
  const coordinator = createResumeCoordinator({ concurrency: 1 });
  let release, valid = true, wrote = false;
  const busy = coordinator.run(1, 'codex', () => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const closed = coordinator.run(2, 'claude', () => { wrote = true; }, () => valid);
  valid = false; release();
  await busy;
  assert.deepEqual(await closed, { status: 'cancelled' });
  assert.equal(wrote, false);
});
