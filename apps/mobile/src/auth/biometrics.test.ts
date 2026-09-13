import { BiometricSession, SESSION_BACKGROUND_TTL_MS } from './biometrics';

describe('biometric session', () => {
  test('starts locked and caches only a successful session authorization', async () => {
    const authenticate = jest.fn(async () => true);
    const session = new BiometricSession(authenticate);
    expect(session.isUnlocked()).toBe(false);
    await expect(session.authorize('session', 'Abrir terminal')).resolves.toBe(true);
    await expect(session.authorize('session', 'Editar arquivo')).resolves.toBe(true);
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(session.isUnlocked()).toBe(true);
  });

  test('requests authorization for every action', async () => {
    const authenticate = jest.fn(async () => true);
    const session = new BiometricSession(authenticate);
    await session.authorize('action', 'Primeira tecla');
    await session.authorize('action', 'Encerrar terminal');
    expect(authenticate).toHaveBeenCalledTimes(2);
  });

  test('does not unlock after a canceled prompt', async () => {
    const session = new BiometricSession(async () => false);
    await expect(session.authorize('session', 'Abrir terminal')).resolves.toBe(false);
    expect(session.isUnlocked()).toBe(false);
  });

  test('locks after five minutes in the background and signals the transition once', async () => {
    let now = 1_000;
    const session = new BiometricSession(async () => true, () => now);
    await session.authorize('session', 'Abrir terminal');
    expect(session.handleAppState('background')).toBe(false);
    now += SESSION_BACKGROUND_TTL_MS;
    expect(session.handleAppState('active')).toBe(true);
    expect(session.isUnlocked()).toBe(false);
    expect(session.handleAppState('active')).toBe(false);
  });

  test('keeps the session unlocked after a short background interval', async () => {
    let now = 1_000;
    const session = new BiometricSession(async () => true, () => now);
    await session.authorize('session', 'Abrir terminal');
    session.handleAppState('inactive');
    now += SESSION_BACKGROUND_TTL_MS - 1;
    expect(session.handleAppState('active')).toBe(false);
    expect(session.isUnlocked()).toBe(true);
  });

  test('signals expiry even when only an action grant existed in the page', async () => {
    let now = 1_000;
    const session = new BiometricSession(async () => true, () => now);
    await session.authorize('action', 'Primeira tecla');
    session.handleAppState('background');
    now += SESSION_BACKGROUND_TTL_MS;
    expect(session.handleAppState('active')).toBe(true);
  });

  test('ignores a successful prompt completed after the session was invalidated', async () => {
    let finishPrompt: ((value: boolean) => void) | undefined;
    const session = new BiometricSession(() => new Promise(resolve => { finishPrompt = resolve; }));
    const authorization = session.authorize('session', 'Abrir terminal');
    await Promise.resolve();
    session.lock();
    finishPrompt?.(true);
    await expect(authorization).resolves.toBe(false);
    expect(session.isUnlocked()).toBe(false);
  });
});
