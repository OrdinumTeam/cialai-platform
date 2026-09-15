// SPDX-License-Identifier: Apache-2.0
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/desktop/tunnel-model.js');

const readyNet = (tor = {}) => ({
  state: 'ready',
  desktop: { id: 'd_AAAAAAAAAAAAAAAAAAAAAA', name: 'Mac do Estúdio', publicKey: 'chave', fingerprint: 'F1A2 B3C4' },
  direct: { state: 'listening', port: 4740, candidates: [{ kind: 'lan', addr: '192.168.0.10:4740' }], mapping: { protocol: 'natpmp', external: '203.0.113.7:4740' }, stun: { state: 'ok', addr: '203.0.113.7:4740' } },
  tor: { state: 'bootstrapping', progress: 37, onion: 'abc.onion', published: false, ...tor },
  mdns: { state: 'announcing' },
  edge: { state: 'running' },
  sessions: { direct: 0, tor: 0 },
});

test('as preferencias de rede ficam sem servidor, usuario ou chave', async () => {
  const { cleanDesktopName, netStartArgs, normalizeNetworkPreferences } = await load();
  const normalized = normalizeNetworkPreferences({
    controlUrl: 'https://headscale.exemplo.com',
    userId: 42,
    userName: 'alice',
    apiKey: 'hskey-api-segredo',
    desktopName: ' Mac do Estúdio ',
    requireApproval: true,
    keepAwakeWhilePaired: true,
  });

  assert.deepEqual(normalized, { desktopName: 'Mac do Estúdio', requireApproval: true, keepAwakeWhilePaired: true });
  assert.deepEqual(normalizeNetworkPreferences(null), { desktopName: null, requireApproval: false, keepAwakeWhilePaired: false });
  assert.deepEqual(netStartArgs(normalized), { desktopName: 'Mac do Estúdio', requireApproval: true });
  assert.deepEqual(netStartArgs({}, 'MacBook de Ana'), { desktopName: 'MacBook de Ana', requireApproval: false });
  assert.deepEqual(Object.keys(netStartArgs({})), ['desktopName', 'requireApproval'], 'net.start nao leva parametros de rede da interface');
  assert.equal(cleanDesktopName('Estúdio '.repeat(10)).length, 47);
  assert.equal(cleanDesktopName('Mac\tdo\nEstúdio'), 'Mac do Estúdio');
  assert.equal(cleanDesktopName('   '), null);
});

test('o QR gira em noventa segundos e le a validade em segundos Unix', async () => {
  const { expiryMillis, pairClock, PAIR_ROTATION_SECONDS, PAIR_TTL_SECONDS } = await load();
  const startedAt = Date.parse('2026-09-12T12:00:00Z');
  const expiresAt = Math.floor(startedAt / 1000) + PAIR_TTL_SECONDS;

  assert.equal(PAIR_ROTATION_SECONDS, 90);
  assert.equal(PAIR_TTL_SECONDS, 600);
  assert.equal(expiryMillis(expiresAt), startedAt + 600_000);
  assert.equal(expiryMillis(new Date(startedAt).toISOString()), startedAt);
  assert.ok(Number.isNaN(expiryMillis('amanha')));
  assert.deepEqual(pairClock(startedAt, expiresAt, startedAt), { rotationSeconds: 90, expirySeconds: 600 });
  assert.deepEqual(pairClock(startedAt, expiresAt, startedAt + 89_100), { rotationSeconds: 1, expirySeconds: 511 });
  assert.deepEqual(pairClock(startedAt, expiresAt, startedAt + 90_000), { rotationSeconds: 0, expirySeconds: 510 });
  assert.deepEqual(pairClock(startedAt, expiresAt, startedAt, 30), { rotationSeconds: 30, expirySeconds: 600 });
});

