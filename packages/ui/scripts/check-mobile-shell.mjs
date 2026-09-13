// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const bundle = await build({
  entryPoints: ['src/mobile/MobileHeader.jsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  external: ['react'],
});

function header(connection) {
  const context = vm.createContext({ module: { exports: {} }, exports: {}, require: createRequire(import.meta.url) });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return renderToStaticMarkup(React.createElement(context.module.exports.default, {
    desktopName: 'MacBook de Foco', connection,
  }));
}

test('o cabecalho mostra computador e estado em todos os momentos', () => {
  assert.match(header('connected'), /MacBook de Foco/);
  assert.match(header('connected'), /Conectado/);
  assert.match(header('connecting'), /Conectando/);
  assert.match(header('removed'), /Celular removido/);
});

test('a composicao do celular contem somente Terminais', async () => {
  const source = await readFile('src/mobile/MobileApp.jsx', 'utf8');
  assert.match(source, /VIEW_COMPONENTS\.terminais/);
  assert.doesNotMatch(source, /TabBar|MoreSheet|PHONE_TABS/);
});
