// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/lib/keys.js');
const press = (key, code, modifiers = {}) => ({ key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers });

test('no macOS os rótulos continuam idênticos aos glifos anteriores', async () => {
  const { label, shortcutLabel } = await load();
  const expected = {
    'Mod+T': '⌘T', 'Mod+N': '⌘N', 'Mod+P': '⌘P', 'Mod+F': '⌘F', 'Mod+R': '⌘R', 'Mod+K': '⌘K', 'Mod+Comma': '⌘,',
    'Mod+Shift+B': '⇧⌘B', 'Mod+Shift+E': '⇧⌘E', 'Mod+Shift+J': '⇧⌘J', 'Ctrl+Mod+S': '⌃⌘S',
    'Alt+ArrowUp': '⌥↑', 'Alt+ArrowDown': '⌥↓', 'Mod+Minus': '⌘−', 'Mod+Equal': '⌘+', 'Shift+Enter': '⇧↩',
  };
  for (const [combo, glyph] of Object.entries(expected)) {
    assert.equal(label(combo, 'macos'), glyph, combo);
    assert.equal(shortcutLabel(combo, 'macos'), glyph, combo);
  }
});

test('no Linux e no Windows os rótulos seguem a tabela do documento 04', async () => {
  const { shortcutLabel, label } = await load();
  for (const os of ['linux', 'windows']) {
    assert.equal(shortcutLabel('Mod+T', os), 'Ctrl Shift T');
    assert.equal(shortcutLabel('Mod+K', os), 'Ctrl Shift K');
    assert.equal(shortcutLabel('Mod+Shift+B', os), 'Ctrl Shift B');
    assert.equal(shortcutLabel('Mod+Minus', os), 'Ctrl Shift −');
    assert.equal(label('Mod+S', os), 'Ctrl S');
    assert.equal(label('Alt+ArrowUp', os), 'Alt ↑');
    assert.equal(label('Mod+Shift+Backspace', os), 'Ctrl Shift Backspace');
  }
});

test('Mod é ⌘ no macOS e Ctrl nos outros sistemas, com modificadores exatos', async () => {
  const { isShortcut, mod } = await load();
  assert.equal(isShortcut(press('t', 'KeyT', { metaKey: true }), 'Mod+T', 'macos'), true);
  assert.equal(isShortcut(press('t', 'KeyT', { ctrlKey: true }), 'Mod+T', 'macos'), false);
  assert.equal(isShortcut(press('t', 'KeyT', { ctrlKey: true }), 'Mod+T', 'windows'), true);
  assert.equal(isShortcut(press('t', 'KeyT', { ctrlKey: true, shiftKey: true }), 'Mod+T', 'windows'), false);
  assert.equal(isShortcut(press('s', 'KeyS', { ctrlKey: true, metaKey: true }), 'Ctrl+Mod+S', 'macos'), true);
  assert.equal(mod(press('a', 'KeyA', { metaKey: true }), 'macos'), true);
  assert.equal(mod(press('a', 'KeyA', { metaKey: true }), 'linux'), false);
});

