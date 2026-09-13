const TAILNET_SUFFIX = '.ts.net';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function isTailnetHostname(hostname: string): boolean {
  const labels = hostname.toLowerCase().split('.');
  return labels.length >= 4 && hostname.toLowerCase().endsWith(TAILNET_SUFFIX);
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function validateControlUrl(value: string, allowDevelopmentLoopback: boolean): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Informe um endereço válido do computador.');
  }
  if (url.username || url.password || url.hash) {
    throw new Error('O endereço não pode conter credenciais ou fragmentos.');
  }
  const tailnet = url.protocol === 'https:' && isTailnetHostname(url.hostname);
  const loopback =
    allowDevelopmentLoopback && url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  if (!tailnet && !loopback) throw new Error('Use um endereço seguro do computador.');
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('Informe somente o endereço raiz do computador.');
  }
  url.hash = '';
  return `${url.origin}${url.search}`;
}

export function buildHealthUrl(controlUrl: string): string {
  return new URL('/api/health', new URL(controlUrl).origin).toString();
}

export function isSameControlOrigin(controlUrl: string, candidate: string): boolean {
  try {
    return new URL(candidate).origin === new URL(controlUrl).origin;
  } catch {
    return false;
  }
}

export function controlOriginWhitelist(controlUrl: string): string[] {
  new URL(controlUrl);
  return ['*'];
}

export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function isSafeDownloadUrl(value: string, allowDevelopmentLoopback: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === 'https:') return Boolean(url.hostname);
    return allowDevelopmentLoopback && url.protocol === 'http:' && isLoopbackHostname(url.hostname);
  } catch {
    return false;
  }
}
