import { buildHealthUrl, controlOriginWhitelist, isSameControlOrigin, isSafeExternalUrl, validateControlUrl } from './url';

const NONCE = 'A'.repeat(43);
const PROXY = `http://127.0.0.1:47400/?k=${NONCE}`;

describe('local proxy URL policy', () => {
  test('accepts and normalizes the production proxy URL', () => {
    expect(validateControlUrl(`  ${PROXY}  `, false)).toBe(PROXY);
  });

  test.each([
    'https://studio.example-tailnet.ts.net',
    `http://localhost:47400/?k=${NONCE}`,
    `http://[::1]:47400/?k=${NONCE}`,
    `http://192.168.1.4:47400/?k=${NONCE}`,
    `http://127.0.0.1/?k=${NONCE}`,
    `http://user:pass@127.0.0.1:47400/?k=${NONCE}`,
    `http://127.0.0.1:47400/private?k=${NONCE}`
  ])('rejects an unsafe production address', value => {
    expect(() => validateControlUrl(value, false)).toThrow();
  });

  test('allows a nonce free loopback only for development', () => {
    expect(validateControlUrl('http://127.0.0.1:47400/', true)).toBe('http://127.0.0.1:47400/');
    expect(() => validateControlUrl('http://127.0.0.1:47400/', false)).toThrow();
  });

  test('restricts WebView navigation to the exact proxy origin', () => {
    expect(isSameControlOrigin(PROXY, 'http://127.0.0.1:47400/files')).toBe(true);
    expect(isSameControlOrigin(PROXY, `http://localhost:47400/?k=${NONCE}`)).toBe(false);
    expect(isSameControlOrigin(PROXY, `http://127.0.0.1:47401/?k=${NONCE}`)).toBe(false);
    expect(isSameControlOrigin(PROXY, 'not a url')).toBe(false);
    expect(controlOriginWhitelist(PROXY)).toEqual(['*']);
  });

  test('builds health checks without carrying the nonce', () => {
    expect(buildHealthUrl(PROXY)).toBe('http://127.0.0.1:47400/api/health');
  });

  test('opens only HTTPS external URLs', () => {
    expect(isSafeExternalUrl('https://ordinum.com.br/ajuda')).toBe(true);
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
    expect(isSafeExternalUrl('cialai://settings')).toBe(false);
  });
});
