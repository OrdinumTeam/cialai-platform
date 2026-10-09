// SPDX-License-Identifier: Apache-2.0
// Navegador de pastas do celular sem ponte nem DOM: caminho atual, pasta
// acima, filtro, seleção, aviso de lista cortada e o botão de confirmar.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = {
  native: `export const invoke = () => new Promise(() => {});`,
  files: `export const baseName = (p) => String(p).split('/').filter(Boolean).at(-1) || String(p);
    export const shortPath = (p) => String(p).replace(/^\\/Users\\/ana/, '~');`,
};
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/terminals/ui/DirectoryBrowser.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
  plugins: [{ name: 'browser-boundaries', setup(api) {
    api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path }) => {
      const key = path.split('/').at(-1).replace(/\.jsx?$/, '');
      if (mocks[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
  } }],
});
const context = vm.createContext({
  console, module: { exports: {} }, exports: {}, require: createRequire(import.meta.url),
  window: {}, document: { documentElement: { lang: 'pt-BR', dataset: {} } }, localStorage: { getItem: () => null, setItem: () => {} },
});
vm.runInContext(bundle.outputFiles[0].text, context);
const api = context.module.exports;
const noop = () => {};
const listing = {
  path: '/Users/ana/Projects', parent: '/Users/ana', truncated: false,
  entries: [{ name: 'psicoapp', path: '/Users/ana/Projects/psicoapp' }, { name: 'frontend', path: '/Users/ana/Projects/frontend' }],
};
const view = (props) => renderToStaticMarkup(React.createElement(api.DirectoryBrowserView, {
  listing, loading: false, error: null, query: '', selected: null,
  onQuery: noop, onSelect: noop, onOpenFolder: noop, onConfirm: noop, onClose: noop, ...props,
}));

test('mostra o caminho atual, a pasta acima e cada subpasta com seleção e entrada', () => {
  const html = view();
  assert.match(html, /~\/Projects/);
  assert.match(html, /aria-label="Pasta acima"/);
  assert.doesNotMatch(html, /disabled=""[^>]*aria-label="Pasta acima"/);
  assert.match(html, /role="radio" aria-checked="false"[^]*psicoapp/);
  assert.match(html, /aria-label="Abrir frontend"/);
  // Sem seleção, confirma a pasta atual.
  assert.match(html, /Usar Projects/);
});

test('a seleção marca a linha e muda o botão de confirmar', () => {
  const html = view({ selected: '/Users/ana/Projects/frontend' });
  assert.match(html, /phone-browser__row is-selected[^]*frontend/);
  assert.match(html, /Usar frontend/);
});

test('o filtro ignora acento e caixa e avisa quando nada combina', () => {
  assert.deepEqual([...api.filterEntries([{ name: 'Configuração' }, { name: 'docs' }], 'CONFIGURACAO')].map((entry) => entry.name), ['Configuração']);
  assert.match(view({ query: 'zzz' }), /Nenhuma pasta com esse nome aqui/);
});

test('nos pontos de partida não há pasta acima e a lista cortada é avisada', () => {
  const html = view({ listing: { path: '', entries: [{ name: 'ana', path: '/Users/ana' }], truncated: true } });
  assert.match(html, /Pontos de partida/);
  assert.match(html, /disabled=""[^>]*aria-label="Pasta acima"/);
  assert.match(html, /Há mais subpastas do que cabe na lista/);
  assert.match(html, /phone-flow__primary" disabled=""/);
});

test('erro do computador aparece no lugar da lista e o rótulo de confirmação pode ser trocado', () => {
  const html = view({ error: 'Fora das pastas permitidas', confirmLabel: 'Adicionar a Projetos' });
  assert.match(html, /role="alert">Fora das pastas permitidas/);
  assert.match(html, /Adicionar a Projetos/);
});
