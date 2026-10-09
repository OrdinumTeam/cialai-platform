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
// padrão.

export const KEYBOARD_PREFS_KEY = 'cialai_terminal_keyboard';
export const MAX_FAVORITES = 3;
export const PASTE_KEY = 'Paste';

const ctrl = { ctrl: true };

// `hint` é a chave de tradução que explica o efeito no terminal.
export const KEY_CATALOG = Object.freeze({
  Escape: { key: 'Escape', cap: 'Esc' },
  Tab: { key: 'Tab', cap: 'Tab' },
  Enter: { key: 'Enter', cap: 'Enter' },
  Backspace: { key: 'Backspace', cap: 'Backspace' },
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
  ShiftTab: { key: 'Tab', mods: { shift: true }, cap: 'Shift Tab', hint: 'terminal.phone.keys.hint.shiftTab' },
  CtrlC: { key: 'c', mods: ctrl, cap: 'Ctrl C', hint: 'terminal.phone.keys.hint.ctrlC' },
  CtrlD: { key: 'd', mods: ctrl, cap: 'Ctrl D', hint: 'terminal.phone.keys.hint.ctrlD' },
  CtrlL: { key: 'l', mods: ctrl, cap: 'Ctrl L', hint: 'terminal.phone.keys.hint.ctrlL' },
  // `icon` faz a tecla aparecer na barra só com o ícone.
  CtrlV: { key: 'v', mods: ctrl, cap: 'terminal.phone.keys.pasteCtrlV', translated: true, name: 'terminal.phone.keys.pasteCtrlVName', hint: 'terminal.phone.keys.hint.ctrlV', icon: 'paste' },
  CtrlA: { key: 'a', mods: ctrl, cap: 'Ctrl A', hint: 'terminal.phone.keys.hint.ctrlA' },
  CtrlZ: { key: 'z', mods: ctrl, cap: 'Ctrl Z', hint: 'terminal.phone.keys.hint.ctrlZ' },
  CtrlR: { key: 'r', mods: ctrl, cap: 'Ctrl R', hint: 'terminal.phone.keys.hint.ctrlR' },
  [PASTE_KEY]: { key: null, cap: 'terminal.phone.paste', name: 'terminal.phone.pasteLabel', translated: true, hint: 'terminal.phone.keys.hint.pastePhone' },
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

export const KEYBOARD_TABS = [
  // Os comandos mais usados nos agentes ficam já na primeira aba, na segunda linha.
  { id: 'basic', keys: ['Escape', 'Tab', 'Enter', 'Backspace', 'ShiftTab', 'CtrlC', 'CtrlV', 'CtrlR'], modifiers: true, dpad: true },
  { id: 'navigation', keys: ['Home', 'End', 'PageUp', 'PageDown'], dpad: true },
  { id: 'editing', keys: ['Delete', 'Insert', 'CtrlD', 'CtrlL', 'CtrlA', 'CtrlZ', PASTE_KEY] },
  { id: 'symbols', keys: Array.from({ length: 12 }, (_, index) => `F${index + 1}`), symbols: true },
];

// Teclas que podem ir para a barra. Setas ficam de fora: na barra seriam os
// botões pequenos em fila que o painel existe para evitar.
export const FAVORITE_CHOICES = ['Escape', 'Tab', 'Enter', 'ShiftTab', 'CtrlC', 'CtrlV', 'CtrlD', 'CtrlL', 'CtrlR', 'CtrlZ', 'Backspace', 'Home', 'End', PASTE_KEY];

export const defaultKeyboardPrefs = () => ({
  // Colar, que é Ctrl V, já vem na barra: é o que mais se usa com os agentes.
  favorites: ['Escape', 'Tab', 'CtrlV'],
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
  const favorites = Array.isArray(value.favorites)
    ? [...new Set(value.favorites.filter((id) => FAVORITE_CHOICES.includes(id)))].slice(0, MAX_FAVORITES)
    : base.favorites;
  return {
    favorites,
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
  try { storage?.setItem(KEYBOARD_PREFS_KEY, JSON.stringify({ version: 1, ...normalized })); }
  catch (_error) { /* sem storage */ }
  return normalized;
}

export function toggleFavorite(prefs, id) {
  const favorites = prefs.favorites.includes(id)
    ? prefs.favorites.filter((item) => item !== id)
    : [...prefs.favorites, id].slice(0, MAX_FAVORITES);
  return normalizeKeyboardPrefs({ ...prefs, favorites });
}

export function moveFavorite(prefs, id, delta) {
  const favorites = [...prefs.favorites];
  const from = favorites.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= favorites.length) return prefs;
  [favorites[from], favorites[to]] = [favorites[to], favorites[from]];
  return { ...prefs, favorites };
}
