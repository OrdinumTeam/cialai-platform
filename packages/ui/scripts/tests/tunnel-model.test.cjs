// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/desktop/tunnel-model.js');

test('a configuracao de rede e normalizada sem guardar a chave da API', async () => {
  const { normalizeNetworkConfig, validateControlInput } = await load();
  const normalized = normalizeNetworkConfig({
    controlUrl: '  https://headscale.exemplo.com/  ',
    userId: 42,
    userName: ' alice ',
    desktopName: ' Mac do Estudio ',
    requireApproval: true,
    keepAwakeWhilePaired: true,
    apiKey: 'hskey-api-segredo',
  });

  assert.deepEqual(normalized, {
    controlUrl: 'https://headscale.exemplo.com',
    userId: '42',
    userName: 'alice',
    desktopName: 'Mac do Estudio',
    requireApproval: true,
    keepAwakeWhilePaired: true,
  });
  assert.equal(validateControlInput('https://headscale.exemplo.com', 'hskey-api-segredo'), '');
  assert.match(validateControlInput('http://headscale.exemplo.com', 'hskey-api-segredo'), /HTTPS/);
  assert.equal(validateControlInput('http://127.0.0.1:8080', 'hskey-api-segredo'), '');
  assert.match(validateControlInput('https://headscale.exemplo.com', ''), /chave da API/);
});

test('a identidade do computador tem o formato exigido pelo codec', async () => {
  const { createDesktopId, headscaleHostname } = await load();
  const id = createDesktopId((buffer) => buffer.fill(0xff));

  assert.equal(id, 'd______________________w');
  assert.equal(headscaleHostname('Mac do Estúdio'), 'mac-do-estudio');
  assert.equal(headscaleHostname('  '), 'cialai-desktop');
});

test('o QR gira em noventa segundos e mantem o TTL total visivel', async () => {
  const { pairClock, PAIR_ROTATION_SECONDS, PAIR_TTL_SECONDS } = await load();
  const startedAt = Date.parse('2026-09-12T12:00:00Z');
  const expiresAt = new Date(startedAt + PAIR_TTL_SECONDS * 1000).toISOString();

  assert.equal(PAIR_ROTATION_SECONDS, 90);
  assert.equal(PAIR_TTL_SECONDS, 600);
  assert.deepEqual(pairClock(startedAt, expiresAt, startedAt), { rotationSeconds: 90, expirySeconds: 600 });
  assert.deepEqual(pairClock(startedAt, expiresAt, startedAt + 89_100), { rotationSeconds: 1, expirySeconds: 511 });
  assert.deepEqual(pairClock(startedAt, expiresAt, startedAt + 90_000), { rotationSeconds: 0, expirySeconds: 510 });
});

test('os eventos do supervisor produzem um estado unico para sidebar e toolbar', async () => {
  const { initialTunnelSnapshot, reduceTunnelEvent, tunnelPresentation } = await load();
  let snapshot = initialTunnelSnapshot(true);
  snapshot = reduceTunnelEvent(snapshot, { event: 'node.state', data: { state: 'running', ip4: '100.64.0.8' } });
  assert.deepEqual(tunnelPresentation(snapshot), { tone: 'busy', label: 'Preparando acesso' });

  snapshot = reduceTunnelEvent(snapshot, { event: 'edge.state', data: { state: 'running', port: 4740 } });
  assert.deepEqual(tunnelPresentation(snapshot), { tone: 'ok', label: 'Acessível' });

  snapshot = reduceTunnelEvent(snapshot, { event: 'tunnel.state', data: { state: 'restarting' } });
  assert.deepEqual(tunnelPresentation(snapshot), { tone: 'busy', label: 'Reconectando' });

  snapshot = reduceTunnelEvent(snapshot, { event: 'tunnel.state', data: { state: 'failed' } });
  assert.deepEqual(tunnelPresentation(snapshot), { tone: 'bad', label: 'Indisponível' });
  assert.deepEqual(tunnelPresentation(initialTunnelSnapshot(false)), { tone: 'idle', label: 'Rede não configurada' });
});

test('a lista de dispositivos reage a renomeacao e revogacao', async () => {
  const { updateDevicesFromEvent } = await load();
  const devices = [{ id: 'dev_1', name: 'iPhone', revoked: false }, { id: 'dev_2', name: 'iPad', revoked: false }];
  assert.deepEqual(updateDevicesFromEvent(devices, { deviceId: 'dev_1', name: 'Celular de Ana' })[0].name, 'Celular de Ana');
  assert.deepEqual(updateDevicesFromEvent(devices, { deviceId: 'dev_2', revoked: true }).map((device) => device.id), ['dev_1']);
});
