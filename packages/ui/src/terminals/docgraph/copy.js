// SPDX-License-Identifier: Apache-2.0
// Textos visíveis do grafo da documentação, num lugar só. Existe para a regra
// de texto do produto ser conferida por máquina: `tools/check/visible-text.mjs`
// percorre os três dicionários e recusa parênteses como aposto e hífen,
// meia-risca ou travessão como separador. Relação entre rótulo e valor se
// mostra com hierarquia na interface, não com pontuação.
//
// Cada texto mora em `@cialai/i18n`, com a chave `terminal.docgraph.*` nos três
// idiomas. `STRINGS` lê pelo nome, então o valor acompanha o idioma ativo sem
// ninguém recarregar a página.

import { getLocale, translate } from '../../shared/i18n.js';

// Leitura por nome: `STRINGS.empty` devolve `terminal.docgraph.empty` no
// idioma ativo. Um objeto comum congelaria o idioma na carga do módulo.
export const STRINGS = new Proxy(Object.create(null), {
  get: (_target, key) => (typeof key === 'string' ? translate(`terminal.docgraph.${key}`) : undefined),
  has: () => true,
});

function number(value) {
  return (Math.max(0, Math.floor(Number(value) || 0))).toLocaleString(getLocale());
}

// Contagem com a forma singular ou plural da própria chave.
function counted(base, count) {
  const value = Math.max(0, Math.floor(Number(count) || 0));
  return translate(`terminal.docgraph.${base}${value === 1 ? 'One' : 'Many'}`, { count: number(value) });
}

export function docsCount(count) {
  return counted('docs', count);
}

export function filesCount(count) {
  return counted('files', count);
}

// Documento na Documentacao, arquivo no Projeto inteiro.
export function itemsCount(count, scope = 'docs') {
  return scope === 'project' ? filesCount(count) : docsCount(count);
}

export function foldersCount(count) {
  return counted('folders', count);
}

export function subfoldersCount(count) {
  return counted('subfolders', count);
}

export function issuesCount(count) {
  return counted('issues', count);
}

export function moreIssues(count) {
  return counted('moreIssues', count);
}

// Numero dentro do disco de uma pasta recolhida: curto o bastante para caber.
export function badgeCount(count) {
  const value = Math.max(0, Math.floor(Number(count) || 0));
  if (value < 10000) return value.toLocaleString(getLocale());
  return translate('terminal.docgraph.badgeThousands', { count: Math.floor(value / 1000).toLocaleString(getLocale()) });
}

// Rotulo acessivel do painel de previa, com o nome do documento.
export function previewOf(name) {
  return translate('terminal.docgraph.previewOf', { name });
}

export function issueReason(code) {
  if (code === 'denied') return STRINGS.reasonDenied;
  if (code === 'depth') return STRINGS.reasonDepth;
  if (code === 'limit') return STRINGS.reasonLimit;
  if (code === 'timeout') return STRINGS.reasonTimeout;
  return STRINGS.reasonIo;
}

export function excludedLines(excluded = {}) {
  const lines = [];
  if (excluded.symlinkDirs) lines.push(counted('excludedSymlinkDirs', excluded.symlinkDirs));
  if (excluded.outsideRoot) lines.push(counted('excludedOutsideRoot', excluded.outsideRoot));
  if (excluded.brokenLinks) lines.push(counted('excludedBrokenLinks', excluded.brokenLinks));
  if (excluded.cacheDirs) lines.push(counted('excludedCacheDirs', excluded.cacheDirs));
  if (excluded.invalidNames) lines.push(counted('excludedInvalidNames', excluded.invalidNames));
  return lines;
}

export function indexingProgress(seconds, scope = 'docs') {
  if (seconds < 2) return scope === 'project' ? STRINGS.indexingHintProject : STRINGS.indexingHint;
  return translate('terminal.docgraph.indexingStill', { elapsed: counted('seconds', Math.floor(seconds)) });
}

