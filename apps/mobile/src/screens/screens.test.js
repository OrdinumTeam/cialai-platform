import { beforeEach, expect, jest, test } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { Linking, Text } from 'react-native';

import { Desktops } from './Desktops';
import { Home } from './Home';
import { Offline } from './Offline';
import { Pair } from './Pair';
import { Agents } from './Agents';
import { Settings } from './Settings';
import { Shell } from './Shell';
import { getLocale, setLocale } from '../i18n';
import { clearDiagnostics, logApp } from '../state/diagnostics';
import { recordSnapshot, resetDashboardForTests, toggleFavorite } from '../dashboard/store';

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
jest.mock('react-native-safe-area-context', () => require('react-native-safe-area-context/jest/mock').default);
const mockHealth = jest.fn(async () => true);
jest.mock('../network/health', () => ({ ...jest.requireActual('../network/health'), checkControlHealth: (...args) => mockHealth(...args) }));

const text = tree => tree.root.findAllByType(Text).map(node => node.props.children).flat(Infinity).join(' ');
const pressable = (tree, label) => tree.root.findAll(node => typeof node.props.onPress === 'function' &&
  node.findAllByType(Text).some(child => [child.props.children].flat(Infinity).join('') === label))[0];
const labelled = (tree, label) => tree.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
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
  storeState: 'ready', onRetryStore: jest.fn(),
  onContinue: jest.fn(), onIntent: jest.fn(), onDisconnect: jest.fn(), onDesktops: jest.fn(), onPair: jest.fn(), onTerminal: jest.fn(), onProjects: jest.fn()
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

const desktopsProps = overrides => ({
  store, describe: () => ({ state: 'idle', transport: null }), keptDesktopId: null, onOpen: jest.fn(), onIntent: jest.fn(), onHome: jest.fn(),
  onPair: jest.fn(), onDisconnect: jest.fn(), onRename: jest.fn(), onForgetDesktop: jest.fn(), ...overrides
});

test('Desktops renders each state and the last transport badge', async () => {
  const describe = id => id === desktopId ? { state: 'connected', transport: 'direct' } : { state: 'removed', transport: null };
  const onHome = jest.fn();
  let tree;
  await act(async () => {
    tree = create(<Desktops {...desktopsProps({ describe, onHome })} />);
  });
  const rendered = text(tree);
  expect(rendered).toMatch(/Mac de Foco/);
  expect(rendered).toMatch(/Conectado/);
  expect(rendered).toMatch(/Direta/);
  expect(rendered).not.toMatch(/Reserva/);
  expect(rendered).toMatch(/Este celular foi removido/);
  expect(rendered).not.toMatch(forbiddenOnMainScreens);
  expect(rendered).not.toMatch(forbiddenPunctuation);
  // O voltar da lista é um ícone que leva ao início, com rótulo próprio.
  await act(async () => { labelled(tree, 'Ir para o início').props.onPress(); });
  expect(onHome).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());

  await act(async () => {
    tree = create(<Desktops {...desktopsProps({ describe: () => ({ state: 'idle', transport: null }) })} />);
  });
  expect(text(tree)).toMatch(/Não conectado/);
  expect(text(tree)).toMatch(/Reserva/);
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Conexão de reserva')).not.toHaveLength(0);
  await act(async () => tree.unmount());
});

