// SPDX-License-Identifier: Apache-2.0
// Valores aceitos para a vista, o escopo e a profundidade do grafo, num modulo
// sem dependencia, para a persistencia e o painel conferirem o que veio do
// disco sem carregar as bibliotecas de layout.

export const VIEW_MODES = ['map', 'tree', 'radial', 'blocks', 'neighbors', 'space'];
// Vistas sem simulacao: a posicao sai inteira do layout.
export const STATIC_VIEWS = ['tree', 'radial', 'blocks'];
export const SCOPES = ['docs', 'project'];
export const DEPTH_LIMIT = 3;

export function cleanViewMode(value) {
  return VIEW_MODES.includes(value) ? value : 'map';
}

export function cleanScope(value) {
  return SCOPES.includes(value) ? value : 'docs';
}

export function cleanDepth(value) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(DEPTH_LIMIT, Math.max(1, number)) : 1;
}
