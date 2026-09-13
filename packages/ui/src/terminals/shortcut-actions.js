// SPDX-License-Identifier: Apache-2.0
// Decisões puras dos atalhos do estúdio. Os componentes ficam responsáveis
// somente pelos efeitos, enquanto esta camada concentra as colisões com o
// shell e as diferenças entre macOS, Linux e Windows.

import { currentOs, isAppShortcut, isShortcut, terminalSafe } from '../lib/keys.js';

const WORKBENCH_SHORTCUTS = [
  ['toggle-explorer', 'Mod+Shift+E'],
  ['toggle-sessions', 'Mod+Shift+J'],
  ['open-browser', 'Mod+Shift+B'],
  ['next-session', 'Mod+Shift+BracketRight'],
  ['previous-session', 'Mod+Shift+BracketLeft'],
  ['quick-open', 'Mod+P'],
  ['find', 'Mod+F'],
  ['font-increase', 'Mod+Equal'],
  ['font-decrease', 'Mod+Minus'],
  ['font-reset', 'Mod+0'],
];

const GLOBAL_SHORTCUTS = ['Mod+K', 'Mod+T', 'Mod+N', 'Mod+W', 'Mod+R', 'Mod+Comma'];

export function workbenchShortcutAction(event, { inTerminal = false, os = currentOs() } = {}) {
  return WORKBENCH_SHORTCUTS.find(([, combo]) => isAppShortcut(event, combo, { inTerminal, os }))?.[0] || null;
}

export function isTerminalAppShortcut(event, os = currentOs()) {
  return [...WORKBENCH_SHORTCUTS.map(([, combo]) => combo), ...GLOBAL_SHORTCUTS]
    .some((combo) => isAppShortcut(event, combo, { inTerminal: true, os }));
}

export function terminalEditAction(event, os = currentOs()) {
  if (os === 'macos') return isShortcut(event, 'Mod+Backspace', os) ? 'delete-line' : null;
  if (isShortcut(event, terminalSafe('Mod+C', os), os) || isShortcut(event, 'Ctrl+Insert', os)) return 'copy';
  if (isShortcut(event, terminalSafe('Mod+V', os), os) || isShortcut(event, 'Shift+Insert', os)) return 'paste';
  if (isShortcut(event, terminalSafe('Mod+Backspace', os), os)) return 'delete-line';
  return null;
}

export function isExplorerDeleteShortcut(event, os = currentOs()) {
  if (os === 'macos') return isShortcut(event, 'Mod+Backspace', os);
  return isShortcut(event, 'Delete', os)
    || isShortcut(event, terminalSafe('Mod+Backspace', os), os);
}
