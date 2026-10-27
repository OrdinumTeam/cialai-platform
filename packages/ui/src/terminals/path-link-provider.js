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

import { findPathLinks, resolveLinkPath } from './terminal-links.js';
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

  return {
    provideLinks(y, callback) {
      let ctx;
      try { ctx = context() || {}; } catch { ctx = {}; }
      const [lines, startLineIndex] = windowedLineStrings(terminal, y - 1);
      if (!lines.length) { callback(undefined); return; }
      const text = lines.join('');
      const candidates = findPathLinks(text, limit);
      if (!candidates.length) { callback(undefined); return; }

      const prepared = [];
      for (const candidate of candidates) {
        const abs = resolveLinkPath(candidate.path, {
          cwd: ctx.cwd || null,
          home: ctx.home || null,
          join: joinPath,
          isAbsolute: isAbsolutePath,
          portable: portablePath,
        });
        if (abs) prepared.push({ ...candidate, abs });
      }
      if (!prepared.length) { callback(undefined); return; }

      Promise.all(prepared.map((item) => checkExists(item.abs)))
        .then((results) => {
          const links = [];
          prepared.forEach((item, index) => {
            if (!results[index]) return;
            const [startY, startX] = mapStrIdx(terminal, startLineIndex, 0, item.index);
            const [endY, endX] = mapStrIdx(terminal, startY, startX, item.length);
            if (startY === -1 || startX === -1 || endY === -1 || endX === -1) return;
            links.push({
              text: item.path,
              range: {
                start: { x: startX + 1, y: startY + 1 },
                end: { x: endX, y: endY + 1 },
              },
              decorations: { pointerCursor: true, underline: true },
              activate: (event) => open(item.abs, { line: item.line, column: item.column }, event),
            });
          });
          callback(links.length ? links : undefined);
        })
        .catch(() => callback(undefined));
    },
  };
}
