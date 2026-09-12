// SPDX-License-Identifier: Apache-2.0
// Remote counterpart of Tauri IPC. A disconnected call is never replayed.
export const DISCONNECTED = 'Ponte com o Mac desconectada.';
let configured;
let socket;
let retryTimer;
let handshakeTimer;
let retryDelay = 500;
let nextCall = 1;
let nextChannel = 1;
let snapshot = { status: 'disabled', capabilities: [], features: [] };
const observers = new Set();
const calls = new Map();
const channels = new Map();
const events = new Map();
export const state = () => snapshot;
export const isConfigured = () => Boolean(configured);
export const subscribeState = (listener) => { observers.add(listener); return () => observers.delete(listener); };
function publish(value) { snapshot = { ...snapshot, ...value }; observers.forEach((listener) => listener(snapshot)); }

export class RemoteChannel {
  constructor(onmessage) { this.id = nextChannel++; this.onmessage = onmessage; channels.set(this.id, this); }
  toJSON() { return { __channel__: this.id }; }
  dispose() { channels.delete(this.id); }
}
export const createChannel = (onmessage) => new RemoteChannel(onmessage);

function detach() {
  const active = [...channels.values()];
  channels.clear();
  active.forEach((channel) => channel.onmessage?.({ type: 'detached', reason: 'socket' }));
  calls.forEach(({ reject, timer }) => { clearTimeout(timer); reject(new Error(DISCONNECTED)); });
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
  try { message = JSON.parse(data); } catch (_) { return; }
  if (message.type === 'welcome') {
    if (message.version !== 1) { socket?.close(4426); return; }
    clearTimeout(handshakeTimer);
    retryDelay = 500;
    publish({ status: 'connected', capabilities: message.capabilities || [], features: message.features || [] });
  } else if (message.type === 'result') {
    const call = calls.get(message.id);
    if (!call) return;
    calls.delete(message.id); clearTimeout(call.timer);
    if (message.ok) call.resolve(message.value); else call.reject(new Error(message.error || 'Falha na ponte com o Mac.'));
  } else if (message.type === 'event') {
    events.get(message.name)?.forEach((handler) => handler(message.payload, { event: message.name, payload: message.payload }));
  } else if (message.type === 'channel') {
    const channel = channels.get(message.channel);
    if (['exit', 'detached'].includes(message.message?.type)) channels.delete(message.channel);
    channel?.onmessage?.(message.message);
  }
}

function scheduleReconnect() {
  if (!configured || retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, retryDelay);
  retryDelay = Math.min(8000, retryDelay * 2);
}

export function connect() {
  if (!configured || socket && socket.readyState < 2) return;
  clearTimeout(retryTimer); retryTimer = null;
  publish({ status: 'connecting' });
  let ws;
  try { ws = new WebSocket(configured.url); } catch (_) { publish({ status: 'disconnected' }); scheduleReconnect(); return; }
  socket = ws;
  ws.binaryType = 'arraybuffer';
  // Covers both an unreachable TCP endpoint and a missing welcome frame.
  handshakeTimer = setTimeout(() => ws.close(), 6000);
  ws.onopen = () => {
    if (socket !== ws) return;
    ws.send(JSON.stringify({ type: 'hello', version: 1, token: configured.token || null, client: 'ios' }));
  };
  ws.onmessage = (event) => { if (socket === ws) receive(event.data); };
  ws.onerror = () => ws.close();
  ws.onclose = (event) => {
    if (socket !== ws) return;
    socket = null; clearTimeout(handshakeTimer);
    publish({ status: 'disconnected', code: event.code });
    detach();
    if (![4401, 4426].includes(event.code)) scheduleReconnect();
  };
}

export function configure(options) {
  disconnect();
  if (!options?.url) return;
  const url = new URL(options.url);
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Endereço da ponte inválido.');
  configured = { ...options, url: url.href };
  connect();
}

export function disconnect() {
  configured = null;
  clearTimeout(retryTimer); retryTimer = null;
  clearTimeout(handshakeTimer);
  const previous = socket; socket = null; previous?.close();
  publish({ status: 'disabled', capabilities: [], features: [] });
  detach();
}

export function invoke(cmd, args = {}) {
  if (snapshot.status !== 'connected' || socket?.readyState !== 1) return Promise.reject(new Error(DISCONNECTED));
  const id = nextCall++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { calls.delete(id); reject(new Error('O Mac não respondeu a tempo.')); }, 60000);
    calls.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ type: 'call', id, cmd, args })); }
    catch (_) { clearTimeout(timer); calls.delete(id); reject(new Error(DISCONNECTED)); }
  });
}

export async function listen(name, handler) {
  if (!events.has(name)) events.set(name, new Set());
  events.get(name).add(handler);
  return () => { events.get(name)?.delete(handler); };
}

export function resume() {
  if (!configured) return;
  // iOS can preserve readyState OPEN even after suspending the connection.
  const previous = socket;
  socket = null;
  clearTimeout(handshakeTimer);
  clearTimeout(retryTimer); retryTimer = null;
  previous?.close();
  publish({ status: 'disconnected' });
  detach();
  connect();
}

if (typeof window !== 'undefined') {
  let hidden = false;
  window.addEventListener('pageshow', (event) => { if (event.persisted) resume(); else connect(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hidden = true;
    else if (hidden) { hidden = false; resume(); }
    else connect();
  });
}
