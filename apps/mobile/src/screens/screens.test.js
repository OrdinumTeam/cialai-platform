import { beforeEach, expect, jest, test } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { Text } from 'react-native';

import { Desktops } from './Desktops';
import { Home } from './Home';
import { Offline } from './Offline';
import { Pair } from './Pair';
import { Settings } from './Settings';
import { Shell } from './Shell';
import { getLocale, setLocale } from '../i18n';
import { clearDiagnostics, logApp } from '../state/diagnostics';

const mockListeners = new Set();
const mockPair = jest.fn();
const mockInspect = jest.fn();

const mockStop = jest.fn(async () => {});

jest.mock('cialai-tunnel', () => ({
  addListener: handler => {
    mockListeners.add(handler);
    return { remove: () => mockListeners.delete(handler) };
  },
  inspectPairPayload: (...args) => mockInspect(...args),
  pair: (...args) => mockPair(...args),
  stop: () => mockStop()
}));
jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: false }, jest.fn()]
}));
jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn(async () => 'CIALAI2.payload') }));
jest.mock('react-native-webview', () => ({ WebView: 'WebView' }));
const mockHealth = jest.fn(async () => true);
jest.mock('../network/health', () => ({ ...jest.requireActual('../network/health'), checkControlHealth: (...args) => mockHealth(...args) }));

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
  mockHealth.mockReset();
  mockHealth.mockResolvedValue(true);
  clearDiagnostics();
  await setLocale('pt-BR');
});

