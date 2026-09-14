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

const i18nBundle = await build({
  entryPoints: ['src/mobile/i18n.js'],
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

function mobileTranslation(shellLocale, storedLocale) {
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    require: createRequire(import.meta.url),
    document: { documentElement: { lang: '' } },
    localStorage: { getItem: () => storedLocale, setItem() {} },
    navigator: { language: 'pt-BR', languages: ['pt-BR'] },
    __CIALAI_SHELL__: { locale: shellLocale },
  });
  vm.runInContext(i18nBundle.outputFiles[0].text, context);
  return context.module.exports.translate('view.terminais.label');
}

test('o cabecalho mostra computador e estado em todos os momentos', () => {
  assert.match(header('connected'), /MacBook de Foco/);
  assert.match(header('connected'), /Conectado/);
  assert.match(header('connecting'), /Conectando/);
  assert.match(header('removed'), /Celular removido/);
});

test('o idioma enviado pelo aplicativo prevalece na pagina do celular', () => {
  assert.equal(mobileTranslation('es-MX', 'pt-BR'), 'Terminales');
});

test('a composicao do celular contem somente Terminais', async () => {
  const source = await readFile('src/mobile/MobileApp.jsx', 'utf8');
  assert.match(source, /VIEW_COMPONENTS\.terminais/);
  assert.doesNotMatch(source, /TabBar|MoreSheet|PHONE_TABS/);
});

test('navigate-back percorre a ponte nos dois sentidos', async () => {
  const shellBundle = await build({
    entryPoints: ['src/lib/shell.js'],
    bundle: true,
    write: false,
    format: 'cjs',
  });
  const sent = [];
  const shellContext = vm.createContext({
    module: { exports: {} },
    exports: {},
    window: { ReactNativeWebView: { postMessage: (message) => sent.push(message) } },
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(shellBundle.outputFiles[0].text, shellContext);
  let received = 0;
  shellContext.module.exports.onNavigateBack(() => { received += 1; });
  shellContext.module.exports.receiveShellMessage({ type: 'navigate-back' });
  shellContext.module.exports.requestNavigateBack();
  assert.equal(received, 1);
  assert.deepEqual(sent, ['{"type":"navigate-back"}']);
});
