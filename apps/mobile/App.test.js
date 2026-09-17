import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { AppState, Text } from 'react-native';

import App, { HOME_PROXY_GRACE_MS, LAST_CONNECTION_FAILED_KEY, SHELL_RECONNECT_DEADLINE_MS } from './App';
import { setLocale } from './src/i18n';
import { clearDiagnostics, recentDiagnostics } from './src/state/diagnostics';

const mockTunnel = {
  listeners: new Set(),
  connect: jest.fn(),
  openDesktop: jest.fn(),
  closeDesktop: jest.fn(async () => {}),
  forgetDesktop: jest.fn(async () => {}),
  status: jest.fn(),
  notifyForeground: jest.fn(),
  notifyNetworkChange: jest.fn(),
  notifyHealthy: jest.fn()
};
const mockHealth = jest.fn(async () => true);
const mockStore = {
  load: jest.fn(),
  save: jest.fn(async () => {}),
  tokens: new Map()
};

jest.mock('cialai-tunnel', () => ({
  addListener: handler => {
    mockTunnel.listeners.add(handler);
    return { remove: () => mockTunnel.listeners.delete(handler) };
  },
  connect: (...args) => mockTunnel.connect(...args),
  openDesktop: (...args) => mockTunnel.openDesktop(...args),
  closeDesktop: (...args) => mockTunnel.closeDesktop(...args),
  forgetDesktop: (...args) => mockTunnel.forgetDesktop(...args),
  status: () => mockTunnel.status(),
  notifyForeground: active => mockTunnel.notifyForeground(active),
  notifyNetworkChange: reachable => mockTunnel.notifyNetworkChange(reachable),
  notifyHealthy: () => mockTunnel.notifyHealthy(),
  setLogLevel: () => {},
  version: () => 'core-test',
  inspectPairPayload: jest.fn(),
  pair: jest.fn()
}));
jest.mock('./src/desktops/store', () => {
  const actual = jest.requireActual('./src/desktops/store');
  return {
    ...actual,
    loadDesktopStore: () => mockStore.load(),
    saveDesktopStore: store => mockStore.save(store),
    readDeviceToken: async desktopId => mockStore.tokens.get(desktopId) ?? null,
    saveDeviceToken: async (desktopId, token) => { mockStore.tokens.set(desktopId, token); },
    deleteDeviceToken: async desktopId => { mockStore.tokens.delete(desktopId); }
  };
});
jest.mock('./src/network/health', () => ({ ...jest.requireActual('./src/network/health'), checkControlHealth: (url, ...rest) => mockHealth(url, ...rest) }));
jest.mock('./src/config/env', () => ({ getAppVersion: () => '1.0.0' }));
jest.mock('@react-native-community/netinfo', () => ({ addEventListener: () => () => {} }));
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
jest.mock('expo-camera', () => ({ CameraView: 'CameraView', useCameraPermissions: () => [{ granted: false }, jest.fn()] }));
jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn(async () => '') }));
const mockSecure = new Map();
jest.mock('expo-secure-store', () => ({
  getItemAsync: async key => mockSecure.get(key) ?? null,
  setItemAsync: async (key, value) => { mockSecure.set(key, value); },
  deleteItemAsync: async key => { mockSecure.delete(key); },
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'unlocked'
}));

const desktopId = 'd_AAAAAAAAAAAAAAAAAAAAAA';
const token = `cdt1.dev_AAAAAAAAAAAAAAAAAAAAAA.${'s'.repeat(43)}`;
const rotated = `cdt1.dev_AAAAAAAAAAAAAAAAAAAAAA.${'r'.repeat(43)}`;
const proxyUrl = `http://127.0.0.1:47400/?k=${'N'.repeat(43)}`;
const stored = {
  version: 2,
  lastDesktopId: desktopId,
  desktops: [{ id: desktopId, name: 'Mac de Foco', fingerprint: '0123456789abcdef', deviceId: 'dev_AAAAAAAAAAAAAAAAAAAAAA',
    pairedAt: '2026-09-12T12:00:00.000Z', lastSeenAt: '2026-09-12T12:00:00.000Z', lastTransport: 'direct' }]
};

