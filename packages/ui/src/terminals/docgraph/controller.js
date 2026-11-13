// SPDX-License-Identifier: Apache-2.0
// Controlador do grafo da documentacao, um por sessao do estudio. Vive em
// escopo de modulo, como o runtime dos terminais e o do Dev Browser: o painel
// desmonta sempre que outra aba e ativada ou a secao muda, e o indice, as
// posicoes dos nos e a visao precisam continuar aqui para a volta ser imediata.
//
// O que ele decide:
//
// - **Raiz**: `session.explorer.root`. A troca e percebida pelo evento
//   `explorer` e ao anexar, porque `changeDirectory` escreve a raiz direto.
// - **Varredura**: pelo indexador, com token, fila unica e descarte de resposta
//   atrasada. O resultado so vira arvore nova quando a impressao digital muda.
// - **Atualizacao**: eventos `fs://change` dentro da raiz sao dica de latencia;
//   a garantia e a releitura periodica, o foco da janela e o botao Atualizar.
// - **Ciclo de vida**: grafo escondido nao tem varredura, temporizador,
//   observador nem laco. `detach` solta tudo isso e mantem os dados.
//
// O painel entrega ganchos no `attach`: `onScene` recebe a cena nova,
// `onFrame` pede um desenho, `applyView` e `focusNode` movem a camera e
// `getSize` devolve a area disponivel.
//
// Vistas: o Mapa tem a simulacao de pastas de sempre, em `controller.sim`.
// Arvore, Radial e Blocos saem inteiras de um layout puro. Vizinhos e 3D tem
// simulacao propria, em `controller.alt`, que existe so enquanto a vista esta
// escolhida. A expansao, a selecao e as cores sao as mesmas em todas.

import * as files from '../files.js';
import { emitDocgraphEvent, getSession, isDemo, registerDocgraphHooks, subscribe, subscribeChanges, unwatchPathAs, watchPathAs } from '../runtime.js';
import { motionOff } from '../motion.js';
import { createIndexer, makeBootId } from './indexer.js';
import {
  ROOT_ID, absPath, ancestorsOf, buildTree, carryLinks, defaultExpansion, diffIndex, effectiveExpanded, idOfPath,
  isBroadRoot, pickWatchDirs, revealSet, shouldAdopt, visibleScene,
} from './model.js';
import { cleanColorMode, cleanPalette, cleanRules, colorize } from './colors.js';
import { STATIC_VIEWS, cleanDepth, cleanScope, cleanViewMode } from './options.js';
import { latestOptions, loadUi, saveUi } from './persist.js';
import { matchSet } from './search.js';
import {
  assignSlots, boundsOf, createNeighborSim, createSim, discRadius, fitView, hashAngle, hubRadius, isCold, seedRadial, settle, slotExtent,
  slotPosition, updateNeighborSim, updateSim,
} from './layout.js';
import { blocksLayout, neighborFocus, neighborhood, radialLayout, treeLayout, visibleRefs } from './views.js';
import { DEFAULT_ORBIT, createSpaceSim, orbitBy, projectedBounds, seedSpace, updateSpaceSim } from './space.js';
import { track } from './stats.js';

const WATCH_CAP = 32;
const SAFETY_NET_MS = 15000;
// Ligacoes cortadas pelo prazo: a proxima leitura vem logo, enquanto avanca.
const LINKS_FOLLOW_MS = 400;
const LINKS_FOLLOW_LIMIT = 30;
const PERSIST_MS = 400;
const SYNC_SETTLE_DIRS = 400;
const SYNC_SETTLE_NODES = 600;
const EMPTY_SCENE = { mode: 'map', dirs: [], docs: [], links: [], refs: [], nodes: [], edges: [], index: new Map(), order: [], revision: 0 };
const EMPTY_COLORS = { mode: 'group', toneOf: new Map(), legend: [], other: 0, groupRoots: new Set() };
const emptyAlt = () => ({ kind: null, sim: null, nodes: new Map() });

const bootId = makeBootId();
const controllers = new Map();

// No modo de demonstracao nada e lido nem gravado: uma captura nao pode
// herdar a visao e a selecao da captura anterior.
function storage() {
  if (isDemo()) return null;
  try { return window.localStorage; } catch (_error) { return null; }
}

function baseName(path) {
  return String(path || '').replace(/\/+$/, '').split('/').pop() || '';
}

function ownerOf(controller) {
  return `docgraph:${controller.sessionId}`;
}

function notify(controller) {
  controller.revision += 1;
  emitDocgraphEvent(controller.sessionId);
}

/* ── criacao e descarte ───────────────────────────────────────────── */

function createController(sessionId) {
  const controller = {
    sessionId,
    root: null,
    rootKey: null,
    status: 'idle',
    error: null,
    refreshing: false,
    stale: false,
    confirmedBroad: false,
    meta: null,
    tree: null,
    decided: new Map(),
    bulk: null,
    overrides: { expanded: new Set(), collapsed: new Set() },
    expanded: new Set(),
    tones: {},
    folderTones: {},
    typeTones: {},
    rules: [],
    colors: EMPTY_COLORS,
    // Vista, escopo e opcoes de cor. Chegam do estado salvo antes da primeira
    // varredura, porque o escopo decide o que o Rust le.
    mode: 'map',
    scope: 'docs',
    colorBy: 'group',
    palette: 'safe',
    depth: 1,
    refs: true,
    optionsLoaded: false,
    alt: emptyAlt(),
    orbit: { ...DEFAULT_ORBIT },
    // Arquivo no centro da vista Vizinhos. Limpar a selecao nao o troca.
    focus: null,
    blocksSize: null,
    // Largura da legenda sobre o canvas, que os Blocos deixam livre.
    reserve: 0,
    // A primeira cena de uma raiz, ou de uma vista, enquadra ou aplica a
    // visao salva. Depois disso a camera e do usuario.
    framed: false,
    selected: null,
    keyboard: false,
    query: '',
    matches: null,
    view: null,
    needsFit: true,
    // Enquanto o usuario nao mexe na camera, o grafo acompanha o tamanho da
    // area: redimensionar o painel enquadra de novo.
    autoFit: true,
    interacted: false,
    uiLoaded: false,
    simNodes: new Map(),
    parked: new Map(),
    slots: new Map(),
    sim: null,
    scene: EMPTY_SCENE,
    attached: false,
    hooks: null,
    watched: new Set(),
    offs: [],
    netTimer: 0,
    linkRounds: 0,
    linksFollow: false,
    persistTimer: 0,
    loop: 0,
    loopKind: null,
    dragging: null,
    scanStartedAt: 0,
    indexingSince: 0,
    revision: 0,
    indexer: null,
  };
  controller.indexer = createIndexer({
    key: sessionId,
    bootId,
    // Pela ponte exportada, na hora da chamada: a verificacao troca por espiao.
    // O escopo e lido na hora do pedido, para a troca valer ja na proxima.
    scan: (key, token, root) => files.docgraph.scan(key, token, root, controller.scope),
    cancel: (key, token) => files.docgraph.cancel(key, token),
    onStart: () => {
      controller.scanStartedAt = performance.now();
      if (controller.tree) controller.refreshing = true;
      else { controller.status = 'indexing'; controller.indexingSince = Date.now(); }
      notify(controller);
    },
    onResult: (scan) => onResult(controller, scan),
    onError: (error) => onError(controller, error),
  });
  return controller;
}

