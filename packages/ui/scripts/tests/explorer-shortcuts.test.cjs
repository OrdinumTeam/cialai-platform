// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');

const press = (key, code, modifiers = {}) => ({ key, code, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...modifiers });

test('os atalhos de edição do explorador seguem o sistema e o Shift exato', async () => {
  const { explorerEditAction } = await import('../../src/terminals/shortcut-actions.js');
  const cases = [
    ['macOS Cmd+X recorta', 'macos', press('x', 'KeyX', { metaKey: true }), 'cut'],
    ['macOS Cmd+C copia', 'macos', press('c', 'KeyC', { metaKey: true }), 'copy'],
    ['macOS Cmd+V cola', 'macos', press('v', 'KeyV', { metaKey: true }), 'paste'],
    ['macOS Cmd+A seleciona tudo', 'macos', press('a', 'KeyA', { metaKey: true }), 'select-all'],
    ['macOS Cmd+Z desfaz', 'macos', press('z', 'KeyZ', { metaKey: true }), 'undo'],
    ['macOS Cmd+Shift+Z refaz', 'macos', press('z', 'KeyZ', { metaKey: true, shiftKey: true }), 'redo'],
    ['macOS F2 renomeia', 'macos', press('F2', 'F2'), 'rename'],
    ['macOS x solto não recorta', 'macos', press('x', 'KeyX'), null],
    ['macOS Cmd+Shift+X não recorta', 'macos', press('x', 'KeyX', { metaKey: true, shiftKey: true }), null],
    ['macOS Ctrl+C não copia no explorador', 'macos', press('c', 'KeyC', { ctrlKey: true }), null],
    ['Windows Ctrl+X recorta', 'windows', press('x', 'KeyX', { ctrlKey: true }), 'cut'],
    ['Windows Ctrl+C copia', 'windows', press('c', 'KeyC', { ctrlKey: true }), 'copy'],
    ['Windows Ctrl+V cola', 'windows', press('v', 'KeyV', { ctrlKey: true }), 'paste'],
    ['Windows Ctrl+A seleciona tudo', 'windows', press('a', 'KeyA', { ctrlKey: true }), 'select-all'],
    ['Windows Ctrl+Z desfaz', 'windows', press('z', 'KeyZ', { ctrlKey: true }), 'undo'],
    ['Windows Ctrl+Shift+Z refaz', 'windows', press('z', 'KeyZ', { ctrlKey: true, shiftKey: true }), 'redo'],
    ['Windows Ctrl+Y refaz', 'windows', press('y', 'KeyY', { ctrlKey: true }), 'redo'],
    ['Windows F2 renomeia', 'windows', press('F2', 'F2'), 'rename'],
    ['Linux Ctrl+Z desfaz', 'linux', press('z', 'KeyZ', { ctrlKey: true }), 'undo'],
    ['Linux Ctrl+Shift+Z não cai em desfazer', 'linux', press('z', 'KeyZ', { ctrlKey: true, shiftKey: true }), 'redo'],
    ['Linux Ctrl+Alt+V não cola', 'linux', press('v', 'KeyV', { ctrlKey: true, altKey: true }), null],
  ];
  for (const [name, os, event, expected] of cases) {
    assert.equal(explorerEditAction(event, os), expected, name);
  }
});
