// SPDX-License-Identifier: Apache-2.0
// Ligar um Broto pelo QR, do lado da pagina do celular: o pedido da casca, o
// acompanhamento com uma ponte falsa e relogios guiados pelo teste, e a folha
// em cada etapa nos tres idiomas.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createI18n, dictionaries } from '@cialai/i18n';
import { BROTO_QR_POLL_MS, brotoQrError, createBrotoQrFlow } from '../src/terminals/broto-qr.js';

const require = createRequire(import.meta.url);
const PAYLOAD = `CIALAIQ1.${'A'.repeat(40)}_-${'z'.repeat(40)}`;
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Ponte falsa: cada comando responde pela fila do teste, na ordem pedida, e
// toda chamada fica registrada com os argumentos.
function bridge(replies = {}) {
  const calls = [];
  const queues = Object.fromEntries(Object.entries(replies).map(([command, list]) => [command, [...list]]));
  const invoke = async (command, args) => {
    calls.push({ command, args });
    const queue = queues[command] || [];
    const reply = queue.length > 1 ? queue.shift() : queue[0];
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'function') return reply(args);
    return reply;
  };
  return { invoke, calls, count: (command) => calls.filter((call) => call.command === command).length };
}

// Relogio do teste: o agendamento so roda quando o teste manda.
function clock(start = Date.parse('2026-11-06T12:00:00Z')) {
  let now = start;
  let pending = null;
  const delays = [];
  return {
    now: () => now,
    schedule: (callback, ms) => { delays.push(ms); pending = callback; return delays.length; },
    unschedule: () => { pending = null; },
    async tick(ms = BROTO_QR_POLL_MS) {
      now += ms;
      const callback = pending;
      pending = null;
      if (callback) await callback();
      await flush();
    },
    get scheduled() { return pending !== null; },
    delays,
  };
}

const begun = { qrId: 'q_AbC-12_x', name: 'Notebook da sala', platform: 'windows', expiresAt: '2026-11-06T12:10:00Z' };
const state = (stage, extra = {}) => ({ qrId: begun.qrId, stage, name: begun.name, platform: begun.platform, digits: '', expiresAt: begun.expiresAt, onion: 'publishing', ...extra });

function start(replies, timers = clock()) {
  const fake = bridge(replies);
  const views = [];
  const flow = createBrotoQrFlow({ invoke: fake.invoke, payload: PAYLOAD, onChange: (view) => views.push(view), now: timers.now, schedule: timers.schedule, unschedule: timers.unschedule });
  return { fake, flow, timers, views };
}

test('o pedido manda so o texto lido; quem pede vem da ponte, nunca da pagina', async () => {
  const { fake, flow, timers } = start({ broto_qr_begin: [begun], broto_qr_state: [state('waiting')] });
  assert.equal(flow.view().stage, 'starting');
  await flush();
  assert.deepEqual(fake.calls[0], { command: 'broto_qr_begin', args: { payload: PAYLOAD } });
  const view = flow.view();
  assert.deepEqual([view.stage, view.qrId, view.name, view.platform, view.expiresAt], ['waiting', begun.qrId, begun.name, 'windows', begun.expiresAt]);
  await timers.tick();
  assert.deepEqual(fake.calls[1], { command: 'broto_qr_state', args: { qrId: begun.qrId } });
  assert.deepEqual(timers.delays, [BROTO_QR_POLL_MS, BROTO_QR_POLL_MS], 'uma consulta a cada 1,5 s, sem espera longa no computador');
  for (const call of fake.calls) assert.ok(!('requester' in call.args), `${call.command} nao leva requester`);
  flow.close();
});

