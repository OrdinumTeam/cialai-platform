// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const vm = require('node:vm');
const { build } = require('esbuild');

async function bundle(entryPoint) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, write: false, outfile: 'bundle.js', format: 'cjs', external: ['react'] });
  return result.outputFiles.find((file) => file.path.endsWith('.js')).text;
}

test('shared interface follows the shell locale and persists later choices', async () => {
  const source = await bundle('src/shared/i18n.js');
  const values = new Map([['cialai_language', 'pt-BR']]);
  const documentElement = { dataset: {}, lang: '' };
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    require: createRequire(__filename),
    document: { documentElement },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    navigator: { language: 'en-US', languages: ['en-US'] },
    __CIALAI_SHELL__: { locale: 'es-MX' },
  });

  vm.runInContext(source, context);
  assert.equal(context.module.exports.getLocale(), 'es');
  assert.equal(context.module.exports.translate('view.terminais.sub'), 'Sesiones, archivos y navegador');
  assert.equal(context.module.exports.translate('shared.action.close'), 'Cerrar');
  assert.equal(context.module.exports.translate('shared.shell.actionCanceled'), 'Acción cancelada. Autoriza en el dispositivo para continuar.');
  assert.equal(context.module.exports.translate('shared.fileManager.generic'), 'administrador de archivos');
  assert.equal(documentElement.lang, 'es');
  assert.equal(documentElement.dataset.locale, 'es');

  assert.equal(context.module.exports.setLocale('en-GB'), 'en');
  assert.equal(values.get('cialai_language'), 'en');
  assert.equal(documentElement.lang, 'en');
});
