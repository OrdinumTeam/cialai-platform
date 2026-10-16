// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
function stub(t, key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  });
}

test('cópia Linux usa GTK sem pedir acesso ao clipboard do navegador', async (t) => {
  const { copyToClipboard } = await import('../../src/lib/helpers.js');
  const calls = [];
  stub(t, 'window', { __TAURI_INTERNALS__: {
    invoke: async (command, args) => calls.push({ command, args }),
  } });
  stub(t, 'document', { documentElement: { dataset: { platform: 'linux' } } });
  assert.equal(await copyToClipboard('ação 😀\nlinha 2'), true);
  assert.deepEqual(calls, [{ command: 'clipboard_write_text', args: { text: 'ação 😀\nlinha 2' } }]);
});

test('fallback de cópia restaura o foco do terminal para a próxima colagem', async (t) => {
  const { copyToClipboard } = await import('../../src/lib/helpers.js');
  let restored = 0, selected = 0, removed = 0;
  const textarea = { style: {}, setAttribute() {}, select() { selected++; }, remove() { removed++; } };
  stub(t, 'window', { isSecureContext: false });
  stub(t, 'document', {
    documentElement: { dataset: { platform: 'linux' } },
    activeElement: { focus() { restored++; } },
    createElement: () => textarea,
    body: { appendChild() {} },
    execCommand: (command) => command === 'copy',
  });
  assert.equal(await copyToClipboard('seleção'), true);
  assert.equal(textarea.value, 'seleção');
  assert.deepEqual([selected, removed, restored], [1, 1, 1]);
});
