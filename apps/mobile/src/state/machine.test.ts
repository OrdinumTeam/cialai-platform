import { transition, type AppScreen } from './machine';

describe('mobile state transitions', () => {
  const loading: AppScreen = { kind: 'loading' };
  test('opens pairing when no profile exists', () => {
    expect(transition(loading, { type: 'needs-pairing' })).toEqual({ kind: 'pair' });
  });
  test('preserves a pairing error', () => {
    expect(transition(loading, { type: 'needs-pairing', error: 'Código inválido' }))
      .toEqual({ kind: 'pair', error: 'Código inválido' });
  });
  test('opens the desktop list and settings', () => {
    expect(transition(loading, { type: 'show-desktops' })).toEqual({ kind: 'desktops' });
    expect(transition(loading, { type: 'show-settings' })).toEqual({ kind: 'settings' });
  });
  test('opens a validated local shell', () => {
    expect(transition(loading, { type: 'desktop-opened', desktopId, url: 'http://127.0.0.1:47400/' }))
      .toEqual({ kind: 'shell', desktopId, url: 'http://127.0.0.1:47400/' });
  });
  test('distinguishes reconnecting and removed states', () => {
    expect(transition(loading, { type: 'desktop-offline', desktopId, reason: 'reconnecting' }))
      .toEqual({ kind: 'offline', desktopId, reason: 'reconnecting' });
    expect(transition(loading, { type: 'desktop-offline', desktopId, reason: 'removed' }))
      .toEqual({ kind: 'offline', desktopId, reason: 'removed' });
  });
});

const desktopId = 'd_AAAAAAAAAAAAAAAAAAAAAA';
