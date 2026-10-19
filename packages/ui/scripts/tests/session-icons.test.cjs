// SPDX-License-Identifier: Apache-2.0
// Confere o registro de icones das sessoes: ids validos, nome traduzido nos
// tres idiomas e o icone padrao que sai do que roda na sessao.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/terminals/session-icons.js');

test('so ids do registro passam; o resto volta ao padrao', async () => {
  const { SESSION_ICONS, validIcon } = await load();
  assert.equal(validIcon('rocket'), 'rocket');
  assert.equal(validIcon('git-branch'), 'git-branch');
  for (const wrong of [null, undefined, '', 'Rocket', 'nao-existe', 7, {}]) assert.equal(validIcon(wrong), null);
  const ids = SESSION_ICONS.map((entry) => entry.id);
  assert.equal(new Set(ids).size, ids.length, 'ids repetidos');
  // O Rust aceita ate 32 caracteres em minusculas, digitos e hifen.
  for (const id of ids) assert.match(id, /^[a-z0-9-]{1,32}$/);
  for (const entry of SESSION_ICONS) assert.ok(entry.Icon, entry.id);
});

test('todo icone tem nome nos tres idiomas', async () => {
  const { SESSION_ICONS } = await load();
  const { createI18n } = await import('@cialai/i18n');
  for (const locale of ['pt-BR', 'en', 'es']) {
    const { t } = createI18n(locale);
    for (const entry of SESSION_ICONS) {
      const label = t(entry.labelKey);
      assert.ok(label && label !== entry.labelKey, `${locale} ${entry.labelKey}`);
    }
    for (const key of ['terminal.icon.default', 'terminal.menu.sessionAppearance', 'terminal.menu.iconSection', 'terminal.newSession.icon']) {
      assert.notEqual(t(key), key, `${locale} ${key}`);
    }
  }
});

test('o icone padrao e o do agente em uso, ou o terminal', async () => {
  const { resolveSessionIcon, sessionAgentKind } = await load();
  const claude = { activity: { foreground: { agent: 'Claude Code' } } };
  const codex = { activity: { foreground: null, agent: 'Codex' } };
  const shell = { activity: { foreground: { agent: null, command: 'npm' } } };
  assert.equal(sessionAgentKind(claude), 'claude');
  assert.equal(sessionAgentKind(codex), 'codex');
  assert.equal(sessionAgentKind(shell), null);
  assert.equal(sessionAgentKind(null), null);
  assert.deepEqual(resolveSessionIcon(claude), { kind: 'agent', id: null, agent: 'claude' });
  assert.equal(resolveSessionIcon(shell).kind, 'default');
  assert.equal(resolveSessionIcon({}).kind, 'default');
  // O icone escolhido vence o agente: ele representa a sessao.
  const chosen = resolveSessionIcon({ ...claude, icon: 'rocket' });
  assert.equal(chosen.kind, 'custom');
  assert.equal(chosen.id, 'rocket');
  // Um id que saiu do registro volta ao padrao, sem quebrar o card.
  assert.equal(resolveSessionIcon({ ...shell, icon: 'removido' }).kind, 'default');
});
