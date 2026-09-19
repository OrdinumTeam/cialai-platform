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

const LIST = [
  { id: 'claude', agent: 'claude', label: 'claude', plan: 'max', isDefault: true, active: false, needsLogin: false, windows: [{ id: 'session', label: 'Sessão', usedPercent: 41 }] },
  { id: 'claude-webrota', agent: 'claude', label: 'webrota', plan: 'max', isDefault: false, active: true, needsLogin: false, windows: [{ id: 'session', label: 'Sessão', usedPercent: 92 }] },
  { id: 'codex-nova', agent: 'codex', label: 'nova', plan: null, isDefault: false, active: false, needsLogin: true, windows: [] },
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
  assert.equal(groups[1].profiles.length, 1);
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
  // O uso de cada conta usa o mesmo tom do card.
  const text = source('../src/terminals/ui/AgentProfiles.jsx');
  assert.match(text, /planTone\(window\.usedPercent\)/);
  assert.match(text, /terminal\.profiles\.needsLogin/, 'conta sem credencial aparece como aguardando login');
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
