// SPDX-License-Identifier: Apache-2.0
// Cores do grafo: as paletas, os modos de colorir e a legenda de cada modo.
// Puro, para o script de verificacao testar no Node.
//
// Seguindo a skill dataviz, cada modo da a cor um trabalho so:
//
// - Grupo, pasta e tipo de arquivo dizem identidade, em vagas fixas.
// - Regras tambem dizem identidade, com a cor que a pessoa escolhe para cada
//   uma entre as cores da organizacao. Essa cor nao muda com a paleta.
// - Tamanho e alteracao dizem grandeza, numa rampa de um tom so, do perto da
//   superficie para o longe dela.
//
// No grafo quaisquer duas marcas podem ficar lado a lado, entao a identidade
// vale para todos os pares. O validador da skill mostrou que nenhum conjunto
// de cinco ou mais cores da paleta compartilhada passa assim: as paletas tem
// quatro vagas, e o excedente fica no neutro.
//
// As vagas tem nome, `ciano`, `rosa`, `indigo` e `lima`, os mesmos que o
// estado salvo ja guardava. A paleta decide o tom de cada vaga, entao trocar
// de paleta muda a cor sem mudar que pasta ocupa qual vaga.

import { ORGANIZATION_COLORS } from '../../lib/organization-colors.js';
import { GROUP_TONES, NEUTRAL_TONE, ROOT_ID, computeColorGroups, foldKey, groupOf } from './model.js';

export const COLOR_MODES = ['group', 'folder', 'type', 'size', 'modified', 'rules'];
export const PALETTES = ['safe', 'neon', 'pastel', 'mono'];
export const SEQUENTIAL_MODES = ['size', 'modified'];
export const RULE_LIMIT = 8;
export const RULE_TEXT_LIMIT = 120;
const KB = 1024;
// Quatro limites, cinco faixas: ate 1 KB, 10 KB, 100 KB, 1 MB e acima.
export const SIZE_STEPS = [KB, 10 * KB, 100 * KB, KB * KB];
const DAY = 24 * 60 * 60 * 1000;
// Ultimo dia, ultima semana, ultimo mes, ultimo ano e mais antigo.
export const AGE_STEPS = [DAY, 7 * DAY, 30 * DAY, 365 * DAY];

const ORG = new Map(ORGANIZATION_COLORS.map((color) => [color.id, color]));
const fromOrg = (ids, side) => ids.map((id) => ORG.get(id)[side]);

// Valores conferidos com `validate_palette.js` da skill dataviz, contra as
// superficies #ffffff e #1c1c1e, com todos os pares:
//
// - Segura passa daltonismo, com delta E de 10,3 no claro e 8,5 no escuro, e
//   visao normal acima de 19 nos dois.
// - Neon troca indigo por roxo e lima por laranja e passa nos mesmos testes,
//   com visao normal em 15,4 e 15,9.
// - Pastel clareia em 15% as cores ciano, rosa, indigo e laranja. Passa no
//   claro e fica no piso de daltonismo no escuro, com 7,2, que so vale com
//   codificacao secundaria: a legenda, os rotulos e a lista da busca. O
//   contraste das marcas no claro tambem fica abaixo de 3:1 e pede o mesmo.
// - Mono nao tem identidade por cor: toda vaga vira o neutro e a legenda das
//   categorias some.
//
// A faixa de luminosidade do tema escuro fica acima da faixa da skill em
// todas, como ja acontecia: a paleta compartilhada e clara no escuro para ser
// lida como texto. As rampas passam a checagem ordinal nos dois temas: um tom
// so, degraus de pelo menos 0,06 em L e o degrau mais perto da superficie com
// 2:1 contra ela.
const SPECS = {
  safe: {
    slots: { light: fromOrg(['ciano', 'rosa', 'indigo', 'lima'], 'light'), dark: fromOrg(['ciano', 'rosa', 'indigo', 'lima'], 'dark') },
    ramp: {
      light: ['#62bfde', '#20a0c2', '#007e9c', '#0b5d73', '#053f4e'],
      dark: ['#045f76', '#08809d', '#20a1c4', '#44c4e9', '#92e2fd'],
    },
  },
  neon: {
    slots: { light: fromOrg(['ciano', 'rosa', 'roxo', 'laranja'], 'light'), dark: fromOrg(['ciano', 'rosa', 'roxo', 'laranja'], 'dark') },
    ramp: {
      light: ['#f38dad', '#db618c', '#bb3a6c', '#931c4f', '#680934'],
      dark: ['#8b2f52', '#b9426e', '#e25e8d', '#fe87ae', '#fec1d2'],
    },
  },
  pastel: {
    slots: { light: ['#2da2be', '#e0478b', '#5f56d2', '#ed7130'], dark: ['#43daf1', '#f687c1', '#949df9', '#fca259'] },
    ramp: {
      light: ['#b2a9de', '#9386c5', '#7466a7', '#564983', '#3a2f5b'],
      dark: ['#574d7c', '#7568a5', '#9486ca', '#b4a8e9', '#d5cdfd'],
    },
  },
  mono: {
    slots: null,
    ramp: {
      light: ['#b1b1b1', '#909090', '#717171', '#545454', '#383838'],
      dark: ['#555555', '#737373', '#929292', '#b2b2b2', '#d4d4d4'],
    },
  },
};

