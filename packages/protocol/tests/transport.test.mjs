// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { after, mock, test } from 'node:test';

const listeners = new Map();
globalThis.window = { addEventListener(name, handler) { listeners.set(name, handler); } };
globalThis.document = { visibilityState: 'visible', addEventListener(name, handler) { listeners.set(name, handler); } };

class SocketFixture {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    SocketFixture.instances.push(this);
  }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(value) { this.onmessage?.({ data: typeof value === 'object' && !(value instanceof ArrayBuffer) ? JSON.stringify(value) : value }); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code }); }
}

globalThis.WebSocket = SocketFixture;
const remote = await import('../remote.js');
const { createNativeBridge, remoteBridgeUrl } = await import('../native.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function connection(options = {}) {
  remote.configure({ url: 'ws://127.0.0.1:9999/pty', app: '1.4.0', ...options });
  const socket = SocketFixture.instances.at(-1);
  socket.open();
  socket.receive({ type: 'welcome', version: 1, auth: 'device', capabilities: ['pty'], features: ['terminal-mobile-v1'] });
  return socket;
}

after(() => remote.disconnect());

test('remote handshake, results and channel frames follow protocol version one', async () => {
  const socket = connection();
  assert.deepEqual(socket.sent[0], { type: 'hello', version: 1, token: null, client: 'cialai-ios', app: '1.4.0' });
  assert.deepEqual(remote.state(), {
    status: 'connected',
    code: null,
    auth: 'device',
    user: null,
    device: null,
    desktop: null,
    capabilities: ['pty'],
    features: ['terminal-mobile-v1'],
  });

  const received = [];
  const channel = remote.createChannel((message) => received.push(message));
  const request = remote.invoke('pty_attach', { id: 7, onOutput: channel });
  const call = socket.sent.at(-1);
  assert.deepEqual(call.args.onOutput, { __channel__: channel.id });
  socket.receive({ type: 'result', id: call.id, ok: true, value: { id: 7 } });
  assert.deepEqual(await request, { id: 7 });
  socket.receive({ type: 'channel', channel: channel.id, message: { type: 'replay', offset: 4, length: 3 } });
  const binary = new Uint8Array(7);
  new DataView(binary.buffer).setUint32(0, channel.id, false);
  binary.set([97, 98, 99], 4);
  socket.receive(binary.buffer);
  assert.deepEqual(received[0], { type: 'replay', offset: 4, length: 3 });
  assert.deepEqual([...received[1]], [97, 98, 99]);
});

test('calls are rejected on disconnect and never replayed after reconnect', async () => {
  const socket = connection();
  const pending = remote.invoke('pty_list');
  const sentBeforeClose = socket.sent.length;
  socket.close(1006);
  await assert.rejects(pending, { code: 'bridge_disconnected', message: /computador desconectada/ });
  await new Promise((resolve) => setTimeout(resolve, 530));
  const replacement = SocketFixture.instances.at(-1);
  assert.notEqual(replacement, socket);
  replacement.open();
  assert.equal(replacement.sent.length, 1);
  assert.equal(replacement.sent[0].type, 'hello');
  assert.equal(sentBeforeClose, 2);
  remote.disconnect();
});

test('bridge failures carry stable codes for localized interfaces', async () => {
  await assert.rejects(remote.invoke('pty_list'), { code: 'bridge_disconnected' });
  assert.throws(() => remote.configure({ url: 'http://127.0.0.1:9999/pty' }), { code: 'bridge_url_invalid' });

  const socket = connection();
  const failed = remote.invoke('pty_list');
  socket.receive({ type: 'result', id: socket.sent.at(-1).id, ok: false });
  await assert.rejects(failed, { code: 'bridge_failed' });

  const detailed = remote.invoke('pty_kill', { id: 3 });
  socket.receive({ type: 'result', id: socket.sent.at(-1).id, ok: false, error: 'Sessão encerrada' });
  await assert.rejects(detailed, (error) => error.message === 'Sessão encerrada' && error.code === undefined);

  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const slow = remote.invoke('pty_metrics');
    mock.timers.tick(60000);
    await assert.rejects(slow, { code: 'bridge_timeout' });
  } finally {
    mock.timers.reset();
  }
  remote.disconnect();
});

