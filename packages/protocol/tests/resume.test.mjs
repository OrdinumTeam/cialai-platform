// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

const listeners = new Map();
globalThis.window = { addEventListener(name, handler) { listeners.set(name, handler); } };
globalThis.document = { visibilityState: 'visible', addEventListener(name, handler) { listeners.set(name, handler); } };

// Socket falso cujo fechamento leva tempo: close() só entra em CLOSING e o
// onclose chega quando o teste chama finishClose(), como um socket morto pela
// suspensão do iOS que o WebKit demora a confirmar.
class SlowCloseSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.closeCalls = 0;
    SlowCloseSocket.instances.push(this);
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
  close() { this.closeCalls += 1; if (this.readyState < 2) this.readyState = 2; }
  finishClose(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
}

globalThis.WebSocket = SlowCloseSocket;
const remote = await import('../remote.js');
const WELCOME = { type: 'welcome', version: 1, auth: 'device', capabilities: ['pty'], features: ['terminal-mobile-v1'] };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connection() {
  remote.configure({ url: 'ws://127.0.0.1:9999/pty', app: '1.4.0' });
  const socket = SlowCloseSocket.instances.at(-1);
  socket.open();
  socket.receive(WELCOME);
  return socket;
}

beforeEach(() => { remote.disconnect(); SlowCloseSocket.instances.length = 0; });
after(() => remote.disconnect());

test('resume waits for the previous socket to close before opening the next one', async () => {
  const first = connection();
  assert.equal(remote.state().status, 'connected');
  remote.resume();
  assert.equal(first.closeCalls, 1);
  assert.equal(first.readyState, 2);
  assert.equal(remote.state().status, 'disconnected');
  await wait(20);
  assert.equal(SlowCloseSocket.instances.length, 1, 'nenhum socket novo enquanto o anterior ainda fecha');
  first.finishClose(1006);
  assert.equal(SlowCloseSocket.instances.length, 2, 'o onclose do anterior abre o novo');
  const second = SlowCloseSocket.instances.at(-1);
  second.open();
  second.receive(WELCOME);
  assert.equal(remote.state().status, 'connected');
  assert.deepEqual(second.sent.map((message) => message.type), ['hello']);
  // O onclose antigo, se chegar de novo, não abre um terceiro socket nem derruba o segundo.
  first.finishClose(1006);
  assert.equal(SlowCloseSocket.instances.length, 2);
  assert.equal(remote.state().status, 'connected');
});

test('resume opens the next socket after the safety grace when the previous never confirms', async () => {
  const first = connection();
  remote.resume();
  await wait(remote.RESUME_CLOSE_GRACE_MS - 200);
  assert.equal(SlowCloseSocket.instances.length, 1);
  await wait(400);
  assert.equal(SlowCloseSocket.instances.length, 2, 'o prazo de seguranca abre o novo socket');
  assert.equal(first.readyState, 2);
  const second = SlowCloseSocket.instances.at(-1);
  second.open();
  second.receive(WELCOME);
  assert.equal(remote.state().status, 'connected');
  // A confirmação atrasada do socket antigo não muda nada.
  first.finishClose(1006);
  assert.equal(SlowCloseSocket.instances.length, 2);
  assert.equal(remote.state().status, 'connected');
});

test('resume connects right away when there is no live socket', async () => {
  const first = connection();
  first.finishClose(1006);
  assert.equal(remote.state().status, 'disconnected');
  const count = SlowCloseSocket.instances.length;
  remote.resume();
  assert.equal(SlowCloseSocket.instances.length, count + 1);
  const second = SlowCloseSocket.instances.at(-1);
  second.open();
  second.receive(WELCOME);
  assert.equal(remote.state().status, 'connected');
});

test('a resume followed by disconnect never opens a socket', async () => {
  connection();
  remote.resume();
  remote.disconnect();
  await wait(remote.RESUME_CLOSE_GRACE_MS + 200);
  assert.equal(SlowCloseSocket.instances.length, 1);
  assert.equal(remote.state().status, 'disabled');
});

test('calls in flight are rejected at resume and never replayed on the next socket', async () => {
  const first = connection();
  const pending = remote.invoke('pty_list');
  remote.resume();
  await assert.rejects(pending, { code: 'bridge_disconnected' });
  first.finishClose(1006);
  const second = SlowCloseSocket.instances.at(-1);
  second.open();
  assert.deepEqual(second.sent.map((message) => message.type), ['hello']);
});
