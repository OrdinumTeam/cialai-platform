// SPDX-License-Identifier: Apache-2.0
// Controlador do teclado especial: modificadores, envio único, repetição com
// contrapressão e combinação com o teclado nativo.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/terminals/special-keys.js');
const ESC = '\x1b';

// Agendador manual: o teste avança o relógio e decide quando a escrita volta.
function harness(options = {}) {
  const sent = [];
  const timers = [];
  let now = 0;
  let pending = [];
  const config = {
    send: (data) => {
      sent.push(data);
      if (!options.slow) return true;
      return new Promise((resolve) => pending.push(resolve));
    },
    schedule: (callback, ms) => { const timer = { at: now + ms, callback, done: false }; timers.push(timer); return timer; },
    cancel: (timer) => { if (timer) timer.done = true; },
    ...options.config,
  };
  async function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = timers.filter((timer) => !timer.done && timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      now = next.at;
      next.done = true;
      next.callback();
      await Promise.resolve();
    }
    now = end;
  }
  async function resolveWrites() { const list = pending; pending = []; list.forEach((resolve) => resolve(true)); await new Promise((resolve) => setImmediate(resolve)); }
  return { sent, config, advance, resolveWrites };
}

test('um toque arma Ctrl, a tecla seguinte consome e o Ctrl volta ao normal', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  const states = [];
  keys.subscribe((state) => states.push(state.armed.ctrl));
  keys.toggleModifier('ctrl');
  assert.equal(keys.getState().armed.ctrl, true);
  await keys.click('c');
  assert.deepEqual(h.sent, ['\x03']);
  assert.equal(keys.getState().armed.ctrl, false);
  assert.deepEqual(states, [true, false]);
});

test('modificadores combinam: Ctrl Shift P e Alt com caractere', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  keys.toggleModifier('ctrl'); keys.toggleModifier('shift');
  await keys.click('p');
  keys.toggleModifier('alt');
  await keys.click('b');
  keys.toggleModifier('ctrl');
  await keys.click('ArrowRight');
  assert.deepEqual(h.sent, ['\x10', `${ESC}b`, `${ESC}[1;5C`]);
});

test('modificador sozinho nunca é enviado, e um segundo toque desarma', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  keys.toggleModifier('ctrl');
  keys.toggleModifier('ctrl');
  await keys.click('ctrl');
  await keys.press('Meta');
  assert.deepEqual(h.sent, []);
  assert.equal(keys.getState().any, true, 'click em Ctrl alterna, não envia');
  keys.reset();
  assert.equal(keys.getState().any, false);
});

test('no modo fixo o modificador fica até ser tocado de novo', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController({ ...h.config, mode: 'sticky' });
  keys.toggleModifier('ctrl');
  await keys.click('c');
  await keys.click('d');
  keys.toggleModifier('ctrl');
  await keys.click('c');
  assert.deepEqual(h.sent, ['\x03', '\x04', 'c']);
});

test('teclas com modificador próprio somam os armados', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  await keys.click('c', { ctrl: true });
  keys.toggleModifier('alt');
  await keys.click('c', { ctrl: true });
  await keys.click('Tab', { shift: true });
  assert.deepEqual(h.sent, ['\x03', `${ESC}\x03`, `${ESC}[Z`]);
});

test('setas seguem o modo de cursor do terminal no momento do toque', async () => {
  const { createKeyController } = await load();
  const h = harness();
  let app = false;
  const keys = createKeyController({ ...h.config, applicationCursor: () => app });
  await keys.click('ArrowUp');
  app = true;
  await keys.click('ArrowUp');
  await keys.click('Home');
  assert.deepEqual(h.sent, [`${ESC}[A`, `${ESC}OA`, `${ESC}OH`]);
});

test('toque curto envia uma vez só, no click', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  keys.pointerDown('ArrowDown');
  await h.advance(120);
  keys.pointerUp();
  await keys.click('ArrowDown');
  await h.advance(1000);
  assert.deepEqual(h.sent, [`${ESC}[B`]);
});