// O que o leitor de tela ouve ao chegar num nó.
export function nodeAnnouncement(node, { expanded = false, rootName = '', scope = 'docs' } = {}) {
  if (!node) return '';
  if (node.kind === 'doc') {
    return translate(scope === 'project' ? 'terminal.docgraph.sayFile' : 'terminal.docgraph.sayDoc', {
      name: node.name,
      parent: node.parent === '.' ? rootName || STRINGS.projectRoot : node.parent,
    });
  }
  return translate(node.kind === 'root' ? 'terminal.docgraph.sayRoot' : 'terminal.docgraph.sayDir', {
    name: node.kind === 'root' ? rootName || node.name : node.name,
    docs: itemsCount(node.docCount, scope),
    state: expanded ? STRINGS.sayExpanded : STRINGS.sayCollapsed,
  });
}

export function countsAnnouncement(docs, dirs, scope = 'docs') {
  return translate('terminal.docgraph.sayCounts', { docs: itemsCount(docs, scope), folders: foldersCount(dirs) });
}

// Nome de cada vista, modo de cor e paleta, na ordem dos seletores.
const VIEW_NAMES = { map: 'viewMap', tree: 'viewTree', radial: 'viewRadial', blocks: 'viewBlocks', neighbors: 'viewNeighbors', space: 'view3d' };
const COLOR_NAMES = { group: 'colorGroup', folder: 'colorFolder', type: 'colorType', size: 'colorSize', modified: 'colorModified', rules: 'colorRules' };
const PALETTE_NAMES = { safe: 'paletteSafe', neon: 'paletteNeon', pastel: 'palettePastel', mono: 'paletteMono' };
const AGE_NAMES = ['ageDay', 'ageWeek', 'ageMonth', 'ageYear', 'ageOlder'];

export function viewName(mode) {
  return STRINGS[VIEW_NAMES[mode] || 'viewMap'];
}

export function colorModeName(mode) {
  return STRINGS[COLOR_NAMES[mode] || 'colorGroup'];
}

export function paletteName(palette) {
  return STRINGS[PALETTE_NAMES[palette] || 'paletteSafe'];
}

// Faixa de tamanho da legenda. `steps` sao os limites, do menor ao maior.
export function sizeBinLabel(bin, steps) {
  if (bin < steps.length) return translate('terminal.docgraph.sizeUpTo', { size: fmtSize(steps[bin]) });
  return translate('terminal.docgraph.sizeAbove', { size: fmtSize(steps[steps.length - 1]) });
}

export function ageBinLabel(bin) {
  return STRINGS[AGE_NAMES[bin] || 'ageOlder'];
}

// Tipo de arquivo na legenda: a extensao em maiusculas, o nome do arquivo de
// ponto como esta, ou a falta de extensao.
export function typeLabel(ext) {
  if (!ext) return STRINGS.noExtension;
  return ext.startsWith('.') ? ext : ext.toUpperCase();
}

export function linksCount(count) {
  return counted('links', count);
}

export function rulesLimit(count) {
  return translate('terminal.docgraph.rulesLimit', { count: number(count) });
}

export function neighborsCapped(count) {
  return translate('terminal.docgraph.neighborsCapped', { count: number(count) });
}

// Tamanho e data do cartão de detalhes.
export function fmtSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return counted('bytes', value);
  const locale = getLocale();
  if (value < 1024 * 1024) return translate('terminal.docgraph.sizeKb', { value: (value / 1024).toLocaleString(locale, { maximumFractionDigits: 1 }) });
  return translate('terminal.docgraph.sizeMb', { value: (value / (1024 * 1024)).toLocaleString(locale, { maximumFractionDigits: 1 }) });
}

export function fmtModified(ms) {
  if (!ms) return '';
  const date = new Date(Number(ms));
  if (Number.isNaN(date.getTime())) return '';
  const locale = getLocale();
  return translate('terminal.docgraph.modifiedAt', {
    date: date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: 'numeric' }),
    time: date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }),
  });
}
