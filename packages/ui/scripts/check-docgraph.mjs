// SPDX-License-Identifier: Apache-2.0
// Regras puras do grafo da documentacao: node --test scripts/check-docgraph.mjs
//
// Por que existe: a interface nao tem typecheck nem lint, e as regras que o
// grafo nao pode errar sao todas puras. A poda por Markdown, as contagens que
// nao mudam ao recolher, a diferenca entre dois indices, o descarte da
// resposta de uma raiz anterior, as vistas, os modos de cor, os links entre
// arquivos e a regra de texto do produto sao conferidas aqui, sem DOM e sem
// Tauri. O esperado de cada cenario e escrito a mao, nao
// recalculado pela mesma funcao que esta sendo testada.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  GROUP_TONES, ROOT_ID, absPath, ancestorsOf, attachIssues, buildTree, carryLinks, computeColorGroups, defaultExpansion, degreeOf,
  diffIndex, effectiveExpanded, foldKey, groupOf, idOfPath, isBroadRoot, neighborsOf, parentId, pickWatchDirs, revealSet,
  shouldAdopt, visibleScene,
} from '../src/terminals/docgraph/model.js';
import { matchSet, searchDocs } from '../src/terminals/docgraph/search.js';
import { OVERRIDE_LIMIT, ROOT_LIMIT, STORAGE_KEY, latestOptions, loadUi, saveUi } from '../src/terminals/docgraph/persist.js';
import {
  BLOCK_HEADER, MIN_BLOCK, RING_GAP, TREE_COLUMN, TREE_ROW, blocksLayout, folderBytes, neighborFocus, neighborhood, radialLayout,
  treeLayout, visibleRefs,
} from '../src/terminals/docgraph/views.js';
import {
  COLOR_MODES, PALETTES, ageBin, assignTones, cleanColorMode, cleanPalette, cleanRules, colorize, paletteColors, sizeBin, toneColor,
  typeKey,
} from '../src/terminals/docgraph/colors.js';
import { DEPTH_LIMIT, VIEW_MODES, cleanDepth, cleanScope, cleanViewMode } from '../src/terminals/docgraph/options.js';
import { PITCH_LIMIT, orbitBy, project, rotationOf, seedSpace } from '../src/terminals/docgraph/space.js';
import { buildDemoScan } from '../src/terminals/docgraph/fixture.js';
import { DEBOUNCE_MS, MAX_WAIT_MS, createIndexer } from '../src/terminals/docgraph/indexer.js';
import * as copy from '../src/terminals/docgraph/copy.js';
import { LAYOUT_LIMITS } from '../src/terminals/layout.js';

const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const scanOf = (paths, extra = {}) => ({ docs: paths.map((relative) => ({ relative, size: 10, modifiedMs: 1, symlink: false, target: null })), fingerprint: paths.join('|'), ...extra });
const treeOf = (paths, extra) => buildTree(scanOf(paths, extra), { rootName: 'projeto' });
const ids = (tree, kind) => [...tree.nodes.values()].filter((node) => (kind === 'doc' ? node.kind === 'doc' : node.kind !== 'doc')).map((node) => node.id).sort();

const EXEMPLO = [
  'programas/azul/README.md',
  'programas/azul/arquitetura.md',
  'programas/azul/tarefas.md',
  'programas/verde/docs/instalacao.md',
];

/* ── poda ─────────────────────────────────────────────────────────── */

test('exemplo obrigatorio: quatro documentos, cinco pastas, ramos sem Markdown ausentes', () => {
  const tree = treeOf(EXEMPLO);
  assert.equal(tree.docCount, 4);
  assert.equal(tree.dirCount, 5);
  assert.deepEqual(ids(tree, 'dir'), ['.', 'programas', 'programas/azul', 'programas/verde', 'programas/verde/docs']);
  assert.deepEqual(ids(tree, 'doc'), [...EXEMPLO].sort());
  ['programas/vermelho', 'backend', 'infra'].forEach((id) => assert.equal(tree.nodes.has(id), false, id));
  assert.equal(tree.nodes.get('programas/azul').docs.length, 3);
  assert.equal(tree.nodes.get('programas').docCount, 4);
  assert.equal(tree.nodes.get('programas/verde').docs.length, 0, 'verde so leva a docs, sem Markdown direto');
  assert.equal(tree.nodes.get('programas/verde').docCount, 1);
  assert.deepEqual(ancestorsOf(tree, 'programas/verde/docs/instalacao.md'), ['.', 'programas', 'programas/verde', 'programas/verde/docs']);
});

test('todos os ancestrais ficam, em qualquer profundidade', () => {
  const tree = treeOf(['a/b/c/d/e/f/nota.md']);
  assert.equal(tree.dirCount, 7);
  assert.equal(tree.nodes.get('a/b/c').docCount, 1);
  assert.equal(tree.nodes.get('a/b/c/d/e/f/nota.md').depth, 7);
});

test('Markdown na raiz e nomes repetidos: pai certo, ids distintos, caixa preservada', () => {
  const tree = treeOf(['README.md', 'docs/README.md', 'Docs/readme.md', 'docs/api/README.md']);
  assert.equal(tree.nodes.get('README.md').parent, ROOT_ID);
  assert.equal(tree.nodes.get('docs/README.md').parent, 'docs');
  assert.equal(tree.nodes.get('Docs/readme.md').parent, 'Docs');
  assert.equal(tree.docCount, 4);
  assert.deepEqual(tree.nodes.get(ROOT_ID).docs, ['README.md']);
  assert.ok(tree.nodes.has('Docs') && tree.nodes.has('docs'), 'caixa do disco preservada');
});

test('nenhum Markdown: sem grafo e sem erro', () => {
  const tree = treeOf([]);
  assert.equal(tree.docCount, 0);
  assert.equal(tree.dirCount, 0);
  assert.deepEqual(visibleScene(tree, new Set([ROOT_ID])), { dirs: [], docs: [], links: [], order: [], hiddenDocs: 0 });
  assert.equal(tree.partial, false);
});

test('entradas invalidas sao recusadas sem deixar pasta vazia', () => {
  const tree = buildTree({ docs: [
    { relative: 'ok/a.md' }, { relative: '/abs/b.md' }, { relative: '../fora.md' }, { relative: 'x//y.md' },
    { relative: '' }, { relative: 'ok/a.md' }, { relative: 'ok/a.md/dentro.md' }, { relative: 42 }, null,
  ] });
  assert.deepEqual(ids(tree, 'doc'), ['ok/a.md']);
  assert.deepEqual(ids(tree, 'dir'), ['.', 'ok']);
  assert.equal(tree.rejected, 8);
  tree.nodes.forEach((node) => { if (node.kind !== 'doc') assert.ok(node.docCount > 0, `pasta sem documento: ${node.id}`); });
});

test('caminho absoluto usa a raiz da sessao, e o id volta do caminho', () => {
  assert.equal(absPath('/Users/x/projeto/', 'docs/a.md'), '/Users/x/projeto/docs/a.md');
  assert.equal(absPath('/Users/x/projeto', ROOT_ID), '/Users/x/projeto');
  assert.equal(idOfPath('/Users/x/projeto', '/Users/x/projeto/docs/a.md'), 'docs/a.md');
  assert.equal(idOfPath('/Users/x/projeto', '/Users/x/projeto'), ROOT_ID);
  assert.equal(idOfPath('/Users/x/projeto', '/Users/x/projeto-outro/a.md'), null);
  assert.equal(parentId('a.md'), ROOT_ID);
  assert.equal(parentId(ROOT_ID), null);
});

/* ── contagens e cena ─────────────────────────────────────────────── */

function random(seed) {
  let state = seed;
  return () => { state = (state * 1664525 + 1013904223) % 4294967296; return state / 4294967296; };
}

