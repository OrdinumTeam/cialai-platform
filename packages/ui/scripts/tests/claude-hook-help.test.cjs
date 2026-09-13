// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const moduleUrl = pathToFileURL(require.resolve('../../src/terminals/claude-hook-help.js')).href;

test('Claude hook help points each desktop family to its installer', async () => {
  const { claudeHookMissingTitle } = await import(moduleUrl);
  assert.match(claudeHookMissingTitle('Trabalho', 'macos'), /scripts\/install-claude-statusline\.sh$/);
  assert.match(claudeHookMissingTitle('Trabalho', 'linux'), /scripts\/install-claude-statusline\.sh$/);
  assert.match(claudeHookMissingTitle('Trabalho', 'windows'), /scripts\/install-claude-statusline\.ps1$/);
});
