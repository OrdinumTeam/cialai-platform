// SPDX-License-Identifier: Apache-2.0
// Catálogo de teclas do teclado especial e preferências guardadas no aparelho.
//
// Cada tecla tem um id estável, que é o que as preferências guardam, o nome
// que vai a `key-encoder.js` e, nos atalhos, os modificadores da própria
// tecla. Ctrl C aqui é a tecla C com Ctrl, e sai como ETX: interrompe o
// processo, nunca copia texto. Colar, na aba Básico, é Ctrl V: o agente no
// computador cola o que está na área de transferência de lá, imagem inclusive.
// Colar do celular é a única tecla que não é sequência: lê a área de
// transferência do aparelho e entrega pelo paste do xterm.
//
// As preferências ficam no localStorage da página, por computador, como a
// rota em `phone-navigation.js`. Valor desconhecido ou corrompido cai no
// padrão. A barra do terminal é fixa desde a versão 3, em `PhoneKeybar.jsx`:
// a escolha de teclas da barra gravada pelas versões anteriores é ignorada.

export const KEYBOARD_PREFS_KEY = 'cialai_terminal_keyboard';
export const KEYBOARD_PREFS_VERSION = 3;
export const PASTE_KEY = 'Paste';

const ctrl = { ctrl: true };

// `hint` é a chave de tradução que explica o efeito no terminal. `caption` é a
// legenda curta que acompanha o ícone da tecla no painel, quando o nome da
// tecla não diz o que ela faz: Interromper em vez de Ctrl C. Os ícones ficam
// em `ui/PhoneKeyIcons.jsx`, pelo mesmo id.
export const KEY_CATALOG = Object.freeze({
  Escape: { key: 'Escape', cap: 'Esc' },
  Tab: { key: 'Tab', cap: 'Tab' },
  Enter: { key: 'Enter', cap: 'Enter' },
  Backspace: { key: 'Backspace', cap: 'Backspace', caption: 'terminal.phone.keys.caption.backspace', hint: 'terminal.phone.keys.hint.backspace' },
  ArrowUp: { key: 'ArrowUp', cap: '↑', name: 'terminal.phone.arrowUp' },
  ArrowDown: { key: 'ArrowDown', cap: '↓', name: 'terminal.phone.arrowDown' },
  ArrowLeft: { key: 'ArrowLeft', cap: '←', name: 'terminal.phone.keys.arrowLeft' },
  ArrowRight: { key: 'ArrowRight', cap: '→', name: 'terminal.phone.keys.arrowRight' },
  Home: { key: 'Home', cap: 'Home' },
  End: { key: 'End', cap: 'End' },
  PageUp: { key: 'PageUp', cap: 'PgUp', name: 'Page Up' },
  PageDown: { key: 'PageDown', cap: 'PgDn', name: 'Page Down' },
  Delete: { key: 'Delete', cap: 'Delete' },
  Insert: { key: 'Insert', cap: 'Ins', name: 'Insert' },
  ShiftTab: { key: 'Tab', mods: { shift: true }, cap: 'Shift Tab', hint: 'terminal.phone.keys.hint.shiftTab', bar: ['Shift', 'Tab'] },
  CtrlC: { key: 'c', mods: ctrl, cap: 'Ctrl C', caption: 'terminal.phone.keys.caption.interrupt', hint: 'terminal.phone.keys.hint.ctrlC', bar: ['Ctrl', 'C'] },
  CtrlD: { key: 'd', mods: ctrl, cap: 'Ctrl D', hint: 'terminal.phone.keys.hint.ctrlD', bar: ['Ctrl', 'D'] },
  CtrlL: { key: 'l', mods: ctrl, cap: 'Ctrl L', hint: 'terminal.phone.keys.hint.ctrlL', bar: ['Ctrl', 'L'] },
  // Na barra, a tecla sem ícone próprio usa `bar`, que empilha o modificador
  // pequeno sobre a letra, para o atalho caber sem reticências.
  CtrlV: { key: 'v', mods: ctrl, cap: 'terminal.phone.keys.pasteCtrlV', translated: true, name: 'terminal.phone.keys.pasteCtrlVName', hint: 'terminal.phone.keys.hint.ctrlV', bar: ['Ctrl', 'V'] },
  CtrlA: { key: 'a', mods: ctrl, cap: 'Ctrl A', hint: 'terminal.phone.keys.hint.ctrlA', bar: ['Ctrl', 'A'] },
  CtrlZ: { key: 'z', mods: ctrl, cap: 'Ctrl Z', hint: 'terminal.phone.keys.hint.ctrlZ', bar: ['Ctrl', 'Z'] },
  CtrlR: { key: 'r', mods: ctrl, cap: 'Ctrl R', caption: 'terminal.phone.keys.caption.history', hint: 'terminal.phone.keys.hint.ctrlR', bar: ['Ctrl', 'R'] },
  [PASTE_KEY]: { key: null, cap: 'terminal.phone.paste', caption: 'terminal.phone.keys.caption.pastePhone', name: 'terminal.phone.pasteLabel', translated: true, hint: 'terminal.phone.keys.hint.pastePhone' },
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`F${index + 1}`, { key: `F${index + 1}`, cap: `F${index + 1}` }])),
});

