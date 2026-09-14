const LOOPBACK_HOST = '127.0.0.1';
const NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function validateControlUrl(value: string, allowDevelopmentWithoutNonce = false): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('control_url_invalid_host');
  }
  if (url.protocol !== 'http:' || url.hostname !== LOOPBACK_HOST || !url.port ||
      url.username || url.password || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('control_url_invalid_origin');
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('control_url_invalid_port');
  }
  const keys = [...url.searchParams.keys()];
  if (allowDevelopmentWithoutNonce && keys.length === 0) return `${url.origin}/`;
  if (keys.length !== 1 || keys[0] !== 'k' || !NONCE_PATTERN.test(url.searchParams.get('k') ?? '')) {
    throw new Error('control_url_invalid_token');
  }
  return `${url.origin}/?k=${url.searchParams.get('k')}`;
}

export function buildHealthUrl(controlUrl: string): string {
  const url = new URL(controlUrl);
  if (url.protocol !== 'http:' || url.hostname !== LOOPBACK_HOST || !url.port) {
    throw new Error('health_url_invalid_origin');
  }
  return new URL('/api/health', url.origin).toString();
}

export function isSameControlOrigin(controlUrl: string, candidate: string): boolean {
  try {
    const expected = new URL(controlUrl);
    const actual = new URL(candidate);
    return expected.protocol === 'http:' && expected.hostname === LOOPBACK_HOST && actual.origin === expected.origin;
  } catch {
    return false;
  }
}

export function controlOriginWhitelist(controlUrl: string): string[] {
  const url = new URL(controlUrl);
  if (url.protocol !== 'http:' || url.hostname !== LOOPBACK_HOST || !url.port) return [];
  return ['*'];
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isSafeDownloadUrl(value: string, allowDevelopmentLoopback: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return Boolean(url.hostname);
    return allowDevelopmentLoopback && url.protocol === 'http:' &&
      (url.hostname === LOOPBACK_HOST || url.hostname === 'localhost' || url.hostname === '[::1]');
  } catch {
    return false;
  }
}