export function getController(sessionId) {
  let controller = controllers.get(sessionId);
  if (!controller) {
    controller = createController(sessionId);
    // Entre o fim da sessao e a desmontagem do painel ainda pode haver um
    // desenho: o controlador de uma sessao que nao existe mais e avulso e nao
    // fica guardado.
    if (getSession(sessionId)) controllers.set(sessionId, controller);
  }
  return controller;
}

export function peekController(sessionId) {
  return controllers.get(sessionId) || null;
}

export function disposeSession(sessionId) {
  const controller = controllers.get(sessionId);
  if (!controller) return;
  detach(sessionId);
  controller.indexer.dispose();
  controllers.delete(sessionId);
}

registerDocgraphHooks({ sessionClosed: (session) => disposeSession(session.id) });

/* ── persistencia ─────────────────────────────────────────────────── */

function uiOf(controller) {
  return {
    bulk: controller.bulk,
    expanded: [...controller.overrides.expanded],
    collapsed: [...controller.overrides.collapsed],
    view: controller.view,
    selected: controller.selected,
    tones: controller.tones,
    folderTones: controller.folderTones,
    typeTones: controller.typeTones,
    rules: controller.rules,
    mode: controller.mode,
    scope: controller.scope,
    colorBy: controller.colorBy,
    palette: controller.palette,
    depth: controller.depth,
    refs: controller.refs,
  };
}

function applyOptions(controller, options) {
  controller.mode = cleanViewMode(options.mode);
  controller.scope = cleanScope(options.scope);
  controller.colorBy = cleanColorMode(options.colorBy);
  controller.palette = cleanPalette(options.palette);
  controller.depth = cleanDepth(options.depth);
  controller.refs = options.refs !== false;
}

// Capturas em modo demo escolhem a vista e as opcoes pela URL.
function demoOptions() {
  try {
    const params = new URLSearchParams(window.location.search);
    return {
      mode: params.get('docgraph_view'), scope: params.get('docgraph_scope'), colorBy: params.get('docgraph_color'),
      palette: params.get('docgraph_palette'), depth: params.get('docgraph_depth') || 1, refs: params.get('docgraph_refs') !== '0',
    };
  } catch (_error) { return null; }
}

// Antes da primeira varredura so se conhece a raiz como a sessao a ve. O
// estado gravado nela, ou a ultima escolha feita em outra raiz, decide o
// escopo do pedido.
function preloadOptions(controller) {
  if (controller.optionsLoaded) return;
  controller.optionsLoaded = true;
  if (isDemo()) { const options = demoOptions(); if (options) applyOptions(controller, options); return; }
  const store = storage();
  if (!store) return;
  applyOptions(controller, loadUi(store, controller.root) || latestOptions(store));
}

function flushPersist(controller) {
  if (controller.persistTimer) { clearTimeout(controller.persistTimer); controller.persistTimer = 0; }
  const store = storage();
  // Uma raiz so e gravada depois de o usuario mexer nela: uma sequencia de
  // `cd` com Acompanhar ligado nao gira o teto de raizes guardadas.
  if (!store || !controller.rootKey || !controller.interacted) return;
  saveUi(store, controller.rootKey, uiOf(controller));
}

function persistSoon(controller) {
  if (controller.persistTimer) return;
  controller.persistTimer = setTimeout(() => { controller.persistTimer = 0; flushPersist(controller); }, PERSIST_MS);
}

function touch(controller) {
  controller.interacted = true;
  persistSoon(controller);
}

// Devolve verdadeiro quando o estado gravado pede outro escopo que o desta
// varredura: a raiz canonica e diferente da raiz da sessao, e so agora o
// estado certo apareceu.
function loadSavedUi(controller, scannedScope) {
  controller.uiLoaded = true;
  const store = storage();
  const saved = store ? loadUi(store, controller.rootKey) : null;
  if (!saved) return false;
  controller.bulk = saved.bulk;
  controller.overrides = { expanded: new Set(saved.expanded), collapsed: new Set(saved.collapsed) };
  controller.tones = saved.tones;
  controller.folderTones = saved.folderTones;
  controller.typeTones = saved.typeTones;
  controller.rules = saved.rules;
  applyOptions(controller, saved);
  controller.selected = saved.selected;
  if (saved.view) { controller.view = saved.view; controller.needsFit = false; controller.autoFit = false; }
  // O que veio do disco ja era escolha do usuario.
  controller.interacted = true;
  return controller.scope !== scannedScope;
}

/* ── raiz ─────────────────────────────────────────────────────────── */

function resetFor(controller, root) {
  flushPersist(controller);
  controller.indexer.reset();
  releaseWatches(controller);
  stopLoop(controller);
  Object.assign(controller, {
    root, rootKey: null, status: 'idle', error: null, refreshing: false, stale: false, confirmedBroad: false, meta: null, tree: null,
    decided: new Map(), bulk: null, overrides: { expanded: new Set(), collapsed: new Set() }, expanded: new Set(), tones: {},
    folderTones: {}, typeTones: {}, rules: [], colors: EMPTY_COLORS, optionsLoaded: false, alt: emptyAlt(), focus: null, blocksSize: null,
    framed: false, selected: null, query: '', matches: null, view: null, needsFit: true, autoFit: true, interacted: false, uiLoaded: false,
    simNodes: new Map(), parked: new Map(), slots: new Map(), sim: null, scene: EMPTY_SCENE, linkRounds: 0, linksFollow: false,
  });
}

// Confere a raiz da sessao. Se mudou, o grafo da raiz antiga some na hora, e a
// resposta de qualquer varredura dela deixa de valer. Sem o painel a vista,
// nada e varrido: a raiz nova e indexada quando ele voltar.
export function syncRoot(sessionId) {
  const controller = getController(sessionId);
  const session = getSession(sessionId);
  const root = session?.explorer.root || null;
  if (!root) return controller;
  if (root !== controller.root) {
    resetFor(controller, root);
    preloadOptions(controller);
    controller.hooks?.onScene(controller.scene);
    if (isBroadRoot(root)) controller.status = 'broad';
    notify(controller);
  }
  // So uma raiz ainda nao lida dispara sozinha. Depois de uma falha quem
  // decide tentar de novo e o usuario: o evento `explorer` chega o tempo todo.
  if (controller.attached && controller.status === 'idle' && !controller.tree && !controller.indexer.state().inFlight) {
    controller.indexer.request(root, { immediate: true });
  }
  return controller;
}

export function confirmBroad(sessionId) {
  const controller = getController(sessionId);
  controller.confirmedBroad = true;
  controller.status = 'indexing';
  controller.indexingSince = Date.now();
  notify(controller);
  controller.indexer.request(controller.root, { immediate: true });
}

export function refresh(sessionId) {
  const controller = getController(sessionId);
  if (!controller.root || controller.status === 'broad') return;
  controller.indexer.request(controller.root, { immediate: true });
}

/* ── resultado da varredura ───────────────────────────────────────── */

