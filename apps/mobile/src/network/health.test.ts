import { createServer, type IncomingMessage, type Server } from 'node:http';
import vm from 'node:vm';

import { clearDiagnostics, recentDiagnostics } from '../state/diagnostics';
import { checkControlHealth, HEALTH_DETECTION_BUDGET_MS, HEALTH_FAILURE_STRIKES, HEALTH_RECHECK_TIMEOUT_MS, HEALTH_TIMEOUT_MS } from './health';

const URL = `http://127.0.0.1:47400/?k=${'A'.repeat(43)}`;

// O jest-expo instala o fetch do Expo, que no Jest não fala HTTP. O fetch do
// próprio Node continua no contexto externo do Jest e é o usado contra o proxy
// de teste, para a sondagem sair como requisição HTTP real, sem cookie.
const nodeFetch = vm.runInThisContext('globalThis.fetch') as typeof fetch;

type ProxyMode = 'direct' | 'reserve' | 'offline' | 'silent';

// Proxy de loopback de teste com o contrato de CONN-02: a rota local de saúde
// responde antes do portão; qualquer outra rota sem o cookie e sem o nonce recebe 403.
class TestProxy {
  readonly requests: IncomingMessage[] = [];
  mode: ProxyMode = 'direct';
  private server: Server;
  private port = 0;

  constructor() {
    this.server = createServer((request, response) => {
      this.requests.push(request);
      if (this.mode === 'silent') return;
      response.setHeader('Connection', 'close');
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'GET' && request.url === '/_cialai/health') {
        if (this.mode === 'offline') {
          response.writeHead(503);
          response.end(JSON.stringify({ status: 'offline', service: 'cialai', reason: 'no_path' }));
          return;
        }
        response.writeHead(200);
        response.end(JSON.stringify({ status: 'ok', service: 'cialai', transport: this.mode }));
        return;
      }
      response.writeHead(403);
      response.end(JSON.stringify({ error: 'forbidden' }));
    });
  }

  async start(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as { port: number }).port;
  }

  controlUrl(): string {
    return `http://127.0.0.1:${this.port}/?k=${'N'.repeat(43)}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}

describe('Cialai health check against a local proxy', () => {
  const proxy = new TestProxy();

  beforeAll(() => proxy.start());
  afterAll(() => proxy.stop());
  beforeEach(() => {
    proxy.requests.length = 0;
    proxy.mode = 'direct';
    clearDiagnostics();
  });

  test.each<ProxyMode>(['direct', 'reserve'])('returns true on 200 over the %s path with a real GET, no cookie and no nonce', async mode => {
    proxy.mode = mode;
    await expect(checkControlHealth(proxy.controlUrl(), nodeFetch)).resolves.toBe(true);
    expect(proxy.requests).toHaveLength(1);
    const request = proxy.requests[0]!;
    expect(request.method).toBe('GET');
    expect(request.url).toBe('/_cialai/health');
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.accept).toBe('application/json');
    expect(recentDiagnostics()).toEqual([]);
  });

  test('returns false on 503 and records the HTTP code and the reason', async () => {
    proxy.mode = 'offline';
    await expect(checkControlHealth(proxy.controlUrl(), nodeFetch)).resolves.toBe(false);
    expect(proxy.requests[0]?.url).toBe('/_cialai/health');
    expect(recentDiagnostics().map(line => line.message)).toEqual(['app: health probe: HTTP 503 no_path']);
  });

  test('the gated page route would refuse the same probe, which is why the health route is local', async () => {
    const response = await nodeFetch(`${new globalThis.URL(proxy.controlUrl()).origin}/api/health`, { headers: { Accept: 'application/json' } });
    expect(response.status).toBe(403);
  });

  test('gives up after the timeout and records it', async () => {
    proxy.mode = 'silent';
    await expect(checkControlHealth(proxy.controlUrl(), nodeFetch, 200)).resolves.toBe(false);
    expect(recentDiagnostics().map(line => line.message)).toEqual(['app: health probe failed: no answer in 200 ms']);
  });
});

describe('Cialai health check contract', () => {
  beforeEach(() => clearDiagnostics());

  test('accepts only the Cialai health contract', async () => {
    const fetchOk = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', service: 'cialai', transport: 'direct' }) })) as unknown as typeof fetch;
    await expect(checkControlHealth(URL, fetchOk)).resolves.toBe(true);
    expect(fetchOk).toHaveBeenCalledWith('http://127.0.0.1:47400/_cialai/health',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }));
  });

  test.each([
    { ok: false, status: 403, body: { status: 'ok', service: 'cialai' }, line: 'app: health probe: HTTP 403 ok' },
    { ok: true, status: 200, body: { status: 'ok', service: 'other' }, line: 'app: health probe: HTTP 200 ok' },
    { ok: true, status: 200, body: { status: 'down', service: 'cialai' }, line: 'app: health probe: HTTP 200 down' },
    { ok: true, status: 200, body: 'not json', line: 'app: health probe: HTTP 200 unexpected body' }
  ])('rejects an invalid response and logs the code', async ({ ok, status, body, line }) => {
    const fetchInvalid = jest.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
    await expect(checkControlHealth(URL, fetchInvalid)).resolves.toBe(false);
    expect(recentDiagnostics().map(entry => entry.message)).toEqual([line]);
  });

  test('treats a network error as offline and logs the failure', async () => {
    const fetchFailed = jest.fn(async () => { throw new TypeError('Network request failed'); }) as unknown as typeof fetch;
    await expect(checkControlHealth(URL, fetchFailed)).resolves.toBe(false);
    expect(recentDiagnostics().map(entry => entry.message)).toEqual(['app: health probe failed: TypeError: Network request failed']);
  });

  test('tolerates the backup latency before declaring the WebView lost', () => {
    // Pela reserva uma resposta demora; a perda só vale com duas falhas seguidas,
    // e a confirmação antes de reconectar espera ainda mais.
    expect(HEALTH_TIMEOUT_MS).toBeGreaterThanOrEqual(8_000);
    expect(HEALTH_FAILURE_STRIKES).toBe(2);
    expect(HEALTH_RECHECK_TIMEOUT_MS).toBeGreaterThan(HEALTH_TIMEOUT_MS);
    expect(HEALTH_DETECTION_BUDGET_MS).toBeLessThanOrEqual(40_000);
  });
});