test('Desktops filters by connection and searches without accents', async () => {
  const describe = id => id === desktopId ? { state: 'connected', transport: 'direct' } : { state: 'idle', transport: null };
  let tree;
  await act(async () => { tree = create(<Desktops {...desktopsProps({ describe })} />); });
  const names = () => tree.root.findAll(node => node.props.accessibilityRole === 'button' && typeof node.props.accessibilityLabel === 'string'
    && /Mac de Foco|Estúdio/.test(node.props.accessibilityLabel) && !/Opções/.test(node.props.accessibilityLabel)).map(node => node.props.accessibilityLabel);
  expect(text(tree)).toMatch(/Todos/);
  expect(text(tree)).toMatch(/Conectados/);
  expect(text(tree)).toMatch(/Desconectados/);
  await act(async () => { pressable(tree, 'Desconectados').props.onPress(); });
  expect(text(tree)).not.toMatch(/Mac de Foco/);
  expect(text(tree)).toMatch(/Estúdio/);
  await act(async () => { pressable(tree, 'Todos').props.onPress(); });
  const search = tree.root.findAll(node => node.props.placeholder === 'Buscar computador' && typeof node.props.onChangeText === 'function')[0];
  await act(async () => { search.props.onChangeText('estudio'); });
  expect(text(tree)).toMatch(/Estúdio/);
  expect(text(tree)).not.toMatch(/Mac de Foco/);
  await act(async () => { search.props.onChangeText('nada'); });
  expect(text(tree)).toMatch(/Nenhum computador encontrado/);
  expect(names()).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('Desktops highlights the active computer and keeps long names on one line', async () => {
  const long = 'Notebook do escritório com um nome comprido demais para caber';
  const many = { ...store, desktops: [...store.desktops, { ...store.desktops[1], id: 'd_CCCCCCCCCCCCCCCCCCCCCC', name: long }] };
  let tree;
  await act(async () => { tree = create(<Desktops {...desktopsProps({ store: many, keptDesktopId: 'd_BBBBBBBBBBBBBBBBBBBBBB' })} />); });
  expect(tree.root.findAll(node => node.props.accessibilityLabel?.startsWith?.('Estúdio, em uso, ') && typeof node.props.onPress === 'function')).not.toHaveLength(0);
  expect(tree.root.findAll(node => node.props.accessibilityLabel?.startsWith?.('Mac de Foco, em uso'))).toHaveLength(0);
  const title = tree.root.findAllByType(Text).find(node => node.props.children === long);
  expect(title.props.numberOfLines).toBe(1);
  await act(async () => tree.unmount());
});

test('Desktops menu opens sessions, starts intents, renames, disconnects and forgets', async () => {
  const props = desktopsProps({ keptDesktopId: desktopId });
  let tree;
  await act(async () => { tree = create(<Desktops {...props} />); });
  const openMenu = async () => { await act(async () => { labelled(tree, 'Opções de Mac de Foco').props.onPress(); }); };
  await openMenu();
  await act(async () => { pressable(tree, 'Nova sessão').props.onPress(); });
  expect(props.onIntent).toHaveBeenCalledWith(store.desktops[0], { kind: 'new-session' });
  await openMenu();
  await act(async () => { pressable(tree, 'Gerenciar agentes').props.onPress(); });
  expect(props.onIntent).toHaveBeenCalledWith(store.desktops[0], { kind: 'profiles' });
  await openMenu();
  await act(async () => { pressable(tree, 'Desconectar').props.onPress(); });
  expect(props.onDisconnect).toHaveBeenCalledTimes(1);
  await openMenu();
  await act(async () => { pressable(tree, 'Renomear').props.onPress(); });
  const input = tree.root.findAll(node => node.props.accessibilityLabel === 'Nome do computador' && typeof node.props.onChangeText === 'function')[0];
  await act(async () => { input.props.onChangeText('Mac novo'); });
  await act(async () => { pressable(tree, 'Salvar nome').props.onPress(); });
  expect(props.onRename).toHaveBeenCalledWith(desktopId, 'Mac novo');
  await openMenu();
  await act(async () => { pressable(tree, 'Esquecer').props.onPress(); });
  expect(props.onForgetDesktop).toHaveBeenCalledWith(store.desktops[0]);
  await openMenu();
  await act(async () => { pressable(tree, 'Abrir terminal').props.onPress(); });
  expect(props.onOpen).toHaveBeenCalledWith(store.desktops[0]);
  await act(async () => tree.unmount());
  // Sem proxy guardado, desconectar não aparece.
  await act(async () => { tree = create(<Desktops {...desktopsProps()} />); });
  await act(async () => { labelled(tree, 'Opções de Mac de Foco').props.onPress(); });
  expect(pressable(tree, 'Desconectar')).toBeUndefined();
  await act(async () => tree.unmount());
});

test('Shell bar switches computers from a native sheet', async () => {
  const onSwitchDesktop = jest.fn();
  const onDesktops = jest.fn();
  const desktops = [
    { id: 'desktop-1', name: 'Studio', state: 'connected', transport: 'tor' },
    { id: 'desktop-2', name: 'Notebook', state: 'idle', transport: null }
  ];
  let tree;
  await act(async () => { tree = create(<Shell {...shellProps({ desktops, onSwitchDesktop, onDesktops })} />); });
  await act(async () => { labelled(tree, 'Trocar de computador, atual Studio').props.onPress(); });
  expect(text(tree)).toMatch(/Atual/);
  expect(text(tree)).toMatch(/Não conectado/);
  await act(async () => { pressable(tree, 'Notebook').props.onPress(); });
  expect(onSwitchDesktop).toHaveBeenCalledWith('desktop-2');
  await act(async () => { labelled(tree, 'Trocar de computador, atual Studio').props.onPress(); });
  await act(async () => { pressable(tree, 'Gerenciar computadores').props.onPress(); });
  expect(onDesktops).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
const snapshot = (overrides = {}) => ({
  type: 'dashboard', at: NOW - 5 * 60_000,
  accounts: [
    { id: 'codex', agent: 'codex', label: 'Codex', plan: 'Plus', active: true, state: 'ok', fetchedAtMs: NOW - 60_000, windows: [
      { id: 'session', label: 'Limite de 5 horas', usedFraction: 0.19, resetsAtMs: NOW + 2 * 3_600_000 + 10 * 60_000, durationMs: 18_000_000, headline: true, weekly: false },
      { id: 'weekly', label: 'Limite semanal', usedFraction: 0.62, resetsAtMs: NOW + 3 * 86_400_000, durationMs: 604_800_000, headline: false, weekly: true }
    ] },
    { id: 'claude', agent: 'claude', label: 'Pessoal', plan: null, active: true, state: 'needsLogin', fetchedAtMs: null, windows: [] }
  ],
  projects: [
    { name: 'psicoapp', path: '/home/pessoa/Projects/psicoapp', root: '~/Projects' },
    { name: 'frontend', path: '/home/pessoa/Projects/frontend', root: '~/Projects' }
  ],
  sessions: [{ id: 's1', name: 'psicoapp', cwd: '/home/pessoa/Projects/psicoapp', status: 'running', agent: 'codex' }],
  ...overrides
});
const memoryFiles = () => {
  const files = new Map();
  return { read: async name => files.get(name) ?? null, write: async (name, value) => { files.set(name, value); }, remove: async name => { files.delete(name); } };
};
const labelledAll = (tree, label) => tree.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function');
const tap = async (tree, label) => { await act(async () => { (labelledAll(tree, label)[0] ?? pressable(tree, label)).props.onPress(); }); };

async function renderHome(props = {}, { dashboard = snapshot(), favorites = [] } = {}) {
  resetDashboardForTests(memoryFiles(), true);
  if (dashboard) recordSnapshot(desktopId, dashboard);
  favorites.forEach(path => toggleFavorite(desktopId, path));
  const handlers = homeHandlers();
  let tree;
  await act(async () => {
    tree = create(<Home store={store} describe={id => id === desktopId ? { state: 'connected', transport: 'direct' } : { state: 'idle', transport: null }}
      keptDesktopId={null} {...handlers} {...props} />);
  });
  return { tree, handlers };
}

test('Home keeps two half-width usage cards and scrolls sideways when an agent has more profiles', async () => {
  jest.useFakeTimers({ now: NOW });
  const single = await renderHome();
  expect(single.tree.root.findAll(node => node.props.testID === 'agent-usage-scroll')).toHaveLength(0);
  await act(async () => single.tree.unmount());
  const base = snapshot();
  const work = { ...base.accounts[0], id: 'codex-work', label: 'Trabalho', active: false };
  const { tree } = await renderHome({}, { dashboard: snapshot({ accounts: [...base.accounts, work] }) });
  const scroll = tree.root.findAll(node => node.props.testID === 'agent-usage-scroll' && node.props.horizontal);
  expect(scroll).not.toHaveLength(0);
  // O card e o Pressable dentro dele carregam o mesmo rótulo, um logo depois do outro.
  const cards = tree.root.findAll(node => typeof node.props.accessibilityHint === 'string' && node.props.accessibilityHint.startsWith('Ver uso do') && typeof node.props.onPress === 'function')
    .filter((card, index, all) => index === 0 || all[index - 1].props.accessibilityLabel !== card.props.accessibilityLabel);
  expect(cards.map(card => card.props.accessibilityLabel.split(',').slice(0, 2).join(','))).toEqual(['Codex, Codex', 'Codex, Trabalho', 'Claude Code, Entre na conta no computador']);
  // Tocar no card do segundo perfil abre os detalhes dele.
  await act(async () => { cards[1].props.onPress(); });
  expect(text(tree)).toContain('Trabalho');
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Home shows the logo, real agent usage and the connected computer first, without addresses', async () => {
  jest.useFakeTimers({ now: NOW });
  const { tree, handlers } = await renderHome({ keptDesktopId: desktopId });
  const rendered = text(tree);
  for (const expected of ['Codex', 'Plus', 'Limite de 5 horas', '19%', 'Renova em 2 h 10 min',
    'Limite semanal', '62%', 'Renova em 3 d', 'Claude Code', 'Entre na conta no computador', 'Atualizado há 5 min',
    'Computadores', 'Mac de Foco', 'Conectado', 'Direta', 'Uma sessão aberta', 'Abrir terminal', 'Desconectar', 'Seus projetos', 'Ações rápidas']) {
    expect(rendered).toContain(expected);
  }
  expect(rendered).not.toMatch(forbiddenOnMainScreens);
  expect(rendered).not.toMatch(forbiddenPunctuation);
  // O cabeçalho é o logo do site, sem saudação.
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Cialai' && node.props.accessibilityRole === 'header')).not.toHaveLength(0);
  expect(rendered).not.toMatch(/Olá|computador conectado/);
  // Ações rápidas com rótulo curto na tela e a ação inteira para o leitor de tela.
  expect(rendered).toContain('Ações rápidas Nova sessão Vincular Terminais Agentes');
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Conexão direta')).not.toHaveLength(0);
  // O leitor de tela ouve o uso, não só a ação do card.
  const usageCard = tree.root.findAll(node => node.props.accessibilityHint === 'Ver uso do Codex')[0];
  expect(usageCard.props.accessibilityLabel).toBe('Codex, Plus, Limite de 5 horas 19%, Limite semanal 62%');
  expect(tree.root.findAll(node => node.props.accessibilityHint === 'Ver uso do Claude Code')[0].props.accessibilityLabel)
    .toBe('Claude Code, Entre na conta no computador');
  await tap(tree, 'Abrir terminal em Mac de Foco');
  expect(handlers.onContinue).toHaveBeenCalledWith(store.desktops[0]);
  await tap(tree, 'Mostrar computadores');
  expect(handlers.onDesktops).toHaveBeenCalledTimes(1);
  await tap(tree, 'Ver todos os projetos');
  expect(handlers.onProjects).toHaveBeenCalledTimes(1);
  await tap(tree, 'Vincular computador');
  expect(handlers.onPair).toHaveBeenCalledTimes(1);
  await tap(tree, 'Ver terminais');
  expect(handlers.onTerminal).toHaveBeenCalledTimes(1);
  await tap(tree, 'Nova sessão');
  expect(handlers.onIntent).toHaveBeenLastCalledWith(store.desktops[0], { kind: 'new-session' });
  await tap(tree, 'Gerenciar agentes');
  expect(handlers.onIntent).toHaveBeenLastCalledWith(store.desktops[0], { kind: 'profiles' });
  await act(async () => { pressable(tree, 'Desconectar').props.onPress(); });
  expect(handlers.onDisconnect).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Home tells each usage state apart and lets the person pick the account shown', async () => {
  jest.useFakeTimers({ now: NOW });
  const second = { id: 'codex-trabalho', agent: 'codex', label: 'Trabalho', plan: 'Pro', active: false, state: 'ok', fetchedAtMs: NOW, windows: [
    { id: 'session', label: 'Limite de 5 horas', usedFraction: 1, resetsAtMs: NOW + 40 * 60_000, durationMs: 18_000_000, headline: true, weekly: false }
  ] };
  const base = snapshot();
  const { tree } = await renderHome({}, { dashboard: { ...base, accounts: [...base.accounts, second] } });
  await act(async () => { tree.root.findAll(node => node.props.accessibilityHint === 'Ver uso do Codex' && typeof node.props.onPress === 'function')[0].props.onPress(); });
  expect(text(tree)).toContain('Conta do Codex');
  await act(async () => { tree.root.findAll(node => node.props.accessibilityRole === 'radio' &&
    node.findAllByType(Text).some(child => child.props.children === 'Trabalho'))[0].props.onPress(); });
  expect(text(tree)).toContain('Esgotado');
  expect(text(tree)).toContain('Renova em 40 min');
  await act(async () => tree.unmount());

  // Sem retrato, os cards pedem para abrir o terminal e nada é inventado.
  const empty = await renderHome({}, { dashboard: null });
  expect(text(empty.tree)).toContain('Abra o terminal para atualizar');
  expect(text(empty.tree)).toContain('Abra o terminal uma vez para listar os projetos deste computador.');
  expect(text(empty.tree)).not.toMatch(/\d+%/);
  await act(async () => empty.tree.unmount());
  jest.useRealTimers();
});

async function renderAgents(props = {}, { dashboard = snapshot(), loaded = true } = {}) {
  resetDashboardForTests(memoryFiles(), loaded);
  if (dashboard) recordSnapshot(desktopId, dashboard);
  const handlers = { onBack: jest.fn(), onPair: jest.fn(), onIntent: jest.fn() };
  let tree;
  await act(async () => {
    tree = create(<Agents store={store} describe={id => id === desktopId ? { state: 'connected', transport: 'direct' } : { state: 'idle', transport: null }}
      {...handlers} {...props} />);
  });
  return { tree, handlers };
}

test('Agents shows each agent account with plan, default badge, usage and the switch note', async () => {
  jest.useFakeTimers({ now: NOW });
  const { tree, handlers } = await renderAgents();
  const rendered = text(tree);
  for (const expected of ['Agentes', 'Codex', 'Plus', 'Padrão', 'Limite de 5 horas', '19%', 'Renova em 2 h 10 min',
    'Limite semanal', '62%', 'Claude Code', 'Pessoal', 'Entre na conta no computador', 'A troca vale para novas sessões',
    'Uma tarefa em execução continua na conta em que começou.', 'Leitura de Mac de Foco, atualizada há 5 min']) {
    expect(rendered).toContain(expected);
  }
  expect(rendered).not.toMatch(forbiddenOnMainScreens);
  expect(rendered).not.toMatch(forbiddenPunctuation);
  // A conta sem leitura não ganha número inventado: só as duas janelas do Codex têm percentual.
  expect(rendered.match(/\d+%/g)).toEqual(['19%', '62%']);
  expect(rendered).not.toMatch(/Contas|Detalhes de uso/);
  await tap(tree, 'Trocar a conta do Codex, atual Codex');
  expect(handlers.onIntent).toHaveBeenLastCalledWith(store.desktops[0], { kind: 'profiles' });
  await tap(tree, 'Detalhes de Pessoal no Claude Code');
  expect(text(tree)).toContain('Gerenciar no terminal');
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Agents marks the active account among many, flags limits near the end and shows every window of the account', async () => {
  jest.useFakeTimers({ now: NOW });
  const long = 'Conta compartilhada da equipe de produto com um nome realmente comprido para caber';
  const base = snapshot();
  const accounts = [
    { id: 'codex-trabalho', agent: 'codex', label: 'Trabalho', plan: 'Pro', active: false, state: 'ok', fetchedAtMs: NOW, windows: [
      { id: 'session', label: 'Limite de 5 horas', usedFraction: 1, resetsAtMs: NOW + 40 * 60_000, durationMs: 18_000_000, headline: true, weekly: false }] },
    { id: 'codex-long', agent: 'codex', label: long, plan: null, active: false, state: 'ok', fetchedAtMs: NOW, windows: [
      { id: 'weekly', label: 'Limite semanal', usedFraction: 0.8, resetsAtMs: NOW + 86_400_000, durationMs: 604_800_000, headline: false, weekly: true }] },
    ...base.accounts,
    { id: 'claude-max', agent: 'claude', label: 'Max', plan: 'Max', active: false, state: 'ok', fetchedAtMs: NOW, windows: [
      { id: 'five', label: 'Sessão', usedFraction: 0.3, resetsAtMs: null, durationMs: null, headline: true, weekly: false },
      { id: 'opus', label: 'Opus semanal', usedFraction: 0.5, resetsAtMs: null, durationMs: null, headline: false, weekly: false },
      { id: 'all', label: 'Todos os modelos', usedFraction: 0.2, resetsAtMs: null, durationMs: null, headline: false, weekly: true }] }
  ];
  const { tree } = await renderAgents({}, { dashboard: { ...base, accounts } });
  const rendered = text(tree);
  expect(rendered).toContain('3 contas');
  expect(rendered).toContain('2 contas');
  expect(rendered).toContain('Esgotado');
  expect(rendered).toContain('Perto do limite');
  expect(rendered).toContain(long);
  for (const label of ['Sessão', 'Opus semanal', 'Todos os modelos']) expect(rendered).toContain(label);
  // A conta ativa vem primeiro, com o selo de padrão.
  const order = ['Trocar a conta do Codex, atual Codex', 'Trocar a conta do Codex, atual Trabalho', `Trocar a conta do Codex, atual ${long}`];
  const switches = tree.root.findAll(node => typeof node.props.onPress === 'function' && order.includes(node.props.accessibilityLabel))
    .map(node => node.props.accessibilityLabel);
  expect([...new Set(switches)]).toEqual(order);
  expect(rendered.match(/Padrão/g)).toHaveLength(2);
  // A engrenagem abre a folha com todas as janelas da conta e a hora da renovação.
  await tap(tree, 'Detalhes de Trabalho no Codex');
  expect(text(tree)).toContain('Renova em 40 min');
  expect(text(tree)).toContain('Renovação');
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Agents shows skeletons while reading and asks to read the accounts without a snapshot', async () => {
  const loading = await renderAgents({}, { dashboard: null, loaded: false });
  expect(loading.tree.root.findAll(node => node.props.accessibilityRole === 'progressbar')).toHaveLength(0);
  expect(text(loading.tree)).not.toMatch(/\d+%/);
  await act(async () => loading.tree.unmount());

  const { tree, handlers } = await renderAgents({}, { dashboard: null });
  expect(text(tree)).toContain('Ainda sem leitura das contas');
  expect(text(tree)).toContain('Abra o terminal de Mac de Foco uma vez para ler as contas e o uso dos agentes.');
  await act(async () => { pressable(tree, 'Ler contas no computador').props.onPress(); });
  expect(handlers.onIntent).toHaveBeenCalledWith(store.desktops[0], { kind: 'profiles' });
  await act(async () => tree.unmount());

  // Um agente sem conta oferece adicionar, e a leitura com erro diz o estado.
  const base = snapshot();
  const accounts = [{ ...base.accounts[0], state: 'error', windows: [] }];
  const partial = await renderAgents({}, { dashboard: { ...base, accounts } });
  expect(text(partial.tree)).toContain('Não foi possível ler o uso');
  expect(text(partial.tree)).toContain('Nenhuma conta neste computador');
  await act(async () => { pressable(partial.tree, 'Adicionar conta').props.onPress(); });
  expect(partial.handlers.onIntent).toHaveBeenCalledWith(store.desktops[0], { kind: 'profiles' });
  await act(async () => partial.tree.unmount());
});

test('Home projects put favorites first, offer to add them and open sessions in the right folder', async () => {
  const { tree, handlers } = await renderHome();
  expect(text(tree)).toContain('Adicionar favoritos');
  await tap(tree, 'Abrir psicoapp');
  expect(text(tree)).toContain('/home/pessoa/Projects/psicoapp');
  await tap(tree, 'Continuar psicoapp');
  expect(handlers.onIntent).toHaveBeenLastCalledWith(store.desktops[0], { kind: 'session', sessionId: 's1' });
  await tap(tree, 'Abrir frontend');
  expect(text(tree)).toContain('Nenhuma sessão aberta nesta pasta.');
  await tap(tree, 'Favoritar frontend');
  await tap(tree, 'Nova sessão aqui');
  expect(handlers.onIntent).toHaveBeenLastCalledWith(store.desktops[0], { kind: 'new-session', cwd: '/home/pessoa/Projects/frontend' });
  // Com um favorito, a grade mostra só os favoritos e oferece gerenciar.
  expect(text(tree)).not.toContain('Adicionar favoritos');
  expect(text(tree)).toContain('Gerenciar favoritos');
  expect(labelledAll(tree, 'Abrir psicoapp')).toHaveLength(0);
  await act(async () => tree.unmount());
});

test('Home offers the community rooms and opens the published address', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const { tree } = await renderHome();
  const rendered = text(tree);
  for (const expected of ['Comunidade', 'Converse com quem usa e desenvolve o Cialai', 'Discord', 'WhatsApp']) {
    expect(rendered).toContain(expected);
  }
  expect(rendered).not.toMatch(forbiddenPunctuation);
  await act(async () => { tree.root.findAll(node => node.props.accessibilityLabel === 'Entrar no Discord')[0].props.onPress(); });
  expect(open).toHaveBeenCalledWith('https://discord.gg/Kd4yjB24wP');
  await act(async () => { tree.root.findAll(node => node.props.accessibilityLabel === 'Entrar no WhatsApp')[0].props.onPress(); });
  expect(open).toHaveBeenCalledWith('https://chat.whatsapp.com/JktntW0R31gKdvCBnLj9cQ');
  // Papel de link, e nao de botao: leva para fora do app.
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Entrar no Discord')[0].props.accessibilityRole).toBe('link');
  await act(async () => tree.unmount());
  open.mockRestore();
});

test('Home without computers offers pairing and shows an offline computer without Disconnect', async () => {
  resetDashboardForTests(memoryFiles(), true);
  const handlers = homeHandlers();
  let tree;
  await act(async () => {
    tree = create(<Home store={{ version: 2, lastDesktopId: null, desktops: [] }} describe={() => ({ state: 'idle', transport: null })}
      keptDesktopId={null} {...handlers} />);
  });
  const rendered = text(tree);
  for (const expected of ['Conecte seu primeiro computador', 'Vincule seu computador para acessar seus terminais e projetos de qualquer lugar.',
    'Vincular computador', 'Como vincular', 'Comunidade']) {
    expect(rendered).toContain(expected);
  }
  // Sem computador, o painel e os atalhos que dependem dele não aparecem.
  expect(rendered).not.toMatch(/Ações rápidas|Seus projetos/);
  expect(rendered).not.toMatch(forbiddenPunctuation);
  await tap(tree, 'Vincular computador');
  expect(handlers.onPair).toHaveBeenCalledTimes(1);
  await act(async () => tree.update(<Home store={{ ...store, desktops: [store.desktops[0]] }}
    describe={() => ({ state: 'offline', transport: null })} keptDesktopId={null} {...handlers} />));
  expect(text(tree)).toMatch(/Fora de alcance/);
  expect(text(tree)).toMatch(/Reserva/);
  expect(text(tree)).not.toMatch(/Desconectar/);
  await act(async () => tree.unmount());
});

// O primeiro acesso só aparece com a loja lida e vazia: carregando há o
// esqueleto, e uma falha de leitura oferece nova tentativa, nunca o vínculo.
test('Home shows a skeleton while loading and a retry when the store fails, never the first access', async () => {
  resetDashboardForTests(memoryFiles(), true);
  const handlers = homeHandlers();
  const empty = { version: 2, lastDesktopId: null, desktops: [] };
  let tree;
  await act(async () => {
    tree = create(<Home {...handlers} describe={() => ({ state: 'idle', transport: null })} keptDesktopId={null} store={empty} storeState="loading" />);
  });
  expect(text(tree)).not.toMatch(/Conecte seu primeiro computador|Comunidade/);
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Abrindo seus computadores' && node.props.accessible)).not.toHaveLength(0);
  await act(async () => tree.update(<Home {...handlers} describe={() => ({ state: 'idle', transport: null })} keptDesktopId={null}
    store={empty} storeState="error" />));
  expect(text(tree)).toMatch(/Não foi possível abrir os computadores guardados/);
  expect(text(tree)).not.toMatch(/Conecte seu primeiro computador/);
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Vincular computador')).toHaveLength(0);
  await tap(tree, 'Tentar de novo');
  expect(handlers.onRetryStore).toHaveBeenCalledTimes(1);
  expect(handlers.onPair).not.toHaveBeenCalled();
  await act(async () => tree.unmount());
});

test('Home renders the selected Spanish locale', async () => {
  await setLocale('es-MX');
  const { tree } = await renderHome();
  for (const expected of ['Computadoras', 'Tus proyectos', 'Abrir terminal', 'Acciones rápidas', 'Nueva sesión Vincular Terminales Agentes']) {
    expect(text(tree)).toContain(expected);
  }
  expect(tree.root.findAll(node => node.props.accessibilityLabel === 'Vincular computadora')).not.toHaveLength(0);
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

test('Settings turns notifications on, keeps them off when blocked and opens the device settings', async () => {
  const onNotification = jest.fn();
  const openSettings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  const props = { desktopCount: 0, tunnelStatus: null, appVersion: '1.0.0', coreVersion: '1.0.0', logLevel: 'info',
    onBack: () => {}, onLogLevel: () => {}, onRefreshStatus: () => {}, onNotification };
  let tree;
  await act(async () => { tree = create(<Settings {...props} notificationPrefs={{ sessions: true, usage: false }} />); });
  expect(text(tree)).toMatch(/Notificações/);
  const toggle = label => tree.root.findAll(node => node.props.accessibilityRole === 'switch' && node.props.accessibilityLabel === label)[0];
  expect(toggle('Sessões finalizadas').props.accessibilityState.checked).toBe(true);
  expect(toggle('Alertas de uso de conta').props.accessibilityState.checked).toBe(false);
  await act(async () => { toggle('Alertas de uso de conta').props.onPress(); });
  expect(onNotification).toHaveBeenCalledWith('usage', true);
  expect(text(tree)).not.toMatch(/Atualizações do app/);
  await act(async () => tree.update(<Settings {...props} notificationAccess="denied" notificationPrefs={{ sessions: true, usage: true }} />));
  expect(toggle('Sessões finalizadas').props.accessibilityState.checked).toBe(false);
  expect(text(tree)).toMatch(/bloqueadas nos ajustes do aparelho/);
  await act(async () => { pressable(tree, 'Abrir ajustes do aparelho').props.onPress(); });
  expect(openSettings).toHaveBeenCalled();
  openSettings.mockRestore();
  await act(async () => tree.unmount());
});

test('Settings reports the log level and shows version, licenses and technical information', async () => {
  const onLogLevel = jest.fn();
  let tree;
  await act(async () => {
    tree = create(<Settings desktopCount={0} tunnelStatus={null} appVersion="0.2.10" coreVersion="core-9" logLevel="info"
      onBack={() => {}} onLogLevel={onLogLevel} onRefreshStatus={() => {}} />);
  });
  expect(text(tree)).toMatch(/Erros Informações Diagnóstico/);
  await act(async () => { labelled(tree, 'Diagnóstico').props.onPress(); });
  expect(onLogLevel).toHaveBeenCalledWith('debug');
  expect(text(tree)).toContain('Cialai v0.2.10');
  await act(async () => { labelled(tree, 'Licenças de código aberto').props.onPress(); });
  expect(text(tree)).toContain('Cialai sob a licença Apache-2.0');
  expect(text(tree)).toContain('Tailscale / tsnet');
  await act(async () => { labelled(tree, 'Informações técnicas').props.onPress(); });
  expect(text(tree)).toContain('core-9');
  expect(text(tree)).not.toMatch(forbiddenPunctuation);
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

test('Shell hands the Home request to the page once and passes the page snapshot back', async () => {
  const onDashboard = jest.fn();
  const onProjectPicked = jest.fn();
  const intent = { id: 'i1', kind: 'new-session', cwd: '/p/</script><script>alert(1)</script>' };
  let tree;
  await act(async () => { tree = create(<Shell {...shellProps({ intent, onDashboard, onProjectPicked })} />); });
  const webView = tree.root.findAll(node => typeof node.props.injectedJavaScriptBeforeContentLoaded === 'string')[0];
  const bootstrap = webView.props.injectedJavaScriptBeforeContentLoaded;
  expect(bootstrap).toContain('"intent":{"id":"i1","kind":"new-session"');
  // A pasta vem do computador: nada nela fecha o script do bootstrap.
  expect(bootstrap).not.toContain('</script>');
  const snapshot = { type: 'dashboard', at: 5, accounts: [], projects: [], sessions: [] };
  await act(async () => {
    await webView.props.onMessage({ nativeEvent: { url: 'http://127.0.0.1:47400/', data: JSON.stringify(snapshot) } });
  });
  expect(onDashboard).toHaveBeenCalledWith({ ...snapshot, recent: [] });
  await act(async () => {
    await webView.props.onMessage({ nativeEvent: { url: 'https://evil.example/', data: JSON.stringify(snapshot) } });
  });
  expect(onDashboard).toHaveBeenCalledTimes(1);
  // A pasta escolhida no navegador da página volta como atalho.
  const picked = { type: 'project-picked', path: '/p/alfa', name: 'alfa' };
  await act(async () => {
    await webView.props.onMessage({ nativeEvent: { url: 'https://evil.example/', data: JSON.stringify(picked) } });
  });
  expect(onProjectPicked).not.toHaveBeenCalled();
  await act(async () => {
    await webView.props.onMessage({ nativeEvent: { url: 'http://127.0.0.1:47400/', data: JSON.stringify(picked) } });
  });
  expect(onProjectPicked).toHaveBeenCalledWith('/p/alfa');
  await act(async () => tree.unmount());
});

test('Shell shows the reconnecting banner above the page and keeps the same source', async () => {
  jest.useFakeTimers();
  const onHome = jest.fn();
  let tree;
  await act(async () => { tree = create(<Shell {...shellProps({ onHome })} />); });
  const webView = () => tree.root.findAll(node => node.props.source?.uri)[0];
  const source = webView().props.source;
  // O voltar da barra é um ícone que leva ao início, com rótulo próprio.
  await act(async () => { labelled(tree, 'Ir para o início').props.onPress(); });
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