function onError(controller, error) {
  controller.refreshing = false;
  // Com um grafo ja na tela, uma releitura que falha nao o derruba.
  if (controller.tree) { controller.stale = true; notify(controller); return; }
  controller.status = 'error';
  controller.error = { code: error?.code || 'io', message: error?.message || String(error) };
  notify(controller);
}

function carryRenames(controller, diff) {
  diff.renamed.forEach(({ from, to, kind }) => {
    if (kind === 'doc') {
      const slots = controller.slots.get(parentOf(from));
      if (slots?.has(from)) { slots.set(to, slots.get(from)); slots.delete(from); }
      if (controller.selected === from) controller.selected = to;
      return;
    }
    const move = (map) => {
      [...map.keys()].forEach((id) => {
        if (id !== from && !id.startsWith(`${from}/`)) return;
        const next = to + id.slice(from.length);
        const value = map.get(id);
        map.delete(id);
        if (value && typeof value === 'object' && 'id' in value) value.id = next;
        map.set(next, value);
      });
    };
    move(controller.simNodes);
    move(controller.parked);
    move(controller.decided);
    // As vagas guardam ids de documento: reescreve o prefixo tambem por dentro.
    [...controller.slots.keys()].forEach((id) => {
      if (id !== from && !id.startsWith(`${from}/`)) return;
      const inner = new Map();
      controller.slots.get(id).forEach((slot, doc) => inner.set(to + doc.slice(from.length), slot));
      controller.slots.delete(id);
      controller.slots.set(to + id.slice(from.length), inner);
    });
    ['expanded', 'collapsed'].forEach((side) => {
      [...controller.overrides[side]].forEach((id) => {
        if (id !== from && !id.startsWith(`${from}/`)) return;
        controller.overrides[side].delete(id);
        controller.overrides[side].add(to + id.slice(from.length));
      });
    });
    if (controller.selected === from || controller.selected?.startsWith(`${from}/`)) controller.selected = to + controller.selected.slice(from.length);
  });
}

function parentOf(id) {
  const index = id.lastIndexOf('/');
  return index < 0 ? ROOT_ID : id.slice(0, index);
}

function onResult(controller, scan) {
  const ipcMs = performance.now() - controller.scanStartedAt;
  track.sample('scanIpcMs', ipcMs);
  track.sample('scanRustMs', Number(scan.elapsedMs) || 0);
  controller.refreshing = false;
  // O Rust devolve o escopo que leu; a ponte antiga, sem o campo, so lia
  // documentacao.
  const scope = cleanScope(scan.scope);
  if (!controller.uiLoaded) {
    controller.rootKey = scan.canonicalRoot || controller.root;
    if (loadSavedUi(controller, scope)) {
      // O estado da raiz canonica pede outro escopo: esta leitura nao serve.
      notify(controller);
      controller.indexer.request(controller.root, { immediate: true });
      return;
    }
  }

  const meta = {
    docs: scan.docs.length, dirs: scan.dirs, visited: scan.visited, elapsedMs: scan.elapsedMs, ipcMs,
    partial: Boolean(scan.partial), stopped: scan.stopped || null, issues: scan.issues || [], issuesTotal: scan.issuesTotal || 0,
    excluded: scan.excluded || {}, fingerprint: scan.fingerprint, scannedAt: Date.now(), scope,
    linksPartial: Boolean(scan.linksPartial),
  };
  const sameScope = controller.meta?.scope === scope;
  // O Rust guarda no cache o que leu antes do prazo, entao a leitura seguinte
  // vai mais longe. Enquanto ela avancar, a proxima vem logo, ate um teto de
  // rodadas. Varredura que parou no teto de arquivos nao entra: cada rodada
  // dela custaria o prazo inteiro.
  const progressing = meta.linksPartial && !meta.stopped && Number(scan.linksRead) > 0;
  controller.linkRounds = progressing ? (controller.linkRounds || 0) + 1 : 0;
  controller.linksFollow = progressing && controller.linkRounds <= LINKS_FOLLOW_LIMIT;

  // Nada mudou: nenhuma arvore nova, nenhum desenho, nenhuma simulacao.
  if (controller.tree && sameScope && scan.fingerprint && scan.fingerprint === controller.meta?.fingerprint) {
    controller.meta = { ...controller.meta, scannedAt: meta.scannedAt, elapsedMs: meta.elapsedMs, ipcMs };
    controller.stale = false;
    scheduleNet(controller);
    notify(controller);
    return;
  }
  // Um indice completo nao e trocado por um que parou no teto ou no prazo.
  // Na troca de escopo o indice anterior e de outra coisa e sempre sai.
  if (controller.tree && sameScope && !shouldAdopt(controller.meta, meta)) {
    controller.stale = true;
    scheduleNet(controller);
    notify(controller);
    return;
  }

  const started = performance.now();
  const session = getSession(controller.sessionId);
  const next = buildTree(scan, { rootName: baseName(controller.root) || session?.name || '' });
  if (controller.tree && sameScope) carryLinks(next, controller.tree);
  const diff = diffIndex(controller.tree, next);
  if (controller.tree) carryRenames(controller, diff);
  controller.tree = next;
  controller.meta = meta;
  controller.stale = false;
  controller.status = next.docCount ? 'ready' : 'empty';
  controller.error = null;
  if (controller.selected && !next.nodes.has(controller.selected)) controller.selected = null;
  if (controller.focus && !next.nodes.has(controller.focus)) controller.focus = null;
  recolor(controller);
  if (controller.query) controller.matches = matchSet(next, controller.query);
  recomputeExpanded(controller);
  track.sample('buildMs', performance.now() - started);
  rebuildScene(controller, { reheat: diff.changed ? 0.15 : 0 });
  consumeFocusRequest(controller);
  scheduleNet(controller);
  notify(controller);
}

// Vagas gravadas do modo de cor corrente. Grupo, pasta e tipo guardam as
// proprias, para trocar de modo e voltar nao repintar nada.
function savedTonesFor(controller) {
  if (controller.colorBy === 'folder') return controller.folderTones;
  if (controller.colorBy === 'type') return controller.typeTones;
  return controller.tones;
}

function recolor(controller, { regroup = false } = {}) {
  if (!controller.tree) { controller.colors = EMPTY_COLORS; return; }
  const colors = colorize(controller.tree, { mode: controller.colorBy, saved: savedTonesFor(controller), rules: controller.rules, regroup });
  if (colors.saved) {
    if (controller.colorBy === 'folder') controller.folderTones = colors.saved;
    else if (controller.colorBy === 'type') controller.typeTones = colors.saved;
    else controller.tones = colors.saved;
  }
  controller.colors = colors;
}

function recomputeExpanded(controller) {
  const tree = controller.tree;
  let base;
  if (controller.bulk === 'all') base = [...tree.nodes.values()].filter((node) => node.kind !== 'doc').map((node) => node.id);
  else if (controller.bulk === 'none') base = [ROOT_ID];
  else {
    const result = defaultExpansion(tree, { frozen: controller.decided });
    controller.decided = result.decided;
    base = result.expanded;
  }
  controller.expanded = effectiveExpanded(tree, base, controller.overrides);
}

/* ── cena e simulacao ─────────────────────────────────────────────── */