test('recolher so oculta: visiveis mais contagens das recolhidas dao sempre o total', () => {
  const paths = [];
  for (let a = 0; a < 6; a += 1) for (let b = 0; b < 4; b += 1) for (let c = 0; c < 3; c += 1) paths.push(`area${a}/mod${b}/doc${c}.md`, `area${a}/mod${b}/sub/x${c}.md`);
  paths.push('README.md', 'area0/LEIA.md');
  const tree = treeOf(paths);
  const dirs = ids(tree, 'dir');
  const next = random(7);
  for (let round = 0; round < 200; round += 1) {
    const expanded = new Set(dirs.filter(() => next() < 0.5));
    const scene = visibleScene(tree, expanded);
    const frontier = scene.dirs.filter((id) => !expanded.has(id)).reduce((sum, id) => sum + tree.nodes.get(id).docCount, 0);
    assert.equal(scene.docs.length + frontier, tree.docCount);
    assert.equal(scene.hiddenDocs, frontier);
    assert.equal(scene.links.length, scene.dirs.length - 1);
  }
  assert.equal(tree.docCount, paths.length);
});

test('expansao padrao: tudo aberto quando cabe, por nivel quando nao cabe, decisao congelada', () => {
  const small = treeOf(EXEMPLO);
  assert.deepEqual([...defaultExpansion(small).expanded].sort(), ids(small, 'dir'));

  const paths = [];
  for (let a = 0; a < 5; a += 1) for (let d = 0; d < 40; d += 1) paths.push(`grande${a}/doc${d}.md`);
  paths.push('pequena/a.md');
  const big = treeOf(paths);
  const { expanded, decided } = defaultExpansion(big, { budget: 100 });
  // Raiz custa 6 marcas; cada pasta grande custa 40; a pequena custa 1.
  assert.ok(expanded.has(ROOT_ID));
  assert.deepEqual([...expanded].filter((id) => id.startsWith('grande')).sort(), ['grande0', 'grande1']);
  assert.ok(expanded.has('pequena'), 'a pasta pequena ainda cabe no orcamento');
  // Uma pasta nova e avaliada uma vez; as antigas nao mudam de estado.
  const grown = treeOf([...paths, 'nova/a.md']);
  const again = defaultExpansion(grown, { budget: 100, frozen: decided });
  assert.deepEqual([...again.expanded].filter((id) => id.startsWith('grande')).sort(), ['grande0', 'grande1']);
  assert.equal(again.decided.has('nova'), true);
});

test('excecoes do usuario valem sobre o padrao, so para pastas que existem', () => {
  const tree = treeOf(EXEMPLO);
  const base = defaultExpansion(tree).expanded;
  const effective = effectiveExpanded(tree, base, { expanded: ['sumiu', 'programas/azul/README.md'], collapsed: ['programas/azul', ROOT_ID] });
  assert.equal(effective.has('programas/azul'), false);
  assert.equal(effective.has(ROOT_ID), true, 'a raiz nunca recolhe por excecao gravada');
  assert.equal(effective.has('sumiu'), false);
  assert.equal(effective.has('programas/azul/README.md'), false);
  assert.equal(visibleScene(tree, effective).hiddenDocs, 3);
});

/* ── atualizacao ──────────────────────────────────────────────────── */

test('criar o primeiro Markdown de um ramo inclui os ancestrais', () => {
  const before = treeOf(EXEMPLO);
  const after = treeOf([...EXEMPLO, 'backend/controllers/LEIAME.md']);
  const diff = diffIndex(before, after);
  assert.deepEqual(diff.addedDocs, ['backend/controllers/LEIAME.md']);
  assert.deepEqual(diff.addedDirs.sort(), ['backend', 'backend/controllers']);
  assert.deepEqual(diff.removedDirs, []);
  assert.equal(diff.changed, true);
  assert.equal(after.dirCount, 7);
});

test('remover ou mover o ultimo Markdown poda as pastas que deixaram de levar a documentos', () => {
  const before = treeOf(EXEMPLO);
  const removed = diffIndex(before, treeOf(EXEMPLO.slice(0, 3)));
  assert.deepEqual(removed.removedDocs, ['programas/verde/docs/instalacao.md']);
  assert.deepEqual(removed.removedDirs.sort(), ['programas/verde', 'programas/verde/docs']);

  const moved = treeOf([...EXEMPLO.slice(0, 3), 'programas/azul/instalacao.md']);
  const diff = diffIndex(before, moved);
  assert.deepEqual(diff.removedDirs.sort(), ['programas/verde', 'programas/verde/docs']);
  assert.deepEqual(diff.addedDocs, ['programas/azul/instalacao.md']);
  assert.equal(moved.nodes.get('programas/azul').docCount, 4);
  assert.equal(moved.nodes.get('programas').docCount, 4);
});

test('renomear: documento pareado na mesma pasta, pasta pareada pela subarvore', () => {
  const before = treeOf(EXEMPLO);
  const caseOnly = diffIndex(before, treeOf(['programas/azul/Readme.md', ...EXEMPLO.slice(1)]));
  assert.deepEqual(caseOnly.renamed, [{ from: 'programas/azul/README.md', to: 'programas/azul/Readme.md', kind: 'doc' }]);

  const single = diffIndex(before, treeOf([...EXEMPLO.slice(0, 3), 'programas/verde/docs/guia.md']));
  assert.deepEqual(single.renamed, [{ from: 'programas/verde/docs/instalacao.md', to: 'programas/verde/docs/guia.md', kind: 'doc' }]);

  const dir = diffIndex(before, treeOf(EXEMPLO.map((path) => path.replace('programas/azul/', 'programas/anil/'))));
  assert.deepEqual(dir.renamed, [{ from: 'programas/azul', to: 'programas/anil', kind: 'dir' }]);
  assert.deepEqual(dir.removedDocs.length, 3);
});

test('sem mudanca, nada a fazer', () => {
  const diff = diffIndex(treeOf(EXEMPLO), treeOf(EXEMPLO));
  assert.equal(diff.changed, false);
  assert.deepEqual([diff.addedDocs, diff.removedDocs, diff.addedDirs, diff.removedDirs, diff.renamed], [[], [], [], [], []]);
});

test('um indice completo nao e trocado por um que parou no prazo', () => {
  assert.equal(shouldAdopt(null, { stopped: 'timeout' }), true, 'sem anterior, o parcial e o que ha');
  assert.equal(shouldAdopt({ stopped: null }, { stopped: null }), true);
  assert.equal(shouldAdopt({ stopped: null }, { stopped: 'timeout' }), false);
  assert.equal(shouldAdopt({ stopped: 'limit' }, { stopped: 'timeout' }), true);
  // Pasta sem permissao e deterministica: nao impede a troca.
  assert.equal(shouldAdopt({ stopped: null }, { stopped: null, partial: true }), true);
});

test('leitura parcial marca o ancestral existente mais proximo, e vazio com parcial nao e vazio limpo', () => {
  const tree = buildTree(scanOf(EXEMPLO, { partial: true, issuesTotal: 2, issues: [
    { relative: 'programas/verde/segredo', code: 'denied' }, { relative: 'fora/da/arvore', code: 'io' },
  ] }));
  assert.equal(tree.nodes.get('programas/verde').partial, true);
  assert.equal(tree.nodes.get(ROOT_ID).partial, true, 'sem ancestral no grafo, a raiz leva o aviso');
  assert.equal(tree.nodes.get('programas/azul').partial, false);
  assert.equal(tree.nodes.has('programas/verde/segredo'), false, 'a pasta ilegivel nao vira no');
  assert.equal(tree.dirCount, 5);

  const stopped = buildTree(scanOf([], { partial: true, stopped: 'limit' }));
  assert.equal(stopped.docCount, 0);
  assert.equal(stopped.partial, true);
  assert.equal(stopped.nodes.get(ROOT_ID).partial, true);

  const capped = treeOf(EXEMPLO);
  attachIssues(capped, [{ relative: 'programas', code: 'io' }], 30, null);
  assert.equal(capped.nodes.get(ROOT_ID).partial, true, 'mais ocorrencias do que as detalhadas');
});

