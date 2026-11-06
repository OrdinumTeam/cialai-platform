// SPDX-License-Identifier: Apache-2.0
// Tema proprio do terminal no computador: igual a janela, claro ou escuro.
//
// A escolha vira o atributo `data-terminal-theme` no html. As folhas de estilo
// repetem cada bloco de tokens de tema para o elemento com
// `data-terminal-scope`, com a mesma especificidade do bloco original, entao o
// contenedor do terminal recebe o conjunto inteiro do esquema escolhido sem
// copia de valor nenhum. `theme.js` le os tokens do xterm de uma sonda com o
// mesmo escopo. Sem o atributo, o terminal herda o tema da janela como sempre.
//
// O celular nao usa: o terminal dele e sempre escuro.

import { useEffect, useState } from 'react';

export const TERMINAL_THEMES = Object.freeze(['app', 'light', 'dark']);
export const STORAGE_KEY = 'cialai_terminal_theme';

const listeners = new Set();

function read() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return TERMINAL_THEMES.includes(stored) ? stored : 'app';
  } catch (_error) {
    return 'app';
  }
}

let current = 'app';

function apply(mode) {
  const root = document.documentElement;
  if (mode === 'app') root.removeAttribute('data-terminal-theme');
  else root.setAttribute('data-terminal-theme', mode);
}

// Chamado uma vez na montagem da casca desktop, antes do primeiro terminal.
export function initTerminalTheme() {
  current = read();
  apply(current);
  return current;
}

export function getTerminalTheme() {
  return current;
}

export function setTerminalTheme(mode) {
  const next = TERMINAL_THEMES.includes(mode) ? mode : 'app';
  if (next === current) return current;
  current = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch (_error) { /* sem storage */ }
  apply(next);
  listeners.forEach((listener) => {
    try { listener(next); } catch (error) { console.error('[terminais/tema]', error); }
  });
  return next;
}

export function subscribeTerminalTheme(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTerminalTheme() {
  const [value, setValue] = useState(current);
  useEffect(() => subscribeTerminalTheme(setValue), []);
  return value;
}
