// SPDX-License-Identifier: Apache-2.0
// Fundacao visual do celular: os tokens phone-* em mobile.css, que seguem os
// do aplicativo nativo, e os componentes de mobile/ui.jsx.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const css = source('../src/mobile/mobile.css');
const nativeTokens = source('../../../apps/mobile/src/ui/tokens.ts');

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/mobile/ui.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
  plugins: [{ name: 'phone-ui-boundaries', setup(api) {
    api.onResolve({ filter: /\/i18n\.js$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const translate=(key)=>key;', loader: 'js' }));
  } }],
});
const context = vm.createContext({ module: { exports: {} }, exports: {}, require, console });
vm.runInContext(bundle.outputFiles[0].text, context);
const ui = context.module.exports;
const html = (element) => renderToStaticMarkup(element);

test('os neutros do celular sao os mesmos do aplicativo nativo e o acento continua o da marca', () => {
  for (const [token, value] of [['bg', '#F8FAFF'], ['surface', '#FFFFFF'], ['border', '#E7EAF2'], ['text', '#20232C'],
    ['text-2', '#747B8B'], ['success', '#18A66A'], ['warning', '#D38B17'], ['danger', '#E5484D'], ['primary-soft', '#FCE7F1'],
    ['terminal', '#202127']]) {
    assert.match(css, new RegExp(`--phone-${token}: ${value};`), `--phone-${token} precisa ser ${value}`);
    assert.ok(nativeTokens.includes(`'${value}'`), `o token nativo correspondente a --phone-${token} precisa ser ${value}`);
  }
  assert.match(css, /--phone-primary: var\(--mac-accent\);/);
  assert.doesNotMatch(css, /--mac-accent\s*:/, 'mobile.css nao redefine o acento da marca');
  assert.match(css, /--mac-fill: var\(--mac-press\);/, '--mac-fill precisa existir no celular');
  assert.match(css, /\[data-form-factor="phone"\]\[data-theme="dark"\] \{/);
});

test('o controle segmentado marca a opcao escolhida e mostra a contagem', () => {
  const markup = html(React.createElement(ui.SegmentedControl, { label: 'Filtro', value: 'on', onChange() {}, options: [
    { value: 'all', label: 'Todos' }, { value: 'on', label: 'Conectados', count: 2 }, { value: 'off', label: 'Desconectados', disabled: true },
  ] }));
  assert.match(markup, /role="tablist" aria-label="Filtro"/);
  assert.match(markup, /aria-selected="true"[^>]*class="phone-segmented__option is-selected"/);
  assert.match(markup, /<span class="phone-segmented__count">2<\/span>/);
  assert.match(markup, /disabled=""/);
});

test('a busca so oferece limpar quando ha texto', () => {
  const empty = html(React.createElement(ui.SearchInput, { value: '', onChange() {}, placeholder: 'Buscar sessão' }));
  assert.match(empty, /aria-label="Buscar sessão"/);
  assert.doesNotMatch(empty, /mobile\.common\.clearSearch/);
  const filled = html(React.createElement(ui.SearchInput, { value: 'deploy', onChange() {}, placeholder: 'Buscar sessão' }));
  assert.match(filled, /aria-label="mobile\.common\.clearSearch"/);
});

test('o selo e a barra de progresso usam o tom pedido e limitam o valor', () => {
  assert.equal(html(React.createElement(ui.StatusBadge, { label: 'Reserva', tone: 'warning', variant: 'pill' })),
    '<span class="phone-badge phone-badge--pill phone-badge--warning">Reserva</span>');
  assert.equal(html(React.createElement(ui.StatusBadge, { label: 'Desconectado' })), '<span class="phone-badge">Desconectado</span>');
  assert.match(html(React.createElement(ui.ProgressIndicator, { value: 0.62, label: '62%' })), /aria-valuenow="62"[^>]*><div class="phone-progress__fill" style="width:62%"/);
  assert.match(html(React.createElement(ui.ProgressIndicator, { value: 7 })), /aria-valuenow="100"/);
  assert.match(html(React.createElement(ui.ProgressIndicator, { value: Number.NaN })), /aria-valuenow="0"/);
});
