// SPDX-License-Identifier: Apache-2.0
// Atalhos por sistema. No macOS, Mod é ⌘ e nunca chega ao shell. No Linux e no
// Windows, Mod é Ctrl; dentro do terminal os atalhos do app ganham Shift, como
// no Windows Terminal e no GNOME Terminal, e fora dele o Ctrl simples também
// vale. Combinações usam nomes: 'Mod+Shift+E', 'Alt+ArrowUp', 'Mod+Equal'.

import { platform } from './platform.js';

const CODES = {
  Comma: ['Comma', ','],
  Equal: ['Equal', '=', '+'],
  Minus: ['Minus', '-', '_'],
  BracketLeft: ['BracketLeft', '[', '{'],
  BracketRight: ['BracketRight', ']', '}'],
  Backspace: ['Backspace', 'Backspace'],
  Delete: ['Delete', 'Delete'],
  Insert: ['Insert', 'Insert'],
  Enter: ['Enter', 'Enter'],
  Escape: ['Escape', 'Escape'],
  ArrowUp: ['ArrowUp', 'ArrowUp'],
  ArrowDown: ['ArrowDown', 'ArrowDown'],
};

const MAC_KEYS = { Comma: ',', Equal: '+', Minus: '−', BracketLeft: '[', BracketRight: ']', Backspace: '⌫', Delete: '⌦', Insert: 'Insert', Enter: '↩', Escape: 'esc', ArrowUp: '↑', ArrowDown: '↓' };
const OTHER_KEYS = { Comma: ',', Equal: '+', Minus: '−', BracketLeft: '[', BracketRight: ']', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert', Enter: 'Enter', Escape: 'Esc', ArrowUp: '↑', ArrowDown: '↓' };

export function currentOs() {
  const fromDocument = typeof document !== 'undefined' ? document.documentElement?.dataset?.platform : '';
  return fromDocument || platform().os;
}

const isMac = (os) => (os || currentOs()) === 'macos';

export function parse(combo) {
  const parts = String(combo).split('+');
  const key = parts.pop();
  const flags = new Set(parts);
  return { key, mod: flags.has('Mod'), shift: flags.has('Shift'), alt: flags.has('Alt'), ctrl: flags.has('Ctrl') };
}

function keyMatches(event, key) {
  const known = CODES[key];
  if (known) {
    const [code, ...values] = known;
    return event.code === code || values.includes(event.key);
  }
  if (/^[A-Z]$/.test(key)) return event.code === `Key${key}` || String(event.key).toLowerCase() === key.toLowerCase();
  if (/^[0-9]$/.test(key)) return event.code === `Digit${key}` || event.key === key;
  return event.key === key;
}

// Modificador principal do sistema, sem o outro.
export function mod(event, os) {
  return isMac(os) ? Boolean(event.metaKey) && !event.ctrlKey : Boolean(event.ctrlKey) && !event.metaKey;
}

export function isShortcut(event, combo, os) {
  const wanted = parse(combo);
  const mac = isMac(os);
  const meta = mac ? wanted.mod : false;
  const ctrl = mac ? wanted.ctrl : wanted.mod || wanted.ctrl;
  return Boolean(event.metaKey) === meta
    && Boolean(event.ctrlKey) === ctrl
    && Boolean(event.shiftKey) === wanted.shift
    && Boolean(event.altKey) === wanted.alt
    && keyMatches(event, wanted.key);
}

// Variante que não colide com o shell: no Linux e no Windows, Mod ganha Shift.
export function terminalSafe(combo, os) {
  const wanted = parse(combo);
  if (isMac(os) || !wanted.mod || wanted.shift) return combo;
  return ['Mod', 'Shift', wanted.alt ? 'Alt' : null, wanted.key].filter(Boolean).join('+');
}

// Atalho do app: dentro do terminal só a variante segura; fora dele as duas.
export function isAppShortcut(event, combo, { inTerminal = false, os } = {}) {
  if (isShortcut(event, terminalSafe(combo, os), os)) return true;
  return !inTerminal && isShortcut(event, combo, os);
}

export function label(combo, os) {
  const wanted = parse(combo);
  if (isMac(os)) {
    const glyphs = `${wanted.ctrl ? '⌃' : ''}${wanted.alt ? '⌥' : ''}${wanted.shift ? '⇧' : ''}${wanted.mod ? '⌘' : ''}`;
    return `${glyphs}${MAC_KEYS[wanted.key] ?? wanted.key}`;
  }
  const words = [wanted.mod || wanted.ctrl ? 'Ctrl' : null, wanted.shift ? 'Shift' : null, wanted.alt ? 'Alt' : null, OTHER_KEYS[wanted.key] ?? wanted.key];
  return words.filter(Boolean).join(' ');
}

// Rótulo mostrado em menus, dicas e na paleta: sempre a variante que funciona
// com o foco em qualquer lugar.
export function shortcutLabel(combo, os) {
  return label(terminalSafe(combo, os), os);
}

export function isTerminalFocused(root = typeof document !== 'undefined' ? document : null) {
  const active = root?.activeElement;
  return Boolean(active && typeof active.closest === 'function' && active.closest('.xterm'));
}