test('confirmar so vale com os numeros na tela; o fim para as consultas', async () => {
  const { fake, flow, timers } = start({
    broto_qr_begin: [begun],
    broto_qr_state: [state('waiting', { onion: 'ready' }), state('verify', { digits: '4821' }), state('approved', { digits: '4821' }), state('done')],
    broto_qr_decide: [{ stage: 'approved' }],
  });
  await flush();
  await flow.decide(true);
  assert.equal(fake.count('broto_qr_decide'), 0, 'esperando o Broto nao ha o que confirmar');
  await timers.tick();
  assert.equal(flow.view().onion, 'ready');
  await timers.tick();
  assert.equal(flow.view().stage, 'verify');
  assert.equal(flow.view().digits, '4821');
  await flow.decide(true);
  assert.deepEqual(fake.calls.at(-1), { command: 'broto_qr_decide', args: { qrId: begun.qrId, approve: true } });
  assert.equal(flow.view().stage, 'approved');
  assert.equal(flow.view().digits, '4821', 'os numeros ficam enquanto o Broto confere');
  await timers.tick();
  await timers.tick();
  assert.equal(flow.view().stage, 'done');
  assert.equal(flow.view().digits, '');
  const polls = fake.count('broto_qr_state');
  assert.equal(timers.scheduled, false, 'nada mais agendado depois do fim');
  await timers.tick();
  assert.equal(fake.count('broto_qr_state'), polls);
  flow.close();
  assert.equal(fake.count('broto_qr_decide'), 1, 'fechar depois do fim nao recusa');
});

test('recusar vale ate um fim e fechar antes do fim recusa', async () => {
  const refused = start({ broto_qr_begin: [begun], broto_qr_state: [state('verify', { digits: '1234' })], broto_qr_decide: [{ stage: 'denied' }] });
  await flush();
  await refused.timers.tick();
  await refused.flow.decide(false);
  assert.deepEqual(refused.fake.calls.at(-1).args, { qrId: begun.qrId, approve: false });
  assert.equal(refused.flow.view().stage, 'denied');
  assert.equal(refused.timers.scheduled, false);

  const closed = start({ broto_qr_begin: [begun], broto_qr_state: [state('approved', { digits: '1234' })], broto_qr_decide: [{ stage: 'denied' }] });
  await flush();
  await closed.timers.tick();
  closed.flow.close();
  await flush();
  assert.deepEqual(closed.fake.calls.at(-1), { command: 'broto_qr_decide', args: { qrId: begun.qrId, approve: false } });
  assert.equal(closed.timers.scheduled, false, 'fechar para as consultas');
  const views = closed.views.length;
  closed.flow.close();
  await flush();
  assert.equal(closed.fake.count('broto_qr_decide'), 1, 'fechar duas vezes recusa uma vez');
  assert.equal(closed.views.length, views, 'a folha fechada nao recebe estado');
});

test('fechar com o QR ainda a caminho recusa assim que o computador responde', async () => {
  let release;
  const timers = clock();
  const fake = bridge({ broto_qr_begin: [() => new Promise((resolve) => { release = resolve; })], broto_qr_decide: [{ stage: 'denied' }] });
  const flow = createBrotoQrFlow({ invoke: fake.invoke, payload: PAYLOAD, now: timers.now, schedule: timers.schedule, unschedule: timers.unschedule });
  await flush();
  flow.close();
  release(begun);
  await flush();
  await flush();
  assert.deepEqual(fake.calls.map((call) => call.command), ['broto_qr_begin', 'broto_qr_decide']);
  assert.deepEqual(fake.calls[1].args, { qrId: begun.qrId, approve: false });
  assert.equal(timers.scheduled, false);
});

