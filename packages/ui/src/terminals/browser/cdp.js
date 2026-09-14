// SPDX-License-Identifier: Apache-2.0
import { translate } from '../../shared/i18n.js';
// Cliente minimo do protocolo do DevTools sobre o WebSocket do navegador:
// uma conexao com o Chromium, multiplexada por sessionId para as abas. Cada
// pedido tem prazo; um evento chega aos ouvintes do metodo e aos gerais.
//
// O webview fala direto com o CDP em 127.0.0.1: os quadros do screencast
// nao passam pelo Rust nem pelo IPC do Tauri.

const DEFAULT_TIMEOUT_MS = 30000;

export class CDPClient {
  constructor() {
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.connected = false;
    this.closedExplicitly = false;
    this.onDisconnected = null;
  }

  connect(wsUrl) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(wsUrl);
      } catch (error) {
        reject(error);
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.connected = true;
        resolve();
      };
      ws.onerror = () => {
        if (!this.connected) reject(new Error(translate('terminal.browser.connectFailed')));
      };
      ws.onclose = () => {
        const was = this.connected;
        this.connected = false;
        this.pending.forEach((entry) => {
          if (entry.timer) clearTimeout(entry.timer);
          entry.reject(new Error(translate('terminal.browser.connectionClosed')));
        });
        this.pending.clear();
        if (!this.closedExplicitly && was) this.onDisconnected?.();
        if (!was) reject(new Error(translate('terminal.browser.connectionRefused')));
      };
      ws.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (_error) { return; }
        if (typeof message.id === 'number') {
          const entry = this.pending.get(message.id);
          if (!entry) return;
          this.pending.delete(message.id);
          if (entry.timer) clearTimeout(entry.timer);
          if (message.error) entry.reject(new Error(message.error.message || translate('terminal.browser.cdpError')));
          else entry.resolve(message.result);
          return;
        }
        if (message.method) {
          const payload = { method: message.method, params: message.params || {}, sessionId: message.sessionId };
          this.dispatch(message.method, payload);
          this.dispatch('*', payload);
        }
      };
    });
  }

  dispatch(method, payload) {
    const set = this.listeners.get(method);
    if (!set) return;
    set.forEach((listener) => {
      try { listener(payload); } catch (error) { console.error('[browser/cdp]', error); }
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(listener);
    return () => { this.listeners.get(method)?.delete(listener); };
  }

  send(method, params = {}, sessionId = undefined, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!this.ws || !this.connected) return Promise.reject(new Error(translate('terminal.browser.cdpDisconnected')));
    const id = this.nextId;
    this.nextId += 1;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(translate('terminal.browser.cdpTimeout', { timeout: timeoutMs, method })));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
  }

  close() {
    this.closedExplicitly = true;
    try { this.ws?.close(); } catch (_error) { /* ja fechado */ }
    this.ws = null;
    this.connected = false;
  }

  isConnected() {
    return this.connected;
  }
}