test('o ponto de estado segue o contrato v2', async () => {
  const { applyNetStatus, initialTunnelSnapshot, reduceTunnelEvent, tunnelPresentation, tunnelState } = await load();
  let snapshot = initialTunnelSnapshot();
  assert.equal(tunnelState(snapshot), 'off');
  snapshot = { ...snapshot, startup: 'starting' };
  assert.deepEqual(tunnelPresentation(snapshot), { state: 'starting', tone: 'busy', label: 'Preparando acesso' });

  snapshot = applyNetStatus(snapshot, { ...readyNet({ state: 'starting', progress: 0 }) });
  assert.equal(snapshot.startup, 'started');
  assert.equal(snapshot.net.desktop.name, 'Mac do Estúdio', 'a identidade vem de NetStatus.desktop');
  assert.deepEqual(tunnelPresentation(snapshot), { state: 'pairable', tone: 'ok', label: 'Pronto para parear' });

  snapshot = reduceTunnelEvent(snapshot, { event: 'tor.state', data: { state: 'bootstrapping', progress: 37, onion: 'abc.onion', published: false } });
  assert.deepEqual(tunnelPresentation(snapshot), { state: 'reserve', tone: 'busy', label: 'Conexão de reserva preparando 37%' });
  assert.equal(snapshot.net.tor.progress, 37, 'tor.state atualiza o NetStatus guardado');

  snapshot = reduceTunnelEvent(snapshot, { event: 'tor.state', data: { state: 'ready', progress: 100, onion: 'abc.onion', published: false } });
  assert.equal(tunnelState(snapshot), 'pairable');

  snapshot = reduceTunnelEvent(snapshot, { event: 'net.state', data: readyNet({ state: 'ready', progress: 100, published: true }) });
  assert.deepEqual(tunnelPresentation(snapshot), { state: 'accessible', tone: 'ok', label: 'Acessível' });

  const degraded = reduceTunnelEvent(snapshot, { event: 'net.state', data: { ...readyNet({ state: 'failed', error: 'tor_exited' }), state: 'degraded' } });
  assert.deepEqual(tunnelPresentation(degraded), { state: 'problem', tone: 'bad', label: 'Rede com problema' });
  assert.equal(tunnelState(reduceTunnelEvent(snapshot, { event: 'net.state', data: { state: 'failed' } })), 'problem');
  assert.equal(tunnelState({ ...snapshot, startup: 'failed', net: null }), 'problem');

  snapshot = reduceTunnelEvent(snapshot, { event: 'tunnel.state', data: { state: 'restarting' } });
  assert.deepEqual(tunnelPresentation(snapshot), { state: 'reconnecting', tone: 'busy', label: 'Reconectando' });
  snapshot = reduceTunnelEvent(snapshot, { event: 'tunnel.state', data: { state: 'failed' } });
  assert.equal(tunnelState(snapshot), 'problem');
});

test('a reserva e as redes publicas saem do NetStatus', async () => {
  const { publicNetworks, reserveLabel, reserveStatus, mappingLabel, candidateKindLabel, normalizeNetStatus } = await load();
  assert.deepEqual(reserveStatus({ state: 'bootstrapping', progress: 37.8 }), { state: 'preparing', progress: 37 });
  assert.deepEqual(reserveStatus({ state: 'ready', progress: 100, published: true }), { state: 'ready', progress: 100 });
  assert.deepEqual(reserveStatus({ state: 'failed', progress: 12 }), { state: 'failed', progress: 12 });
  assert.deepEqual(reserveStatus(null), { state: 'preparing', progress: 0 });
  assert.equal(reserveLabel({ state: 'bootstrapping', progress: 37 }), 'preparando 37%');
  assert.equal(reserveLabel({ state: 'ready', published: true }), 'pronta');

  const net = normalizeNetStatus(readyNet());
  assert.deepEqual(publicNetworks(net), [
    { id: 'tor', state: 'preparing' },
    { id: 'stun', state: 'active' },
    { id: 'mdns', state: 'active' },
  ]);
  assert.deepEqual(publicNetworks(normalizeNetStatus({ direct: { stun: { state: 'disabled' } }, mdns: { state: 'failed' }, tor: { state: 'disabled' } })).map((item) => item.state), ['off', 'off', 'failed']);
  assert.equal(mappingLabel(net.direct.mapping), 'NAT-PMP');
  assert.equal(mappingLabel({ protocol: 'none' }), 'Nenhum');
  assert.equal(candidateKindLabel('lan'), 'Rede local');
  assert.equal(candidateKindLabel('reflexive'), 'Endereço público');
});