const shellProps = overrides => ({
  url: 'http://127.0.0.1:47400/?k=test', desktopId: 'desktop-1', desktopName: 'Studio', version: '1.0.0',
  biometricSession: { authorize: async () => true, lock: () => false }, lockSignal: 0, transport: 'tor', reconnecting: false,
  onConnectionLost: () => {}, onConnectionRestored: () => {}, onHome: () => {}, ...overrides
});
const offlineProps = overrides => ({
  desktopId, reason: 'no-path', reserveProgress: null, onRetry: async () => false,
  onHome: () => {}, onDesktops: () => {}, onSettings: () => {}, onPair: () => {}, onPairAgain: () => {}, ...overrides
});
const homeHandlers = () => ({
  onContinue: jest.fn(), onDisconnect: jest.fn(), onDesktops: jest.fn(), onPair: jest.fn(), onTerminal: jest.fn(), onSettings: jest.fn()
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
  expect(text(tree)).toMatch(/Voltar ao início/);
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

test('Pair explains a slow backup, counts the time and lets the person cancel', async () => {
  jest.useFakeTimers();
  mockStop.mockClear();
  mockInspect.mockResolvedValue({ v: 2, desktop: { id: desktopId, name: 'Mac de Foco', fingerprint: '0123456789abcdef' },
    expiresAt: 1_800_000_000, candidates: 3, known: false, approvalCode: '' });
  let rejectPair;
  mockPair.mockImplementation(() => new Promise((_resolve, reject) => { rejectPair = reject; }));
  let tree;
  await act(async () => {
    tree = create(<Pair device={{ name: 'iPhone', model: 'iPhone16,1', platform: 'ios', app: '1.0.0' }} onPaired={async () => {}} />);
  });
  await act(async () => { await pressable(tree, 'Colar código').props.onPress(); });
  await act(async () => { pressable(tree, 'Vincular').props.onPress(); });
  expect(text(tree)).toMatch(/Cancelar pareamento/);
  expect(text(tree)).not.toMatch(/passa pela reserva/);
  await act(async () => { jest.advanceTimersByTime(9_000); });
  expect(text(tree)).toMatch(/passa pela reserva/);
  expect(text(tree)).toMatch(/Tentando há \d+ s/);
  expect(text(tree)).not.toMatch(forbiddenPunctuation);
  await act(async () => { await pressable(tree, 'Cancelar pareamento').props.onPress(); });
  expect(mockStop).toHaveBeenCalledTimes(1);
  await act(async () => { rejectPair(Object.assign(new Error('parado'), { code: 'stopped' })); });
  // O código continua na tela, sem mensagem de erro, pronto para tentar de novo.
  expect(text(tree)).toMatch(/Vincular a Mac de Foco\?/);
  expect(text(tree)).not.toMatch(/parado/);
  expect(pressable(tree, 'Vincular')).toBeDefined();
  await act(async () => tree.unmount());
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
  const onHome = jest.fn();
  let tree;
  await act(async () => {
    tree = create(<Desktops store={store} describe={describe} onOpen={() => {}} onHome={onHome} onPair={() => {}}
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
  // O voltar da lista leva ao início, com rótulo próprio.
  await act(async () => { pressable(tree, 'Início').props.onPress(); });
  expect(onHome).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());

  await act(async () => {
    tree = create(<Desktops store={store} describe={() => ({ state: 'idle', transport: null })} onOpen={() => {}}
      onHome={() => {}} onPair={() => {}} onSettings={() => {}} onRename={() => {}} onForgetDesktop={() => {}} />);
  });
  expect(text(tree)).toMatch(/Não conectado/);
  expect(text(tree)).toMatch(/Reserva/);
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Conexão de reserva')).not.toHaveLength(0);
  await act(async () => tree.unmount());
});

test('Home shows the last computer, the four cards and the count, without addresses', async () => {
  const describe = id => id === desktopId ? { state: 'connected', transport: 'direct' } : { state: 'idle', transport: null };
  const handlers = homeHandlers();
  let tree;
  await act(async () => {
    tree = create(<Home store={store} describe={describe} keptDesktopId={desktopId} {...handlers} />);
  });
  const rendered = text(tree);
  for (const expected of ['Início', 'Continuar', 'Mac de Foco', 'Conectado', 'Direta', 'Desconectar',
    'Computadores', '2 vinculados', 'Vincular', 'Ler o código do computador', 'Terminal', 'Ajustes']) {
    expect(rendered).toContain(expected);
  }
  expect(rendered).not.toMatch(forbiddenOnMainScreens);
  expect(rendered).not.toMatch(forbiddenPunctuation);
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Conexão direta')).not.toHaveLength(0);
  await act(async () => { tree.root.findAll(node => node.props.accessibilityLabel === 'Continuar em Mac de Foco')[0].props.onPress(); });
  expect(handlers.onContinue).toHaveBeenCalledWith(store.desktops[0]);
  for (const [label, handler] of [['Mostrar computadores', 'onDesktops'], ['Abrir o pareamento', 'onPair'],
    ['Abrir o terminal', 'onTerminal'], ['Abrir ajustes', 'onSettings']]) {
    await act(async () => { tree.root.findAll(node => node.props.accessibilityLabel === label)[0].props.onPress(); });
    expect(handlers[handler]).toHaveBeenCalledTimes(1);
  }
  await act(async () => { pressable(tree, 'Desconectar').props.onPress(); });
  expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

test('Home without a last computer hides Continue and offers to choose one', async () => {
  const handlers = homeHandlers();
  let tree;
  await act(async () => {
    tree = create(<Home store={{ version: 2, lastDesktopId: null, desktops: [] }} describe={() => ({ state: 'idle', transport: null })}
      keptDesktopId={null} {...handlers} />);
  });
  expect(text(tree)).not.toMatch(/Continuar/);
  expect(text(tree)).toMatch(/Nenhum vinculado/);
  expect(text(tree)).toMatch(/Escolha um computador/);
  expect(text(tree)).not.toMatch(forbiddenPunctuation);
  // Com um computador fora de alcance e sem proxy guardado, não há Desconectar.
  await act(async () => tree.update(<Home store={{ ...store, desktops: [store.desktops[0]] }}
    describe={() => ({ state: 'offline', transport: null })} keptDesktopId={null} {...handlers} />));
  expect(text(tree)).toMatch(/Um vinculado/);
  expect(text(tree)).toMatch(/Fora de alcance/);
  expect(text(tree)).toMatch(/Reserva/);
  expect(text(tree)).not.toMatch(/Desconectar/);
  await act(async () => tree.unmount());
});

test('Home renders the selected Spanish locale', async () => {
  await setLocale('es-MX');
  let tree;
  await act(async () => {
    tree = create(<Home store={store} describe={() => ({ state: 'idle', transport: null })} keptDesktopId={null} {...homeHandlers()} />);
  });
  for (const expected of ['Inicio', 'Continuar', 'Computadoras', '2 vinculadas', 'Vincular', 'Terminal', 'Configuración']) {
    expect(text(tree)).toContain(expected);
  }
  expect(text(tree)).not.toMatch(forbiddenPunctuation);
  await act(async () => tree.unmount());
});

test('Offline shows the reserve progress and retries it', async () => {
  jest.useFakeTimers();
  const onRetry = jest.fn(async () => false);
  let tree;
  await act(async () => {
    tree = create(<Offline {...offlineProps({ reason: 'reserve-preparing', reserveProgress: 37, onRetry })} />);
  });
  expect(text(tree)).toMatch(/Preparando a conexão de reserva/);
  expect(text(tree)).toMatch(/Preparando 37%/);
  expect(text(tree)).toMatch(/Conectando/);
  // A reserva em preparo segue a mesma escada dos outros motivos.
  await act(async () => { jest.advanceTimersByTime(2_000); });
  expect(onRetry).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(3_999); });
  expect(onRetry).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(onRetry).toHaveBeenCalledTimes(2);
  expect(text(tree)).not.toMatch(forbiddenOnMainScreens);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Offline backs off at 2, 4, 8 and 16 seconds without a path', async () => {
  jest.useFakeTimers();
  const onRetry = jest.fn(async () => false);
  let tree;
  await act(async () => {
    tree = create(<Offline {...offlineProps({ onRetry })} />);
  });
  expect(text(tree)).toMatch(/O computador está fora de alcance/);
  for (const [delay, calls] of [[1_999, 0], [1, 1], [4_000, 2], [8_000, 3], [16_000, 4], [16_000, 5]]) {
    await act(async () => { jest.advanceTimersByTime(delay); });
    expect(onRetry).toHaveBeenCalledTimes(calls);
  }
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Offline keeps climbing the ladder when the reason changes and restarts for another desktop', async () => {
  jest.useFakeTimers();
  const onRetry = jest.fn(async () => false);
  const render = (id, reason) => <Offline {...offlineProps({ desktopId: id, reason, onRetry })} />;
  let tree;
  await act(async () => { tree = create(render(desktopId, 'tunnel')); });
  await act(async () => { jest.advanceTimersByTime(2_000); });
  expect(onRetry).toHaveBeenCalledTimes(1);
  // O motivo muda enquanto o núcleo procura; a próxima tentativa segue em 4 s, não volta a 2 s.
  await act(async () => tree.update(render(desktopId, 'no-path')));
  await act(async () => { jest.advanceTimersByTime(3_999); });
  expect(onRetry).toHaveBeenCalledTimes(1);
  await act(async () => { jest.advanceTimersByTime(1); });
  expect(onRetry).toHaveBeenCalledTimes(2);
  await act(async () => tree.update(render(desktopId, 'reserve-preparing')));
  await act(async () => { jest.advanceTimersByTime(8_000); });
  expect(onRetry).toHaveBeenCalledTimes(3);
  // Outro computador recomeça a escada em 2 s.
  await act(async () => tree.update(render('d_BBBBBBBBBBBBBBBBBBBBBB', 'no-path')));
  await act(async () => { jest.advanceTimersByTime(2_000); });
  expect(onRetry).toHaveBeenCalledTimes(4);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Offline after revocation offers pairing again and never retries', async () => {
  jest.useFakeTimers();
  const onRetry = jest.fn(async () => false);
  const onPairAgain = jest.fn();
  let tree;
  await act(async () => {
    tree = create(<Offline {...offlineProps({ reason: 'removed', onRetry, onPairAgain })} />);
  });
  expect(text(tree)).toMatch(/Este celular foi removido/);
  expect(text(tree)).not.toMatch(/Tentar agora/);
  // Depois da revogação o atalho Vincular sai: o botão principal já vincula de novo.
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Abrir o pareamento')).toHaveLength(0);
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(onRetry).not.toHaveBeenCalled();
  await act(async () => { pressable(tree, 'Vincular de novo').props.onPress(); });
  expect(onPairAgain).toHaveBeenCalled();
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Offline goes back to the home and offers the list, settings and pairing shortcuts', async () => {
  jest.useFakeTimers();
  const onRetry = jest.fn(async () => false);
  const handlers = { onHome: jest.fn(), onDesktops: jest.fn(), onSettings: jest.fn(), onPair: jest.fn() };
  let tree;
  await act(async () => { tree = create(<Offline {...offlineProps({ onRetry, ...handlers })} />); });
  for (const expected of ['Início', 'Computadores', 'Ajustes', 'Vincular']) expect(text(tree)).toContain(expected);
  expect(text(tree)).not.toMatch(forbiddenPunctuation);
  for (const [label, handler] of [['Ir para o início', 'onHome'], ['Mostrar computadores', 'onDesktops'],
    ['Abrir ajustes', 'onSettings'], ['Abrir o pareamento', 'onPair']]) {
    await act(async () => { tree.root.findAll(node => node.props.accessibilityLabel === label)[0].props.onPress(); });
    expect(handlers[handler]).toHaveBeenCalledTimes(1);
  }
  // Sair da tela cancela a escada: nenhuma tentativa dispara depois.
  await act(async () => { jest.advanceTimersByTime(60_000); });
  expect(onRetry).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Offline renders the selected Spanish locale', async () => {
  jest.useFakeTimers();
  await setLocale('es-MX');
  let tree;
  await act(async () => {
    tree = create(<Offline {...offlineProps({ reason: 'reserve-unavailable' })} />);
  });
  expect(text(tree)).toMatch(/Conexión de reserva no disponible/);
  expect(text(tree)).toMatch(/Intentar ahora/);
  expect(text(tree)).toMatch(/Inicio/);
  expect(text(tree)).toMatch(/Computadoras/);
  expect(text(tree)).toMatch(/Configuración/);
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

test('Settings offers the three appearance modes and reports the choice', async () => {
  const onThemeMode = jest.fn();
  let tree;
  await act(async () => {
    tree = create(<Settings desktopCount={0} tunnelStatus={null} appVersion="1.0.0" coreVersion="1.0.0" logLevel="info" themeMode="system"
      onBack={() => {}} onLogLevel={() => {}} onThemeMode={onThemeMode} onRefreshStatus={() => {}} />);
  });
  expect(text(tree)).toMatch(/Aparência/);
  expect(text(tree)).toMatch(/Sistema Claro Escuro/);
  const dark = tree.root.findAll(node => node.props.accessibilityLabel === 'Escuro' && typeof node.props.onPress === 'function')[0];
  await act(async () => { dark.props.onPress(); });
  expect(onThemeMode).toHaveBeenCalledWith('dark');
  await act(async () => tree.unmount());
});

test('Settings offers the biometric policy and reports the choice', async () => {
  const onBiometricPolicy = jest.fn();
  let tree;
  await act(async () => {
    tree = create(<Settings desktopCount={0} tunnelStatus={null} appVersion="1.0.0" coreVersion="1.0.0" logLevel="info" biometricPolicy="always"
      onBack={() => {}} onLogLevel={() => {}} onBiometricPolicy={onBiometricPolicy} onRefreshStatus={() => {}} />);
  });
  expect(text(tree)).toMatch(/Face ID ou biometria/);
  expect(text(tree)).toMatch(/Sempre Só ao abrir Desligada/);
  expect(text(tree)).toMatch(/em cada ação no terminal/);
  const off = tree.root.findAll(node => node.props.accessibilityLabel === 'Desligada' && typeof node.props.onPress === 'function')[0];
  await act(async () => { off.props.onPress(); });
  expect(onBiometricPolicy).toHaveBeenCalledWith('off');
  expect(text(tree)).not.toMatch(forbiddenPunctuation);
  await act(async () => tree.unmount());
});

test('Settings keeps connection details inside the advanced diagnostics', async () => {
  const onRefreshStatus = jest.fn();
  logApp('info', 'health probe: HTTP 403 forbidden', new Date(2026, 8, 16, 11, 7, 3).getTime());
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
    'Redes públicas usadas', 'STUN opcional', 'DNS-SD local', 'Linhas recentes', '11:07:03', 'app: health probe: HTTP 403 forbidden']) {
    expect(rendered).toContain(expected);
  }
  expect(rendered).not.toMatch(forbiddenPunctuation);
  await act(async () => tree.unmount());
});

test('Settings says when the diagnostic ring is still empty', async () => {
  let tree;
  await act(async () => {
    tree = create(<Settings desktopCount={0} tunnelStatus={null} appVersion="1.0.0" coreVersion="1.0.0" logLevel="info"
      onBack={() => {}} onLogLevel={() => {}} onRefreshStatus={() => {}} />);
  });
  await act(async () => { pressable(tree, 'Mostrar detalhes').props.onPress(); });
  expect(text(tree)).toMatch(/Nenhuma linha registrada ainda/);
  await act(async () => tree.unmount());
});

test('Shell shows the transport dot and passes the selected locale to the mobile page', async () => {
  jest.useFakeTimers();
  await setLocale('es-MX');
  let tree;
  await act(async () => {
    tree = create(<Shell {...shellProps()} />);
  });
  const webView = tree.root.findAll(node => typeof node.props.injectedJavaScriptBeforeContentLoaded === 'string')[0];
  expect(webView.props.injectedJavaScriptBeforeContentLoaded).toContain('"locale":"es"');
  expect(webView.props.injectedJavaScriptBeforeContentLoaded).toContain('"theme":"system"');
  expect(webView.props.pullToRefreshEnabled).toBe(false);
  expect(text(tree)).toMatch(/Studio/);
  expect(text(tree)).toMatch(/Reserva/);
  expect(text(tree)).not.toMatch(forbiddenOnMainScreens);
  await act(async () => tree.update(<Shell {...shellProps({ transport: null })} />));
  expect(text(tree)).toMatch(/Buscando camino/);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Shell shows the reconnecting banner above the page and keeps the same source', async () => {
  jest.useFakeTimers();
  const onHome = jest.fn();
  let tree;
  await act(async () => { tree = create(<Shell {...shellProps({ onHome })} />); });
  const webView = () => tree.root.findAll(node => node.props.source?.uri)[0];
  const source = webView().props.source;
  // O botão da barra volta ao início, com rótulo próprio.
  await act(async () => { pressable(tree, 'Início').props.onPress(); });
  expect(onHome).toHaveBeenCalledTimes(1);
  expect(text(tree)).not.toMatch(/Reconectando/);
  await act(async () => tree.update(<Shell {...shellProps({ reconnecting: true })} />));
  expect(text(tree)).toMatch(/Reconectando/);
  expect(text(tree)).toMatch(/A página continua aqui/);
  expect(text(tree)).not.toMatch(forbiddenPunctuation);
  expect(webView().props.source).toBe(source);
  await act(async () => tree.update(<Shell {...shellProps({ reconnecting: false })} />));
  expect(text(tree)).not.toMatch(/Reconectando/);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Shell needs two strikes from probes or load errors before reporting the loss, and reports recovery', async () => {
  jest.useFakeTimers();
  const onConnectionLost = jest.fn();
  const onConnectionRestored = jest.fn();
  let tree;
  await act(async () => { tree = create(<Shell {...shellProps({ onConnectionLost, onConnectionRestored })} />); });
  const webView = tree.root.findAll(node => node.props.source?.uri)[0];
  const loadError = { nativeEvent: { code: -1009, description: 'Sem conexão' } };
  // Um erro de carregamento sozinho não derruba nada.
  await act(async () => { webView.props.onError(loadError); });
  expect(onConnectionLost).not.toHaveBeenCalled();
  // Uma sondagem boa zera a contagem e avisa que a página respondeu.
  await act(async () => { jest.advanceTimersByTime(10_000); });
  expect(onConnectionRestored).toHaveBeenCalledTimes(1);
  await act(async () => { webView.props.onError(loadError); });
  expect(onConnectionLost).not.toHaveBeenCalled();
  // O segundo erro seguido completa o par.
  await act(async () => { webView.props.onError(loadError); });
  expect(onConnectionLost).toHaveBeenCalledTimes(1);
  // Sondagem falha mais erro de carregamento também formam o par.
  mockHealth.mockResolvedValueOnce(false);
  await act(async () => { jest.advanceTimersByTime(10_000); });
  expect(onConnectionLost).toHaveBeenCalledTimes(1);
  await act(async () => { webView.props.onError(loadError); });
  expect(onConnectionLost).toHaveBeenCalledTimes(2);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});
