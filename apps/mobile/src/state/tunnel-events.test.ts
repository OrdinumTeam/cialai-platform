import { interpretTunnelEvent, parseTorProgress, reservePercent } from './tunnel-events';

const desktopId = 'd_AAAAAAAAAAAAAAAAAAAAAA';

describe('native tunnel events', () => {
  test('path events carry the transport for the status dot', () => {
    expect(interpretTunnelEvent({ kind: 'path', payload: { desktopId, transport: 'tor', path: 'tor', reason: 'direct_lost' } }))
      .toEqual([{ type: 'path', desktopId, transport: 'tor', path: 'tor', reason: 'direct_lost' }, { type: 'status-changed' }]);
  });

  test('a path without a valid transport clears the dot instead of guessing', () => {
    expect(interpretTunnelEvent({ kind: 'path', payload: { desktopId, transport: 'relay', path: 'tor' } })[0])
      .toEqual({ type: 'path', desktopId, transport: null, path: null, reason: '' });
    expect(interpretTunnelEvent({ kind: 'path', payload: { transport: 'tor', path: 'tor' } })).toEqual([]);
  });

  test('revocation can arrive as a path reason or a proxy state', () => {
    expect(interpretTunnelEvent({ kind: 'path', payload: { desktopId, transport: '', path: '', reason: 'revoked' } }))
      .toEqual([{ type: 'revoked', desktopId }]);
    expect(interpretTunnelEvent({ kind: 'proxy', payload: { state: 'revoked', desktopId } }))
      .toEqual([{ type: 'revoked', desktopId }]);
  });

  test('token rotation hands the new token to the secure store', () => {
    expect(interpretTunnelEvent({ kind: 'proxy', payload: { state: 'token-rotated', desktopId, deviceToken: 'cdt1.next' } }))
      .toEqual([{ type: 'token-rotated', desktopId, deviceToken: 'cdt1.next' }]);
    expect(interpretTunnelEvent({ kind: 'proxy', payload: { state: 'token-rotated', desktopId } })).toEqual([]);
    expect(interpretTunnelEvent({ kind: 'proxy', payload: { state: 'open', desktopId, port: 47400 } })).toEqual([]);
  });

  test('tor progress is clamped and unknown states are dropped', () => {
    expect(interpretTunnelEvent({ kind: 'tor', payload: { state: 'bootstrapping', progress: 37.4 } }))
      .toEqual([{ type: 'tor', tor: { state: 'bootstrapping', progress: 37 } }]);
    expect(parseTorProgress({ state: 'bootstrapping', progress: 140 })).toEqual({ state: 'bootstrapping', progress: 100 });
    expect(parseTorProgress({ state: 'starting' })).toEqual({ state: 'starting', progress: 0 });
    expect(interpretTunnelEvent({ kind: 'tor', payload: { state: 'weird', progress: 10 } })).toEqual([]);
  });

  test('state events refresh the status and flag the legacy discard once', () => {
    expect(interpretTunnelEvent({ kind: 'state', payload: { legacyDiscarded: true } }))
      .toEqual([{ type: 'legacy-discarded' }, { type: 'status-changed' }]);
    expect(interpretTunnelEvent({ kind: 'state', payload: { state: 'offline', desktops: 1 } }))
      .toEqual([{ type: 'core-offline' }, { type: 'status-changed' }]);
    expect(interpretTunnelEvent({ kind: 'state', payload: null })).toEqual([{ type: 'status-changed' }]);
  });

  test('Android background reopening is followed from start to end', () => {
    expect(interpretTunnelEvent({ kind: 'state', payload: { state: 'reconnecting', desktopId } })[0])
      .toEqual({ type: 'native-reopening', desktopId });
    expect(interpretTunnelEvent({ kind: 'proxy', payload: { state: 'reopened', desktopId, url: 'http://127.0.0.1:1/?k=x' } }))
      .toEqual([{ type: 'native-reopened', desktopId, url: 'http://127.0.0.1:1/?k=x' }]);
    expect(interpretTunnelEvent({ kind: 'state', payload: { state: 'reconnect-failed', code: 'revoked' } })[0])
      .toEqual({ type: 'native-reopen-failed', desktopId: null, code: 'revoked' });
  });

  test('pair events expose the core stage and logs are ignored', () => {
    expect(interpretTunnelEvent({ kind: 'pair', payload: { state: 'tor' } })).toEqual([{ type: 'pair-stage', state: 'tor' }]);
    expect(interpretTunnelEvent({ kind: 'log', payload: { level: 'error', code: 'x' } })).toEqual([]);
  });

  test('reserve percentage is shown only while the reserve prepares', () => {
    expect(reservePercent({ state: 'bootstrapping', progress: 37 })).toBe(37);
    expect(reservePercent({ state: 'starting', progress: 0 })).toBe(0);
    expect(reservePercent({ state: 'ready', progress: 100 })).toBeNull();
    expect(reservePercent({ state: 'failed', progress: 20 })).toBeNull();
    expect(reservePercent(null)).toBeNull();
  });
});
