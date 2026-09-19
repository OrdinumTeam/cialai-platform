// SPDX-License-Identifier: Apache-2.0
// Busca do grafo da documentacao, por nome e por caminho, sobre o indice que
// ja esta em memoria. Pura, para o script de verificacao testar no Node.
//
// O ranking repete o de `fs_find` no Rust, que o ⌘P ja ensinou ao usuario:
// nome exato, prefixo do nome, trecho do nome, trecho do caminho e, por fim,
// subsequencia do caminho. Tudo sobre a forma dobrada de `foldKey`, entao
// acento, caixa e a diferenca entre NFC e NFD nao atrapalham.

import { ROOT_ID, foldKey } from './model.js';

function subsequence(haystack, needle) {
  let cursor = 0;
  for (const character of needle) {
    cursor = haystack.indexOf(character, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

function scoreOf(node, needle, terms) {
  const name = node.key;
  const path = node.pathKey;
  if (name === needle) return 1000;
  if (name.startsWith(needle)) return 800 - Math.min(name.length, 200);
  if (name.includes(needle)) return 600 - Math.min(name.length, 200);
  if (path.includes(needle)) return 400 - Math.min(path.length, 300);
  // Varias palavras: todas precisam aparecer no caminho, em qualquer ordem.
  if (terms.length > 1 && terms.every((term) => path.includes(term))) return 300 - Math.min(path.length, 250);
  if (subsequence(path, needle.replace(/\s+/g, ''))) return Math.max(1, 100 - Math.min(path.length, 99));
  return 0;
}

// Devolve `{ id, score }` do melhor para o pior. Sem consulta, todos os
// documentos em ordem de caminho: e a lista que serve de alternativa tabular
// ao grafo. Pastas entram na busca depois dos documentos de mesma nota.
export function searchDocs(tree, query, { limit = 50, includeDirs = true } = {}) {
  const needle = foldKey(query).trim();
  const nodes = [...(tree?.nodes?.values() || [])].filter((node) => node.id !== ROOT_ID);
  if (!needle) {
    return nodes
      .filter((node) => node.kind === 'doc')
      .sort((a, b) => (a.pathKey < b.pathKey ? -1 : a.pathKey > b.pathKey ? 1 : a.id < b.id ? -1 : 1))
      .slice(0, limit)
      .map((node) => ({ id: node.id, score: 0 }));
  }
  const terms = needle.split(/\s+/).filter(Boolean);
  const ranked = [];
  nodes.forEach((node) => {
    if (node.kind !== 'doc' && !includeDirs) return;
    const score = scoreOf(node, needle, terms);
    if (score > 0) ranked.push({ id: node.id, score, doc: node.kind === 'doc', length: node.id.length });
  });
  ranked.sort((a, b) => b.score - a.score || Number(b.doc) - Number(a.doc) || a.length - b.length || (a.id < b.id ? -1 : 1));
  return ranked.slice(0, limit).map(({ id, score }) => ({ id, score }));
}

// Ids que casam com a consulta, para o desenho apagar os demais. So
// correspondencia de verdade: a camada de subsequencia serve a lista de
// resultados, mas no canvas acenderia meio grafo por coincidencia de letras.
export const SUBSEQUENCE_CEILING = 100;
export function matchSet(tree, query) {
  const needle = foldKey(query).trim();
  if (!needle) return null;
  return new Set(searchDocs(tree, query, { limit: Number.MAX_SAFE_INTEGER }).filter((item) => item.score > SUBSEQUENCE_CEILING).map((item) => item.id));
}
