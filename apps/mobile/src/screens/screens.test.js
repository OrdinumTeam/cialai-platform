import { beforeEach, expect, jest, test } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { Text } from 'react-native';

import { Desktops } from './Desktops';
import { Offline } from './Offline';
import { Pair } from './Pair';
import { Settings } from './Settings';
import { Shell } from './Shell';
import { getLocale, setLocale } from '../i18n';

const mockListeners = new Set();
const mockPair = jest.fn();
const mockInspect = jest.fn();

jest.mock('cialai-tunnel', () => ({
  addListener: handler => {
    mockListeners.add(handler);
    return { remove: () => mockListeners.delete(handler) };
  },
  inspectPairPayload: (...args) => mockInspect(...args),
  pair: (...args) => mockPair(...args)
}));
jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: false }, jest.fn()]
}));
jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn(async () => 'CIALAI2.payload') }));
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));

const text = tree => tree.root.findAllByType(Text).map(node => node.props.children).flat(Infinity).join(' ');
const pressable = (tree, label) => tree.root.findAll(node => typeof node.props.onPress === 'function' &&
  node.findAllByType(Text).some(child => [child.props.children].flat(Infinity).join('') === label))[0];
const desktopId = 'd_AAAAAAAAAAAAAAAAAAAAAA';
const store = {
  version: 2,
  lastDesktopId: desktopId,
  desktops: [
    { id: desktopId, name: 'Mac de Foco', fingerprint: '0123456789abcdef', deviceId: 'dev_AAAAAAAAAAAAAAAAAAAAAA',
      pairedAt: '2026-09-12T12:00:00.000Z', lastSeenAt: '2026-09-12T12:00:00.000Z', lastTransport: 'tor' },
    { id: 'd_BBBBBBBBBBBBBBBBBBBBBB', name: 'Estúdio', fingerprint: 'fedcba9876543210', deviceId: 'dev_BBBBBBBBBBBBBBBBBBBBBB',
      pairedAt: '2026-09-12T12:00:00.000Z', lastSeenAt: '2026-09-12T12:00:00.000Z', lastTransport: '' }
  ]
};
const forbiddenOnMainScreens = /127\.0\.0\.1|\b\d{1,3}(?:\.\d{1,3}){3}\b|\.onion|\b4740\b|cdt1|nodekey|servidor|server|porta\b/i;
const forbiddenPunctuation = /[()–—]| - /;

beforeEach(async () => {
  mockListeners.clear();
  mockPair.mockReset();
  mockInspect.mockReset();
  await setLocale('pt-BR');
});

test('Pair explains the QR flow, camera use and a pairing notice', async () => {
  let tree;
  await act(async () => {
    tree = create(<Pair device={{ name: 'iPhone', model: 'iPhone16,1', platform: 'ios', app: '1.0.0' }}
      notice="Vincule Mac de Foco de novo para continuar." onCancel={() => {}} onPaired={async () => {}} />);
  });
  expect(text(tree)).toMatch(/Abra Vincular celular no/);
  expect(text(tree)).toMatch(/Permitir câmera/);
  expect(text(tree)).toMatch(/Vincule Mac de Foco de novo/);
  expect(text(tree)).toMatch(/Voltar aos computadores/);
  await act(async () => tree.unmount());
});

test('Pair shows the short fingerprint and the progress of each stage', async () => {
  jest.useFakeTimers();
  mockInspect.mockResolvedValue({ v: 2, desktop: { id: desktopId, name: 'Mac de Foco', fingerprint: '0123456789abcdef' },
    expiresAt: 1_800_000_000, candidates: 3, known: true, approvalCode: '4821' });
  let resolvePair;
  mockPair.mockImplementation(() => new Promise(resolve => { resolvePair = resolve; }));
  const onPaired = jest.fn(async () => {});
  let tree;
  await act(async () => {
    tree = create(<Pair device={{ name: 'iPhone', model: 'iPhone16,1', platform: 'ios', app: '1.0.0' }} onPaired={onPaired} />);
  });
  await act(async () => { await pressable(tree, 'Colar código').props.onPress(); });
  expect(mockInspect).toHaveBeenCalledWith('CIALAI2.payload');
  expect(text(tree)).toMatch(/Vincular a Mac de Foco\?/);
  expect(text(tree)).toMatch(/0123 4567 89ab cdef/);
  expect(text(tree)).toMatch(/Código de aprovação/);
  expect(text(tree)).toContain('4821');
  expect(text(tree)).toMatch(/Já vinculado/);
  expect(text(tree)).not.toMatch(forbiddenOnMainScreens);

  await act(async () => { pressable(tree, 'Vincular').props.onPress(); });
  for (const label of ['Lendo código', 'Procurando na rede local', 'Conectando pela internet', 'Conectando pela reserva', 'Confirmando']) {
    expect(text(tree)).toContain(label);
  }
  await act(async () => {
    for (const listener of mockListeners) {
      listener({ kind: 'pair', payload: { state: 'tor' } });
      listener({ kind: 'tor', payload: { state: 'bootstrapping', progress: 42 } });
    }
  });
  expect(text(tree)).toMatch(/Preparando 42%/);

  const result = { desktopId, deviceId: 'dev_AAAAAAAAAAAAAAAAAAAAAA', token: 'cdt1.x', transport: 'tor',
    desktop: { id: desktopId, name: 'Mac de Foco', fingerprint: '0123456789abcdef' } };
  await act(async () => { resolvePair(result); });
  expect(onPaired).toHaveBeenCalledWith(result);
  await act(async () => tree.unmount());
  expect(mockListeners.size).toBe(0);
  jest.useRealTimers();
});

