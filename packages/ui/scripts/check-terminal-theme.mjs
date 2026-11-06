// SPDX-License-Identifier: Apache-2.0
// Tema proprio do terminal: a preferencia guardada, o esquema que o xterm usa
// e o espelho de cada bloco de tokens no contenedor do terminal, com a mesma
// especificidade do bloco original.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// DOM minimo: atributos, filhos e o que `getComputedStyle` devolve por
// elemento.
function fakeElement(tag) {
  const attributes = new Map();
  return {
    tagName: tag.toUpperCase(),
    children: [],
    isConnected: false,
    hidden: false,
    tokens: {},
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    hasAttribute(name) { return attributes.has(name); },
    removeAttribute(name) { attributes.delete(name); },
    appendChild(child) { this.children.push(child); child.isConnected = true; return child; },
  };
}

function installDom() {
  const html = fakeElement('html');
  html.isConnected = true;
  const body = fakeElement('body');
  html.appendChild(body);
  const stored = new Map();
  globalThis.document = { documentElement: html, body, createElement: fakeElement };
  globalThis.localStorage = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => { stored.set(key, String(value)); },
  };
  globalThis.getComputedStyle = (element) => ({ getPropertyValue: (name) => element.tokens[name] || '' });
  return { html, body, stored };
}

const dom = installDom();
const themeModule = await import('../src/terminals/terminal-theme.js');
const xtermTheme = await import('../src/terminals/theme.js');

test('a preferencia guarda so valores conhecidos e vira atributo no html', () => {
  const { STORAGE_KEY, getTerminalTheme, initTerminalTheme, setTerminalTheme, subscribeTerminalTheme } = themeModule;
  dom.stored.set(STORAGE_KEY, 'neon');
  assert.equal(initTerminalTheme(), 'app', 'valor estranho volta ao padrao');
  assert.equal(dom.html.getAttribute('data-terminal-theme'), null, 'igual a janela nao marca o html');

  const heard = [];
  const stop = subscribeTerminalTheme((mode) => heard.push(mode));
  assert.equal(setTerminalTheme('dark'), 'dark');
  assert.equal(dom.html.getAttribute('data-terminal-theme'), 'dark');
  assert.equal(dom.stored.get(STORAGE_KEY), 'dark');
  assert.equal(setTerminalTheme('dark'), 'dark', 'repetir nao avisa de novo');
  assert.equal(setTerminalTheme('rosa'), 'app', 'valor estranho vira igual a janela');
  assert.equal(dom.html.hasAttribute('data-terminal-theme'), false);
  stop();
  setTerminalTheme('light');
  assert.deepEqual(heard, ['dark', 'app'], 'quem saiu nao ouve mais');
  assert.equal(getTerminalTheme(), 'light');

  dom.stored.set(STORAGE_KEY, 'dark');
  assert.equal(initTerminalTheme(), 'dark', 'a abertura seguinte le o que ficou guardado');
  assert.equal(dom.html.getAttribute('data-terminal-theme'), 'dark');
});

test('o xterm usa o esquema e os tokens do terminal, nao os da janela', () => {
  const { setTerminalTheme } = themeModule;
  const { buildTheme, isDarkTerminal, searchDecorations } = xtermTheme;
  dom.html.setAttribute('data-theme', 'light');
  dom.html.tokens = { '--mac-surface-2': '#f5f6f8', '--mac-label': '#1d1d1f' };

  setTerminalTheme('app');
  assert.equal(isDarkTerminal(), false);
  assert.equal(buildTheme().background, '#f5f6f8', 'sem tema proprio os tokens saem do html');

  setTerminalTheme('dark');
  assert.equal(isDarkTerminal(), true);
  assert.equal(buildTheme().background, '#26262a', 'sem valor na sonda vale a reserva escura');
  const probe = dom.body.children.find((child) => child.hasAttribute('data-terminal-scope'));
  assert.ok(probe, 'a sonda entra no body');
  assert.equal(probe.hidden, true);
  assert.equal(probe.getAttribute('aria-hidden'), 'true');
  probe.tokens = { '--mac-surface-2': '#202024', '--mac-label': '#f5f5f7' };
  const dark = buildTheme({ light: { text: '#c0185f', softHover: 'rgba(1,2,3,.2)' }, dark: { text: '#ff8ac0', softHover: 'rgba(4,5,6,.3)' } });
  assert.equal(dark.background, '#202024', 'com tema proprio os tokens saem da sonda');
  assert.equal(dark.foreground, '#f5f5f7');
  assert.equal(dark.cursor, '#ff8ac0', 'o tom da sessao usa a variante do esquema do terminal');
  assert.equal(dark.black, '#2f2f34', 'as cores ANSI sao as do terminal escuro');
  assert.match(searchDecorations().matchBackground, /^#[0-9a-f]{6}$/);
  assert.equal(dom.body.children.filter((child) => child.hasAttribute('data-terminal-scope')).length, 1, 'uma sonda so');

  dom.html.setAttribute('data-theme', 'dark');
  setTerminalTheme('light');
  assert.equal(isDarkTerminal(), false, 'terminal claro na janela escura');
  assert.equal(buildTheme().black, '#1d1d1f');

  setTerminalTheme('app');
  assert.equal(isDarkTerminal(), true, 'igual a janela volta a seguir o data-theme');
});

// ── espelho dos tokens ────────────────────────────────────────────────
// Cada regra cujo alvo e o proprio html e declara variaveis precisa repetir o
// seletor para `[data-terminal-scope]` com a mesma especificidade. Assim o
// contenedor do terminal recebe o conjunto inteiro do esquema escolhido com o
// mesmo resultado de cascata do html, sem copia de valor.

function splitTop(text, separator = ',') {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function closing(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') { depth -= 1; if (depth === 0) return index; }
  }
  throw new Error(`parentese sem fechamento em ${text}`);
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const compare = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]);

