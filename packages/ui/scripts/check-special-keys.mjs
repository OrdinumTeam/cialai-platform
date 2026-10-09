// SPDX-License-Identifier: Apache-2.0
// Teclado especial do celular com o runtime real e o @xterm/xterm instalado,
// sem PTY nem rede. Confere o que chega ao `pty_write` para as teclas, o modo
// de cursor de aplicação, a combinação com o teclado nativo e a paridade do
// codificador com o `evaluateKeyboardEvent` do próprio xterm.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const require_ = createRequire(import.meta.url);

const mocks = {
  // O xterm de verdade, com duas peças que só existem num DOM completo
  // substituídas: `open` não monta nada e a textarea que o `paste` limpa vira
  // um objeto inerte. Tudo o que o teste afirma, envelope da colagem entre
  // colchetes e conversão de quebras, continua sendo do xterm.
  renderer: `import { Terminal as RealTerminal } from '@xterm/xterm';
    export class Terminal extends RealTerminal {
      constructor(options) {
        super(options);
        this._core.textarea = { value: '', addEventListener(){}, removeEventListener(){}, focus(){}, blur(){}, setAttribute(){} };
        this._mounted = null;
      }
      get element() { return this._mounted; }
      open(parent) { this._mounted = { isConnected: true, parentElement: parent, addEventListener(){}, removeEventListener(){} }; }
      focus() {}
    }`,
  addons: 'export class FitAddon {activate(term){this.term=term;} dispose(){} fit(){} proposeDimensions(){return {cols:80,rows:24};}} export class SearchAddon {activate(){} dispose(){}} export class WebglAddon {activate(){} onContextLoss(){} dispose(){}} export class WebLinksAddon {constructor(handler){this.handler=handler;} activate(){} dispose(){}}',
  style: '',
  native: `export const isTauri = () => false; export const hasBridge = () => true;
    export const NATIVE_ONLY_MESSAGE = 'macOS'; export const invoke = (cmd,args) => fixture.invoke(cmd,args);
    export const listen = async () => () => {}; export const createChannel = async (onmessage) => ({onmessage});
    export const chooseDirectory = async () => null;`,
  downloads: 'export const openExternal = async () => {};',
  theme: 'export const buildTheme = () => ({}); export const terminalFont = () => "monospace"; export const watchTheme = () => () => {};',
  files: 'export const baseName = p => String(p).split("/").at(-1); export const fs = {}; export const isInside=()=>false; export const shellQuote=p=>p;',
  layout: 'export const getLayout = () => ({fontSize:13}); export const subscribeLayout = () => () => {};',
  remote: 'export const state = () => fixture.remoteState; export const subscribeState = handler => {fixture.remoteListener=handler; return () => {};};',
  shell: 'export const isPhone = () => fixture.phone; export const onShellLock = () => () => {};',
};

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/terminals/runtime.js', import.meta.url))],
  bundle: true, write: false, format: 'iife', globalName: 'runtime',
  external: ['@xterm/xterm'],
  plugins: [{ name: 'special-keys-boundaries', setup(api) {
    api.onResolve({ filter: /./ }, (args) => {
      const { path } = args;
      // Só a fronteira fala com o pacote de verdade; o runtime passa por ela.
      if (path === '@xterm/xterm') {
        return args.namespace === 'fixture' ? { external: true } : { path: 'renderer', namespace: 'fixture' };
      }
      if (path.endsWith('.css')) return { path: 'style', namespace: 'fixture' };
      if (path.startsWith('@xterm/')) return { path: 'addons', namespace: 'fixture' };
      const key = path.split('/').at(-1)?.replace(/\.js$/, '');
      if (mocks[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
  } }],
});

function scenario({ phone = false, owned = true } = {}) {
  const alive = [{ id: 1, pid: 1001, tag: 'sessao', cwd: '/fixture', cols: 80, rows: 24, view: { id: 1, owner: phone ? 'remote' : 'local', leaseId: 1, revision: 1, cols: 80, rows: 24 } }];
  const fixture = {
    phone, owned, written: [], remoteState: { status: 'connected', features: ['terminal-mobile-v1'] },
    async invoke(cmd, args) {
      if (cmd === 'pty_list') return alive.map((item) => ({ ...item }));
      if (cmd === 'pty_attach') return { ...alive[0] };
      if (cmd === 'pty_write') { this.written.push(args.data); return; }
      if (cmd === 'pty_metrics' || cmd === 'ai_usage') return [];
      if (cmd === 'pty_view_claim' || cmd === 'pty_view_renew') {
        if (!this.owned) throw new Error('sem controle');
        alive[0].view = { id: 1, owner: 'remote', leaseId: 1, revision: (alive[0].view.revision || 0) + 1, cols: args.cols, rows: args.rows };
        return { ...alive[0].view };
      }
      if (cmd === 'pty_view_release' || cmd === 'pty_ack' || cmd === 'pty_resize') return;
      if (cmd === 'pty_saved') return null;
      if (cmd === 'pty_prune' || cmd === 'pty_forget' || cmd === 'pty_presentation') return;
      throw new Error(`chamada inesperada: ${cmd}`);
    },
  };
  const storageKey = phone ? 'cialai_terminals_phone' : 'cialai_terminals';
  const storage = new Map([[storageKey, JSON.stringify({ version: 2, sessions: [], selectedId: null, recent: [] })]]);
  // Relógio próprio: o runtime reagenda o laço de métricas sozinho, e com
  // temporizadores de verdade o processo do teste nunca terminaria.
  let clock = 0;
  let timerId = 0;
  const timers = new Map();
  const schedule = (fn, ms, repeat = 0) => { const id = (timerId += 1); timers.set(id, { fn, at: clock + ms, repeat }); return id; };
  const context = vm.createContext({
    fixture, console, URLSearchParams, Uint8Array, ArrayBuffer, require: require_,
    setTimeout: (fn, ms = 0) => schedule(fn, ms), clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: (id) => timers.delete(id),
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    window: {
      location: { search: '' }, addEventListener() {}, devicePixelRatio: 1,
      matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
      setTimeout: (fn, ms = 0) => schedule(fn, ms), clearTimeout: (id) => timers.delete(id),
      setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: (id) => timers.delete(id),
    },
    document: { hasFocus: () => true, visibilityState: 'visible', addEventListener() {}, body: { appendChild() {} }, createElement: () => ({ isConnected: true, setAttribute() {}, appendChild() {} }) },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  async function advance(ms) {
    const until = clock + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, entry]) => entry.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, entry] = due;
      clock = entry.at;
      timers.delete(id);
      if (entry.repeat) timers.set(id, { ...entry, at: clock + entry.repeat });
      await entry.fn();
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    }
    clock = until;
  }
  return { runtime: context.runtime, fixture, advance };
}