/* ── busca ────────────────────────────────────────────────────────── */

test('busca revela documento dentro de pasta recolhida, e a contagem nao muda', () => {
  const tree = treeOf(EXEMPLO);
  const collapsed = new Set([ROOT_ID]);
  assert.equal(visibleScene(tree, collapsed).docs.length, 0);
  assert.equal(tree.nodes.get('programas').docCount, 4);
  const [hit] = searchDocs(tree, 'instalacao');
  assert.equal(hit.id, 'programas/verde/docs/instalacao.md');
  const { expanded, opened } = revealSet(tree, collapsed, hit.id);
  assert.deepEqual(opened, ['programas', 'programas/verde', 'programas/verde/docs']);
  assert.ok(visibleScene(tree, expanded).docs.includes(hit.id));
  assert.equal(expanded.has('programas/azul'), false, 'so o caminho do resultado abre');
  assert.equal(tree.nodes.get('programas').docCount, 4);
});

test('busca sem acento, em NFD, por caminho, por varias palavras e por subsequencia', () => {
  const tree = treeOf(['docs/Instalação.md', 'docs/guia/Relatório Ação.md', 'api/instalacao-rapida.md', 'api/ref/index.md', 'instalacao.md']);
  assert.deepEqual(searchDocs(tree, 'instalacao.md').map((item) => item.id).slice(0, 2), ['instalacao.md', 'docs/Instalação.md']);
  assert.equal(searchDocs(tree, 'INSTALAÇÃO')[0].id, 'instalacao.md');
  assert.equal(searchDocs(tree, 'relatório'.normalize('NFD'))[0].id, 'docs/guia/Relatório Ação.md');
  assert.equal(searchDocs(tree, 'api/ref')[0].id, 'api/ref', 'pasta entra na busca');
  assert.equal(searchDocs(tree, 'api/ref', { includeDirs: false })[0].id, 'api/ref/index.md');
  assert.equal(searchDocs(tree, 'guia acao')[0].id, 'docs/guia/Relatório Ação.md');
  assert.equal(searchDocs(tree, 'dcsgia')[0].id, 'docs/guia');
  assert.deepEqual(searchDocs(tree, 'nao-existe-nada'), []);
  assert.equal(foldKey('Ação'), 'acao');
});

test('busca vazia lista todos os documentos, a alternativa tabular ao grafo', () => {
  const tree = treeOf(EXEMPLO);
  // Ordem de caminho sem distinguir caixa, como o explorador: arquitetura vem
  // antes de README.
  assert.deepEqual(searchDocs(tree, '  ').map((item) => item.id), [
    'programas/azul/arquitetura.md',
    'programas/azul/README.md',
    'programas/azul/tarefas.md',
    'programas/verde/docs/instalacao.md',
  ]);
  assert.equal(searchDocs(tree, '', { limit: 2 }).length, 2);
  assert.equal(matchSet(tree, ''), null);
  assert.deepEqual([...matchSet(tree, 'azul')].sort(), ['programas/azul', ...EXEMPLO.slice(0, 3)].sort());
  // No canvas so acende o que casa de verdade: `pgzl` acha `programas/azul`
  // por subsequencia na lista, mas nao apaga nem acende nada no grafo.
  assert.equal(searchDocs(tree, 'pgzl')[0].id, 'programas/azul');
  assert.equal(matchSet(tree, 'pgzl').size, 0);
});

/* ── cores e observadores ─────────────────────────────────────────── */

test('grupos de cor: corte adaptativo quando um ramo domina', () => {
  const paths = [];
  for (let index = 0; index < 60; index += 1) paths.push(`docs/integrations/apify/pages/api/d${index}.md`);
  for (let index = 0; index < 40; index += 1) paths.push(`docs/integrations/apify/pages/academy/d${index}.md`);
  for (let index = 0; index < 12; index += 1) paths.push(`docs/integrations/apify/pages/legal/d${index}.md`);
  for (let index = 0; index < 8; index += 1) paths.push(`docs/application/d${index}.md`);
  for (let index = 0; index < 6; index += 1) paths.push(`storage/d${index}.md`);
  paths.push('tools/a.md', 'README.md');
  const tree = treeOf(paths);
  const result = computeColorGroups(tree);
  assert.deepEqual(result.tones, {
    'docs/integrations/apify/pages/api': 'ciano',
    'docs/integrations/apify/pages/academy': 'rosa',
    'docs/integrations/apify/pages/legal': 'indigo',
    'docs/application': 'lima',
  });
  assert.equal(groupOf(tree, 'docs/integrations/apify/pages/api/d3.md', result.tones), 'docs/integrations/apify/pages/api');
  assert.equal(groupOf(tree, 'storage/d1.md', result.tones), null, 'o excedente fica no neutro');
  assert.equal(groupOf(tree, 'docs/integrations', result.tones), null, 'o tronco dividido fica neutro');
  assert.equal(result.otherDocs, paths.length - 120);
  assert.deepEqual(GROUP_TONES, ['ciano', 'rosa', 'indigo', 'lima']);
});

test('a cor segue a entidade: sobrevivente nunca e repintado, vaga livre e reocupada', () => {
  const base = ['a/1.md', 'a/2.md', 'a/3.md', 'b/1.md', 'b/2.md', 'c/1.md', 'd/1.md', 'e/1.md'];
  const first = computeColorGroups(treeOf(base));
  assert.deepEqual(first.tones, { a: 'ciano', b: 'rosa', c: 'indigo', d: 'lima' });
  assert.equal(first.changed, true);

  // `e` passa a ser o maior, mas quem ja tinha tom continua com ele.
  const grown = treeOf([...base, 'e/2.md', 'e/3.md', 'e/4.md', 'e/5.md']);
  const second = computeColorGroups(grown, first.tones);
  assert.deepEqual(second.tones, first.tones);
  assert.equal(second.changed, false);

  // `b` some: o tom dele fica livre e vai para o maior sem tom.
  const third = computeColorGroups(treeOf(grown.nodes.size ? [...base.filter((path) => !path.startsWith('b/')), 'e/2.md', 'e/3.md'] : []), first.tones);
  assert.deepEqual(third.tones, { a: 'ciano', c: 'indigo', d: 'lima', e: 'rosa' });

  // Reagrupar ignora o que estava gravado.
  const regrouped = computeColorGroups(grown, first.tones, { regroup: true });
  assert.deepEqual(regrouped.tones, { e: 'ciano', a: 'rosa', b: 'indigo', c: 'lima' });
});

test('observadores: raiz e pastas visiveis, das mais rasas para as mais fundas, ate o teto', () => {
  const tree = treeOf(EXEMPLO);
  const all = new Set(ids(tree, 'dir'));
  assert.deepEqual(pickWatchDirs(tree, all, 3), ['.', 'programas', 'programas/azul']);
  assert.deepEqual(pickWatchDirs(tree, new Set([ROOT_ID])), ['.', 'programas']);
  assert.deepEqual(pickWatchDirs(treeOf([]), new Set()), ['.']);
});

test('raizes amplas pedem confirmacao, projetos nao', () => {
  ['/', '/Users', '/Users/focoamorim', '/Users/focoamorim/', '/Volumes', '/Volumes/ORDINUM-SSD', '/Users/x/Library', '/tmp'].forEach((root) => assert.equal(isBroadRoot(root), true, root));
  ['/Users/focoamorim/Ordinum/Repos/OrdinumTeam/ordinum-control', '/Users/x/Documents', '/Volumes/ORDINUM-SSD/Github Projects (SSD)/x', '/private/tmp/projeto'].forEach((root) => assert.equal(isBroadRoot(root), false, root));
});

/* ── persistencia ─────────────────────────────────────────────────── */

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key) => (data.has(key) ? data.get(key) : null), setItem: (key, value) => { data.set(key, String(value)); }, data };
}