test('arrastar para fora ou cancelar não envia nada', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  keys.pointerDown('ArrowDown');
  keys.pointerUp();
  await h.advance(1000);
  assert.deepEqual(h.sent, []);
});

test('segurar repete, para ao soltar e o click do fim não duplica', async () => {
  const { createKeyController, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  keys.toggleModifier('shift');
  keys.pointerDown('ArrowLeft');
  await h.advance(REPEAT_DELAY_MS - 1);
  assert.equal(h.sent.length, 0);
  await h.advance(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(keys.getState().armed.shift, false, 'Shift solta na primeira saída e as repetições mantêm a combinação');
  for (let i = 0; i < 3; i += 1) { await h.advance(REPEAT_INTERVAL_MS); await new Promise((resolve) => setImmediate(resolve)); }
  keys.pointerUp();
  await keys.click('ArrowLeft');
  await h.advance(1000);
  assert.deepEqual(h.sent, Array(4).fill(`${ESC}[1;2D`));
});

test('a repetição espera a escrita anterior voltar antes da próxima', async () => {
  const { createKeyController, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS } = await load();
  const h = harness({ slow: true });
  const keys = createKeyController(h.config);
  keys.pointerDown('Backspace');
  await h.advance(REPEAT_DELAY_MS + REPEAT_INTERVAL_MS * 5);
  assert.equal(h.sent.length, 1, 'rede lenta não acumula repetições');
  await h.resolveWrites();
  await h.advance(REPEAT_INTERVAL_MS);
  assert.equal(h.sent.length, 2);
  keys.pointerUp();
  await h.resolveWrites();
  await h.advance(1000);
  assert.equal(h.sent.length, 2);
});

test('teclas que não repetem só saem no click, mesmo seguradas', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  keys.pointerDown('Enter');
  await h.advance(2000);
  assert.deepEqual(h.sent, []);
  await keys.click('Enter');
  assert.deepEqual(h.sent, ['\r']);
});

test('teclado nativo: um caractere com Ctrl armado vira a combinação', async () => {
  const { createKeyController } = await load();
  const keys = createKeyController(harness().config);
  assert.equal(keys.transformTyped('c'), 'c', 'sem modificador o texto passa intacto');
  keys.toggleModifier('ctrl');
  assert.equal(keys.transformTyped('c'), '\x03');
  assert.equal(keys.getState().any, false);
  keys.toggleModifier('alt');
  assert.equal(keys.transformTyped('\r'), `${ESC}\r`);
  keys.toggleModifier('ctrl'); keys.toggleModifier('shift');
  assert.equal(keys.transformTyped('p'), '\x10');
});

test('teclado nativo: colagem, palavra inteira e respostas do xterm passam intactas', async () => {
  const { createKeyController } = await load();
  const keys = createKeyController(harness().config);
  keys.toggleModifier('ctrl');
  assert.equal(keys.transformTyped('hello'), 'hello');
  assert.equal(keys.transformTyped(`${ESC}[?1;2c`), `${ESC}[?1;2c`);
  assert.equal(keys.transformTyped('\x7fab'), '\x7fab');
  assert.equal(keys.getState().armed.ctrl, true, 'o modificador espera um caractere só');
});

test('vibração só com a preferência ligada', async () => {
  const { createKeyController } = await load();
  const calls = [];
  const h = harness();
  const keys = createKeyController({ ...h.config, vibrate: (ms) => calls.push(ms) });
  await keys.click('Tab');
  keys.setHaptics(true);
  await keys.click('Tab');
  keys.toggleModifier('ctrl');
  assert.equal(calls.length, 2);
});

test('falha de envio não derruba o controlador', async () => {
  const { createKeyController } = await load();
  const keys = createKeyController({ send: () => { throw new Error('offline'); } });
  assert.equal(await keys.click('Tab'), false);
  const rejecting = createKeyController({ send: () => Promise.reject(new Error('offline')) });
  assert.equal(await rejecting.click('Tab'), false);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));
// Segura a tecla, deixa repetir `ticks` vezes depois da primeira e solta.
async function hold(h, keys, key, fixed, ticks = 2) {
  keys.pointerDown(key, fixed);
  await h.advance(400); await flush();
  for (let i = 0; i < ticks; i += 1) { await h.advance(80); await flush(); }
  keys.pointerUp();
}

test('os tempos de repetição são 400 ms para começar e 80 ms entre envios', async () => {
  const { createKeyController, REPEAT_DELAY_MS, REPEAT_INTERVAL_MS } = await load();
  assert.equal(REPEAT_DELAY_MS, 400);
  assert.equal(REPEAT_INTERVAL_MS, 80);
  const h = harness();
  const keys = createKeyController(h.config);
  keys.pointerDown('ArrowUp');
  await h.advance(399); await flush();
  assert.equal(h.sent.length, 0);
  await h.advance(1); await flush();
  assert.equal(h.sent.length, 1);
  await h.advance(79); await flush();
  assert.equal(h.sent.length, 1);
  await h.advance(1); await flush();
  assert.equal(h.sent.length, 2);
  keys.pointerUp();
});

test('trocar o modo em uso avisa, ignora modo inválido e vale para o próximo toque', async () => {
  const { createKeyController } = await load();
  const h = harness();
  assert.equal(createKeyController({ ...h.config, mode: 'qualquer' }).getState().mode, 'oneShot');
  const keys = createKeyController(h.config);
  const modes = [];
  keys.subscribe((state) => modes.push(state.mode));
  keys.setMode('sticky');
  keys.setMode('sticky');
  keys.setMode('travado');
  assert.deepEqual(modes, ['sticky'], 'só a troca real avisa');
  keys.toggleModifier('ctrl');
  await keys.click('c');
  assert.equal(keys.getState().armed.ctrl, true, 'no modo fixo o Ctrl continua');
  keys.setMode('oneShot');
  await keys.click('d');
  assert.equal(keys.getState().armed.ctrl, false, 'de volta ao toque único, a próxima tecla solta');
  assert.deepEqual(h.sent, ['\x03', '\x04']);
});

test('a repetição soma o modificador próprio da tecla e mantém o fixo armado', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  await hold(h, keys, 'Backspace', { ctrl: true });
  assert.deepEqual(h.sent, ['\b', '\b', '\b']);
  const sticky = harness();
  const fixed = createKeyController({ ...sticky.config, mode: 'sticky' });
  fixed.toggleModifier('shift');
  await hold(sticky, fixed, 'ArrowRight');
  assert.deepEqual(sticky.sent, Array(3).fill(`${ESC}[1;2C`));
  assert.equal(fixed.getState().armed.shift, true);
});

