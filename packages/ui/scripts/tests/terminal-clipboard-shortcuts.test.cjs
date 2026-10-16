// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');

const press = (key, code, modifiers = {}) => ({ key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers });

test('copiar e colar no terminal respeitam sistema, seleção, agente e modificadores exatos', async () => {
  const { terminalEditAction } = await import('../../src/terminals/shortcut-actions.js');
  const cases = [
    ['Windows Ctrl+V cola no shell', 'windows', press('v', 'KeyV', { ctrlKey: true }), {}, 'paste'],
    ['Windows Ctrl+C copia a seleção', 'windows', press('c', 'KeyC', { ctrlKey: true }), { hasSelection: true }, 'copy'],
    ['Windows Ctrl+C sem seleção preserva a interrupção', 'windows', press('c', 'KeyC', { ctrlKey: true }), { hasSelection: false }, null],
    ['Windows Ctrl+C sem contexto preserva a interrupção', 'windows', press('c', 'KeyC', { ctrlKey: true }), {}, null],
    ['Windows Ctrl+Shift+V continua colando', 'windows', press('V', 'KeyV', { ctrlKey: true, shiftKey: true }), {}, 'paste'],
    ['Windows Shift+Insert continua colando', 'windows', press('Insert', 'Insert', { shiftKey: true }), {}, 'paste'],
    ['Windows Ctrl+Alt+V não cola', 'windows', press('v', 'KeyV', { ctrlKey: true, altKey: true }), {}, null],
    ['Windows Ctrl+Meta+V não cola', 'windows', press('v', 'KeyV', { ctrlKey: true, metaKey: true }), {}, null],
    ['Windows Ctrl+Alt+C não copia a seleção', 'windows', press('c', 'KeyC', { ctrlKey: true, altKey: true }), { hasSelection: true }, null],
    ['Windows Ctrl+Meta+C não copia a seleção', 'windows', press('c', 'KeyC', { ctrlKey: true, metaKey: true }), { hasSelection: true }, null],
    ['Windows V sem Ctrl não cola', 'windows', press('v', 'KeyV'), {}, null],
    ['Windows C sem Ctrl não copia a seleção', 'windows', press('c', 'KeyC'), { hasSelection: true }, null],
    ['Linux Ctrl+V fica com o Codex', 'linux', press('v', 'KeyV', { ctrlKey: true }), { agent: 'Codex' }, null],
    ['Linux Ctrl+V fica com o Claude Code', 'linux', press('v', 'KeyV', { ctrlKey: true }), { agent: 'Claude Code' }, null],
    ['Linux Ctrl+V sem agente preserva literal-next', 'linux', press('v', 'KeyV', { ctrlKey: true }), {}, null],
    ['Linux Ctrl+V no shell preserva literal-next', 'linux', press('v', 'KeyV', { ctrlKey: true }), { agent: 'bash' }, null],
    ['Linux Ctrl+Shift+V cola no shell', 'linux', press('V', 'KeyV', { ctrlKey: true, shiftKey: true }), {}, 'paste'],
    ['Linux Shift+Insert cola no shell', 'linux', press('Insert', 'Insert', { shiftKey: true }), {}, 'paste'],
    ['Linux Ctrl+Alt+V não cola no Codex', 'linux', press('v', 'KeyV', { ctrlKey: true, altKey: true }), { agent: 'Codex' }, null],
    ['Linux Ctrl+Meta+V não cola no Claude Code', 'linux', press('v', 'KeyV', { ctrlKey: true, metaKey: true }), { agent: 'Claude Code' }, null],
    ['Linux Ctrl+Shift+Alt+V não cola', 'linux', press('V', 'KeyV', { ctrlKey: true, shiftKey: true, altKey: true }), { agent: 'Codex' }, null],
    ['Linux Ctrl+Shift+Meta+V não cola', 'linux', press('V', 'KeyV', { ctrlKey: true, shiftKey: true, metaKey: true }), { agent: 'Claude Code' }, null],
    ['Linux Shift+Alt+Insert não cola', 'linux', press('Insert', 'Insert', { shiftKey: true, altKey: true }), {}, null],
    ['Linux Shift+Meta+Insert não cola', 'linux', press('Insert', 'Insert', { shiftKey: true, metaKey: true }), {}, null],
    ['Linux Ctrl+Shift+Insert não cola', 'linux', press('Insert', 'Insert', { ctrlKey: true, shiftKey: true }), {}, null],
    ['Linux V sem Ctrl não cola no Codex', 'linux', press('v', 'KeyV'), { agent: 'Codex' }, null],
    ['Linux Shift+V não cola no Claude Code', 'linux', press('V', 'KeyV', { shiftKey: true }), { agent: 'Claude Code' }, null],
    ['macOS Cmd+C mantém a cópia nativa', 'macos', press('c', 'KeyC', { metaKey: true }), { hasSelection: true }, null],
    ['macOS Cmd+V mantém a colagem nativa', 'macos', press('v', 'KeyV', { metaKey: true }), { agent: 'Codex' }, null],
    ['macOS Ctrl+C copia com seleção', 'macos', press('c', 'KeyC', { ctrlKey: true }), { hasSelection: true }, 'copy'],
    ['macOS Ctrl+C mantém a interrupção sem seleção', 'macos', press('c', 'KeyC', { ctrlKey: true }), {}, null],
    ['macOS Ctrl+V cola no shell', 'macos', press('v', 'KeyV', { ctrlKey: true }), {}, 'paste'],
    ['macOS Ctrl+Alt+V não cola', 'macos', press('v', 'KeyV', { ctrlKey: true, altKey: true }), {}, null],
  ];

  for (const [description, os, event, context, expected] of cases) {
    assert.equal(terminalEditAction(event, os, context), expected, description);
  }
  for (const agent of [null, 'Codex', 'Claude Code', 'Gemini CLI', 'bash']) {
    assert.equal(terminalEditAction(press('C', 'KeyC', { ctrlKey: true, shiftKey: true }), 'linux', { agent }), 'copy');
    assert.equal(terminalEditAction(press('V', 'KeyV', { ctrlKey: true, shiftKey: true }), 'linux', { agent }), 'paste');
    assert.equal(terminalEditAction(press('c', 'KeyC', { ctrlKey: true }), 'linux', { agent, hasSelection: true }), null);
  }
});
