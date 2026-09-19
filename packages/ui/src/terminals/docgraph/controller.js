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

import * as files from '../files.js';
import { emitDocgraphEvent, getSession, isDemo, registerDocgraphHooks, subscribe, subscribeChanges, unwatchPathAs, watchPathAs } from '../runtime.js';
import { motionOff } from '../motion.js';
import { createIndexer, makeBootId } from './indexer.js';
import {
  ROOT_ID, absPath, ancestorsOf, buildTree, computeColorGroups, defaultExpansion, diffIndex, effectiveExpanded, groupOf, idOfPath,
  isBroadRoot, pickWatchDirs, revealSet, shouldAdopt, visibleScene,
} from './model.js';
import { loadUi, saveUi } from './persist.js';
import { matchSet } from './search.js';
import { assignSlots, boundsOf, createSim, discRadius, fitView, hashAngle, hubRadius, isCold, seedRadial, settle, slotExtent, slotPosition, updateSim } from './layout.js';
import { track } from './stats.js';

const WATCH_CAP = 32;
const SAFETY_NET_MS = 15000;
const PERSIST_MS = 400;
const SYNC_SETTLE_DIRS = 400;
const EMPTY_SCENE = { dirs: [], docs: [], links: [], index: new Map(), revision: 0 };

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
    groups: [],
    otherDocs: 0,
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
    scan: (key, token, root) => files.docgraph.scan(key, token, root),
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
  };
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

function loadSavedUi(controller) {
  controller.uiLoaded = true;
  const store = storage();
  const saved = store ? loadUi(store, controller.rootKey) : null;
  if (!saved) return;
  controller.bulk = saved.bulk;
  controller.overrides = { expanded: new Set(saved.expanded), collapsed: new Set(saved.collapsed) };
  controller.tones = saved.tones;
  controller.selected = saved.selected;
  if (saved.view) { controller.view = saved.view; controller.needsFit = false; controller.autoFit = false; }
  // O que veio do disco ja era escolha do usuario.
  controller.interacted = true;
}

/* ── raiz ─────────────────────────────────────────────────────────── */

