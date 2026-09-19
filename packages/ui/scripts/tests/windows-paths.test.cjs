// SPDX-License-Identifier: Apache-2.0
// Caminhos do Windows na interface. O contrato de
// docs/arquitetura/14-diferencas-por-plataforma.md diz que todo caminho que
// chega à interface usa barra normal. Metade do código cumpria e metade não, e
// as comparações de igualdade falhavam: o explorador trocava de raiz sem
// parar, a árvore não expandia, a seta para a esquerda não achava o pai e a
// faixa Terminal em nunca sumia.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/lib/paths.js');

const lower = (value) => value.toLowerCase();

test('a forma portatil aceita barra invertida, UNC e prefixo estendido', async () => {
  const { portablePath } = await load();
  assert.equal(portablePath('C:\\Users\\ana\\Documents'), 'C:/Users/ana/Documents');
  assert.equal(portablePath('\\\\?\\C:\\Users\\ana'), 'C:/Users/ana');
  assert.equal(portablePath('\\\\?\\UNC\\servidor\\publico\\ana'), '//servidor/publico/ana');
  assert.equal(portablePath('/Users/ana'), '/Users/ana', 'um caminho Unix passa intacto');
  assert.equal(portablePath(null), '');
});

test('a raiz de unidade, a de compartilhamento e a do Unix sao reconhecidas', async () => {
  const { pathRoot, isAbsolutePath } = await load();
  assert.equal(pathRoot('C:/Users/ana'), 'C:/');
  assert.equal(pathRoot('C:\\'), 'C:/');
  assert.equal(pathRoot('C:'), 'C:/');
  assert.equal(pathRoot('//servidor/publico/ana'), '//servidor/publico/');
  assert.equal(pathRoot('/Users/ana'), '/');
  assert.equal(pathRoot('pasta/arquivo.txt'), '', 'caminho relativo nao tem raiz');
  for (const absolute of ['C:\\Users\\ana', 'C:/', '//servidor/publico', '/Users/ana']) {
    assert.equal(isAbsolutePath(absolute), true, `${absolute} e absoluto`);
  }
  assert.equal(isAbsolutePath('Users/ana'), false);
  assert.equal(isAbsolutePath(''), false);
});

test('a pasta acima sobe ate a raiz da unidade e para ali', async () => {
  const { dirName } = await load();
  assert.equal(dirName('C:/Users/ana/Documents'), 'C:/Users/ana');
  assert.equal(dirName('C:/Users/ana'), 'C:/Users');
  // Antes disto `C:/Users` devolvia `C:`, e o Rust recusava por nao ser
  // absoluto; `C:/` devolvia `/`, que nao existe no Windows.
  assert.equal(dirName('C:/Users'), 'C:/');
  assert.equal(dirName('C:/'), null, 'a raiz da unidade nao tem pai');
  assert.equal(dirName('C:'), null);
  assert.equal(dirName('//servidor/publico/ana'), '//servidor/publico/');
  assert.equal(dirName('//servidor/publico'), null, 'a raiz do compartilhamento nao tem pai');
  assert.equal(dirName('/Users/ana'), '/Users');
  assert.equal(dirName('/Users'), '/');
  assert.equal(dirName('/'), null);
  assert.equal(dirName('pasta/arquivo.txt'), 'pasta');
  assert.equal(dirName('arquivo.txt'), '/', 'caminho relativo sem pasta continua como antes');
});

test('juntar com a raiz nao duplica a barra', async () => {
  const { joinPath } = await load();
  assert.equal(joinPath('C:/', 'Users'), 'C:/Users');
  assert.equal(joinPath('C:\\Users\\ana', 'nota.md'), 'C:/Users/ana/nota.md');
  assert.equal(joinPath('/', 'Users'), '/Users');
  assert.equal(joinPath('/Users/ana/', 'nota.md'), '/Users/ana/nota.md');
});

test('estar dentro da raiz nao pode depender de maiusculas no Windows', async () => {
  const { isInsideWith } = await load();
  assert.equal(isInsideWith('C:/Users/ana', 'C:/Users/ana/Documents'), true);
  assert.equal(isInsideWith('C:/Users/ana', 'C:\\Users\\ana\\Documents'), true, 'a forma portatil e aplicada dos dois lados');
  assert.equal(isInsideWith('C:/Users/Ana', 'c:/users/ana/Documents'), false, 'sem dobra continua diferenciando');
  assert.equal(isInsideWith('C:/Users/Ana', 'c:/users/ana/Documents', lower), true);
  assert.equal(isInsideWith('C:/Users/ana', 'C:/Users/anabela'), false, 'prefixo de nome nao e pasta dentro');
});