test('estado por raiz: ida e volta, tetos e conteudo invalido', () => {
  const storage = memoryStorage();
  assert.equal(loadUi(storage, '/p'), null);
  saveUi(storage, '/p', { expanded: ['a', 7, ''], collapsed: ['b'], view: { x: 1, y: 2, s: 0.5 }, selected: 'a/x.md', tones: { a: 'ciano', b: 3 } }, 100);
  assert.deepEqual(loadUi(storage, '/p'), {
    bulk: null, expanded: ['a'], collapsed: ['b'], view: { x: 1, y: 2, s: 0.5 }, selected: 'a/x.md', tones: { a: 'ciano' },
    folderTones: {}, typeTones: {}, rules: [], mode: 'map', scope: 'docs', colorBy: 'group', palette: 'safe', depth: 1, refs: true, updatedAt: 100,
  });
  saveUi(storage, '/tudo', { bulk: 'all' }, 100);
  assert.equal(loadUi(storage, '/tudo').bulk, 'all');
  saveUi(storage, '/tudo', { bulk: 'qualquer' }, 100);
  assert.equal(loadUi(storage, '/tudo').bulk, null);

  saveUi(storage, '/nan', { view: { x: Number.NaN, y: 0, s: 1 } }, 101);
  assert.equal(loadUi(storage, '/nan').view, null, 'visao com NaN nunca e gravada');

  const many = Array.from({ length: OVERRIDE_LIMIT + 50 }, (_, index) => `d${index}`);
  saveUi(storage, '/muitas', { expanded: many }, 102);
  assert.equal(loadUi(storage, '/muitas').expanded.length, OVERRIDE_LIMIT);

  for (let index = 0; index < ROOT_LIMIT + 10; index += 1) saveUi(storage, `/r${index}`, {}, 200 + index);
  const roots = Object.keys(JSON.parse(storage.data.get(STORAGE_KEY)).roots);
  assert.equal(roots.length, ROOT_LIMIT);
  assert.equal(roots.includes('/p'), false, 'a mais antiga sai primeiro');
  assert.equal(roots.includes(`/r${ROOT_LIMIT + 9}`), true);

  assert.equal(loadUi(memoryStorage({ [STORAGE_KEY]: '{quebrado' }), '/p'), null);
  assert.equal(loadUi(memoryStorage({ [STORAGE_KEY]: '{"version":9}' }), '/p'), null);
});

/* ── indexador ────────────────────────────────────────────────────── */

function harness() {
  let clock = 0;
  const pending = [];
  const calls = [];
  const cancels = [];
  const results = [];
  const errors = [];
  const timers = {
    setTimeout: (fn, ms) => { const entry = { at: clock + ms, fn }; pending.push(entry); return entry; },
    clearTimeout: (entry) => { const index = pending.indexOf(entry); if (index >= 0) pending.splice(index, 1); },
  };
  const indexer = createIndexer({
    key: 's1',
    bootId: 'boot',
    scan: (key, token, root) => new Promise((resolve, reject) => { calls.push({ key, token, root, resolve, reject }); }),
    cancel: (key, token) => { cancels.push(token); },
    onResult: (result) => results.push(result),
    onError: (error) => errors.push(error),
    now: () => clock,
    timers,
  });
  const flush = async () => { for (let index = 0; index < 6; index += 1) await Promise.resolve(); };
  const advance = async (ms) => {
    clock += ms;
    pending.filter((entry) => entry.at <= clock).forEach((entry) => { pending.splice(pending.indexOf(entry), 1); entry.fn(); });
    await flush();
  };
  return { indexer, calls, cancels, results, errors, flush, advance };
}

test('trocar de projeto durante a indexacao: a resposta antiga e descartada', async () => {
  const h = harness();
  h.indexer.request('/A', { immediate: true });
  await h.flush();
  h.indexer.request('/B', { immediate: true });
  await h.flush();
  assert.deepEqual(h.calls.map((call) => call.root), ['/A', '/B']);
  assert.deepEqual(h.cancels, ['boot:s1:1'], 'a varredura da raiz anterior e cancelada no Rust');
  h.calls[0].resolve({ root: '/A', docs: [{ relative: 'velho.md' }] });
  await h.flush();
  assert.deepEqual(h.results, [], 'nada do projeto anterior chega ao grafo');
  h.calls[1].resolve({ root: '/B', docs: [] });
  await h.flush();
  assert.deepEqual(h.results.map((result) => result.root), ['/B']);
});

test('ida e volta entre duas raizes: so o ultimo pedido vale, mesmo com a mesma raiz', async () => {
  const h = harness();
  h.indexer.request('/A', { immediate: true });
  await h.flush();
  h.indexer.request('/B', { immediate: true });
  await h.flush();
  h.indexer.request('/A', { immediate: true });
  await h.flush();
  // A primeira resposta e de `/A`, a raiz corrente, mas de um pedido antigo.
  h.calls[0].resolve({ root: '/A', docs: [{ relative: 'antigo.md' }] });
  h.calls[1].reject({ code: 'cancelled' });
  await h.flush();
  assert.deepEqual(h.results, []);
  assert.deepEqual(h.errors, [], 'o cancelamento de um pedido antigo nao vira erro na tela');
  h.calls[2].resolve({ root: '/A', docs: [{ relative: 'novo.md' }] });
  await h.flush();
  assert.deepEqual(h.results.map((result) => result.docs[0].relative), ['novo.md']);
});

test('uma rajada de eventos vira no maximo duas varreduras, e a em andamento nunca e cancelada', async () => {
  const h = harness();
  h.indexer.request('/A', { immediate: true });
  await h.flush();
  for (let index = 0; index < 40; index += 1) { h.indexer.request('/A'); await h.advance(50); }
  assert.equal(h.calls.length, 1, 'a varredura em andamento segue sozinha');
  assert.deepEqual(h.cancels, []);
  assert.equal(h.indexer.state().queued, true);
  h.calls[0].resolve({ root: '/A', docs: [] });
  await h.flush();
  assert.equal(h.calls.length, 2, 'uma unica varredura na fila roda em seguida');
  h.calls[1].resolve({ root: '/A', docs: [] });
  await h.flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.results.length, 2);
});

test('debounce de eventos e espera maxima', async () => {
  const h = harness();
  h.indexer.request('/A', { immediate: true });
  await h.flush();
  h.calls[0].resolve({ root: '/A', docs: [] });
  await h.flush();
  h.indexer.request('/A');
  await h.advance(DEBOUNCE_MS - 1);
  assert.equal(h.calls.length, 1);
  await h.advance(1);
  assert.equal(h.calls.length, 2);
  h.calls[1].resolve({ root: '/A', docs: [] });
  await h.flush();
  // Eventos sem parar: o pedido sai ao bater a espera maxima.
  let elapsed = 0;
  while (h.calls.length === 2 && elapsed < MAX_WAIT_MS * 2) { h.indexer.request('/A'); await h.advance(100); elapsed += 100; }
  assert.equal(h.calls.length, 3);
  assert.ok(elapsed <= MAX_WAIT_MS + 100, `saiu em ${elapsed} ms`);
});

test('erro do pedido corrente chega a tela; sair do painel cancela e cala a resposta', async () => {
  const h = harness();
  h.indexer.request('/A', { immediate: true });
  await h.flush();
  h.calls[0].reject({ code: 'not_found', message: 'Pasta do projeto não encontrada' });
  await h.flush();
  assert.equal(h.errors.length, 1);
  h.indexer.request('/A', { immediate: true });
  await h.flush();
  h.indexer.cancel();
  await h.flush();
  assert.deepEqual(h.cancels, ['boot:s1:2']);
  h.calls[1].resolve({ root: '/A', docs: [{ relative: 'tarde.md' }] });
  await h.flush();
  assert.deepEqual(h.results, []);
  h.indexer.dispose();
  h.indexer.request('/A', { immediate: true });
  await h.flush();
  assert.equal(h.calls.length, 2, 'descartado nao varre mais');
});

