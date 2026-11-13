// SPDX-License-Identifier: Apache-2.0
// Vistas do grafo alem do Mapa. Cada uma e uma funcao pura da arvore, do que
// esta expandido e das ligacoes, para o script de verificacao testar no Node:
//
// - Arvore: a hierarquia em camadas, da esquerda para a direita.
// - Radial: a mesma hierarquia em aneis a partir da raiz.
// - Blocos: retangulos com area proporcional aos bytes, para ver onde o
//   projeto pesa. Pasta recolhida e um bloco so, com o total dela.
// - Vizinhos: o arquivo em foco e os que ele cita ou que o citam, ate tres
//   passos. A posicao sai de uma simulacao no controlador; aqui fica so a
//   escolha de quem entra.
//
// Arvore, Radial e Blocos respeitam a expansao do Mapa: a pasta recolhida
// numa vista esta recolhida em todas. O 3D usa a mesma cena visivel do Mapa e
// mora em `space.js`.
//
// Nenhuma vista usa `Math.random`: a mesma arvore desenha sempre o mesmo
// grafo.

import { hierarchy, tree as tidyTree, treemap, treemapSquarify } from 'd3-hierarchy';
import { ROOT_ID, degreeOf, neighborsOf } from './model.js';
import { cleanDepth } from './options.js';

export const TREE_ROW = 18;
export const TREE_COLUMN = 210;
export const RING_GAP = 120;
const LEAF_ARC = 15;
// Arquivo vazio ainda ocupa lugar nos Blocos.
export const MIN_BLOCK = 256;
export const BLOCK_HEADER = 16;
// Pasta aberta abaixo disso nao ganha a faixa do nome.
const HEADER_MIN = { w: 56, h: 40 };
export const NEIGHBOR_CAP = 300;

/* ── hierarquia visivel ───────────────────────────────────────────── */

// A arvore como o Mapa mostra: pasta expandida abre as subpastas e os
// arquivos, nessa ordem; pasta recolhida e folha.
export function visibleHierarchy(tree, expanded) {
  const build = (id) => {
    const node = tree.nodes.get(id);
    if (node.kind === 'doc' || !expanded.has(id)) return { id };
    return { id, children: [...node.dirs.map(build), ...node.docs.map((doc) => ({ id: doc }))] };
  };
  return hierarchy(build(ROOT_ID));
}

function edgesOf(root) {
  return root.links().map((link) => ({ source: link.source.data.id, target: link.target.data.id }));
}

/* ── arvore e radial ──────────────────────────────────────────────── */

// Camadas da esquerda para a direita. O rotulo da pasta fica a esquerda dela
// e o do arquivo a direita, entao a caixa reserva espaco dos dois lados.
// Caixa dos nos com folga: `left` e `right` para os rotulos que saem para os
// lados, `y` em cima e embaixo.
function extentOf(nodes, { left, right, y }) {
  let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
  nodes.forEach((node) => { minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x); minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y); });
  return { x: minX - left, y: minY - y, w: maxX - minX + left + right, h: maxY - minY + y * 2 };
}

export function treeLayout(tree, expanded) {
  const root = visibleHierarchy(tree, expanded);
  tidyTree().nodeSize([TREE_ROW, TREE_COLUMN]).separation((a, b) => (a.parent === b.parent ? 1 : 1.5))(root);
  const nodes = root.descendants().map((item) => ({ id: item.data.id, x: item.y, y: item.x, depth: item.depth, side: item.children ? 'left' : 'right' }));
  return { nodes, edges: edgesOf(root), bounds: extentOf(nodes, { left: 150, right: 180, y: 24 }) };
}

// Aneis a partir da raiz. O raio cresce com o numero de folhas, para elas
// nao se encostarem no anel de fora, e com a profundidade, para os aneis nao
// se encostarem entre si.
export function radialLayout(tree, expanded) {
  const root = visibleHierarchy(tree, expanded);
  const leaves = root.leaves().length;
  const radius = Math.max(RING_GAP, (root.height || 1) * RING_GAP, (leaves * LEAF_ARC) / (2 * Math.PI));
  tidyTree().size([2 * Math.PI, radius]).separation((a, b) => (a.parent === b.parent ? 1 : 2) / Math.max(1, a.depth))(root);
  const nodes = root.descendants().map((item) => {
    // Comeca no topo e gira no sentido do relogio.
    const angle = item.x - Math.PI / 2;
    const x = item.y * Math.cos(angle);
    const y = item.y * Math.sin(angle);
    return { id: item.data.id, x, y, depth: item.depth, angle, r: item.y, side: item.depth === 0 ? 'center' : x < -0.5 ? 'left' : 'right' };
  });
  // A caixa e a do desenho, nao a do anel inteiro: um ramo fundo de um lado
  // so nao encolhe o resto. A folga e para os rotulos que saem para os lados.
  return { nodes, edges: edgesOf(root), bounds: extentOf(nodes, { left: 80, right: 80, y: 30 }) };
}

/* ── blocos ───────────────────────────────────────────────────────── */

// Bytes de cada pasta, com o piso por arquivo. A arvore nao muda depois de
// montada, entao o total fica guardado nela.
export function folderBytes(tree) {
  if (tree.bytes) return tree.bytes;
  const totals = new Map();
  tree.nodes.forEach((node) => {
    if (node.kind !== 'doc') return;
    const value = Math.max(Number(node.size) || 0, MIN_BLOCK);
    let cursor = node.parent;
    while (cursor !== null && cursor !== undefined) {
      totals.set(cursor, (totals.get(cursor) || 0) + value);
      cursor = tree.nodes.get(cursor).parent;
    }
  });
  tree.bytes = totals;
  return totals;
}

