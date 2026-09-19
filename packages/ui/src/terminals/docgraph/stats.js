// SPDX-License-Identifier: Apache-2.0
// Contadores e medidas do grafo da documentacao. Existem por dois motivos do
// pedido: provar que abrir e fechar o grafo nao acumula ouvintes, observadores
// nem lacos, e registrar com numeros reais quanto custam a varredura, o layout,
// o desenho e o acerto do ponteiro.
//
// Todo ouvinte, observador e laco do grafo passa por `on` e `off`. A
// verificacao em navegador compara os saldos depois de varios ciclos de abrir
// e fechar com os da primeira montagem. E barato o bastante para ficar ligado
// sempre: sao somas e uma janela curta de amostras.

const live = new Map();
const totals = new Map();
const samples = new Map();
const SAMPLE_WINDOW = 240;

export const track = {
  on(kind) { live.set(kind, (live.get(kind) || 0) + 1); },
  off(kind) { live.set(kind, Math.max(0, (live.get(kind) || 0) - 1)); },
  count(kind, amount = 1) { totals.set(kind, (totals.get(kind) || 0) + amount); },
  sample(kind, value) {
    if (!Number.isFinite(value)) return;
    let list = samples.get(kind);
    if (!list) { list = []; samples.set(kind, list); }
    list.push(value);
    if (list.length > SAMPLE_WINDOW) list.shift();
  },
};

function percentile(list, fraction) {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function liveCounts() {
  return Object.fromEntries(live);
}

export function snapshot() {
  const measured = {};
  samples.forEach((list, kind) => {
    const sum = list.reduce((total, value) => total + value, 0);
    measured[kind] = { n: list.length, avg: list.length ? sum / list.length : null, p95: percentile(list, 0.95), max: list.length ? Math.max(...list) : null };
  });
  return { live: liveCounts(), totals: Object.fromEntries(totals), measured };
}

export function resetSamples() {
  samples.clear();
}