/* ── previa ao lado do grafo ──────────────────────────────────────── */

test('as acoes por caminho do grafo existem no estudio', () => {
  const pane = source('../src/terminals/ui/DocGraphPane.jsx');
  const bench = source('../src/terminals/ui/Workbench.jsx');
  // O cartao de detalhes e o menu do grafo chamam as tres por caminho. Sem
  // elas no objeto de acoes, Visualizar e Abrir no editor nao faziam nada e
  // o console ficava com `actions.previewPath is not a function`.
  for (const action of ['openPath', 'previewPath', 'revealInExplorer']) {
    assert.match(pane, new RegExp(`actions\\.${action}\\(`), `o grafo chama ${action}`);
  }
  assert.match(bench, /openPath,/);
  assert.match(bench, /previewPath,/);
  assert.match(bench, /revealInExplorer: revealPathInExplorer,/);
  assert.match(bench, /openDocGraphPreview\(current\.id, path\)/, 'Visualizar abre a previa da sessao');
  assert.match(bench, /openFile\(current\.id, path\)/, 'Abrir no editor continua abrindo o arquivo');
});

test('a divisao nasce meio a meio, e o divisor tem limites proprios', () => {
  assert.equal(LAYOUT_LIMITS.docgraphRatio.default, 0.5);
  assert.ok(LAYOUT_LIMITS.docgraphRatio.min > 0 && LAYOUT_LIMITS.docgraphRatio.min < 0.5);
  assert.ok(LAYOUT_LIMITS.docgraphRatio.max > 0.5 && LAYOUT_LIMITS.docgraphRatio.max < 1);
});

test('um painel de previa por sessao, reaproveitado ao trocar de documento', () => {
  const tab = source('../src/terminals/docgraph/tab.js');
  // O documento fica na sessao, num campo so: escolher outro troca o
  // conteudo no lugar em vez de empilhar painel.
  assert.match(tab, /session\.docgraph\.preview = \{ path, at: Date\.now\(\) \}/);
  assert.match(tab, /export function closeDocGraphPreview/);
  const pane = source('../src/terminals/ui/DocGraphPane.jsx');
  assert.match(pane, /closeDocGraphPreview\(session\.id\)/, 'fechar devolve a area ao grafo');
  assert.match(pane, /if \(!previewPath\) return body;/, 'sem previa o grafo ocupa a aba inteira');
});

test('a previa trata documento apagado e leitura que falhou', () => {
  const preview = source('../src/terminals/ui/DocGraphPreview.jsx');
  assert.match(preview, /status: 'missing'/);
  assert.match(preview, /status: 'error'/);
  assert.match(preview, /previewMissing/);
  assert.match(preview, /previewFailed/);
  // O documento muda no disco enquanto esta aberto: a previa rele.
  assert.match(preview, /watchPathAs\(owner, path\)/);
  assert.match(preview, /unwatchPathAs\(owner, path\)/);
});

/* ── links entre arquivos ─────────────────────────────────────────── */

test('links por indice: sem repeticao, sem laco e sem indice invalido', () => {
  const tree = treeOf(['a.md', 'b.md', 'c/d.md'], { links: [[0, 1], [0, 1], [1, 1], [2, 0], [5, 0], [0, -1], 'x', [0.5, 1]], linksPartial: true });
  assert.equal(tree.links.count, 2);
  assert.deepEqual(tree.links.out.get('a.md'), ['b.md']);
  assert.deepEqual(tree.links.out.get('c/d.md'), ['a.md']);
  assert.deepEqual(tree.links.into.get('a.md'), ['c/d.md']);
  assert.equal(tree.links.partial, true);
  assert.equal(degreeOf(tree, 'a.md'), 2);
  assert.deepEqual([...neighborsOf(tree, 'a.md')].sort(), ['b.md', 'c/d.md']);
  assert.equal(treeOf(['a.md']).links.count, 0, 'varredura antiga, sem links, vira grafo sem links');
});

test('links cortados pelo prazo guardam os da leitura anterior entre arquivos que ficaram', () => {
  const before = treeOf(['a.md', 'b.md', 'c.md'], { links: [[0, 1], [1, 2], [2, 0]] });
  // A leitura nova parou no prazo: leu so a.md, e c.md saiu do indice.
  const cut = treeOf(['a.md', 'b.md', 'd.md'], { links: [[0, 2]], linksPartial: true });
  assert.equal(carryLinks(cut, before), 1, 'so a->b volta: b->c e c->a apontam para quem saiu');
  assert.deepEqual(cut.links.out.get('a.md'), ['d.md', 'b.md']);
  assert.deepEqual(cut.links.into.get('b.md'), ['a.md']);
  assert.equal(cut.links.count, 2);
  // Leitura completa nao herda nada: o que sumiu sumiu de verdade.
  const full = treeOf(['a.md', 'b.md'], { links: [] });
  assert.equal(carryLinks(full, before), 0);
  assert.equal(full.links.count, 0);
  // O controlador herda so no mesmo escopo e volta logo quando a leitura avanca.
  const controller = source('../src/terminals/docgraph/controller.js');
  assert.match(controller, /if \(controller\.tree && sameScope\) carryLinks\(next, controller\.tree\)/);
  assert.match(controller, /meta\.linksPartial && !meta\.stopped && Number\(scan\.linksRead\) > 0/);
});

test('links na cena: a ponta vai para a pasta recolhida que a contem, com peso', () => {
  // x/a cita y/c e x/b; x/b cita y/c; z cita x/a.
  const tree = treeOf(['x/a.md', 'x/b.md', 'y/c.md', 'z.md'], { links: [[0, 2], [1, 2], [0, 1], [3, 0]] });
  const visible = new Set(['.', 'x', 'y', 'z.md']);
  const result = visibleRefs(tree, (id) => visible.has(id));
  assert.equal(result.total, 2, 'x/a para x/b cai dentro de x e some');
  assert.deepEqual(result.refs.find((ref) => ref.b === 'y'), { a: 'x', b: 'y', weight: 2 });
  assert.deepEqual(result.refs.find((ref) => ref.b === 'z.md'), { a: 'x', b: 'z.md', weight: 1 });
  assert.deepEqual(visibleRefs(tree, (id) => visible.has(id), { cap: 1 }).refs, [{ a: 'x', b: 'y', weight: 2 }], 'acima do teto fica o mais pesado');
  const open = new Set(['.', 'x', 'x/a.md', 'x/b.md', 'y', 'z.md']);
  assert.equal(visibleRefs(tree, (id) => open.has(id)).total, 4);
});

/* ── vistas ───────────────────────────────────────────────────────── */

test('vistas: nome valido, escopo e profundidade limpos', () => {
  assert.deepEqual(VIEW_MODES, ['map', 'tree', 'radial', 'blocks', 'neighbors', 'space']);
  assert.equal(cleanViewMode('tree'), 'tree');
  assert.equal(cleanViewMode('pizza'), 'map');
  assert.equal(cleanScope('project'), 'project');
  assert.equal(cleanScope(undefined), 'docs');
  assert.equal(DEPTH_LIMIT, 3);
  assert.equal(cleanDepth(0), 1);
  assert.equal(cleanDepth('2'), 2);
  assert.equal(cleanDepth(9), 3);
  assert.equal(cleanDepth('nada'), 1);
});

test('arvore: camadas da esquerda para a direita e pasta recolhida como folha', () => {
  const tree = treeOf(['a/x.md', 'a/y.md', 'b/z.md', 'r.md']);
  const layout = treeLayout(tree, new Set(['.', 'a']));
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.deepEqual([...byId.keys()].sort(), ['.', 'a', 'a/x.md', 'a/y.md', 'b', 'r.md']);
  assert.equal(byId.get('.').x, 0);
  assert.equal(byId.get('a').x, TREE_COLUMN);
  assert.equal(byId.get('a/x.md').x, 2 * TREE_COLUMN);
  assert.equal(byId.get('a').side, 'left', 'pasta aberta leva o rotulo a esquerda');
  assert.equal(byId.get('b').side, 'right', 'pasta recolhida e folha, rotulo a direita');
  assert.equal(Math.abs(byId.get('a/y.md').y - byId.get('a/x.md').y), TREE_ROW, 'irmaos a uma linha de distancia');
  assert.equal(layout.edges.length, 5);
  assert.ok(layout.nodes.every((node) => node.x > layout.bounds.x && node.x < layout.bounds.x + layout.bounds.w && node.y > layout.bounds.y && node.y < layout.bounds.y + layout.bounds.h));
});