test('Delete, Page Up e Page Down repetem; a seta acompanha o modo de cursor durante o toque longo', async () => {
  const { createKeyController } = await load();
  for (const [key, data] of [['Delete', `${ESC}[3~`], ['PageUp', `${ESC}[5~`], ['PageDown', `${ESC}[6~`]]) {
    const h = harness();
    await hold(h, createKeyController(h.config), key, undefined, 1);
    assert.deepEqual(h.sent, [data, data], key);
  }
  const h = harness();
  let app = false;
  const keys = createKeyController({ ...h.config, applicationCursor: () => app });
  keys.pointerDown('ArrowDown');
  await h.advance(400); await flush();
  app = true;
  await h.advance(80); await flush();
  keys.pointerUp();
  assert.deepEqual(h.sent, [`${ESC}[B`, `${ESC}OB`]);
});

test('um segundo dedo, reset e dispose param a repetição em curso', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  keys.pointerDown('ArrowUp');
  await h.advance(300);
  keys.pointerDown('ArrowDown');
  await h.advance(400); await flush();
  keys.reset();
  await h.advance(1000); await flush();
  assert.deepEqual(h.sent, [`${ESC}[B`], 'só a segunda tecla saiu, e o reset parou a repetição');
  const d = harness();
  const disposed = createKeyController(d.config);
  disposed.pointerDown('ArrowLeft');
  await d.advance(400); await flush();
  disposed.dispose();
  await d.advance(1000); await flush();
  assert.equal(d.sent.length, 1);
});

