// SPDX-License-Identifier: Apache-2.0
// Estado do grafo da documentacao que sobrevive ao fechamento do app, guardado
// por raiz: o que o usuario expandiu e recolheu, a visao da camera, a selecao e
// os tons dos grupos. Recebe o storage de fora, entao o script de verificacao
// testa com um objeto em memoria.
//
// A chave de cada raiz e o caminho canonizado que o Rust devolve, para duas
// sessoes na mesma pasta dividirem o estado mesmo quando uma chegou por link.
// Guarda excecoes ao padrao, nao o conjunto inteiro de pastas expandidas: uma
// pasta nova segue a regra padrao em vez de nascer recolhida. `bulk` lembra um
// Expandir tudo ou Recolher tudo, que nao caberia em lista nenhuma. Posicoes dos nos
// nao entram aqui; ficam em memoria no controlador.

export const STORAGE_KEY = 'cialai_terminals_docgraph';
export const ROOT_LIMIT = 24;
export const OVERRIDE_LIMIT = 200;

function readStore(storage) {
  try {
    const parsed = JSON.parse(storage.getItem(STORAGE_KEY) || 'null');
    if (parsed && parsed.version === 1 && parsed.roots && typeof parsed.roots === 'object') return parsed;
  } catch (_error) { /* sem storage ou conteudo invalido */ }
  return { version: 1, roots: {} };
}

function strings(value, limit) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item).slice(-limit) : [];
}

function cleanView(view) {
  if (!view) return null;
  const { x, y, s } = view;
  return [x, y, s].every((number) => Number.isFinite(number)) && s > 0 ? { x, y, s } : null;
}

function cleanTones(tones) {
  const result = {};
  if (tones && typeof tones === 'object') {
    Object.entries(tones).forEach(([id, tone]) => { if (typeof tone === 'string' && tone) result[id] = tone; });
  }
  return result;
}

function cleanBulk(value) {
  return value === 'all' || value === 'none' ? value : null;
}

export function emptyUi() {
  return { bulk: null, expanded: [], collapsed: [], view: null, selected: null, tones: {}, updatedAt: 0 };
}

export function loadUi(storage, rootKey) {
  if (!rootKey) return null;
  const entry = readStore(storage).roots[rootKey];
  if (!entry || typeof entry !== 'object') return null;
  return {
    bulk: cleanBulk(entry.bulk),
    expanded: strings(entry.expanded, OVERRIDE_LIMIT),
    collapsed: strings(entry.collapsed, OVERRIDE_LIMIT),
    view: cleanView(entry.view),
    selected: typeof entry.selected === 'string' ? entry.selected : null,
    tones: cleanTones(entry.tones),
    updatedAt: Number(entry.updatedAt) || 0,
  };
}

// Grava a raiz e descarta as mais antigas acima do teto.
export function saveUi(storage, rootKey, ui, now = Date.now()) {
  if (!rootKey) return false;
  const store = readStore(storage);
  store.roots[rootKey] = {
    bulk: cleanBulk(ui?.bulk),
    expanded: strings(ui?.expanded, OVERRIDE_LIMIT),
    collapsed: strings(ui?.collapsed, OVERRIDE_LIMIT),
    view: cleanView(ui?.view),
    selected: typeof ui?.selected === 'string' ? ui.selected : null,
    tones: cleanTones(ui?.tones),
    updatedAt: now,
  };
  const keys = Object.keys(store.roots).sort((a, b) => (store.roots[b].updatedAt || 0) - (store.roots[a].updatedAt || 0));
  keys.slice(ROOT_LIMIT).forEach((key) => { delete store.roots[key]; });
  try { storage.setItem(STORAGE_KEY, JSON.stringify(store)); return true; } catch (_error) { return false; }
}

export function forgetUi(storage, rootKey) {
  const store = readStore(storage);
  if (!store.roots[rootKey]) return;
  delete store.roots[rootKey];
  try { storage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (_error) { /* sem storage */ }
}
