// SPDX-License-Identifier: Apache-2.0
// Ponteiro, roda, pinca e teclado do grafo da documentacao. Traduz o gesto em
// intencao e entrega a camera, ao controlador ou as acoes do painel; nao guarda
// estado do grafo.
//
// Convencoes, as mesmas do resto do produto:
//
// - Pasta: clique seleciona e alterna a expansao, como na arvore do explorador.
//   O segundo clique de um duplo e ignorado, senao ela abriria e fecharia.
// - Documento: clique seleciona; duplo clique e Enter abrem. Abrir ativa a aba
//   do arquivo e esconde o grafo, por isso nao acontece no clique simples.
// - Fundo: arrastar desloca a camera, clique limpa a selecao e duplo clique
//   aproxima, como no Mapa, que usa a mesma camera.
// - Arrastar uma marca move o agrupamento, e so depois de 4 px acumulados, o
//   mesmo limiar de `drag.js`. O limiar e proprio porque o `moved` da camera e
//   por evento, e um deslocamento lento passaria por clique.
// - A raiz fica presa na origem: o gesto sobre ela desloca a camera.

import { ROOT_ID } from './model.js';
import { track } from './stats.js';

const DRAG_THRESHOLD = 4;
const HOVER_DELAY_MS = 120;

export function bindInteraction(host, { camera, renderer, controller, api, actions }) {
  const sessionId = controller.sessionId;
  const offs = [];
  const on = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    track.on('listener');
    offs.push(() => { target.removeEventListener(type, handler, options); track.off('listener'); });
  };

  const local = (event) => { const rect = host.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const nodeOf = (id) => controller.tree?.nodes.get(id) || null;

  let press = null;
  let suppressClick = false;
  let hoverTimer = 0;
  let pinchScale = 1;

  const setHover = (id, point) => {
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = 0; }
    if (renderer.state.hover !== id) renderer.setState({ hover: id });
    host.style.cursor = id ? 'pointer' : 'default';
    if (!id) { actions.onHover(null); return; }
    hoverTimer = setTimeout(() => { hoverTimer = 0; actions.onHover({ id, x: point.x, y: point.y }); }, HOVER_DELAY_MS);
  };

  /* ── roda e pinca ───────────────────────────────────────────────── */

  on(host, 'wheel', (event) => {
    event.preventDefault();
    actions.byUser();
    // A pinca do trackpad chega como roda com `ctrlKey` e deltas pequenos.
    camera.zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.012 : 0.0016)), event.clientX, event.clientY);
  }, { passive: false });
  // No WebKit a pinca tambem chega como evento de gesto.
  on(host, 'gesturestart', (event) => { event.preventDefault(); pinchScale = 1; });
  on(host, 'gesturechange', (event) => {
    event.preventDefault();
    const scale = Number(event.scale) || 1;
    actions.byUser();
    camera.zoomAt(scale / pinchScale, event.clientX, event.clientY);
    pinchScale = scale;
  });
  on(host, 'gestureend', (event) => { event.preventDefault(); });

  /* ── ponteiro ───────────────────────────────────────────────────── */

  on(host, 'pointerdown', (event) => {
    if (event.button !== 0) return;
    host.focus({ preventScroll: true });
    const point = local(event);
    const id = renderer.pick(point.x, point.y);
    actions.onHover(null);
    press = { id: id && id !== ROOT_ID ? id : null, x: event.clientX, y: event.clientY, travelled: 0, dragging: false, panning: false };
    // A captura do ponteiro recusa um id que o navegador nao conhece, que e o
    // caso de um evento montado a mao pela verificacao: o gesto segue sem ela.
    try {
      if (!press.id) { press.panning = true; camera.handlers.onPointerDown(event); } else host.setPointerCapture?.(event.pointerId);
    } catch (_error) { /* sem captura */ }
  });

  on(host, 'pointermove', (event) => {
    if (!press) {
      const point = local(event);
      setHover(renderer.pick(point.x, point.y), point);
      return;
    }
    const dx = event.clientX - press.x;
    const dy = event.clientY - press.y;
    press.x = event.clientX;
    press.y = event.clientY;
    press.travelled += Math.abs(dx) + Math.abs(dy);
    if (press.panning) { if (press.travelled > DRAG_THRESHOLD) actions.byUser(); camera.handlers.onPointerMove(event); return; }
    if (!press.dragging && press.travelled > DRAG_THRESHOLD) press.dragging = api.dragStart(sessionId, press.id);
    if (press.dragging) { const scale = camera.getView().s; api.dragMove(sessionId, dx / scale, dy / scale); }
  });

  const release = (event) => {
    if (!press) return;
    const current = press;
    press = null;
    if (current.panning) camera.handlers.onPointerUp(event);
    if (current.dragging) api.dragEnd(sessionId);
    // O `click` vem logo depois: um arraste nao pode virar clique.
    suppressClick = current.travelled > DRAG_THRESHOLD;
  };
  on(host, 'pointerup', release);
  on(host, 'pointercancel', release);
  on(host, 'pointerleave', () => { if (!press) setHover(null); });

  on(host, 'click', (event) => {
    if (suppressClick) { suppressClick = false; return; }
    const point = local(event);
    const id = renderer.pick(point.x, point.y);
    if (!id) { api.select(sessionId, null); return; }
    const node = nodeOf(id);
    api.select(sessionId, id);
    if (node && node.kind === 'dir' && event.detail <= 1) api.toggle(sessionId, id);
  });

  on(host, 'dblclick', (event) => {
    const point = local(event);
    const id = renderer.pick(point.x, point.y);
    const node = id && nodeOf(id);
    if (node?.kind === 'doc') { actions.open(id); return; }
    if (!id) { actions.byUser(); camera.handlers.onDoubleClick(event); }
  });

  on(host, 'contextmenu', (event) => {
    const point = local(event);
    const id = renderer.pick(point.x, point.y);
    if (!id) return;
    event.preventDefault();
    api.select(sessionId, id);
    actions.menu(id, { x: event.clientX, y: event.clientY, align: 'left', flipOffset: 0 });
  });

  /* ── teclado ────────────────────────────────────────────────────── */

  // Traz o no para dentro da area se ele estiver fora dela.
  const bringIntoView = (id) => {
    const spot = renderer.locate(id);
    if (!spot) return;
    const screen = renderer.toScreen(spot.x, spot.y);
    const margin = 40;
    if (screen.x < margin || screen.y < margin || screen.x > renderer.width - margin || screen.y > renderer.height - margin) camera.centerWorld(spot.x, spot.y, 260);
  };
  const moveTo = (id) => { if (!id) return; api.select(sessionId, id, { keyboard: true }); bringIntoView(id); };

  on(host, 'keydown', (event) => {
    if (event.target !== host) return;
    const order = controller.scene.order || [];
    if (!order.length) return;
    const key = event.key;
    const meta = event.metaKey || event.ctrlKey;
    const current = controller.selected && order.includes(controller.selected) ? controller.selected : null;
    const at = current ? order.indexOf(current) : -1;
    const node = current ? nodeOf(current) : null;
    const done = () => { event.preventDefault(); event.stopPropagation(); };

    if (meta && key.toLowerCase() === 'f') { done(); actions.focusSearch(); return; }
    if (meta) return;
    if (key === 'ArrowDown') { done(); moveTo(order[Math.min(order.length - 1, at + 1)] || order[0]); return; }
    if (key === 'ArrowUp') { done(); moveTo(at <= 0 ? order[0] : order[at - 1]); return; }
    if (key === 'Home') { done(); moveTo(order[0]); return; }
    if (key === 'End') { done(); moveTo(order[order.length - 1]); return; }
    if (key === 'ArrowLeft') {
      done();
      if (!node) { moveTo(order[0]); return; }
      if (node.kind === 'dir' && controller.expanded.has(current)) api.toggle(sessionId, current);
      else if (node.parent !== null) moveTo(node.parent);
      return;
    }
    if (key === 'ArrowRight') {
      done();
      if (!node) { moveTo(order[0]); return; }
      if (node.kind === 'doc') return;
      if (!controller.expanded.has(current)) { if (current !== ROOT_ID) api.toggle(sessionId, current); } else moveTo(order[at + 1]);
      return;
    }
    if (key === 'Enter') {
      done();
      if (!node) return;
      if (node.kind === 'doc') { if (event.altKey) actions.preview(current); else actions.open(current); } else if (current !== ROOT_ID) api.toggle(sessionId, current);
      return;
    }
    if (key === ' ') { done(); if (node && node.kind === 'dir') api.toggle(sessionId, current); return; }
    if (key === '+' || key === '=') { done(); actions.byUser(); camera.zoomBy(1.35); return; }
    if (key === '-' || key === '_') { done(); actions.byUser(); camera.zoomBy(1 / 1.35); return; }
    if (key === '0') { done(); actions.fit(); return; }
    if (key === 'c' || key === 'C') { done(); actions.center(); return; }
    if (key === '/') { done(); actions.focusSearch(); return; }
    if (key === 'F10' && event.shiftKey && current) {
      done();
      const spot = renderer.locate(current);
      const screen = renderer.toScreen(spot.x, spot.y);
      const rect = host.getBoundingClientRect();
      actions.menu(current, { x: rect.left + screen.x, y: rect.top + screen.y, align: 'left', flipOffset: 0 });
      return;
    }
    if (key === 'Escape') { actions.escape(); }
  });

  return () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    if (press?.dragging) api.dragEnd(sessionId);
    offs.forEach((off) => off());
    host.style.cursor = '';
  };
}
