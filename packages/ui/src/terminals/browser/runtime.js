// SPDX-License-Identifier: Apache-2.0
// Cola entre o runtime do estudio e o Dev Browser de cada sessao: lanca o
// Chromium pelo Rust, conecta o CDP pelo WebSocket, mantem a sessao de
// navegacao e o screencast fora do React, e expoe as acoes que o painel, os
// atalhos e a paleta usam. O estado visivel fica em `session.browser` e
// muda por eventos `browser` do runtime.
//
// O Chromium nasce quando o painel e aberto pela primeira vez, nunca ao
// criar a sessao. Fechar a aba esconde e pausa o screencast; o agente pode
// continuar dirigindo pela porta. Encerrar e explicito, ou vem junto com o
// fim da sessao.

import { invoke, isTauri, listen, NATIVE_ONLY_MESSAGE } from '../../lib/native.js';
import { copyToClipboard } from '../../lib/helpers.js';
import {
  activateTab, addTab, announce, emitBrowserEvent, getSession, getState, registerBrowserHooks,
} from '../runtime.js';
import { CDPClient } from './cdp.js';
import { BrowserSession } from './session.js';
import { Screencast } from './screencast.js';
import { bindInput } from './input.js';

const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 800;
const SEARCH_URL = 'https://www.google.com/search?q=';

// Controladores vivos por sessao do estudio: cliente CDP, sessao de
// navegacao, screencast e o canvas adotado.
const controllers = new Map();
let listenersInstalled = false;
let viewVisible = true;

function messageOf(error) {
  if (!error) return 'Erro desconhecido';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

function emit(session) {
  emitBrowserEvent(session.id);
}

export function browserState(sessionId) {
  return getSession(sessionId)?.browser || null;
}

function looksLikeUrl(text) {
  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(text)) return true;
  if (/\s/.test(text)) return false;
  if (/^localhost(:\d+)?(\/|$)/i.test(text)) return true;
  if (/^[\d.]+(:\d+)?(\/|$)/.test(text)) return true;
  if (/^[^\s]+:\d+(\/|$)/.test(text)) return true;
  if (/\.[a-z]{2,}(\/|:|$)/i.test(text)) return true;
  return false;
}

// O que o usuario digitou na barra vira URL, ou busca quando nao parece uma.
export function resolveInput(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (looksLikeUrl(text)) return /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(text) ? text : `http://${text}`;
  return `${SEARCH_URL}${encodeURIComponent(text)}`;
}

/* ── aba do browser ───────────────────────────────────────────────── */

function findBrowserTab(session) {
  return session.editor.tabs.find((tab) => tab.kind === 'browser') || null;
}

