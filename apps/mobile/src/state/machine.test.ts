import type { TunnelStatus } from 'cialai-tunnel';

import { describeDesktop, transition, type AppScreen, type OfflineReason } from './machine';

const desktopId = 'd_AAAAAAAAAAAAAAAAAAAAAA';
const otherDesktopId = 'd_BBBBBBBBBBBBBBBBBBBBBB';
const url = 'http://127.0.0.1:47400/';

describe('mobile state transitions', () => {
  const loading: AppScreen = { kind: 'loading' };

  test('opens pairing with an optional error or notice', () => {
    expect(transition(loading, { type: 'needs-pairing' })).toEqual({ kind: 'pair' });
    expect(transition(loading, { type: 'needs-pairing', error: 'Código inválido' })).toEqual({ kind: 'pair', error: 'Código inválido' });
    expect(transition(loading, { type: 'needs-pairing', notice: 'Vincule de novo' })).toEqual({ kind: 'pair', notice: 'Vincule de novo' });
  });

  test('opens the desktop list and settings', () => {
    expect(transition(loading, { type: 'show-desktops' })).toEqual({ kind: 'desktops' });
    expect(transition(loading, { type: 'show-settings' })).toEqual({ kind: 'settings' });
  });

  test('opens the home from any screen, including an open shell', () => {
    expect(transition(loading, { type: 'show-home' })).toEqual({ kind: 'home' });
    const shell = transition(loading, { type: 'desktop-opened', desktopId, url, transport: 'direct', path: 'lan' });
    expect(transition(shell, { type: 'show-home' })).toEqual({ kind: 'home' });
    const removed: AppScreen = { kind: 'offline', desktopId, reason: 'removed' };
    expect(transition(removed, { type: 'show-home' })).toEqual({ kind: 'home' });
    const home: AppScreen = { kind: 'home' };
    expect(transition(home, { type: 'path-changed', desktopId, transport: 'tor', path: 'tor' })).toBe(home);
    expect(transition(home, { type: 'desktop-opened', desktopId, url, transport: 'tor', path: 'tor' }))
      .toEqual({ kind: 'shell', desktopId, url, transport: 'tor', path: 'tor', reconnecting: false });
  });

  test('opens a local shell with the active transport', () => {
    expect(transition(loading, { type: 'desktop-opened', desktopId, url, transport: 'direct', path: 'lan' }))
      .toEqual({ kind: 'shell', desktopId, url, transport: 'direct', path: 'lan', reconnecting: false });
  });

  test('health loss marks the shell as reconnecting without leaving the page', () => {
    const shell = transition(loading, { type: 'desktop-opened', desktopId, url, transport: 'tor', path: 'tor' });
    const reconnecting = transition(shell, { type: 'shell-reconnecting', desktopId });
    expect(reconnecting).toEqual({ kind: 'shell', desktopId, url, transport: 'tor', path: 'tor', reconnecting: true });
    expect(transition(reconnecting, { type: 'shell-reconnecting', desktopId })).toBe(reconnecting);
    expect(transition(shell, { type: 'shell-reconnecting', desktopId: otherDesktopId })).toBe(shell);
    expect(transition(reconnecting, { type: 'shell-recovered', desktopId })).toEqual(shell);
    expect(transition(shell, { type: 'shell-recovered', desktopId })).toBe(shell);
    const offline: AppScreen = { kind: 'offline', desktopId, reason: 'no-path' };
    expect(transition(offline, { type: 'shell-reconnecting', desktopId })).toBe(offline);
    expect(transition(offline, { type: 'shell-recovered', desktopId })).toBe(offline);
  });

  test('reopening the same proxy keeps the page and clears the reconnecting flag', () => {
    const shell = transition(loading, { type: 'desktop-opened', desktopId, url, transport: 'tor', path: 'tor' });
    expect(transition(shell, { type: 'desktop-opened', desktopId, url, transport: 'tor', path: 'tor' })).toBe(shell);
    const reconnecting = transition(shell, { type: 'shell-reconnecting', desktopId });
    expect(transition(reconnecting, { type: 'desktop-opened', desktopId, url, transport: 'tor', path: 'tor' })).toEqual(shell);
    expect(transition(reconnecting, { type: 'desktop-opened', desktopId, url: 'http://127.0.0.1:47401/', transport: 'direct', path: 'lan' }))
      .toEqual({ kind: 'shell', desktopId, url: 'http://127.0.0.1:47401/', transport: 'direct', path: 'lan', reconnecting: false });
  });

  test.each<OfflineReason>(['reconnecting', 'reserve-preparing', 'reserve-unavailable', 'no-path', 'tunnel', 'removed'])(
    'shows the %s offline reason', reason => {
      expect(transition(loading, { type: 'desktop-offline', desktopId, reason })).toEqual({ kind: 'offline', desktopId, reason });
    });

  test('path events move the dot only for the open desktop', () => {
    const shell = transition(loading, { type: 'desktop-opened', desktopId, url, transport: 'direct', path: 'direct' });
    expect(transition(shell, { type: 'path-changed', desktopId, transport: 'tor', path: 'tor' }))
      .toEqual({ kind: 'shell', desktopId, url, transport: 'tor', path: 'tor', reconnecting: false });
    expect(transition(shell, { type: 'path-changed', desktopId, transport: null, path: null }))
      .toEqual({ kind: 'shell', desktopId, url, transport: null, path: null, reconnecting: false });
    expect(transition(shell, { type: 'path-changed', desktopId: otherDesktopId, transport: 'tor', path: 'tor' })).toBe(shell);
    expect(transition(shell, { type: 'path-changed', desktopId, transport: 'direct', path: 'direct' })).toBe(shell);
    const desktops: AppScreen = { kind: 'desktops' };
    expect(transition(desktops, { type: 'path-changed', desktopId, transport: 'tor', path: 'tor' })).toBe(desktops);
  });

  test('a revoked phone ignores late retries and reopenings for that desktop', () => {
    const removed = transition(loading, { type: 'desktop-offline', desktopId, reason: 'removed' });
    expect(transition(removed, { type: 'desktop-offline', desktopId, reason: 'no-path' })).toBe(removed);
    expect(transition(removed, { type: 'desktop-opened', desktopId, url, transport: 'tor', path: 'tor' })).toBe(removed);
    expect(transition(removed, { type: 'desktop-opened', desktopId: otherDesktopId, url, transport: 'tor', path: 'tor' }))
      .toEqual({ kind: 'shell', desktopId: otherDesktopId, url, transport: 'tor', path: 'tor', reconnecting: false });
    expect(transition(removed, { type: 'needs-pairing' })).toEqual({ kind: 'pair' });
  });
});