test('o QR vencido para sem perguntar, e a consulta velha nao desfaz a decisao', async () => {
  const lapsed = start({ broto_qr_begin: [begun], broto_qr_state: [state('waiting')] });
  await flush();
  await lapsed.timers.tick(10 * 60 * 1000 + 6000);
  assert.equal(lapsed.flow.view().stage, 'expired');
  assert.equal(lapsed.fake.count('broto_qr_state'), 0);
  lapsed.flow.close();
  await flush();
  assert.equal(lapsed.fake.count('broto_qr_decide'), 0, 'o pedido vencido nao precisa de recusa');

  // A consulta sai com o pedido em verify e a decisao chega antes da resposta.
  let answer;
  const raced = start({ broto_qr_begin: [begun], broto_qr_state: [state('verify', { digits: '9999' }), () => new Promise((resolve) => { answer = resolve; })], broto_qr_decide: [{ stage: 'approved' }] });
  await flush();
  await raced.timers.tick();
  assert.equal(raced.flow.view().stage, 'verify');
  const inFlight = raced.timers.tick();
  await flush();
  await raced.flow.decide(true);
  answer(state('verify', { digits: '9999' }));
  await inFlight;
  assert.equal(raced.flow.view().stage, 'approved', 'o estado de antes da decisao foi descartado');
  assert.equal(raced.timers.scheduled, true, 'a decisao agenda a consulta seguinte');
  raced.flow.close();
});

test('falhas viram codigos que a folha traduz, e a ponte instavel so avisa', async () => {
  const en = dictionaries.en['native.error.desktopOnly'];
  assert.deepEqual(brotoQrError(new Error('qr_busy')), { code: 'qr_busy', message: '' });
  assert.deepEqual(brotoQrError(new Error(en)), { code: 'outdated', message: '' });
  assert.deepEqual(brotoQrError(new Error(dictionaries['pt-BR']['native.error.desktopOnly'])), { code: 'outdated', message: '' });
  assert.deepEqual(brotoQrError(new Error('command_unknown')), { code: 'outdated', message: '' });
  assert.deepEqual(brotoQrError(new Error('network_setup')), { code: 'failed', message: '' }, 'codigo cru nao vira texto');
  assert.deepEqual(brotoQrError(new Error('Ação cancelada.')), { code: 'failed', message: 'Ação cancelada.' });

  const busy = start({ broto_qr_begin: [new Error('qr_busy')] });
  await flush();
  assert.equal(busy.flow.view().stage, 'error');
  assert.equal(busy.flow.view().error.code, 'qr_busy');
  assert.equal(busy.timers.scheduled, false);

  const shaky = start({ broto_qr_begin: [begun], broto_qr_state: [Object.assign(new Error('O computador não respondeu a tempo.'), { code: 'bridge_timeout' }), state('verify', { digits: '0042' })] });
  await flush();
  await shaky.timers.tick();
  assert.equal(shaky.flow.view().stage, 'waiting');
  assert.equal(shaky.flow.view().notice.code, 'bridge_timeout');
  await shaky.timers.tick();
  assert.equal(shaky.flow.view().stage, 'verify');
  assert.equal(shaky.flow.view().notice, null);
  shaky.flow.close();

  const canceled = start({ broto_qr_begin: [begun], broto_qr_state: [state('verify', { digits: '0042' })], broto_qr_decide: [new Error('Ação cancelada.'), { stage: 'approved' }] });
  await flush();
  await canceled.timers.tick();
  await canceled.flow.decide(true);
  assert.equal(canceled.flow.view().stage, 'verify', 'biometria cancelada deixa confirmar de novo');
  assert.equal(canceled.flow.view().notice.message, 'Ação cancelada.');
  await canceled.flow.decide(true);
  assert.equal(canceled.flow.view().stage, 'approved');
  canceled.flow.close();

  const gone = start({ broto_qr_begin: [begun], broto_qr_state: [new Error('qr_unknown')] });
  await flush();
  await gone.timers.tick();
  assert.equal(gone.flow.view().error.code, 'qr_unknown');
  assert.equal(gone.timers.scheduled, false);
});

test('numeros fora do formato e etapas desconhecidas nao entram', async () => {
  const odd = start({ broto_qr_begin: [begun], broto_qr_state: [state('verify', { digits: '12a4' }), state('surprise', { digits: '1234' }), state('waiting', { digits: '1234' })] });
  await flush();
  await odd.timers.tick();
  assert.equal(odd.flow.view().digits, '');
  await odd.timers.tick();
  assert.equal(odd.flow.view().stage, 'verify');
  assert.equal(odd.flow.view().digits, '1234');
  await odd.timers.tick();
  assert.equal(odd.flow.view().digits, '', 'esperando nao mostra numeros');
  odd.flow.close();

  const broken = start({ broto_qr_begin: [{ qrId: '../q' }] });
  await flush();
  assert.equal(broken.flow.view().stage, 'error');
  assert.equal(broken.fake.count('broto_qr_state'), 0);
});