// Especificidade do subconjunto usado nas folhas: tipo, classe, atributo,
// pseudo-classe, :is, :not, :has e :where.
function specificity(selector) {
  let total = [0, 0, 0];
  let index = 0;
  let compoundStart = true;
  while (index < selector.length) {
    const char = selector[index];
    if (/[\s>+~]/.test(char)) { index += 1; compoundStart = true; continue; }
    if (char === '[') {
      const end = selector.indexOf(']', index);
      total = add(total, [0, 1, 0]);
      index = end + 1;
    } else if (char === '.' || char === '#') {
      const name = selector.slice(index + 1).match(/^[\w-]+/)[0];
      total = add(total, char === '#' ? [1, 0, 0] : [0, 1, 0]);
      index += 1 + name.length;
    } else if (char === ':') {
      const element = selector[index + 1] === ':';
      const name = selector.slice(index + (element ? 2 : 1)).match(/^[\w-]+/)[0];
      index += (element ? 2 : 1) + name.length;
      if (selector[index] === '(') {
        const end = closing(selector, index);
        const inner = selector.slice(index + 1, end);
        index = end + 1;
        if (name === 'where') { compoundStart = false; continue; }
        if (['is', 'not', 'has', 'matches'].includes(name)) {
          total = add(total, splitTop(inner).map(specificity).sort(compare).at(-1));
        } else {
          total = add(total, [0, 1, 0]);
        }
      } else {
        total = add(total, element ? [0, 0, 1] : [0, 1, 0]);
      }
    } else if (char === '*') {
      index += 1;
    } else if (compoundStart && /[a-z]/i.test(char)) {
      const name = selector.slice(index).match(/^[\w-]+/)[0];
      total = add(total, [0, 0, 1]);
      index += name.length;
    } else {
      throw new Error(`seletor fora do subconjunto: ${selector}`);
    }
    compoundStart = false;
  }
  return total;
}

test('a especificidade do verificador segue a regra do CSS', () => {
  assert.deepEqual(specificity(':root'), [0, 1, 0]);
  assert.deepEqual(specificity('html[data-shell="desktop"][data-theme="dark"]'), [0, 2, 1]);
  assert.deepEqual(specificity(':is([data-shell="desktop"],[data-platform="macos"])[data-theme="dark"]'), [0, 2, 0]);
  assert.deepEqual(specificity(':where(html[data-terminal-theme]) [data-terminal-scope]'), [0, 1, 0]);
  assert.deepEqual(specificity(':where(html[data-terminal-theme="dark"] .session-scope) div[data-terminal-scope][data-terminal-scope]'), [0, 2, 1]);
  assert.deepEqual(specificity('.a > .b:hover::before'), [0, 3, 1]);
});

// O alvo e o html quando, tirando os atributos, sobra so `html`, `:root` ou um
// `:is` de atributos.
function targetsRoot(part) {
  const bare = part.replace(/\[[^\]]*\]/g, '').replace(/:is\(\s*(,\s*)*\)/g, '').trim();
  return bare === '' || bare === 'html' || bare === ':root';
}

const DESKTOP_CSS = source('../src/desktop/desktop.css');
const SHEETS = [...DESKTOP_CSS.matchAll(/@import '([^']+)';/g)].map((match) => new URL(match[1], new URL('../src/desktop/', import.meta.url)));

