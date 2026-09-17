import { buildHealthUrl } from '../config/url';
import { logApp } from '../state/diagnostics';

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

type HealthBody = { status?: unknown; service?: unknown; reason?: unknown };

async function readBody(response: Response): Promise<HealthBody> {
  try {
    const body: unknown = await response.json();
    return typeof body === 'object' && body !== null ? body as HealthBody : {};
  } catch {
    return {};
  }
}

function describeFailure(caught: unknown, aborted: boolean, timeoutMs: number): string {
  if (aborted) return `no answer in ${timeoutMs} ms`;
  if (caught instanceof Error) return `${caught.name}: ${caught.message}`.slice(0, 120);
  return 'unknown error';
}

// Cada falha fica registrada no anel de diagnóstico com o código HTTP ou o
// motivo, para a causa de uma queda ser lida no próprio aparelho.
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
    const body = await readBody(response);
    if (response.ok && body.status === 'ok' && body.service === 'cialai') return true;
    const reason = typeof body.reason === 'string' ? body.reason : typeof body.status === 'string' ? body.status : 'unexpected body';
    logApp('info', `health probe: HTTP ${response.status} ${reason}`);
    return false;
  } catch (caught) {
    logApp('info', `health probe failed: ${describeFailure(caught, controller.signal.aborted, timeoutMs)}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
