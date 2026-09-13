// SPDX-License-Identifier: Apache-2.0
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const vm = require('node:vm');
const { build } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

async function bundle(entryPoint) {
  const result = await build({ entryPoints: [entryPoint], bundle: true, write: false, outfile: 'bundle.js', format: 'cjs', external: ['react'] });
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
  assert.equal(browser.context.module.exports.translate('navigation.more'), 'Más');
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
  const markup = renderToStaticMarkup(React.createElement(Toolbar, {
    view: { id: 'terminais', label: 'Terminales', sub: 'Sesiones' },
    sidebarHidden: false,
    onToggleSidebar() {},
    onOpenPalette() {},
    onReload() {},
    appearance: { resolved: 'light', setMode() {} },
    onOpenPreferences() {},
    tunnelStatus: null,
    onOpenPair() {},
    menuActions: {},
    views: [],
  }));
  assert.match(markup, /Mostrar u ocultar la barra lateral/);
  assert.match(markup, /Vincular teléfono/);
  assert.match(markup, /Red no configurada/);
});