test('radial: raiz no centro e um anel por nivel', () => {
  const tree = treeOf(['a/x.md', 'b/y.md']);
  const layout = radialLayout(tree, new Set(['.', 'a', 'b']));
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get('.').x, 0);
  assert.equal(byId.get('.').y, 0);
  assert.equal(byId.get('a').r, RING_GAP);
  assert.equal(byId.get('a/x.md').r, 2 * RING_GAP);
  layout.nodes.forEach((node) => {
    assert.ok(Math.abs(Math.hypot(node.x, node.y) - node.r) < 1e-6, node.id);
    if (node.id !== '.') assert.equal(node.side, node.x < -0.5 ? 'left' : 'right', node.id);
  });
});

test('blocos: area pelos bytes, piso por arquivo e pasta recolhida inteira', () => {
  const scan = {
    docs: [
      { relative: 'a/grande.md', size: 30000, modifiedMs: 1 },
      { relative: 'a/pequeno.md', size: 10, modifiedMs: 1 },
      { relative: 'b/medio.md', size: 10000, modifiedMs: 1 },
    ],
    fingerprint: 'blocos',
  };
  const tree = buildTree(scan, { rootName: 'p' });
  const bytes = folderBytes(tree);
  assert.equal(bytes.get('a'), 30000 + MIN_BLOCK);
  assert.equal(bytes.get('.'), 30000 + MIN_BLOCK + 10000);
  const layout = blocksLayout(tree, new Set(['.', 'a']), { width: 1000, height: 600 });
  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  assert.equal(byId.has('b/medio.md'), false, 'pasta recolhida nao abre os arquivos');
  assert.equal(byId.get('b').open, false);
  assert.equal(byId.get('b').value, 10000);
  assert.equal(byId.get('a').value, 30000 + MIN_BLOCK);
  assert.equal(byId.get('a/pequeno.md').value, MIN_BLOCK);
  assert.equal(byId.get('.').header, true, 'a raiz sempre tem a faixa do nome');
  assert.ok(byId.get('a').rect.y0 >= BLOCK_HEADER);
  const area = (id) => { const rect = byId.get(id).rect; return (rect.x1 - rect.x0) * (rect.y1 - rect.y0); };
  assert.ok(area('a') > area('b'), 'quem pesa mais ocupa mais');
  layout.nodes.forEach((node) => {
    const rect = node.rect;
    assert.ok(rect.x0 >= 0 && rect.y0 >= 0 && rect.x1 <= 1000 && rect.y1 <= 600, node.id);
  });
});

test('vizinhos: foco, passos, teto e quem trouxe cada arquivo', () => {
  // a cita b e e; b cita c; c cita d; f nao tem link.
  const tree = treeOf(['a.md', 'b.md', 'c.md', 'd.md', 'e.md', 'f.md', 'g/h.md'], { links: [[0, 1], [1, 2], [2, 3], [0, 4]] });
  assert.equal(neighborFocus(tree, 'c.md'), 'c.md', 'arquivo selecionado e o foco');
  assert.equal(neighborFocus(tree, null), 'a.md', 'empate de grau fica com o primeiro caminho');
  assert.equal(neighborFocus(tree, 'g'), null, 'pasta sem arquivo ligado nao tem foco');
  assert.equal(neighborFocus(treeOf(['a.md']), null), null);
  const ids = (hood) => hood.nodes.map((node) => node.id);
  assert.deepEqual(ids(neighborhood(tree, 'a.md', 1)), ['a.md', 'b.md', 'e.md'], 'no mesmo passo entra antes o mais ligado');
  const two = neighborhood(tree, 'a.md', 2);
  assert.deepEqual(ids(two), ['a.md', 'b.md', 'e.md', 'c.md']);
  assert.equal(two.nodes.find((node) => node.id === 'c.md').via, 'b.md');
  assert.equal(two.nodes.find((node) => node.id === 'c.md').ring, 2);
  assert.deepEqual(two.edges, [{ source: 'a.md', target: 'b.md' }, { source: 'a.md', target: 'e.md' }, { source: 'b.md', target: 'c.md' }]);
  assert.deepEqual(ids(neighborhood(tree, 'a.md', 9)), ['a.md', 'b.md', 'e.md', 'c.md', 'd.md'], 'profundidade passa pelo teto de tres');
  const capped = neighborhood(tree, 'a.md', 3, 2);
  assert.deepEqual(ids(capped), ['a.md', 'b.md']);
  assert.equal(capped.capped, true);
  assert.deepEqual(neighborhood(tree, 'f.md', 2), { nodes: [{ id: 'f.md', ring: 0, via: null }], edges: [], capped: false });
});

test('3D: giro com teto no angulo vertical, projecao e semente estavel', () => {
  assert.deepEqual(orbitBy({ yaw: 0, pitch: 0 }, 0.5, 9), { yaw: 0.5, pitch: PITCH_LIMIT });
  assert.deepEqual(orbitBy({ yaw: 0, pitch: 0 }, 0, -9), { yaw: 0, pitch: -PITCH_LIMIT });
  const flat = project(10, 20, 0, rotationOf({ yaw: 0, pitch: 0 }), 300);
  assert.deepEqual(flat, { x: 10, y: 20, depth: 0, k: 1 }, 'sem giro e sem profundidade, o ponto fica onde esta');
  const far = project(0, 0, 100, rotationOf({ yaw: 0, pitch: 0 }), 300);
  assert.equal(far.depth, 100);
  assert.equal(far.k, 0.75, 'longe da camera fica menor');
  const turned = project(10, 0, 0, rotationOf({ yaw: Math.PI / 2, pitch: 0 }), 300);
  assert.ok(Math.abs(turned.x) < 1e-9 && Math.abs(turned.depth + 10) < 1e-9, 'um quarto de volta leva o eixo x para a profundidade');
  const tree = treeOf(['a/x.md', 'b.md']);
  const seed = () => {
    const nodes = new Map([['.', { kind: 'root' }], ['a', { kind: 'dir' }], ['a/x.md', { kind: 'doc' }], ['b.md', { kind: 'doc' }]]);
    seedSpace(tree, nodes);
    return [...nodes.values()].map((node) => [node.x, node.y, node.z]);
  };
  assert.deepEqual(seed(), seed(), 'a mesma arvore nasce sempre igual');
  assert.deepEqual(seed()[0], [0, 0, 0], 'a raiz nasce na origem');
});

/* ── cores ────────────────────────────────────────────────────────── */

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

test('cores: faixas de tamanho e de idade, e tipo pelo nome', () => {
  assert.deepEqual([0, 1023, 1024, 10 * 1024 - 1, 10 * 1024, 100 * 1024, 1024 * 1024, 5e9].map(sizeBin), [0, 0, 1, 1, 2, 3, 4, 4]);
  assert.deepEqual([NOW - 1000, NOW - 2 * DAY, NOW - 10 * DAY, NOW - 100 * DAY, NOW - 400 * DAY, NOW + 5000].map((ms) => ageBin(ms, NOW)), [0, 1, 2, 3, 4, 0]);
  assert.equal(ageBin(null, NOW), null);
  assert.equal(ageBin(0, NOW), null);
  assert.equal(typeKey('README.md'), 'md');
  assert.equal(typeKey('App.JSX'), 'jsx');
  assert.equal(typeKey('.gitignore'), '.gitignore');
  assert.equal(typeKey('Makefile'), '');
  assert.equal(typeKey('nota.'), '');
});