describe('desktop state in the list', () => {
  const status = (state: TunnelStatus['state'], active: TunnelStatus['active']): TunnelStatus =>
    ({ state, active, tor: { state: 'ready', progress: 100 }, desktops: 2 });
  const none = new Map<string, OfflineReason>();

  test('is idle without activity', () => {
    expect(describeDesktop(desktopId, { tunnelStatus: null, connectingId: null, failures: none }))
      .toEqual({ state: 'idle', transport: null });
  });

  test('shows the attempt in progress', () => {
    expect(describeDesktop(desktopId, { tunnelStatus: null, connectingId: desktopId, failures: none }).state).toBe('connecting');
    expect(describeDesktop(otherDesktopId, { tunnelStatus: null, connectingId: desktopId, failures: none }).state).toBe('idle');
  });

  test('uses the path the core keeps for the desktop', () => {
    const active = { desktopId, transport: 'tor' as const, path: 'tor' as const, since: '2026-09-15T10:00:00Z' };
    expect(describeDesktop(desktopId, { tunnelStatus: status('connected', active), connectingId: null, failures: none }))
      .toEqual({ state: 'connected', transport: 'tor' });
    expect(describeDesktop(desktopId, { tunnelStatus: status('connecting', active), connectingId: null, failures: none }).state)
      .toBe('connecting');
    expect(describeDesktop(otherDesktopId, { tunnelStatus: status('connected', active), connectingId: null, failures: none }).state)
      .toBe('idle');
  });

  test('keeps the last failure until the desktop opens again and revocation wins', () => {
    const active = { desktopId, transport: 'direct' as const, path: 'lan' as const, since: 1 };
    expect(describeDesktop(desktopId, { tunnelStatus: null, connectingId: null, failures: new Map([[desktopId, 'no-path']]) }).state)
      .toBe('offline');
    expect(describeDesktop(desktopId, {
      tunnelStatus: status('connected', active), connectingId: desktopId, failures: new Map([[desktopId, 'removed']])
    })).toEqual({ state: 'removed', transport: null });
  });
});
