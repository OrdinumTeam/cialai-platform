import * as Notifications from 'expo-notifications';

import { noticeRequest, onNoticeOpened } from './notify';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => null),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
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
