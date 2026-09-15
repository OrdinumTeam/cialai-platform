import { buildHealthUrl } from '../config/url';

// A sondagem passa pelo proxy local e, pela reserva, por um circuito do Tor:
// uma resposta pode levar vários segundos. O prazo folgado e duas falhas
// seguidas evitam derrubar uma conexão que só estava lenta.
export const HEALTH_TIMEOUT_MS = 8_000;
export const HEALTH_POLL_INTERVAL_MS = 10_000;
export const HEALTH_FAILURE_STRIKES = 2;
// Confirmação antes de reconectar do zero, quando o núcleo diz que o caminho
// continua ativo.
export const HEALTH_RECHECK_TIMEOUT_MS = 20_000;
export const HEALTH_DETECTION_BUDGET_MS = (HEALTH_TIMEOUT_MS + HEALTH_POLL_INTERVAL_MS) * HEALTH_FAILURE_STRIKES;

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
