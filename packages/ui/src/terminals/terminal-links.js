// SPDX-License-Identifier: Apache-2.0
// Caminhos de arquivo na saída do terminal, como no VS Code. A varredura é
// pura e trabalha sobre o texto de uma linha; o terminal cuida das posições de
// célula e da validação no disco. Reconhece caminho absoluto, relativo, com ~,
// do Windows, e os sufixos de local mais comuns: `:linha`, `:linha:coluna`,
// `(linha,coluna)` e o `, line N` do traceback do Python.

// Um token é caminho quando tem separador de pasta ou um nome com extensão de
// letras. Isso evita marcar palavra solta, número ou versão como `1.5`.
function looksLikePath(path) {
  if (/[\\/]/.test(path)) return true;
  const base = path.split(/[\\/]/).pop() || '';
  return /\.[A-Za-z][\w+-]*$/.test(base);
}

function parseLocation(suffix) {
  if (!suffix) return { line: null, column: null };
  let match = suffix.match(/^:(\d+)(?::(\d+))?$/);
  if (match) return { line: Number(match[1]), column: match[2] ? Number(match[2]) : null };
  match = suffix.match(/^\((\d+),(\d+)\)$/);
  if (match) return { line: Number(match[1]), column: Number(match[2]) };
  return { line: null, column: null };
}

const TOKEN = /(?<![\w@~./\\-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])?[\w.@%+-]+(?:[\\/][\w.@%+-]+)*)((?::\d+(?::\d+)?)|(?:\(\d+,\d+\)))?/g;
const QUOTED = /["']([^"'\n]+?)["'](?:,?\s*line\s+(\d+))?/gi;

// Candidatos a link numa linha de texto. Cada um traz o trecho a sublinhar
// pelo índice e tamanho em caracteres, o caminho limpo e, quando houver, a
// linha e a coluna. Trechos sobrepostos ficam com o primeiro encontrado.
export function findPathLinks(text, limit = 50) {
  if (!text) return [];
  const found = [];
  const taken = [];
  const overlaps = (start, end) => taken.some((range) => start < range.end && end > range.start);
  const push = (index, length, path, line, column) => {
    if (found.length >= limit) return;
    if (overlaps(index, index + length)) return;
    taken.push({ start: index, end: index + length });
    found.push({ index, length, path, line, column });
  };

  // Caminhos entre aspas, inclusive o `File "...", line N` do Python.
  let match;
  QUOTED.lastIndex = 0;
  while ((match = QUOTED.exec(text))) {
    const path = match[1];
    if (!looksLikePath(path)) continue;
    const inner = match.index + 1;
    push(inner, path.length, path, match[2] ? Number(match[2]) : null, null);
  }

  // Tokens soltos com sufixo de local opcional.
  TOKEN.lastIndex = 0;
  while ((match = TOKEN.exec(text))) {
    const path = match[1];
    if (!looksLikePath(path)) continue;
    const { line, column } = parseLocation(match[2]);
    push(match.index, match[0].length, path, line, column);
  }

  return found.sort((a, b) => a.index - b.index);
}

// Caminho absoluto a partir do que apareceu na tela, resolvido contra o
// diretório atual do shell e o lar do usuário. Devolve com barras normais.
export function resolveLinkPath(raw, { cwd, home, join, isAbsolute, portable }) {
  let path = raw;
  if (home && (path === '~' || path.startsWith('~/') || path.startsWith('~\\'))) {
    path = `${home}/${path.slice(1).replace(/^[\\/]/, '')}`;
  }
  const normal = portable ? portable(path) : path.replace(/\\/g, '/');
  if (isAbsolute(normal)) return normal;
  if (!cwd) return null;
  return join(cwd, normal);
}