const text = tree => tree.root.findAllByType(Text).map(node => node.props.children).flat(Infinity).join(' ');
const coded = code => Object.assign(new Error('mensagem do núcleo'), { code });
const labelled = (tree, label) => tree.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
const pressable = (tree, label) => tree.root.findAll(node => typeof node.props.onPress === 'function' &&
  node.findAllByType(Text).some(child => [child.props.children].flat(Infinity).join('') === label))[0];

async function press(tree, label) {
  await act(async () => { labelled(tree, label).props.onPress(); });
  await flush();
}

async function flush() {
  await act(async () => {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
  });
}

async function advance(ms) {
  await act(async () => { jest.advanceTimersByTime(ms); });
  await flush();
}

async function emit(kind, payload) {
  await act(async () => {
    for (const listener of mockTunnel.listeners) listener({ kind, payload });
  });
  await flush();
}

// Cada montagem do WebView pede um nó falso novo: contar os pedidos diz se ele foi remontado.
const webViewMounts = [];
const createNodeMock = element => {
  if (element.type !== 'WebView') return null;
  const node = { injectJavaScript: jest.fn(), reload: jest.fn() };
  webViewMounts.push(node);
  return node;
};

async function render() {
  let tree;
  await act(async () => { tree = create(<App />, { createNodeMock }); });
  await flush();
  return tree;
}

beforeEach(async () => {
  jest.useFakeTimers();
  await setLocale('pt-BR');
  mockTunnel.listeners.clear();
  for (const mock of [mockTunnel.connect, mockTunnel.openDesktop, mockTunnel.closeDesktop, mockTunnel.status, mockStore.load, mockStore.save]) {
    mock.mockClear();
  }
  mockStore.tokens = new Map([[desktopId, token]]);
  mockHealth.mockReset();
  mockHealth.mockResolvedValue(true);
  mockTunnel.notifyForeground.mockClear();
  mockTunnel.notifyHealthy.mockClear();
  webViewMounts.length = 0;
  mockSecure.clear();
  clearDiagnostics();
  mockStore.load.mockResolvedValue({ store: stored, legacyDiscarded: false });
  mockTunnel.status.mockResolvedValue({ state: 'connected', active: null, tor: { state: 'ready', progress: 100 }, desktops: 1 });
  mockTunnel.connect.mockResolvedValue({ desktopId, transport: 'tor', path: 'tor', elapsedMs: 4_000 });
  mockTunnel.openDesktop.mockResolvedValue({ url: proxyUrl, port: 47400, nonce: 'N'.repeat(43) });
});

afterEach(() => {
  jest.useRealTimers();
});

test('opens the last desktop with connect then the stored token and follows path events', async () => {
  const tree = await render();
  expect(mockTunnel.connect).toHaveBeenCalledWith(desktopId);
  expect(mockTunnel.openDesktop).toHaveBeenCalledWith(desktopId, token, 0);
  expect(text(tree)).toMatch(/Mac de Foco/);
  expect(text(tree)).toMatch(/Reserva/);
  expect(mockStore.save).toHaveBeenLastCalledWith(expect.objectContaining({
    desktops: [expect.objectContaining({ id: desktopId, lastTransport: 'tor' })]
  }));

  await emit('path', { desktopId, transport: 'direct', path: 'lan', reason: 'upgrade' });
  expect(text(tree)).toMatch(/Direta/);
  expect(mockStore.save).toHaveBeenLastCalledWith(expect.objectContaining({
    desktops: [expect.objectContaining({ lastTransport: 'direct' })]
  }));

  await emit('proxy', { state: 'token-rotated', desktopId, deviceToken: rotated });
  expect(mockStore.tokens.get(desktopId)).toBe(rotated);
  await act(async () => tree.unmount());
});