function rebuildScene(controller, { reheat = 0 } = {}) {
  const tree = controller.tree;
  if (!tree || !tree.docCount) {
    stopLoop(controller);
    controller.scene = { ...EMPTY_SCENE, mode: controller.mode, revision: controller.scene.revision + 1 };
    controller.hooks?.onScene(controller.scene);
    reconcileWatches(controller);
    return;
  }
  if (controller.mode !== 'map') { rebuildView(controller, { reheat }); return; }
  const started = performance.now();
  const visible = visibleScene(tree, controller.expanded);
  const wanted = new Set(visible.dirs);

  // Pasta que sai de vista guarda onde estava em relacao ao pai, para voltar
  // ao mesmo lugar quando for expandida de novo.
  controller.simNodes.forEach((node, id) => {
    if (wanted.has(id)) return;
    const parent = controller.simNodes.get(tree.nodes.get(id)?.parent ?? parentOf(id));
    if (parent && Number.isFinite(node.x)) controller.parked.set(id, { dx: node.x - parent.x, dy: node.y - parent.y });
    controller.simNodes.delete(id);
  });

  let structural = false;
  visible.dirs.forEach((id) => {
    const info = tree.nodes.get(id);
    const hub = hubRadius(info);
    const open = controller.expanded.has(id);
    const slots = open ? assignSlots(controller.slots.get(id), info.docs) : controller.slots.get(id);
    if (open) controller.slots.set(id, slots);
    const R = discRadius(open ? slotExtent(slots) : 0, hub);
    let node = controller.simNodes.get(id);
    if (!node) {
      node = { id, depth: info.depth, hub, R, seeded: false };
      const parent = controller.simNodes.get(info.parent);
      const parked = controller.parked.get(id);
      if (parent && parked && parent.seeded) { node.x = parent.x + parked.dx; node.y = parent.y + parked.dy; node.seeded = true; }
      if (id === ROOT_ID) { node.x = 0; node.y = 0; node.fx = 0; node.fy = 0; node.seeded = true; }
      controller.simNodes.set(id, node);
      structural = true;
    } else if (Math.abs(node.R - R) > 6) {
      structural = true;
    }
    node.hub = hub;
    node.R = R;
    node.depth = info.depth;
  });
  // Insere na ordem da cena, para o pai vir sempre antes do filho.
  const ordered = new Map();
  visible.dirs.forEach((id) => ordered.set(id, controller.simNodes.get(id)));
  controller.simNodes = ordered;
  seedRadial(tree, controller.simNodes);

  const nodes = [...controller.simNodes.values()];
  const links = visible.links.map((link) => ({ source: controller.simNodes.get(link.source), target: controller.simNodes.get(link.target) }));
  const first = !controller.sim;
  if (first) controller.sim = createSim(nodes, links); else updateSim(controller.sim, nodes, links);

  if (first) {
    controller.sim.alpha(1);
    if (nodes.length <= SYNC_SETTLE_DIRS || motionOff()) {
      settle(controller.sim, { ticks: 300, budgetMs: motionOff() ? 400 : 60 });
    }
  } else if (structural || reheat) {
    controller.sim.alpha(Math.max(controller.sim.alpha(), structural ? Math.max(reheat, 0.3) : reheat));
  }

  controller.scene = buildRenderScene(controller, visible);
  track.sample('sceneMs', performance.now() - started);
  controller.hooks?.onScene(controller.scene);
  frameOnce(controller);
  if (!isCold(controller.sim)) startLoop(controller);
  reconcileWatches(controller);
}

// Primeira cena da raiz ou da vista: enquadra, ou aplica a visao que veio do
// estado salvo. Ela chega depois da montagem do painel, entao a camera ainda
// esta na visao padrao e precisa recebe-la daqui.
function frameOnce(controller) {
  if (controller.framed || !controller.hooks) return;
  controller.framed = true;
  if (controller.needsFit) fitToArea(controller, { animate: false });
  else if (controller.view) controller.hooks.applyView(controller.view, { animate: false });
}

// O no como as vistas o desenham. O tom vem do modo de cor; o rotulo da
// raiz e o nome da pasta do projeto.
function sceneNode(controller, id, extra) {
  const info = controller.tree.nodes.get(id);
  return {
    id,
    kind: info.kind,
    tone: controller.colors.toneOf.get(id) ?? null,
    label: info.kind === 'root' ? info.name || baseName(controller.root) : info.name,
    expanded: info.kind !== 'doc' && controller.expanded.has(id),
    count: info.kind === 'doc' ? 0 : info.docCount,
    partial: Boolean(info.partial),
    groupRoot: controller.colors.groupRoots.has(id),
    ...extra,
  };
}

// Ligacoes entre arquivos sobre os nos da cena, por indice.
function refsOver(controller, index, cap) {
  if (!controller.refs) return [];
  return visibleRefs(controller.tree, (id) => index.has(id), cap ? { cap } : undefined).refs
    .map((ref) => ({ source: index.get(ref.a).at, target: index.get(ref.b).at, weight: ref.weight }));
}

// Os Blocos nascem do tamanho da area livre de quando a vista foi aberta, em
// pixels, para a faixa com o nome da pasta ter tamanho de texto no
// enquadramento. Mudar o tamanho do painel nao rearruma os blocos, so
// reenquadra.
function blocksSize(controller) {
  const size = controller.hooks?.getSize?.();
  if (!size || size.width < 2 || size.height < 2) return { width: 1600, height: 1000 };
  const width = size.width - reserveOf(controller, size);
  const pad = Math.min(48, 0.1 * Math.min(width, size.height));
  return { width: Math.max(320, Math.round(width - pad * 2)), height: Math.max(200, Math.round(size.height - pad * 2)) };
}

// Largura que a legenda cobre na direita do canvas. So os Blocos a respeitam:
// eles enchem o retangulo inteiro, e o canto de baixo e onde ficam os menores.
function reserveOf(controller, size) {
  return controller.mode === 'blocks' ? Math.min(controller.reserve || 0, size.width * 0.4) : 0;
}

export function setReserve(sessionId, reserve) {
  const controller = controllers.get(sessionId);
  const next = Math.max(0, Math.round(Number(reserve) || 0));
  if (!controller || Math.abs((controller.reserve || 0) - next) < 4) return;
  controller.reserve = next;
  // Enquanto a camera for automatica, os Blocos se refazem para a area nova.
  if (controller.mode === 'blocks' && controller.autoFit && controller.tree) {
    controller.blocksSize = null;
    rebuildScene(controller, { reheat: 0 });
  }
}

function ensureAlt(controller, kind) {
  if (controller.alt.kind !== kind) controller.alt = { ...emptyAlt(), kind };
  return controller.alt;
}

function rebuildView(controller, { reheat = 0 } = {}) {
  const started = performance.now();
  const mode = controller.mode;
  let scene;
  if (STATIC_VIEWS.includes(mode)) scene = buildStaticScene(controller);
  else if (mode === 'neighbors') scene = buildNeighborScene(controller, { reheat });
  else scene = buildSpaceScene(controller, { reheat });
  controller.scene = { ...scene, revision: controller.scene.revision + 1 };
  track.sample('sceneMs', performance.now() - started);
  controller.hooks?.onScene(controller.scene);
  frameOnce(controller);
  const sim = activeSim(controller);
  if (sim && !isCold(sim)) startLoop(controller);
  else if (!sim && controller.autoFit && controller.framed) fitToArea(controller, { animate: true });
  reconcileWatches(controller);
}

