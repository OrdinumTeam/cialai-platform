// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildTheme, opaqueColor, searchDecorations } from '../src/terminals/theme.js';

const themePath = fileURLToPath(new URL('../src/desktop/theme.macos.js', import.meta.url));
const { build } = await import('esbuild');
const [bundle] = (await build({
  entryPoints: [themePath], bundle: true, platform: 'node', format: 'esm', write: false,
})).outputFiles;
const { buildMacTheme } = await import(`data:text/javascript;base64,${Buffer.from(bundle.contents).toString('base64')}`);

const cssTokens = new Map();
globalThis.document = {
  documentElement: {
    getAttribute(name) { return name === 'data-theme' ? 'light' : null; },
  },
};
globalThis.getComputedStyle = () => ({
  getPropertyValue(name) { return cssTokens.get(name) || ''; },
});

test('os controles usam a identidade rosa do Cialai nos dois temas', () => {
  const light = buildMacTheme('light');
  const dark = buildMacTheme('dark');

  assert.equal(light.palette.primary.main, '#E23B84');
  assert.equal(dark.palette.primary.main, '#FF7AB2');
  assert.equal(light.palette.primary.contrastText, '#3A1B33');
  assert.equal(dark.palette.primary.contrastText, '#3A1B33');
});

test('o azul ANSI continua azul quando o acento da interface fica rosa', () => {
  cssTokens.set('--mac-accent', '#E23B84');
  cssTokens.set('--mac-accent-hover', '#C9317A');
  cssTokens.set('--mac-accent-soft-hover', 'rgba(226,59,132,.14)');

  const theme = buildTheme();

  assert.equal(theme.blue, '#1a4fa0');
  assert.equal(theme.brightBlue, '#4a8ae6');
  assert.equal(theme.selectionBackground, 'rgba(226,59,132,.14)');
});

test('a busca no terminal entrega ao xterm cores opacas em hex', () => {
  cssTokens.set('--mac-surface-2', '#f5f6f8');
  cssTokens.set('--mac-warn', '#c27a00');
  cssTokens.set('--mac-accent', '#E23B84');
  cssTokens.set('--mac-accent-soft-hover', 'rgba(226,59,132,.14)');
  cssTokens.set('--terminais-editor-search', 'rgba(194,122,0,.22)');

  const colors = searchDecorations();

  for (const value of Object.values(colors)) assert.match(value, /^#[\da-f]{6}$/);
  assert.equal(colors.activeMatchColorOverviewRuler, '#e23b84');
  assert.equal(colors.matchBackground, opaqueColor('rgba(194,122,0,.22)', '#f5f6f8'));
  assert.equal(opaqueColor('rgba(0,0,0,.5)', '#ffffff'), '#808080');
  assert.equal(opaqueColor('#fff8', '#000000'), '#888888');
  assert.equal(opaqueColor('var(--x)', '#ffffff', '#123456'), '#123456');
});
