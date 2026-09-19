// SPDX-License-Identifier: Apache-2.0
// Preferencias de layout do estudio de terminais: largura e recolhimento das
// colunas, proporcao do editor sobre o terminal, tamanho da fonte e modo
// foco. Ficam em cialai_terminals_layout no armazenamento do webview e sao
// lidas por todos os componentes pelo mesmo assinante.

import { useEffect, useState } from 'react';

const KEY = 'cialai_terminals_layout';
const LEGACY_KEY = 'oc_terminals_layout';

export const LAYOUT_LIMITS = {
  sessions: { min: 200, max: 360, default: 240 },
  explorer: { min: 220, max: 440, default: 260 },
  editorRatio: { min: 0.2, max: 0.85, default: 0.55 },
  // Quanto da aba do grafo fica com o grafo quando a previa esta aberta. A
  // divisao nasce meio a meio, como o pedido de 19/09/2026.
  docgraphRatio: { min: 0.25, max: 0.8, default: 0.5 },
  fontSize: { min: 10, max: 20, default: 12 },
};

const DEFAULTS = {
  sessionsWidth: LAYOUT_LIMITS.sessions.default,
  explorerWidth: LAYOUT_LIMITS.explorer.default,
  sessionsCollapsed: false,
  explorerCollapsed: false,
  editorRatio: LAYOUT_LIMITS.editorRatio.default,
  docgraphRatio: LAYOUT_LIMITS.docgraphRatio.default,
  fontSize: LAYOUT_LIMITS.fontSize.default,
  focus: false,
  // Painel cujo aviso de onde reabrir ja foi mostrado uma vez. Recolher uma
  // coluna esconde a lista inteira, e sem o aviso a pessoa fica sem saber para
  // onde ela foi.
  noticedSessions: false,
  noticedExplorer: false,
};

function clamp(value, limits) {
  return Math.min(limits.max, Math.max(limits.min, value));
}

function sanitize(raw) {
  const next = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return next;
  if (Number.isFinite(raw.sessionsWidth)) next.sessionsWidth = clamp(raw.sessionsWidth, LAYOUT_LIMITS.sessions);
  if (Number.isFinite(raw.explorerWidth)) next.explorerWidth = clamp(raw.explorerWidth, LAYOUT_LIMITS.explorer);
  if (Number.isFinite(raw.editorRatio)) next.editorRatio = clamp(raw.editorRatio, LAYOUT_LIMITS.editorRatio);
  if (Number.isFinite(raw.docgraphRatio)) next.docgraphRatio = clamp(raw.docgraphRatio, LAYOUT_LIMITS.docgraphRatio);
  if (Number.isFinite(raw.fontSize)) next.fontSize = clamp(Math.round(raw.fontSize), LAYOUT_LIMITS.fontSize);
  next.sessionsCollapsed = Boolean(raw.sessionsCollapsed);
  next.explorerCollapsed = Boolean(raw.explorerCollapsed);
  next.noticedSessions = Boolean(raw.noticedSessions);
  next.noticedExplorer = Boolean(raw.noticedExplorer);
  // Modo foco nao sobrevive a reabertura: o app volta com a navegacao.
  next.focus = false;
  return next;
}

function read() {
  try {
    let raw = localStorage.getItem(KEY);
    if (raw == null) {
      raw = localStorage.getItem(LEGACY_KEY);
      if (raw != null) localStorage.setItem(KEY, raw);
    }
    return sanitize(JSON.parse(raw || 'null'));
  } catch (_error) {
    return { ...DEFAULTS };
  }
}

const store = {
  value: read(),
  listeners: new Set(),
};

function write() {
  try {
    const { focus: _focus, ...persisted } = store.value;
    localStorage.setItem(KEY, JSON.stringify(persisted));
  } catch (_error) { /* sem storage */ }
}

export function getLayout() {
  return store.value;
}

export function setLayout(patch) {
  const next = sanitize({ ...store.value, ...patch });
  // O modo foco e a unica chave que nao passa pelo sanitizador.
  if (typeof patch.focus === 'boolean') next.focus = patch.focus;
  else next.focus = store.value.focus;
  const changed = Object.keys(next).some((key) => next[key] !== store.value[key]);
  if (!changed) return store.value;
  store.value = next;
  write();
  store.listeners.forEach((listener) => {
    try { listener(next); } catch (error) { console.error('[terminais/layout]', error); }
  });
  return next;
}

export function subscribeLayout(listener) {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

export function useLayout() {
  const [value, setValue] = useState(store.value);
  useEffect(() => subscribeLayout(setValue), []);
  return value;
}