function buildStaticScene(controller) {
  const tree = controller.tree;
  const mode = controller.mode;
  let layout;
  if (mode === 'tree') layout = treeLayout(tree, controller.expanded);
  else if (mode === 'radial') layout = radialLayout(tree, controller.expanded);
  else {
    if (!controller.blocksSize) controller.blocksSize = blocksSize(controller);
    layout = blocksLayout(tree, controller.expanded, controller.blocksSize);
  }
  const index = new Map();
  layout.nodes.forEach((item, at) => index.set(item.id, { kind: 'node', at }));
  const nodes = layout.nodes.map((item) => sceneNode(controller, item.id, {
    pos: { x: item.x, y: item.y }, side: item.side || 'right', rect: item.rect || null, angle: item.angle ?? null, radius: item.r ?? null,
    open: Boolean(item.open), header: Boolean(item.header),
  }));
  const edges = layout.edges.map((edge) => ({ source: index.get(edge.source).at, target: index.get(edge.target).at }));
  const refs = mode === 'blocks' ? [] : refsOver(controller, index);
  return { mode, nodes, edges, refs, index, order: visibleScene(tree, controller.expanded).order, bounds: layout.bounds };
}

// Vizinhos: o foco preso na origem e a vizinhanca solta em volta. Quem ja
// estava na vista fica onde estava; quem chega nasce perto de quem o trouxe.
function buildNeighborScene(controller, { reheat = 0 } = {}) {
  const tree = controller.tree;
  if (!controller.focus || tree.nodes.get(controller.focus)?.kind !== 'doc') controller.focus = neighborFocus(tree, controller.selected);
  const hood = neighborhood(tree, controller.focus, controller.depth);
  const alt = ensureAlt(controller, 'neighbors');
  const wanted = new Set(hood.nodes.map((item) => item.id));
  [...alt.nodes.keys()].forEach((id) => { if (!wanted.has(id)) alt.nodes.delete(id); });
  let structural = false;
  const ordered = new Map();
  hood.nodes.forEach((item) => {
    let node = alt.nodes.get(item.id);
    if (!node) {
      const via = item.via ? ordered.get(item.via) : null;
      const angle = hashAngle(item.id);
      const distance = item.ring ? 70 : 0;
      node = { id: item.id, x: (via?.x || 0) + distance * Math.cos(angle), y: (via?.y || 0) + distance * Math.sin(angle) };
      structural = true;
    }
    node.ring = item.ring;
    ordered.set(item.id, node);
  });
  alt.nodes = ordered;
  // O foco vai para a origem e leva os outros junto, para a camera nao pular.
  const center = alt.nodes.get(controller.focus);
  alt.nodes.forEach((node) => { node.fx = null; node.fy = null; });
  if (center) {
    const dx = center.x; const dy = center.y;
    if (dx || dy) alt.nodes.forEach((node) => { node.x -= dx; node.y -= dy; });
    center.fx = 0; center.fy = 0;
  }
  const nodes = [...alt.nodes.values()];
  const links = hood.edges.map((edge) => ({ source: alt.nodes.get(edge.source), target: alt.nodes.get(edge.target) }));
  if (!alt.sim) {
    alt.sim = createNeighborSim(nodes, links);
    alt.sim.alpha(1);
    if (nodes.length <= SYNC_SETTLE_NODES || motionOff()) settle(alt.sim, { ticks: 300, budgetMs: motionOff() ? 400 : 60 });
  } else {
    updateNeighborSim(alt.sim, nodes, links);
    if (structural || reheat) alt.sim.alpha(Math.max(alt.sim.alpha(), structural ? 0.5 : reheat));
  }
  const index = new Map();
  hood.nodes.forEach((item, at) => index.set(item.id, { kind: 'node', at }));
  const scene = {
    mode: 'neighbors',
    nodes: hood.nodes.map((item) => sceneNode(controller, item.id, { pos: alt.nodes.get(item.id), ring: item.ring, focus: item.id === controller.focus })),
    edges: hood.edges.map((edge) => ({ source: index.get(edge.source).at, target: index.get(edge.target).at, directed: true })),
    refs: [],
    index,
    order: hood.nodes.map((item) => item.id),
    focus: controller.focus,
    capped: hood.capped,
  };
  if (!tree.links.count) scene.empty = 'noLinks';
  else if (!controller.focus) scene.empty = 'noFocus';
  else if (hood.nodes.length <= 1) scene.empty = 'alone';
  return scene;
}

// 3D: pastas e arquivos a vista, ligados pela hierarquia e, quando ligadas,
// pelas citacoes, com forca fraca para nao desmanchar as pastas.
function buildSpaceScene(controller, { reheat = 0 } = {}) {
  const tree = controller.tree;
  const ids = visibleScene(tree, controller.expanded).order;
  const alt = ensureAlt(controller, 'space');
  let structural = false;
  const ordered = new Map();
  ids.forEach((id) => {
    let node = alt.nodes.get(id);
    if (!node) { node = { id, seeded: false }; structural = true; }
    node.kind = tree.nodes.get(id).kind;
    ordered.set(id, node);
  });
  if (ordered.size !== alt.nodes.size) structural = true;
  alt.nodes = ordered;
  seedSpace(tree, alt.nodes);
  const root = alt.nodes.get(ROOT_ID);
  if (root) { root.fx = 0; root.fy = 0; root.fz = 0; }
  const index = new Map();
  ids.forEach((id, at) => index.set(id, { kind: 'node', at }));
  const edges = [];
  const simLinks = [];
  ids.forEach((id) => {
    const parent = tree.nodes.get(id).parent;
    if (parent === null || !alt.nodes.has(parent)) return;
    edges.push({ source: index.get(parent).at, target: index.get(id).at });
    simLinks.push({ source: alt.nodes.get(parent), target: alt.nodes.get(id), kind: 'tree' });
  });
  const refs = refsOver(controller, index, 3000);
  refs.forEach((ref) => simLinks.push({ source: alt.nodes.get(ids[ref.source]), target: alt.nodes.get(ids[ref.target]), kind: 'ref' }));
  const nodes = [...alt.nodes.values()];
  if (!alt.sim) {
    alt.sim = createSpaceSim(nodes, simLinks);
    alt.sim.alpha(1);
    if (motionOff()) settle(alt.sim, { ticks: 400, budgetMs: 400 });
  } else {
    updateSpaceSim(alt.sim, nodes, simLinks);
    if (structural || reheat) alt.sim.alpha(Math.max(alt.sim.alpha(), structural ? Math.max(reheat, 0.4) : reheat));
  }
  return {
    mode: 'space',
    nodes: ids.map((id) => sceneNode(controller, id, { pos: alt.nodes.get(id) })),
    edges,
    refs,
    index,
    order: ids,
    orbit: controller.orbit,
  };
}

function activeSim(controller) {
  if (controller.mode === 'map') return controller.sim;
  if (controller.mode === 'neighbors' || controller.mode === 'space') return controller.alt.sim;
  return null;
}