test('a revocation removes the token and never retries', async () => {
  const tree = await render();
  await emit('proxy', { state: 'revoked', desktopId });
  expect(text(tree)).toMatch(/Este celular foi removido/);
  expect(mockStore.tokens.has(desktopId)).toBe(false);
  expect(mockTunnel.closeDesktop).toHaveBeenCalledWith(desktopId);
  const calls = mockTunnel.connect.mock.calls.length;
  await advance(120_000);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(calls);
  await act(async () => tree.unmount());
});

test('a revoked connect error shows the removed screen without a new attempt', async () => {
  mockTunnel.connect.mockRejectedValue(coded('revoked'));
  const tree = await render();
  expect(text(tree)).toMatch(/Este celular foi removido/);
  expect(mockStore.tokens.has(desktopId)).toBe(false);
  expect(mockTunnel.openDesktop).not.toHaveBeenCalled();
  await advance(60_000);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

test('waits for the reserve with progress and connects when it is ready', async () => {
  mockTunnel.connect.mockRejectedValueOnce(coded('reserve_preparing'));
  const tree = await render();
  expect(text(tree)).toMatch(/Preparando a conexão de reserva/);
  await emit('tor', { state: 'bootstrapping', progress: 55 });
  expect(text(tree)).toMatch(/Preparando 55%/);
  await advance(3_000);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(2);
  expect(text(tree)).toMatch(/Mac de Foco/);
  expect(text(tree)).toMatch(/Reserva/);
  await act(async () => tree.unmount());
});

test('without a path it retries at 2, 4, 8 and 16 seconds', async () => {
  mockTunnel.connect.mockRejectedValue(coded('no_path'));
  const tree = await render();
  expect(text(tree)).toMatch(/O computador está fora de alcance/);
  for (const [delay, calls] of [[2_000, 2], [4_000, 3], [8_000, 4], [16_000, 5], [16_000, 6]]) {
    await advance(delay);
    expect(mockTunnel.connect).toHaveBeenCalledTimes(calls);
  }
  mockTunnel.connect.mockRejectedValue(coded('reserve_unavailable'));
  await advance(16_000);
  expect(text(tree)).toMatch(/Conexão de reserva indisponível/);
  await act(async () => tree.unmount());
});

test('a missing token asks to pair that desktop again', async () => {
  mockStore.tokens = new Map();
  const tree = await render();
  expect(mockTunnel.connect).not.toHaveBeenCalled();
  expect(text(tree)).toMatch(/Vincule Mac de Foco de novo para continuar/);
  expect(mockStore.save).toHaveBeenLastCalledWith({ version: 2, desktops: [], lastDesktopId: null });
  await act(async () => tree.unmount());
});

test('discarded Headscale profiles lead to pairing with a notice', async () => {
  mockStore.load.mockResolvedValue({ store: { version: 2, desktops: [], lastDesktopId: null }, legacyDiscarded: true });
  const tree = await render();
  expect(text(tree)).toMatch(/Esta versão do Cialai conecta de um jeito novo/);
  expect(mockTunnel.connect).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});

function captureAppState() {
  const handlers = [];
  const original = AppState.addEventListener;
  AppState.addEventListener = (type, handler) => {
    handlers.push(handler);
    return { remove: () => {} };
  };
  return {
    restore: () => { AppState.addEventListener = original; },
    change: async state => {
      await act(async () => { for (const handler of handlers) handler(state); });
      await flush();
    }
  };
}

test('returning from the background reconnects from zero when the proxy stopped answering', async () => {
  const appState = captureAppState();
  const tree = await render();
  expect(mockTunnel.connect).toHaveBeenCalledTimes(1);

  await appState.change('background');
  expect(mockTunnel.notifyForeground).toHaveBeenLastCalledWith(false);
  mockHealth.mockResolvedValue(false);
  mockTunnel.openDesktop.mockResolvedValue({ url: `http://127.0.0.1:47401/?k=${'M'.repeat(43)}`, port: 47401, nonce: 'M'.repeat(43) });
  await appState.change('active');
  expect(mockTunnel.notifyForeground).toHaveBeenLastCalledWith(true);
  expect(mockHealth).toHaveBeenCalledWith(proxyUrl);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(2);
  const webView = tree.root.findAll(node => node.props.source?.uri)[0];
  expect(webView.props.source.uri).toContain('47401');
  await act(async () => tree.unmount());
  appState.restore();
});

test('returning from the background keeps a proxy that still answers', async () => {
  const appState = captureAppState();
  const tree = await render();
  await appState.change('inactive');
  await appState.change('active');
  expect(mockTunnel.notifyForeground).not.toHaveBeenCalled();
  await appState.change('background');
  await appState.change('active');
  expect(mockHealth).toHaveBeenCalledTimes(1);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(1);
  // O proxy sobreviveu: o nativo do iOS não precisa recomeçar do zero na próxima conexão.
  expect(mockTunnel.notifyHealthy).toHaveBeenCalledTimes(1);
  expect(text(tree)).toMatch(/Mac de Foco/);
  await act(async () => tree.unmount());
  appState.restore();
});

test('a single failed probe or a slow backup never reopens a proxy the core still holds', async () => {
  const tree = await render();
  const webView = () => tree.root.findAll(node => node.props.source?.uri)[0];
  expect(mockTunnel.connect).toHaveBeenCalledTimes(1);
  // Primeira sondagem sem resposta: só conta uma falha.
  mockHealth.mockResolvedValueOnce(false);
  await advance(10_000);
  expect(mockTunnel.openDesktop).toHaveBeenCalledTimes(1);
  // Segunda falha seguida: o núcleo diz que o caminho está ativo e a sondagem
  // longa responde, então a página fica como está.
  mockTunnel.status.mockResolvedValue({ state: 'connected', active: { desktopId, transport: 'tor', path: 'tor', since: 1 },
    tor: { state: 'ready', progress: 100 }, desktops: 1 });
  mockHealth.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await advance(10_000);
  expect(mockHealth).toHaveBeenLastCalledWith(proxyUrl, expect.anything(), 20_000);
  expect(mockTunnel.openDesktop).toHaveBeenCalledTimes(1);
  expect(webView().props.source.uri).toBe(proxyUrl);
  expect(text(tree)).toMatch(/Mac de Foco/);
  // Duas falhas seguidas com a sondagem longa também sem resposta: reconecta
  // pedindo a mesma porta; o proxy voltou em outra e a página recarrega sem remontar.
  mockHealth.mockResolvedValue(false);
  mockTunnel.openDesktop.mockResolvedValue({ url: `http://127.0.0.1:47405/?k=${'P'.repeat(43)}`, port: 47405, nonce: 'P'.repeat(43) });
  await advance(10_000);
  await advance(10_000);
  expect(mockTunnel.openDesktop).toHaveBeenCalledTimes(2);
  expect(mockTunnel.openDesktop).toHaveBeenLastCalledWith(desktopId, token, 47400);
  expect(webView().props.source.uri).toContain('47405');
  expect(webViewMounts).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('a transient health loss keeps the WebView mounted behind the reconnecting banner and reuses the proxy', async () => {
  const tree = await render();
  const webView = () => tree.root.findAll(node => node.props.source?.uri)[0];
  expect(webViewMounts).toHaveLength(1);
  expect(text(tree)).not.toMatch(/Reconectando/);
  // Duas sondagens sem resposta: a faixa entra enquanto o proxy é reaberto, a página fica.
  mockTunnel.status.mockResolvedValue({ state: 'connected', active: null, tor: { state: 'ready', progress: 100 }, desktops: 1 });
  mockHealth.mockResolvedValue(false);
  let finishOpen;
  mockTunnel.openDesktop.mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve; }));
  await advance(10_000);
  await advance(10_000);
  expect(text(tree)).toMatch(/Reconectando/);
  expect(text(tree)).toMatch(/Mac de Foco/);
  expect(text(tree)).not.toMatch(/Procurando o melhor caminho/);
  expect(webViewMounts).toHaveLength(1);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(2);
  expect(mockTunnel.openDesktop).toHaveBeenLastCalledWith(desktopId, token, 47400);
  // O núcleo devolveu o mesmo proxy: mesma URL, mesmo source, a faixa sai e nada recarrega.
  await act(async () => { finishOpen({ url: proxyUrl, port: 47400, nonce: 'N'.repeat(43) }); });
  await flush();
  expect(text(tree)).not.toMatch(/Reconectando/);
  expect(webView().props.source.uri).toBe(proxyUrl);
  expect(webViewMounts).toHaveLength(1);
  // Nova perda com a reabertura falhando: a página fica atrás da faixa e a
  // próxima sondagem boa a devolve ao normal, ainda sem remontar.
  mockTunnel.status.mockResolvedValue({ state: 'connecting', active: null, tor: { state: 'ready', progress: 100 }, desktops: 1 });
  mockTunnel.connect.mockRejectedValueOnce(coded('no_path'));
  await advance(10_000);
  await advance(10_000);
  expect(text(tree)).toMatch(/Reconectando/);
  expect(tree.root.findAll(node => node.props.source?.uri)).toHaveLength(1);
  mockHealth.mockResolvedValue(true);
  await advance(10_000);
  expect(text(tree)).not.toMatch(/Reconectando/);
  expect(text(tree)).toMatch(/Mac de Foco/);
  expect(webViewMounts).toHaveLength(1);
  expect(recentDiagnostics().map(line => line.message)).toEqual(expect.arrayContaining([
    'app: shell reconnecting: two health probes in a row failed',
    'app: proxy reused over tor; page kept',
    'app: open failed with no-path; page kept within the reconnect deadline',
    'app: shell recovered: the health probe answered'
  ]));
  await act(async () => tree.unmount());
});

test('a health loss confirmed by the core as offline leaves the page for the offline screen', async () => {
  const tree = await render();
  mockTunnel.status.mockResolvedValue({ state: 'offline', active: null, tor: { state: 'ready', progress: 100 }, desktops: 1 });
  mockHealth.mockResolvedValue(false);
  mockTunnel.connect.mockRejectedValue(coded('no_path'));
  await advance(10_000);
  await advance(10_000);
  expect(text(tree)).toMatch(/O computador está fora de alcance/);
  expect(tree.root.findAll(node => node.props.source?.uri)).toHaveLength(0);
  expect(recentDiagnostics().map(line => line.message)).toContain('app: offline reconnecting: the core reports no path');
  await act(async () => tree.unmount());
});

test('a failed reopen keeps the page until the reconnect deadline and then shows the offline screen', async () => {
  const tree = await render();
  const webView = () => tree.root.findAll(node => node.props.source?.uri);
  mockTunnel.status.mockResolvedValue({ state: 'connecting', active: null, tor: { state: 'ready', progress: 100 }, desktops: 1 });
  mockHealth.mockResolvedValue(false);
  mockTunnel.connect.mockRejectedValue(coded('no_path'));
  await advance(10_000);
  await advance(10_000);
  expect(text(tree)).toMatch(/Reconectando/);
  expect(webView()).toHaveLength(1);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(2);
  await advance(SHELL_RECONNECT_DEADLINE_MS);
  expect(text(tree)).not.toMatch(/Reconectando/);
  expect(webView()).toHaveLength(0);
  expect(text(tree)).toMatch(/Procurando o melhor caminho|O computador está fora de alcance/);
  expect(webViewMounts).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('the offline screen retries as soon as the core announces a path', async () => {
  mockTunnel.connect.mockRejectedValue(coded('no_path'));
  const tree = await render();
  expect(text(tree)).toMatch(/O computador está fora de alcance/);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(1);
  mockTunnel.connect.mockResolvedValue({ desktopId, transport: 'direct', path: 'lan', elapsedMs: 300 });
  await emit('path', { desktopId, transport: 'direct', path: 'lan', reason: 'adopt' });
  expect(mockTunnel.connect).toHaveBeenCalledTimes(2);
  expect(text(tree)).toMatch(/Mac de Foco/);
  expect(text(tree)).toMatch(/Direta/);
  await act(async () => tree.unmount());
});

test('the appearance chosen in settings reaches the page and is remembered', async () => {
  const tree = await render();
  const webView = () => tree.root.findAll(node => typeof node.props.injectedJavaScriptBeforeContentLoaded === 'string')[0];
  expect(webView().props.injectedJavaScriptBeforeContentLoaded).toContain('"theme":"system"');
  // Do terminal ao início e do início aos ajustes.
  await press(tree, 'Ir para o início');
  await press(tree, 'Abrir ajustes');
  await press(tree, 'Escuro');
  expect(mockSecure.get('cialai.theme')).toBe('dark');
  // O voltar dos ajustes leva ao início, não à lista.
  await press(tree, 'Ir para o início');
  expect(text(tree)).toMatch(/Continuar/);
  expect(text(tree)).not.toMatch(/Escolha onde deseja continuar/);
  await act(async () => tree.unmount());
});

test('the biometric policy chosen in settings is remembered', async () => {
  const tree = await render();
  await press(tree, 'Ir para o início');
  await press(tree, 'Abrir ajustes');
  await press(tree, 'Desligada');
  expect(mockSecure.get('cialai.biometrics')).toBe('off');
  expect(text(tree)).toMatch(/Nunca pede confirmação/);
  await act(async () => tree.unmount());
});

test('opens on the home without a last computer and the terminal card leads to the list', async () => {
  mockStore.load.mockResolvedValue({ store: { ...stored, lastDesktopId: null }, legacyDiscarded: false });
  const tree = await render();
  expect(mockTunnel.connect).not.toHaveBeenCalled();
  expect(text(tree)).toMatch(/Início/);
  expect(text(tree)).toMatch(/Um vinculado/);
  expect(text(tree)).not.toMatch(/Continuar/);
  await press(tree, 'Abrir o terminal');
  expect(text(tree)).toMatch(/Escolha onde deseja continuar/);
  expect(mockTunnel.connect).not.toHaveBeenCalled();
  // O voltar da lista leva ao início.
  await press(tree, 'Ir para o início');
  expect(text(tree)).toMatch(/Seus computadores a um toque/);
  await act(async () => tree.unmount());
});

test('opens on the home when the last connection failed and continues from there', async () => {
  mockSecure.set(LAST_CONNECTION_FAILED_KEY, 'true');
  const tree = await render();
  expect(mockTunnel.connect).not.toHaveBeenCalled();
  expect(text(tree)).toMatch(/Continuar/);
  expect(text(tree)).toMatch(/Mac de Foco/);
  expect(text(tree)).toMatch(/Não conectado/);
  await press(tree, 'Continuar em Mac de Foco');
  expect(mockTunnel.connect).toHaveBeenCalledTimes(1);
  expect(tree.root.findAll(node => node.props.source?.uri)[0].props.source.uri).toBe(proxyUrl);
  // A conexão boa limpa a marca: a próxima abertura volta direto ao terminal.
  expect(mockSecure.get(LAST_CONNECTION_FAILED_KEY)).toBe('false');
  await act(async () => tree.unmount());
});

test('a failed connection is remembered so the next launch starts on the home', async () => {
  mockTunnel.connect.mockRejectedValue(coded('no_path'));
  const tree = await render();
  expect(text(tree)).toMatch(/O computador está fora de alcance/);
  expect(mockSecure.get(LAST_CONNECTION_FAILED_KEY)).toBe('true');
  // Da tela sem conexão o início fica a um toque e a escada para.
  await press(tree, 'Ir para o início');
  expect(text(tree)).toMatch(/Fora de alcance/);
  const calls = mockTunnel.connect.mock.calls.length;
  await advance(60_000);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(calls);
  await act(async () => tree.unmount());
});

test('going to the home keeps the proxy open and returning to the terminal reuses the same address', async () => {
  const tree = await render();
  const webView = () => tree.root.findAll(node => node.props.source?.uri);
  expect(webView()).toHaveLength(1);
  await press(tree, 'Ir para o início');
  expect(text(tree)).toMatch(/Continuar/);
  expect(text(tree)).toMatch(/Desconectar/);
  expect(webView()).toHaveLength(0);
  expect(mockTunnel.closeDesktop).not.toHaveBeenCalled();
  await advance(HOME_PROXY_GRACE_MS - 1_000);
  expect(mockTunnel.closeDesktop).not.toHaveBeenCalled();
  await press(tree, 'Abrir o terminal');
  expect(mockTunnel.closeDesktop).not.toHaveBeenCalled();
  expect(mockTunnel.openDesktop).toHaveBeenCalledTimes(2);
  expect(webView()[0].props.source.uri).toBe(proxyUrl);
  expect(text(tree)).toMatch(/Mac de Foco/);
  // O prazo antigo não fecha o proxy que voltou a ser a página aberta.
  await advance(HOME_PROXY_GRACE_MS);
  expect(mockTunnel.closeDesktop).not.toHaveBeenCalled();
  expect(recentDiagnostics().map(line => line.message)).toContain(`app: proxy kept for ${HOME_PROXY_GRACE_MS} ms while on the home`);
  await act(async () => tree.unmount());
});

test('the proxy kept for the home closes after the grace period and on an explicit disconnect', async () => {
  const tree = await render();
  await press(tree, 'Ir para o início');
  await advance(HOME_PROXY_GRACE_MS);
  expect(mockTunnel.closeDesktop).toHaveBeenCalledTimes(1);
  expect(mockTunnel.closeDesktop).toHaveBeenCalledWith(desktopId);
  expect(text(tree)).not.toMatch(/Desconectar/);
  expect(recentDiagnostics().map(line => line.message)).toContain(`app: proxy closed ${HOME_PROXY_GRACE_MS} ms after leaving the terminal`);
  // A volta depois do prazo abre o proxy de novo.
  await press(tree, 'Continuar em Mac de Foco');
  expect(mockTunnel.openDesktop).toHaveBeenCalledTimes(2);
  expect(text(tree)).toMatch(/Mac de Foco/);
  await press(tree, 'Ir para o início');
  await act(async () => { pressable(tree, 'Desconectar').props.onPress(); });
  await flush();
  expect(mockTunnel.closeDesktop).toHaveBeenCalledTimes(2);
  expect(text(tree)).not.toMatch(/Desconectar/);
  await advance(HOME_PROXY_GRACE_MS);
  expect(mockTunnel.closeDesktop).toHaveBeenCalledTimes(2);
  await act(async () => tree.unmount());
});

test('the Android native reopening is awaited behind the banner and then opens the new proxy', async () => {
  const tree = await render();
  await emit('state', { state: 'reconnecting', desktopId });
  expect(text(tree)).toMatch(/Reconectando/);
  expect(text(tree)).toMatch(/Mac de Foco/);
  await advance(20_000);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(1);

  mockTunnel.status.mockResolvedValue({ state: 'connected', active: { desktopId, transport: 'direct', path: 'direct', since: 1 },
    tor: { state: 'ready', progress: 100 }, desktops: 1 });
  await emit('proxy', { state: 'reopened', desktopId, url: `http://127.0.0.1:47402/?k=${'O'.repeat(43)}` });
  expect(text(tree)).toMatch(/Direta/);
  expect(text(tree)).not.toMatch(/Reconectando/);
  expect(tree.root.findAll(node => node.props.source?.uri)[0].props.source.uri).toContain('47402');
  expect(webViewMounts).toHaveLength(1);
  await act(async () => tree.unmount());
});

test('core log events reach the diagnostic ring', async () => {
  const tree = await render();
  await emit('log', { level: 'debug', message: 'pathmgr: adopt direct' });
  expect(recentDiagnostics().at(-1)).toMatchObject({ level: 'debug', message: 'pathmgr: adopt direct' });
  await act(async () => tree.unmount());
});