test('revocation and incompatible versions stop reconnecting', async () => {
  for (const [code, status] of [[4401, 'removed'], [4426, 'incompatible']]) {
    const socket = connection();
    const count = SocketFixture.instances.length;
    socket.close(code);
    await new Promise((resolve) => setTimeout(resolve, 530));
    assert.equal(SocketFixture.instances.length, count);
    assert.equal(remote.state().status, status);
    assert.equal(remote.state().code, code);
    remote.disconnect();
  }
});

test('a revoked device stays removed when the page returns to the foreground', async () => {
  const socket = connection();
  const count = SocketFixture.instances.length;
  socket.close(4401);
  listeners.get('pageshow')({ persisted: true });
  listeners.get('pageshow')({ persisted: false });
  document.visibilityState = 'hidden';
  listeners.get('visibilitychange')();
  document.visibilityState = 'visible';
  listeners.get('visibilitychange')();
  remote.connect();
  remote.resume();
  await new Promise((resolve) => setTimeout(resolve, 530));
  assert.equal(SocketFixture.instances.length, count);
  assert.equal(remote.state().status, 'removed');
  assert.equal(remote.state().code, 4401);
  await assert.rejects(remote.invoke('pty_list'), { code: 'bridge_disconnected' });
  remote.disconnect();
});

test('native adapter authorizes remote calls and bypasses authorization inside Tauri', async () => {
  const calls = [];
  let native = false;
  let configured = true;
  const bridge = createNativeBridge({
    isNative: () => native,
    isRemoteConfigured: () => configured,
    authorizeRemote: async (command) => calls.push(['authorize', command]),
    invokeRemote: async (command, args) => { calls.push(['remote', command, args]); return 'remote'; },
    invokeNative: async (command, args) => { calls.push(['native', command, args]); return 'native'; },
    listenRemote: async () => 'remote-listener',
    listenNative: async () => 'native-listener',
    createRemoteChannel: () => 'remote-channel',
    createNativeChannel: async () => 'native-channel',
  });
  assert.equal(bridge.hasBridge(), true);
  assert.equal(await bridge.invoke('pty_list', { page: 1 }), 'remote');
  assert.deepEqual(calls, [['authorize', 'pty_list'], ['remote', 'pty_list', { page: 1 }]]);
  native = true;
  assert.equal(await bridge.invoke('set_preferences', { next: {} }), 'native');
  assert.equal(await bridge.listen('pty://exit', () => {}), 'native-listener');
  assert.equal(await bridge.createChannel(() => {}), 'native-channel');
  configured = false;
  native = false;
  assert.equal(await bridge.invoke('pty_list'), undefined);
  assert.equal(typeof await bridge.listen('pty://exit', () => {}), 'function');
  assert.equal(await bridge.createChannel(() => {}), null);
  await tick();
});

test('bridge URL comes from the served host and only loopback accepts an empty default', () => {
  assert.equal(remoteBridgeUrl({ protocol: 'https:', hostname: 'phone.cialai.test', host: 'phone.cialai.test' }), 'wss://phone.cialai.test/pty');
  assert.equal(remoteBridgeUrl({ protocol: 'http:', hostname: '192.0.2.4', host: '192.0.2.4:8443' }), 'ws://192.0.2.4:8443/pty');
  assert.equal(remoteBridgeUrl({ protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:1420' }), '');
  assert.equal(remoteBridgeUrl({ protocol: 'http:', hostname: 'localhost', host: 'localhost:1420' }, 'ws://127.0.0.1:3720/pty'), 'ws://127.0.0.1:3720/pty');
  assert.throws(() => remoteBridgeUrl({ protocol: 'http:', hostname: 'localhost', host: 'localhost' }, 'https://example.test'), { code: 'bridge_url_invalid', message: /WebSocket/ });
});
