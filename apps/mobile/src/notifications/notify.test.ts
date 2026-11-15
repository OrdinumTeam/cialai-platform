import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { nativeNotice, noticeAttachment, noticeRequest, onNoticeOpened, presentNotices } from './notify';

const mockNative = {
  listeners: new Set<(event: { kind: string; payload: unknown }) => void>(),
  presentNotice: jest.fn(async (_notice: unknown) => true),
  opened: null as null | { desktopId: string; sessionId: string }
};
jest.mock('cialai-tunnel', () => ({
  addListener: (handler: (event: { kind: string; payload: unknown }) => void) => {
    mockNative.listeners.add(handler);
    return { remove: () => mockNative.listeners.delete(handler) };
  },
  canPresentNotices: () => true,
  presentNotice: (notice: unknown) => mockNative.presentNotice(notice),
  takeOpenedNotice: () => { const opened = mockNative.opened; mockNative.opened = null; return opened; }
}));
const mockFiles: { uri: string; bytes: Uint8Array }[] = [];
jest.mock('expo-file-system', () => ({
  Paths: { cache: 'file:///cache' },
  Directory: class { exists = true; uri: string; constructor(...parts: string[]) { this.uri = parts.join('/'); } create() {} },
  File: class {
    uri: string;
    constructor(directory: { uri: string }, name: string) { this.uri = `${directory.uri}/${name}`; }
    write(bytes: Uint8Array) { mockFiles.push({ uri: this.uri, bytes }); }
  }
}));

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
  getPermissionsAsync: jest.fn(async () => ({ granted: true, canAskAgain: true })),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 }
}));

const mocked = Notifications as jest.Mocked<typeof Notifications>;
const target = { desktopId: 'd', sessionId: 's1' };
const response = (data: Record<string, unknown>) =>
  ({ notification: { request: { identifier: 'd:s1', content: { data } }, date: 1 } }) as unknown as Notifications.NotificationResponse;

test('an attention notice carries the computer, the session color and the session it opens', () => {
  const request = noticeRequest({
    key: 'k', title: '🟢 site-exemplo', body: 'Pediu atenção', subtitle: 'Mac', color: '#1f9d5b',
    channel: 'attention', identifier: 'd:s1', target
  });
  expect(request.identifier).toBe('d:s1');
  expect(request.content).toEqual({ title: '🟢 site-exemplo', body: 'Pediu atenção', subtitle: 'Mac', color: '#1f9d5b', data: { target } });
});

test('a plain notice keeps only title and body', () => {
  const request = noticeRequest({ key: 'k', title: 'Codex perto do limite', body: 'Limite de 5 horas em 80%' });
  expect(request.identifier).toBeUndefined();
  expect(request.content).toEqual({ title: 'Codex perto do limite', body: 'Limite de 5 horas em 80%' });
});

test('tapping a session notice opens it, also when the tap launched the app, and only once', () => {
  const opened: unknown[] = [];
  mocked.getLastNotificationResponse.mockReturnValueOnce(response({ target }));
  const stop = onNoticeOpened(value => opened.push(value));
  expect(opened).toEqual([target]);
  expect(mocked.clearLastNotificationResponse).toHaveBeenCalledTimes(1);
  const listener = mocked.addNotificationResponseReceivedListener.mock.calls[0]![0];
  listener(response({ target: { desktopId: 'd', sessionId: 's2' } }));
  listener(response({ other: true }));
  expect(opened).toEqual([target, { desktopId: 'd', sessionId: 's2' }]);
  stop();
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const withImage = { key: 'k2', title: 'site-exemplo', body: 'Pediu atenção', subtitle: 'Mac', color: '#1a4fa0', channel: 'attention' as const,
  identifier: 'd:s1', target, image: PNG };

test('the Android notice carries the session image, its color, the tag that replaces the previous one and the session it opens', () => {
  expect(nativeNotice(withImage)).toEqual({
    tag: 'd:s1', channel: 'attention', channelName: expect.any(String), title: 'site-exemplo', body: 'Pediu atenção',
    subtitle: 'Mac', color: '#1a4fa0', image: PNG, desktopId: 'd', sessionId: 's1'
  });
  // Sem identificador, a chave do aviso vira a etiqueta; sem imagem, nada de imagem.
  expect(nativeNotice({ key: 'k', title: 't', body: 'b' })).toEqual({ tag: 'k', channel: 'activity', channelName: expect.any(String), title: 't', body: 'b' });
});

test('the iPhone notice attaches the session image as a file of its own', () => {
  const attachment = noticeAttachment(withImage);
  expect(attachment).toEqual({ identifier: 'session', url: expect.stringMatching(/^file:\/\/\/cache\/notice-badges\/badge-\d+-\d+\.png$/), type: null, typeHint: 'public.png', hideThumbnail: false });
  expect(Array.from(mockFiles.at(-1)!.bytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(noticeAttachment({ ...withImage, url: undefined, image: 'not a png' } as never)).toBeNull();
  expect(noticeAttachment({ key: 'k', title: 't', body: 'b' })).toBeNull();
  expect(noticeRequest(withImage, attachment).content.attachments).toEqual([attachment]);
});

test('on Android the native module draws the notice; when it fails the expo notice still goes out', async () => {
  const os = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  try {
    await presentNotices([withImage]);
    expect(mockNative.presentNotice).toHaveBeenCalledWith(expect.objectContaining({ tag: 'd:s1', image: PNG }));
    expect(mocked.scheduleNotificationAsync).not.toHaveBeenCalled();
    mockNative.presentNotice.mockResolvedValueOnce(false);
    await presentNotices([{ ...withImage, key: 'k3' }]);
    expect(mocked.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  } finally {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  }
});

test('tapping a notice drawn by Android opens its session, also when the tap launched the app', () => {
  const os = Platform.OS;
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  try {
    const opened: unknown[] = [];
    mockNative.opened = { desktopId: 'd', sessionId: 's9' };
    const stop = onNoticeOpened(value => opened.push(value));
    expect(opened).toEqual([{ desktopId: 'd', sessionId: 's9' }]);
    mockNative.opened = { desktopId: 'd', sessionId: 's10' };
    mockNative.listeners.forEach(listener => listener({ kind: 'notice', payload: {} }));
    mockNative.listeners.forEach(listener => listener({ kind: 'notice', payload: {} }));
    expect(opened).toEqual([{ desktopId: 'd', sessionId: 's9' }, { desktopId: 'd', sessionId: 's10' }]);
    stop();
    expect(mockNative.listeners.size).toBe(0);
  } finally {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
  }
});
