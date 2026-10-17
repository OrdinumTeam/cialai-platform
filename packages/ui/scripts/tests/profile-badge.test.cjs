// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const moduleUrl = pathToFileURL(require.resolve('../../src/terminals/profile-badge.js')).href;

test('a pasta padrao so ganha selo quando tem apelido na Barra de IA', async () => {
  const { profileBadge } = await import(moduleUrl);
  const claude = { profile: 'claude', profileName: null };
  const codex = { profile: 'codex', profileName: null };
  assert.equal(profileBadge(claude, { id: 'claude', label: 'pessoa' }), null);
  assert.equal(profileBadge(claude, null), null);
  assert.equal(profileBadge(claude, { id: 'claude', label: 'equipe', alias: 'equipe' }), 'equipe');
  assert.equal(profileBadge(codex, { id: 'codex', label: 'equipe', alias: ' equipe ' }), 'equipe');
  assert.equal(profileBadge(codex, { id: 'codex', alias: '   ' }), null);
});

test('perfil nomeado mostra o nome do terminal, e o apelido vence quando existe', async () => {
  const { profileBadge } = await import(moduleUrl);
  const named = { profile: 'claude-work', profileName: 'WORK' };
  assert.equal(profileBadge(named, null), 'WORK');
  assert.equal(profileBadge(named, { id: 'claude-work', label: 'work' }), 'WORK');
  assert.equal(profileBadge(named, { id: 'claude-work', label: 'Trabalho', alias: 'Trabalho' }), 'Trabalho');
  assert.equal(profileBadge({ profile: 'claude-work', profileName: null }, null), null);
  assert.equal(profileBadge({ profile: null, profileName: 'WORK' }, null), null);
  assert.equal(profileBadge(null, null), null);
});

test('o agente identifica o padrao sem variavel exportada e preserva a caixa do apelido', async () => {
  const { activityProfile, profileBadge } = await import(moduleUrl);
  for (const [agent, id] of [['Claude Code', 'claude'], ['Codex', 'codex']]) {
    const activity = { agent, profile: null, profileName: null };
    assert.equal(activityProfile(activity), id);
    assert.equal(profileBadge(activity, { id, alias: '  Minha eQUIPE  ' }), 'Minha eQUIPE');
    assert.equal(profileBadge(activity, { id, label: 'email' }), null);
    assert.equal(profileBadge(activity, { id, alias: '  ' }), null);
    assert.equal(activityProfile({ agent, profile: `${id}-work` }), `${id}-work`);
  }
  assert.equal(activityProfile({ foreground: { agent: 'Codex' } }), 'codex');
  assert.equal(profileBadge({ agent: 'node' }, null), null);
});
