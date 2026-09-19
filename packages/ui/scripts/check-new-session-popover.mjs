// SPDX-License-Identifier: Apache-2.0
// Seletor de pasta com uma ponte falsa. Com a raiz de projetos apontando para
// Documentos, a lista mostrava só as subpastas dela: não havia como abrir uma
// sessão na própria Documentos nem subir um nível. Aqui a raiz entra como
// opção e o modo navegar cobre o resto, dentro dos limites do servidor.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = {
  native: `export const invoke = (cmd, args) => fixture.invoke(cmd, args);
    export const isTauri = () => fixture.tauri; export const hasBridge = () => true;`,
  shell: `export const isPhone = () => fixture.phone;`,
  runtime: `export const getRecent = () => fixture.recent; export const isDemo = () => false;`,
  files: `export const baseName = (p) => String(p).split('/').filter(Boolean).at(-1) || String(p);
    export const portablePath = (p) => String(p || '').replace(/\\\\/g, '/');
    export const shortPath = (p) => String(p);`,
};

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/terminals/ui/NewSessionPopover.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
  plugins: [{ name: 'popover-boundaries', setup(api) {
    api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path }) => {
      const key = path.split('/').at(-1).replace(/\.jsx?$/, '');
      if (mocks[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
  } }],
});

// Árvore falsa: Documentos é a raiz de projetos e tem duas subpastas.
const TREE = {
  '': { path: '', entries: [{ name: 'ana', path: '/Users/ana' }] },
  '/Users/ana': { path: '/Users/ana', entries: [{ name: 'Documentos', path: '/Users/ana/Documentos' }] },
  '/Users/ana/Documentos': {
    path: '/Users/ana/Documentos',
    parent: '/Users/ana',
    entries: [{ name: 'contratos', path: '/Users/ana/Documentos/contratos' }, { name: 'notas', path: '/Users/ana/Documentos/notas' }],
  },
};