test('Pair maps a pairing failure without exposing the native message', async () => {
  mockInspect.mockRejectedValue(Object.assign(new Error('segredo'), { code: 'payload_expired' }));
  let tree;
  await act(async () => {
    tree = create(<Pair device={{ name: 'iPhone', model: 'iPhone16,1', platform: 'ios', app: '1.0.0' }} onPaired={async () => {}} />);
  });
  await act(async () => { await pressable(tree, 'Colar código').props.onPress(); });
  expect(text(tree)).toMatch(/Este código expirou/);
  expect(text(tree)).not.toMatch(/segredo/);
  await act(async () => tree.unmount());
});

test('Desktops renders each state and the last transport badge', async () => {
  const describe = id => id === desktopId ? { state: 'connected', transport: 'direct' } : { state: 'removed', transport: null };
  let tree;
  await act(async () => {
    tree = create(<Desktops store={store} describe={describe} onOpen={() => {}} onPair={() => {}}
      onSettings={() => {}} onRename={() => {}} onForgetDesktop={() => {}} />);
  });
  const rendered = text(tree);
  expect(rendered).toMatch(/Mac de Foco/);
  expect(rendered).toMatch(/Conectado/);
  expect(rendered).toMatch(/Direta/);
  expect(rendered).not.toMatch(/Reserva/);
  expect(rendered).toMatch(/Este celular foi removido/);
  expect(rendered).not.toMatch(forbiddenOnMainScreens);
  expect(rendered).not.toMatch(forbiddenPunctuation);
  await act(async () => tree.unmount());

  await act(async () => {
    tree = create(<Desktops store={store} describe={() => ({ state: 'idle', transport: null })} onOpen={() => {}}
      onPair={() => {}} onSettings={() => {}} onRename={() => {}} onForgetDesktop={() => {}} />);
  });
  expect(text(tree)).toMatch(/Não conectado/);
  expect(text(tree)).toMatch(/Reserva/);
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Conexão de reserva')).not.toHaveLength(0);
  await act(async () => tree.unmount());
});

