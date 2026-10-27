// SPDX-License-Identifier: Apache-2.0
// O provedor de link do terminal, com um buffer fiel de células ASCII no lugar
// do xterm. Prova o que a varredura pura não alcança: o range em célula e
// linha, a reconstrução de uma linha quebrada, o esticão por cima de espaços e
// o clique que abre o caminho resolvido. A validação de existência é feita
// contra arquivos de verdade no disco, não contra um mock que sempre diz sim,
// que foi o furo da 0.4.2: acento e espaço no nome não eram pegos.
//
// O buffer imita a API que o provedor usa: `buffer.active.getLine(i)` com
// `translateToString(trimRight)`, `isWrapped`, `length` e `getCell(i, cell)`, e
// `buffer.active.getNullCell()`. Cada caractere ocupa uma célula de largura 1,
// como no texto de um caminho; a borda de caractere largo é cópia literal do
// `WebLinkProvider` e fica para a conferência no app.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, mkdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { createPathLinkProvider } = await import('../src/terminals/path-link-provider.js');

// Quebra o texto lógico em linhas de `cols` células. A primeira não é
// continuação; as seguintes são, como o xterm marca uma linha que transbordou.
function fakeTerminal(logical, cols = 120) {
  const rows = [];
  for (let i = 0; i < logical.length; i += cols) rows.push(logical.slice(i, i + cols));
  if (!rows.length) rows.push('');
  const line = (text, wrapped) => ({
    isWrapped: wrapped,
    length: cols,
    translateToString: (trimRight) => (trimRight ? text.replace(/\s+$/, '') : text.padEnd(cols, ' ')),
    getCell: (i, cell) => { cell._ch = i < text.length ? text[i] : ''; cell._w = 1; },
  });
  const lines = rows.map((text, index) => line(text, index > 0));
  return {
    buffer: {
      active: {
        getLine: (index) => lines[index],
        getNullCell: () => ({ _ch: '', _w: 1, getChars() { return this._ch; }, getWidth() { return this._w; } }),
      },
    },
  };
}

// Chama provideLinks e devolve os links e o que o clique abriria. `exists`
// recebe o caminho absoluto; por padrão nada existe, cada teste informa o seu.
function provide(terminal, y, { context, exists = async () => false } = {}) {
  const opened = [];
  const provider = createPathLinkProvider({
    terminal,
    context: context || (() => ({ cwd: '/home/foco/rea', home: '/home/foco' })),
    exists,
    open: (path, location, event) => opened.push({ path, location, event }),
  });
  return new Promise((resolve) => {
    provider.provideLinks(y, (links) => resolve({ links: links || [], opened }));
  });
}

// Um `exists` que só diz sim para um conjunto de caminhos, como o disco faria.
const existsIn = (set) => async (abs) => set.has(abs);

test('um caminho numa linha vira link com o range certo e abre no clique', async () => {
  const terminal = fakeTerminal('abra /home/foco/a.txt agora');
  const { links, opened } = await provide(terminal, 1, { exists: existsIn(new Set(['/home/foco/a.txt'])) });
  assert.equal(links.length, 1);
  assert.equal(links[0].text, '/home/foco/a.txt');
  assert.deepEqual(links[0].range, { start: { x: 6, y: 1 }, end: { x: 21, y: 1 } });
  assert.deepEqual(links[0].decorations, { pointerCursor: true, underline: true });
  links[0].activate({ fake: true }, links[0].text);
  assert.equal(opened[0].path, '/home/foco/a.txt');
});

test('um caminho relativo resolve contra o diretorio vivo da sessao', async () => {
  const terminal = fakeTerminal('saiu temp/areas/position.csv pronto');
  const { links, opened } = await provide(terminal, 1, {
    context: () => ({ cwd: '/home/foco/rea', home: '/home/foco' }),
    exists: existsIn(new Set(['/home/foco/rea/temp/areas/position.csv'])),
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].text, 'temp/areas/position.csv');
  links[0].activate({}, links[0].text);
  assert.equal(opened[0].path, '/home/foco/rea/temp/areas/position.csv');
});

test('so o que existe no disco fica sublinhado', async () => {
  const terminal = fakeTerminal('veja temp/some/that/none.csv aqui');
  const { links } = await provide(terminal, 1, { exists: async () => false });
  assert.equal(links.length, 0);
});

