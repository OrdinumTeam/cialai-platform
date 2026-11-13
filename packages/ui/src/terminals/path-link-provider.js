// SPDX-License-Identifier: Apache-2.0
// Provedor de link do xterm para caminhos de arquivo na saída do terminal,
// como o Cmd/Ctrl clique do VS Code, mas aqui o clique simples já abre, igual
// aos links http que o app já reconhece.
//
// A varredura do texto é pura e vive em `terminal-links.js`. Aqui fica só a
// cola com o xterm: reconstruir a linha lógica a partir das linhas quebradas,
// mapear o índice no texto de volta para célula e linha do buffer, resolver o
// caminho contra o diretório vivo da sessão e, só quando ele existe no disco,
// oferecer o link. A conta de linha quebrada e de caractere largo é a mesma do
// `WebLinkProvider` do `@xterm/addon-web-links`, que trabalha só com a API
// pública do terminal.
//
// Nome de arquivo com espaço não cabe num token. Para ele, o âncora é o pedaço
// com a extensão, e o provedor estica para a esquerda por cima dos espaços,
// conferindo cada trecho no disco, e fica com o maior que é um arquivo. Só o
// disco decide, então um trecho que atravessa palavras que não formam arquivo
// nenhum nunca vira link.

import { findPathLinks, growthStarts, resolveLinkPath } from './terminal-links.js';
import { isAbsolutePath, joinPath, portablePath } from '../lib/paths.js';

// Linhas lógicas em torno da linha `lineIndex` (0-based no buffer ativo),
// subindo e descendo pelas continuações de uma linha quebrada. Para em espaço
// ou quando passa de 2048 caracteres, como no addon. Devolve as strings e o
// índice da linha de cima.
function windowedLineStrings(terminal, lineIndex) {
  const buffer = terminal.buffer.active;
  let line = buffer.getLine(lineIndex);
  let topIdx = lineIndex;
  let bottomIdx = lineIndex;
  const lines = [];
  if (!line) return [lines, topIdx];

  const currentContent = line.translateToString(true);
  if (line.isWrapped && currentContent[0] !== ' ') {
    let length = 0;
    while ((line = buffer.getLine(--topIdx)) && length < 2048) {
      const content = line.translateToString(true);
      length += content.length;
      lines.push(content);
      if (!line.isWrapped || content.indexOf(' ') !== -1) break;
    }
    lines.reverse();
  }

  lines.push(currentContent);

  let length = 0;
  while ((line = buffer.getLine(++bottomIdx)) && line.isWrapped && length < 2048) {
    const content = line.translateToString(true);
    length += content.length;
    lines.push(content);
    if (content.indexOf(' ') !== -1) break;
  }
  return [lines, topIdx];
}

// Índice no texto lógico de volta para [linha, coluna] 0-based no buffer, ou
// [-1, -1] quando cai fora. Corrige o caractere largo que quebra na borda,
// como o addon.
function mapStrIdx(terminal, lineIndex, rowIndex, stringIndex) {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  let start = rowIndex;
  let remaining = stringIndex;
  while (remaining) {
    const line = buffer.getLine(lineIndex);
    if (!line) return [-1, -1];
    for (let i = start; i < line.length; ++i) {
      line.getCell(i, cell);
      const chars = cell.getChars();
      const width = cell.getWidth();
      if (width) {
        remaining -= chars.length || 1;
        if (i === line.length - 1 && chars === '') {
          const next = buffer.getLine(lineIndex + 1);
          if (next && next.isWrapped) {
            next.getCell(0, cell);
            if (cell.getWidth() === 2) remaining += 1;
          }
        }
      }
      if (remaining < 0) return [lineIndex, i];
    }
    lineIndex++;
    start = 0;
  }
  return [lineIndex, start];
}

// Cria o provedor. `context()` devolve `{ cwd, home }` vivos da sessão,
// `exists(abs)` resolve para `true` quando o caminho é um arquivo que dá para
// abrir, e `open(abs, { line, column }, event)` abre. `exists` é consultado
// por hover com um cache curto, para não bater no disco a cada passada do
// mouse na mesma linha.
export function createPathLinkProvider({ terminal, context, exists, open, limit = 50, cacheMs = 3000 }) {
  const cache = new Map();

  function checkExists(abs) {
    const now = Date.now();
    const hit = cache.get(abs);
    if (hit && now - hit.at < cacheMs) return Promise.resolve(hit.ok);
    return Promise.resolve()
      .then(() => exists(abs))
      .then((ok) => { cache.set(abs, { ok: Boolean(ok), at: now }); return Boolean(ok); })
      .catch(() => false);
  }

  // O maior trecho que é um arquivo de verdade, começando no âncora e esticando
  // para a esquerda por cima de espaços. Tenta do maior para o menor e para no
  // primeiro que existe no disco.
  async function bestSpan(text, candidate, resolveArgs) {
    const pathStart = candidate.index;
    const pathEnd = candidate.index + candidate.path.length;
    const starts = [...growthStarts(text, pathStart), pathStart];
    for (const start of starts) {
      const spanText = text.slice(start, pathEnd);
      const abs = resolveLinkPath(spanText, resolveArgs);
      if (abs && await checkExists(abs)) {
        return { start, end: pathEnd, text: spanText, abs };
      }
    }
    return null;
  }

  return {
    provideLinks(y, callback) {
      let ctx;
      try { ctx = context() || {}; } catch { ctx = {}; }
      const [lines, startLineIndex] = windowedLineStrings(terminal, y - 1);
      if (!lines.length) { callback(undefined); return; }
      const text = lines.join('');
      const candidates = findPathLinks(text, limit);
      if (!candidates.length) { callback(undefined); return; }

      const resolveArgs = {
        cwd: ctx.cwd || null,
        home: ctx.home || null,
        join: joinPath,
        isAbsolute: isAbsolutePath,
        portable: portablePath,
      };

      Promise.all(candidates.map((candidate) => bestSpan(text, candidate, resolveArgs).then((span) => ({ candidate, span }))))
        .then((results) => {
          const links = [];
          const taken = [];
          for (const { candidate, span } of results) {
            if (!span) continue;
            // Trechos que se sobrepõem, depois de esticar, ficam com o primeiro.
            if (taken.some((range) => span.start < range.end && span.end > range.start)) continue;
            const [startY, startX] = mapStrIdx(terminal, startLineIndex, 0, span.start);
            const [endY, endX] = mapStrIdx(terminal, startY, startX, span.text.length);
            if (startY === -1 || startX === -1 || endY === -1 || endX === -1) continue;
            taken.push({ start: span.start, end: span.end });
            links.push({
              text: span.text,
              range: {
                start: { x: startX + 1, y: startY + 1 },
                end: { x: endX, y: endY + 1 },
              },
              decorations: { pointerCursor: true, underline: true },
              activate: (event) => open(span.abs, { line: candidate.line, column: candidate.column }, event),
            });
          }
          callback(links.length ? links : undefined);
        })
        .catch(() => callback(undefined));
    },
  };
}
