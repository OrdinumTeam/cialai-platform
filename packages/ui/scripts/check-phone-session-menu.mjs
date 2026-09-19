// SPDX-License-Identifier: Apache-2.0
// Menu de ações de terminal no celular: os itens e os manipuladores. O card no
// modo toque desligava todo caminho para essas ações; aqui elas voltam pelo
// botão de três pontos e pelo toque longo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mocks = {
  runtime: `export const SESSION_COLORS=[{id:'azul',light:'#1a4fa0',dark:'#4a8ae6'},{id:'verde',light:'#1f9d5b',dark:'#3ccf76'}];
    export const canMoveSession=(id,delta)=>fixture.canMove(id,delta);`,
  dialogs: `export const Sheet=()=>null;`,
  ui: `export const useToast=()=>()=>{};`,
};

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/terminals/ui/PhoneSessionMenu.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
  plugins: [{ name: 'menu-boundaries', setup(api) {
    api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path }) => {
      const key = path.split('/').at(-1).replace(/\.jsx?$/, '');
      if (mocks[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
  } }],
});

function load({ canMove = () => true } = {}) {
  const context = vm.createContext({
    fixture: { canMove }, console,
    module: { exports: {} }, exports: {}, require: createRequire(import.meta.url),
    window: { innerHeight: 852 }, document: { documentElement: { lang: 'pt-BR', dataset: {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return context.module.exports;
}

const session = { id: 's1', name: 'Projeto', subtitle: '', pinned: false, status: 'running', cwd: '/fixture/projeto' };

test('o menu traz as dez ações do computador que fazem sentido no celular', () => {
  const { menuItems } = load();
  const kinds = [...menuItems(session).map((item) => item.kind)];
  assert.deepEqual(kinds, [
    'rename', 'subtitle', 'color', 'pin', 'up', 'down', 'clone', 'launch', 'directory', 'copy', 'restart', 'close',
  ]);
  // O que só existe no computador fica de fora.
  for (const absent of ['browser', 'browser-stop', 'finder']) {
    assert.ok(!kinds.includes(absent), `${absent} não pode aparecer no celular`);
  }
});

test('mover para cima e para baixo desabilitam nos extremos da lista', () => {
  const { menuItems } = load({ canMove: (_id, delta) => delta > 0 });
  const items = Object.fromEntries(menuItems(session).map((item) => [item.kind, item]));
  assert.equal(items.up.disabled, true, 'a primeira sessão não sobe');
  assert.equal(items.down.disabled, false);
});

test('trocar a pasta exige sessão viva, porque a ação encerra o processo', () => {
  const { menuItems } = load();
  const running = Object.fromEntries(menuItems(session).map((item) => [item.kind, item]));
  assert.equal(running.directory.disabled, false);
  const dead = Object.fromEntries(menuItems({ ...session, status: 'exited' }).map((item) => [item.kind, item]));
  assert.equal(dead.directory.disabled, true);
});

test('os rótulos acompanham o estado da sessão', () => {
  const { menuItems } = load();
  const label = (list, kind) => list.find((item) => item.kind === kind).label;
  assert.equal(label(menuItems(session), 'pin'), 'Fixar no topo');
  assert.equal(label(menuItems({ ...session, pinned: true }), 'pin'), 'Desafixar do topo');
  assert.equal(label(menuItems(session), 'subtitle'), 'Definir subtítulo…');
  assert.equal(label(menuItems({ ...session, subtitle: 'Plantão' }), 'subtitle'), 'Editar subtítulo…');
  assert.equal(menuItems(null).length, 0);
});

test('cada ação do menu tem manipulador na tela do celular', () => {
  const { menuItems } = load();
  const workbench = source('../src/terminals/ui/PhoneWorkbench.jsx');
  const action = workbench.slice(workbench.indexOf('async function runSessionAction'), workbench.indexOf('async function endSession'));
  for (const item of menuItems(session)) {
    assert.match(action, new RegExp(`kind === '${item.kind}'`), `ação sem manipulador: ${item.kind}`);
  }
  // Renomear e subtítulo passam pelo diálogo de nome, não tocam no processo.
  assert.match(action, /setNameRequest\(\{ kind: 'rename'/);
  assert.match(action, /setNameRequest\(\{ kind: 'subtitle'/);
  assert.doesNotMatch(action.slice(0, action.indexOf("kind === 'color'")), /restart|closeSession|pty_kill/);
  // Abrir outra sessão na mesma pasta usa o cwd da sessão, e a existente segue.
  assert.match(action, /kind === 'clone'.*openSession\(session\.cwd\)/);
});

test('o card no toque abre o menu pelo botão de três pontos e pelo toque longo', () => {
  const card = source('../src/terminals/ui/SessionCard.jsx');
  assert.match(card, /const LONG_PRESS_MS = 500;/);
  assert.match(card, /onPointerDown=\{touch && onMenu \?/);
  for (const cancel of ['onPointerMove', 'onPointerUp', 'onPointerCancel']) {
    assert.match(card, new RegExp(`${cancel}=\\{touch && onMenu \\? cancelLongPress`), `${cancel} precisa cancelar o toque longo`);
  }
  // O botão existe nos dois modos; no toque ele abre a folha em vez do menu
  // ancorado, que não tem onde ancorar num aparelho.
  assert.match(card, /if \(touch\) \{ onMenu\(session, \{ touch: true \}\); return; \}/);
  assert.doesNotMatch(card, /\{!touch && <button/);
});