export function cleanPalette(value) {
  return PALETTES.includes(value) ? value : 'safe';
}

export function cleanColorMode(value) {
  return COLOR_MODES.includes(value) ? value : 'group';
}

// As cores concretas de uma paleta num tema: as quatro vagas, a rampa e o
// neutro. Mono devolve as vagas no neutro.
export function paletteColors(palette, dark) {
  const spec = SPECS[cleanPalette(palette)];
  const side = dark ? 'dark' : 'light';
  const neutral = ORG.get(NEUTRAL_TONE)[side];
  return {
    dark: Boolean(dark),
    slots: spec.slots ? spec.slots[side] : GROUP_TONES.map(() => neutral),
    ramp: spec.ramp[side],
    neutral,
  };
}

// Chave de tom para cor. A chave e o nome da vaga, `q0` a `q4` para a rampa,
// `c:<cor>` para a cor escolhida numa regra, ou nada para o neutro.
export function toneColor(key, colors) {
  if (!key) return colors.neutral;
  const slot = GROUP_TONES.indexOf(key);
  if (slot >= 0) return colors.slots[slot];
  if (key.length === 2 && key[0] === 'q') return colors.ramp[Number(key[1])] || colors.neutral;
  if (key.startsWith('c:')) {
    const entry = ORG.get(key.slice(2));
    if (entry) return colors.dark ? entry.dark : entry.light;
  }
  return colors.neutral;
}

// Faixa de tamanho de 0 a 4. Arquivo vazio fica na primeira.
export function sizeBin(bytes) {
  const value = Number(bytes) || 0;
  const index = SIZE_STEPS.findIndex((step) => value < step);
  return index < 0 ? SIZE_STEPS.length : index;
}

// Faixa de idade de 0, ultimo dia, a 4, mais de um ano. Sem data, nada.
export function ageBin(modifiedMs, now) {
  const value = Number(modifiedMs);
  if (!Number.isFinite(value) || value <= 0) return null;
  const age = Math.max(0, now - value);
  const index = AGE_STEPS.findIndex((step) => age < step);
  return index < 0 ? AGE_STEPS.length : index;
}

// Tipo de um arquivo pelo nome: a extensao em minusculas. Arquivo que comeca
// com ponto e nao tem outra extensao, como `.gitignore`, e o proprio nome.
// Sem extensao, a chave e vazia.
export function typeKey(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  if (dot > 0 && dot < text.length - 1) return text.slice(dot + 1).toLowerCase();
  if (dot === 0 && text.length > 1) return text.toLowerCase();
  return '';
}

// Vagas para categorias ja ordenadas da maior para a menor. Quem ja tinha
// vaga fica com ela; vaga livre vai para a maior categoria sem vaga.
export function assignTones(ranked, saved = {}, { tones = GROUP_TONES, regroup = false } = {}) {
  const present = new Set(ranked);
  const assigned = {};
  const used = new Set();
  if (!regroup) {
    Object.entries(saved || {}).forEach(([key, tone]) => {
      if (present.has(key) && tones.includes(tone) && !used.has(tone)) { assigned[key] = tone; used.add(tone); }
    });
  }
  const free = tones.filter((tone) => !used.has(tone));
  ranked.forEach((key) => {
    if (!free.length || assigned[key]) return;
    assigned[key] = free.shift();
  });
  return assigned;
}

function sameTones(a, b) {
  return JSON.stringify(Object.entries(a || {}).sort()) === JSON.stringify(Object.entries(b || {}).sort());
}