const settle = async () => { for (let i = 0; i < 40; i += 1) await Promise.resolve(); };
const host = () => ({ getBoundingClientRect: () => ({ width: 350, height: 480, bottom: 480 }), appendChild(child) { child.parentElement = this; } });

// Escrever num terminal exige que ele esteja montado e que este cliente tenha
// a concessão da largura, a mesma regra do estúdio e do celular.
async function ready(options) {
  const s = scenario(options);
  await s.runtime.hydrate();
  await settle();
  const session = s.runtime.getSession('sessao');
  assert.ok(session, 'a sessão viva do computador entra na lista');
  s.runtime.selectSession(session.id);
  s.runtime.hostTerminal(session.id, host());
  await settle();
  return { ...s, session };
}

const encoderModule = await import('../src/terminals/key-encoder.js');
const controllerModule = await import('../src/terminals/special-keys.js');

// O codificador do xterm, compilado do fonte que o pacote publica.
const xtermSource = fileURLToPath(new URL('../../../node_modules/@xterm/xterm/src/', import.meta.url));
const keyboardBundle = await build({
  entryPoints: [`${xtermSource}common/input/Keyboard.ts`],
  bundle: true, write: false, format: 'esm', platform: 'neutral',
  plugins: [{ name: 'xterm-src', setup(api) {
    api.onResolve({ filter: /^common\// }, (args) => ({ path: `${xtermSource}${args.path}.ts` }));
  } }],
});
const { evaluateKeyboardEvent } = await import(`data:text/javascript;base64,${Buffer.from(keyboardBundle.outputFiles[0].text).toString('base64')}`);

const KEY_CODES = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46 };
for (let n = 1; n <= 12; n += 1) KEY_CODES[`F${n}`] = 111 + n;
const SYMBOL_CODES = { ';': 186, '=': 187, ',': 188, '-': 189, '.': 190, '/': 191, '`': 192, '[': 219, '\\': 220, ']': 221, "'": 222 };
const SHIFTED = { 1: '!', 2: '@', 3: '#', 4: '$', 5: '%', 6: '^', 7: '&', 8: '*', 9: '(', 0: ')', ';': ':', '=': '+', ',': '<', '-': '_', '.': '>', '/': '?', '`': '~', '[': '{', '\\': '|', ']': '}', "'": '"' };

function keyEvent(key, mods) {
  let keyCode = KEY_CODES[key];
  let value = key;
  if (keyCode === undefined) {
    if (/^[a-z]$/.test(key)) { keyCode = key.toUpperCase().charCodeAt(0); value = mods.shift ? key.toUpperCase() : key; }
    else if (/^[0-9]$/.test(key)) { keyCode = 48 + Number(key); value = mods.shift ? SHIFTED[key] : key; }
    else { keyCode = SYMBOL_CODES[key]; value = mods.shift ? SHIFTED[key] : key; }
  }
  return { keyCode, key: value, code: '', shiftKey: Boolean(mods.shift), altKey: Boolean(mods.alt), ctrlKey: Boolean(mods.ctrl), metaKey: Boolean(mods.meta), type: 'keydown' };
}

const combos = [];
for (let mask = 0; mask < 16; mask += 1) combos.push({ shift: Boolean(mask & 1), alt: Boolean(mask & 2), ctrl: Boolean(mask & 4), meta: Boolean(mask & 8) });

// Onde a tabela daqui diverge do xterm de propósito, documentado em
// `key-encoder.js`: o xterm deixa a tecla para o navegador (`undefined`), Meta
// sem CSI é tratado como Alt, Insert e Page Up/Down levam o modificador, e
// Ctrl Alt com dígito ou símbolo mantém o Ctrl, como o xterm do X11, onde o
// xterm.js o descarta.
function intentional(key, mods, expected) {
  if (expected === undefined) return true;
  if (mods.ctrl && mods.alt && !/^[a-z]$/.test(key) && key.length === 1) return true;
  if (mods.meta && !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Delete'].includes(key) && !/^F\d+$/.test(key)) return true;
  if (['Insert', 'PageUp', 'PageDown'].includes(key) && (mods.alt || mods.meta || mods.ctrl || mods.shift)) return true;
  return false;
}

test('o codificador bate com o evaluateKeyboardEvent do xterm', () => {
  const keys = [...Object.keys(KEY_CODES), ...'abcdefghijklmnopqrstuvwxyz', ...'0123456789', ...Object.keys(SYMBOL_CODES)];
  let compared = 0;
  for (const applicationCursor of [false, true]) {
    for (const key of keys) {
      for (const mods of combos) {
        const expected = evaluateKeyboardEvent(keyEvent(key, mods), applicationCursor, false, false).key;
        if (intentional(key, mods, expected)) continue;
        assert.equal(encoderModule.encodeKey(key, mods, { applicationCursor }), expected, `${JSON.stringify(mods)} ${JSON.stringify(key)} DECCKM=${applicationCursor}`);
        compared += 1;
      }
    }
  }
  assert.ok(compared > 800, `combinações comparadas: ${compared}`);
});

function controllerFor(runtime, session) {
  return controllerModule.createKeyController({
    send: (data) => runtime.sendKey(session.id, data),
    applicationCursor: () => runtime.applicationCursorKeys(session.id),
  });
}
const flush = (term) => new Promise((resolve) => { term.write('', resolve); });

test('Ctrl C, Ctrl D, Ctrl L, Tab, Esc, Home, End, Page Up e Page Down chegam ao PTY', async () => {
  const { runtime, fixture, session } = await ready();
  const keys = controllerFor(runtime, session);
  await keys.click('c', { ctrl: true });
  await keys.click('d', { ctrl: true });
  await keys.click('l', { ctrl: true });
  await keys.click('Tab');
  await keys.click('Tab', { shift: true });
  await keys.click('Escape');
  for (const key of ['Home', 'End', 'PageUp', 'PageDown', 'ArrowUp']) await keys.click(key);
  await settle();
  assert.deepEqual([...fixture.written], ['\x03', '\x04', '\x0c', '\t', '\x1b[Z', '\x1b', '\x1b[H', '\x1b[F', '\x1b[5~', '\x1b[6~', '\x1b[A']);
});

test('com o modo de cursor de aplicação as setas saem em SS3', async () => {
  const { runtime, fixture, session } = await ready();
  const keys = controllerFor(runtime, session);
  session.term.write('\x1b[?1h');
  await flush(session.term);
  assert.equal(runtime.applicationCursorKeys(session.id), true);
  await keys.click('ArrowUp');
  await keys.click('ArrowLeft');
  await keys.click('Home');
  session.term.write('\x1b[?1l');
  await flush(session.term);
  await keys.click('ArrowUp');
  await settle();
  assert.deepEqual([...fixture.written], ['\x1bOA', '\x1bOD', '\x1bOH', '\x1b[A']);
});

test('modificador armado combina com o próximo caractere do teclado nativo', async () => {
  const { runtime, fixture, session } = await ready();
  const keys = controllerFor(runtime, session);
  runtime.setInputTransform(session.id, keys.transformTyped);
  keys.toggleModifier('ctrl');
  session.term.input('c', true);
  session.term.input('c', true);
  keys.toggleModifier('alt');
  session.term.input('b', true);
  keys.toggleModifier('ctrl');
  keys.toggleModifier('shift');
  session.term.input('p', true);
  await settle();
  assert.deepEqual([...fixture.written], ['\x03', 'c', '\x1bb', '\x10']);
  assert.equal(keys.getState().any, false);
});

test('colagem e texto longo passam intactos com Ctrl armado', async () => {
  const { runtime, fixture, session } = await ready();
  const keys = controllerFor(runtime, session);
  runtime.setInputTransform(session.id, keys.transformTyped);
  keys.toggleModifier('ctrl');
  assert.equal(runtime.pasteText(session.id, 'c'), true);
  assert.equal(await runtime.submitText(session.id, 'x'), true);
  session.term.input('palavra', true);
  await settle();
  assert.deepEqual([...fixture.written], ['c', 'x', 'palavra']);
  assert.equal(keys.getState().armed.ctrl, true, 'Ctrl continua esperando uma tecla');
});

test('desligar o tradutor devolve a digitação normal', async () => {
  const { runtime, fixture, session } = await ready();
  const keys = controllerFor(runtime, session);
  const unbind = runtime.setInputTransform(session.id, keys.transformTyped);
  keys.toggleModifier('ctrl');
  unbind();
  session.term.input('c', true);
  await settle();
  assert.deepEqual([...fixture.written], ['c']);
});

test('sem controle do terminal, em replay ou encerrado, a tecla não sai', async () => {
  const phone = await ready({ phone: true, owned: false });
  assert.equal(await controllerFor(phone.runtime, phone.session).click('c', { ctrl: true }), false);
  await settle();
  assert.deepEqual([...phone.fixture.written], []);
  const { runtime, fixture, session } = await ready();
  session.replaying = true;
  assert.equal(await controllerFor(runtime, session).click('Tab'), false);
  session.replaying = false;
  session.status = 'exited';
  assert.equal(await controllerFor(runtime, session).click('Tab'), false);
  await settle();
  assert.deepEqual([...fixture.written], []);
});

test('saída contínua: rolar para cima solta do fim, saída nova avisa e voltar ao fim reencaixa', async () => {
  const { runtime, session } = await ready();
  const lines = Array.from({ length: 200 }, (_, index) => `linha ${index}`).join('\r\n');
  session.term.write(`${lines}\r\n`);
  await flush(session.term);
  const events = [];
  const stop = runtime.watchTail(session.id, (event) => events.push({ ...event }));
  assert.deepEqual(events, [], 'no fim da saída não há aviso');
  session.term.write('mais uma\r\n');
  await flush(session.term);
  assert.deepEqual(events, [], 'saída nova com a tela no fim segue o fim, sem aviso');
  session.term.scrollLines(-20);
  assert.deepEqual(events.at(-1), { detached: true, fresh: false });
  session.term.write('saída nova\r\n');
  await flush(session.term);
  assert.deepEqual(events.at(-1), { detached: true, fresh: true }, 'o botão passa a dizer saída nova');
  const viewport = session.term.buffer.active.viewportY;
  session.term.write('outra\r\n');
  await flush(session.term);
  assert.equal(session.term.buffer.active.viewportY, viewport, 'quem leu o histórico não é puxado para o fim');
  runtime.scrollToBottom(session.id);
  assert.deepEqual(events.at(-1), { detached: false, fresh: false });
  const count = events.length;
  stop();
  session.term.scrollLines(-5);
  assert.equal(events.length, count, 'depois de desligar, nada mais avisa');
});