test('vagas de cor: quem tinha fica, a livre vai para a maior e reagrupar refaz', () => {
  assert.deepEqual(assignTones(['md', 'js', 'py', 'rs', 'go'], { js: 'ciano' }), { js: 'ciano', md: 'rosa', py: 'indigo', rs: 'lima' });
  assert.deepEqual(assignTones(['md', 'js', 'py', 'rs', 'go'], { js: 'ciano' }, { regroup: true }), { md: 'ciano', js: 'rosa', py: 'indigo', rs: 'lima' });
  assert.deepEqual(assignTones(['md'], { velho: 'ciano' }), { md: 'ciano' }, 'vaga de categoria que sumiu fica livre');
  assert.deepEqual(assignTones(['a', 'b'], { a: 'ciano', b: 'ciano' }), { a: 'ciano', b: 'rosa' }, 'vaga repetida no estado gravado vale uma vez');
  assert.deepEqual(assignTones(['a'], { a: 'roxo' }), { a: 'ciano' }, 'vaga que nao existe e descartada');
});

test('modos de cor: tipo, tamanho, data e regras, cada um com a sua legenda', () => {
  const tree = buildTree({
    docs: [
      { relative: 'src/app.js', size: 500, modifiedMs: NOW - 1000 },
      { relative: 'src/util.js', size: 20000, modifiedMs: NOW - 3 * DAY },
      { relative: 'docs/guia.md', size: 2048, modifiedMs: NOW - 40 * DAY },
      { relative: 'Makefile', size: 2_000_000, modifiedMs: null },
    ],
    fingerprint: 'cores',
  }, { rootName: 'p' });
  assert.deepEqual(COLOR_MODES, ['group', 'folder', 'type', 'size', 'modified', 'rules']);
  assert.equal(cleanColorMode('arco-iris'), 'group');

  const type = colorize(tree, { mode: 'type', now: NOW });
  assert.deepEqual(type.legend.map((entry) => [entry.ext, entry.key, entry.count]), [['js', 'ciano', 2], ['', 'rosa', 1], ['md', 'indigo', 1]]);
  assert.equal(type.toneOf.get('src/app.js'), 'ciano');
  assert.equal(type.toneOf.has('src'), false, 'no modo tipo a pasta fica neutra');
  assert.equal(type.other, 0);
  assert.deepEqual(type.saved, { js: 'ciano', '': 'rosa', md: 'indigo' });

  const size = colorize(tree, { mode: 'size', now: NOW });
  assert.deepEqual(size.legend.map((entry) => [entry.key, entry.count]), [['q0', 1], ['q1', 1], ['q2', 1], ['q3', 0], ['q4', 1]]);
  assert.equal(size.toneOf.get('Makefile'), 'q4');

  const age = colorize(tree, { mode: 'modified', now: NOW });
  assert.deepEqual(age.legend.map((entry) => [entry.bin, entry.key, entry.count]), [[0, 'q4', 1], [1, 'q3', 1], [2, 'q2', 0], [3, 'q1', 1], [4, 'q0', 0]]);
  assert.equal(age.toneOf.get('src/app.js'), 'q4', 'o mais recente fica no fim da rampa, que chama o olho');
  assert.equal(age.other, 1, 'arquivo sem data vai para o neutro');

  const rules = colorize(tree, {
    mode: 'rules',
    rules: [{ query: 'SRC util', color: 'verde' }, { query: 'src', color: 'azul' }, { query: '   ', color: 'rosa' }, { query: 'x', color: 'naoexiste' }],
  });
  assert.equal(rules.toneOf.get('src/util.js'), 'c:verde', 'vale a primeira regra que combina');
  assert.equal(rules.toneOf.get('src/app.js'), 'c:azul');
  assert.equal(rules.toneOf.get('src'), 'c:azul', 'a regra pinta a pasta tambem');
  assert.equal(rules.toneOf.has('docs/guia.md'), false);
  assert.deepEqual(rules.legend.map((entry) => [entry.query, entry.key, entry.count]), [['SRC util', 'c:verde', 1], ['src', 'c:azul', 1]]);
  assert.equal(rules.other, 2);
  assert.deepEqual(cleanRules([{ query: 'a'.repeat(300), color: 'azul' }, { query: 1, color: 'azul' }, null]), [{ query: 'a'.repeat(120), color: 'azul' }]);
  assert.equal(cleanRules(Array.from({ length: 20 }, () => ({ query: 'x', color: 'azul' }))).length, 8);
});

