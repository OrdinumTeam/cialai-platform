import { afterEach, beforeEach, expect, jest, test } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { AppState, Text } from 'react-native';

import App from './App';
import { setLocale } from './src/i18n';

const mockTunnel = {
  listeners: new Set(),
  connect: jest.fn(),
  openDesktop: jest.fn(),
  closeDesktop: jest.fn(async () => {}),
  forgetDesktop: jest.fn(async () => {}),
  status: jest.fn(),
  notifyForeground: jest.fn(),
  notifyNetworkChange: jest.fn()
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

async function render() {
  let tree;
  await act(async () => { tree = create(<App />); });
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
  expect(mockTunnel.openDesktop).toHaveBeenCalledWith(desktopId, token);
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
  // Duas falhas seguidas com a sondagem longa também sem resposta: reconecta.
  mockHealth.mockResolvedValue(false);
  mockTunnel.openDesktop.mockResolvedValue({ url: `http://127.0.0.1:47405/?k=${'P'.repeat(43)}`, port: 47405, nonce: 'P'.repeat(43) });
  await advance(10_000);
  await advance(10_000);
  expect(mockTunnel.openDesktop).toHaveBeenCalledTimes(2);
  expect(webView().props.source.uri).toContain('47405');
  await act(async () => tree.unmount());
});

test('the appearance chosen in settings reaches the page and is remembered', async () => {
  const tree = await render();
  const webView = () => tree.root.findAll(node => typeof node.props.injectedJavaScriptBeforeContentLoaded === 'string')[0];
  expect(webView().props.injectedJavaScriptBeforeContentLoaded).toContain('"theme":"system"');
  await act(async () => { tree.root.findAll(node => node.props.accessibilityLabel === 'Mostrar computadores')[0].props.onPress(); });
  await flush();
  await act(async () => { tree.root.findAll(node => node.props.accessibilityLabel === 'Abrir ajustes')[0].props.onPress(); });
  await flush();
  const dark = tree.root.findAll(node => node.props.accessibilityLabel === 'Escuro' && typeof node.props.onPress === 'function')[0];
  await act(async () => { dark.props.onPress(); });
  await flush();
  expect(mockSecure.get('cialai.theme')).toBe('dark');
  await act(async () => tree.unmount());
});

test('the biometric policy chosen in settings is remembered', async () => {
  const tree = await render();
  await act(async () => { tree.root.findAll(node => node.props.accessibilityLabel === 'Mostrar computadores')[0].props.onPress(); });
  await flush();
  await act(async () => { tree.root.findAll(node => node.props.accessibilityLabel === 'Abrir ajustes')[0].props.onPress(); });
  await flush();
  const off = tree.root.findAll(node => node.props.accessibilityLabel === 'Desligada' && typeof node.props.onPress === 'function')[0];
  await act(async () => { off.props.onPress(); });
  await flush();
  expect(mockSecure.get('cialai.biometrics')).toBe('off');
  expect(text(tree)).toMatch(/Nunca pede confirmação/);
  await act(async () => tree.unmount());
});

test('the Android native reopening is awaited and then opens the new proxy', async () => {
  const tree = await render();
  await emit('state', { state: 'reconnecting', desktopId });
  expect(text(tree)).toMatch(/Procurando o melhor caminho/);
  await advance(20_000);
  expect(mockTunnel.connect).toHaveBeenCalledTimes(1);

  mockTunnel.status.mockResolvedValue({ state: 'connected', active: { desktopId, transport: 'direct', path: 'direct', since: 1 },
    tor: { state: 'ready', progress: 100 }, desktops: 1 });
  await emit('proxy', { state: 'reopened', desktopId, url: `http://127.0.0.1:47402/?k=${'O'.repeat(43)}` });
  expect(text(tree)).toMatch(/Direta/);
  expect(tree.root.findAll(node => node.props.source?.uri)[0].props.source.uri).toContain('47402');
  await act(async () => tree.unmount());
});