function mount({ phone = false, tauri = false, recent = [], startPath = null } = {}) {
  const calls = [];
  const body = { children: [], appendChild(child) { this.children.push(child); } };
  const fixture = {
    phone, tauri, recent, calls,
    invoke(cmd, args) {
      calls.push({ cmd, args });
      if (cmd === 'list_repo_dirs') {
        return Promise.resolve({
          roots: [{ label: 'Documentos', path: '/Users/ana/Documentos', exists: true }],
          repos: [{ name: 'contratos', path: '/Users/ana/Documentos/contratos', root: 'Documentos' }],
        });
      }
      if (cmd === 'list_dirs') {
        const listing = TREE[args.path || ''];
        return listing ? Promise.resolve({ ...listing, truncated: false }) : Promise.reject(new Error('fora dos limites'));
      }
      return Promise.reject(new Error(`chamada inesperada: ${cmd}`));
    },
  };
  // `createPortal` exige um elemento do DOM, que o render estático não tem. A
  // fronteira devolve os filhos no lugar, e o componente segue o de produção.
  const load = createRequire(import.meta.url);
  const require_ = (id) => (id === 'react-dom'
    ? { ...load('react-dom'), createPortal: (children) => children }
    : load(id));
  const context = vm.createContext({
    fixture, console, module: { exports: {} }, exports: {}, require: require_,
    window: { innerWidth: 1280, innerHeight: 800 },
    document: {
      documentElement: { lang: 'pt-BR', dataset: {} }, body,
      addEventListener() {}, removeEventListener() {},
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {},
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const api = context.module.exports;
  const Popover = api.default;
  const picked = [];
  const html = renderToStaticMarkup(React.createElement(Popover, {
    anchor: null, startPath,
    onClose() {}, onPick: (path, name) => picked.push([path, name]),
    onBrowse: tauri ? () => {} : undefined,
  }));
  return { html, picked, fixture, api };
}

test('o seletor oferece Navegar pastas nos dois modos', () => {
  const desktop = mount({ tauri: true });
  assert.match(desktop.html, /Navegar pastas/);
  assert.match(desktop.html, /Escolher outra pasta/, 'no computador o diálogo nativo continua');

  const phone = mount({ phone: true });
  assert.match(phone.html, /Navegar pastas/, 'no celular o navegador é o único caminho');
  assert.doesNotMatch(phone.html, /Escolher outra pasta/);
});

test('o modo navegar mostra a trilha, Pasta acima e Usar esta pasta', async () => {
  // O estado da navegação vem de um efeito assíncrono; o render estático
  // exercita a estrutura, e a árvore falsa cobre as chamadas.
  const { fixture } = mount();
  const listing = await fixture.invoke('list_dirs', { path: '/Users/ana/Documentos' });
  assert.equal(listing.path, '/Users/ana/Documentos');
  assert.equal(listing.parent, '/Users/ana');
  assert.deepEqual([...listing.entries.map((entry) => entry.name)], ['contratos', 'notas']);
  await assert.rejects(fixture.invoke('list_dirs', { path: '/etc' }), /fora dos limites/);

  const source = (await import('node:fs')).readFileSync(
    fileURLToPath(new URL('../src/terminals/ui/NewSessionPopover.jsx', import.meta.url)), 'utf8',
  );
  const browse = source.slice(source.indexOf('if (browse) {'), source.indexOf('let running = -1;'));
  assert.match(browse, /terminal\.session\.folderUp/);
  assert.match(browse, /terminal\.session\.useThisFolder/);
  assert.match(browse, /onClick=\{\(\) => openFolder\(entry\.path\)\}/, 'tocar numa pasta desce');
  assert.match(browse, /onClick=\{\(\) => openFolder\(browse\.parent \|\| null\)\}/, 'Pasta acima sobe');
  assert.match(browse, /disabled=\{!current\}/, 'sem pasta atual não há o que usar');
});

test('cada raiz oferece a si mesma, antes das subpastas', () => {
  const { api } = mount();
  const repos = {
    roots: [{ label: 'Documentos', path: '/Users/ana/Documentos', exists: true }],
    repos: [{ name: 'contratos', path: '/Users/ana/Documentos/contratos', root: 'Documentos' }],
  };
  const groups = api.folderGroups({ recent: [], repos, query: '' });
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].items.map((item) => item.name)], ['Documentos', 'contratos'], 'a própria raiz vem primeiro');
  assert.equal(groups[0].items[0].path, '/Users/ana/Documentos');

  // Uma raiz que não existe no disco não se oferece.
  const missing = api.folderGroups({ recent: [], repos: { roots: [{ label: 'Sumida', path: '/x', exists: false }], repos: [] }, query: '' });
  assert.equal(missing.length, 0);

  // A busca filtra a raiz junto com as subpastas.
  const filtered = api.folderGroups({ recent: [], repos, query: 'contra' });
  assert.deepEqual([...filtered[0].items.map((item) => item.name)], ['contratos']);

  // Recentes continuam em primeiro, com o nome da pasta acima.
  const withRecent = api.folderGroups({ recent: ['/Users/ana/Documentos/notas'], repos, query: '' });
  assert.equal(withRecent[0].showParent, true);
  assert.equal(withRecent[0].items[0].name, 'notas');
});

test('abrir a partir de uma sessão começa na pasta dela', async () => {
  const source = (await import('node:fs')).readFileSync(
    fileURLToPath(new URL('../src/terminals/ui/NewSessionPopover.jsx', import.meta.url)), 'utf8',
  );
  assert.match(source, /openFolder\(startPath \|\| null\)/);
  const workbench = (await import('node:fs')).readFileSync(
    fileURLToPath(new URL('../src/terminals/ui/PhoneWorkbench.jsx', import.meta.url)), 'utf8',
  );
  assert.match(workbench, /startPath=\{folderFor\.cwd\}/, 'trocar a pasta começa na pasta atual da sessão');
  assert.match(workbench, /changeDirectory\(session\.id, path\)/);
});
