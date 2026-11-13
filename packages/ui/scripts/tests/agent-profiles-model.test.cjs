// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/desktop/agent-profiles-model.js');
const t = (key, values = {}) => `${key}${Object.keys(values).length ? JSON.stringify(values) : ''}`;
const WEEK = 7 * 24 * 60 * 60 * 1000;

function account(over = {}) {
  return { id: 'codex', agent: 'codex', label: 'amorim', isDefault: true, needsLogin: false, ...over };
}

function reading(windows, over = {}) {
  return { headlineId: windows[0]?.id ?? null, weeklyId: windows[1]?.id ?? null, status: { kind: 'ok' }, windows, ...over };
}

test('o nome do perfil novo segue a regra do Rust e o id vira nome e pasta', async () => {
  const { NAME_LIMIT, finalName, sanitizeName, profileFolder, profileExists, profileName } = await load();
  assert.equal(NAME_LIMIT, 32);
  assert.equal(sanitizeName(' Felipe-2 Conta/../'), 'felipe-2conta');
  assert.equal(sanitizeName('time_b'), 'time_b');
  assert.equal(sanitizeName('--x'), 'x');
  assert.equal(finalName('conta-'), 'conta');
  assert.equal(sanitizeName('a'.repeat(40)).length, 32);
  assert.equal(profileFolder('codex', ''), '.codex');
  assert.equal(profileFolder('claude', 'felipe'), '.claude-felipe');
  assert.equal(profileName(account()), '');
  assert.equal(profileName(account({ id: 'codex-felipe', isDefault: false })), 'felipe');
  const profiles = [account({ id: 'codex-felipe' })];
  assert.equal(profileExists(profiles, 'codex', 'felipe'), true);
  assert.equal(profileExists(profiles, 'claude', 'felipe'), false);
  assert.equal(profileExists(profiles, 'codex', ''), false);
});

test('a cota vale pela janela que mais apertou entre a do anel e a semanal', async () => {
  const { quotaOf } = await load();
  const session = { id: 'session', usedFraction: 0.2, resetsAtMs: 1 };
  const weekly = { id: 'weekly', usedFraction: 0.716, resetsAtMs: 2, durationMs: WEEK };
  assert.deepEqual(quotaOf(account({ usage: reading([session, weekly]) })), { state: 'free', free: 28, resetsAtMs: 2 });
  assert.deepEqual(quotaOf(account({ usage: reading([{ ...session, usedFraction: 1, resetsAtMs: 9 }]) })), { state: 'out', free: 0, resetsAtMs: 9 });
  // Uma janela longa que não é de uma semana não conta como semanal.
  const monthly = { ...weekly, usedFraction: 0.99, durationMs: 30 * 24 * 60 * 60 * 1000 };
  assert.equal(quotaOf(account({ usage: reading([session, monthly]) })).free, 80);
  assert.deepEqual(quotaOf(account({ usage: reading([]) })), { state: 'unknown' });
  assert.deepEqual(quotaOf(account()), { state: 'unknown' });
});

test('a linha de cota mostra login, esgotada, sem limite e a hora da volta', async () => {
  const { quotaLine, resetTime } = await load();
  const now = new Date(2026, 9, 21, 10, 0).getTime();
  const at = (days, hour) => new Date(2026, 9, 21 + days, hour, 0).getTime();
  const context = { now, locale: 'pt-BR', t };
  assert.equal(resetTime(at(0, 14), context), '14:00');
  assert.equal(resetTime(at(1, 9), context), 'agentProfiles.tomorrow{"time":"09:00"}');
  assert.match(resetTime(at(3, 9), context), /09:00$/);
  assert.equal(resetTime(null, context), '');

  const free = quotaLine(account({ usage: reading([{ id: 's', usedFraction: 0.38, resetsAtMs: at(0, 14) }]) }), context);
  assert.deepEqual(free, { state: 'free', tone: 'free', value: '62%', detail: 'agentProfiles.resetsAt{"time":"14:00"}', free: 62 });
  const out = quotaLine(account({ usage: reading([{ id: 's', usedFraction: 1, resetsAtMs: at(1, 9) }]) }), context);
  assert.equal(out.tone, 'out');
  assert.equal(out.value, 'agentProfiles.exhausted');
  assert.equal(quotaLine(account({ needsLogin: true }), context).state, 'none');
  assert.equal(quotaLine(account({ usage: reading([], { status: { kind: 'needsAuth' } }) }), context).value, 'agentProfiles.noLogin');
  assert.equal(quotaLine(account({ usage: reading([], { status: { kind: 'unsupported' } }) }), context).value, 'terminal.profiles.unmetered');
  assert.equal(quotaLine(account(), context).value, 'agentProfiles.noQuota');
});

test('o menu do terminal recebe o id, o rotulo e o estado de cada conta do agente', async () => {
  const { menuEntries } = await load();
  const now = new Date(2026, 9, 21, 10, 0).getTime();
  const profiles = [
    account({ usage: reading([{ id: 's', usedFraction: 1, resetsAtMs: new Date(2026, 9, 21, 14, 0).getTime() }]) }),
    account({ id: 'codex-felipe', label: 'felipe', isDefault: false, needsLogin: true }),
    account({ id: 'claude', agent: 'claude' }),
  ];
  assert.deepEqual(menuEntries(profiles, 'codex', { now, locale: 'pt-BR', t }), [
    { id: 'codex', label: 'amorim', state: 'out', value: 'agentProfiles.exhausted', detail: 'agentProfiles.backAt{"time":"14:00"}' },
    { id: 'codex-felipe', label: 'felipe', state: 'none', value: 'agentProfiles.noLogin', detail: '' },
  ]);
});

test('o tutorial usa contas de exemplo, o prompt do shell e destaca valores', async () => {
  const { richText, tutorialAccounts, tutorialShell } = await load();
  const accounts = tutorialAccounts({ name: 'felipe', t });
  assert.deepEqual(accounts.map((item) => item.state), ['free', 'out', 'free']);
  assert.equal(accounts[2].name, 'felipe');
  assert.deepEqual(tutorialShell({ path: '/bin/zsh', flavor: 'posix' }, 'macos'), { title: 'zsh', prompt: '~ ❯' });
  assert.deepEqual(tutorialShell({ path: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', flavor: 'powershell' }, 'windows'), { title: 'PowerShell', prompt: 'PS ~>' });
  assert.deepEqual(tutorialShell(null, 'linux'), { title: 'bash', prompt: '~ ❯' });
  const template = (_key, values) => `Enter usa ${values.name}`;
  assert.deepEqual(richText(template, 'k', { name: 'felipe' }, ['name']), [{ text: 'Enter usa ', bold: false }, { text: 'felipe', bold: true }]);
});
