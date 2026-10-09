// SPDX-License-Identifier: Apache-2.0
// Sessão nova do celular em três etapas e navegador de pastas, renderizados
// com uma ponte falsa e sem DOM. Confere a grade de projetos em duas colunas,
// o indicador de etapas, as contas nunca bloqueadas pelo número de uso, a
// continuidade de sessões na mesma pasta e que a pasta de um pedido do
// aplicativo só preenche o fluxo, sem abrir sessão sozinha.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const mocks = {
  native: `export const invoke = (cmd, args) => fixture.invoke(cmd, args); export const hasBridge = () => true; export const isTauri = () => false;`,
  shell: `export const isPhone = () => true; export const shellDesktopName = () => fixture.desktopName || '';`,
  runtime: `export const getRecent = () => fixture.recent || []; export const isDemo = () => false;
    export const getState = () => ({ sessions: fixture.sessions || [] });
    export const SESSION_COLORS = [{ id: 'verde', light: '#1f9d5b', dark: '#3ccf76' }];
    export const openSession = (...args) => { fixture.opened.push(args); return 'nova'; };
    export const launchAgentWhenReady = async (...args) => { fixture.launched.push(args); };`,
  files: `export const baseName = (p) => String(p).split('/').filter(Boolean).at(-1) || String(p);
    export const portablePath = (p) => String(p || '');
    export const shortPath = (p) => String(p).replace(/^\\/Users\\/ana/, '~');
    export const compactPath = (p) => String(p).replace(/^\\/Users\\/ana/, '~');`,
};

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/terminals/ui/NewSessionFlow.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
  plugins: [{ name: 'flow-boundaries', setup(api) {
    api.onResolve({ filter: /\.svg\?raw$/ }, ({ path }) => ({ path, namespace: 'glyph' }));
    api.onLoad({ filter: /.*/, namespace: 'glyph' }, () => ({ contents: 'export default "<svg></svg>";', loader: 'js' }));
    api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path }) => {
      const key = path.split('/').at(-1).replace(/\.jsx?$/, '');
      if (mocks[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
  } }],
});