// Pedido da casca e folha, com a ponte e o MUI de fora.
const mocks = {
  native: 'export const invoke=async()=>null;',
  dialogs: `import React from 'react'; export const Sheet=({open,title,children,actions})=>open?React.createElement('section',{'data-sheet':''},React.createElement('h2',null,title),children,React.createElement('footer',null,actions)):null;`,
};
async function bundle(entry) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, write: false, format: 'cjs', platform: 'node', external: ['react', 'react-dom', 'lucide-react'],
    plugins: [{ name: 'broto-qr-boundaries', setup(api) {
      api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path }) => {
        const key = path.split('/').at(-1).replace(/\.jsx?$/, '');
        if (mocks[key]) return { path: key, namespace: 'fixture' };
      });
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'jsx', resolveDir: fileURLToPath(new URL('.', import.meta.url)) }));
    } }],
  });
  return result.outputFiles[0].text;
}
const run = (code, locale = 'pt-BR', window = { __CIALAI_SHELL__: { locale } }) => {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, require, console, window, __CIALAI_SHELL__: { locale },
    document: { documentElement: { lang: locale, dataset: {} } }, localStorage: { getItem: () => null, setItem: () => {} }, navigator: { language: locale } });
  vm.runInContext(code, context);
  return context.module.exports;
};

test('a casca abre a folha com o texto do QR, uma vez, so no formato certo', async () => {
  const window = { __CIALAI_SHELL__: null };
  const shell = run(await bundle('../src/lib/shell.js'), 'pt-BR', window);
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  window.__CIALAI_SHELL__ = { intent: { id: 'b1', kind: 'broto-qr', payload: PAYLOAD } };
  assert.deepEqual({ ...shell.takeShellIntent(storage) }, { id: 'b1', kind: 'broto-qr', payload: PAYLOAD });
  assert.equal(shell.takeShellIntent(storage), null, 'o mesmo QR nao abre duas vezes');
  for (const [id, payload] of [['b2', 'CIALAIB2.abc'], ['b3', `CIALAIQ1.${'A'.repeat(1192)}`], ['b4', 'CIALAIQ1.abc=='], ['b5', 'CIALAIQ1.'], ['b6', undefined]]) {
    window.__CIALAI_SHELL__ = { intent: { id, kind: 'broto-qr', payload } };
    assert.equal(shell.takeShellIntent(storage), null, `recusa ${String(payload).slice(0, 20)}`);
  }
  assert.equal(shell.isBrotoQrPayload(`CIALAIQ1.${'A'.repeat(1191)}`), true, '1200 caracteres ainda cabem');
  let heard = 0;
  const stop = shell.onShellIntent(() => { heard += 1; });
  shell.receiveShellMessage({ type: 'intent', intent: { id: 'b7', kind: 'broto-qr', payload: PAYLOAD } });
  shell.receiveShellMessage({ type: 'intent', intent: { id: 'b8', kind: 'broto-qr', payload: 'texto qualquer' } });
  assert.equal(heard, 1, 'com a pagina aberta, so o QR valido avisa');
  stop();
});