function buildRenderScene(controller, visible) {
  const tree = controller.tree;
  const index = new Map();
  const toneOf = controller.colors.toneOf;
  const dirs = visible.dirs.map((id, at) => {
    const info = tree.nodes.get(id);
    index.set(id, { kind: 'dir', at });
    return {
      id, kind: info.kind, sim: controller.simNodes.get(id), tone: toneOf.get(id) ?? null,
      expanded: controller.expanded.has(id), count: info.docCount, docTotal: info.docs.length, partial: info.partial,
      label: info.name || baseName(controller.root), groupRoot: controller.colors.groupRoots.has(id),
    };
  });
  const docs = [];
  visible.dirs.forEach((dirId) => {
    if (!controller.expanded.has(dirId)) return;
    const info = tree.nodes.get(dirId);
    const at = index.get(dirId).at;
    const slots = controller.slots.get(dirId);
    const phase = hashAngle(dirId);
    info.docs.forEach((docId) => {
      const position = slotPosition(slots.get(docId), dirs[at].sim.hub, phase);
      docs.push({ id: docId, dir: at, dx: position.x, dy: position.y, tone: toneOf.get(docId) ?? null, label: tree.nodes.get(docId).name });
    });
  });
  // Por tom, para o canvas trocar de cor o minimo de vezes.
  docs.sort((a, b) => (a.tone || '').localeCompare(b.tone || ''));
  docs.forEach((doc, at) => index.set(doc.id, { kind: 'doc', at }));
  const links = visible.links.map((link) => {
    const target = index.get(link.target).at;
    return { source: index.get(link.source).at, target, tone: dirs[target].tone, depth: dirs[target].sim.depth };
  });
  // Citacoes entre arquivos, com cada ponta no no a vista mais proximo.
  const refs = controller.refs
    ? visibleRefs(tree, (id) => index.has(id)).refs.map((ref) => ({ a: index.get(ref.a), b: index.get(ref.b), weight: ref.weight }))
    : [];
  return { mode: 'map', dirs, docs, links, refs, index, order: visible.order, revision: controller.scene.revision + 1 };
}

// O laco existe so enquanto a simulacao esta quente e o painel esta a vista.
// Com movimento desligado, ou fora da tela, assenta de uma vez: o WKWebView
// fora da tela nao entrega quadro de animacao.
function startLoop(controller) {
  const sim = activeSim(controller);
  if (controller.loop || !controller.attached || !sim) return;
  if (motionOff() || document.visibilityState === 'hidden') {
    settle(sim, { ticks: 400, budgetMs: 400 });
    controller.hooks?.onFrame();
    settled(controller);
    return;
  }
  track.on('loop');
  controller.loopKind = 'raf';
  const step = () => {
    controller.loop = 0;
    // A vista pode ter mudado entre um quadro e outro: vale a simulacao dela.
    const current = activeSim(controller);
    if (!controller.attached || !current) { track.off('loop'); controller.loopKind = null; return; }
    const started = performance.now();
    current.tick();
    track.sample('tickMs', performance.now() - started);
    controller.hooks?.onFrame();
    if (isCold(current) && !controller.dragging) { track.off('loop'); controller.loopKind = null; settled(controller); return; }
    controller.loop = requestAnimationFrame(step);
  };
  controller.loop = requestAnimationFrame(step);
}

// A simulacao esfriou. O grafo muda de tamanho enquanto assenta, entao o
// enquadramento feito no comeco fica errado: enquanto o usuario nao tiver
// mexido na camera, enquadra de novo.
function settled(controller) {
  if (controller.attached && controller.autoFit && !controller.dragging) fitToArea(controller, { animate: true });
}

function stopLoop(controller) {
  if (controller.loop) { cancelAnimationFrame(controller.loop); controller.loop = 0; }
  if (controller.loopKind) { track.off('loop'); controller.loopKind = null; }
}

// Caixa do que a vista corrente desenha, no espaco do mundo.
function sceneBounds(controller) {
  if (controller.mode === 'map') return controller.simNodes.size ? boundsOf([...controller.simNodes.values()]) : null;
  const scene = controller.scene;
  if (!scene.nodes?.length) return null;
  if (scene.bounds) return scene.bounds;
  if (controller.mode === 'space') return projectedBounds([...controller.alt.nodes.values()], controller.orbit);
  // Vizinhos: folga para os rotulos que saem ao lado das marcas.
  return boundsOf(scene.nodes.map((node) => ({ x: node.pos.x, y: node.pos.y, R: 60 })));
}

export function fitToArea(sessionId, options) {
  const controller = typeof sessionId === 'string' ? getController(sessionId) : sessionId;
  const size = controller.hooks?.getSize?.();
  const bounds = size && size.width >= 2 && size.height >= 2 ? sceneBounds(controller) : null;
  if (!bounds) return false;
  const view = fitView(bounds, size.width - reserveOf(controller, size), size.height);
  controller.needsFit = false;
  controller.hooks.applyView(view, { animate: options?.animate !== false });
  return true;
}

/* ── observadores e rede de seguranca ─────────────────────────────── */

function reconcileWatches(controller) {
  if (!controller.attached || !controller.root) return;
  const owner = ownerOf(controller);
  const ids = controller.tree ? pickWatchDirs(controller.tree, controller.expanded, WATCH_CAP) : [ROOT_ID];
  const wanted = new Set(ids.map((id) => absPath(controller.root, id)));
  [...controller.watched].forEach((path) => { if (!wanted.has(path)) { controller.watched.delete(path); unwatchPathAs(owner, path); } });
  wanted.forEach((path) => { if (!controller.watched.has(path)) { controller.watched.add(path); watchPathAs(owner, path); } });
}

function releaseWatches(controller) {
  const owner = ownerOf(controller);
  controller.watched.forEach((path) => unwatchPathAs(owner, path));
  controller.watched.clear();
}

export function watchCount(sessionId) {
  return controllers.get(sessionId)?.watched.size || 0;
}

// Releitura periodica, so com o painel a vista: 15 s, ou 25 vezes o tempo da
// ultima varredura quando isso for maior, para uma raiz cara nao pesar.
function scheduleNet(controller) {
  if (controller.netTimer) { clearTimeout(controller.netTimer); controller.netTimer = 0; }
  if (!controller.attached) return;
  const last = Math.max(Number(controller.meta?.elapsedMs) || 0, Number(controller.meta?.ipcMs) || 0);
  const wait = controller.linksFollow ? LINKS_FOLLOW_MS : Math.max(SAFETY_NET_MS, 25 * last);
  controller.netTimer = setTimeout(() => {
    controller.netTimer = 0;
    if (!controller.attached) return;
    if (document.visibilityState === 'visible' && controller.root && controller.status !== 'broad') controller.indexer.request(controller.root, { immediate: true });
    else scheduleNet(controller);
  }, wait);
}

/* ── anexar e soltar ──────────────────────────────────────────────── */