function resetFor(controller, root) {
  flushPersist(controller);
  controller.indexer.reset();
  releaseWatches(controller);
  stopLoop(controller);
  Object.assign(controller, {
    root, rootKey: null, status: 'idle', error: null, refreshing: false, stale: false, confirmedBroad: false, meta: null, tree: null,
    decided: new Map(), bulk: null, overrides: { expanded: new Set(), collapsed: new Set() }, expanded: new Set(), tones: {}, groups: [],
    otherDocs: 0, selected: null, query: '', matches: null, view: null, needsFit: true, autoFit: true, interacted: false, uiLoaded: false,
    simNodes: new Map(), parked: new Map(), slots: new Map(), sim: null, scene: EMPTY_SCENE,
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
  if (!controller.uiLoaded) { controller.rootKey = scan.canonicalRoot || controller.root; loadSavedUi(controller); }

  const meta = {
    docs: scan.docs.length, dirs: scan.dirs, visited: scan.visited, elapsedMs: scan.elapsedMs, ipcMs,
    partial: Boolean(scan.partial), stopped: scan.stopped || null, issues: scan.issues || [], issuesTotal: scan.issuesTotal || 0,
    excluded: scan.excluded || {}, fingerprint: scan.fingerprint, scannedAt: Date.now(),
  };

  // Nada mudou: nenhuma arvore nova, nenhum desenho, nenhuma simulacao.
  if (controller.tree && scan.fingerprint && scan.fingerprint === controller.meta?.fingerprint) {
    controller.meta = { ...controller.meta, scannedAt: meta.scannedAt, elapsedMs: meta.elapsedMs, ipcMs };
    controller.stale = false;
    scheduleNet(controller);
    notify(controller);
    return;
  }
  // Um indice completo nao e trocado por um que parou no teto ou no prazo.
  if (controller.tree && !shouldAdopt(controller.meta, meta)) {
    controller.stale = true;
    scheduleNet(controller);
    notify(controller);
    return;
  }

  const started = performance.now();
  const session = getSession(controller.sessionId);
  const next = buildTree(scan, { rootName: baseName(controller.root) || session?.name || '' });
  const diff = diffIndex(controller.tree, next);
  if (controller.tree) carryRenames(controller, diff);
  controller.tree = next;
  controller.meta = meta;
  controller.stale = false;
  controller.status = next.docCount ? 'ready' : 'empty';
  controller.error = null;
  if (controller.selected && !next.nodes.has(controller.selected)) controller.selected = null;
  const colors = computeColorGroups(next, controller.tones);
  controller.tones = colors.tones;
  controller.groups = colors.groups;
  controller.otherDocs = colors.otherDocs || 0;
  if (controller.query) controller.matches = matchSet(next, controller.query);
  recomputeExpanded(controller);
  track.sample('buildMs', performance.now() - started);
  rebuildScene(controller, { reheat: diff.changed ? 0.15 : 0 });
  consumeFocusRequest(controller);
  scheduleNet(controller);
  notify(controller);
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
    controller.scene = { ...EMPTY_SCENE, revision: controller.scene.revision + 1 };
    controller.hooks?.onScene(controller.scene);
    reconcileWatches(controller);
    return;
  }
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
  // Primeira cena da raiz: enquadra, ou aplica a visao que veio do estado
  // salvo. Ela chega depois da montagem do painel, entao a camera ainda esta
  // na visao padrao e precisa recebe-la daqui.
  if (first) {
    if (controller.needsFit) fitToArea(controller, { animate: false });
    else if (controller.view) controller.hooks?.applyView(controller.view, { animate: false });
  }
  if (!isCold(controller.sim)) startLoop(controller);
  reconcileWatches(controller);
}

function buildRenderScene(controller, visible) {
  const tree = controller.tree;
  const index = new Map();
  const groupRoots = new Set(Object.keys(controller.tones));
  const dirs = visible.dirs.map((id, at) => {
    const info = tree.nodes.get(id);
    index.set(id, { kind: 'dir', at });
    const group = groupOf(tree, id, controller.tones);
    return {
      id, kind: info.kind, sim: controller.simNodes.get(id), tone: group ? controller.tones[group] : null,
      expanded: controller.expanded.has(id), count: info.docCount, docTotal: info.docs.length, partial: info.partial,
      label: info.name || baseName(controller.root), groupRoot: groupRoots.has(id),
    };
  });
  const docs = [];
  visible.dirs.forEach((dirId) => {
    if (!controller.expanded.has(dirId)) return;
    const info = tree.nodes.get(dirId);
    const at = index.get(dirId).at;
    const slots = controller.slots.get(dirId);
    const phase = hashAngle(dirId);
    const tone = dirs[at].tone;
    info.docs.forEach((docId) => {
      const position = slotPosition(slots.get(docId), dirs[at].sim.hub, phase);
      docs.push({ id: docId, dir: at, dx: position.x, dy: position.y, tone, label: tree.nodes.get(docId).name });
    });
  });
  // Por tom, para o canvas trocar de cor o minimo de vezes.
  docs.sort((a, b) => (a.tone || '').localeCompare(b.tone || ''));
  docs.forEach((doc, at) => index.set(doc.id, { kind: 'doc', at }));
  const links = visible.links.map((link) => {
    const target = index.get(link.target).at;
    return { source: index.get(link.source).at, target, tone: dirs[target].tone, depth: dirs[target].sim.depth };
  });
  return { dirs, docs, links, index, order: visible.order, revision: controller.scene.revision + 1 };
}

// O laco existe so enquanto a simulacao esta quente e o painel esta a vista.
// Com movimento desligado, ou fora da tela, assenta de uma vez: o WKWebView
// fora da tela nao entrega quadro de animacao.
function startLoop(controller) {
  if (controller.loop || !controller.attached || !controller.sim) return;
  if (motionOff() || document.visibilityState === 'hidden') {
    settle(controller.sim, { ticks: 400, budgetMs: 400 });
    controller.hooks?.onFrame();
    settled(controller);
    return;
  }
  track.on('loop');
  controller.loopKind = 'raf';
  const step = () => {
    controller.loop = 0;
    if (!controller.attached || !controller.sim) { track.off('loop'); controller.loopKind = null; return; }
    const started = performance.now();
    controller.sim.tick();
    track.sample('tickMs', performance.now() - started);
    controller.hooks?.onFrame();
    if (isCold(controller.sim) && !controller.dragging) { track.off('loop'); controller.loopKind = null; settled(controller); return; }
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

export function fitToArea(sessionId, options) {
  const controller = typeof sessionId === 'string' ? getController(sessionId) : sessionId;
  const size = controller.hooks?.getSize?.();
  if (!size || size.width < 2 || size.height < 2 || !controller.simNodes.size) return false;
  const view = fitView(boundsOf([...controller.simNodes.values()]), size.width, size.height);
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
  const wait = Math.max(SAFETY_NET_MS, 25 * last);
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
  listen(document, 'visibilitychange', () => { if (document.visibilityState === 'visible') { rescanNow(); if (controller.sim && !isCold(controller.sim)) startLoop(controller); } else stopLoop(controller); });

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
  if (controller.sim && !isCold(controller.sim)) settle(controller.sim, { ticks: 200, budgetMs: 12 });
  controller.dragging = null;
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

export function select(sessionId, id, { keyboard = false } = {}) {
  const controller = getController(sessionId);
  const next = id && controller.tree?.nodes.has(id) ? id : null;
  if (controller.selected === next && controller.keyboard === keyboard) return;
  controller.selected = next;
  controller.keyboard = keyboard;
  touch(controller);
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
  const colors = computeColorGroups(controller.tree, {}, { regroup: true });
  controller.tones = colors.tones;
  controller.groups = colors.groups;
  controller.otherDocs = colors.otherDocs || 0;
  touch(controller);
  rebuildScene(controller, { reheat: 0 });
  notify(controller);
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
export function dragStart(sessionId, id) {
  const controller = getController(sessionId);
  const entry = controller.scene.index.get(id);
  if (!entry) return false;
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
  controller.sim.alphaTarget(0);
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
