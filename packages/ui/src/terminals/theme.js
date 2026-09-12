// SPDX-License-Identifier: Apache-2.0
// Tema do xterm derivado dos tokens da camada macOS. O fundo e a superficie
// suave do painel, para terminal e cabecalho formarem um bloco so, e as cores
// ANSI de estado saem dos mesmos tokens que o resto do app usa.

function token(name, fallback = '') {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function isDarkTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

export function terminalFont() {
  return token('--mac-font-mono', '"SF Mono", SFMono-Regular, ui-monospace, Menlo, monospace');
}

const LIGHT_ANSI = {
  black: '#1d1d1f',
  blue: '#1a4fa0',
  magenta: '#8a3fb2',
  cyan: '#0f7f8c',
  white: '#d2d2d7',
  brightBlack: '#6e6e73',
  brightBlue: '#4a8ae6',
  brightMagenta: '#a55ad0',
  brightCyan: '#1a9aa8',
  brightWhite: '#f5f6f8',
};

const DARK_ANSI = {
  black: '#2f2f34',
  blue: '#4a8ae6',
  magenta: '#c67de8',
  cyan: '#3fc1cf',
  white: '#d8d8dc',
  brightBlack: '#8e8e93',
  brightBlue: '#5f9aeb',
  brightMagenta: '#d9a0f2',
  brightCyan: '#66d3de',
  brightWhite: '#f5f5f7',
};

// Objeto novo a cada chamada: o xterm so reaplica o tema quando a referencia
// muda.
export function buildTheme() {
  const dark = isDarkTheme();
  const surface = token('--mac-surface-2', dark ? '#26262a' : '#f5f6f8');
  const ink = token('--mac-label', dark ? '#f5f5f7' : '#1d1d1f');
  const ok = token('--mac-ok', '#1f9d5b');
  const warn = token('--mac-warn', '#c27a00');
  const bad = token('--mac-bad', '#d83a3a');
  return {
    background: surface,
    foreground: ink,
    cursor: ink,
    cursorAccent: surface,
    selectionBackground: token('--mac-accent-soft-hover', 'rgba(26,79,160,.14)'),
    selectionInactiveBackground: token('--mac-neutral-bg', 'rgba(0,0,0,.05)'),
    red: bad,
    green: ok,
    yellow: warn,
    brightRed: bad,
    brightGreen: ok,
    brightYellow: warn,
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
  };
}

// Mesmo padrao do Mapa: observa data-theme no html em vez de depender do
// contexto de aparencia, que as views nao recebem.
export function watchTheme(apply) {
  const observer = new MutationObserver(() => apply());
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
