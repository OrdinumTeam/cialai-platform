// SPDX-License-Identifier: Apache-2.0
// Vista 3D do grafo: a mesma cena visivel do Mapa, com pastas e arquivos
// soltos numa simulacao de forcas em tres eixos, projetada em perspectiva no
// proprio canvas 2D. Sem WebGL, para nao disputar o teto de contextos com o
// xterm de cada sessao.
//
// A camera 2D do grafo continua valendo depois da projecao: zoom e
// deslocamento sao os mesmos das outras vistas. O arraste gira a cena em
// volta da origem, onde a raiz fica presa.
//
// Como no Mapa, a simulacao nasce parada e quem a possui chama `tick()`, e a
// semente sai de um hash do id: a mesma arvore nasce sempre igual.

import { forceLink, forceManyBody, forceSimulation, forceX, forceY, forceZ } from 'd3-force-3d';
import { ROOT_ID } from './model.js';
import { hashOf } from './layout.js';

const ALPHA_MIN = 0.001;
// Esfria em cerca de 220 passos.
const ALPHA_DECAY = 1 - ALPHA_MIN ** (1 / 220);
export const PITCH_LIMIT = 1.45;
export const DEFAULT_ORBIT = { yaw: 0.6, pitch: -0.35 };

function linkDistance(link) {
  if (link.kind === 'ref') return 110;
  return link.target.kind === 'doc' ? 22 : 64;
}

function charge(node) {
  if (node.kind === 'root') return -160;
  return node.kind === 'doc' ? -14 : -70;
}

export function createSpaceSim(nodes, links) {
  return forceSimulation(nodes, 3)
    .alphaMin(ALPHA_MIN)
    .alphaDecay(ALPHA_DECAY)
    .velocityDecay(0.42)
    .force('link', forceLink(links).distance(linkDistance).strength((link) => (link.kind === 'ref' ? 0.04 : 0.8)).iterations(2))
    .force('charge', forceManyBody().strength(charge).theta(0.9).distanceMax(700))
    .force('x', forceX(0).strength(0.02))
    .force('y', forceY(0).strength(0.02))
    .force('z', forceZ(0).strength(0.02))
    .stop();
}

export function updateSpaceSim(simulation, nodes, links) {
  simulation.nodes(nodes);
  simulation.force('link').links(links);
  simulation.force('charge').strength(charge);
}

// Direcao estavel tirada do id, na esfera.
function direction(id) {
  const hash = hashOf(id);
  const theta = ((hash & 0xffff) / 0x10000) * Math.PI * 2;
  const z = (((hash >>> 16) & 0xffff) / 0x10000) * 2 - 1;
  const ring = Math.sqrt(Math.max(0, 1 - z * z));
  return { x: ring * Math.cos(theta), y: ring * Math.sin(theta), z };
}

// No novo nasce perto do pai, numa direcao tirada do proprio id. Quem ja tinha
// posicao nao muda. `nodes` e o mapa de id para no da simulacao, na ordem da
// cena, entao o pai sempre vem antes do filho.
export function seedSpace(tree, nodes) {
  nodes.forEach((node, id) => {
    if (node.seeded) return;
    if (id === ROOT_ID) { node.x = 0; node.y = 0; node.z = 0; node.seeded = true; return; }
    const parent = nodes.get(tree.nodes.get(id)?.parent ?? ROOT_ID);
    const step = node.kind === 'doc' ? 18 : 48;
    const dir = direction(id);
    node.x = (parent?.x || 0) + dir.x * step;
    node.y = (parent?.y || 0) + dir.y * step;
    node.z = (parent?.z || 0) + dir.z * step;
    node.seeded = true;
  });
}

export function orbitBy(orbit, dx, dy) {
  return { yaw: orbit.yaw + dx, pitch: Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, orbit.pitch + dy)) };
}

export function rotationOf(orbit) {
  return { cy: Math.cos(orbit.yaw), sy: Math.sin(orbit.yaw), cp: Math.cos(orbit.pitch), sp: Math.sin(orbit.pitch) };
}

// Gira em volta do eixo vertical, depois do horizontal, e aplica a
// perspectiva. `depth` positivo e longe da camera; `k` e a escala do ponto.
export function project(x, y, z, rotation, focal) {
  const x1 = x * rotation.cy + z * rotation.sy;
  const z1 = -x * rotation.sy + z * rotation.cy;
  const y2 = y * rotation.cp - z1 * rotation.sp;
  const depth = y * rotation.sp + z1 * rotation.cp;
  const k = focal / Math.max(focal * 0.2, focal + depth);
  return { x: x1 * k, y: y2 * k, depth, k };
}

// Raio da nuvem a partir da origem. A distancia focal e um multiplo dele,
// para a perspectiva ficar suave em qualquer tamanho de projeto.
export function spaceExtent(nodes) {
  let extent = 60;
  nodes.forEach((node) => {
    const value = Math.hypot(node.x || 0, node.y || 0, node.z || 0);
    if (Number.isFinite(value) && value > extent) extent = value;
  });
  return extent;
}

export function focalOf(extent) {
  return extent * 3;
}

// Caixa da cena projetada, para o enquadramento.
export function projectedBounds(nodes, orbit) {
  const rotation = rotationOf(orbit);
  const focal = focalOf(spaceExtent(nodes));
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  nodes.forEach((node) => {
    const spot = project(node.x || 0, node.y || 0, node.z || 0, rotation, focal);
    minX = Math.min(minX, spot.x); maxX = Math.max(maxX, spot.x);
    minY = Math.min(minY, spot.y); maxY = Math.max(maxY, spot.y);
  });
  if (!Number.isFinite(minX)) return { x: -100, y: -100, w: 200, h: 200 };
  const pad = 40;
  return { x: minX - pad, y: minY - pad, w: Math.max(1, maxX - minX + pad * 2), h: Math.max(1, maxY - minY + pad * 2) };
}
