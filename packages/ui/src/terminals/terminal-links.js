// SPDX-License-Identifier: Apache-2.0
// Caminhos de arquivo na saída do terminal, como no VS Code. A varredura é
// pura e trabalha sobre o texto de uma linha; o terminal cuida das posições de
// célula e da validação no disco. Reconhece caminho absoluto, relativo, com ~,
// do Windows, e os sufixos de local mais comuns: `:linha`, `:linha:coluna`,
// `(linha,coluna)` e o `, line N` do traceback do Python.
//
// Letra acentuada conta como letra: `Apresentação` e `Logística` são um token
// só, não `Apresenta` mais `o`. Nome com espaço não cabe num token; para ele,
// `growthStarts` devolve onde o trecho pode começar mais à esquerda, e quem
// tem o disco, o provedor, estica o âncora por cima dos espaços e fica com o
// maior trecho que é um arquivo de verdade.

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

// `\p{L}` e `\p{N}`, com a flag `u`, deixam letra acentuada e de outros
// alfabetos valerem como parte do nome, para `ç`, `ã` e `í` não cortarem o
// token no meio.
const TOKEN = /(?<![\p{L}\p{N}_@~./\\-])((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/]|[\\/])?[\p{L}\p{N}_.@%+-]+(?:[\\/][\p{L}\p{N}_.@%+-]+)*)((?::\d+(?::\d+)?)|(?:\(\d+,\d+\)))?/gu;
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

// Onde um trecho com espaços pode começar, da esquerda para a direita, para
// esticar um âncora por cima de nomes de arquivo com espaço. Cada número é o
// início de uma sequência sem espaço antes do âncora; da mais à esquerda, o
// maior trecho, para a mais próxima, o menor. O provedor tenta cada começo até
// `anchorEnd`, valida no disco e fica com o maior que é um arquivo. Limitado em
// palavras e caracteres para não varrer a linha inteira.
export function growthStarts(lineText, anchorStart, { maxWords = 12, maxChars = 240 } = {}) {
  if (!lineText || anchorStart <= 0) return [];
  const minIndex = Math.max(0, anchorStart - maxChars);
  const left = lineText.slice(0, anchorStart);
  const starts = [];
  const runs = /\S+/g;
  let match;
  while ((match = runs.exec(left))) {
    if (match.index >= minIndex) starts.push(match.index);
  }
  return starts.slice(-maxWords);
}