function rulesOf(url) {
  const css = readFileSync(fileURLToPath(url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    file: fileURLToPath(url).split('/src/')[1],
    selector: match[1].trim().replace(/\s+/g, ' '),
    parts: splitTop(match[1].trim().replace(/\s+/g, ' ')),
    body: match[2],
    tokens: [...match[2].matchAll(/(--[\w-]+)\s*:/g)].map((token) => token[1]),
  }));
}

const RULES = SHEETS.flatMap((url, order) => rulesOf(url).map((rule, position) => ({ ...rule, order, position })));

test('cada bloco de tokens do html tem espelho no terminal com a mesma especificidade', () => {
  assert.ok(SHEETS.length >= 6, 'desktop.css lista as camadas');
  let mirrored = 0;
  for (const rule of RULES.filter((entry) => entry.tokens.length)) {
    const mirrors = rule.parts.filter((part) => part.includes('[data-terminal-scope]'));
    for (const part of rule.parts.filter((entry) => !entry.includes('data-terminal-scope') && targetsRoot(entry))) {
      // A pagina do celular nunca ganha tema proprio do terminal.
      if (/^\[data-form-factor="phone"\]/.test(part)) continue;
      const dark = /data-theme="dark"/.test(part);
      const match = mirrors.find((mirror) => compare(specificity(mirror), specificity(part)) === 0
        && (dark ? /data-terminal-theme="dark"/.test(mirror) : /\[data-terminal-theme\]/.test(mirror)));
      assert.ok(match, `${rule.file}: ${part} sem espelho de mesma especificidade para [data-terminal-scope]`);
      mirrored += 1;
    }
  }
  assert.ok(mirrored >= 14, `so ${mirrored} blocos espelhados`);
});

test('o tom da sessao vence os espelhos dentro do terminal', () => {
  const session = RULES.filter((rule) => rule.parts.some((part) => /\.session-scope\) div\[data-terminal-scope\]/.test(part)));
  assert.equal(session.length, 3, 'claro, escuro e acento');
  for (const rule of session) {
    const weight = specificity(rule.parts[0]);
    for (const other of RULES.filter((entry) => !session.includes(entry) && entry.parts.some((part) => part.includes('[data-terminal-scope]')))) {
      const shared = other.tokens.filter((token) => rule.tokens.includes(token));
      if (!shared.length) continue;
      const otherWeight = other.parts.filter((part) => part.includes('[data-terminal-scope]')).map(specificity).sort(compare).at(-1);
      const later = rule.order > other.order || (rule.order === other.order && rule.position > other.position);
      assert.ok(compare(weight, otherWeight) > 0 || (compare(weight, otherWeight) === 0 && later), `${other.file}: ${other.selector} passa por cima do tom da sessao em ${shared.join(', ')}`);
    }
  }
  const accent = session.find((rule) => rule.tokens.includes('--mac-accent'));
  assert.ok(accent, 'o acento da casca aponta para o tom da sessao');
  assert.ok(RULES.some((rule) => rule.selector === ':where(html[data-terminal-theme="dark"]) [data-terminal-scope]' && /color-scheme:dark/.test(rule.body)));
  assert.ok(RULES.some((rule) => rule.selector === ':where(html[data-terminal-theme="light"]) [data-terminal-scope]' && /color-scheme:light/.test(rule.body)));
});

test('o contenedor, a abertura, o xterm e as preferencias usam o tema proprio', () => {
  const work = source('../src/terminals/ui/WorkArea.jsx');
  assert.match(work, /className=\{`terminais-terminal\$\{dropping \? ' is-dropping' : ''\}`\}\s*data-terminal-scope=""/);
  const main = source('../src/desktop/main.jsx');
  assert.ok(main.indexOf('initTerminalTheme();') > 0 && main.indexOf('initTerminalTheme();') < main.indexOf('createRoot('), 'o tema entra antes da montagem');
  const runtime = source('../src/terminals/runtime.js');
  assert.match(runtime, /state\.themeWatcher = watchTerminalTheme\(/, 'o xterm reaplica quando o tema do terminal muda');
  const preferences = source('../src/desktop/Preferences.jsx');
  assert.match(preferences, /desktop\.preferences\.terminalTheme/);
  assert.match(preferences, /onChange=\{setTerminalTheme\}/);
  const palette = source('../src/desktop/CommandPalette.jsx');
  for (const mode of ['app', 'light', 'dark']) assert.match(palette, new RegExp(`setTerminalTheme\\('${mode}'\\)`));
  const phone = source('../src/terminals/theme.js');
  assert.match(phone, /const dark = phone \|\| isDarkTerminal\(\);/, 'o celular continua sempre escuro');
});
