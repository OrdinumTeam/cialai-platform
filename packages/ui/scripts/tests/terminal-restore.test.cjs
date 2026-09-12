// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/terminals/restore.js');

test('o aviso diz quando foi a ultima gravacao', async () => {
  const { restoredNotice } = await load();
  const now = new Date(2026, 8, 10, 18, 0).getTime();
  assert.equal(restoredNotice(new Date(2026, 8, 10, 16, 5).getTime(), now), '\x1b[2mHistórico restaurado. Última gravação hoje às 16:05.\x1b[0m\r\n');
  assert.equal(restoredNotice(new Date(2026, 8, 9, 21, 7).getTime(), now), '\x1b[2mHistórico restaurado. Última gravação em 09/09 às 21:07.\x1b[0m\r\n');
  assert.equal(restoredNotice(0, now), '\x1b[2mHistórico restaurado.\x1b[0m\r\n');
});

test('o tamanho gravado respeita os limites do PTY', async () => {
  const { savedSize } = await load();
  assert.deepEqual(savedSize({ cols: 120, rows: 40 }), { cols: 120, rows: 40 });
  assert.deepEqual(savedSize({ cols: 900, rows: 400 }), { cols: 500, rows: 300 });
  assert.equal(savedSize({ cols: 0, rows: 0 }), null);
  assert.equal(savedSize(null), null);
});

test('a retomada espera saida do shell e leituras sem saida nova', async () => {
  const { waitForPrompt, PROMPT_QUIET_POLLS, PROMPT_POLL_MS } = await load();
  const received = [0, 0, 40, 90, 90, 90, 90, 90, 90]; let reads = 0; const slept = [];
  const ready = await waitForPrompt(() => received[Math.min(reads++, received.length - 1)], async (ms) => { slept.push(ms); });
  assert.equal(ready, true); assert.equal(reads, 4 + PROMPT_QUIET_POLLS); assert.ok(slept.every((ms) => ms === PROMPT_POLL_MS));
});

test('a retomada desiste quando a sessao mudou e digita ao fim do prazo', async () => {
  const { waitForPrompt } = await load();
  assert.equal(await waitForPrompt(() => null, async () => {}), false);
  let reads = 0;
  assert.equal(await waitForPrompt(() => { reads += 1; return 0; }, async () => {}, { maxPolls: 5 }), true);
  assert.equal(reads, 6);
});