export function attach(sessionId, hooks) {
  const controller = getController(sessionId);
  if (controller.attached) detach(sessionId);
  controller.attached = true;
  controller.hooks = hooks;
  track.count('attached');

  const listen = (target, type, handler) => {
    target.addEventListener(type, handler);
    track.on('listener');
    controller.offs.push(() => { target.removeEventListener(type, handler); track.off('listener'); });
  };
  // A janela voltou para a frente: o disco pode ter mudado enquanto isso.
  const rescanNow = () => { if (controller.root && controller.tree && controller.status !== 'broad') controller.indexer.request(controller.root, { immediate: true }); };
  listen(window, 'focus', rescanNow);
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState !== 'visible') { stopLoop(controller); return; }
    rescanNow();
    const sim = activeSim(controller);
    if (sim && !isCold(sim)) startLoop(controller);
  });

  const offChanges = subscribeChanges((event) => {
    const root = controller.root;
    if (!root || !event?.path) return;
    if (event.path !== root && !event.path.startsWith(`${root.replace(/\/+$/, '')}/`)) return;
    // O Rust ja soltou o observador de um caminho removido: esquece aqui
    // tambem, para a proxima reconciliacao registrar de novo.
    if (event.kind === 'removed' && controller.watched.has(event.path)) { controller.watched.delete(event.path); unwatchPathAs(ownerOf(controller), event.path); }
    if (controller.status !== 'broad') controller.indexer.request(root);
  });
  track.on('listener');
  controller.offs.push(() => { offChanges(); track.off('listener'); });

  const offRuntime = subscribe((event) => {
    if (event?.id !== sessionId) return;
    if (event.type === 'explorer') syncRoot(sessionId);
    if (event.type === 'docgraph') consumeFocusRequest(controller);
  });
  track.on('listener');
  controller.offs.push(() => { offRuntime(); track.off('listener'); });

  syncRoot(sessionId);
  if (controller.tree) {
    // Volta imediata com o que ja se sabia, e releitura em seguida.
    rebuildScene(controller, { reheat: 0 });
    if (controller.status !== 'broad') controller.indexer.request(controller.root, { immediate: true });
  }
  consumeFocusRequest(controller);
  scheduleNet(controller);
  notify(controller);
  return controller;
}

export function detach(sessionId) {
  const controller = controllers.get(sessionId);
  if (!controller || !controller.attached) return;
  controller.attached = false;
  track.count('detached');
  controller.indexer.cancel();
  controller.refreshing = false;
  if (controller.status === 'indexing') controller.status = 'idle';
  stopLoop(controller);
  // Termina de assentar num prazo curto, para a proxima montagem ja nascer
  // parada.
  const sim = activeSim(controller);
  if (sim && !isCold(sim)) settle(sim, { ticks: 200, budgetMs: 12 });
  if (controller.dragging) { controller.dragging.fx = null; controller.dragging.fy = null; }
  controller.dragging = null;
  // A proxima montagem enquadra de novo, ou devolve a visao que ficou.
  controller.framed = false;
  controller.offs.forEach((off) => { try { off(); } catch (_error) { /* ja solto */ } });
  controller.offs = [];
  if (controller.netTimer) { clearTimeout(controller.netTimer); controller.netTimer = 0; }
  releaseWatches(controller);
  flushPersist(controller);
  controller.hooks = null;
}

/* ── acoes do usuario ─────────────────────────────────────────────── */

function setOverride(controller, id, open) {
  controller.overrides.expanded.delete(id);
  controller.overrides.collapsed.delete(id);
  controller.overrides[open ? 'expanded' : 'collapsed'].add(id);
}

export function toggle(sessionId, id) {
  const controller = getController(sessionId);
  const node = controller.tree?.nodes.get(id);
  if (!node || node.kind === 'doc' || id === ROOT_ID) return;
  const open = !controller.expanded.has(id);
  setOverride(controller, id, open);
  recomputeExpanded(controller);
  // Recolher com a selecao la dentro traz a selecao para a pasta.
  if (!open && controller.selected && controller.selected.startsWith(`${id}/`)) controller.selected = id;
  touch(controller);
  rebuildScene(controller, { reheat: open ? 0.3 : 0.15 });
  notify(controller);
}

// Na vista Vizinhos a selecao leva o foco: escolher um arquivo o poe no
// centro, e escolher uma pasta poe no centro o arquivo mais ligado dela.
// Limpar a selecao mantem o foco, para um clique no fundo nao mudar a vista.
function followSelection(controller) {
  if (controller.mode !== 'neighbors' || !controller.tree || !controller.selected) return;
  const focus = neighborFocus(controller.tree, controller.selected);
  if (!focus || focus === controller.focus) return;
  controller.focus = focus;
  rebuildScene(controller, { reheat: 0.5 });
}

export function select(sessionId, id, { keyboard = false } = {}) {
  const controller = getController(sessionId);
  const next = id && controller.tree?.nodes.has(id) ? id : null;
  if (controller.selected === next && controller.keyboard === keyboard) return;
  controller.selected = next;
  controller.keyboard = keyboard;
  touch(controller);
  // Nos Vizinhos a selecao pelo teclado anda dentro da vizinhanca; o clique
  // leva o foco junto.
  if (!keyboard) followSelection(controller);
  notify(controller);
}

// Vizinhos: centra a vizinhanca num arquivo.
export function focusOn(sessionId, id) {
  const controller = getController(sessionId);
  if (controller.mode !== 'neighbors' || controller.tree?.nodes.get(id)?.kind !== 'doc' || controller.focus === id) return;
  controller.focus = id;
  rebuildScene(controller, { reheat: 0.5 });
  notify(controller);
}

// Expande o que for preciso para o no aparecer, seleciona e leva a camera.
export function reveal(sessionId, id, { focus = true } = {}) {
  const controller = getController(sessionId);
  if (!controller.tree?.nodes.has(id)) return false;
  const { opened } = revealSet(controller.tree, controller.expanded, id);
  opened.forEach((dir) => setOverride(controller, dir, true));
  controller.selected = id;
  touch(controller);
  if (opened.length) { recomputeExpanded(controller); rebuildScene(controller, { reheat: 0.3 }); }
  followSelection(controller);
  notify(controller);
  if (focus) controller.hooks?.focusNode(id);
  return true;
}

export function expandAll(sessionId) {
  const controller = getController(sessionId);
  if (!controller.tree) return;
  controller.bulk = 'all';
  controller.overrides = { expanded: new Set(), collapsed: new Set() };
  recomputeExpanded(controller);
  touch(controller);
  rebuildScene(controller, { reheat: 0.3 });
  fitToArea(controller);
  notify(controller);
}

export function collapseAll(sessionId) {
  const controller = getController(sessionId);
  if (!controller.tree) return;
  controller.bulk = 'none';
  controller.overrides = { expanded: new Set(), collapsed: new Set() };
  recomputeExpanded(controller);
  if (controller.selected && !visibleScene(controller.tree, controller.expanded).order.includes(controller.selected)) controller.selected = null;
  touch(controller);
  rebuildScene(controller, { reheat: 0.15 });
  fitToArea(controller);
  notify(controller);
}

export function setQuery(sessionId, query) {
  const controller = getController(sessionId);
  controller.query = query;
  controller.matches = controller.tree ? matchSet(controller.tree, query) : null;
  notify(controller);
}

export function regroupColors(sessionId) {
  const controller = getController(sessionId);
  if (!controller.tree) return;
  recolor(controller, { regroup: true });
  touch(controller);
  rebuildScene(controller, { reheat: 0 });
  notify(controller);
}