function hasHeader(item) {
  return item.depth === 0 || (item.x1 - item.x0 > HEADER_MIN.w && item.y1 - item.y0 > HEADER_MIN.h);
}

export function blocksLayout(tree, expanded, { width = 1600, height = 1000 } = {}) {
  const bytes = folderBytes(tree);
  const root = visibleHierarchy(tree, expanded)
    .sum((data) => {
      if (data.children) return 0;
      const node = tree.nodes.get(data.id);
      return node.kind === 'doc' ? Math.max(Number(node.size) || 0, MIN_BLOCK) : bytes.get(data.id) || MIN_BLOCK;
    })
    .sort((a, b) => b.value - a.value || (a.data.id < b.data.id ? -1 : 1));
  treemap()
    .tile(treemapSquarify)
    .size([width, height])
    .round(false)
    .paddingOuter(2)
    .paddingInner(2)
    // A faixa do nome so entra em pasta grande o bastante para mostrar algo.
    .paddingTop((item) => (hasHeader(item) ? BLOCK_HEADER : 2))(root);
  const nodes = root.descendants().map((item) => ({
    id: item.data.id,
    x: (item.x0 + item.x1) / 2,
    y: (item.y0 + item.y1) / 2,
    depth: item.depth,
    value: item.value,
    rect: { x0: item.x0, y0: item.y0, x1: item.x1, y1: item.y1 },
    open: Boolean(item.children),
    header: Boolean(item.children) && hasHeader(item),
  }));
  return { nodes, edges: [], bounds: { x: 0, y: 0, w: width, h: height } };
}

/* ── vizinhos ─────────────────────────────────────────────────────── */

// Arquivo em foco: o selecionado, se for arquivo. Senao, o mais ligado dentro
// da pasta selecionada, ou do projeto todo. Empate fica com o primeiro
// caminho. Sem nenhuma ligacao, nada.
export function neighborFocus(tree, selected) {
  const node = selected ? tree?.nodes.get(selected) : null;
  if (node?.kind === 'doc') return node.id;
  if (!tree?.links?.count) return null;
  const prefix = node && node.id !== ROOT_ID ? `${node.id}/` : '';
  let best = null;
  let bestDegree = 0;
  tree.nodes.forEach((candidate) => {
    if (candidate.kind !== 'doc' || (prefix && !candidate.id.startsWith(prefix))) return;
    const degree = degreeOf(tree, candidate.id);
    if (degree > bestDegree || (degree === bestDegree && degree > 0 && candidate.id < best)) { best = candidate.id; bestDegree = degree; }
  });
  return best;
}

// Quem entra na vista: o foco, os vizinhos dele e assim por diante ate a
// profundidade, em largura. Num mesmo passo entram primeiro os mais ligados,
// e o teto corta o resto. `via` e quem trouxe o arquivo, para a simulacao o
// fazer nascer perto dele. As arestas sao todas as ligacoes entre quem entrou.
export function neighborhood(tree, focus, depth = 1, cap = NEIGHBOR_CAP) {
  if (!focus || !tree?.nodes.has(focus)) return { nodes: [], edges: [], capped: false };
  const ring = new Map([[focus, { ring: 0, via: null }]]);
  let frontier = [focus];
  let capped = false;
  for (let level = 1; level <= cleanDepth(depth) && frontier.length && !capped; level += 1) {
    const candidates = new Map();
    frontier.forEach((id) => neighborsOf(tree, id).forEach((other) => { if (!ring.has(other) && !candidates.has(other)) candidates.set(other, id); }));
    const ordered = [...candidates.keys()].sort((a, b) => degreeOf(tree, b) - degreeOf(tree, a) || (a < b ? -1 : 1));
    const next = [];
    for (const id of ordered) {
      if (ring.size >= cap) { capped = true; break; }
      ring.set(id, { ring: level, via: candidates.get(id) });
      next.push(id);
    }
    frontier = next;
  }
  const edges = [];
  ring.forEach((_, id) => (tree.links.out.get(id) || []).forEach((to) => { if (ring.has(to)) edges.push({ source: id, target: to }); }));
  return { nodes: [...ring.entries()].map(([id, info]) => ({ id, ...info })), edges, capped };
}

/* ── ligacoes na cena visivel ─────────────────────────────────────── */

// Cada ponta de uma ligacao vai para o no mais proximo que esta a vista: o
// proprio arquivo, ou a pasta recolhida que o contem. Pares que caem no mesmo
// no somem, e pares repetidos viram um so, com peso. Acima do teto ficam os
// mais pesados.
export function visibleRefs(tree, isVisible, { cap = 4000 } = {}) {
  const links = tree?.links;
  if (!links?.count) return { refs: [], total: 0 };
  const memo = new Map();
  const representative = (id) => {
    if (memo.has(id)) return memo.get(id);
    let cursor = id;
    while (cursor !== null && cursor !== undefined && !isVisible(cursor)) cursor = tree.nodes.get(cursor)?.parent ?? null;
    memo.set(id, cursor ?? null);
    return cursor ?? null;
  };
  const pairs = new Map();
  links.out.forEach((targets, source) => {
    const a = representative(source);
    if (!a) return;
    targets.forEach((target) => {
      const b = representative(target);
      if (!b || a === b) return;
      const key = a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
      const entry = pairs.get(key);
      if (entry) entry.weight += 1;
      else pairs.set(key, { a: a < b ? a : b, b: a < b ? b : a, weight: 1 });
    });
  });
  const list = [...pairs.values()];
  if (list.length > cap) list.sort((x, y) => y.weight - x.weight || (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : 1));
  return { refs: list.slice(0, cap), total: list.length };
}
