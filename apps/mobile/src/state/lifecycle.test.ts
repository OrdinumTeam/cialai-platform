import { handleAppStateTransition, notifyNetworkTransition } from './lifecycle';

const shell = {
  kind: 'shell' as const,
  desktopId: 'd_AAAAAAAAAAAAAAAAAAAAAA',
  url: `http://127.0.0.1:47400/?k=${'A'.repeat(43)}`
};

describe('native lifecycle transitions', () => {
  test('notifies background and probes immediately when iOS returns active', async () => {
    const notifyForeground = jest.fn();
    const checkHealth = jest.fn(async () => false);
    const markOffline = jest.fn();
    const reconnect = jest.fn();

    const backgroundedAt = handleAppStateTransition({
      nextState: 'background', backgroundedAt: null, now: 1_000, platform: 'ios', screen: shell,
      notifyForeground, checkHealth, markOffline, reconnect
    });
    expect(backgroundedAt).toBe(1_000);
    expect(notifyForeground).toHaveBeenLastCalledWith(false);

    const activeAt = handleAppStateTransition({
      nextState: 'active', backgroundedAt, now: 2_000, platform: 'ios', screen: shell,
      notifyForeground, checkHealth, markOffline, reconnect
    });
    expect(activeAt).toBeNull();
    expect(notifyForeground).toHaveBeenLastCalledWith(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(checkHealth).toHaveBeenCalledWith(shell.url);
    expect(markOffline).toHaveBeenCalledWith(shell.desktopId, 'desktop');
    expect(reconnect).not.toHaveBeenCalled();
  });

  test('requests Android reconnection after two minutes without probing the stale proxy', async () => {
    const notifyForeground = jest.fn();
    const checkHealth = jest.fn(async () => true);
    const markOffline = jest.fn();
    const reconnect = jest.fn();
    handleAppStateTransition({
      nextState: 'active', backgroundedAt: 1_000, now: 121_000, platform: 'android', screen: shell,
      notifyForeground, checkHealth, markOffline, reconnect
    });
    await Promise.resolve();
    expect(notifyForeground).toHaveBeenCalledWith(true);
    expect(reconnect).toHaveBeenCalledWith(shell.desktopId);
    expect(checkHealth).not.toHaveBeenCalled();
    expect(markOffline).not.toHaveBeenCalled();
  });

  test.each([
    [{ isConnected: true, isInternetReachable: true }, true],
    [{ isConnected: true, isInternetReachable: null }, true],
    [{ isConnected: false, isInternetReachable: true }, false],
    [{ isConnected: true, isInternetReachable: false }, false]
  ])('forwards conservative network reachability', (state, expected) => {
    const notifyNetworkChange = jest.fn();
    expect(notifyNetworkTransition(state, notifyNetworkChange)).toBe(expected);
    expect(notifyNetworkChange).toHaveBeenCalledWith(expected);
  });
});