test('paletas: quatro vagas, rampa de cinco degraus e mono sem identidade', () => {
  const luminance = (hex) => {
    const value = Number.parseInt(hex.slice(1), 16);
    const channel = (raw) => { const part = raw / 255; return part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * channel((value >> 16) & 255) + 0.7152 * channel((value >> 8) & 255) + 0.0722 * channel(value & 255);
  };
  assert.deepEqual(PALETTES, ['safe', 'neon', 'pastel', 'mono']);
  PALETTES.forEach((palette) => [false, true].forEach((dark) => {
    const colors = paletteColors(palette, dark);
    assert.equal(colors.slots.length, 4, palette);
    assert.equal(colors.ramp.length, 5, palette);
    [...colors.slots, ...colors.ramp, colors.neutral].forEach((hex) => assert.match(hex, /^#[0-9a-f]{6}$/i, `${palette} ${hex}`));
    // A rampa sai de perto da superficie e vai para longe dela.
    const steps = colors.ramp.map(luminance);
    steps.slice(1).forEach((value, at) => assert.ok(dark ? value > steps[at] : value < steps[at], `${palette} ${dark ? 'escuro' : 'claro'} degrau ${at + 1}`));
  }));
  const mono = paletteColors('mono', false);
  assert.ok(mono.slots.every((hex) => hex === mono.neutral));
  const safe = paletteColors('safe', false);
  assert.equal(toneColor('ciano', safe), '#0891b2', 'a Segura e a paleta compartilhada de sempre');
  assert.equal(toneColor('q0', safe), '#62bfde');
  assert.equal(toneColor('c:verde', safe), '#1f9d5b');
  assert.equal(toneColor('c:verde', paletteColors('safe', true)), '#3ccf76');
  assert.equal(toneColor(null, safe), safe.neutral);
  assert.equal(toneColor('q9', safe), safe.neutral);
  assert.equal(toneColor('ciano', paletteColors('neon', false)), toneColor('ciano', safe), 'trocar de paleta nao muda que pasta ocupa qual vaga');
  assert.equal(cleanPalette('arco-iris'), 'safe');
});

/* ── opcoes gravadas ──────────────────────────────────────────────── */

test('opcoes do grafo: gravadas por raiz, limpas e herdadas por uma raiz nova', () => {
  const storage = memoryStorage();
  assert.deepEqual(latestOptions(storage), { mode: 'map', scope: 'docs', colorBy: 'group', palette: 'safe', depth: 1, refs: true });
  saveUi(storage, '/a', {
    mode: 'space', scope: 'project', colorBy: 'rules', palette: 'neon', depth: 9, refs: false,
    rules: [{ query: 'src', color: 'verde' }, { query: 7, color: 'azul' }], folderTones: { x: 'rosa' }, typeTones: { md: 'ciano', '': 'lima' },
  }, 100);
  const loaded = loadUi(storage, '/a');
  assert.deepEqual(
    [loaded.mode, loaded.scope, loaded.colorBy, loaded.palette, loaded.depth, loaded.refs],
    ['space', 'project', 'rules', 'neon', 3, false],
  );
  assert.deepEqual(loaded.rules, [{ query: 'src', color: 'verde' }]);
  assert.deepEqual(loaded.folderTones, { x: 'rosa' });
  assert.deepEqual(loaded.typeTones, { md: 'ciano', '': 'lima' });
  saveUi(storage, '/b', { mode: 'nada', palette: 'arco-iris', colorBy: 'magia', scope: 'tudo' }, 200);
  const bad = loadUi(storage, '/b');
  assert.deepEqual([bad.mode, bad.palette, bad.colorBy, bad.scope], ['map', 'safe', 'group', 'docs']);
  saveUi(storage, '/c', { mode: 'tree', palette: 'pastel', rules: [{ query: 'x', color: 'azul' }] }, 300);
  assert.deepEqual(latestOptions(storage), { mode: 'tree', scope: 'docs', colorBy: 'group', palette: 'pastel', depth: 1, refs: true }, 'regras e vagas nao passam para a raiz nova');
});

/* ── demonstracao ─────────────────────────────────────────────────── */

test('demonstracao: links por indice dentro da lista, e codigo so no projeto inteiro', () => {
  ['small', 'real', 'partial'].forEach((scenario) => {
    const docs = buildDemoScan('/p', scenario, 'docs');
    const project = buildDemoScan('/p', scenario, 'project');
    assert.equal(docs.scope, 'docs');
    assert.equal(project.scope, 'project');
    assert.ok(docs.docs.every((doc) => doc.relative.endsWith('.md')), scenario);
    assert.ok(project.docs.length > docs.docs.length, scenario);
    [docs, project].forEach((scan) => {
      assert.ok(scan.links.length > 0, scenario);
      scan.links.forEach(([from, to]) => {
        assert.ok(Number.isInteger(from) && Number.isInteger(to) && from !== to && from < scan.docs.length && to < scan.docs.length, `${scenario} ${from} ${to}`);
      });
      assert.equal(buildTree(scan, { rootName: 'p' }).links.count, scan.links.length, `${scenario} sem par repetido`);
    });
    assert.ok(docs.links.every(([from, to]) => docs.docs[from].relative.endsWith('.md') && docs.docs[to].relative.endsWith('.md')));
    assert.notEqual(docs.fingerprint, project.fingerprint);
  });
  assert.deepEqual(buildDemoScan('/p', 'empty', 'project').links, []);
});

test('o painel tem o seletor de vista, as opcoes e o giro do 3D', () => {
  const pane = source('../src/terminals/ui/DocGraphPane.jsx');
  assert.match(pane, /VIEW_MODES\.map/);
  assert.match(pane, /<GraphOptions/);
  assert.doesNotMatch(pane, /controller\.groups/, 'os grupos agora moram em controller.colors');
  // A cor de uma regra e escolhida, nao sai da paleta: a legenda das regras
  // fica na monocromatica, e o seletor de paleta some no modo de regras.
  const overlays = source('../src/terminals/ui/DocGraphOverlays.jsx');
  assert.match(overlays, /palette === 'mono' && CATEGORICAL\.includes\(mode\)\) return null/);
  assert.match(overlays, /colorBy === 'rules' \? \(\s*<RulesEditor[^]*?\) : \(\s*<Section title=\{STRINGS\.palette\}/);
  const interaction = source('../src/terminals/docgraph/interaction.js');
  assert.match(interaction, /api\.rotate\(sessionId/);
  assert.match(interaction, /panInstead\(event\)/, 'vista sem arraste de marca desloca a camera');
  const renderer = source('../src/terminals/docgraph/renderer.js');
  ['drawLayout()', 'drawBlocks()', 'drawSpace()', 'pickLayout(sx, sy)', 'locateLayout(at)'].forEach((name) => assert.ok(renderer.includes(name), name));
  // O 3D desenha no proprio canvas 2D: WebGL disputaria contexto com os terminais.
  assert.doesNotMatch(renderer, /getContext\('webgl/);
  // O painel, como o motor, fica fora da primeira pintura do estudio, que tem
  // orcamento de payload em tools/check/performance.mjs.
  const editor = source('../src/terminals/ui/EditorPane.jsx');
  assert.match(editor, /lazy\(\(\) => import\('\.\/DocGraphPane\.jsx'\)\)/);
  assert.doesNotMatch(editor, /^import DocGraphPane/m);
});

/* ── texto visivel ────────────────────────────────────────────────── */

test('texto visivel sem parenteses, sem travessao separador e com plural certo', () => {
  const samples = [
    ...Object.values(copy.STRINGS),
    copy.docsCount(1), copy.docsCount(271), copy.foldersCount(1), copy.foldersCount(5), copy.subfoldersCount(1), copy.subfoldersCount(3),
    copy.issuesCount(1), copy.issuesCount(4), copy.moreIssues(1), copy.moreIssues(9), copy.badgeCount(12400), copy.indexingProgress(5),
    ...['denied', 'io', 'depth', 'limit', 'timeout'].map(copy.issueReason),
    ...copy.excludedLines({ symlinkDirs: 1, outsideRoot: 2, brokenLinks: 1, cacheDirs: 3, invalidNames: 1 }),
    copy.nodeAnnouncement({ kind: 'dir', name: 'docs', docCount: 12 }, { expanded: true }),
    copy.nodeAnnouncement({ kind: 'doc', name: 'a.md', parent: 'docs' }),
    copy.nodeAnnouncement({ kind: 'root', name: '', docCount: 1 }, { rootName: 'projeto' }),
    copy.countsAnnouncement(977, 204), copy.fmtSize(1), copy.fmtSize(2048), copy.fmtSize(5 * 1024 * 1024), copy.fmtModified(1789000000000),
    copy.previewOf('README.md'),
    copy.filesCount(1), copy.filesCount(3), copy.itemsCount(2, 'project'), copy.linksCount(1), copy.linksCount(40), copy.neighborsCapped(300), copy.rulesLimit(8),
    ...VIEW_MODES.map(copy.viewName), ...COLOR_MODES.map(copy.colorModeName), ...PALETTES.map(copy.paletteName),
    ...[0, 1, 2, 3, 4].map((bin) => copy.sizeBinLabel(bin, [1024, 10240, 102400, 1048576])), ...[0, 1, 2, 3, 4].map(copy.ageBinLabel),
    copy.typeLabel('md'), copy.typeLabel(''), copy.typeLabel('.gitignore'), copy.indexingProgress(1, 'project'),
    copy.nodeAnnouncement({ kind: 'doc', name: 'app.js', parent: 'src' }, { scope: 'project' }),
    copy.countsAnnouncement(10, 2, 'project'),
    ...['preview', 'previewWidth', 'previewReload', 'previewClose', 'previewCloseTitle', 'previewDetach', 'previewDetachTitle', 'previewLoading', 'previewMissing', 'previewFailed'].map((key) => copy.STRINGS[key]),
  ];
  samples.forEach((text) => {
    assert.equal(typeof text, 'string');
    assert.doesNotMatch(text, /[()]/, `parenteses em: ${text}`);
    assert.doesNotMatch(text, /\s[-–—]\s|[–—]/, `travessao em: ${text}`);
  });
  assert.equal(copy.docsCount(1), '1 documento');
  assert.equal(copy.docsCount(271), '271 documentos');
  assert.equal(copy.docsCount(1204), '1.204 documentos');
  assert.equal(copy.badgeCount(271), '271');
  assert.equal(copy.badgeCount(1204), '1.204');
  assert.equal(copy.badgeCount(12400), '12 mil');
  assert.equal(copy.countsAnnouncement(1, 1), '1 documento em 1 pasta');
  assert.equal(copy.countsAnnouncement(3, 1, 'project'), '3 arquivos em 1 pasta');
  assert.equal(copy.sizeBinLabel(0, [1024, 10240, 102400, 1048576]), 'Até 1 KB');
  assert.equal(copy.sizeBinLabel(4, [1024, 10240, 102400, 1048576]), 'Acima de 1 MB');
  assert.equal(copy.typeLabel('md'), 'MD');
  assert.equal(copy.typeLabel(''), 'Sem extensão');
  assert.equal(copy.viewName('space'), '3D');
  assert.equal(copy.viewName('nada'), 'Mapa');
});
