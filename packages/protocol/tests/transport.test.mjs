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
// Dedupe real da tela do terminal, para o replay ser conferido como a página o aplica.
const { beginReplay, consumeOutput } = await import('../../ui/src/terminals/replay.js');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const WELCOME = { type: 'welcome', version: 1, auth: 'device', capabilities: ['pty'], features: ['terminal-mobile-v1'] };

function connection(options = {}) {
  remote.configure({ url: 'ws://127.0.0.1:9999/pty', app: '1.4.0', ...options });
  const socket = SocketFixture.instances.at(-1);
  socket.open();
  socket.receive(WELCOME);
  return socket;
}

// Espera a religação automática depois da queda e abre o socket do caminho novo.
async function nextSocket(previous) {
  await new Promise((resolve) => setTimeout(resolve, 530));
  const socket = SocketFixture.instances.at(-1);
  assert.notEqual(socket, previous);
  socket.open();
  return socket;
}

function channelFrame(channel, bytes) {
  const frame = new Uint8Array(4 + bytes.byteLength);
  new DataView(frame.buffer).setUint32(0, channel, false);
  frame.set(bytes, 4);
  return frame.buffer;
}

const sentCalls = (sockets, cmd) => sockets.flatMap((socket) => socket.sent).filter((message) => message.type === 'call' && message.cmd === cmd);

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

// Troca de caminho: o proxy do celular fecha o upstream antigo e a página vê o
// WebSocket cair com 1006. A chamada em voo pode ter chegado ou não ao
// computador; o cliente nunca a repete, então ela executa uma vez ou nenhuma.
test('a path switch during pty_write rejects the write and never sends it again', async () => {
  const socket = connection();
  const write = remote.invoke('pty_write', { id: 3, data: 'ls\n' });
  const call = socket.sent.at(-1);
  assert.equal(call.cmd, 'pty_write');
  const failed = assert.rejects(write, { code: 'bridge_disconnected', message: /computador desconectada/ });
  socket.close(1006);
  await failed;
  assert.equal(remote.state().status, 'disconnected');
  assert.equal(remote.state().code, 1006);

  const replacement = await nextSocket(socket);
  // Digitação enquanto o caminho novo não recebeu welcome falha na hora, sem fila.
  await assert.rejects(remote.invoke('pty_write', { id: 3, data: 'ls\n' }), { code: 'bridge_disconnected' });
  replacement.receive(WELCOME);
  assert.deepEqual(replacement.sent.map((message) => message.type), ['hello']);

  const next = remote.invoke('pty_write', { id: 3, data: 'pwd\n' });
  const nextCall = replacement.sent.at(-1);
  assert.ok(nextCall.id > call.id, 'ids de chamada não voltam a ser usados depois de religar');
  let settled = false;
  next.then(() => { settled = true; }, () => { settled = true; });
  // Resposta atrasada da chamada antiga, pelo socket antigo ou pelo novo, não resolve nada.
  socket.receive({ type: 'result', id: call.id, ok: true, value: null });
  replacement.receive({ type: 'result', id: call.id, ok: true, value: null });
  await tick();
  assert.equal(settled, false);
  replacement.receive({ type: 'result', id: nextCall.id, ok: true, value: null });
  assert.equal(await next, null);

  assert.deepEqual(sentCalls([socket, replacement], 'pty_write').map((message) => message.args.data), ['ls\n', 'pwd\n']);
  remote.disconnect();
});

