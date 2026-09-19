// SPDX-License-Identifier: Apache-2.0
// Motor do grafo da documentacao, num ponto de entrada so. O painel carrega
// este arquivo por `import()` quando a aba monta pela primeira vez, entao o
// d3-force, o renderizador e o controlador ficam fora do pacote principal do
// estudio, como o `xlsx` e o `mammoth` das previas de documentos.

export * as api from './controller.js';
export { DocGraphRenderer, readGraphTheme } from './renderer.js';
export { bindInteraction } from './interaction.js';
export { track, snapshot, liveCounts, resetSamples } from './stats.js';
export { searchDocs } from './search.js';
export { ROOT_ID, absPath, groupOf } from './model.js';