function load(fixture = {}) {
  const full = { opened: [], launched: [], invoke: () => new Promise(() => {}), ...fixture };
  const context = vm.createContext({
    fixture: full, console, module: { exports: {} }, exports: {}, require: createRequire(import.meta.url),
    window: {}, document: { documentElement: { lang: 'pt-BR', dataset: {} } },
    localStorage: { getItem: () => null, setItem: () => {} }, setTimeout, clearTimeout,
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return { api: context.module.exports, fixture: full };
}
const render = (api, name, props = {}) => renderToStaticMarkup(React.createElement(api[name], props));
const noop = () => {};

const repos = {
  roots: [{ label: 'Projects', path: '/Users/ana/Projects', exists: true }],
  repos: [
    { name: 'psicoapp', path: '/Users/ana/Projects/psicoapp', root: 'Projects' },
    { name: 'frontend', path: '/Users/ana/Projects/frontend', root: 'Projects' },
  ],
};

test('a grade de projetos traz cada pasta uma vez e segue a busca', () => {
  const { api } = load();
  const names = (list) => [...list].map((item) => item.name);
  assert.deepEqual(names(api.projectItems(repos, '')), ['Projects', 'psicoapp', 'frontend']);
  assert.deepEqual(names(api.projectItems(repos, 'front')), ['frontend']);
  assert.equal(api.projectItems(null, '').length, 0);
});

test('o indicador mostra as três etapas, marca a atual e só volta para as feitas', () => {
  const { api } = load();
  assert.deepEqual([...api.FLOW_STEPS], ['project', 'agent', 'config']);
  const html = render(api, 'StepIndicator', { step: 1, onStep: noop });
  for (const name of ['Projeto', 'Agente', 'Configuração']) assert.match(html, new RegExp(name));
  assert.match(html, /is-done[^]*Etapa 1 de 3, Projeto/);
  assert.match(html, /aria-current="step"[^]*Etapa 2 de 3, Agente/);
  assert.match(html, /disabled=""[^>]*aria-label="Etapa 3 de 3, Configuração"/);
});

test('o cartão de pasta usa a ilustração no tom do projeto e marca a seleção', () => {
  const { api } = load();
  const item = { name: 'psicoapp', path: '/Users/ana/Projects/psicoapp' };
  const plain = render(api, 'ProjectCard', { item, selected: false, sessionCount: 0, onPick: noop });
  assert.match(plain, /phone-project-card__cover[^]*phone-folder-art phone-folder-art--(pink|blue|green|orange|violet)/);
  assert.match(plain, /aria-checked="false"/);
  assert.match(plain, /~\/Projects\/psicoapp/);
  const chosen = render(api, 'ProjectCard', { item, selected: true, sessionCount: 2, onPick: noop });
  assert.match(chosen, /is-selected/);
  assert.match(chosen, /phone-project-card__check/);
  assert.match(chosen, /2 sessões abertas/);
});

test('contas mostram limites, leitura velha e login pendente sem nunca bloquear', () => {
  const { api } = load();
  const usage = (fraction, kind = 'ok') => ({ headlineId: 'w', windows: [{ id: 'w', label: 'Semana', usedFraction: fraction }], fetchedAtMs: 1, status: { kind } });
  const cases = [
    [{ id: 'cheia', agent: 'codex', label: 'Cheia', plan: 'Plus', active: true, usage: usage(1) }, /100%/],
    [{ id: 'velha', agent: 'codex', label: 'Velha', usage: usage(0.4, 'stale') }, /Desatualizado/],
    [{ id: 'login', agent: 'codex', label: 'Login', needsLogin: true }, /pede o login no terminal/],
  ];
  for (const [profile, expected] of cases) {
    const html = render(api, 'AccountCard', { profile, selected: false, onPick: noop });
    assert.match(html, expected);
    assert.doesNotMatch(html, /disabled/);
  }
  const active = render(api, 'AccountCard', { profile: cases[0][0], selected: true, onPick: noop });
  assert.match(active, /Em uso/);
  assert.match(active, /Plus/);
  assert.match(active, /role="progressbar"/);
});

test('a configuração oferece nome, subtítulo e cor e resume o que vai abrir', () => {
  const { api } = load({ desktopName: 'Mac de Ana' });
  const html = render(api, 'ConfigStep', {
    path: '/Users/ana/Projects/psicoapp', agent: 'codex', agentName: 'Codex', account: { id: 'trabalho', label: 'Trabalho' },
    name: '', subtitle: '', color: null, onName: noop, onSubtitle: noop, onColor: noop, onStep: noop,
  });
  for (const text of ['Nome da sessão', 'Subtítulo da sessão', 'Cor da sessão', 'Mac de Ana', '~/Projects/psicoapp', 'Codex', 'Trabalho', 'Alterar Conta']) {
    assert.ok(html.includes(text), text);
  }
});

test('pasta vinda do aplicativo começa no agente e oferece continuar as sessões dela', () => {
  const sessions = [{ id: 's1', name: 'psicoapp', cwd: '/Users/ana/Projects/psicoapp' }, { id: 's2', name: 'outra', cwd: '/srv/outra' }];
  const { api, fixture } = load({ sessions });
  const html = render(api, 'default', { initialPath: '/Users/ana/Projects/psicoapp', onClose: noop, onOpen: noop });
  assert.match(html, /aria-current="step"[^]*Etapa 2 de 3, Agente/);
  assert.match(html, /Terminal padrão/);
  assert.match(html, /Este projeto já tem sessões/);
  assert.match(html, /Continuar psicoapp/);
  assert.doesNotMatch(html, /Continuar outra/);
  assert.equal(fixture.opened.length, 0, 'nada abre sem o toque final');
});

test('sem pasta o fluxo começa no projeto, com busca e navegação manual', () => {
  const { api } = load({ recent: ['/Users/ana/Projects/frontend'] });
  const html = render(api, 'default', { onClose: noop, onOpen: noop });
  assert.match(html, /aria-current="step"[^]*Etapa 1 de 3, Projeto/);
  assert.match(html, /Buscar projeto/);
  assert.match(html, /Recentes[^]*frontend/);
  assert.match(html, /Navegar pastas/);
  assert.match(html, /phone-flow__primary" disabled=""/);
});

test('o pedido do aplicativo e a criação seguem sem abrir nada sozinhos', () => {
  const read = (name) => readFileSync(fileURLToPath(new URL(`../src/terminals/ui/${name}`, import.meta.url)), 'utf8');
  const workbench = read('PhoneWorkbench.jsx');
  assert.doesNotMatch(workbench, /openSession\(intent\.cwd\)/);
  assert.match(workbench, /intent\.kind === 'new-session'\) setPicker\(\{ path:/);
  assert.match(workbench, /intent\.kind === 'pick-project'\) setPickProject\(true\)/);
  assert.match(workbench, /postProjectPicked\(path, baseName\(path\)\)/);
  const flow = read('NewSessionFlow.jsx');
  // O agente abre na conta escolhida sem trocar a conta ativa do computador.
  assert.match(flow, /launchAgentWhenReady\(id, agent, account\.id\)/);
  assert.doesNotMatch(flow, /agent_profile_select/);
});
