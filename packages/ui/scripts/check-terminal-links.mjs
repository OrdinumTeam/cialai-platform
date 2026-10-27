// SPDX-License-Identifier: Apache-2.0
// O provedor de link do terminal, com um buffer fiel de células ASCII no lugar
// do xterm. Prova o que a varredura pura não alcança: o range em célula e
// linha, a reconstrução de uma linha quebrada, o filtro pela existência no
// disco e o clique que abre o caminho resolvido. A paridade com o xterm de
// verdade é conferida no app em dev, onde o terminal é o mesmo do produto.
//
// O buffer imita a API que o provedor usa: `buffer.active.getLine(i)` com
// `translateToString(trimRight)`, `isWrapped`, `length` e `getCell(i, cell)`, e
// `buffer.getNullCell()`. Cada caractere ocupa uma célula de largura 1, como no
// texto ASCII de um caminho; a borda de caractere largo é cópia literal do
// `WebLinkProvider` e fica para a conferência no app.

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { createPathLinkProvider } = await import('../src/terminals/path-link-provider.js');

// Quebra o texto lógico em linhas de `cols` células. A primeira não é
// continuação; as seguintes são, como o xterm marca uma linha que transbordou.
function fakeTerminal(logical, cols = 80) {
  const rows = [];
  for (let i = 0; i < logical.length; i += cols) rows.push(logical.slice(i, i + cols));
  if (!rows.length) rows.push('');
  const line = (text, wrapped) => ({
    isWrapped: wrapped,
    length: cols,
    translateToString: (trimRight) => (trimRight ? text.replace(/\s+$/, '') : text.padEnd(cols, ' ')),
    getCell: (i, cell) => {
      const ch = i < text.length ? text[i] : '';
      cell._ch = ch;
      cell._w = 1;
    },
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

// Chama provideLinks e devolve os links, com um exists e um open de mentira.
function provide(terminal, y, { context, exists = async () => true } = {}) {
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

test('um caminho numa linha vira link com o range certo e abre no clique', async () => {
  const terminal = fakeTerminal('abra /home/foco/a.txt agora', 80);
  const { links, opened } = await provide(terminal, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, '/home/foco/a.txt');
  assert.deepEqual(links[0].range, { start: { x: 6, y: 1 }, end: { x: 21, y: 1 } });
  assert.deepEqual(links[0].decorations, { pointerCursor: true, underline: true });
  links[0].activate({ fake: true }, links[0].text);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].path, '/home/foco/a.txt');
});

test('um caminho relativo resolve contra o diretorio vivo da sessao', async () => {
  const terminal = fakeTerminal('saiu temp/areas/position.csv pronto', 80);
  const { links, opened } = await provide(terminal, 1, { context: () => ({ cwd: '/home/foco/rea', home: '/home/foco' }) });
  assert.equal(links.length, 1);
  assert.equal(links[0].text, 'temp/areas/position.csv');
  links[0].activate({}, links[0].text);
  assert.equal(opened[0].path, '/home/foco/rea/temp/areas/position.csv');
});

test('so o que existe no disco fica sublinhado', async () => {
  const terminal = fakeTerminal('veja temp/some/that/none.csv aqui', 80);
  const { links } = await provide(terminal, 1, { exists: async () => false });
  assert.equal(links.length, 0);
});

test('sem diretorio vivo, um caminho relativo nao vira link', async () => {
  const terminal = fakeTerminal('saiu temp/areas/position.csv pronto', 80);
  const { links } = await provide(terminal, 1, { context: () => ({ cwd: null, home: '/home/foco' }) });
  assert.equal(links.length, 0);
});

test('um caminho que transborda a largura mapeia nas duas linhas', async () => {
  const path = '/home/foco/rea/temp/virtual-areas-gt-15420/position_virtual_area.csv';
  assert.ok(path.length > 40, 'o caminho precisa passar da largura para quebrar');
  const terminal = fakeTerminal(path, 40);
  const { links } = await provide(terminal, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].text, path);
  assert.equal(links[0].range.start.y, 1);
  assert.equal(links[0].range.end.y, 2);
});

test('le a linha e a coluna do sufixo e leva no clique', async () => {
  const terminal = fakeTerminal('erro em src/app.js:12:4 aqui', 80);
  const { links, opened } = await provide(terminal, 1, { context: () => ({ cwd: '/w', home: '/home/foco' }) });
  assert.equal(links.length, 1);
  assert.equal(links[0].text, 'src/app.js');
  links[0].activate({}, links[0].text);
  assert.deepEqual([opened[0].location.line, opened[0].location.column], [12, 4]);
});
