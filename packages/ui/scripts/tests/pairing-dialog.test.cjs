// SPDX-License-Identifier: Apache-2.0
// Diálogo de pareamento com a rede caída: o lugar do QR mostra o motivo real,
// a pasta do app.log e o atalho para o diagnóstico, em vez de ficar em
// "Preparando a conexão…" sem explicação, como acontecia no Linux quando o
// sidecar ou o bundle do celular não eram encontrados.
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { build } = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const entry = path.resolve(__dirname, '../../src/desktop/PairingDialog.jsx');
const source = readFileSync(entry, 'utf8');

// A ponte, o contexto do túnel e o modal do MUI ficam de fora: o teste olha o
// que o diálogo decide mostrar a partir do retrato da rede.
const mocks = {
  TunnelContext: `export const useTunnel = () => globalThis.fixture.tunnel;
    export const tunnelErrorMessage = (error) => String(error?.message || error);`,
  ui: `import React from 'react';
    export const AppModal = ({ title, children }) => React.createElement('section', { 'data-title': title }, children);`,
  native: `export const invoke = (command) => globalThis.fixture.invoke(command);
    export const isTauri = () => globalThis.fixture.tauri;`,
};

async function load() {
  const result = await build({
    entryPoints: [entry],
    bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react', 'qrcode'],
    plugins: [{ name: 'pairing-boundaries', setup(api) {
      api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path: imported }) => {
        const key = imported.split('/').at(-1).replace(/\.jsx?$/, '');
        if (mocks[key]) return { path: key, namespace: 'fixture' };
        return undefined;
      });
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: key }) => ({ contents: mocks[key], loader: 'jsx', resolveDir: path.dirname(entry) }));
    } }],
  });
  const context = vm.createContext({
    module: { exports: {} },
    exports: {},
    require: createRequire(__filename),
    globalThis: undefined,
    window: { dispatchEvent() {} },
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
    fixture: null,
    console,
  });
  context.globalThis = context;
  vm.runInContext(result.outputFiles[0].text, context);
  return { PairingDialog: context.module.exports.default, context };
}

const stoppedSnapshot = () => ({ startup: 'starting', supervisor: 'running', net: null, tor: null });

function tunnelFixture(over = {}) {
  return {
    desktopName: 'Linux de teste',
    snapshot: stoppedSnapshot(),
    lastError: '',
    pairEvent: null,
    beginPair: async () => { throw new Error('não deve pedir QR'); },
    cancelPair: async () => {},
    decidePair: async () => {},
    clearPairEvent() {},
    ...over,
  };
}

function render(PairingDialog, context, tunnel, { tauri = false } = {}) {
  const invoked = [];
  context.fixture = { tunnel, tauri, invoke(command) { invoked.push(command); return Promise.resolve({ logs: '/home/ana/.local/share/br.com.ordinum.cialai/logs' }); } };
  const markup = renderToStaticMarkup(React.createElement(PairingDialog, { open: true, onClose() {}, onDevices() {} }));
  return { markup, invoked };
}

test('enquanto a rede sobe o diálogo só espera, sem bloco de problema', async () => {
  const { PairingDialog, context } = await load();
  const { markup } = render(PairingDialog, context, tunnelFixture());
  assert.match(markup, /Preparando a conexão…/);
  assert.doesNotMatch(markup, /mac-pair__problem/);
  assert.doesNotMatch(markup, /A conexão não pôde ser preparada/);
  assert.match(markup, /Novo código em/, 'os cronômetros continuam na espera normal');
});

test('net.start que falhou no Rust mostra o motivo real, o app.log e o diagnóstico', async () => {
  const { PairingDialog, context } = await load();
  const reason = 'bundle da página do celular não encontrado em /usr/lib/cialai/resources/mobile';
  const tunnel = tunnelFixture({ snapshot: { startup: 'failed', supervisor: 'idle', net: null, tor: null }, lastError: reason });
  const { markup } = render(PairingDialog, context, tunnel);
  assert.match(markup, /A conexão não pôde ser preparada\./, 'o lugar do QR diz que a rede não vai subir');
  assert.doesNotMatch(markup, /Preparando a conexão…/);
  assert.ok(markup.includes(reason), 'o motivo guardado pela interface aparece como está');
  assert.match(markup, /O motivo completo fica em app\.log, na pasta de registros do Cialai\./, 'sem caminho conhecido a frase aponta a pasta de registros');
  assert.match(markup, /Diagnóstico avançado/, 'botão para o diagnóstico avançado');
  assert.match(markup, /mac-pair__problem/);
  assert.match(markup, /is-expired/, 'o quadro do QR perde o anel de progresso');
  assert.doesNotMatch(markup, /Novo código em/, 'sem cronômetros quando não há código');
  assert.doesNotMatch(markup, /Gerar outro código/, 'gerar outro código não resolve rede caída');
  assert.doesNotMatch(markup, /[()]|–|—/, 'texto visível sem parênteses nem travessão');
});

test('erro guardado pelo sidecar vence o da última chamada', async () => {
  const { PairingDialog, context } = await load();
  const net = {
    state: 'failed', desktop: null,
    direct: { state: 'failed', port: null, candidates: [], mapping: { protocol: 'none' }, stun: { state: 'disabled' } },
    tor: { state: 'disabled', progress: 0, onion: '', published: false, error: '' },
    mdns: { state: 'disabled' }, edge: { state: 'stopped' }, sessions: { direct: 0, tor: 0 },
    error: { code: 'onion_key', message: 'A chave do endereço de reserva não pôde ser lida.' },
  };
  const tunnel = tunnelFixture({ snapshot: { startup: 'started', supervisor: 'running', net, tor: net.tor }, lastError: 'motivo antigo' });
  const { markup } = render(PairingDialog, context, tunnel);
  assert.match(markup, /A chave do endereço de reserva não pôde ser lida\./);
  assert.doesNotMatch(markup, /motivo antigo/);
});

test('supervisor que esgotou os reinícios também expõe o problema', async () => {
  const { PairingDialog, context } = await load();
  const tunnel = tunnelFixture({ snapshot: { startup: 'started', supervisor: 'failed', net: null, tor: null }, lastError: '' });
  const { markup } = render(PairingDialog, context, tunnel);
  assert.match(markup, /A conexão não pôde ser preparada\./);
  assert.match(markup, /Diagnóstico avançado/);
  assert.doesNotMatch(markup, /role="alert"/, 'sem motivo conhecido não há linha vazia de alerta');
});

test('a fonte pede a pasta de registros ao app e leva ao diagnóstico pelo evento das Preferências', () => {
  assert.match(source, /invoke\('app_paths'\)/, 'a pasta do app.log vem do comando que as Preferências já usam');
  assert.match(source, /desktop\.pair\.networkFailedLog', \{ path: logDirectory \}/, 'a frase com caminho recebe a pasta de registros');
  assert.match(source, /onClose\(\);\s*if \(onDiagnostics\) onDiagnostics\(\);\s*else window\.dispatchEvent\(new CustomEvent\('cialai:network-diagnostics'\)\)/, 'fecha o diálogo e abre o diagnóstico avançado');
  assert.match(source, /networkFailed\(tunnel\.snapshot\)/);
  assert.match(source, /networkFailureReason\(tunnel\.snapshot, tunnel\.lastError\)/);
});
