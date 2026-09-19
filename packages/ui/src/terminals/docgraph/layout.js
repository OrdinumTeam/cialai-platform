// SPDX-License-Identifier: Apache-2.0
// Layout do grafo da documentacao, em dois niveis.
//
// A simulacao de forcas move so a raiz e as pastas: cerca de duzentos corpos
// num projeto grande, bem abaixo de um milissegundo por passo. Os documentos
// diretos de cada pasta ficam num disco em espiral de girassol em volta dela,
// em posicoes fixas, e o raio desse disco entra na colisao e na distancia das
// ligacoes. Uma pasta com 271 documentos vira uma constelacao compacta em vez
// de uma bola de nos se empurrando, e criar ou remover um documento so mexe no
// disco da propria pasta.
//
// Nada aqui usa `Math.random`: a semente e radial, por setores proporcionais a
// quantidade de documentos, com o angulo de desempate tirado de um hash do id.
// A mesma arvore desenha sempre o mesmo grafo.
//
// A simulacao nasce parada e quem a possui chama `tick()`. Assim o `d3-timer`
// nunca roda por conta propria, e uma aba escondida nao gasta quadro nenhum.

import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import { ROOT_ID } from './model.js';

const GOLDEN_ANGLE = 2.399963229728653;
const SLOT_SPACING = 9;
const ALPHA_MIN = 0.001;
// Esfria em cerca de 180 passos.
const ALPHA_DECAY = 1 - ALPHA_MIN ** (1 / 180);
export const ROOT_RADIUS = 16;

export function hashOf(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) { value ^= text.charCodeAt(index); value = Math.imul(value, 16777619); }
  return value >>> 0;
}

// Angulo estavel tirado do id: a fase do girassol de cada pasta.
export function hashAngle(id) {
  return (hashOf(id) / 4294967296) * Math.PI * 2;
}

// Raio do disco que representa a pasta: cresce devagar com o total de
// documentos abaixo dela, para uma pasta grande se destacar sem dominar.
export function hubRadius(node) {
  if (node.kind === 'root') return ROOT_RADIUS;
  return Math.min(24, Math.max(8, 6 + 1.9 * Math.log2(1 + node.docCount)));
}

function slotOrigin(hub) {
  return ((hub + 6) / SLOT_SPACING) ** 2;
}