test('sem diretorio vivo, um caminho relativo nao vira link', async () => {
  const terminal = fakeTerminal('saiu temp/areas/position.csv pronto');
  const { links } = await provide(terminal, 1, {
    context: () => ({ cwd: null, home: '/home/foco' }),
    exists: existsIn(new Set(['/home/foco/rea/temp/areas/position.csv'])),
  });
  assert.equal(links.length, 0);
});

test('um caminho que transborda a largura mapeia nas duas linhas', async () => {
  const path = '/home/foco/rea/temp/virtual-areas-gt-15420/position_virtual_area.csv';
  const terminal = fakeTerminal(path, 40);
  const { links } = await provide(terminal, 1, { exists: existsIn(new Set([path])) });
  assert.equal(links.length, 1);
  assert.equal(links[0].text, path);
  assert.equal(links[0].range.start.y, 1);
  assert.equal(links[0].range.end.y, 2);
});

test('le a linha e a coluna do sufixo e leva no clique', async () => {
  const terminal = fakeTerminal('erro em src/app.js:12:4 aqui');
  const { links, opened } = await provide(terminal, 1, {
    context: () => ({ cwd: '/w', home: '/home/foco' }),
    exists: existsIn(new Set(['/w/src/app.js'])),
  });
  assert.equal(links.length, 1);
  assert.equal(links[0].text, 'src/app.js');
  links[0].activate({}, links[0].text);
  assert.deepEqual([opened[0].location.line, opened[0].location.column], [12, 4]);
});

test('nome acentuado sem espaco vira link inteiro', async () => {
  const terminal = fakeTerminal('gerei Relatório-Final.csv na pasta');
  const { links } = await provide(terminal, 1, {
    context: () => ({ cwd: '/dados', home: '/home/foco' }),
    exists: existsIn(new Set(['/dados/Relatório-Final.csv'])),
  });
  assert.equal(links.length, 1, 'o acento nao pode cortar o token');
  assert.equal(links[0].text, 'Relatório-Final.csv');
});

test('nome com espaco e acento vira link pelo esticao, e so o arquivo real', async () => {
  const nome = 'WebRota – Apresentação – Desafio Logística.pptx';
  const terminal = fakeTerminal(`– ${nome}: editável, e pode ser importado`);
  const { links, opened } = await provide(terminal, 1, {
    context: () => ({ cwd: '/Users/foco/SILEMG', home: '/home/foco' }),
    exists: existsIn(new Set([`/Users/foco/SILEMG/${nome}`])),
  });
  assert.equal(links.length, 1, 'o nome com espaco precisa virar um link so');
  assert.equal(links[0].text, nome);
  links[0].activate({}, links[0].text);
  assert.equal(opened[0].path, `/Users/foco/SILEMG/${nome}`);
});

test('contra arquivos de verdade no disco, com acento e espaco no nome', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cialai-links-'));
  try {
    const comEspaco = 'WebRota – Apresentação – Desafio Logística.pptx';
    writeFileSync(join(dir, comEspaco), 'x');
    const acentuado = 'Relatório-Final.csv';
    writeFileSync(join(dir, acentuado), 'x');
    mkdirSync(join(dir, 'temp', 'áreas-15420'), { recursive: true });
    const relativo = 'temp/áreas-15420/posição.csv';
    writeFileSync(join(dir, relativo), 'x');

    const realExists = async (abs) => { try { return statSync(abs).isFile(); } catch { return false; } };
    const context = () => ({ cwd: dir, home: '/home/foco' });

    const spaced = await provide(fakeTerminal(`– ${comEspaco}: editável`), 1, { context, exists: realExists });
    assert.equal(spaced.links.length, 1);
    assert.equal(spaced.links[0].text, comEspaco);
    assert.equal(spaced.opened.length, 0);
    spaced.links[0].activate({}, spaced.links[0].text);
    assert.equal(spaced.opened[0].path, join(dir, comEspaco).replace(/\\/g, '/'));

    const accented = await provide(fakeTerminal(`gerei ${acentuado} agora`), 1, { context, exists: realExists });
    assert.equal(accented.links.length, 1);
    assert.equal(accented.links[0].text, acentuado);

    const rel = await provide(fakeTerminal(`saiu ${relativo} pronto`), 1, { context, exists: realExists });
    assert.equal(rel.links.length, 1);
    assert.equal(rel.links[0].text, relativo);

    const ausente = await provide(fakeTerminal('veja temp/não/existe.csv aqui'), 1, { context, exists: realExists });
    assert.equal(ausente.links.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
