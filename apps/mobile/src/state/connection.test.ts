import { validateControlUrl } from '../config/url';
import {
  connectionErrorCode,
  openConnection,
  outcomeForCode,
  RESERVE_PREPARING_RETRY_MS,
  retryDelay,
  type ConnectionPorts
} from './connection';

const desktopId = 'd_AAAAAAAAAAAAAAAAAAAAAA';
const token = `cdt1.dev_AAAAAAAAAAAAAAAAAAAAAA.${'s'.repeat(43)}`;
const proxyUrl = `http://127.0.0.1:47400/?k=${'N'.repeat(43)}`;

function ports(overrides: Partial<ConnectionPorts> = {}) {
  const mocks = {
    readToken: jest.fn(async () => token as string | null),
    connect: jest.fn(async () => ({ desktopId, transport: 'tor' as const, path: 'tor' as const, elapsedMs: 4_200 })),
    openDesktop: jest.fn(async () => ({ url: proxyUrl, port: 47400, nonce: 'N'.repeat(43) })),
    validateUrl: jest.fn((url: string) => validateControlUrl(url))
  };
  return { ...mocks, ...overrides } as typeof mocks;
}

// Erro como o Android rejeita: código estável e mensagem em português.
function androidError(code: string) {
  return Object.assign(new Error('Mensagem do núcleo'), { code });
}

// Erro como o Expo repassa o NSError do Go no iOS.
function iosError(code: string) {
  return new Error(`Calling the 'connect' function has failed\n→ Caused by: ${code}: Mensagem do núcleo`);
}

describe('opening a desktop through the path manager', () => {
  test('connects before opening the proxy with the stored token', async () => {
    const native = ports();
    await expect(openConnection(desktopId, native)).resolves.toEqual({
      kind: 'opened', desktopId, url: proxyUrl, transport: 'tor', path: 'tor'
    });
    expect(native.readToken).toHaveBeenCalledWith(desktopId);
    expect(native.connect).toHaveBeenCalledWith(desktopId);
    expect(native.openDesktop).toHaveBeenCalledWith(desktopId, token);
    expect(native.connect.mock.invocationCallOrder[0]).toBeLessThan(native.openDesktop.mock.invocationCallOrder[0]!);
  });

  test('asks for pairing again without calling the core when the token is gone', async () => {
    const native = ports({ readToken: jest.fn(async () => null) });
    await expect(openConnection(desktopId, native)).resolves.toEqual({ kind: 'unpaired', desktopId });
    expect(native.connect).not.toHaveBeenCalled();
  });

  test('treats an unreadable secure store as a local failure', async () => {
    const native = ports({ readToken: jest.fn(async () => { throw new Error('keychain locked'); }) });
    await expect(openConnection(desktopId, native)).resolves.toEqual({ kind: 'offline', desktopId, reason: 'tunnel' });
  });

  test.each([
    ['revoked', { kind: 'revoked', desktopId }],
    ['desktop_unknown', { kind: 'unpaired', desktopId }],
    ['reserve_preparing', { kind: 'offline', desktopId, reason: 'reserve-preparing' }],
    ['reserve_unavailable', { kind: 'offline', desktopId, reason: 'reserve-unavailable' }],
    ['no_path', { kind: 'offline', desktopId, reason: 'no-path' }]
  ])('maps the %s connect error from both native modules', async (code, expected) => {
    for (const error of [androidError(code), iosError(code)]) {
      const native = ports({ connect: jest.fn(async () => { throw error; }) });
      await expect(openConnection(desktopId, native)).resolves.toEqual(expected);
      expect(native.openDesktop).not.toHaveBeenCalled();
    }
  });

  test('maps a revocation found while opening the proxy', async () => {
    const native = ports({ openDesktop: jest.fn(async () => { throw androidError('revoked'); }) });
    await expect(openConnection(desktopId, native)).resolves.toEqual({ kind: 'revoked', desktopId });
  });

  test('refuses a proxy address outside the loopback policy', async () => {
    const native = ports({ openDesktop: jest.fn(async () => ({ url: 'http://192.168.0.2:47400/', port: 47400, nonce: '' })) });
    await expect(openConnection(desktopId, native)).resolves.toEqual({ kind: 'offline', desktopId, reason: 'tunnel' });
  });

  test('keeps unknown errors generic', async () => {
    expect(connectionErrorCode(new Error('proxy_open_failed: porta ocupada'))).toBeNull();
    expect(connectionErrorCode('no_path')).toBeNull();
    expect(outcomeForCode(desktopId, null)).toEqual({ kind: 'offline', desktopId, reason: 'tunnel' });
    expect(outcomeForCode(desktopId, 'reconnect_failed')).toEqual({ kind: 'offline', desktopId, reason: 'tunnel' });
  });
});

describe('offline retries', () => {
  test('back off at 2, 4, 8 and 16 seconds and keep the last interval', () => {
    expect([0, 1, 2, 3, 4, 9].map(attempt => retryDelay('no-path', attempt))).toEqual([2_000, 4_000, 8_000, 16_000, 16_000, 16_000]);
    expect([0, 3].map(attempt => retryDelay('reserve-unavailable', attempt))).toEqual([2_000, 16_000]);
    expect(retryDelay('reconnecting', 0)).toBe(2_000);
  });

  test('retry quickly while the reserve prepares and never after revocation', () => {
    expect(retryDelay('reserve-preparing', 5)).toBe(RESERVE_PREPARING_RETRY_MS);
    expect(retryDelay('removed', 0)).toBeNull();
  });
});
