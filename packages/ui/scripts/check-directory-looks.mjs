// SPDX-License-Identifier: Apache-2.0
// Cor e icone lembrados por pasta: a chave da pasta, a gravacao, o teto e a
// precedencia da escolha explicita sobre a memoria.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOOK_LIMIT, STORAGE_KEY, lookKey, recallLook, rememberLook } from '../src/terminals/directory-looks.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    data,
  };
}

const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('a chave da pasta ignora barra no fim e, no Windows, maiusculas', () => {
  assert.equal(lookKey('/Users/ana/projeto/', 'macos'), '/Users/ana/projeto');
  assert.equal(lookKey('/Users/ana/projeto', 'macos'), '/Users/ana/projeto');
  assert.notEqual(lookKey('/Users/Ana/Projeto', 'linux'), lookKey('/users/ana/projeto', 'linux'), 'fora do Windows maiusculas contam');
  assert.equal(lookKey('C:\\Users\\Ana\\Projeto\\', 'windows'), 'c:/users/ana/projeto');
  assert.equal(lookKey('c:/users/ana/projeto', 'windows'), lookKey('C:/Users/Ana/Projeto', 'windows'));
  assert.equal(lookKey('\\\\?\\C:\\obra', 'windows'), 'c:/obra', 'o prefixo estendido some');
  assert.equal(lookKey('/', 'linux'), '/', 'a raiz continua sendo a raiz');
  assert.equal(lookKey('C:/', 'windows'), 'c:/');
  assert.equal(lookKey('//servidor/pasta/', 'windows'), '//servidor/pasta/', 'a raiz do compartilhamento fica inteira');
  assert.equal(lookKey('', 'macos'), '');
});

test('a pasta lembra a ultima escolha e o padrao a esquece', () => {
  const storage = memoryStorage();
  assert.equal(recallLook(storage, '/obra'), null, 'pasta nunca escolhida nao tem memoria');
  rememberLook(storage, '/obra', { color: 'azul', icon: 'globe' }, 1);
  assert.deepEqual(recallLook(storage, '/obra', 2), { color: 'azul', icon: 'globe' });
  rememberLook(storage, '/obra', { color: null, icon: 'globe' }, 3);
  assert.deepEqual(recallLook(storage, '/obra', 4), { color: null, icon: 'globe' }, 'so o icone tambem vale');
  rememberLook(storage, '/obra', { color: null, icon: null }, 5);
  assert.equal(recallLook(storage, '/obra', 6), null, 'voltar ao padrao esquece a pasta');
  assert.equal(JSON.parse(storage.data.get(STORAGE_KEY)).folders['/obra'], undefined);
});

test('acima do teto sai a pasta usada ha mais tempo, e reabrir conta como uso', () => {
  const storage = memoryStorage();
  for (let index = 0; index < LOOK_LIMIT; index += 1) rememberLook(storage, `/p${index}`, { color: 'lima' }, index + 1);
  recallLook(storage, '/p0', LOOK_LIMIT + 1);
  rememberLook(storage, '/nova', { color: 'rosa' }, LOOK_LIMIT + 2);
  const folders = JSON.parse(storage.data.get(STORAGE_KEY)).folders;
  assert.equal(Object.keys(folders).length, LOOK_LIMIT);
  assert.ok(folders['/p0'], 'a pasta reaberta ficou');
  assert.equal(folders['/p1'], undefined, 'saiu a menos usada');
  assert.ok(folders['/nova']);
});

test('armazenamento estragado ou ausente nao derruba nada', () => {
  const broken = memoryStorage();
  broken.setItem(STORAGE_KEY, '{nao e json');
  assert.equal(recallLook(broken, '/obra'), null);
  assert.equal(rememberLook(broken, '/obra', { color: 'azul' }), true);
  assert.deepEqual(recallLook(broken, '/obra'), { color: 'azul', icon: null });
  const failing = { getItem: () => { throw new Error('sem storage'); }, setItem: () => { throw new Error('sem storage'); } };
  assert.equal(recallLook(failing, '/obra'), null);
  assert.equal(rememberLook(failing, '/obra', { color: 'azul' }), false);
});

test('a sessao nova herda a memoria so quando ninguem escolheu', () => {
  const runtime = source('../src/terminals/runtime.js');
  const open = runtime.slice(runtime.indexOf('export function openSession('), runtime.indexOf('const LAUNCH_WAIT_MS'));
  assert.match(open, /const chosen = color !== undefined \|\| icon !== undefined/, 'ausente e diferente de null');
  assert.match(open, /recallDirectoryLook\(cwd\)/);
  assert.match(open, /if \(chosen\) rememberDirectoryLook\(session\)/);
  // Restaurar sessoes salvas e adotar terminais vivos passa por createSession,
  // que nao pode consultar a memoria nem gravar nela.
  const create = runtime.slice(runtime.indexOf('function createSession('), runtime.indexOf('const session = {', runtime.indexOf('function createSession(')) + 400);
  assert.doesNotMatch(create, /DirectoryLook/);
  for (const setter of ['export function setSessionColor', 'export function setSessionIcon']) {
    const body = runtime.slice(runtime.indexOf(setter), runtime.indexOf('}\n', runtime.indexOf(setter)));
    assert.match(body, /rememberDirectoryLook\(session\)/, `${setter} grava a escolha na pasta`);
  }
  const sync = runtime.slice(runtime.indexOf('async function syncSharedSessions'), runtime.indexOf('export function hydrate'));
  assert.doesNotMatch(sync, /rememberDirectoryLook/, 'adotar a apresentacao do Rust nao grava');
  assert.match(runtime, /if \(state\.demo \|\| session\.deviceId\) return;/, 'demonstracao e Broto ficam de fora');
});

test('popover e fluxo do celular so mandam cor e icone quando a pessoa mexeu', () => {
  const popover = source('../src/terminals/ui/NewSessionPopover.jsx');
  assert.match(popover, /const chosen = customize && look\.touched \?/);
  assert.match(popover, /touched: true, color/);
  assert.match(popover, /touched: true, icon/);
  const flow = source('../src/terminals/ui/NewSessionFlow.jsx');
  assert.match(flow, /openSession\(path, lookTouched \? \{ name, subtitle, color, icon \} : \{ name, subtitle \}\)/);
});
