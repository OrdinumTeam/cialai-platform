// SPDX-License-Identifier: Apache-2.0
// Entrega de texto escrito fora do terminal, com o runtime real e o
// @xterm/xterm instalado, sem PTY nem rede. O envelope da colagem entre
// colchetes, a conversão das quebras de linha e a ordem entre texto e Enter
// são do xterm e do runtime, não do teste.
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
  plugins: [{ name: 'submit-text-boundaries', setup(api) {
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

test('com a colagem entre colchetes ligada o texto vai envelopado e sem Enter', async () => {
  const { runtime, fixture, session } = await ready();
  session.term.write('\x1b[?2004h');
  await new Promise((resolve) => { session.term.write('', resolve); });
  assert.equal(runtime.bracketedPaste(session.id), true);

  assert.equal(await runtime.submitText(session.id, 'primeira\nsegunda'), true);
  await settle();
  assert.equal(fixture.written.length, 1, 'inserir é uma escrita só');
  assert.equal(fixture.written[0], '\x1b[200~primeira\rsegunda\x1b[201~');
});

test('sem a colagem entre colchetes as quebras viram retorno de carro', async () => {
  const { runtime, fixture, session } = await ready();
  assert.equal(runtime.bracketedPaste(session.id), false);
  assert.equal(await runtime.submitText(session.id, 'uma\nduas\r\ntres'), true);
  await settle();
  assert.equal(fixture.written[0], 'uma\rduas\rtres');
  assert.doesNotMatch(fixture.written[0], /\x1b\[200~/);
});

test('enviar manda o Enter depois do texto, numa escrita à parte', async () => {
  const { runtime, fixture, session } = await ready();
  assert.equal(await runtime.submitText(session.id, 'ola', { enter: true }), true);
  await settle();
  assert.deepEqual([...fixture.written], ['ola', '\r'], 'o Enter chega depois e sozinho');
});

test('durante o replay nada é escrito', async () => {
  const { runtime, fixture, session } = await ready();
  session.replaying = true;
  assert.equal(await runtime.submitText(session.id, 'nao deve sair', { enter: true }), false);
  await settle();
  assert.deepEqual([...fixture.written], []);
});

test('sessão sem PTY, texto vazio e sessão desconhecida não escrevem nada', async () => {
  const { runtime, fixture, session } = await ready();
  assert.equal(await runtime.submitText(session.id, ''), false);
  assert.equal(await runtime.submitText('nao-existe', 'x'), false);
  session.status = 'disconnected';
  assert.equal(await runtime.submitText(session.id, 'x'), false);
  await settle();
  assert.deepEqual([...fixture.written], []);
});

test('no celular sem o controle do terminal nada é escrito', async () => {
  const { runtime, fixture, session } = await ready({ phone: true, owned: false });
  assert.equal(await runtime.submitText(session.id, 'sem controle', { enter: true }), false);
  await settle();
  assert.deepEqual([...fixture.written], []);
});
