// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const vm = require('node:vm');
const { build } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

async function bundle(entryPoint) {
  // A toolbar mostra a assinatura com a lateral fechada; a imagem entra
  // embutida, como no fixture do terminal do celular.
  const result = await build({ entryPoints: [entryPoint], bundle: true, write: false, outfile: 'bundle.js', format: 'cjs', external: ['react'], loader: { '.png': 'dataurl' } });
  return result.outputFiles.find((file) => file.path.endsWith('.js')).text;
}

function browserContext({ locale = 'es-MX', stored = null } = {}) {
  const values = new Map(stored ? [['cialai_language', stored]] : []);
  const documentElement = { dataset: {}, lang: '' };
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    require: createRequire(__filename),
    document: { documentElement, addEventListener() {}, removeEventListener() {} },
    history: { replaceState() {} },
    localStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
    navigator: { language: locale, languages: [locale], userAgent: 'Mac' },
    window: { location: { hash: '', search: '' }, addEventListener() {}, removeEventListener() {} },
    URLSearchParams,
  });
  return { context, documentElement, values };
}

test('desktop detects Spanish and persists a normalized selection', async () => {
  const source = await bundle('src/desktop/i18n.js');
  const browser = browserContext();
  vm.runInContext(source, browser.context);

  assert.equal(browser.context.module.exports.getLocale(), 'es');
  assert.equal(browser.context.module.exports.translate('view.terminais.label'), 'Terminales');
  assert.equal(browser.documentElement.lang, 'es');
  assert.equal(browser.context.module.exports.setLocale('en-US'), 'en');
  assert.equal(browser.values.get('cialai_language'), 'en');
  assert.equal(browser.documentElement.lang, 'en');
});

test('desktop toolbar renders the selected Spanish locale', async () => {
  const source = await bundle('src/desktop/Toolbar.jsx');
  const browser = browserContext();
  vm.runInContext(source, browser.context);
  const Toolbar = browser.context.module.exports.default;
  const props = (sidebarHidden) => ({
    view: { id: 'terminais', label: 'Terminales', sub: 'Sesiones' },
    sidebarHidden,
    onToggleSidebar() {},
    onOpenPalette() {},
    onReload() {},
    appearance: { resolved: 'light', setMode() {} },
    onOpenPreferences() {},
    tunnelStatus: null,
    onOpenPair() {},
    menuActions: {},
    views: [],
  });
  const markup = renderToStaticMarkup(React.createElement(Toolbar, props(false)));
  assert.match(markup, /Mostrar u ocultar la barra lateral/);
  assert.match(markup, /Vincular teléfono/);
  assert.match(markup, /Preparando el acceso/);
  // Com a lateral aberta a assinatura e dela; fechada, o lettering passa
  // para a toolbar.
  assert.doesNotMatch(markup, /mac-toolbar__wordmark/);
  const hidden = renderToStaticMarkup(React.createElement(Toolbar, props(true)));
  // So a peca do tema atual entra na pagina: a escondida por CSS seria
  // baixada do mesmo jeito. Sem tema escuro marcado, a de cores.
  assert.match(hidden, /class="mac-toolbar__wordmark mac-toolbar__wordmark--light"/);
  assert.doesNotMatch(hidden, /mac-toolbar__wordmark--dark/);
  assert.equal((hidden.match(/alt="Cialai"/g) || []).length, 1);
});