export function cleanRules(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((rule) => rule && typeof rule.query === 'string' && ORG.has(rule.color))
    .slice(0, RULE_LIMIT)
    .map((rule) => ({ query: rule.query.slice(0, RULE_TEXT_LIMIT), color: rule.color }));
}

// Palavras da regra sobre a forma dobrada do caminho: todas precisam
// aparecer, em qualquer ordem, como na busca.
function ruleTerms(query) {
  return foldKey(query).trim().split(/\s+/).filter(Boolean);
}

// Colore a arvore conforme o modo. Devolve o tom de cada no, a legenda e as
// vagas atualizadas para gravar. `saved` sao as vagas gravadas do modo.
export function colorize(tree, { mode = 'group', saved = {}, rules = [], regroup = false, now = Date.now() } = {}) {
  const kind = cleanColorMode(mode);
  const result = { mode: kind, toneOf: new Map(), legend: [], other: 0, saved: null, changed: false, groupRoots: new Set() };
  if (!tree?.docCount) return result;
  const files = [];
  tree.nodes.forEach((node) => { if (node.kind === 'doc') files.push(node); });

  if (kind === 'group' || kind === 'folder') {
    // Pasta e o corte fixo no primeiro nivel; grupo desce onde um ramo domina.
    const colors = computeColorGroups(tree, saved, { regroup, threshold: kind === 'folder' ? 1 : 0.5 });
    tree.nodes.forEach((node, id) => {
      const group = groupOf(tree, id, colors.tones);
      if (group) result.toneOf.set(id, colors.tones[group]);
    });
    result.legend = colors.groups.map((group) => ({ key: group.tone, kind: 'folder', id: group.id, count: group.docCount }));
    result.other = colors.otherDocs || 0;
    result.saved = colors.tones;
    result.changed = colors.changed;
    colors.groups.forEach((group) => result.groupRoots.add(group.id));
    return result;
  }

  if (kind === 'type') {
    const counts = new Map();
    files.forEach((node) => { const key = typeKey(node.name); counts.set(key, (counts.get(key) || 0) + 1); });
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([key]) => key);
    const assigned = assignTones(ranked, saved, { regroup });
    files.forEach((node) => { const tone = assigned[typeKey(node.name)]; if (tone) result.toneOf.set(node.id, tone); });
    result.legend = Object.entries(assigned)
      .sort((a, b) => GROUP_TONES.indexOf(a[1]) - GROUP_TONES.indexOf(b[1]))
      .map(([ext, tone]) => ({ key: tone, kind: 'type', ext, count: counts.get(ext) || 0 }));
    result.other = files.length - result.legend.reduce((sum, entry) => sum + entry.count, 0);
    result.saved = assigned;
    result.changed = !sameTones(saved, assigned);
    return result;
  }

  if (kind === 'size') {
    const counts = [0, 0, 0, 0, 0];
    files.forEach((node) => { const bin = sizeBin(node.size); counts[bin] += 1; result.toneOf.set(node.id, `q${bin}`); });
    result.legend = counts.map((count, bin) => ({ key: `q${bin}`, kind: 'size', bin, count }));
    return result;
  }

  if (kind === 'modified') {
    const counts = [0, 0, 0, 0, 0];
    files.forEach((node) => {
      const bin = ageBin(node.modifiedMs, now);
      if (bin === null) { result.other += 1; return; }
      counts[bin] += 1;
      // O mais recente fica mais longe da superficie, que e o que chama o olho.
      result.toneOf.set(node.id, `q${4 - bin}`);
    });
    result.legend = counts.map((count, bin) => ({ key: `q${4 - bin}`, kind: 'age', bin, count }));
    return result;
  }

  // Regras proprias: a primeira que casa com o caminho define a cor. Vale para
  // pasta e arquivo, entao uma regra com o nome de uma pasta pinta o ramo todo.
  const prepared = cleanRules(rules).map((rule) => ({ ...rule, terms: ruleTerms(rule.query) })).filter((rule) => rule.terms.length);
  const counts = prepared.map(() => 0);
  tree.nodes.forEach((node, id) => {
    if (id === ROOT_ID) return;
    const at = prepared.findIndex((rule) => rule.terms.every((term) => node.pathKey.includes(term)));
    if (at < 0) { if (node.kind === 'doc') result.other += 1; return; }
    result.toneOf.set(id, `c:${prepared[at].color}`);
    if (node.kind === 'doc') counts[at] += 1;
  });
  result.legend = prepared.map((rule, at) => ({ key: `c:${rule.color}`, kind: 'rule', query: rule.query, count: counts[at] }));
  return result;
}