// Garante a aba do browser na sessao e a ativa. Com `start`, lanca o
// Chromium se ainda nao esta vivo; sem, a aba mostra "Abrir browser".
export function openBrowserTab(sessionId, { start = true, url } = {}) {
  const session = getSession(sessionId);
  if (!session) return null;
  let tab = findBrowserTab(session);
  if (!tab) {
    tab = {
      id: `browser-${session.id}`,
      kind: 'browser',
      path: null,
      name: 'Browser',
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
    addTab(sessionId, tab);
  } else {
    activateTab(sessionId, tab.id);
  }
  session.browser.autoStart = start;
  if (start && ['idle', 'stopped', 'error'].includes(session.browser.status)) startBrowser(sessionId, { url }).catch(() => {});
  return tab;
}

/* ── ciclo de vida ────────────────────────────────────────────────── */

function markStopped(session, message) {
  const browser = session.browser;
  const controller = controllers.get(session.id);
  if (controller) {
    controllers.delete(session.id);
    disposeController(controller);
  }
  browser.status = 'stopped';
  browser.loading = false;
  browser.error = message || null;
  browser.info = null;
  emit(session);
}

function disposeController(controller) {
  controller.offs.forEach((off) => { try { off(); } catch (_error) { /* ja solto */ } });
  controller.offs = [];
  controller.unbind?.();
  controller.unbind = null;
  controller.cast.dispose();
  controller.session.dispose();
  controller.cdp.onDisconnected = null;
  controller.cdp.close();
}

function installListeners() {
  if (listenersInstalled || !isTauri()) return;
  listenersInstalled = true;
  listen('browser://exit', (payload) => {
    const session = payload?.sessionId ? getSession(payload.sessionId) : null;
    if (!session || !controllers.has(session.id)) return;
    const detail = payload.signal ? `sinal ${payload.signal}` : `código ${payload.code ?? '?'}`;
    markStopped(session, `O Chromium terminou, ${detail}`);
  }).catch(() => {});
  // O Rust instala um Chromium so por vez, e enquanto isso toda sessao que
  // espera um browser abrir mostra o mesmo andamento.
  listen('browser://install', (payload) => {
    const message = payload?.running ? (payload.message || '') : null;
    getState().sessions.forEach((session) => {
      if (session.browser.status !== 'starting' || session.browser.install === message) return;
      session.browser.install = message;
      emit(session);
    });
  }).catch(() => {});
}

async function syncActive(session, controller) {
  const target = controller.session.activeTarget();
  const browser = session.browser;
  browser.url = target?.url && target.url !== 'about:blank' ? target.url : (target?.url || '');
  browser.title = target?.title || '';
  const nav = target ? await controller.session.navState(target.targetId) : { canGoBack: false, canGoForward: false };
  browser.canGoBack = nav.canGoBack;
  browser.canGoForward = nav.canGoForward;
  emit(session);
}

function wire(session, controller) {
  const { cdp, session: bs } = controller;
  const forActive = (event) => event.sessionId && event.sessionId === bs.activeSessionId();
  controller.offs.push(bs.on('targets-changed', () => { syncActive(session, controller).catch(() => {}); }));
  controller.offs.push(bs.on('active-changed', () => { syncActive(session, controller).catch(() => {}); }));
  controller.offs.push(bs.on('target-crashed', ({ targetId }) => {
    if (targetId === bs.activeTargetId) {
      session.browser.error = 'A aba travou';
      emit(session);
    }
  }));
  controller.offs.push(bs.on('dialog', (dialog) => {
    // Sem interface de dialogo nesta fase: confirm e prompt recebem "nao".
    if (!dialog.answered) bs.answerDialog(dialog.sessionId, false).catch(() => {});
  }));
  controller.offs.push(cdp.on('Page.frameStartedLoading', (event) => {
    if (!forActive(event)) return;
    session.browser.loading = true;
    emit(session);
  }));
  controller.offs.push(cdp.on('Page.frameStoppedLoading', (event) => {
    if (!forActive(event)) return;
    session.browser.loading = false;
    syncActive(session, controller).catch(() => {});
  }));
  controller.offs.push(cdp.on('Page.frameNavigated', (event) => {
    if (!forActive(event) || event.params.frame?.parentId) return;
    session.browser.url = event.params.frame?.url || '';
    session.browser.error = null;
    syncActive(session, controller).catch(() => {});
  }));
  controller.offs.push(cdp.on('Page.navigatedWithinDocument', (event) => {
    if (!forActive(event)) return;
    session.browser.url = event.params.url || '';
    syncActive(session, controller).catch(() => {});
  }));
  cdp.onDisconnected = () => markStopped(session, 'Conexão com o Chromium perdida');
}

function canvasSize(session) {
  const canvas = session.browser.canvas;
  if (!canvas) return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
  const rect = canvas.getBoundingClientRect();
  return { width: Math.max(320, Math.floor(rect.width) || DEFAULT_WIDTH), height: Math.max(240, Math.floor(rect.height) || DEFAULT_HEIGHT) };
}

// Lanca o Chromium da sessao pelo Rust, ou religa a um que ja esta vivo, e
// conecta o CDP. Idempotente: uma segunda chamada enquanto abre nao faz nada.
export async function startBrowser(sessionId, { url } = {}) {
  const session = getSession(sessionId);
  if (!session) return null;
  const browser = session.browser;
  if (browser.status === 'starting' || browser.status === 'ready') return browser.info;
  if (!isTauri()) {
    browser.status = 'error';
    browser.error = NATIVE_ONLY_MESSAGE;
    emit(session);
    return null;
  }
  installListeners();
  browser.status = 'starting';
  browser.error = null;
  browser.install = null;
  emit(session);
  const epoch = (browser.epoch || 0) + 1;
  browser.epoch = epoch;
  try {
    const size = canvasSize(session);
    const info = await invoke('browser_start', {
      sessionId: session.id,
      cwd: session.cwd,
      width: size.width,
      height: size.height,
      origin: window.location.origin,
      startUrl: url || browser.url || '',
    });
    if (browser.epoch !== epoch) return null;
    const cdp = new CDPClient();
    await cdp.connect(info.wsUrl);
    const bs = new BrowserSession(cdp);
    await bs.start();
    const cast = new Screencast({ cdp, session: bs });
    const controller = { cdp, session: bs, cast, offs: [], unbind: null };
    controllers.set(session.id, controller);
    wire(session, controller);
    browser.info = info;
    browser.status = 'ready';
    browser.error = null;
    browser.install = null;
    emit(session);
    if (browser.canvas) attachCanvas(session.id, browser.canvas, browser.canvasHandlers || {});
    cast.setVisible(viewVisible && Boolean(browser.canvas));
    await syncActive(session, controller);
    return info;
  } catch (error) {
    if (browser.epoch !== epoch) return null;
    const controller = controllers.get(session.id);
    if (controller) { controllers.delete(session.id); disposeController(controller); }
    browser.status = 'error';
    browser.error = messageOf(error);
    browser.info = null;
    browser.install = null;
    emit(session);
    return null;
  }
}

// Encerra o Chromium da sessao. Com `purge` o perfil vai junto, o que e o
// caso quando a sessao e encerrada.
export async function stopBrowser(sessionId, { purge = false, silent = false } = {}) {
  const session = getSession(sessionId);
  if (!session) return;
  const browser = session.browser;
  browser.epoch = (browser.epoch || 0) + 1;
  const controller = controllers.get(session.id);
  if (controller) {
    controllers.delete(session.id);
    disposeController(controller);
  }
  browser.status = purge ? 'idle' : 'stopped';
  browser.loading = false;
  browser.info = null;
  browser.error = null;
  if (!silent) emit(session);
  if (isTauri()) await invoke('browser_stop', { sessionId: session.id, purge }).catch(() => {});
}

// Depois de uma recarga do webview o Chromium continua vivo no Rust:
// religa as sessoes que tem instancia e reabre a aba delas.
export async function reconcileBrowsers() {
  if (!isTauri()) return;
  let list = [];
  try { list = await invoke('browser_list'); } catch (_error) { return; }
  if (!Array.isArray(list)) return;
  list.forEach((info) => {
    const session = getSession(info.sessionId);
    if (!session) return;
    session.browser.restoreOpen = false;
    openBrowserTab(session.id, { start: true });
  });
}

/* ── canvas ───────────────────────────────────────────────────────── */

export function attachCanvas(sessionId, canvas, handlers = {}) {
  const session = getSession(sessionId);
  if (!session || !canvas) return;
  const browser = session.browser;
  browser.canvas = canvas;
  browser.canvasHandlers = handlers;
  const controller = controllers.get(session.id);
  if (!controller) return;
  controller.unbind?.();
  controller.cast.attach(canvas);
  controller.unbind = bindInput(canvas, {
    send: (method, params) => {
      const target = controller.session.activeSessionId();
      if (!target) return Promise.reject(new Error('Sem aba ativa'));
      return controller.cdp.send(method, params, target);
    },
    toPageCoords: (event) => controller.cast.toPageCoords(event),
    focusUrl: handlers.focusUrl,
    back: () => goBack(sessionId),
    forward: () => goForward(sessionId),
    reload: (hard) => reload(sessionId, hard),
    stopLoading: () => stopLoading(sessionId),
  });
  controller.cast.setVisible(viewVisible);
}

export function detachCanvas(sessionId) {
  const session = getSession(sessionId);
  if (!session) return;
  session.browser.canvas = null;
  session.browser.canvasHandlers = null;
  const controller = controllers.get(session.id);
  if (!controller) return;
  controller.unbind?.();
  controller.unbind = null;
  controller.cast.setVisible(false);
  controller.cast.detach();
}

export function hasFrame(sessionId) {
  return Boolean(controllers.get(sessionId)?.cast.hasFrame());
}

/* ── navegacao ────────────────────────────────────────────────────── */

function active(sessionId) {
  const controller = controllers.get(sessionId);
  const targetId = controller?.session.activeTargetId;
  return controller && targetId ? { controller, targetId } : null;
}

export async function navigate(sessionId, raw) {
  const session = getSession(sessionId);
  const url = resolveInput(raw);
  if (!session || !url) return;
  const current = active(sessionId);
  if (!current) {
    // Sem Chromium ainda: guarda e abre com essa URL.
    session.browser.url = url;
    emit(session);
    await startBrowser(sessionId, { url });
    return;
  }
  session.browser.url = url;
  emit(session);
  await current.controller.session.navigate(current.targetId, url);
}

export async function reload(sessionId, hard = false) {
  const current = active(sessionId);
  if (current) await current.controller.session.reload(current.targetId, Boolean(hard));
}

export async function stopLoading(sessionId) {
  const current = active(sessionId);
  if (current) await current.controller.session.stopLoading(current.targetId);
}

export async function goBack(sessionId) {
  const current = active(sessionId);
  if (current) await current.controller.session.goBack(current.targetId);
}

export async function goForward(sessionId) {
  const current = active(sessionId);
  if (current) await current.controller.session.goForward(current.targetId);
}

export async function recoverTab(sessionId) {
  const current = active(sessionId);
  if (!current) return;
  const session = getSession(sessionId);
  await current.controller.session.recoverTarget(current.targetId);
  if (session) { session.browser.error = null; emit(session); }
}

// ⌘R e acelerador do menu nativo: com a aba do browser ativa na sessao
// selecionada, recarrega a pagina e devolve true; senao false e o app
// recarrega os dados.
export function reloadActive() {
  const { selected } = getState();
  if (!selected) return false;
  const tab = selected.editor.tabs.find((entry) => entry.id === selected.editor.activeId);
  if (!tab || tab.kind !== 'browser') return false;
  if (selected.browser.status !== 'ready') return true;
  reload(selected.id).catch(() => {});
  return true;
}

export function isBrowserFocused() {
  const node = document.activeElement;
  return Boolean(node && node.closest && node.closest('.terminais-browser'));
}

export async function copyPort(sessionId) {
  const info = getSession(sessionId)?.browser.info;
  if (!info) return false;
  const ok = await copyToClipboard(String(info.port));
  announce(ok ? `Porta ${info.port} copiada` : 'Não foi possível copiar');
  return ok;
}

/* ── ganchos do runtime ───────────────────────────────────────────── */

registerBrowserHooks({
  sessionClosed: (session) => { stopBrowser(session.id, { purge: true, silent: true }).catch(() => {}); },
  directoryChanged: (session) => { stopBrowser(session.id).catch(() => {}); },
  visibility: (visible) => {
    viewVisible = visible;
    controllers.forEach((controller, id) => {
      const session = getSession(id);
      controller.cast.setVisible(visible && Boolean(session?.browser.canvas));
    });
  },
});
