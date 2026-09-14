// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const vm = require('node:vm');
const { build } = require('esbuild');

async function load(entry, globals) {
  const input = entry.includes('\n') || entry.startsWith('export')
    ? { stdin: { contents: entry, resolveDir: process.cwd(), loader: 'js' } }
    : { entryPoints: [entry] };
  const result = await build({
    ...input,
    bundle: true,
    write: false,
    outfile: 'bundle.js',
    format: 'cjs',
    external: ['react', '@tauri-apps/*'],
  });
  const source = result.outputFiles.find((file) => file.path.endsWith('.js')).text;
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    require: createRequire(__filename),
    document: { documentElement: { dataset: {}, lang: '' }, visibilityState: 'visible', addEventListener() {} },
    addEventListener() {},
    URL,
    setTimeout: () => 0,
    clearTimeout() {},
    ...globals,
  });
  context.window = context;
  vm.runInContext(source, context);
  return context.module.exports;
}

test('bridge failures with stable codes are shown in the active language', async () => {
  const { localizeError } = await load('src/lib/errors.js', { localStorage: { getItem: () => 'es', setItem() {} } });
  const timeout = localizeError(Object.assign(new Error('O computador não respondeu a tempo.'), { code: 'bridge_timeout' }));
  assert.equal(timeout.message, 'La computadora no respondió a tiempo.');
  assert.equal(timeout.code, 'bridge_timeout');
  assert.equal(localizeError(Object.assign(new Error('x'), { code: 'MOBILE_READ_ONLY' })).message, 'En el teléfono, esta área es de solo lectura. Haz los cambios en la computadora.');
  assert.equal(localizeError(Object.assign(new Error('x'), { code: 'session_locked' })).message, 'La sesión se bloqueó. Vuelve a autorizar.');
  const unknown = Object.assign(new Error('Pasta não encontrada'), { code: 'not_found' });
  assert.equal(localizeError(unknown), unknown);
  assert.equal(localizeError('texto cru'), 'texto cru');
});

test('remote calls reject with the translated bridge message', async () => {
  class PendingSocket { constructor() { this.readyState = 0; } close() {} send() {} }
  const { native, remote } = await load("export * as native from './src/lib/native.js';\nexport * as remote from './src/lib/remote.js';", {
    localStorage: { getItem: () => 'en', setItem() {} },
    WebSocket: PendingSocket,
  });
  remote.configure({ url: 'ws://127.0.0.1:9/pty' });
  await assert.rejects(native.invoke('pty_list'), { code: 'bridge_disconnected', message: 'Disconnected from the computer.' });
  remote.disconnect();
});

test('authorization reasons are translated before the browser or the phone prompt', async () => {
  const asked = [];
  let answer = true;
  const browser = await load('src/lib/shell.js', {
    localStorage: { getItem: () => 'es', setItem() {} },
    confirm: (message) => { asked.push(message); return answer; },
  });
  await browser.requireSensitive('action', 'terminal_input');
  assert.deepEqual(asked, ['Autorizar escritura en este terminal']);
  answer = false;
  await assert.rejects(browser.requireSensitive('session', 'computer_change'), { message: 'Acción cancelada. Autoriza en el dispositivo para continuar.' });
  assert.equal(asked.at(-1), 'Autorizar cambios en la computadora');
  answer = true;
  await browser.requireSensitive('action', 'Motivo livre');
  assert.equal(asked.at(-1), 'Motivo livre');

  const posted = [];
  const phone = await load('src/lib/shell.js', {
    __CIALAI_SHELL__: { locale: 'en' },
    ReactNativeWebView: { postMessage: (raw) => posted.push(JSON.parse(raw)) },
  });
  const request = phone.requireSensitive('action', 'terminal_close');
  assert.equal(posted[0].reason, 'End this terminal');
  phone.receiveShellMessage({ type: 'auth', id: posted[0].id, ok: true });
  await request;
});
