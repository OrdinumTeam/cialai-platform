// SPDX-License-Identifier: Apache-2.0
// Tela de contas dos agentes, com uma ponte falsa. O cliente só manda o id do
// perfil; caminho de credencial e chave de conta nunca aparecem aqui.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mocks = {
  native: `export const invoke = (cmd, args) => fixture.invoke(cmd, args); export const isTauri = () => false;`,
  SessionCard: `export const planTone = (percent) => (percent >= 90 ? 'bad' : percent >= 75 ? 'warn' : 'ok');`,
  files: `export const fmtPlan = (value) => \`\${Math.round(value)}%\`;`,
};

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/terminals/ui/AgentProfiles.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
  plugins: [{ name: 'profiles-boundaries', setup(api) {
    api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path }) => {
      const key = path.split('/').at(-1).replace(/\.jsx?$/, '');
      if (mocks[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
  } }],
});

// A leitura de uso chega no formato da loja da Barra de IA, igual para os
// dois provedores: janelas com rótulo, janela do anel declarada, estado e
// instante da leitura.
const reading = (over = {}) => ({
  id: 'x', provider: 'claude', label: 'x', configDir: '', fidelity: 'official',
  status: { kind: 'ok' }, windows: [], headlineId: null, weeklyId: null,
  fetchedAtMs: 1_700_000_000_000, source: 'cli', ...over,
});

const LIST = [
  {
    id: 'claude',
    agent: 'claude',
    label: 'claude',
    plan: 'max',
    isDefault: true,
    active: false,
    needsLogin: false,
    usage: reading({
      id: 'claude',
      plan: 'max',
      headlineId: 'session',
      weeklyId: 'weekly_all',
      windows: [
        { id: 'session', label: 'session', usedFraction: 0.41 },
        { id: 'weekly_all', label: 'weeklyAll', usedFraction: 0.12 },
      ],
    }),
  },
  {
    id: 'claude-webrota',
    agent: 'claude',
    label: 'webrota',
    plan: 'max',
    isDefault: false,
    active: true,
    needsLogin: false,
    usage: reading({ id: 'claude-webrota', plan: 'max', headlineId: 'session', windows: [{ id: 'session', label: 'session', usedFraction: 0.92 }] }),
  },
  {
    id: 'codex-nova',
    agent: 'codex',
    label: 'nova',
    plan: null,
    isDefault: false,
    active: false,
    needsLogin: true,
    usage: reading({ id: 'codex-nova', provider: 'codex', status: { kind: 'needsAuth' }, fetchedAtMs: 0 }),
  },
  {
    id: 'codex-erro',
    agent: 'codex',
    label: 'erro',
    plan: 'plus',
    isDefault: false,
    active: false,
    needsLogin: false,
    usage: reading({ id: 'codex-erro', provider: 'codex', status: { kind: 'error', message: 'http', detail: '500' }, windows: [] }),
  },
  {
    id: 'codex-velho',
    agent: 'codex',
    label: 'velho',
    plan: 'pro',
    isDefault: false,
    active: false,
    needsLogin: false,
    usage: reading({ id: 'codex-velho', provider: 'codex', status: { kind: 'stale', sinceMs: 1 }, headlineId: 'primary', windows: [{ id: 'primary', label: 'session', usedFraction: 0.5 }] }),
  },
];