test('a lista abre a folha do QR pelo pedido e o voltar fecha a folha antes', async () => {
  const source = await readFile(new URL('../src/terminals/ui/PhoneWorkbench.jsx', import.meta.url), 'utf8');
  assert.match(source, /intent\.kind === 'broto-qr'\) setBrotoQr\(\{ id: intent\.id, payload: intent\.payload \}\)/);
  assert.match(source, /<PhoneBrotoPairing request=\{brotoQr\} onClose=\{\(\) => setBrotoQr\(null\)\} \/>/);
  assert.match(source, /onNavigateBack\(\(\) => \{\n\s+if \(brotoQr\) setBrotoQr\(null\);/);
});

const sheetCode = await bundle('../src/terminals/ui/PhoneBrotoPairing.jsx');
for (const locale of ['pt-BR', 'en', 'es']) {
  const t = createI18n(locale).t;
  const sheet = run(sheetCode, locale);
  const html = (view) => renderToStaticMarkup(React.createElement(sheet.BrotoQrBody, { view: { stage: 'waiting', qrId: begun.qrId, name: '', platform: '', digits: '', expiresAt: '', onion: '', busy: false, error: null, notice: null, ...view } }));
  const text = (markup) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

  test(`folha do QR em ${locale}: nome, sistema, numeros e o que fazer`, () => {
    const verify = html({ stage: 'verify', name: begun.name, platform: 'windows', digits: '4821' });
    assert.equal([...verify.matchAll(/<span>(\d)<\/span>/g)].map((match) => match[1]).join(''), '4821');
    assert.match(verify, new RegExp(`aria-label="${t('terminal.brotoQr.digitsLabel')}"`));
    assert.ok(text(verify).includes('Windows'), 'o sistema aparece pelo nome');
    assert.ok(text(verify).includes(t('terminal.brotoQr.verifyLead')));
    assert.ok(text(verify).includes(t('terminal.brotoQr.verifyHint')));
    assert.ok(text(html({ stage: 'approved', digits: '4821', platform: 'darwin' })).includes(t('terminal.brotoQr.approved')));
    assert.ok(text(html({ stage: 'approved', digits: '4821', platform: 'darwin' })).includes('macOS'));
    assert.ok(text(html({ stage: 'done' })).includes(t('terminal.brotoQr.doneHint')));
    assert.ok(text(html({ stage: 'denied' })).includes(t('terminal.brotoQr.denied')));
    assert.ok(text(html({ stage: 'expired' })).includes(t('terminal.brotoQr.expired')));
  });

  test(`folha do QR em ${locale}: a espera explica o Tor e a mesma rede`, () => {
    assert.ok(text(html({ stage: 'starting' })).includes(t('terminal.brotoQr.starting')));
    const waiting = text(html({ stage: 'waiting', name: begun.name, platform: 'linux', onion: 'publishing' }));
    assert.ok(waiting.includes(t('terminal.brotoQr.waiting')) && waiting.includes(t('terminal.brotoQr.waitingTor')) && waiting.includes(begun.name) && waiting.includes('Linux'));
    const off = text(html({ stage: 'waiting', onion: 'off' }));
    assert.ok(off.includes(t('terminal.brotoQr.onionOff')));
    assert.ok(!off.includes(t('terminal.brotoQr.waitingTor')));
  });

  test(`folha do QR em ${locale}: cada falha no idioma da pessoa`, () => {
    for (const [code, key] of [['qr_invalid', 'terminal.brotoQr.error.invalid'], ['qr_expired', 'terminal.brotoQr.expired'], ['qr_used', 'terminal.brotoQr.error.used'], ['qr_busy', 'terminal.brotoQr.error.busy'], ['qr_unknown', 'terminal.brotoQr.error.unknown'], ['outdated', 'terminal.brotoQr.error.outdated'], ['failed', 'terminal.brotoQr.error.failed']]) {
      assert.ok(text(html({ stage: 'error', error: { code, message: '' } })).includes(t(key)), code);
    }
    assert.ok(text(html({ stage: 'error', error: { code: 'failed', message: 'Ação cancelada.' } })).includes('Ação cancelada.'));
    assert.ok(text(html({ stage: 'verify', digits: '1234', notice: { code: 'qr_not_ready', message: '' } })).includes(t('terminal.brotoQr.error.notReady')));
    assert.ok(text(html({ stage: 'waiting', notice: { code: 'bridge_disconnected', message: '' } })).includes(t('terminal.brotoQr.reconnecting')));
    assert.ok(t('terminal.brotoQr.error.outdated').includes('0.6.0'));
  });
}
