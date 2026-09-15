import { ANDROID_BACKGROUND_STOP_MS, createNetworkForwarder, handleAppStateTransition } from './lifecycle';
import type { AppScreen } from './machine';

const desktopId = 'd_AAAAAAAAAAAAAAAAAAAAAA';
const shell: AppScreen = {
  kind: 'shell',
  desktopId,
  url: `http://127.0.0.1:47400/?k=${'A'.repeat(43)}`,
  transport: 'tor',
  path: 'tor'
};

function transitionFrom(
  nextState: 'active' | 'background' | 'inactive',
  backgroundedAt: number | null,
  now: number,
  platform: 'ios' | 'android',
  screen: AppScreen = shell
) {
  const notifyForeground = jest.fn();
  const result = handleAppStateTransition({ nextState, backgroundedAt, now, platform, screen, notifyForeground });
  return { result, notifyForeground };
}

describe('app state transitions', () => {
  test('notifies the core once when the app really goes to the background', () => {
    const first = transitionFrom('background', null, 1_000, 'ios');
    expect(first.result).toEqual({ backgroundedAt: 1_000, action: { kind: 'none' } });
    expect(first.notifyForeground).toHaveBeenCalledWith(false);

    const repeated = transitionFrom('background', 1_000, 1_500, 'ios');
    expect(repeated.result.backgroundedAt).toBe(1_000);
    expect(repeated.notifyForeground).not.toHaveBeenCalled();
  });

  test('ignores inactive states from Face ID, control center and the app switcher', () => {
    const inactive = transitionFrom('inactive', null, 1_000, 'ios');
    expect(inactive.result).toEqual({ backgroundedAt: null, action: { kind: 'none' } });
    expect(inactive.notifyForeground).not.toHaveBeenCalled();

    const back = transitionFrom('active', null, 1_200, 'ios');
    expect(back.result.action).toEqual({ kind: 'none' });
    expect(back.notifyForeground).not.toHaveBeenCalled();
  });

  test('keeps the background time while inactive follows background', () => {
    const inactive = transitionFrom('inactive', 1_000, 2_000, 'ios');
    expect(inactive.result.backgroundedAt).toBe(1_000);
  });

  test.each([1_000, ANDROID_BACKGROUND_STOP_MS * 10])('iOS verifies the proxy and accepts reconnecting from zero after %i ms', duration => {
    const { result, notifyForeground } = transitionFrom('active', 5_000, 5_000 + duration, 'ios');
    expect(notifyForeground).toHaveBeenCalledWith(true);
    expect(result).toEqual({ backgroundedAt: null, action: { kind: 'verify', desktopId, url: shell.url } });
  });

  test('Android verifies the proxy after a short background', () => {
    const { result, notifyForeground } = transitionFrom('active', 1_000, ANDROID_BACKGROUND_STOP_MS, 'android');
    expect(notifyForeground).toHaveBeenCalledWith(true);
    expect(result.action).toEqual({ kind: 'verify', desktopId, url: shell.url });
  });

  test('Android waits for the native reopening after the two minute stop', () => {
    const { result, notifyForeground } = transitionFrom('active', 1_000, 1_000 + ANDROID_BACKGROUND_STOP_MS, 'android');
    expect(notifyForeground).toHaveBeenCalledWith(true);
    expect(result.action).toEqual({ kind: 'await-native-reopen', desktopId, url: shell.url });
  });

  test('retries an unreachable desktop right away on both systems', () => {
    const offline: AppScreen = { kind: 'offline', desktopId, reason: 'no-path' };
    for (const platform of ['ios', 'android'] as const) {
      expect(transitionFrom('active', 1_000, 400_000, platform, offline).result.action).toEqual({ kind: 'reconnect', desktopId });
    }
  });

  test('never retries a revoked phone and leaves other screens alone', () => {
    const removed: AppScreen = { kind: 'offline', desktopId, reason: 'removed' };
    expect(transitionFrom('active', 1_000, 2_000, 'ios', removed).result.action).toEqual({ kind: 'none' });
    expect(transitionFrom('active', 1_000, 2_000, 'android', { kind: 'desktops' }).result.action).toEqual({ kind: 'none' });
    expect(transitionFrom('active', 1_000, 2_000, 'ios', { kind: 'pair' }).result.action).toEqual({ kind: 'none' });
  });
});

describe('network changes', () => {
  test.each([
    [{ isConnected: true, isInternetReachable: true }, true],
    [{ isConnected: true, isInternetReachable: null }, true],
    [{ isConnected: false, isInternetReachable: true }, false],
    [{ isConnected: true, isInternetReachable: false }, false],
    [{ isConnected: null, isInternetReachable: null }, false]
  ])('forwards conservative reachability %#', (state, expected) => {
    const notifyNetworkChange = jest.fn();
    expect(createNetworkForwarder(notifyNetworkChange)(state).reachable).toBe(expected);
    expect(notifyNetworkChange).toHaveBeenCalledWith(expected);
  });

  test('forwards interface changes with the same reachability and drops exact repeats', () => {
    const notifyNetworkChange = jest.fn();
    const forward = createNetworkForwarder(notifyNetworkChange);
    expect(forward({ isConnected: true, isInternetReachable: true, type: 'wifi' })).toEqual({ reachable: true, changed: true, regained: false });
    expect(forward({ isConnected: true, isInternetReachable: true, type: 'wifi' })).toEqual({ reachable: true, changed: false, regained: false });
    expect(forward({ isConnected: true, isInternetReachable: true, type: 'cellular' })).toEqual({ reachable: true, changed: true, regained: false });
    expect(notifyNetworkChange).toHaveBeenCalledTimes(2);
  });

  test('reports when the network comes back', () => {
    const notifyNetworkChange = jest.fn();
    const forward = createNetworkForwarder(notifyNetworkChange);
    forward({ isConnected: true, isInternetReachable: true, type: 'wifi' });
    expect(forward({ isConnected: false, isInternetReachable: false, type: 'none' })).toEqual({ reachable: false, changed: true, regained: false });
    expect(forward({ isConnected: true, isInternetReachable: null, type: 'cellular' })).toEqual({ reachable: true, changed: true, regained: true });
    expect(notifyNetworkChange.mock.calls).toEqual([[true], [false], [true]]);
  });
});