test('depois de um toque longo, o click de outra tecla sai normalmente', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  await hold(h, keys, 'ArrowLeft', undefined, 0);
  await keys.click('Tab');
  await keys.click('ArrowLeft');
  assert.deepEqual(h.sent, [`${ESC}[D`, '\t', `${ESC}[D`], 'o click engolido é só o do fim do toque longo');
});

test('envio recusado devolve falso sem travar as próximas teclas', async () => {
  const { createKeyController } = await load();
  const sent = [];
  let accept = false;
  const keys = createKeyController({ send: (data) => { sent.push(data); return accept; } });
  assert.equal(await keys.click('Tab'), false);
  accept = true;
  assert.equal(await keys.click('Tab'), true);
  assert.deepEqual(sent, ['\t', '\t']);
});

test('teclado nativo: Esc, Tab, Backspace, emoji e só Shift armado', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const keys = createKeyController(h.config);
  keys.toggleModifier('alt');
  assert.equal(keys.transformTyped('\x7f'), `${ESC}\x7f`);
  keys.toggleModifier('alt');
  assert.equal(keys.transformTyped('\x1b'), `${ESC}${ESC}`);
  keys.toggleModifier('alt');
  assert.equal(keys.transformTyped('😀'), `${ESC}😀`, 'um emoji é um caractere só');
  keys.toggleModifier('shift');
  assert.equal(keys.transformTyped('\t'), `${ESC}[Z`);
  keys.toggleModifier('shift');
  assert.equal(keys.transformTyped('a'), 'A');
  assert.equal(keys.getState().any, false);
  assert.equal(keys.transformTyped('a'), 'a', 'sem modificador o texto passa intacto');
});

test('cancelar a inscrição para os avisos; vibração com erro não impede o envio', async () => {
  const { createKeyController } = await load();
  const h = harness();
  const calls = [];
  const keys = createKeyController({ ...h.config, haptics: true, vibrate: (ms) => { calls.push(ms); throw new Error('sem motor'); } });
  const seen = [];
  const stop = keys.subscribe((state) => seen.push(state.any));
  keys.toggleModifier('ctrl');
  stop();
  keys.toggleModifier('ctrl');
  assert.deepEqual(seen, [true]);
  await keys.click('Tab');
  assert.deepEqual(h.sent, ['\t']);
  await hold(h, keys, 'ArrowUp', undefined, 3);
  assert.equal(calls.length, 4, 'dois toques de Ctrl, o Tab e uma vez no início da repetição');
});

test('trocar de sessão descarta os modificadores armados e religa o teclado nativo à sessão nova', async () => {
  const { sessionKeyController, bindSessionKeys } = await load();
  const writes = [];
  const transforms = new Map();
  const deps = {
    sendKey: (id, data) => { writes.push([id, data]); return true; },
    applicationCursorKeys: (id) => id === 'vim',
  };
  const binding = {
    setInputTransform: (id, transform) => { transforms.set(id, transform); return () => transforms.delete(id); },
    onState: () => {},
  };
  const first = sessionKeyController('shell', deps);
  const unbindFirst = bindSessionKeys(first, 'shell', binding);
  first.toggleModifier('ctrl');
  assert.equal(transforms.get('shell')('c'), '\x03', 'o texto nativo da sessão passa pelo controlador dela');
  first.toggleModifier('alt');
  first.pointerDown('ArrowUp');
  unbindFirst();
  assert.equal(transforms.has('shell'), false, 'a sessão antiga deixa de transformar o texto');
  const second = sessionKeyController('vim', deps);
  const states = [];
  bindSessionKeys(second, 'vim', { ...binding, onState: (state) => states.push(state.any) });
  assert.deepEqual(states, [false], 'a sessão nova começa sem modificador armado');
  await second.click('ArrowUp');
  assert.deepEqual(writes, [['vim', '\x1bOA']], 'a seta vai para a sessão nova, no modo de cursor dela, e a repetição antiga parou');
});
