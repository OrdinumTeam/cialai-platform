// SPDX-License-Identifier: Apache-2.0
// A aba do grafo da documentacao na area central do estudio. E uma aba
// virtual, sem arquivo por tras, no molde da aba do Dev Browser: entra na
// mesma lista de abas da sessao, fecha com ⌘W e troca como qualquer outra.
//
// Fica separada do controlador de proposito: os pontos de entrada, que sao o
// botao do cabecalho, o menu do explorador, a paleta e o atalho, importam so
// isto. O motor do grafo, com o d3-force, so e carregado quando o painel monta.

import { activateTab, addTab, emitDocgraphEvent, getSession } from '../runtime.js';
import { STRINGS } from './copy.js';

export const DOCGRAPH_KIND = 'docgraph';

export function docGraphTabId(sessionId) {
  return `docgraph-${sessionId}`;
}

export function findDocGraphTab(session) {
  return session?.editor.tabs.find((tab) => tab.kind === DOCGRAPH_KIND) || null;
}

// Garante a aba do grafo na sessao. `focusPath` pede que o grafo revele e
// selecione aquele caminho assim que o indice estiver pronto; o painel consome
// o pedido, montado ou nao.
export function openDocGraphTab(sessionId, { focusPath = null, activate = true } = {}) {
  const session = getSession(sessionId);
  if (!session) return null;
  if (focusPath) session.docgraph.focusRequest = { path: focusPath, at: Date.now() };
  let tab = findDocGraphTab(session);
  if (!tab) {
    tab = {
      id: docGraphTabId(session.id),
      kind: DOCGRAPH_KIND,
      path: null,
      name: STRINGS.name,
      title: STRINGS.name,
      session: null,
      view: null,
      savedDoc: '',
      dirty: false,
      conflict: null,
      loading: false,
      error: null,
      mode: 'edit',
      watchPath: null,
    };
    addTab(sessionId, tab, { activate });
  } else if (activate) {
    activateTab(sessionId, tab.id);
  }
  emitDocgraphEvent(session.id);
  return tab;
}

/* ── prévia ao lado do grafo ───────────────────────────────────────── */

// A prévia é um painel dentro da própria aba do grafo, não outra aba: a
// pessoa lê o documento sem perder o mapa de vista. Um painel por sessão, que
// troca de documento no lugar em vez de abrir outro.
export function openDocGraphPreview(sessionId, path) {
  const session = getSession(sessionId);
  if (!session || !path) return null;
  const current = session.docgraph.preview;
  if (current?.path !== path) session.docgraph.preview = { path, at: Date.now() };
  emitDocgraphEvent(session.id);
  return session.docgraph.preview;
}

export function closeDocGraphPreview(sessionId) {
  const session = getSession(sessionId);
  if (!session || !session.docgraph.preview) return;
  session.docgraph.preview = null;
  emitDocgraphEvent(session.id);
}

export function docGraphPreview(sessionId) {
  return getSession(sessionId)?.docgraph.preview || null;
}
