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

export function indexingProgress(seconds) {
  if (seconds < 2) return STRINGS.indexingHint;
  return translate('terminal.docgraph.indexingStill', { elapsed: counted('seconds', Math.floor(seconds)) });
}

// O que o leitor de tela ouve ao chegar num nó.
export function nodeAnnouncement(node, { expanded = false, rootName = '' } = {}) {
  if (!node) return '';
  if (node.kind === 'doc') {
    return translate('terminal.docgraph.sayDoc', {
      name: node.name,
      parent: node.parent === '.' ? rootName || STRINGS.projectRoot : node.parent,
    });
  }
  return translate(node.kind === 'root' ? 'terminal.docgraph.sayRoot' : 'terminal.docgraph.sayDir', {
    name: node.kind === 'root' ? rootName || node.name : node.name,
    docs: docsCount(node.docCount),
    state: expanded ? STRINGS.sayExpanded : STRINGS.sayCollapsed,
  });
}

export function countsAnnouncement(docs, dirs) {
  return translate('terminal.docgraph.sayCounts', { docs: docsCount(docs), folders: foldersCount(dirs) });
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