test('Offline shows the reserve progress and retries it', async () => {
  jest.useFakeTimers();
  const onRetry = jest.fn(async () => false);
  let tree;
  await act(async () => {
    tree = create(<Offline reason="reserve-preparing" reserveProgress={37} onRetry={onRetry} onDesktops={() => {}} onPairAgain={() => {}} />);
  });
  expect(text(tree)).toMatch(/Preparando a conexão de reserva/);
  expect(text(tree)).toMatch(/Preparando 37%/);
  expect(text(tree)).toMatch(/Conectando/);
  await act(async () => { jest.advanceTimersByTime(3_000); });
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(text(tree)).not.toMatch(forbiddenOnMainScreens);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Offline backs off at 2, 4, 8 and 16 seconds without a path', async () => {
  jest.useFakeTimers();
  const onRetry = jest.fn(async () => false);
  let tree;
  await act(async () => {
    tree = create(<Offline reason="no-path" reserveProgress={null} onRetry={onRetry} onDesktops={() => {}} onPairAgain={() => {}} />);
  });
  expect(text(tree)).toMatch(/O computador está fora de alcance/);
  for (const [delay, calls] of [[1_999, 0], [1, 1], [4_000, 2], [8_000, 3], [16_000, 4], [16_000, 5]]) {
    await act(async () => { jest.advanceTimersByTime(delay); });
    expect(onRetry).toHaveBeenCalledTimes(calls);
  }
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Offline after revocation offers pairing again and never retries', async () => {
  jest.useFakeTimers();
  const onRetry = jest.fn(async () => false);
  const onPairAgain = jest.fn();
  let tree;
  await act(async () => {
    tree = create(<Offline reason="removed" reserveProgress={null} onRetry={onRetry} onDesktops={() => {}} onPairAgain={onPairAgain} />);
  });
  expect(text(tree)).toMatch(/Este celular foi removido/);
  expect(text(tree)).not.toMatch(/Tentar agora/);
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(onRetry).not.toHaveBeenCalled();
  await act(async () => { pressable(tree, 'Vincular de novo').props.onPress(); });
  expect(onPairAgain).toHaveBeenCalled();
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Offline renders the selected Spanish locale', async () => {
  jest.useFakeTimers();
  await setLocale('es-MX');
  let tree;
  await act(async () => {
    tree = create(<Offline reason="reserve-unavailable" reserveProgress={null} onRetry={async () => false} onDesktops={() => {}} onPairAgain={() => {}} />);
  });
  expect(text(tree)).toMatch(/Conexión de reserva no disponible/);
  expect(text(tree)).toMatch(/Intentar ahora/);
  expect(text(tree)).toMatch(/Cambiar de computadora/);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Settings offers and persists the three supported languages', async () => {
  let tree;
  await act(async () => {
    tree = create(<Settings desktopCount={0} tunnelStatus={null} appVersion="1.0.0" coreVersion="1.0.0" logLevel="info"
      onBack={() => {}} onLogLevel={() => {}} onRefreshStatus={() => {}} />);
  });
  expect(text(tree)).toMatch(/Português English Español/);
  for (const label of ['Português', 'English', 'Español']) {
    expect(tree.root.findAll(node => node.props.accessibilityLabel === label)).not.toHaveLength(0);
  }
  const spanishChoice = tree.root.findAll(node => node.props.accessibilityLabel === 'Español' && typeof node.props.onPress === 'function')[0];
  await act(async () => { await spanishChoice.props.onPress(); });
  expect(getLocale()).toBe('es');
  await act(async () => tree.unmount());
});

test('Settings keeps connection details inside the advanced diagnostics', async () => {
  const onRefreshStatus = jest.fn();
  const tunnelStatus = {
    state: 'connected',
    active: { desktopId, transport: 'tor', path: 'tor', since: '2026-09-15T10:00:00Z' },
    tor: { state: 'bootstrapping', progress: 64 },
    desktops: 2
  };
  let tree;
  await act(async () => {
    tree = create(<Settings desktopCount={2} tunnelStatus={tunnelStatus} appVersion="1.0.0" coreVersion="core-2.0.0"
      logLevel="info" onBack={() => {}} onLogLevel={() => {}} onRefreshStatus={onRefreshStatus} />);
  });
  expect(text(tree)).not.toMatch(/Transporte ativo/);
  await act(async () => { pressable(tree, 'Mostrar detalhes').props.onPress(); });
  expect(onRefreshStatus).toHaveBeenCalled();
  const rendered = text(tree);
  for (const expected of ['Núcleo', 'Conectado', 'Transporte ativo', 'Reserva', 'Caminho ativo', 'Rede Tor',
    'Conexão de reserva', 'Preparando 64%', 'Computadores vinculados', '2', 'Versão do núcleo', 'core-2.0.0',
    'Redes públicas usadas', 'STUN opcional', 'DNS-SD local']) {
    expect(rendered).toContain(expected);
  }
  expect(rendered).not.toMatch(forbiddenPunctuation);
  await act(async () => tree.unmount());
});

test('Shell shows the transport dot and passes the selected locale to the mobile page', async () => {
  jest.useFakeTimers();
  await setLocale('es-MX');
  let tree;
  await act(async () => {
    tree = create(<Shell url="http://127.0.0.1:47400/?k=test" desktopId="desktop-1" desktopName="Studio"
      version="1.0.0" biometricSession={{ authorize: async () => true, lock: () => false }} lockSignal={0}
      transport="tor" onConnectionLost={() => {}} onDesktops={() => {}} />);
  });
  const webView = tree.root.findAll(node => typeof node.props.injectedJavaScriptBeforeContentLoaded === 'string')[0];
  expect(webView.props.injectedJavaScriptBeforeContentLoaded).toContain('"locale":"es"');
  expect(text(tree)).toMatch(/Studio/);
  expect(text(tree)).toMatch(/Reserva/);
  expect(text(tree)).not.toMatch(forbiddenOnMainScreens);
  await act(async () => tree.update(<Shell url="http://127.0.0.1:47400/?k=test" desktopId="desktop-1" desktopName="Studio"
    version="1.0.0" biometricSession={{ authorize: async () => true, lock: () => false }} lockSignal={0}
    transport={null} onConnectionLost={() => {}} onDesktops={() => {}} />));
  expect(text(tree)).toMatch(/Buscando camino/);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});
