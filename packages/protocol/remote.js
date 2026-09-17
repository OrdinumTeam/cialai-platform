// SPDX-License-Identifier: Apache-2.0
// WebSocket counterpart of Tauri IPC. Calls in flight are never replayed.

export const DISCONNECTED = 'Ponte com o computador desconectada.';

// O código estável permite que cada interface traduza a falha no seu idioma.
const bridgeError = (code, message) => Object.assign(new Error(message), { code });
const EMPTY_STATE = Object.freeze({
  status: 'disabled',
  code: null,
  auth: null,
  user: null,
  device: null,
  desktop: null,
  capabilities: [],
  features: [],
});

let configured;
let socket;
let retryTimer;
let handshakeTimer;
let resumeTimer;
let retryDelay = 500;
let nextCall = 1;
let nextChannel = 1;
let snapshot = { ...EMPTY_STATE };
const observers = new Set();
const calls = new Map();
const channels = new Map();
const events = new Map();

export const state = () => snapshot;
export const isConfigured = () => Boolean(configured);
export const subscribeState = (listener) => { observers.add(listener); return () => observers.delete(listener); };

function publish(value) {
  snapshot = { ...snapshot, ...value };
  observers.forEach((listener) => listener(snapshot));
}

export class RemoteChannel {
  constructor(onmessage) {
    this.id = nextChannel;
    nextChannel += 1;
    this.onmessage = onmessage;
    channels.set(this.id, this);
  }
  toJSON() { return { __channel__: this.id }; }
  dispose() { channels.delete(this.id); }
}

export const createChannel = (onmessage) => new RemoteChannel(onmessage);

function detach() {
  const active = [...channels.values()];
  channels.clear();
  active.forEach((channel) => channel.onmessage?.({ type: 'detached', reason: 'socket' }));
  calls.forEach(({ reject, timer }) => {
    clearTimeout(timer);
    reject(bridgeError('bridge_disconnected', DISCONNECTED));
  });
  calls.clear();
}

function receive(data) {
  if (data instanceof ArrayBuffer) {
    if (data.byteLength < 4) return;
    const id = new DataView(data).getUint32(0, false);
    channels.get(id)?.onmessage?.(new Uint8Array(data, 4));
    return;
  }
  let message;
  try { message = JSON.parse(data); } catch (_error) { return; }
  if (message.type === 'welcome') {
    if (message.version !== 1) { socket?.close(4426); return; }
    clearTimeout(handshakeTimer);
    retryDelay = 500;
    publish({
      status: 'connected',
      code: null,
      auth: message.auth || null,
      user: message.user || null,
      device: message.device || null,
      desktop: message.desktop || null,
      capabilities: message.capabilities || [],
      features: message.features || [],
    });
    return;
  }
  if (message.type === 'result') {
    const call = calls.get(message.id);
    if (!call) return;
    calls.delete(message.id);
    clearTimeout(call.timer);
    if (message.ok) call.resolve(message.value);
    else call.reject(message.error ? new Error(message.error) : bridgeError('bridge_failed', 'Falha na ponte com o computador.'));
    return;
  }
  if (message.type === 'event') {
    events.get(message.name)?.forEach((handler) => handler(message.payload, { event: message.name, payload: message.payload }));
    return;
  }
  if (message.type === 'channel') {
    const channel = channels.get(message.channel);
    if (['exit', 'detached'].includes(message.message?.type)) channels.delete(message.channel);
    channel?.onmessage?.(message.message);
  }
}

function scheduleReconnect() {
  if (!configured || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, retryDelay);
  retryDelay = Math.min(8000, retryDelay * 2);
}

