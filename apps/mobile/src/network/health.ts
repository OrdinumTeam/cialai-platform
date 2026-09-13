import { buildHealthUrl } from '../config/url';

export const HEALTH_TIMEOUT_MS = 5_000;
export const HEALTH_POLL_INTERVAL_MS = 10_000;

export async function checkControlHealth(
  controlUrl: string,
  fetchImplementation: typeof fetch = fetch,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImplementation(buildHealthUrl(controlUrl), {
      method: 'GET',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: unknown; service?: unknown };
    return body.status === 'ok' && body.service === 'cialai';
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
