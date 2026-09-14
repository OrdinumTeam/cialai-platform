// SPDX-License-Identifier: Apache-2.0
// Runtime do estudio de terminais em escopo de modulo. As sessoes, as
// instancias do xterm, as metricas e o estado do editor de cada sessao vivem
// aqui, fora do React, para sobreviver a troca de secao e a troca do card
// selecionado. A view so assina este runtime e adota o elemento do terminal
// selecionado; os demais ficam estacionados num contenedor fora da tela, onde
// o xterm pausa a renderizacao sozinho mas continua consumindo a saida.
//
// A sessao pertence ao gerenciador de processos no Rust. Selecionar outro
// card muda apenas o que esta sendo exibido: o shell, o historico, a posicao
// de rolagem e o comando digitado ficam na instancia do xterm de cada sessao.
//
// Eventos, sempre tipados para cada componente redesenhar so o que lhe cabe:
// - `sessions`: lista, ordem, selecao, nome, subtitulo, cor, fixacao e
//   estados que mudam a lista, como desconectada.
// - `activity` com `id`: metricas, primeiro plano, saida recente e atencao de
//   uma sessao. So o card e o cabecalho dessa sessao redesenham.
// - `editor` e `explorer` com `id`: abas e arvore de uma sessao.
// - `error`, `notify` e `theme`: mensagens e tema.
// A saida do terminal nunca redesenha a lista inteira: com o shell em prompt
// ela nao emite nada, e com um processo rodando emite no maximo duas vezes
// por segundo para a etiqueta "Recebendo saida" acompanhar.
//
// Estados observaveis, sem adivinhacao:
// - starting: o shell ainda esta abrindo.
// - running: shell vivo. O primeiro plano vem do tty, pelo Rust: quando o
//   grupo em primeiro plano e o proprio shell, a sessao esta pronta para
//   comando; senao ha um processo em execucao, com nome e agente lidos da
//   linha de comando.
// - exited: o shell terminou, com codigo ou sinal.
// - error: nao foi possivel abrir, como pasta inexistente.
// - disconnected: o app reabriu e o backend nao preservou o processo. O
//   historico gravado em disco volta ao xterm, e Reabrir retoma o agente.
//
// Sinais de atencao, todos vindos do proprio terminal ou do kernel: sino,
// notificacao por OSC 9 ou OSC 777, fim de um job que durou mais que alguns
// segundos e fim do shell. Ficam no card ate a sessao ser consultada.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { isTauri, hasBridge, NATIVE_ONLY_MESSAGE, invoke, listen, createChannel, chooseDirectory } from '../lib/native.js';
import { openExternal } from '../lib/downloads.js';
import { buildTheme, terminalFont, watchTheme } from './theme.js';
import { baseName, fs, isInside, shellQuote } from './files.js';
import { getLayout, subscribeLayout } from './layout.js';
import { platform } from '../lib/platform.js';
import { translate } from '../shared/i18n.js';

export { NATIVE_ONLY_MESSAGE };
import * as remote from '../lib/remote.js';
import { isPhone, onShellLock } from '../lib/shell.js';
import { consumeOutput, beginReplay } from './replay.js';
import { restoredNotice, savedSize, waitForPrompt } from './restore.js';
import { TerminalViewport } from './viewport.js';
import { createTouchScroll } from './touch-scroll.js';

// Cores que um card pode receber. `null` deixa o card transparente. Cada uma tem um
// tom para o claro e outro para o escuro, como os tokens da camada macOS.
import { ORGANIZATION_COLORS as SESSION_COLORS } from '../lib/organization-colors.js';
export { SESSION_COLORS };

const STORAGE_KEY = isPhone() ? 'cialai_terminals_phone' : 'cialai_terminals';
const LEGACY_STORAGE_KEY = isPhone() ? 'oc_terminals_phone' : 'oc_terminals';
const RECENT_LIMIT = 10;
// Confirmacao de bytes consumidos: em blocos de 32 KB, ou depois de 100 ms
// para lotes pequenos nao ficarem presos.
const ACK_THRESHOLD = 32 * 1024;
const ACK_DELAY_MS = 100;
const FIT_DEBOUNCE_MS = 50;
// Metricas: a cada 2 s com a secao visivel, a cada 6 s em segundo plano.
// O uso do plano e lido junto das metricas enquanto ha um agente rodando,
// para o numero acompanhar a sessao. O Rust guarda a resposta por dois
// segundos e revarre as pastas do Codex a cada quinze, entao a leitura
// frequente custa pouco.
const USAGE_MS = 5000;
const METRICS_VISIBLE_MS = 2000;
const METRICS_HIDDEN_MS = 6000;
// Saida recente conta como "recebendo saida" por este tempo.
const STREAMING_WINDOW_MS = 1500;
// Um job que durou menos que isto nao vira "concluido" no card.
const FINISHED_MIN_MS = 4000;
// Teto de redesenhos do card por saida do terminal.
const ACTIVITY_THROTTLE_MS = 500;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 32;

const state = {
  sessions: new Map(),
  order: [],
  selectedId: null,
  hydrated: false,
  connectionEpoch: 0,
  hydrating: null,
  listeners: new Set(),
  themeWatcher: null,
  layoutWatcher: null,
  exitListener: null,
  changeListener: null,
  focusWatcher: false,
  parking: null,
  metricsTimer: null,
  aiUsage: new Map(),
  usageAt: 0,
  metricsBusy: false,
  viewMounted: false,
  viewVisible: false,
  windowFocused: typeof document !== 'undefined' ? document.hasFocus() : true,
  pendingNewTerminal: false,
  newTerminalHandler: null,
  newFileHandler: null,
  pendingNewFile: false,
  closeHandler: null,
  hostElement: null,
  hostedId: null,
  demo: false,
  // Observadores de arquivos por caminho, com contagem de sessoes.
  watches: new Map(),
  changeListeners: new Set(),
  // Eventos coalescidos por chave ate o proximo giro.
  queue: new Map(),
  flushTimer: null,
};

/* ── assinatura ───────────────────────────────────────────────────── */

export function subscribe(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

function dispatch(event) {
  state.listeners.forEach((listener) => {
    try { listener(event); } catch (error) { console.error('[terminais]', error); }
  });
}

// Coalesce eventos iguais no mesmo giro: dez lotes de saida da mesma sessao
// viram um unico `activity`.
function emitSoon(event) {
  const key = `${event.type}:${event.id || ''}`;
  state.queue.set(key, event);
  if (state.flushTimer) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    const pending = [...state.queue.values()];
    state.queue.clear();
    pending.forEach(dispatch);
  }, 0);
}

function emitSessions() { emitSoon({ type: 'sessions' }); }
function emitEditor(session) { emitSoon({ type: 'editor', id: session.id }); }
function emitExplorer(session) { emitSoon({ type: 'explorer', id: session.id }); }
function emitActivity(session) { emitSoon({ type: 'activity', id: session.id }); }
export function emitBrowserEvent(id) { emitSoon({ type: 'browser', id }); }

// Um aviso curto para a interface, sem ser erro.
export function announce(message) {
  dispatch({ type: 'notify', message });
}

// O Dev Browser vive em browser/runtime.js e se registra aqui, para o fim
// da sessao, a troca de pasta e a visibilidade chegarem ate ele sem
// importacao circular.
const browserHooks = { sessionClosed: null, directoryChanged: null, visibility: null };
export function registerBrowserHooks(hooks) {
  Object.assign(browserHooks, hooks);
}

export function isDemo() {
  return state.demo;
}

/* ── persistencia ─────────────────────────────────────────────────── */

function readStore() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (raw != null) localStorage.setItem(STORAGE_KEY, raw);
    }
    const parsed = JSON.parse(raw || 'null');
    if (parsed && parsed.version === 2) {
      return {
        version: 2,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        selectedId: typeof parsed.selectedId === 'string' ? parsed.selectedId : null,
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      };
    }
    // Formato da grade antiga: so as pastas. Viram sessoes sem nome proprio.
    if (parsed && parsed.version === 1) {
      const panels = Array.isArray(parsed.panels) ? parsed.panels : [];
      return {
        version: 2,
        sessions: panels.filter((panel) => panel && typeof panel.cwd === 'string').map((panel) => ({ cwd: panel.cwd })),
        selectedId: null,
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      };
    }
  } catch (_error) { /* sem storage */ }
  return { version: 2, sessions: [], selectedId: null, recent: [] };
}

function writeStore(store) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(store)); } catch (_error) { /* sem storage */ }
}

function serializeSession(session) {
  return {
    id: session.id,
    cwd: session.cwd,
    name: session.name,
    customName: session.customName,
    subtitle: session.subtitle,
    color: session.color,
    pinned: session.pinned,
    createdAt: session.createdAt,
    editor: {
      tabs: session.editor.tabs.filter((tab) => tab.kind !== 'diff' && tab.path).map((tab) => tab.path),
      activeId: session.editor.activeId,
      ratio: session.editor.ratio,
    },
    explorer: {
      root: session.explorer.root,
      expanded: [...session.explorer.expanded],
      followCwd: session.explorer.followCwd,
    },
    // A aba do browser nao tem caminho: lembra-se que estava aberta e a
    // ultima URL, e ela volta em estado parado, sem lancar nada sozinha.
    browser: {
      open: session.editor.tabs.some((tab) => tab.kind === 'browser') || Boolean(session.browser?.restoreOpen),
      url: session.browser?.url || '',
    },
  };
}

let persistTimer = null;
export function persist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const store = readStore();
    store.sessions = state.order.map((id) => state.sessions.get(id)).filter(Boolean).map(serializeSession);
    store.selectedId = state.selectedId;
    writeStore(store);
    if (isTauri() && !state.demo) state.order.forEach((id, order) => {
      const session = state.sessions.get(id);
      if (session?.ptyId == null) return;
      const presentation = { name: session.name, subtitle: session.subtitle, color: session.color, pinned: session.pinned, order };
      const identity = terminalIdentity(session);
      const signature = JSON.stringify([identity, presentation]);
      if (session.publishedPresentation === signature) return;
      const request = {};
      session.presentationRequest = request;
      invoke('pty_presentation', { id: session.ptyId, presentation }).then(() => {
        if (session.presentationRequest === request && terminalIdentity(session) === identity) session.publishedPresentation = signature;
      }).catch(() => {});
    });
  }, 120);
}