export function connect() {
  if (!configured || socket && socket.readyState < 2) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  publish({ status: 'connecting', code: null });
  let nextSocket;
  try { nextSocket = new WebSocket(configured.url); } catch (_error) {
    publish({ status: 'disconnected' });
    scheduleReconnect();
    return;
  }
  socket = nextSocket;
  nextSocket.binaryType = 'arraybuffer';
  handshakeTimer = setTimeout(() => nextSocket.close(), 6000);
  nextSocket.onopen = () => {
    if (socket !== nextSocket) return;
    nextSocket.send(JSON.stringify({
      type: 'hello',
      version: 1,
      token: configured.token || null,
      client: configured.client,
      app: configured.app,
    }));
  };
  nextSocket.onmessage = (event) => { if (socket === nextSocket) receive(event.data); };
  nextSocket.onerror = () => nextSocket.close();
  nextSocket.onclose = (event) => {
    if (socket !== nextSocket) return;
    socket = null;
    clearTimeout(handshakeTimer);
    const fatal = event.code === 4401 || event.code === 4426;
    const status = event.code === 4401 ? 'removed' : event.code === 4426 ? 'incompatible' : 'disconnected';
    if (fatal) configured = null;
    publish({ status, code: event.code });
    detach();
    if (!fatal) scheduleReconnect();
  };
}

export function configure(options) {
  disconnect();
  if (!options?.url) return;
  const url = new URL(options.url);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw bridgeError('bridge_url_invalid', 'Endereço da ponte inválido.');
  configured = {
    token: null,
    client: 'cialai-ios',
    app: '0.1.0',
    ...options,
    url: url.href,
  };
  connect();
}

export function disconnect() {
  configured = null;
  clearTimeout(retryTimer);
  retryTimer = null;
  clearTimeout(handshakeTimer);
  clearTimeout(resumeTimer);
  resumeTimer = null;
  const previous = socket;
  socket = null;
  previous?.close();
  snapshot = { ...EMPTY_STATE };
  observers.forEach((listener) => listener(snapshot));
  detach();
}

export function invoke(cmd, args = {}) {
  if (snapshot.status !== 'connected' || socket?.readyState !== 1) return Promise.reject(bridgeError('bridge_disconnected', DISCONNECTED));
  const id = nextCall;
  nextCall += 1;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      calls.delete(id);
      reject(bridgeError('bridge_timeout', 'O computador não respondeu a tempo.'));
    }, 60000);
    calls.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ type: 'call', id, cmd, args })); } catch (_error) {
      clearTimeout(timer);
      calls.delete(id);
      reject(bridgeError('bridge_disconnected', DISCONNECTED));
    }
  });
}

export async function listen(name, handler) {
  if (!events.has(name)) events.set(name, new Set());
  events.get(name).add(handler);
  return () => { events.get(name)?.delete(handler); };
}

// Prazo curto para o socket anterior confirmar o fechamento antes de abrir o
// novo; passado ele, o novo abre mesmo assim.
export const RESUME_CLOSE_GRACE_MS = 1500;

// A borda do computador limita os sockets por aparelho: abrir o novo antes de o
// anterior fechar de verdade podia bater no limite e virar mais um ciclo de
// reconexão. O novo socket espera o onclose do anterior, ou o prazo de segurança.
export function resume() {
  if (!configured) return;
  const previous = socket;
  socket = null;
  clearTimeout(handshakeTimer);
  clearTimeout(retryTimer);
  retryTimer = null;
  clearTimeout(resumeTimer);
  resumeTimer = null;
  publish({ status: 'disconnected', code: null });
  detach();
  if (!previous || previous.readyState === 3) {
    connect();
    return;
  }
  let reopened = false;
  const reopen = () => {
    if (reopened) return;
    reopened = true;
    clearTimeout(resumeTimer);
    resumeTimer = null;
    connect();
  };
  previous.onclose = reopen;
  previous.onerror = reopen;
  resumeTimer = setTimeout(reopen, RESUME_CLOSE_GRACE_MS);
  if (previous.readyState < 2) previous.close();
}

// Face ID, a central de notificacoes e o seletor de apps escondem a pagina
// por instantes com o socket vivo. So uma ausencia longa, em que o iOS pode
// ter suspendido o processo e deixado o socket morto em OPEN, justifica
// religar; religar a toda hora refazia o replay de cada terminal.
export const RESUME_AFTER_HIDDEN_MS = 15000;

if (typeof window !== 'undefined') {
  let hiddenAt = 0;
  window.addEventListener('pageshow', (event) => { if (event.persisted) resume(); else connect(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { hiddenAt = hiddenAt || Date.now(); return; }
    const away = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (!away) { connect(); return; }
    if (away < RESUME_AFTER_HIDDEN_MS && socket?.readyState === 1 && snapshot.status === 'connected') return;
    resume();
  });
}
