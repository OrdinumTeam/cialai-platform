import { beforeEach, expect, jest, test } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { Text } from 'react-native';

import { Desktops } from './Desktops';
import { Offline } from './Offline';
import { Pair } from './Pair';
import { Settings } from './Settings';
import { getLocale, setLocale } from '../i18n';

jest.mock('cialai-tunnel', () => ({
  inspectPairPayload: jest.fn(),
  pair: jest.fn()
}));
jest.mock('expo-camera', () => ({
  CameraView: 'CameraView',
  useCameraPermissions: () => [{ granted: false }, jest.fn()]
}));
jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn(async () => '') }));

const text = tree => tree.root.findAllByType(Text).map(node => node.props.children).flat(Infinity).join(' ');

beforeEach(async () => {
  await setLocale('pt-BR');
});

test('Pair explains the QR flow and camera use', async () => {
  let tree;
  await act(async () => {
    tree = create(<Pair device={{ name: 'iPhone', model: 'iPhone16,1', platform: 'ios', app: '1.0.0' }} onPaired={async () => {}} />);
  });
  expect(text(tree)).toMatch(/Abra Vincular celular no/);
  expect(text(tree)).toMatch(/Permitir câmera/);
  await act(async () => tree.unmount());
});

test('Desktops renders names, state and profile', async () => {
  const store = { lastProfileId: 'p1', lastDesktopId: 'd1', profiles: [{ id: 'p1', controlUrl: 'https://hs.example.com',
    userId: '42', userName: 'foco', lastUsedAt: '2026-09-12T12:00:00Z', desktops: [{ id: 'd1', name: 'Mac de Foco',
      port: 4740, nodeKey: 'nodekey:test', deviceId: 'dev1', pairedAt: '2026-09-12T12:00:00Z', lastSeenAt: '2026-09-12T12:00:00Z' }] }] };
  let tree;
  await act(async () => { tree = create(<Desktops store={store} tunnelStatus={null} onOpen={() => {}} onPair={() => {}}
    onSettings={() => {}} onSwitchProfile={() => {}} onRename={() => {}} onForgetDesktop={() => {}} />); });
  expect(text(tree)).toMatch(/Mac de Foco/);
  expect(text(tree)).toMatch(/Fora de alcance/);
  await act(async () => tree.unmount());
});

test('Offline renders the exact reason and retry actions', async () => {
  jest.useFakeTimers();
  let tree;
  await act(async () => { tree = create(<Offline reason="reconnecting" onRetry={async () => false} onDesktops={() => {}} />); });
  expect(text(tree)).toMatch(/Reconectando/);
  expect(text(tree)).toMatch(/Tentar agora/);
  expect(text(tree)).toMatch(/Trocar de computador/);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Offline renders the selected Spanish locale', async () => {
  jest.useFakeTimers();
  await setLocale('es-MX');
  let tree;
  await act(async () => { tree = create(<Offline reason="desktop" onRetry={async () => false} onDesktops={() => {}} />); });
  expect(text(tree)).toMatch(/La computadora está fuera de alcance/);
  expect(text(tree)).toMatch(/Intentar ahora/);
  expect(text(tree)).toMatch(/Cambiar de computadora/);
  await act(async () => tree.unmount());
  jest.useRealTimers();
});

test('Settings offers and persists the three supported languages', async () => {
  let tree;
  await act(async () => {
    tree = create(<Settings store={{ profiles: [], lastProfileId: null, lastDesktopId: null }} appVersion="1.0.0"
      coreVersion="1.0.0" logLevel="info" onBack={() => {}} onForgetProfile={() => {}} onLogLevel={() => {}} />);
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