test('Shift muda o caractere mas o código físico ainda casa', async () => {
  const { isShortcut } = await load();
  assert.equal(isShortcut(press('}', 'BracketRight', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+BracketRight', 'linux'), true);
  assert.equal(isShortcut(press('+', 'Equal', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+Equal', 'windows'), true);
  assert.equal(isShortcut(press('E', 'KeyE', { metaKey: true, shiftKey: true }), 'Mod+Shift+E', 'macos'), true);
  assert.equal(isShortcut(press('!', 'Digit1', { ctrlKey: true, shiftKey: true }), 'Mod+Shift+1', 'windows'), true);
});

test('dentro do terminal só a variante com Shift é do app fora do macOS', async () => {
  const { isAppShortcut, terminalSafe } = await load();
  const ctrlF = press('f', 'KeyF', { ctrlKey: true });
  const ctrlShiftF = press('F', 'KeyF', { ctrlKey: true, shiftKey: true });
  assert.equal(terminalSafe('Mod+F', 'linux'), 'Mod+Shift+F');
  assert.equal(terminalSafe('Mod+F', 'macos'), 'Mod+F');
  assert.equal(terminalSafe('Mod+Shift+E', 'windows'), 'Mod+Shift+E');
  assert.equal(isAppShortcut(ctrlF, 'Mod+F', { inTerminal: true, os: 'linux' }), false);
  assert.equal(isAppShortcut(ctrlShiftF, 'Mod+F', { inTerminal: true, os: 'linux' }), true);
  assert.equal(isAppShortcut(ctrlF, 'Mod+F', { inTerminal: false, os: 'windows' }), true);
  assert.equal(isAppShortcut(press('f', 'KeyF', { metaKey: true }), 'Mod+F', { inTerminal: true, os: 'macos' }), true);
});

test('ações do Workbench respeitam foco e combinações de cada sistema', async () => {
  const { workbenchShortcutAction, isTerminalAppShortcut } = await import('../../src/terminals/shortcut-actions.js');
  assert.equal(workbenchShortcutAction(press('f', 'KeyF', { ctrlKey: true }), { inTerminal: true, os: 'windows' }), null);
  assert.equal(workbenchShortcutAction(press('F', 'KeyF', { ctrlKey: true, shiftKey: true }), { inTerminal: true, os: 'windows' }), 'find');
  assert.equal(workbenchShortcutAction(press('f', 'KeyF', { ctrlKey: true }), { inTerminal: false, os: 'linux' }), 'find');
  assert.equal(workbenchShortcutAction(press('E', 'KeyE', { ctrlKey: true, shiftKey: true }), { inTerminal: false, os: 'linux' }), 'toggle-explorer');
  assert.equal(workbenchShortcutAction(press(']', 'BracketRight', { metaKey: true, shiftKey: true }), { inTerminal: true, os: 'macos' }), 'next-session');
  assert.equal(isTerminalAppShortcut(press('T', 'KeyT', { ctrlKey: true, shiftKey: true }), 'windows'), true);
  assert.equal(isTerminalAppShortcut(press('t', 'KeyT', { ctrlKey: true }), 'windows'), false);
});

test('edição do terminal preserva o Mac e adiciona as variantes dos outros sistemas', async () => {
  const { terminalEditAction } = await import('../../src/terminals/shortcut-actions.js');
  for (const os of ['linux', 'windows']) {
    assert.equal(terminalEditAction(press('C', 'KeyC', { ctrlKey: true, shiftKey: true }), os), 'copy');
    assert.equal(terminalEditAction(press('Insert', 'Insert', { ctrlKey: true }), os), 'copy');
    assert.equal(terminalEditAction(press('V', 'KeyV', { ctrlKey: true, shiftKey: true }), os), 'paste');
    assert.equal(terminalEditAction(press('Insert', 'Insert', { shiftKey: true }), os), 'paste');
    assert.equal(terminalEditAction(press('Backspace', 'Backspace', { ctrlKey: true, shiftKey: true }), os), 'delete-line');
    assert.equal(terminalEditAction(press('c', 'KeyC', { ctrlKey: true }), os), null);
  }
  assert.equal(terminalEditAction(press('Backspace', 'Backspace', { metaKey: true }), 'macos'), 'delete-line');
  assert.equal(terminalEditAction(press('c', 'KeyC', { metaKey: true }), 'macos'), null);
});

test('exclusão no explorador mantém o Mac e aceita as duas variantes fora dele', async () => {
  const { isExplorerDeleteShortcut } = await import('../../src/terminals/shortcut-actions.js');
  assert.equal(isExplorerDeleteShortcut(press('Backspace', 'Backspace', { metaKey: true }), 'macos'), true);
  assert.equal(isExplorerDeleteShortcut(press('Delete', 'Delete'), 'macos'), false);
  for (const os of ['linux', 'windows']) {
    assert.equal(isExplorerDeleteShortcut(press('Delete', 'Delete'), os), true);
    assert.equal(isExplorerDeleteShortcut(press('Backspace', 'Backspace', { ctrlKey: true }), os), false);
    assert.equal(isExplorerDeleteShortcut(press('Backspace', 'Backspace', { ctrlKey: true, shiftKey: true }), os), true);
  }
});
