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

test('Linux usa clipboard nativo mesmo sem API do navegador e sem agente conhecido', async () => {
  const { installTerminalClipboard } = await load();
  const fixture = terminal();
  const controller = installTerminalClipboard(fixture.term, {
    ...fixture.options,
    readNative: async () => ({ kind: 'text', text: 'ação\n😀' }),
  });
  assert.equal(await controller.read({ readText() { throw new Error('browser API must not be called'); } }), 'text');
  assert.deepEqual(fixture.pasted, ['ação\n😀']);
  controller.dispose();
});

test('arquivos de gerenciadores usam URI local e preservam espaços e Unicode', async () => {
  const { clipboardPaths, clipboardPayload, readClipboard } = await load();
  const uris = '# comment\r\nfile:///tmp/foto%20a%C3%A7%C3%A3o.png\r\nfile:///tmp/%24%28literal%29.txt\r\n';
  const paths = ['/tmp/foto ação.png', '/tmp/$(literal).txt'];
  assert.deepEqual(clipboardPaths(uris), paths);
  assert.deepEqual(clipboardPaths('copy\n' + uris), paths);
  assert.deepEqual(clipboardPaths('file:///C:/Users/example/a%20b.png'), ['C:/Users/example/a b.png']);
  for (const uri of ['https://example.com/a', 'file://remote/a', 'file:///tmp/a%0Ab', 'file:///tmp/%00', 'file:///tmp/%XX']) {
    assert.deepEqual(clipboardPaths(uri), [], uri);
  }
  assert.deepEqual(clipboardPayload({ getData: (type) => type === 'text/uri-list' ? uris : 'incorrect fallback' }), { kind: 'paths', paths });
  assert.deepEqual(await readClipboard({ read: async () => [{ types: ['text/uri-list', 'text/plain'], getType: async (type) => ({ text: async () => type === 'text/uri-list' ? uris : 'incorrect fallback' }) }] }), { kind: 'paths', paths });
});

test('imagem real e arquivo binário preservam bytes em vez de simular Ctrl+V', async () => {
  const { clipboardPayload, readClipboard, installTerminalClipboard } = await load();
  const file = new Blob([new Uint8Array([0, 255, 127])], { type: 'image/png' });
  assert.deepEqual(clipboardPayload({ files: [file] }), { kind: 'files', files: [file] });
  assert.deepEqual(await readClipboard({ read: async () => [{ types: ['image/png'], getType: async () => file }] }), { kind: 'files', files: [file] });
  const fixture = terminal(), inserted = [];
  const controller = installTerminalClipboard(fixture.term, {
    ...fixture.options,
    files: async (files) => {
      assert.deepEqual([...new Uint8Array(await files[0].arrayBuffer())], [0, 255, 127]);
      return ['/tmp/clipboard.png'];
    },
    paths: (paths) => inserted.push(paths),
  });
  await controller.read({ read: async () => [{ types: ['image/png'], getType: async () => file }] });
  assert.deepEqual(inserted, [['/tmp/clipboard.png']]);
  assert.deepEqual(fixture.pasted, []);
  assert.deepEqual(fixture.images, []);
  controller.dispose();
});

test('PTY substituído durante gravação de arquivo não recebe o caminho', async () => {
  const { installTerminalClipboard } = await load();
  const fixture = terminal(), inserted = [];
  let generation = 1, finish;
  const controller = installTerminalClipboard(fixture.term, {
    ...fixture.options,
    identity: () => generation,
    files: () => new Promise((resolve) => { finish = resolve; }),
    paths: (paths) => inserted.push(paths),
  });
  const read = controller.read({ read: async () => [{ types: ['image/png'], getType: async () => new Blob(['bytes']) }] });
  await new Promise((resolve) => setImmediate(resolve));
  generation++;
  finish(['/tmp/late.png']);
  assert.equal(await read, 'cancelled');
  assert.deepEqual(inserted, []);
  controller.dispose();
});

test('paste WebView vazio aguarda a leitura nativa pendente e não a cancela', async () => {
  const { installTerminalClipboard } = await load();
  const fixture = terminal(); let finish;
  const controller = installTerminalClipboard(fixture.term, {
    ...fixture.options,
    readNative: () => new Promise((resolve) => { finish = resolve; }),
  });
  const read = controller.read();
  fixture.handlers.get('paste')({ clipboardData: data(''), preventDefault() {}, stopImmediatePropagation() {} });
  finish({ kind: 'text', text: 'native data' });
  assert.equal(await read, 'text');
  assert.deepEqual(fixture.pasted, ['native data']);
  controller.dispose();
});

test('paste nativo com dados vence a leitura GTK pendente sem duplicar', async () => {
  const { installTerminalClipboard } = await load();
  const fixture = terminal(); let finish;
  const controller = installTerminalClipboard(fixture.term, {
    ...fixture.options,
    readNative: () => new Promise((resolve) => { finish = resolve; }),
  });
  const read = controller.read();
  fixture.handlers.get('paste')({ clipboardData: data('uma vez'), preventDefault() {}, stopImmediatePropagation() {} });
  finish({ kind: 'text', text: 'uma vez' });
  assert.equal(await read, 'native');
  assert.deepEqual(fixture.pasted, ['uma vez']);
  controller.dispose();
});

test('paste vazio sem leitura pendente recupera caminhos pelo clipboard GTK', async () => {
  const { installTerminalClipboard } = await load();
  const fixture = terminal(), paths = [];
  const controller = installTerminalClipboard(fixture.term, {
    ...fixture.options,
    readNative: async () => ({ kind: 'paths', paths: ['/tmp/a b.png'] }),
    paths: (value) => paths.push(value),
  });
  fixture.handlers.get('paste')({ clipboardData: data(''), preventDefault() {}, stopImmediatePropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(paths, [['/tmp/a b.png']]);
  assert.deepEqual(fixture.pasted, []);
  controller.dispose();
});

test('falha ao gravar imagem do paste nativo é reportada sem enviar Ctrl+V', async () => {
  const { installTerminalClipboard } = await load();
  const fixture = terminal(), errors = [];
  const controller = installTerminalClipboard(fixture.term, {
    ...fixture.options,
    files: async () => { throw new Error('disk full'); },
    onError: (error) => errors.push(error.message),
  });
  fixture.handlers.get('paste')({ clipboardData: { files: [new Blob(['bytes'])] }, preventDefault() {}, stopImmediatePropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, ['disk full']);
  assert.deepEqual(fixture.pasted, []);
  assert.deepEqual(fixture.images, []);
  controller.dispose();
});
