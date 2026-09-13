import { checkControlHealth, HEALTH_DETECTION_BUDGET_MS } from './health';

const URL = `http://127.0.0.1:47400/?k=${'A'.repeat(43)}`;

describe('Cialai health check', () => {
  test('accepts only the Cialai health contract', async () => {
    const fetchOk = jest.fn(async () => ({ ok: true, json: async () => ({ status: 'ok', service: 'cialai' }) })) as unknown as typeof fetch;
    await expect(checkControlHealth(URL, fetchOk)).resolves.toBe(true);
    expect(fetchOk).toHaveBeenCalledWith('http://127.0.0.1:47400/api/health',
      expect.objectContaining({ method: 'GET', cache: 'no-store' }));
  });

  test.each([
    { ok: false, body: { status: 'ok', service: 'cialai' } },
    { ok: true, body: { status: 'ok', service: 'other' } },
    { ok: true, body: { status: 'down', service: 'cialai' } }
  ])('rejects an invalid response', async ({ ok, body }) => {
    const fetchInvalid = jest.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch;
    await expect(checkControlHealth(URL, fetchInvalid)).resolves.toBe(false);
  });

  test('treats a network error as offline', async () => {
    const fetchFailed = jest.fn(async () => { throw new Error('network unavailable'); }) as unknown as typeof fetch;
    await expect(checkControlHealth(URL, fetchFailed)).resolves.toBe(false);
  });

  test('budgets loaded WebView loss detection below twenty seconds', () => {
    expect(HEALTH_DETECTION_BUDGET_MS).toBeLessThanOrEqual(20_000);
  });
});