test('celulares conectados ganham badge de transporte pelos eventos de sessao', async () => {
  const { applySessionEvent, connectedCount, deviceTransport, normalizeDevices, updateDevicesFromEvent } = await load();
  let devices = normalizeDevices([
    { id: 'dev_1', name: 'iPhone', connected: true, transports: ['tor'], lastTransport: 'tor' },
    { id: 'dev_2', name: 'iPad', connected: false, transports: [] },
    { id: 'dev_3', name: 'Antigo', revoked: true },
  ]);
  assert.deepEqual(devices.map((device) => device.id), ['dev_1', 'dev_2']);
  assert.equal(deviceTransport(devices[0]), 'tor');
  assert.equal(deviceTransport(devices[1]), null);
  assert.equal(connectedCount(devices), 1);

  const now = Date.parse('2026-09-14T12:00:00Z');
  devices = applySessionEvent(devices, { event: 'session.opened', data: { deviceId: 'dev_1', transport: 'direct', remoteAddr: '192.168.0.20:51000' } }, now);
  assert.equal(deviceTransport(devices[0]), 'direct', 'direta tem prioridade');
  assert.deepEqual(devices[0].transports, ['direct', 'tor']);
  assert.equal(devices[0].lastRemoteAddr, '192.168.0.20:51000');
  assert.equal(devices[0].lastSeenAt, '2026-09-14T12:00:00.000Z');

  devices = applySessionEvent(devices, { event: 'session.opened', data: { deviceId: 'dev_2', transport: 'direct' } }, now);
  devices = applySessionEvent(devices, { event: 'session.opened', data: { deviceId: 'dev_2', transport: 'direct' } }, now);
  devices = applySessionEvent(devices, { event: 'session.closed', data: { deviceId: 'dev_2', transport: 'direct' } }, now);
  assert.equal(deviceTransport(devices[1]), 'direct', 'a segunda sessao direta continua aberta');
  devices = applySessionEvent(devices, { event: 'session.closed', data: { deviceId: 'dev_2', transport: 'direct' } }, now);
  devices = applySessionEvent(devices, { event: 'session.closed', data: { deviceId: 'dev_2', transport: 'direct' } }, now);
  assert.equal(devices[1].connected, false);
  assert.equal(devices[1].sessions.direct, 0);
  assert.equal(applySessionEvent(devices, { event: 'session.opened', data: { deviceId: 'dev_1', transport: 'relay' } }), devices);

  devices = applySessionEvent(devices, { event: 'session.closed', data: { deviceId: 'dev_1', transport: 'tor' } }, now);
  assert.equal(deviceTransport(devices[0]), 'direct');
  assert.equal(connectedCount(devices), 1);
  assert.equal(updateDevicesFromEvent(devices, { deviceId: 'dev_1', name: 'Celular de Ana' })[0].name, 'Celular de Ana');
  assert.deepEqual(updateDevicesFromEvent(devices, { deviceId: 'dev_2', revoked: true }).map((device) => device.id), ['dev_1']);
  assert.equal(updateDevicesFromEvent(devices, { deviceId: 'dev_2' }), devices);
});

test('o diagnostico traduz as verificacoes conhecidas e mantem as novas', async () => {
  const { DIAGNOSTIC_CHECK_KEYS, normalizeDiagnostics } = await load();
  const { setLocale, translate } = await import('../../src/shared/i18n.js');
  const result = normalizeDiagnostics({ ok: true, checks: [{ id: 'direct_listener', ok: true, detail: 'UDP 4740' }, { id: 'tor_bootstrap', ok: false, detail: '37%' }, { id: 'novo', ok: true }] });
  assert.equal(result.ok, false);
  assert.deepEqual(result.checks.map((check) => check.label), ['Ouvinte direto', 'Inicialização do Tor', 'novo']);
  assert.deepEqual(Object.keys(DIAGNOSTIC_CHECK_KEYS), ['identity', 'direct_listener', 'lan_candidates', 'ipv6', 'port_mapping', 'stun', 'tor_process', 'tor_bootstrap', 'onion_published', 'mdns', 'edge']);
  for (const locale of ['pt-BR', 'en', 'es']) {
    setLocale(locale);
    for (const key of Object.values(DIAGNOSTIC_CHECK_KEYS)) assert.ok(translate(key).length > 0, `${locale} ${key}`);
  }
  setLocale('pt-BR');
});

test('erros do tunel com codigo conhecido seguem o idioma ativo', async () => {
  const { TUNNEL_ERROR_KEYS, tunnelErrorMessage } = await load();
  const { setLocale, translate } = await import('../../src/shared/i18n.js');
  setLocale('es');
  assert.equal(tunnelErrorMessage({ code: 'net_not_ready', message: 'O ouvinte direto ainda não existe.' }), 'La conexión todavía se está preparando. Inténtalo de nuevo en unos segundos.');
  assert.equal(tunnelErrorMessage({ error: { code: 'pair_expired', message: 'Expirou.' } }), 'Este código de vinculación venció.');
  assert.equal(tunnelErrorMessage({ code: 'codigo_novo', message: 'Texto do sidecar' }), 'Texto do sidecar');
  assert.equal(tunnelErrorMessage(null), 'El túnel no respondió.');
  setLocale('en');
  assert.equal(tunnelErrorMessage({ code: 'tunnel_start', message: 'Não foi possível iniciar o núcleo do túnel: ENOENT' }), 'Could not start the tunnel core.');
  for (const locale of ['pt-BR', 'en', 'es']) {
    setLocale(locale);
    for (const key of Object.values(TUNNEL_ERROR_KEYS)) assert.ok(translate(key).length > 0, `${locale} ${key}`);
  }
  assert.equal(Object.keys(TUNNEL_ERROR_KEYS).some((code) => /^(control|node)_/.test(code)), false, 'codigos do Headscale saem da interface');
  assert.ok(TUNNEL_ERROR_KEYS.net_not_ready);
  setLocale('pt-BR');
});