/* ── vista e opcoes ───────────────────────────────────────────────── */

export function setMode(sessionId, mode) {
  const controller = getController(sessionId);
  const next = cleanViewMode(mode);
  if (controller.mode === next) return;
  stopLoop(controller);
  // A simulacao que sai termina de assentar: a volta a ela nasce parada.
  const leaving = activeSim(controller);
  if (leaving && !isCold(leaving)) settle(leaving, { ticks: 200, budgetMs: 12 });
  if (controller.dragging) { controller.dragging.fx = null; controller.dragging.fy = null; controller.dragging = null; }
  controller.mode = next;
  controller.blocksSize = null;
  // Cada vista tem outra geometria: a camera enquadra a nova.
  controller.framed = false;
  controller.needsFit = true;
  controller.autoFit = true;
  touch(controller);
  rebuildScene(controller, { reheat: 0 });
  notify(controller);
}

export function setScope(sessionId, scope) {
  const controller = getController(sessionId);
  const next = cleanScope(scope);
  if (controller.scope === next) return;
  controller.scope = next;
  touch(controller);
  notify(controller);
  if (controller.root && controller.status !== 'broad') controller.indexer.request(controller.root, { immediate: true });
}

export function setColorBy(sessionId, mode) {
  const controller = getController(sessionId);
  const next = cleanColorMode(mode);
  if (controller.colorBy === next) return;
  controller.colorBy = next;
  recolor(controller);
  touch(controller);
  rebuildScene(controller, { reheat: 0 });
  notify(controller);
}

export function setPalette(sessionId, palette) {
  const controller = getController(sessionId);
  const next = cleanPalette(palette);
  if (controller.palette === next) return;
  controller.palette = next;
  touch(controller);
  notify(controller);
}

export function setRules(sessionId, rules) {
  const controller = getController(sessionId);
  controller.rules = cleanRules(rules);
  if (controller.colorBy === 'rules') { recolor(controller); rebuildScene(controller, { reheat: 0 }); }
  touch(controller);
  notify(controller);
}

export function setDepth(sessionId, depth) {
  const controller = getController(sessionId);
  const next = cleanDepth(depth);
  if (controller.depth === next) return;
  controller.depth = next;
  if (controller.mode === 'neighbors') rebuildScene(controller, { reheat: 0.5 });
  touch(controller);
  notify(controller);
}

export function setRefs(sessionId, on) {
  const controller = getController(sessionId);
  const next = Boolean(on);
  if (controller.refs === next) return;
  controller.refs = next;
  rebuildScene(controller, { reheat: controller.mode === 'space' ? 0.3 : 0 });
  touch(controller);
  notify(controller);
}

// Gira a vista 3D. A orbita e o mesmo objeto que a cena guarda, entao o
// desenho seguinte ja a ve.
export function rotate(sessionId, dx, dy) {
  const controller = controllers.get(sessionId);
  if (!controller || controller.mode !== 'space') return;
  const next = orbitBy(controller.orbit, dx, dy);
  controller.orbit.yaw = next.yaw;
  controller.orbit.pitch = next.pitch;
  controller.hooks?.onFrame();
}

// A camera mudou. `byUser` separa o gesto do usuario do enquadramento
// automatico, que nao conta como interacao.
export function setView(sessionId, view, { byUser = false } = {}) {
  const controller = controllers.get(sessionId);
  if (!controller || !view || ![view.x, view.y, view.s].every(Number.isFinite)) return;
  controller.view = { x: view.x, y: view.y, s: view.s };
  if (byUser) { controller.needsFit = false; controller.autoFit = false; touch(controller); } else if (controller.interacted) persistSoon(controller);
}

/* ── arraste ──────────────────────────────────────────────────────── */

// Arrastar uma pasta ou um documento move o agrupamento inteiro. A raiz fica
// presa na origem; o painel trata o gesto sobre ela como deslocamento da camera.
// Nos Vizinhos o arquivo arrastado se move sozinho, e o foco fica preso. As
// vistas sem simulacao recusam, e o gesto vira deslocamento da camera.
export function dragStart(sessionId, id) {
  const controller = getController(sessionId);
  const entry = controller.scene.index.get(id);
  if (!entry) return false;
  if (controller.mode === 'neighbors') {
    const node = controller.alt.nodes.get(id);
    if (!node || id === controller.focus || !controller.alt.sim) return false;
    controller.dragging = node;
    node.fx = node.x;
    node.fy = node.y;
    controller.alt.sim.alphaTarget(0.2);
    controller.alt.sim.alpha(Math.max(controller.alt.sim.alpha(), 0.2));
    startLoop(controller);
    return true;
  }
  if (controller.mode !== 'map') return false;
  const dirId = entry.kind === 'dir' ? id : controller.scene.dirs[controller.scene.docs[entry.at].dir].id;
  if (dirId === ROOT_ID) return false;
  const node = controller.simNodes.get(dirId);
  if (!node) return false;
  controller.dragging = node;
  node.fx = node.x;
  node.fy = node.y;
  controller.sim.alphaTarget(0.2);
  controller.sim.alpha(Math.max(controller.sim.alpha(), 0.2));
  startLoop(controller);
  return true;
}

export function dragMove(sessionId, dx, dy) {
  const node = controllers.get(sessionId)?.dragging;
  if (!node) return;
  node.fx += dx;
  node.fy += dy;
  // Com movimento desligado nao ha laco: o no acompanha o ponteiro na hora.
  const controller = controllers.get(sessionId);
  if (!controller.loop) { node.x = node.fx; node.y = node.fy; controller.hooks?.onFrame(); }
}

export function dragEnd(sessionId) {
  const controller = controllers.get(sessionId);
  const node = controller?.dragging;
  if (!node) return;
  node.fx = null;
  node.fy = null;
  controller.dragging = null;
  activeSim(controller)?.alphaTarget(0);
  touch(controller);
  if (!controller.loop) startLoop(controller);
}

/* ── pedido de foco vindo do explorador ───────────────────────────── */

function consumeFocusRequest(controller) {
  const session = getSession(controller.sessionId);
  const request = session?.docgraph?.focusRequest;
  if (!request || !controller.tree || !controller.attached) return;
  session.docgraph.focusRequest = null;
  let id = idOfPath(controller.root, request.path);
  // Uma pasta sem Markdown nao esta no grafo: vale o ancestral que esta.
  while (id && id !== ROOT_ID && !controller.tree.nodes.has(id)) id = parentOf(id);
  if (id && controller.tree.nodes.has(id)) reveal(controller.sessionId, id);
}

/* ── leitura para o painel e para as verificacoes ─────────────────── */

export function pathToRoot(sessionId, id) {
  const controller = controllers.get(sessionId);
  if (!controller?.tree || !id) return null;
  return new Set([...ancestorsOf(controller.tree, id), id]);
}

export function debugCounts() {
  let loops = 0; let attached = 0; let watched = 0;
  controllers.forEach((controller) => { if (controller.loop) loops += 1; if (controller.attached) attached += 1; watched += controller.watched.size; });
  return { controllers: controllers.size, attached, loops, watched };
}