// Posicao da vaga `index` do girassol, relativa ao centro da pasta.
export function slotPosition(index, hub, phase = 0) {
  const radius = SLOT_SPACING * Math.sqrt(index + slotOrigin(hub));
  const angle = index * GOLDEN_ANGLE + phase;
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

// Raio do agrupamento inteiro: o disco da pasta mais as vagas ocupadas.
export function discRadius(slots, hub) {
  if (!slots) return hub;
  return SLOT_SPACING * Math.sqrt(slots + slotOrigin(hub)) + 5;
}

// Vagas dos documentos de uma pasta. Quem ja tinha vaga fica nela; documento
// novo ocupa a menor vaga livre. Reordenar tudo faria os vizinhos saltarem,
// porque uma vaga a mais no girassol gira a marca em 137 graus.
export function assignSlots(previous, docIds) {
  const next = new Map();
  const used = new Set();
  docIds.forEach((id) => {
    const kept = previous?.get(id);
    if (Number.isInteger(kept) && !used.has(kept)) { next.set(id, kept); used.add(kept); }
  });
  let cursor = 0;
  docIds.forEach((id) => {
    if (next.has(id)) return;
    while (used.has(cursor)) cursor += 1;
    next.set(id, cursor);
    used.add(cursor);
  });
  return next;
}

export function slotExtent(slots) {
  let highest = -1;
  slots?.forEach((index) => { if (index > highest) highest = index; });
  return highest + 1;
}

function gapFor(depth) {
  return depth <= 1 ? 56 : 40;
}

// Semente radial das pastas que ainda nao tem posicao. `nodes` e o mapa de id
// para no da simulacao, com `R` ja calculado. Pasta que ja tinha posicao nao e
// tocada; pasta nova nasce junto do pai, do lado de fora.
export function seedRadial(tree, nodes) {
  const root = nodes.get(ROOT_ID);
  if (!root) return;
  if (!root.seeded) { root.x = 0; root.y = 0; root.seeded = true; }
  const weight = (id) => Math.sqrt(tree.nodes.get(id).docCount) + 1;
  const place = (id, center, spread) => {
    const parent = nodes.get(id);
    const kids = tree.nodes.get(id).dirs.filter((child) => nodes.has(child));
    if (!kids.length) return;
    const total = kids.reduce((sum, child) => sum + weight(child), 0);
    let cursor = center - spread / 2;
    kids.forEach((child) => {
      const span = (spread * weight(child)) / total;
      const node = nodes.get(child);
      const jitter = ((hashOf(child) % 1000) / 1000 - 0.5) * Math.min(span, 0.35);
      const angle = cursor + span / 2 + jitter;
      if (!node.seeded) {
        const distance = parent.R + node.R + gapFor(node.depth);
        node.x = parent.x + distance * Math.cos(angle);
        node.y = parent.y + distance * Math.sin(angle);
        node.seeded = true;
      }
      // Os netos abrem em leque para fora, nunca de volta para o avo.
      const outward = Math.atan2(node.y - parent.y, node.x - parent.x);
      place(child, outward, Math.min(Math.PI * 1.15, Math.max(Math.PI * 0.55, span * 2.4)));
      cursor += span;
    });
  };
  place(ROOT_ID, 0, Math.PI * 2);
}

export function createSim(nodes, links) {
  const simulation = forceSimulation(nodes)
    .alphaMin(ALPHA_MIN)
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(0.45)
    .force('link', forceLink(links)
      .distance((link) => link.source.R + link.target.R + gapFor(link.target.depth))
      .strength(0.7)
      .iterations(2))
    .force('charge', forceManyBody().strength((node) => -(30 + 1.2 * node.R)).theta(0.9).distanceMax(900))
    .force('collide', forceCollide().radius((node) => node.R + 10).strength(0.9).iterations(2))
    .force('x', forceX(0).strength(0.015))
    .force('y', forceY(0).strength(0.015))
    .stop();
  return simulation;
}

// Troca nos e ligacoes mantendo as forcas. As forcas do d3 guardam o raio e a
// forca de cada no ao serem inicializadas, entao precisam ser reinicializadas
// quando um raio muda.
export function updateSim(simulation, nodes, links) {
  simulation.nodes(nodes);
  simulation.force('link').links(links);
  simulation.force('collide').radius((node) => node.R + 10);
  simulation.force('charge').strength((node) => -(30 + 1.2 * node.R));
}

// Roda passos de forma sincrona ate esfriar, ate o teto de passos ou ate o
// prazo. Devolve quantos passos rodou.
export function settle(simulation, { ticks = 120, budgetMs = 60, now = () => performance.now() } = {}) {
  const started = now();
  let count = 0;
  while (count < ticks && simulation.alpha() >= ALPHA_MIN) {
    simulation.tick();
    count += 1;
    if (count % 8 === 0 && now() - started > budgetMs) break;
  }
  return count;
}

export function isCold(simulation) {
  return simulation.alpha() < ALPHA_MIN;
}

// Caixa que contem todos os agrupamentos, no espaco do mundo.
export function boundsOf(nodes) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  nodes.forEach((node) => {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
    minX = Math.min(minX, node.x - node.R); maxX = Math.max(maxX, node.x + node.R);
    minY = Math.min(minY, node.y - node.R); maxY = Math.max(maxY, node.y + node.R);
  });
  if (!Number.isFinite(minX)) return { x: -100, y: -100, w: 200, h: 200 };
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

// Visao que enquadra uma caixa do mundo na area disponivel. Pura, para o
// primeiro desenho nao depender de quadro de animacao.
export function fitView(bounds, width, height, { maxScale = 1.25, minScale = 0.03 } = {}) {
  const padding = Math.min(48, 0.1 * Math.min(width, height));
  const s = Math.min(maxScale, Math.max(minScale, Math.min((width - padding * 2) / bounds.w, (height - padding * 2) / bounds.h)));
  return { s, x: (width - bounds.w * s) / 2 - bounds.x * s, y: (height - bounds.h * s) / 2 - bounds.y * s };
}
