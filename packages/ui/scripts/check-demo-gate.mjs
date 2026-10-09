// SPDX-License-Identifier: Apache-2.0
// Dados fictícios só em navegador puro. Dentro do app do computador ou da
// página aberta pelo celular, as chaves de demonstração da URL são ignoradas.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { demoParam, hostedInApp } from '../src/lib/demo.js';

const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const browser = (search) => ({ location: { search } });

test('a chave vale no navegador puro e some dentro dos apps', () => {
  assert.equal(demoParam('terminais', undefined, browser('?terminais=demo')), 'demo');
  assert.equal(demoParam('notch', '?notch=demo:many', browser('')), 'demo:many');
  for (const host of [{ __TAURI_INTERNALS__: {} }, { __CIALAI_SHELL__: { type: 'shell' } }, { ReactNativeWebView: {} }]) {
    const win = { ...browser('?terminais=demo&tunnel=demo&notch=demo:basic'), ...host };
    assert.equal(hostedInApp(win), true);
    for (const name of ['terminais', 'tunnel', 'notch']) assert.equal(demoParam(name, undefined, win), null, name);
  }
  assert.equal(hostedInApp(undefined), false);
  assert.equal(demoParam('terminais', '%%%', browser('')), null);
});

test('toda leitura de chave de demonstração passa pela trava', () => {
  const readers = {
    '../src/terminals/runtime.js': "demoParam('terminais')",
    '../src/terminals/files.js': "demoParam('terminais')",
    '../src/terminals/agent-profiles-demo.js': "demoParam('terminais', search)",
    '../src/desktop/TunnelContext.jsx': "demoParam('tunnel')",
    '../src/notch/fixtures.js': "demoParam('notch', search)",
  };
  for (const [file, call] of Object.entries(readers)) {
    const text = source(file);
    assert.ok(text.includes(call), `${file} usa ${call}`);
    assert.doesNotMatch(text, /get\('(terminais|tunnel|notch)'\)/, `${file} não lê a chave sozinho`);
  }
});
