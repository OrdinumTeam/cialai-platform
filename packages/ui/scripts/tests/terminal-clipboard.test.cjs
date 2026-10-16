// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../src/terminals/clipboard.js');
const data = (text, types = []) => ({ getData: () => text, items: types.map((type) => ({ type })) });
function terminal() {
  const handlers = new Map(), pasted = [], images = [];
  const term = { element: { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: (name) => handlers.delete(name) }, focus() {} };
  return { term, handlers, pasted, images, options: { paste: (text) => pasted.push(text), image: () => images.push(true) } };
}
test('texto vence imagem em clipboard multiformato e preserva Unicode e multilinha', async () => {
  const { clipboardPayload, readClipboard } = await load();
  const text = 'ação 😀\n$HOME `literal`\r\nsegunda';
  assert.deepEqual(clipboardPayload(data(text, ['image/png', 'text/plain'])), { kind: 'text', text });
  assert.deepEqual(await readClipboard({ read: async () => [{ types: ['image/png', 'text/plain'], getType: async () => ({ text: async () => text }) }] }), { kind: 'text', text });
  assert.deepEqual(clipboardPayload(data('', ['image/png'])), { kind: 'image' });
  assert.deepEqual(clipboardPayload(data('')), { kind: 'empty' });
});
test('paste nativo durante leitura assincrona insere exatamente uma vez', async () => {
  const { installTerminalClipboard } = await load();
  const fixture = terminal(); const controller = installTerminalClipboard(fixture.term, fixture.options);
  let finish; const read = controller.read({ readText: () => new Promise((resolve) => { finish = resolve; }) });
  let prevented = 0, stopped = 0;
  fixture.handlers.get('paste')({ clipboardData: data('uma vez'), preventDefault: () => prevented++, stopImmediatePropagation: () => stopped++ });
  finish('uma vez'); assert.equal(await read, 'native');
  assert.deepEqual(fixture.pasted, ['uma vez']); assert.equal(prevented, 1); assert.equal(stopped, 1);
  controller.dispose(); assert.equal(fixture.handlers.size, 0);
});
test('permissao negada, clipboard vazio e PTY substituido nunca geram Ctrl+V nem texto', async () => {
  const { installTerminalClipboard } = await load();
  const fixture = terminal(); let generation = 1;
  const controller = installTerminalClipboard(fixture.term, { ...fixture.options, identity: () => generation });
  await assert.rejects(controller.read({ readText: async () => { throw new Error('denied'); } }));
  assert.equal(await controller.read({ readText: async () => '' }), 'empty');
  let finish; const read = controller.read({ readText: () => new Promise((resolve) => { finish = resolve; }) });
  generation++; finish('wrong PTY'); assert.equal(await read, 'cancelled');
  assert.deepEqual(fixture.pasted, []); assert.deepEqual(fixture.images, []);
  controller.dispose();
});
test('acoes de colagem independentes continuam independentes e dispose cancela leitura', async () => {
  const { installTerminalClipboard } = await load(); const fixture = terminal();
  const controller = installTerminalClipboard(fixture.term, fixture.options);
  await Promise.all([controller.read({ readText: async () => 'a' }), controller.read({ readText: async () => 'a' })]);
  assert.deepEqual(fixture.pasted, ['a', 'a']);
  let finish; const read = controller.read({ readText: () => new Promise((resolve) => { finish = resolve; }) });
  controller.dispose(); finish('late'); assert.equal(await read, 'cancelled');
  assert.deepEqual(fixture.pasted, ['a', 'a']);
});

test('fechar terminal cancela leitura sem esperar permissao ou clipboard bloqueado', async () => {
  const { installTerminalClipboard } = await load(); const fixture = terminal();
  const controller = installTerminalClipboard(fixture.term, fixture.options);
  let outcome;
  controller.read({ readText: () => new Promise(() => {}) }).then((value) => { outcome = value; });
  controller.dispose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(outcome, 'cancelled');
  assert.deepEqual(fixture.pasted, []);
});

test('evento nativo conclui operacao pendente mesmo quando a API nao responde', async () => {
  const { installTerminalClipboard } = await load(); const fixture = terminal();
  const controller = installTerminalClipboard(fixture.term, fixture.options);
  let outcome;
  const read = controller.read({ readText: () => new Promise(() => {}) }).then((value) => { outcome = value; });
  fixture.handlers.get('paste')({ clipboardData:data('native'),preventDefault(){},stopImmediatePropagation(){} });
  await new Promise((resolve) => setImmediate(resolve));
  controller.dispose(); await read;
  assert.equal(outcome,'native');
  assert.deepEqual(fixture.pasted,['native']);
});

test('paste nativo tardio da leitura anterior nao escreve no PTY substituto', async () => {
  const { installTerminalClipboard } = await load(); const fixture = terminal();
  let generation=1;
  const controller=installTerminalClipboard(fixture.term,{...fixture.options,identity:()=>generation});
  const read=controller.read({readText:()=>new Promise(()=>{})});
  generation++;
  fixture.handlers.get('paste')({clipboardData:data('old target'),preventDefault(){},stopImmediatePropagation(){}});
  controller.dispose();
  assert.equal(await read,'cancelled');
  assert.deepEqual(fixture.pasted,[]);
});

test('clipboard sem resposta tem prazo e nao deixa operacao pendurada', async () => {
  const { installTerminalClipboard } = await load(); const fixture = terminal();
  const controller=installTerminalClipboard(fixture.term,{...fixture.options,timeoutMs:5});
  await assert.rejects(controller.read({readText:()=>new Promise(()=>{})}),/clipboard_timeout/);
  controller.dispose();
});