function rememberRecent(cwd) {
  const store = readStore();
  store.recent = [cwd, ...store.recent.filter((entry) => entry !== cwd)].slice(0, RECENT_LIMIT);
  writeStore(store);
}

export function getRecent() {
  return readStore().recent;
}

/* ── sessoes ──────────────────────────────────────────────────────── */

function newId() {
  const random = Math.random().toString(36).slice(2, 8);
  return `s_${Date.now().toString(36)}${random}`;
}

function messageOf(error) {
  if (!error) return translate('terminal.common.unknownError');
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

// Contenedor fora da tela onde os terminais nao exibidos ficam abertos. O
// xterm pausa a renderizacao de um elemento que nao intersecta a janela, mas
// continua consumindo a saida, entao trocar de sessao nao perde nada.
function parking() {
  if (state.parking && state.parking.isConnected) return state.parking;
  const element = document.createElement('div');
  element.className = 'terminais-parking';
  element.setAttribute('aria-hidden', 'true');
  document.body.appendChild(element);
  state.parking = element;
  return element;
}

/* ── roda do mouse ────────────────────────────────────────────────── */

// O xterm rola um punhado de linhas por entalhe e nunca ganha velocidade:
// percorrer a saida de um agente com a roda fica lento. Aqui a rolagem
// continua acelera ate seis vezes o passo e a pausa devolve o passo normal.
// Nada e interceptado: so o fator do proprio xterm muda, entao a tela
// alternativa do vim e os programas que leem o mouse seguem recebendo a roda.
const WHEEL_BASE = 2;
const WHEEL_MAX = 8;
const WHEEL_RAMP = 1.28;
const WHEEL_GAP_MS = 180;

function installWheelScroll(session) {
  const element = session.term.element;
  if (!element) return;
  let speed = WHEEL_BASE;
  let last = 0;
  element.addEventListener('wheel', (event) => {
    if (!event.deltaY) return;
    const now = Date.now();
    speed = now - last < WHEEL_GAP_MS ? Math.min(WHEEL_MAX, speed * WHEEL_RAMP) : WHEEL_BASE;
    last = now;
    if (session.term.options.scrollSensitivity !== speed) session.term.options.scrollSensitivity = speed;
  }, { capture: true, passive: true });
}

// O xterm 6 nao trata toque: sem isto o celular nao sobe para ler o que
// passou. O arrasto vira scrollLines no buffer normal e setas no alternativo;
// a conta fica em touch-scroll.js. O preventDefault segura a rolagem do
// contenedor e o efeito elastico do WebKit enquanto o dedo esta no terminal.
function installTouchScroll(session) {
  const { term } = session;
  const element = term.element;
  if (!element) return;
  const scroll = createTouchScroll({
    rowHeight: () => {
      const screen = element.querySelector('.xterm-screen');
      const height = screen ? screen.getBoundingClientRect().height / Math.max(1, term.rows) : 0;
      return height > 0 ? height : term.options.fontSize * (term.options.lineHeight || 1);
    },
    scrollLines: (rows) => term.scrollLines(rows),
    sendKeys: (data) => { if (session.status === 'running' && session.ptyId != null) writeTerminal(session, data); },
    hasScrollback: () => term.buffer.active.type === 'normal',
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  });
  const single = (event) => (event.touches.length === 1 ? event.touches[0] : null);
  element.addEventListener('touchstart', (event) => {
    const touch = single(event);
    if (touch) scroll.start(touch.clientY, performance.now());
    else scroll.cancel();
  }, { passive: true });
  element.addEventListener('touchmove', (event) => {
    const touch = single(event);
    if (!touch) return;
    scroll.move(touch.clientY, performance.now());
    if (event.cancelable) event.preventDefault();
  }, { passive: false });
  element.addEventListener('touchend', (event) => { if (!event.touches.length) scroll.end(performance.now()); }, { passive: true });
  element.addEventListener('touchcancel', () => scroll.cancel(), { passive: true });
  session.disposables.push({ dispose: () => scroll.cancel() });
}

function createTerminal() {
  const layout = getLayout();
  const term = new Terminal({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    fontFamily: terminalFont(),
    fontSize: isPhone() ? 12 : layout.fontSize,
    lineHeight: 1.15,
    fontWeight: '400',
    fontWeightBold: '600',
    scrollback: 8000,
    scrollSensitivity: WHEEL_BASE,
    cursorBlink: true,
    macOptionIsMeta: false,
    allowProposedApi: true,
    theme: buildTheme(),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  // window.open nao abre o navegador dentro do WKWebView; o opener abre.
  term.loadAddon(new WebLinksAddon((_event, uri) => { openExternal(uri).catch(() => {}); }));
  return { term, fit, search };
}

function validColor(color) {
  return SESSION_COLORS.some((entry) => entry.id === color) ? color : null;
}

function createSession({ id, cwd, name, customName = false, subtitle = '', color = null, pinned = false, createdAt, editor, explorer, browser, shellFlavor } = {}) {
  const { term, fit, search } = createTerminal();
  const session = {
    id: id || newId(),
    cwd,
    name: name || baseName(cwd) || translate('terminal.session.defaultName'),
    customName: Boolean(customName),
    subtitle: typeof subtitle === 'string' ? subtitle : '',
    color: validColor(color),
    pinned: Boolean(pinned),
    createdAt: createdAt || Date.now(),
    term,
    fit,
    search,
    webgl: null,
    host: null,
    ptyId: null,
    pid: null,
    shellFlavor: shellFlavor || platform().defaultShellFlavor,
    identityEpoch: 0,
    status: 'starting',
    exitCode: null,
    signal: null,
    early: false,
    error: null,
    spawning: false,
    reattachId: null,
    spawnToken: null,
    pendingAck: 0,
    outputOffset: 0,
    receivedOffset: 0,
    channelId: null,
    ackTimer: null,
    fitTimer: null,
    lastOutputAt: 0,
    activityTimer: null,
    idleTimer: null,
    activity: null,
    metricsAt: 0,
    jobStartedAt: null,
    jobLabel: null,
    attention: null,
    // Estado guardado pelo Rust depois que o app fechou: tamanho, historico e
    // o comando que retoma o agente. `replaying` cala sino e notificacoes do
    // historico enquanto ele volta para o xterm.
    saved: null,
    restoring: null,
    replaying: false,
    reopening: false,
    disposables: [],
    editor: {
      tabs: [],
      activeId: editor?.activeId || null,
      ratio: Number.isFinite(editor?.ratio) ? editor.ratio : null,
      maximized: null,
      restoreTabs: Array.isArray(editor?.tabs) ? editor.tabs.filter((path) => typeof path === 'string') : [],
    },
    explorer: {
      root: explorer?.root && typeof explorer.root === 'string' ? explorer.root : cwd,
      expanded: new Set(Array.isArray(explorer?.expanded) ? explorer.expanded : [cwd]),
      followCwd: Boolean(explorer?.followCwd),
      nodes: new Map(),
      git: null,
      gitAt: 0,
      selected: null,
      revision: 0,
    },
    // Dev Browser da sessao: idle, starting, ready, stopped ou error. O
    // controlador vive em browser/runtime.js; aqui fica o que a interface le.
    browser: {
      status: 'idle',
      restoreOpen: Boolean(browser?.open),
      autoStart: false,
      url: typeof browser?.url === 'string' ? browser.url : '',
      title: '',
      info: null,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
      canvas: null,
      canvasHandlers: null,
      epoch: 0,
      // Andamento da instalacao automatica do Chromium; `null` fora dela.
      install: null,
    },
  };

  session.disposables.push(term.onData((data) => {
    if (session.ptyId == null || session.status !== 'running') return;
    if (session.attention) clearAttention(session);
    writeTerminal(session, data);
  }));
  session.disposables.push(term.onBinary((data) => {
    if (session.ptyId == null || session.status !== 'running') return;
    writeTerminal(session, data, true);
  }));
  session.disposables.push(term.onResize(({ cols, rows }) => {
    if (session.applyingView) return;
    if (session.ptyId == null || session.status !== 'running') return;
    if (isTauri()) invoke('pty_resize', { id: session.ptyId, cols, rows }).catch(() => {});
    else session.viewport?.resize({ cols, rows }).catch(() => {});
  }));
  // Sino e notificacoes: o unico jeito honesto de saber que um programa no
  // terminal pediu atencao. Claude Code, WezTerm e iTerm usam estes canais.
  session.disposables.push(term.onBell(() => { if (!session.replaying) signalAttention(session, 'bell', translate('terminal.session.needsAttention')); }));
  const oscNotify = (data) => {
    if (session.replaying) return true;
    const text = String(data || '').split(';').filter(Boolean).slice(-1)[0] || '';
    signalAttention(session, 'notify', text.trim() || translate('terminal.session.notification'));
    return true;
  };
  session.disposables.push(term.parser.registerOscHandler(9, oscNotify));
  session.disposables.push(term.parser.registerOscHandler(777, oscNotify));

  term.open(parking());
  term.element?.addEventListener('pointerdown', () => {
    requestTerminalControl(session.id).catch((error) => dispatch({ type: 'error', message: messageOf(error) }));
  });
  installWheelScroll(session);
  installTouchScroll(session);
  state.sessions.set(session.id, session);
  return session;
}

function flushAck(session) {
  if (session.ackTimer) { clearTimeout(session.ackTimer); session.ackTimer = null; }
  if (session.pendingAck <= 0 || session.ptyId == null) return;
  const bytes = session.pendingAck;
  session.pendingAck = 0;
  invoke('pty_ack', { id: session.ptyId, bytes, ...(!isTauri() ? { channel: session.channelId } : {}) }).catch(() => {});
}

function scheduleAck(session) {
  if (session.ackTimer) return;
  session.ackTimer = setTimeout(() => { session.ackTimer = null; flushAck(session); }, ACK_DELAY_MS);
}

// Saida chegou. Com o shell em prompt nada redesenha: o eco do que se digita
// nao muda o card. Com um processo rodando, o card acompanha a etiqueta
// "Recebendo saida" com no maximo dois redesenhos por segundo e um ultimo
// quando a saida para.
function touchOutput(session) {
  session.lastOutputAt = Date.now();
  if (!session.activity?.foreground) return;
  if (!session.activityTimer) {
    emitActivity(session);
    session.activityTimer = setTimeout(() => { session.activityTimer = null; }, ACTIVITY_THROTTLE_MS);
  }
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => { session.idleTimer = null; emitActivity(session); }, STREAMING_WINDOW_MS + 100);
}

function handleMessage(session, token, message) {
  if (session.spawnToken !== token) return;
  const isBinary = message instanceof ArrayBuffer || message instanceof Uint8Array || Array.isArray(message);
  if (isBinary) {
    let bytes;
    if (message instanceof Uint8Array) bytes = message;
    else if (message instanceof ArrayBuffer) bytes = new Uint8Array(message);
    else bytes = Uint8Array.from(message);
    const output = consumeOutput(session, bytes);
    session.term.write(output, () => {
      if (session.spawnToken !== token) return;
      session.pendingAck += bytes.byteLength;
      if (session.pendingAck >= ACK_THRESHOLD) flushAck(session);
      else scheduleAck(session);
    });
    touchOutput(session);
    return;
  }
  if (message?.type === 'replay') {
    beginReplay(session, message);
    return;
  }
  if (message?.type === 'detached') {
    session.spawnToken = null;
    session.pendingAck = 0;
    setStatus(session, 'disconnected');
    if (remote.state().status === 'connected') setTimeout(() => reattachSession(session, session.ptyId), 500);
    return;
  }
  if (message && message.type === 'exit') {
    markExited(session, message);
  }
}

// Mudanca de estado do shell: o card, o cabecalho e a lista redesenham.
function setStatus(session, status) {
  session.status = status;
  if (isPhone() && ['exited', 'error'].includes(status)) fitNow(session);
  emitActivity(session);
  emitSessions();
}

function markExited(session, { code, signal, early }) {
  if (session.status !== 'running' && session.status !== 'starting' && session.status !== 'disconnected') return;
  if (session.ackTimer) { clearTimeout(session.ackTimer); session.ackTimer = null; }
  session.pendingAck = 0;
  session.exitCode = Number.isFinite(code) ? code : -1;
  session.signal = signal || null;
  session.early = Boolean(early);
  invalidateTerminalIdentity(session);
  session.ptyId = null;
  session.pid = null;
  session.spawnToken = null;
  session.spawning = false;
  session.activity = null;
  session.jobStartedAt = null;
  const failed = session.exitCode !== 0;
  session.attention = {
    kind: failed ? 'error' : 'exited',
    message: failed
      ? translate('terminal.session.endedCode', { code: session.exitCode })
      : translate('terminal.session.processFinished'),
    at: Date.now(),
  };
  setStatus(session, 'exited');
}

function spawnSize(session) {
  const cols = session.term.cols || DEFAULT_COLS;
  const rows = session.term.rows || DEFAULT_ROWS;
  return { cols, rows };
}

// Onde o cursor do xterm esta quando o shell abre, contado a partir de 1. O
// ConPTY do Windows pergunta isso ao nascer e o Rust responde por quem abriu a
// sessao, mesmo com o historico de um reinicio acima do cursor.
function spawnCursor(term) {
  const buffer = term?.buffer?.active;
  const row = Number.isInteger(buffer?.cursorY) ? buffer.cursorY + 1 : 1;
  const col = Number.isInteger(buffer?.cursorX) ? buffer.cursorX + 1 : 1;
  return { cursorRow: row, cursorCol: col };
}

async function spawnSession(session) {
  if (session.spawning) return;
  invalidateTerminalIdentity(session);
  session.ptyId = null;
  session.pid = null;
  session.spawning = true;
  session.error = null;
  session.exitCode = null;
  session.signal = null;
  session.early = false;
  const token = {};
  session.outputOffset = 0; session.receivedOffset = 0;
  session.spawnToken = token;
  setStatus(session, 'starting');
  try {
    const channel = await createChannel((message) => handleMessage(session, token, message));
    if (session.spawnToken !== token) { channel?.dispose?.(); return; }
    if (!channel) throw new Error(translate('terminal.common.desktopOnly'));
    session.outputChannel?.dispose?.();
    session.outputChannel = channel;
    session.channelId = channel.id;
    const { cols, rows } = spawnSize(session);
    const info = await invoke('pty_spawn', { cwd: session.cwd, cols, rows, ...spawnCursor(session.term), tag: session.id, onOutput: channel });
    if (session.spawnToken !== token) return;
    applyTerminalInfo(session, info);
    setStatus(session, 'running');
    fitNow(session);
    if (isPhone() && session.host) requestTerminalControl(session.id).catch(() => {});
    rememberRecent(session.cwd);
    persist();
    ensureMetrics();
  } catch (error) {
    if (session.spawnToken !== token) return;
    session.outputChannel?.dispose?.();
    session.error = messageOf(error);
    setStatus(session, 'error');
    dispatch({ type: 'error', message: session.error });
  } finally {
    if (session.spawnToken === token) session.spawning = false;
  }
}

// Depois de uma recarga do webview em desenvolvimento, o PTY continua vivo no
// Rust e so precisa de um canal novo.
async function reattachSession(session, ptyId) {
  if (session.spawning || ptyId == null || !state.sessions.has(session.id)) return;
  session.pendingAck = 0;
  if (session.ackTimer) clearTimeout(session.ackTimer);
  session.ackTimer = null;
  session.reattachId = null;
  session.spawning = true;
  const token = {};
  session.spawnToken = token;
  try {
    const channel = await createChannel((message) => handleMessage(session, token, message));
    if (session.spawnToken !== token) { channel?.dispose?.(); return; }
    session.outputChannel?.dispose?.();
    session.outputChannel = channel;
    session.channelId = channel?.id;
    session.ptyId = ptyId;
    const info = await invoke('pty_attach', { id: ptyId, onOutput: channel });
    if (session.spawnToken !== token) return;
    applyTerminalInfo(session, info);
    setStatus(session, 'running');
    fitNow(session);
    if (isPhone() && session.host) requestTerminalControl(session.id).catch(() => {});
    ensureMetrics();
  } catch (error) {
    if (session.spawnToken !== token) return;
    session.error = messageOf(error);
    setStatus(session, 'error');
  } finally {
    if (session.spawnToken === token) session.spawning = false;
  }
}

/* ── sessoes que voltam ───────────────────────────────────────────── */

// Historico e estado de uma sessao que o app perdeu ao fechar. O Rust grava a
// saida de cada PTY e a conversa do agente em uso; aqui o historico volta ao
// xterm no tamanho em que foi escrito, com um aviso no fim, e o plano de
// retomada fica na sessao para o proximo Reabrir. A promessa e compartilhada:
// o Reabrir espera a restauracao que ja estava em curso.
function restoreSaved(session) {
  if (!isTauri() || state.demo) return Promise.resolve(null);
  if (!session.restoring) {
    session.restoring = (async () => {
      try {
        const saved = await invoke('pty_saved', { tag: session.id });
        if (!saved || !state.sessions.has(session.id)) return null;
        session.saved = saved;
        if (saved.historyBytes > 0 && session.status === 'disconnected') {
          const body = await invoke('pty_saved_history', { tag: session.id });
          const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : Uint8Array.from(body || []);
          if (bytes.byteLength && session.status === 'disconnected') await replayHistory(session, bytes, saved);
        }
        emitActivity(session);
        return saved;
      } catch (error) {
        console.error('[terminais] histórico da sessão', error);
        return null;
      }
    })();
  }
  return session.restoring;
}

function replayHistory(session, bytes, saved) {
  const { term } = session;
  const current = { cols: term.cols, rows: term.rows };
  const size = savedSize(saved);
  session.replaying = true;
  if (size) resizeRenderer(session, size);
  return new Promise((resolve) => {
    term.write(bytes);
    term.write(restoredNotice(saved.updatedAtMs), () => {
      session.replaying = false;
      if (size) resizeRenderer(session, current);
      fitNow(session);
      resolve();
    });
  });
}

// Depois da hidratacao, uma sessao por vez, para a abertura nao esperar o
// historico de todas. No fim, o disco perde o que sobrou de sessoes que nao
// existem mais.
async function restoreDisconnected() {
  for (const id of [...state.order]) {
    const session = state.sessions.get(id);
    if (session?.status === 'disconnected') await restoreSaved(session);
  }
  invoke('pty_prune', { keep: [...state.order] }).catch(() => {});
}

// Espera o prompt do shell novo e digita o comando que devolve a conversa.
// Escreve direto no PTY, sem a concessao de largura, porque a sessao pode
// estar fora da tela quando todas reabrem juntas. Se um programa ja tomou o
// terminal, como algo aberto pelo .zshrc, nada e digitado.
async function resumeAgent(session, plan) {
  const ptyId = session.ptyId;
  const same = () => session.ptyId === ptyId && session.status === 'running';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const ready = await waitForPrompt(() => (same() ? session.receivedOffset : null), sleep);
  if (!ready || !same()) return;
  try {
    const metrics = await invoke('pty_metrics');
    if (Array.isArray(metrics) && metrics.find((item) => item.tag === session.id)?.foreground) return;
  } catch (_error) { /* sem metricas, segue com o prompt observado */ }
  if (!same()) return;
  try {
    await invoke('pty_write', { id: ptyId, data: `${plan.command}\r` });
    dispatch({ type: 'notify', sessionId: session.id, message: translate('terminal.session.resuming', { agent: plan.agent, name: session.name }) });
  } catch (error) {
    dispatch({ type: 'error', message: messageOf(error) });
  }
}

function loadWebgl(session) {
  if (session.webgl) return;
  try {
    const addon = new WebglAddon();
    addon.onContextLoss(() => {
      addon.dispose();
      session.webgl = null;
    });
    session.term.loadAddon(addon);
    session.webgl = addon;
  } catch (_error) {
    // Sem WebGL o xterm segue no renderizador DOM.
    session.webgl = null;
  }
}

function unloadWebgl(session) {
  if (!session.webgl) return;
  try { session.webgl.dispose(); } catch (_error) { /* contexto ja perdido */ }
  session.webgl = null;
}

function fitNow(session) {
  const phoneHistory = isPhone() && ['exited', 'error'].includes(session.status);
  if (!isTauri() && !state.demo && !session.viewport?.owned && !phoneHistory) return;
  const element = session.term.element;
  if (!element || !element.isConnected) return;
  const host = element.parentElement;
  if (!host || host === state.parking) return;
  const rect = host.getBoundingClientRect();
  if (rect.width < 40 || rect.height < 24) return;
  if (isTauri() && session.viewport?.latest?.owner === 'remote') {
    const size = measureTerminal(session);
    if (size && session.ptyId != null) invoke('pty_resize', { id: session.ptyId, ...size }).catch(() => {});
    return;
  }
  try { session.fit.fit(); } catch (_error) { /* painel sem tamanho ainda */ }
  // Garantia contra a ultima linha cortada: se a tela do xterm ficou mais
  // alta que o espaco do painel, por arredondamento do renderizador ou por
  // troca de tela, tira uma linha. Nenhuma linha fica escondida atras da
  // borda.
  try {
    const screen = element.querySelector('.xterm-screen');
    if (!screen) return;
    const style = getComputedStyle(host);
    const bottom = rect.bottom - (parseFloat(style.paddingBottom) || 0);
    const overflow = screen.getBoundingClientRect().bottom - bottom;
    if (overflow > 1 && session.term.rows > 2) session.term.resize(session.term.cols, session.term.rows - 1);
  } catch (_error) { /* medida indisponivel */ }
}

export function supportsPhoneTerminal() {
  return state.demo || isTauri() || remote.state().features?.includes('terminal-mobile-v1') === true;
}

function measureTerminal(session) {
  if (!session.host || session.host.getBoundingClientRect().width < 40) return null;
  try {
    const size = session.fit.proposeDimensions();
    if (size && Number.isFinite(size.cols) && Number.isFinite(size.rows)) {
      return { cols: Math.max(2, Math.min(500, size.cols)), rows: Math.max(1, Math.min(300, size.rows)) };
    }
  } catch (_) { /* Await a visible renderer. */ }
  return null;
}

function resizeRenderer(session, view) {
  session.applyingView = true;
  try { session.term.resize(view.cols, view.rows); } finally { session.applyingView = false; }
}

function viewportFor(session) {
  if (session.ptyId == null) return null;
  if (session.viewport?.id === session.ptyId) return session.viewport;
  session.viewport?.invalidate();
  session.viewport = new TerminalViewport({
    id: session.ptyId, invoke,
    apply: (view) => resizeRenderer(session, view),
    changed: () => emitSoon({ type: 'viewport', id: session.id }),
  });
  return session.viewport;
}

function terminalIdentity(session) {
  return `${session.identityEpoch}:${session.ptyId}:${session.pid}`;
}

function invalidateTerminalIdentity(session) {
  session.viewport?.invalidate();
  session.viewport = null;
  session.identityEpoch += 1;
  session.publishedPresentation = null;
  session.presentationRequest = null;
}

function applyTerminalInfo(session, info) {
  const pid = info.pid ?? null;
  if (session.ptyId !== info.id || session.pid !== pid) invalidateTerminalIdentity(session);
  session.ptyId = info.id;
  session.pid = pid;
  session.shellFlavor = info.shellFlavor || session.shellFlavor || platform().defaultShellFlavor;
  if (info.view) viewportFor(session)?.receive(info.view);
  else if (info.cols && info.rows && !session.viewport?.owned) resizeRenderer(session, info);
}

export async function requestTerminalControl(id) {
  const session = state.sessions.get(id);
  if (!session?.host || session.status !== 'running' || document.visibilityState === 'hidden') return;
  if (state.demo) { fitNow(session); return; }
  if (!supportsPhoneTerminal()) return;
  const size = measureTerminal(session);
  if (!size) return;
  await viewportFor(session)?.claim(size);
}

function writeTerminal(session, data, binary = false) {
  const identity = terminalIdentity(session);
  (async () => {
    // Na demonstracao nao ha PTY nem concessao de largura: a escrita segue
    // direto, para as verificacoes fora do app observarem o que seria
    // enviado.
    if (supportsPhoneTerminal() && !state.demo) {
      await requestTerminalControl(session.id);
      if (terminalIdentity(session) !== identity || !session.host || !session.viewport?.owned) return;
    }
    await invoke('pty_write', { id: session.ptyId, data, ...(binary ? { binary: true } : {}) });
  })().catch((error) => dispatch({ type: 'error', message: messageOf(error) }));
}

// Trocar de tela muda a razao de pixels e o tamanho da celula; o terminal
// exibido precisa caber de novo.
function watchPixelRatio() {
  if (typeof window === 'undefined') return;
  const query = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  const onChange = () => {
    query.removeEventListener('change', onChange);
    if (state.hostedId) fitAndResize(state.hostedId);
    watchPixelRatio();
  };
  query.addEventListener('change', onChange);
}

/* ── atencao e atividade ──────────────────────────────────────────── */

function isViewed(session) {
  return state.viewMounted && state.viewVisible && state.windowFocused && state.selectedId === session.id;
}

function signalAttention(session, kind, message) {
  if (kind === 'bell' || kind === 'notify') {
    // Com a sessao na frente e a janela ativa, o usuario ja esta vendo.
    if (isViewed(session)) {
      dispatch({ type: 'notify', sessionId: session.id, message });
      return;
    }
  }
  session.attention = { kind, message, at: Date.now() };
  emitActivity(session);
  emitSessions();
}

export function clearAttention(session) {
  const target = typeof session === 'string' ? state.sessions.get(session) : session;
  if (!target || !target.attention) return;
  target.attention = null;
  emitActivity(target);
  emitSessions();
}

export function isStreaming(session) {
  return session.status === 'running' && Date.now() - session.lastOutputAt < STREAMING_WINDOW_MS;
}

// Ha um processo em primeiro plano alem do shell.
export function isWorking(session) {
  const foreground = session.activity?.foreground;
  return session.status === 'running' && Boolean(foreground) && !foreground.stopped;
}

// Estado em linguagem simples, derivado so do que foi observado.
export function describe(session) {
  if (session.status === 'starting') return { code: 'starting', label: translate('terminal.session.openingShell'), tone: 'busy' };
  if (session.status === 'error') return { code: 'error', label: translate('terminal.session.openFailed'), tone: 'bad' };
  if (session.status === 'disconnected') return { code: 'disconnected', label: translate('terminal.session.disconnected'), tone: 'muted' };
  if (session.status === 'exited') {
    if (session.exitCode === 0) return { code: 'exited', label: translate('terminal.session.processFinished'), tone: 'muted' };
    return {
      code: 'failed',
      label: session.signal
        ? translate('terminal.session.endedSignal', { signal: session.signal })
        : translate('terminal.session.endedCode', { code: session.exitCode }),
      tone: 'bad',
    };
  }
  const foreground = session.activity?.foreground || null;
  if (foreground) {
    if (foreground.stopped) return { code: 'stopped', label: translate('terminal.session.processStopped'), tone: 'warn' };
    if (isStreaming(session)) return { code: 'streaming', label: translate('terminal.session.receivingOutput'), tone: 'busy' };
    return { code: 'busy', label: translate('terminal.session.processRunning'), tone: 'busy' };
  }
  if (session.activity === null) return { code: 'running', label: translate('terminal.session.shellOpen'), tone: 'ok' };
  return { code: 'idle', label: translate('terminal.session.ready'), tone: 'ok' };
}

// Nome do que esta rodando: o agente, quando reconhecido pela linha de
// comando, senao o programa em primeiro plano.
export function runningLabel(session) {
  const activity = session.activity;
  if (!activity || session.status !== 'running') return null;
  if (activity.foreground) {
    if (activity.foreground.agent) return { text: activity.foreground.agent, agent: true };
    return { text: activity.foreground.command || activity.foreground.name, agent: false };
  }
  if (activity.agent) return { text: activity.agent, agent: true, background: true };
  return null;
}

// Tons da sessao para o claro e o escuro, ou null quando nao tem cor.
export function sessionAccent(session) {
  const entry = session.color ? SESSION_COLORS.find((color) => color.id === session.color) : null;
  return entry ? { light: entry.light, dark: entry.dark } : null;
}

function sameForeground(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.pid === b.pid && a.agent === b.agent && a.stopped === b.stopped && a.command === b.command
    && a.profile === b.profile && a.cwd === b.cwd;
}

function applyMetrics(list) {
  const now = Date.now();
  const byTag = new Map(list.map((item) => [item.tag, item]));
  state.sessions.forEach((session) => {
    if (session.status !== 'running' || session.ptyId == null) return;
    const metrics = byTag.get(session.id) || list.find((item) => item.id === session.ptyId);
    if (!metrics) return;
    const before = session.activity;
    const foreground = metrics.foreground || null;
    const agent = metrics.agent || null;
    // O perfil vem do processo do agente: o do primeiro plano quando e ele o
    // agente, senao o do agente encontrado na arvore.
    const fromForeground = Boolean(foreground?.agent);
    const profile = (fromForeground ? foreground.profile : metrics.agentProfile) || null;
    const profileName = (fromForeground ? foreground.profileName : metrics.agentProfileName) || null;
    const configDir = (fromForeground ? foreground.configDir : metrics.agentConfigDir) || null;
    const next = {
      available: Boolean(metrics.available),
      cpu: metrics.cpuPercent ?? null,
      memory: metrics.memoryBytes ?? null,
      processes: metrics.processes || 0,
      foreground,
      agent,
      profile,
      profileName,
      configDir,
      shellCwd: metrics.shellCwd || null,
      usage: usageFor(agent, profile),
    };
    session.activity = next;
    session.metricsAt = now;
    const hadJob = Boolean(before?.foreground);
    const hasJob = Boolean(foreground);
    if (!hadJob && hasJob) {
      session.jobStartedAt = now;
      session.jobLabel = foreground.agent || foreground.command || foreground.name;
    } else if (hadJob && !hasJob) {
      const lasted = session.jobStartedAt ? now - session.jobStartedAt : 0;
      const label = session.jobLabel;
      session.jobStartedAt = null;
      session.jobLabel = null;
      if (lasted >= FINISHED_MIN_MS && !isViewed(session)) {
        signalAttention(session, 'finished', label
          ? translate('terminal.session.finishedNamed', { name: label })
          : translate('terminal.session.finishedProcess'));
      }
    } else if (hasJob && before?.foreground && before.foreground.pid !== foreground.pid) {
      session.jobStartedAt = now;
      session.jobLabel = foreground.agent || foreground.command || foreground.name;
    }
    // Um card so redesenha quando algo que ele mostra mudou.
    const changed = !before
      || before.available !== next.available
      || before.cpu !== next.cpu
      || before.memory !== next.memory
      || before.agent !== next.agent
      || before.profile !== next.profile
      || before.usage !== next.usage
      || before.shellCwd !== next.shellCwd
      || !sameForeground(before.foreground, next.foreground)
      || Boolean(session.jobStartedAt);
    if (changed) emitActivity(session);
    // O explorador acompanha o diretorio do shell quando a sessao pediu.
    if (session.explorer.followCwd && next.shellCwd && next.shellCwd !== session.explorer.root) {
      setExplorerRoot(session.id, next.shellCwd, { keepFollow: true });
    }
  });
}

/* ── uso do plano dos agentes ─────────────────────────────────────── */

// Quanto do plano o agente ja gastou, na conta do perfil que a sessao usa:
// duas sessoes do mesmo agente no mesmo perfil mostram o mesmo numero, e
// perfis diferentes mostram numeros diferentes. Sem perfil no processo, vale
// o perfil padrao do agente.
const DEFAULT_PROFILE = { 'Claude Code': 'claude', Codex: 'codex' };

function usageKey(agent, profile) {
  return `${agent}|${profile || DEFAULT_PROFILE[agent] || ''}`;
}

export function usageFor(agent, profile) {
  if (!agent) return null;
  return state.aiUsage.get(usageKey(agent, profile)) || null;
}

// Modelo em uso pela sessao do agente: a sessao do perfil cuja pasta bate
// com a do processo, senao a mais recente do perfil.
export function sessionModel(activity) {
  const usage = activity?.usage;
  if (!usage) return null;
  const cwd = activity.foreground?.cwd || activity.shellCwd || null;
  const match = cwd && Array.isArray(usage.sessions) ? usage.sessions.find((session) => session.cwd === cwd) : null;
  return match?.model || usage.model || null;
}

function usageSignature(usage) {
  if (!usage) return '';
  const sessions = Array.isArray(usage.sessions) ? usage.sessions.map((session) => `${session.cwd}:${session.model}`).join(',') : '';
  return `${usage.windows.map((window) => `${window.id}:${window.usedPercent}`).join('|')}#${usage.model || ''}#${sessions}`;
}

// Guarda o objeto anterior quando os numeros nao mudaram: assim os cards nao
// redesenham a cada leitura.
function mergeUsage(list) {
  const next = new Map();
  list.forEach((item) => {
    if (!item || !item.agent || item.stale || !item.windows?.length) return;
    const key = usageKey(item.agent, item.profile);
    const before = state.aiUsage.get(key);
    next.set(key, before && usageSignature(before) === usageSignature(item) ? before : item);
  });
  return next;
}

// Devolve false quando nem tentou ler, para o intervalo nao ser consumido:
// assim o numero aparece poucos segundos depois de um agente comecar.
async function sampleUsage() {
  if (!hasBridge() || state.demo) return false;
  const wanted = [...state.sessions.values()].some((session) => session.status === 'running' && session.activity?.agent);
  if (!wanted) return false;
  try {
    const list = await invoke('ai_usage');
    if (!Array.isArray(list)) return;
    state.aiUsage = mergeUsage(list);
  } catch (_error) {
    // Sem o comando ou sem dado publicado, os cards ficam so com CPU e memoria.
    state.aiUsage = new Map();
  }
  state.sessions.forEach((session) => {
    const activity = session.activity;
    if (!activity) return;
    const usage = usageFor(activity.agent, activity.profile);
    if (usage === activity.usage) return;
    session.activity = { ...activity, usage };
    emitActivity(session);
  });
  return true;
}

async function sampleMetrics() {
  if (state.metricsBusy || !hasBridge() || state.demo) return;
  const running = [...state.sessions.values()].some((session) => session.status === 'running' && session.ptyId != null);
  if (!running) return;
  state.metricsBusy = true;
  try {
    const list = await invoke('pty_metrics');
    if (Array.isArray(list)) applyMetrics(list);
  } catch (_error) {
    // Kernel recusou a leitura: os cards mostram o dado como indisponivel.
    state.sessions.forEach((session) => {
      if (session.status === 'running' && session.activity) {
        session.activity = { ...session.activity, available: false, cpu: null, memory: null };
        emitActivity(session);
      }
    });
  } finally {
    state.metricsBusy = false;
  }
}

function ensureMetrics() {
  if (state.metricsTimer) return;
  const tick = async () => {
    state.metricsTimer = null;
    const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
    const running = [...state.sessions.values()].some((session) => session.status === 'running');
    if (!running) return;
    if (!hidden) await sampleMetrics();
    if (!hidden && Date.now() - state.usageAt > USAGE_MS) {
      if (await sampleUsage()) state.usageAt = Date.now();
    }
    const interval = state.viewMounted && state.viewVisible && !hidden ? METRICS_VISIBLE_MS : METRICS_HIDDEN_MS;
    state.metricsTimer = setTimeout(tick, interval);
  };
  state.metricsTimer = setTimeout(tick, 250);
}

function ensureWatchers() {
  if (!state.themeWatcher) {
    state.themeWatcher = watchTheme(() => {
      state.sessions.forEach((session) => { session.term.options.theme = buildTheme(); });
      dispatch({ type: 'theme' });
    });
  }
  if (!state.layoutWatcher) {
    let fontSize = getLayout().fontSize;
    state.layoutWatcher = subscribeLayout((layout) => {
      if (layout.fontSize === fontSize) return;
      if (isPhone()) return;
      fontSize = layout.fontSize;
      state.sessions.forEach((session) => {
        session.term.options.fontSize = fontSize;
        fitAndResize(session.id);
      });
    });
  }
  if (typeof window !== 'undefined' && !state.focusWatcher) {
    state.focusWatcher = true;
    watchPixelRatio();
    window.addEventListener('focus', () => { state.windowFocused = true; onViewedChange(); });
    window.addEventListener('blur', () => { state.windowFocused = false; });
    document.addEventListener('visibilitychange', () => {
      state.viewVisible = state.viewMounted && document.visibilityState === 'visible';
      if (!state.viewVisible) state.sessions.forEach(session => session.viewport?.release());
      try { browserHooks.visibility?.(state.viewVisible); } catch (_error) { /* sem browser */ }
      onViewedChange();
    });
    onShellLock(() => state.sessions.forEach(session => session.viewport?.release()));
  }
  if (!state.exitListener && hasBridge()) {
    state.exitListener = true;
    listen('pty://view', (view) => {
      const session = [...state.sessions.values()].find(entry => entry.ptyId === view?.id);
      if (session) viewportFor(session)?.receive(view);
    }).catch(() => {});
    // Rede de seguranca: o fim normalmente chega pelo canal, depois do ultimo
    // lote; o evento global cobre um canal perdido.
    listen('pty://exit', (payload) => {
      if (!payload) return;
      state.sessions.forEach((session) => {
        if (session.ptyId === payload.id && session.status === 'running') {
          setTimeout(() => {
            if (session.ptyId === payload.id && session.status === 'running') markExited(session, payload);
          }, 300);
        }
      });
    }).catch(() => {});
  }
  if (!state.changeListener && isTauri()) {
    state.changeListener = true;
    listen('fs://change', (payload) => {
      if (!payload || !payload.path) return;
      state.changeListeners.forEach((listener) => {
        try { listener(payload); } catch (error) { console.error('[terminais/fs]', error); }
      });
    }).catch(() => {});
  }
}

// A sessao selecionada foi consultada: o sinal de atencao dela sai.
function onViewedChange() {
  const session = state.selectedId ? state.sessions.get(state.selectedId) : null;
  if (session && isViewed(session) && session.attention) clearAttention(session);
}

/* ── ciclo de vida da view ────────────────────────────────────────── */

export function viewMounted(mounted) {
  state.viewMounted = mounted;
  state.viewVisible = mounted && (typeof document === 'undefined' || document.visibilityState === 'visible');
  try { browserHooks.visibility?.(state.viewVisible); } catch (_error) { /* sem browser */ }
  if (mounted) {
    ensureMetrics();
    onViewedChange();
  }
}

/* ── API publica ──────────────────────────────────────────────────── */

export function getState() {
  const sessions = state.order.map((id) => state.sessions.get(id)).filter(Boolean);
  return {
    sessions,
    selectedId: state.selectedId,
    selected: state.selectedId ? state.sessions.get(state.selectedId) || null : null,
    hydrated: state.hydrated,
    demo: state.demo,
  };
}

export function getSession(id) {
  return state.sessions.get(id) || null;
}

// Ordem de exibicao: fixadas primeiro, cada grupo na ordem manual.
export function orderedSessions() {
  const sessions = state.order.map((id) => state.sessions.get(id)).filter(Boolean);
  return [...sessions.filter((session) => session.pinned), ...sessions.filter((session) => !session.pinned)];
}

// Both screens adopt live PTYs. Browser storage contains presentation metadata,
// never ownership or permission to terminate a process.
async function syncSharedSessions() {
  if (state.sessionsSyncing || state.demo) return;
  state.sessionsSyncing = true;
  const connectionEpoch = state.connectionEpoch;
  const observed = new Map([...state.sessions.values()].map((session) => [session.id, { ptyId: session.ptyId, token: session.spawnToken }]));
  try {
    const alive = await invoke('pty_list') || [];
    if (connectionEpoch !== state.connectionEpoch) return;
    for (const info of alive) {
      let session = [...state.sessions.values()].find((entry) => entry.ptyId === info.id);
      if (!session && info.tag) session = state.sessions.get(info.tag);
      if (!session && !info.tag) session = [...state.sessions.values()].find((entry) => entry.ptyId == null && !entry.spawning && entry.cwd === info.cwd);
      // A spawn result can arrive after pty_list observed its tag.
      if (session?.spawning) continue;
      if (!session) {
        session = createSession({ id: info.tag && !state.sessions.has(info.tag) ? info.tag : undefined, cwd: info.cwd, name: baseName(info.cwd) });
        state.order.push(session.id);
        session.ptyId = info.id;
      }
      if (session.ptyId !== info.id || session.pid !== (info.pid ?? null)) {
        session.term.reset();
        session.outputOffset = 0; session.receivedOffset = 0;
        session.spawnToken = null;
      }
      if (!isTauri() && info.presentation) {
        const value = info.presentation;
        if (typeof value.name === 'string') session.name = value.name;
        session.subtitle = typeof value.subtitle === 'string' ? value.subtitle : '';
        session.color = validColor(value.color);
        session.pinned = Boolean(value.pinned);
        session.remoteOrder = value.order;
      }
      applyTerminalInfo(session, info);
      if (!session.spawnToken || session.status !== 'running') await reattachSession(session, info.id);
    }
    if (!isTauri()) state.order.sort((a, b) => (state.sessions.get(a)?.remoteOrder ?? Infinity) - (state.sessions.get(b)?.remoteOrder ?? Infinity));
    state.sessions.forEach((session) => {
      const previous = observed.get(session.id);
      if (!session.spawning && previous?.ptyId != null && previous.ptyId === session.ptyId && previous.token === session.spawnToken && !alive.some((info) => info.id === session.ptyId)) markExited(session, { code: 0 });
    });
    if (!state.selectedId) state.selectedId = state.order[0] || null;
    persist();
    emitSessions();
    ensureMetrics();
  } finally { state.sessionsSyncing = false; }
}

export function hydrate() {
  if (state.hydrating) return state.hydrating;
  state.hydrating = (async () => {
    ensureWatchers();
    const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : null;
    if (params && params.get('terminais') === 'demo') {
      state.demo = true;
      seedDemo();
      state.hydrated = true;
      emitSessions();
      return;
    }
    if (!hasBridge()) {
      state.hydrated = true;
      emitSessions();
      return;
    }
    const store = readStore();
    if (isTauri()) {
      for (const saved of store.sessions) {
        if (!saved || typeof saved.cwd !== 'string' || !saved.cwd) continue;
        const session = createSession(saved);
        session.status = 'disconnected';
        state.order.push(session.id);
      }
      state.selectedId = store.selectedId && state.sessions.has(store.selectedId) ? store.selectedId : state.order[0] || null;
    }
    if (!isTauri() && !state.remoteListener) state.remoteListener = remote.subscribeState((value) => {
      if (value.status === 'connected') syncSharedSessions().catch(() => {});
      else {
        state.connectionEpoch += 1;
        state.sessions.forEach(session => {
          invalidateTerminalIdentity(session);
          session.spawnToken = null;
          session.spawning = false;
          if (session.ptyId != null) setStatus(session, 'disconnected');
        });
      }
    });
    // Keep discovery alive even while the local session list is empty.
    if (!state.sessionsPoll) state.sessionsPoll = setInterval(() => {
      if ((isTauri() || remote.state().status === 'connected') && document.visibilityState !== 'hidden') syncSharedSessions().catch(() => {});
    }, 3000);
    if (isTauri() || remote.state().status === 'connected') {
      await syncSharedSessions().catch((error) => dispatch({ type: 'error', message: messageOf(error) }));
    }
    state.hydrated = true;
    emitSessions();
    ensureMetrics();
    if (isTauri()) restoreDisconnected().catch(() => {});
  })();
  return state.hydrating;
}

// Cria a sessao e abre o shell na hora, mesmo sem ser exibida. Devolve o
// identificador ou null quando recusou.
export function openSession(cwd, { name, subtitle, color, select = true } = {}) {
  if (!hasBridge() && !state.demo) {
    dispatch({ type: 'error', message: translate('terminal.common.desktopOnly') });
    return null;
  }
  if (!cwd) return null;
  const session = createSession({ cwd, name: name?.trim() || undefined, customName: Boolean(name?.trim()), subtitle: subtitle?.trim() || '', color: color || null });
  state.order.push(session.id);
  if (select || !state.selectedId) state.selectedId = session.id;
  persist();
  emitSessions();
  if (state.demo) {
    session.status = 'running';
    session.activity = { available: false, cpu: null, memory: null, processes: 1, foreground: null, agent: null, shellCwd: cwd };
    session.term.write(`\x1b[2m${translate('terminal.session.demo', { path: cwd })}\x1b[0m\r\n$ `);
  } else {
    spawnSession(session);
  }
  return session.id;
}

export async function pickAndOpen(defaultPath, options) {
  const picked = await chooseDirectory({ title: translate('terminal.session.openAt'), defaultPath: defaultPath || undefined });
  return picked ? openSession(picked, options) : null;
}

export function selectSession(id) {
  if (!state.sessions.has(id) || state.selectedId === id) return;
  state.selectedId = id;
  persist();
  emitSessions();
  onViewedChange();
}

// Adota o elemento do terminal da sessao no host da area central. O
// anterior volta para o contenedor fora da tela.
export function hostTerminal(id, element) {
  const session = state.sessions.get(id);
  if (!session || !element) return;
  if (state.hostedId && state.hostedId !== id) {
    const previous = state.sessions.get(state.hostedId);
    if (previous) {
      previous.viewport?.release();
      unloadWebgl(previous);
      if (previous.term.element) parking().appendChild(previous.term.element);
      previous.host = null;
    }
  }
  const { term } = session;
  if (term.element && term.element.parentElement !== element) element.appendChild(term.element);
  session.host = element;
  state.hostedId = id;
  state.hostElement = element;
  loadWebgl(session);
  fitNow(session);
  if (isPhone()) requestTerminalControl(id).catch((error) => dispatch({ type: 'error', message: messageOf(error) }));
  else if (state.selectedId === id) term.focus();
}

export function releaseTerminal(id) {
  const session = state.sessions.get(id);
  if (!session) return;
  session.viewport?.release();
  unloadWebgl(session);
  if (session.term.element) parking().appendChild(session.term.element);
  session.host = null;
  if (state.hostedId === id) { state.hostedId = null; state.hostElement = null; }
}

export function fitAndResize(id) {
  const session = state.sessions.get(id);
  if (!session) return;
  if (session.fitTimer) clearTimeout(session.fitTimer);
  session.fitTimer = setTimeout(() => {
    session.fitTimer = null;
    fitNow(session);
  }, FIT_DEBOUNCE_MS);
}

export function focusTerminal(id) {
  const session = state.sessions.get(id || state.selectedId);
  if (session && session.host) session.term.focus();
}

// No iPhone, foco no terminal significa teclado aberto.
export function terminalHasFocus(id) {
  const session = state.sessions.get(id || state.selectedId);
  const textarea = session?.term.textarea;
  return Boolean(textarea) && typeof document !== 'undefined' && document.activeElement === textarea;
}

export function focusSelected() {
  focusTerminal(state.selectedId);
}

// Abre um shell novo na sessao: depois de exit, de erro ou de desconexao.
// Desconectada, a sessao antes recebe o historico gravado e, quando um agente
// rodava nela, a conversa volta pelo comando de retomada.
export async function reopen(id) {
  const session = state.sessions.get(id);
  if (!session || session.status === 'running' || session.spawning || session.reopening) return;
  session.reopening = true;
  try {
    const disconnected = session.status === 'disconnected';
    const saved = disconnected ? await restoreSaved(session) : null;
    if (!state.sessions.has(id) || session.status === 'running' || session.spawning) return;
    if (!disconnected) session.term.write(`\r\n\x1b[2m${translate('terminal.session.reopened')}\x1b[0m\r\n`);
    session.attention = null;
    await spawnSession(session);
    if (saved?.resume?.command && session.status === 'running') await resumeAgent(session, saved.resume);
  } finally {
    session.reopening = false;
  }
}

// Encerra o shell e abre outro na mesma pasta, preservando o historico.
export async function restart(id) {
  const session = state.sessions.get(id);
  if (!session) return;
  if (session.ptyId != null) {
    const old = session.ptyId;
    try { await invoke('pty_kill', { id: old }); }
    catch (error) { dispatch({ type: 'error', message: messageOf(error) }); return; }
    session.spawnToken = null;
    session.ptyId = null;
    session.activity = null;
  }
  session.term.write(`\r\n\x1b[2m${translate('terminal.session.terminalRestarted')}\x1b[0m\r\n`);
  session.attention = null;
  spawnSession(session);
}

export async function changeDirectory(id, cwd) {
  const session = state.sessions.get(id);
  if (!session) return;
  const picked = cwd || await chooseDirectory({ title: translate('terminal.session.changeFolderTitle'), defaultPath: session.cwd });
  if (!picked || picked === session.cwd) return;
  if (session.ptyId != null) {
    const old = session.ptyId;
    try { await invoke('pty_kill', { id: old }); }
    catch (error) { dispatch({ type: 'error', message: messageOf(error) }); return; }
    session.spawnToken = null;
    session.ptyId = null;
  }
  // O arquivo de porta do browser fica na pasta antiga: o Chromium encerra
  // e reabre na nova quando a aba for usada de novo.
  try { browserHooks.directoryChanged?.(session); } catch (_error) { /* sem browser */ }
  session.cwd = picked;
  if (!session.customName) session.name = baseName(picked);
  session.explorer.root = picked;
  session.explorer.expanded = new Set([picked]);
  session.explorer.nodes = new Map();
  session.explorer.git = null;
  session.explorer.revision += 1;
  session.term.write(`\r\n\x1b[2m${translate('terminal.session.folderChanged', { path: picked })}\x1b[0m\r\n`);
  persist();
  emitExplorer(session);
  spawnSession(session);
}

export async function closeSession(id) {
  const session = state.sessions.get(id);
  if (!session) return false;
  if (session.ptyId != null) {
    try { await invoke('pty_kill', { id: session.ptyId }); }
    catch (error) { dispatch({ type: 'error', message: messageOf(error) }); return false; }
  }
  // Encerrada de proposito: o historico e a conversa guardados saem do disco.
  if (isTauri() && !state.demo) invoke('pty_forget', { tag: id }).catch(() => {});
  session.spawnToken = null;
  if (session.ackTimer) clearTimeout(session.ackTimer);
  if (session.fitTimer) clearTimeout(session.fitTimer);
  if (session.activityTimer) clearTimeout(session.activityTimer);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.outputChannel?.dispose?.();
  try { browserHooks.sessionClosed?.(session); } catch (_error) { /* sem browser */ }
  session.editor.tabs.forEach((tab) => disposeTab(tab));
  releaseSessionWatches(session);
  session.disposables.forEach((disposable) => { try { disposable.dispose(); } catch (_error) { /* ja descartado */ } });
  unloadWebgl(session);
  try { session.term.dispose(); } catch (_error) { /* ja descartado */ }
  state.sessions.delete(id);
  state.order = state.order.filter((entry) => entry !== id);
  if (state.hostedId === id) { state.hostedId = null; state.hostElement = null; }
  if (state.selectedId === id) {
    const ordered = orderedSessions();
    state.selectedId = ordered[0]?.id || null;
  }
  persist();
  emitSessions();
  return true;
}

export function renameSession(id, name) {
  const session = state.sessions.get(id);
  if (!session) return;
  const next = String(name || '').trim();
  if (next) {
    session.name = next;
    session.customName = true;
  } else {
    session.name = baseName(session.cwd);
    session.customName = false;
  }
  persist();
  emitSessions();
}

// Subtitulo livre: para que serve esta sessao, ja que a mesma pasta pode
// estar aberta varias vezes com papeis diferentes.
export function setSessionSubtitle(id, subtitle) {
  const session = state.sessions.get(id);
  if (!session) return;
  session.subtitle = String(subtitle || '').trim();
  persist();
  emitSessions();
}

export function setSessionColor(id, color) {
  const session = state.sessions.get(id);
  if (!session) return;
  session.color = validColor(color);
  persist();
  emitSessions();
}

export function togglePinned(id) {
  const session = state.sessions.get(id);
  if (!session) return;
  session.pinned = !session.pinned;
  persist();
  emitSessions();
}

// Move a sessao para antes de `beforeId` dentro do proprio grupo, fixadas
// ou nao. `beforeId` nulo manda para o fim do grupo.
export function moveSession(id, beforeId) {
  const session = state.sessions.get(id);
  if (!session || id === beforeId) return;
  const target = beforeId ? state.sessions.get(beforeId) : null;
  if (target && target.pinned !== session.pinned) return;
  const rest = state.order.filter((entry) => entry !== id);
  if (target) {
    const index = rest.indexOf(beforeId);
    rest.splice(index, 0, id);
  } else {
    // Fim do grupo: depois da ultima do mesmo estado de fixacao.
    let last = -1;
    rest.forEach((entry, position) => { if (state.sessions.get(entry)?.pinned === session.pinned) last = position; });
    rest.splice(last + 1, 0, id);
  }
  state.order = rest;
  persist();
  emitSessions();
}

// Uma posicao para cima ou para baixo dentro do proprio grupo, para o
// teclado e o menu. Devolve false nas pontas.
export function canMoveSession(id, delta) {
  const session = state.sessions.get(id);
  if (!session || !delta) return false;
  const group = orderedSessions().filter((entry) => entry.pinned === session.pinned);
  const index = group.findIndex((entry) => entry.id === id);
  const target = index + delta;
  return index >= 0 && target >= 0 && target < group.length;
}

export function moveSessionBy(id, delta) {
  if (!canMoveSession(id, delta)) return false;
  const session = state.sessions.get(id);
  const group = orderedSessions().filter((entry) => entry.pinned === session.pinned);
  const index = group.findIndex((entry) => entry.id === id);
  const target = index + delta;
  if (delta < 0) moveSession(id, group[target].id);
  else moveSession(id, group[target + 1]?.id || null);
  return true;
}

export function selectNext(delta = 1) {
  const ordered = orderedSessions();
  if (!ordered.length) return;
  const index = ordered.findIndex((session) => session.id === state.selectedId);
  const next = ordered[(index + delta + ordered.length) % ordered.length];
  selectSession(next.id);
}

export function sessionsNeedingAttention() {
  return orderedSessions().filter((session) => session.attention);
}

export function selectNextAttention() {
  const pending = sessionsNeedingAttention();
  if (!pending.length) return false;
  const current = pending.findIndex((session) => session.id === state.selectedId);
  const next = pending[(current + 1) % pending.length];
  selectSession(next.id);
  return true;
}

// Texto para inserir no terminal, sem executar.
export function insertText(id, text) {
  const session = state.sessions.get(id || state.selectedId);
  if (!session || session.ptyId == null || session.status !== 'running') return false;
  writeTerminal(session, text);
  session.term.focus();
  return true;
}

// Tecla da fileira do celular: escreve sem mexer no foco. Quem decide se o
// teclado do iPhone abre e o toque no proprio terminal, nao o botao; assim
// Ctrl C ou Esc no meio da leitura nao sobem o teclado.
export function sendKey(id, data) {
  const session = state.sessions.get(id || state.selectedId);
  if (!session || session.ptyId == null || session.status !== 'running') return false;
  writeTerminal(session, data);
  return true;
}

// Colar pelo paste do xterm, que respeita o bracketed paste do shell ou do
// agente e normaliza as quebras de linha, em vez de escrever o texto cru.
export function pasteText(id, text) {
  const session = state.sessions.get(id || state.selectedId);
  if (!session || session.ptyId == null || session.status !== 'running' || !text) return false;
  session.term.paste(text);
  return true;
}

// Rolagem afastada do fim, para a interface oferecer a volta e avisar de
// saida nova enquanto a pessoa le o historico. So o buffer normal tem
// historico; na tela alternativa nada e sinalizado.
export function watchTail(id, listener) {
  const session = state.sessions.get(id);
  if (!session) return () => {};
  const { term } = session;
  let detached = false;
  let fresh = false;
  const check = (output) => {
    const buffer = term.buffer.active;
    const now = buffer.type === 'normal' && buffer.viewportY < buffer.baseY;
    if (now !== detached) { detached = now; fresh = false; listener({ detached, fresh }); return; }
    if (now && output && !fresh) { fresh = true; listener({ detached, fresh }); }
  };
  const disposables = [term.onScroll(() => check(false)), term.onWriteParsed(() => check(true))];
  check(false);
  return () => disposables.forEach((disposable) => disposable.dispose());
}

export function scrollToBottom(id) {
  state.sessions.get(id || state.selectedId)?.term.scrollToBottom();
}

// Soltar arquivos equivale a colar argumentos, sem Enter. O paste do xterm
// respeita bracketed paste quando o shell ou agente o habilitou. O caminho
// vai sempre absoluto e citado, venha do Finder ou do explorador: um
// caminho relativo deixava de valer assim que o shell trocava de pasta.
export function insertPaths(id, paths) {
  const session = state.sessions.get(id);
  if (!session || session.ptyId == null || session.status !== 'running') return false;
  const valid = paths.filter((path) => typeof path === 'string' && path.length > 0 && !/[\x00-\x1f\x7f]/.test(path));
  if (!valid.length) return false;
  session.term.paste(`${valid.map((path) => shellQuote(path, session.shellFlavor)).join(' ')} `);
  session.term.focus();
  return true;
}

// Manda caminhos para uma sessao trazendo-a para frente antes. A escrita so
// vale com o terminal hospedado na area central e com a concessao de largura
// do Mac, entao numa sessao em segundo plano a colagem se perderia em
// silencio; aqui ela espera o terminal ser adotado.
export function deliverPaths(id, paths) {
  const session = state.sessions.get(id);
  if (!session || session.ptyId == null || session.status !== 'running') return false;
  selectSession(id);
  const attempt = (left) => {
    if (state.hostedId === id && session.host) { insertPaths(id, paths); return; }
    if (left > 0) setTimeout(() => attempt(left - 1), 50);
  };
  attempt(40);
  return true;
}

/* ── intencoes vindas do menu nativo ──────────────────────────────── */

// ⌘T: se a view esta montada ela abre o seletor; senao a intencao espera.
export function requestNewTerminal() {
  if (state.newTerminalHandler) {
    state.newTerminalHandler();
    return;
  }
  state.pendingNewTerminal = true;
}

// ⌘N: novo arquivo temporario. Mesma ideia do ⌘T, com a intencao esperando
// quando a secao ainda nao esta montada.
export function requestNewFile() {
  if (state.newFileHandler) {
    state.newFileHandler();
    return;
  }
  state.pendingNewFile = true;
}

export function onNewFileRequest(handler) {
  state.newFileHandler = handler;
  if (state.pendingNewFile) {
    state.pendingNewFile = false;
    setTimeout(() => handler(), 0);
  }
  return () => {
    if (state.newFileHandler === handler) state.newFileHandler = null;
  };
}

export function onNewTerminalRequest(handler) {
  state.newTerminalHandler = handler;
  if (state.pendingNewTerminal) {
    state.pendingNewTerminal = false;
    setTimeout(() => handler(), 0);
  }
  return () => {
    if (state.newTerminalHandler === handler) state.newTerminalHandler = null;
  };
}

// ⌘W: a view decide entre fechar a aba do editor e encerrar a sessao, com
// as confirmacoes que cabem. Devolve false quando nao ha o que fechar, para
// o atalho cair no comportamento de fechar a janela.
export function onCloseRequest(handler) {
  state.closeHandler = handler;
  return () => {
    if (state.closeHandler === handler) state.closeHandler = null;
  };
}

export function closeActive() {
  if (state.closeHandler) return state.closeHandler();
  return false;
}

/* ── explorador ───────────────────────────────────────────────────── */

export function subscribeChanges(listener) {
  state.changeListeners.add(listener);
  return () => state.changeListeners.delete(listener);
}

// Observa um caminho para a sessao. O mesmo caminho observado por duas
// sessoes vira um observador so, aqui e no Rust.
export function watchPath(session, path) {
  if (!isTauri() || state.demo || !path) return;
  let entry = state.watches.get(path);
  if (!entry) {
    entry = { id: null, owners: new Set(), pending: fs.watch(path).then((id) => { entry.id = id; return id; }).catch(() => null) };
    state.watches.set(path, entry);
  }
  entry.owners.add(session.id);
}

export function unwatchPath(session, path) {
  const entry = state.watches.get(path);
  if (!entry) return;
  entry.owners.delete(session.id);
  if (entry.owners.size > 0) return;
  state.watches.delete(path);
  entry.pending.then((id) => { if (id != null) fs.unwatch(id).catch(() => {}); });
}

function releaseSessionWatches(session) {
  [...state.watches.keys()].forEach((path) => unwatchPath(session, path));
}

export function setExplorerRoot(id, root, { keepFollow = false } = {}) {
  const session = state.sessions.get(id);
  if (!session || !root) return;
  const explorer = session.explorer;
  const previous = explorer.root;
  if (previous === root) {
    if (!keepFollow) explorer.followCwd = false;
    return;
  }
  // Mantem expandidas as pastas que continuam dentro da nova raiz.
  const expanded = new Set([root]);
  explorer.expanded.forEach((path) => { if (isInside(root, path)) expanded.add(path); });
  explorer.expanded = expanded;
  explorer.root = root;
  if (!keepFollow) explorer.followCwd = false;
  explorer.revision += 1;
  persist();
  emitExplorer(session);
}

export function setFollowCwd(id, follow) {
  const session = state.sessions.get(id);
  if (!session) return;
  session.explorer.followCwd = Boolean(follow);
  if (follow && session.activity?.shellCwd) setExplorerRoot(id, session.activity.shellCwd, { keepFollow: true });
  persist();
  emitExplorer(session);
}

export function markExplorerChanged(id) {
  const session = state.sessions.get(id);
  if (!session) return;
  session.explorer.revision += 1;
  emitExplorer(session);
}

/* ── editor por sessao ────────────────────────────────────────────── */

function disposeTab(tab) {
  if (tab.view) {
    try { tab.onDispose?.(); } catch (_error) { /* sem ouvinte */ }
    try { tab.view.destroy(); } catch (_error) { /* ja destruido */ }
    tab.view = null;
  }
  if (tab.watchPath && tab.session) unwatchPath(tab.session, tab.watchPath);
}

export function getTabs(id) {
  const session = state.sessions.get(id);
  return session ? session.editor.tabs : [];
}

export function allTabs() {
  const result = [];
  state.sessions.forEach((session) => result.push(...session.editor.tabs));
  return result;
}

export function findTab(id, path) {
  const session = state.sessions.get(id);
  if (!session || !path) return null;
  return session.editor.tabs.find((tab) => tab.path === path && tab.kind !== 'diff') || null;
}

// Registra uma aba. `tab` ja vem montada pelo modulo do editor; aqui so entra
// na lista da sessao e vira a ativa.
export function addTab(id, tab, { activate = true } = {}) {
  const session = state.sessions.get(id);
  if (!session) return null;
  tab.session = session;
  session.editor.tabs.push(tab);
  if (activate || !session.editor.activeId) session.editor.activeId = tab.id;
  if (tab.watchPath) watchPath(session, tab.watchPath);
  persist();
  emitEditor(session);
  return tab;
}

export function activateTab(id, tabId) {
  const session = state.sessions.get(id);
  if (!session) return;
  if (!session.editor.tabs.some((tab) => tab.id === tabId)) return;
  session.editor.activeId = tabId;
  persist();
  emitEditor(session);
}

export function removeTab(id, tabId) {
  const session = state.sessions.get(id);
  if (!session) return;
  const index = session.editor.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  const [tab] = session.editor.tabs.splice(index, 1);
  disposeTab(tab);
  if (session.editor.activeId === tabId) {
    const neighbour = session.editor.tabs[index] || session.editor.tabs[index - 1] || null;
    session.editor.activeId = neighbour ? neighbour.id : null;
  }
  if (!session.editor.tabs.length) session.editor.maximized = null;
  persist();
  emitEditor(session);
}

// O arquivo da aba mudou de lugar ou ganhou nome: o observador segue o
// caminho novo e o conteudo do editor fica onde esta, com o desfazer.
export function setTabPath(tab, path, name) {
  const session = tab.session;
  if (tab.watchPath && session) unwatchPath(session, tab.watchPath);
  tab.path = path;
  tab.name = name;
  tab.watchPath = tab.kind === 'diff' ? null : path;
  if (tab.watchPath && session) watchPath(session, tab.watchPath);
  persist();
  if (session) emitEditor(session);
}

// Uma aba mudou por dentro: sujo, conflito, modo ou carregamento.
export function touchTab(tab) {
  if (tab?.session) emitEditor(tab.session);
  else state.sessions.forEach((session) => emitEditor(session));
}

export function setEditorRatio(id, ratio) {
  const session = state.sessions.get(id);
  if (!session) return;
  session.editor.ratio = ratio;
  persist();
  emitEditor(session);
}

export function setMaximized(id, target) {
  const session = state.sessions.get(id);
  if (!session) return;
  session.editor.maximized = session.editor.maximized === target ? null : target;
  emitEditor(session);
}

/* ── fixtures para capturas fora do Tauri ─────────────────────────── */

function seedDemo() {
  const home = `${platform().home}/Projects`;
  // Uso do plano de exemplo, para o card mostrar o chip nas capturas.
  state.aiUsage = new Map([
    ['Claude Code|claude-main', {
      agent: 'Claude Code',
      profile: 'claude-main',
      profileName: translate('terminal.demo.profileMain'),
      configDir: '/Users/exemplo/.claude-main',
      model: 'Fable 5.1',
      sessions: [{ sessionId: 'demo', cwd: `${home}/cialai-platform`, model: 'Fable 5.1', updatedAtMs: Date.now() }],
      plan: 'max',
      source: 'statusline',
      stale: false,
      updatedAtMs: Date.now(),
      windows: [
        { id: 'five_hour', label: translate('terminal.demo.sessionWindow'), usedPercent: 41, windowMinutes: 300, resetsAtMs: Date.now() + 2 * 3600 * 1000 },
        { id: 'seven_day', label: translate('terminal.demo.weekWindow'), usedPercent: 63, windowMinutes: 10080, resetsAtMs: Date.now() + 3 * 86400 * 1000 },
      ],
    }],
  ]);
  const first = createSession({ cwd: `${home}/cialai-platform`, name: 'cialai-platform', subtitle: translate('terminal.demo.studioSubtitle') });
  first.status = 'running';
  first.activity = {
    available: true, cpu: 38.4, memory: 412 * 1024 * 1024, processes: 6, shellCwd: `${home}/cialai-platform/packages/ui`,
    foreground: { pid: 4242, name: 'node', command: 'node', agent: 'Claude Code', stopped: false, cwd: `${home}/cialai-platform`, profile: 'claude-main', profileName: translate('terminal.demo.profileMain'), configDir: '/Users/exemplo/.claude-main' },
    agent: 'Claude Code', profile: 'claude-main', profileName: translate('terminal.demo.profileMain'), configDir: '/Users/exemplo/.claude-main',
    usage: usageFor('Claude Code', 'claude-main'),
  };
  first.lastOutputAt = Date.now();
  first.jobStartedAt = Date.now() - 154000;
  first.term.write(`\x1b[2m$ claude --resume\x1b[0m\r\n\r\n\x1b[1m⏺\x1b[0m ${translate('terminal.demo.reading')}\r\n\x1b[2m  ⎿  Read 612 lines\x1b[0m\r\n\r\n\x1b[1m⏺\x1b[0m ${translate('terminal.demo.adjustCard')}\r\n`);
  first.explorer.git = { isRepo: true, branch: 'main', ahead: 2, behind: 0, changes: [{ path: 'packages/ui/src/terminals/runtime.js', status: 'modified', staged: false, worktree: true }, { path: 'packages/ui/src/views/Terminais.css', status: 'modified', staged: false, worktree: true }, { path: 'docs/04-desktop.md', status: 'untracked', staged: false, worktree: true }] };
  const second = createSession({ cwd: `${home}/site-exemplo`, name: 'site-exemplo', pinned: true, color: 'verde', subtitle: translate('terminal.demo.devServer') });
  second.status = 'running';
  second.activity = { available: true, cpu: 0.6, memory: 96 * 1024 * 1024, processes: 2, foreground: { pid: 5100, name: 'node', command: 'npm', agent: null, stopped: false }, agent: null, shellCwd: `${home}/site-exemplo` };
  second.lastOutputAt = Date.now() - 20000;
  second.term.write('$ npm run dev\r\n\r\n  VITE v7.3.6  ready in 412 ms\r\n\r\n  ➜  Local:   http://127.0.0.1:5173/\r\n');
  second.jobStartedAt = Date.now() - 3600000;
  const third = createSession({ cwd: `${home}/api-exemplo`, name: 'api-exemplo', color: 'roxo', subtitle: translate('terminal.demo.backendTests') });
  third.status = 'running';
  third.activity = { available: true, cpu: 0, memory: 14 * 1024 * 1024, processes: 1, foreground: null, agent: null, shellCwd: `${home}/api-exemplo` };
  third.lastOutputAt = Date.now() - 400000;
  third.term.write('$ git pull\r\nAlready up to date.\r\n$ ');
  third.attention = { kind: 'finished', message: translate('terminal.session.finishedNamed', { name: 'pytest' }), at: Date.now() - 60000 };
  const fourth = createSession({ cwd: `${home}/rascunho`, name: 'rascunho', color: 'laranja' });
  fourth.status = 'exited';
  fourth.exitCode = 1;
  fourth.term.write('$ npm test\r\n\x1b[31m✖ 3 tests failed\x1b[0m\r\n');
  fourth.attention = { kind: 'error', message: translate('terminal.session.endedCode', { code: 1 }), at: Date.now() - 5000 };
  const fifth = createSession({ cwd: `${home}/automacoes`, name: 'automações', customName: true });
  fifth.status = 'disconnected';
  state.order = [first.id, second.id, third.id, fourth.id, fifth.id];
  state.selectedId = first.id;
}

export function localizeDemo() {
  if (!state.demo) return;
  const usage = state.aiUsage.get('Claude Code|claude-main');
  if (usage) {
    usage.profileName = translate('terminal.demo.profileMain');
    usage.windows = usage.windows.map((window) => ({
      ...window,
      label: translate(window.id === 'five_hour' ? 'terminal.demo.sessionWindow' : 'terminal.demo.weekWindow'),
    }));
  }
  for (const session of state.sessions.values()) {
    if (session.cwd.endsWith('/cialai-platform')) {
      session.subtitle = translate('terminal.demo.studioSubtitle');
      if (session.activity) {
        session.activity.profileName = translate('terminal.demo.profileMain');
        session.activity.usage = usage || null;
        if (session.activity.foreground) session.activity.foreground.profileName = translate('terminal.demo.profileMain');
      }
    } else if (session.cwd.endsWith('/site-exemplo')) {
      session.subtitle = translate('terminal.demo.devServer');
    } else if (session.cwd.endsWith('/api-exemplo')) {
      session.subtitle = translate('terminal.demo.backendTests');
      session.attention = { ...session.attention, message: translate('terminal.session.finishedNamed', { name: 'pytest' }) };
    } else if (session.cwd.endsWith('/rascunho')) {
      session.attention = { ...session.attention, message: translate('terminal.session.endedCode', { code: 1 }) };
    }
    emitActivity(session);
  }
  emitSessions();
}