export const MODIFIER_KEYS = [
  { id: 'ctrl', cap: 'Ctrl' },
  { id: 'alt', cap: 'Alt' },
  { id: 'shift', cap: 'Shift' },
  { id: 'meta', cap: 'Meta' },
];

// Os mais usados no shell e nos agentes que o teclado do celular esconde.
export const SYMBOLS = ['|', '~', '`', '/', '\\', '-', '_', '{', '}', '[', ']', '<', '>', '$', '&', '*', ';', ':', "'", '"', '#', '%', '^', '!', '=', '+', '@', '?'];

// A primeira linha das abas de teclas: cancelar, completar, confirmar e apagar
// ficam sempre no mesmo lugar.
const COMMON_KEYS = ['Escape', 'Tab', 'Enter', 'Backspace'];

const functionKeys = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => `F${from + index}`);

// `keys` é a grade de quatro colunas; `functions`, a das teclas de função.
// Nenhuma aba fica sem Enter nem Backspace. Em Símbolos a linha comum
// empurraria os símbolos para fora da tela, então os dois fecham as linhas das
// teclas de função, no canto direito, como num teclado.
export const KEYBOARD_TABS = [
  // Os comandos mais usados nos agentes ficam já na primeira aba, na segunda linha.
  { id: 'basic', keys: [...COMMON_KEYS, 'ShiftTab', 'CtrlC', 'CtrlV', 'CtrlR'], modifiers: true, dpad: true },
  { id: 'navigation', keys: [...COMMON_KEYS, 'Home', 'End', 'PageUp', 'PageDown'], dpad: true },
  { id: 'editing', keys: [...COMMON_KEYS, 'Delete', 'Insert', 'CtrlD', 'CtrlL', 'CtrlA', 'CtrlZ', PASTE_KEY] },
  { id: 'symbols', keys: [], functions: [...functionKeys(1, 6), 'Backspace', ...functionKeys(7, 12), 'Enter'], symbols: true },
];

export const defaultKeyboardPrefs = () => ({
  modifierMode: 'oneShot',
  haptics: false,
  autoOpen: false,
});

export function keyboardPrefsStorage() {
  try { return typeof window !== 'undefined' ? window.localStorage : null; }
  catch (_error) { return null; }
}

export function normalizeKeyboardPrefs(value) {
  const base = defaultKeyboardPrefs();
  if (!value || typeof value !== 'object') return base;
  return {
    modifierMode: value.modifierMode === 'sticky' ? 'sticky' : 'oneShot',
    haptics: value.haptics === true,
    autoOpen: value.autoOpen === true,
  };
}

export function readKeyboardPrefs(storage) {
  try { return normalizeKeyboardPrefs(JSON.parse(storage?.getItem(KEYBOARD_PREFS_KEY) || 'null')); }
  catch (_error) { return defaultKeyboardPrefs(); }
}

export function writeKeyboardPrefs(storage, prefs) {
  const normalized = normalizeKeyboardPrefs(prefs);
  try { storage?.setItem(KEYBOARD_PREFS_KEY, JSON.stringify({ version: KEYBOARD_PREFS_VERSION, ...normalized })); }
  catch (_error) { /* sem storage */ }
  return normalized;
}
