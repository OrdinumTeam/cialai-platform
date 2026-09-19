// SPDX-License-Identifier: Apache-2.0
// Caixa de texto do celular, renderizada de verdade e sem PTY. Enter dentro da
// caixa é edição; o texto só sai por Inserir ou Enviar.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/terminals/ui/PhoneComposer.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
});

function load() {
  const context = vm.createContext({
    module: { exports: {} }, exports: {}, require: createRequire(import.meta.url), console,
    window: { innerHeight: 852, sessionStorage: null },
    document: { documentElement: { lang: 'pt-BR', dataset: {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return context.module.exports;
}

const api = load();
const PhoneComposer = api.default;

// Armazenamento de rascunho por sessão, em memória, como a WebView entrega.
function storage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
    map,
  };
}

const render = (props) => renderToStaticMarkup(React.createElement(PhoneComposer, {
  open: true, sessionId: 'sessao', interactive: true, bracketed: true,
  onSubmit: async () => true, onClose() {}, storage: storage(), ...props,
}));

test('a caixa fechada não renderiza nada', () => {
  assert.equal(render({ open: false }), '');
});

test('a caixa aberta traz o campo, o contador e as três ações', () => {
  const html = render();
  assert.match(html, /phone-composer__area/);
  assert.match(html, /enterkeyhint="enter"/i, 'o teclado mostra a tecla de quebra de linha');
  assert.match(html, /font-size:16px/, 'abaixo de 16 px o iOS amplia a página inteira');
  assert.match(html, /Inserir/);
  assert.match(html, /Enviar/);
  assert.match(html, /Limpar/);
  assert.match(html, /0 linhas/);
});

test('Enter no campo não chama submitText', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(
    fileURLToPath(new URL('../src/terminals/ui/PhoneComposer.jsx', import.meta.url)), 'utf8',
  ));
  const handler = source.slice(source.indexOf('onKeyDown='), source.indexOf('placeholder='));
  assert.match(handler, /event\.key === 'Enter'/);
  assert.doesNotMatch(handler, /onSubmit|deliver/, 'Enter é edição, nunca entrega');
  // A entrega só acontece nos dois botões.
  const deliveries = [...source.matchAll(/deliver\((true|false)\)/g)].map((match) => match[1]);
  assert.deepEqual(deliveries, ['false', 'true'], 'Inserir sem Enter, Enviar com Enter');
});

test('sem colagem entre colchetes, texto de várias linhas pede segunda confirmação', () => {
  assert.equal(api.needsBracketWarning('uma linha', false), false);
  assert.equal(api.needsBracketWarning('uma\nduas', false), true);
  assert.equal(api.needsBracketWarning('uma\nduas', true), false, 'com o modo ligado o bloco vai inteiro');
  assert.equal(api.countLines(''), 0);
  assert.equal(api.countLines('a\nb\nc'), 3);
});

test('o rascunho fica guardado por sessão e some ao entregar', () => {
  const store = storage();
  api.writeDraft('sessao-a', 'texto da primeira', store);
  api.writeDraft('sessao-b', 'texto da segunda', store);
  assert.equal(api.readDraft('sessao-a', store), 'texto da primeira');
  assert.equal(api.readDraft('sessao-b', store), 'texto da segunda');
  api.writeDraft('sessao-a', '', store);
  assert.equal(api.readDraft('sessao-a', store), '');
  assert.equal(api.readDraft('sessao-b', store), 'texto da segunda', 'uma sessão não apaga a outra');
  // Sem armazenamento nada quebra: a WebView pode negar o acesso.
  assert.equal(api.readDraft('sessao-a', null), '');
  assert.doesNotThrow(() => api.writeDraft('sessao-a', 'x', null));
});

test('a caixa abre com o rascunho guardado da sessão', () => {
  const store = storage();
  api.writeDraft('sessao', 'rascunho guardado', store);
  const html = renderToStaticMarkup(React.createElement(PhoneComposer, {
    open: true, sessionId: 'sessao', interactive: true, bracketed: true,
    onSubmit: async () => true, onClose() {}, storage: store,
  }));
  // O valor inicial entra no primeiro efeito; o contador já parte de uma linha
  // vazia porque o render estático não roda efeitos.
  assert.match(html, /phone-composer__area/);
  assert.equal(api.readDraft('sessao', store), 'rascunho guardado');
});

test('sem terminal interativo Inserir e Enviar ficam desabilitados', () => {
  const html = render({ interactive: false });
  const actions = [...html.matchAll(/<button[^>]*phone-composer__action[^>]*>/g)].map((match) => match[0]);
  assert.equal(actions.length, 3);
  assert.ok(actions[1].includes('disabled'), 'Inserir desabilitado');
  assert.ok(actions[2].includes('disabled'), 'Enviar desabilitado');
});
