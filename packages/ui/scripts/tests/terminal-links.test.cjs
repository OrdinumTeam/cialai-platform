// SPDX-License-Identifier: Apache-2.0
// Varredura pura de caminhos na saida do terminal e a resolucao para absoluto.
// Sem xterm nem disco: so o texto de uma linha vira candidatos, e um candidato
// mais o diretorio vivo viram um caminho. A existencia no disco e a conta de
// celula ficam no provedor, testados a parte com o xterm de verdade.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const links = () => import('../../src/terminals/terminal-links.js');
const paths = () => import('../../src/lib/paths.js');

function at(found, path) {
  return found.find((item) => item.path === path) || null;
}

test('acha caminho relativo, absoluto, com ~ e do Windows', async () => {
  const { findPathLinks } = await links();
  const found = findPathLinks('veja temp/areas-15420/position_virtual_area.csv e /etc/hosts e ~/notas.md e C:\\Users\\foco\\a.txt');
  assert.ok(at(found, 'temp/areas-15420/position_virtual_area.csv'));
  assert.ok(at(found, '/etc/hosts'));
  assert.ok(at(found, '~/notas.md'));
  assert.ok(at(found, 'C:\\Users\\foco\\a.txt'));
});

test('le a linha e a coluna nos sufixos conhecidos', async () => {
  const { findPathLinks } = await links();
  const colon = at(await findPathLinks('erro em src/app.js:10:5 aqui'), 'src/app.js');
  assert.deepEqual([colon.line, colon.column], [10, 5]);

  const onlyLine = at(await findPathLinks('erro em src/app.js:42 aqui'), 'src/app.js');
  assert.deepEqual([onlyLine.line, onlyLine.column], [42, null]);

  const paren = at(await findPathLinks('em Componente.tsx(45,2) ali'), 'Componente.tsx');
  assert.deepEqual([paren.line, paren.column], [45, 2]);
});

test('entende o traceback do Python entre aspas, com line N', async () => {
  const { findPathLinks } = await links();
  const found = findPathLinks('  File "/home/foco/rea/run.py", line 42, in main');
  const hit = at(found, '/home/foco/rea/run.py');
  assert.ok(hit);
  assert.equal(hit.line, 42);
});

test('nao marca palavra solta, numero ou versao', async () => {
  const { findPathLinks } = await links();
  assert.equal(findPathLinks('apenas uma frase comum aqui').length, 0);
  assert.equal(findPathLinks('o teto subiu para 1.5 vezes').length, 0);
  assert.equal(findPathLinks('saiu a versao 0.4.1 hoje').length, 0);
});

test('pega o caminho entre parenteses, como a saida da REA', async () => {
  const { findPathLinks } = await links();
  const text = 'position_virtual_area.csv (temp/virtual-areas-gt-15420-20261026T210842Z/position_virtual_area.csv) com 177602 vinculos';
  const found = findPathLinks(text);
  const inside = at(found, 'temp/virtual-areas-gt-15420-20261026T210842Z/position_virtual_area.csv');
  assert.ok(inside, 'o caminho dentro dos parenteses vira candidato');
});

test('trechos nao se sobrepoem e o limite e respeitado', async () => {
  const { findPathLinks } = await links();
  const found = findPathLinks('a/b.js c/d.js e/f.js', 2);
  assert.equal(found.length, 2);
  for (let i = 1; i < found.length; i += 1) {
    assert.ok(found[i].index >= found[i - 1].index + found[i - 1].length);
  }
});

test('resolve absoluto, relativo, ~ e Windows contra o diretorio vivo', async () => {
  const { resolveLinkPath } = await links();
  const { joinPath, isAbsolutePath, portablePath } = await paths();
  const bag = { join: joinPath, isAbsolute: isAbsolutePath, portable: portablePath };

  assert.equal(resolveLinkPath('/etc/hosts', { cwd: '/home/foco/rea', home: '/home/foco', ...bag }), '/etc/hosts');
  assert.equal(resolveLinkPath('temp/x.csv', { cwd: '/home/foco/rea', home: '/home/foco', ...bag }), '/home/foco/rea/temp/x.csv');
  assert.equal(resolveLinkPath('~/notas.md', { cwd: '/qualquer', home: '/home/foco', ...bag }), '/home/foco/notas.md');
  assert.equal(resolveLinkPath('C:\\Users\\foco\\a.txt', { cwd: 'C:/trab', home: 'C:/Users/foco', ...bag }), 'C:/Users/foco/a.txt');
});

test('sem diretorio vivo, um caminho relativo nao resolve', async () => {
  const { resolveLinkPath } = await links();
  const { joinPath, isAbsolutePath, portablePath } = await paths();
  const out = resolveLinkPath('temp/x.csv', { cwd: null, home: '/home/foco', join: joinPath, isAbsolute: isAbsolutePath, portable: portablePath });
  assert.equal(out, null);
});