function load() {
  const calls = [];
  const context = vm.createContext({
    fixture: { calls, invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve(LIST); } },
    console, module: { exports: {} }, exports: {}, require: createRequire(import.meta.url),
    window: {}, document: { documentElement: { lang: 'pt-BR', dataset: {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return { api: context.module.exports, calls };
}

test('as contas são agrupadas por agente, na ordem que o computador devolveu', () => {
  const { api } = load();
  const groups = api.groupProfiles(LIST);
  assert.deepEqual([...groups.map((group) => group.id)], ['claude', 'codex']);
  assert.deepEqual([...groups[0].profiles.map((profile) => profile.id)], ['claude', 'claude-webrota']);
  assert.equal(groups[1].profiles.length, 3);
  // Agente sem conta nenhuma não vira seção vazia.
  assert.equal(api.groupProfiles([]).length, 0);
  assert.deepEqual([...api.AGENTS], ['claude', 'codex']);
});

test('a tela avisa que a troca vale só para sessões novas', () => {
  const { api } = load();
  const html = renderToStaticMarkup(React.createElement(api.default, {}));
  assert.match(html, /A troca vale para sessões novas/);
  assert.match(html, /continua na conta em que começou/);
});

test('nenhum caminho de credencial nem chave de conta aparece na tela', () => {
  // Os comentários explicam o que a tela não faz; a busca é no código.
  const text = source('../src/terminals/ui/AgentProfiles.jsx').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['accountKey', 'auth.json', 'configDir', 'config_dir', '.credentials']) {
    assert.ok(!text.includes(forbidden), `${forbidden} não pode estar na tela`);
  }
  // O cliente manda o id do perfil e mais nada.
  assert.match(text, /invoke\('agent_profile_select', \{ agent: profile\.agent, id: profile\.id \}\)/);
  assert.doesNotMatch(text, /CLAUDE_CONFIG_DIR|CODEX_HOME/, 'o cliente nunca envia variável de ambiente');
});

test('a conta em uso é marcada e as outras oferecem a troca', () => {
  const { api } = load();
  const groups = api.groupProfiles(LIST);
  const active = groups[0].profiles.filter((profile) => profile.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'claude-webrota');
  const text = source('../src/terminals/ui/AgentProfiles.jsx');
  assert.match(text, /terminal\.profiles\.needsLogin/, 'conta sem credencial aparece como aguardando login');
  // O rótulo do botão é curto; a explicação do efeito fica uma vez só no topo.
  assert.match(text, /terminal\.profiles\.use'/);
  assert.match(text, /terminal\.profiles\.runningStays/);
});

test('o tom do número segue as mesmas faixas em qualquer provedor', () => {
  const { api } = load();
  assert.equal(api.usageTone(0.41), 'ok');
  assert.equal(api.usageTone(0.8), 'warn');
  assert.equal(api.usageTone(0.95), 'bad');
  // Sem leitura não há tom, e muito menos zero por cento.
  assert.equal(api.usageTone(null), 'none');
  assert.equal(api.usageTone(undefined), 'none');
});

test('a janela do anel é a declarada pelo provedor, e a semanal não repete a do anel', () => {
  const { api } = load();
  assert.equal(api.headlineWindow(LIST[0].usage).id, 'session');
  assert.equal(api.weeklyWindow(LIST[0].usage).id, 'weekly_all');
  // Sem janela declarada, nada é promovido ao lugar dela.
  assert.equal(api.headlineWindow({ windows: [{ id: 'session', usedFraction: 0.5 }] }), null);
  assert.equal(api.weeklyWindow({ headlineId: 'session', weeklyId: 'session', windows: [] }), null);
});

test('cada estado de leitura tem nome próprio, e nenhum deles é zero por cento', () => {
  const { api } = load();
  assert.equal(api.readingState(LIST[0]), 'ok');
  assert.equal(api.readingState(LIST[2]), 'needsLogin');
  assert.equal(api.readingState(LIST[3]), 'error');
  assert.equal(api.readingState(LIST[4]), 'stale');
  assert.equal(api.readingState({ usage: { status: { kind: 'unsupported' }, windows: [] } }), 'unmetered');
  assert.equal(api.readingState({ usage: { status: { kind: 'ok' }, windows: [], fetchedAtMs: 0 } }), 'reading');
  assert.equal(api.readingState({}), 'unavailable');
});

test('Claude Code e Codex mostram plano e percentual pelo mesmo caminho', () => {
  const { api } = load();
  const html = renderToStaticMarkup(React.createElement(api.default, {}));
  // Sem dados ainda: a primeira pintura diz que está lendo, não zero.
  assert.match(html, /Lendo as contas/);
  assert.doesNotMatch(html, /0%/);
  const text = source('../src/terminals/ui/AgentProfiles.jsx');
  // O mesmo componente desenha os dois provedores: nada é condicionado ao
  // nome do agente na hora de mostrar plano ou número.
  assert.doesNotMatch(text.replace(/^\s*\/\/.*$/gm, ''), /agent === 'claude'|agent === 'codex'/);
  assert.match(text, /windowLabel\(headline\)/, 'o percentual vem com o nome da janela');
});

test('a lista relê o uso antes de buscar as contas de novo', () => {
  const text = source('../src/terminals/ui/AgentProfiles.jsx');
  assert.match(text, /invoke\('agent_profiles_refresh'\)/);
});

test('o item de menu que abre o agente numa conta existe nos dois lados e respeita o primeiro plano', () => {
  const bench = source('../src/terminals/ui/Workbench.jsx');
  assert.match(bench, /id: 'launch'/);
  assert.match(bench, /disabled: session\.status !== 'running' \|\| Boolean\(session\.activity\?\.foreground\)/);
  assert.match(bench, /terminal\.profiles\.launchBusy/);
  const menu = source('../src/terminals/ui/PhoneSessionMenu.jsx');
  assert.match(menu, /kind: 'launch'/);
  assert.match(menu, /disabled: !running \|\| Boolean\(session\.activity\?\.foreground\)/);
});