test('a path switch during pty_spawn rejects the spawn, detaches its channel and never spawns again', async () => {
  const socket = connection();
  const received = [];
  const channel = remote.createChannel((message) => received.push(message));
  const spawn = remote.invoke('pty_spawn', { cwd: '/tmp/projeto', cols: 80, rows: 24, tag: 'sessao-1', onOutput: channel });
  const call = socket.sent.at(-1);
  assert.equal(call.cmd, 'pty_spawn');
  assert.deepEqual(call.args.onOutput, { __channel__: channel.id });
  const failed = assert.rejects(spawn, { code: 'bridge_disconnected' });
  socket.close(1006);
  await failed;
  assert.deepEqual(received, [{ type: 'detached', reason: 'socket' }]);

  const replacement = await nextSocket(socket);
  replacement.receive(WELCOME);
  assert.deepEqual(replacement.sent.map((message) => message.type), ['hello']);
  // O terminal pode ter nascido no computador; o resultado e a saída dele
  // chegando atrasados não ressuscitam a chamada nem o canal antigo.
  socket.receive({ type: 'result', id: call.id, ok: true, value: { id: 9 } });
  replacement.receive({ type: 'result', id: call.id, ok: true, value: { id: 9 } });
  replacement.receive({ type: 'channel', channel: channel.id, message: { type: 'replay', offset: 0, length: 2 } });
  replacement.receive(channelFrame(channel.id, new Uint8Array([104, 105])));
  await tick();
  assert.deepEqual(received, [{ type: 'detached', reason: 'socket' }]);
  assert.equal(sentCalls([socket, replacement], 'pty_spawn').length, 1);
  remote.disconnect();
});

test('pty_attach after a path switch resumes at the replay offset without duplicating screen bytes', async () => {
  // Offsets contam bytes; "ç" e "ã" ocupam dois bytes cada.
  const output = new TextEncoder().encode('$ ls\r\nREADME.md\r\n$ make\r\ncompilação\r\npronto\r\n$ ');
  const screen = { outputOffset: 0, receivedOffset: 0, bytes: [] };
  const show = (message) => {
    if (message instanceof Uint8Array) screen.bytes.push(...consumeOutput(screen, message));
    else if (message?.type === 'replay') beginReplay(screen, message);
  };

  const socket = connection();
  const first = remote.createChannel(show);
  const attach = remote.invoke('pty_attach', { id: 7, onOutput: first });
  socket.receive({ type: 'channel', channel: first.id, message: { type: 'replay', offset: 0, length: 10 } });
  socket.receive(channelFrame(first.id, output.subarray(0, 10)));
  socket.receive({ type: 'result', id: socket.sent.at(-1).id, ok: true, value: { id: 7 } });
  await attach;
  // A saída ao vivo para no meio do "ç" quando o caminho cai.
  socket.receive(channelFrame(first.id, output.subarray(10, 33)));
  socket.close(1006);

  const replacement = await nextSocket(socket);
  replacement.receive(WELCOME);
  const second = remote.createChannel(show);
  const reattach = remote.invoke('pty_attach', { id: 7, onOutput: second });
  const call = replacement.sent.at(-1);
  assert.deepEqual(replacement.sent.map((message) => message.cmd ?? message.type), ['hello', 'pty_attach']);
  assert.deepEqual(call.args, { id: 7, onOutput: { __channel__: second.id } });
  // O anel já descartou os 4 primeiros bytes; o replay cobre 4..40, em dois quadros,
  // incluindo o que o computador produziu enquanto o celular estava fora.
  replacement.receive({ type: 'channel', channel: second.id, message: { type: 'replay', offset: 4, length: 36 } });
  replacement.receive(channelFrame(second.id, output.subarray(4, 20)));
  // Quadros atrasados do canal substituído, no meio do replay, nunca chegam à tela.
  socket.receive(channelFrame(first.id, output.subarray(33, 40)));
  replacement.receive(channelFrame(first.id, output.subarray(33, 40)));
  replacement.receive(channelFrame(second.id, output.subarray(20, 40)));
  replacement.receive({ type: 'result', id: call.id, ok: true, value: { id: 7 } });
  await reattach;
  replacement.receive(channelFrame(second.id, output.subarray(40)));

  assert.deepEqual(Uint8Array.from(screen.bytes), output);
  assert.equal(new TextDecoder().decode(Uint8Array.from(screen.bytes)), new TextDecoder().decode(output));
  assert.equal(sentCalls([socket, replacement], 'pty_attach').length, 2);
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
