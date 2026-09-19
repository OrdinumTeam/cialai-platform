// SPDX-License-Identifier: Apache-2.0
// Regras puras do grafo da documentacao: node --test scripts/check-docgraph.mjs
//
// Por que existe: a interface nao tem typecheck nem lint, e as regras que o
// grafo nao pode errar sao todas puras. A poda por Markdown, as contagens que
// nao mudam ao recolher, a diferenca entre dois indices, o descarte da
// resposta de uma raiz anterior e a regra de texto do produto sao conferidas
// aqui, sem DOM e sem Tauri. O esperado de cada cenario e escrito a mao, nao
// recalculado pela mesma funcao que esta sendo testada.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GROUP_TONES, ROOT_ID, absPath, ancestorsOf, attachIssues, buildTree, computeColorGroups, defaultExpansion,
  diffIndex, effectiveExpanded, foldKey, groupOf, idOfPath, isBroadRoot, parentId, pickWatchDirs, revealSet,
  shouldAdopt, visibleScene,
} from '../src/terminals/docgraph/model.js';
import { matchSet, searchDocs } from '../src/terminals/docgraph/search.js';
import { OVERRIDE_LIMIT, ROOT_LIMIT, STORAGE_KEY, loadUi, saveUi } from '../src/terminals/docgraph/persist.js';
import { DEBOUNCE_MS, MAX_WAIT_MS, createIndexer } from '../src/terminals/docgraph/indexer.js';
import * as copy from '../src/terminals/docgraph/copy.js';

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
  assert.deepEqual(loadUi(storage, '/p'), { bulk: null, expanded: ['a'], collapsed: ['b'], view: { x: 1, y: 2, s: 0.5 }, selected: 'a/x.md', tones: { a: 'ciano' }, updatedAt: 100 });
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
});
