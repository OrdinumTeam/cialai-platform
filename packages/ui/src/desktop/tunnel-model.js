// SPDX-License-Identifier: Apache-2.0
// Pure state and validation helpers for the desktop tunnel interface.
import { getLocale, translate } from './i18n.js';

export const PAIR_ROTATION_SECONDS = 90;
export const PAIR_TTL_SECONDS = 600;
export const DESKTOP_NAME_MAX = 48;
export const TRANSPORTS = Object.freeze(['direct', 'tor']);

// O sidecar e o supervisor mandam código estável com texto em português. A
// interface mostra o texto do idioma ativo e mantém o original para códigos
// ainda sem tradução.
export const TUNNEL_ERROR_KEYS = Object.freeze({
  args_invalid: 'desktop.tunnel.error.argsInvalid',
  command_sensitive: 'desktop.tunnel.error.commandSensitive',
  command_unknown: 'desktop.tunnel.error.commandUnknown',
  device_invalid: 'desktop.tunnel.error.deviceInvalid',
  device_not_found: 'desktop.tunnel.error.deviceNotFound',
  doctor_invalid: 'desktop.tunnel.error.doctorInvalid',
  doctor_unavailable: 'desktop.tunnel.error.doctorUnavailable',
  edge_stopped: 'desktop.tunnel.error.edgeStopped',
  internal: 'desktop.tunnel.error.internal',
  keyring_unavailable: 'desktop.tunnel.error.keyringUnavailable',
  net_not_ready: 'desktop.tunnel.error.netNotReady',
  pair_consumed: 'desktop.tunnel.error.pairConsumed',
  pair_denied: 'desktop.tunnel.error.pairDenied',
  pair_expired: 'desktop.tunnel.error.pairExpired',
  pair_internal: 'desktop.tunnel.error.pairInternal',
  pair_secret_mismatch: 'desktop.tunnel.error.pairSecretMismatch',
  pair_timeout: 'desktop.tunnel.error.pairTimeout',
  pair_unknown: 'desktop.tunnel.error.pairUnknown',
  payload_invalid: 'desktop.tunnel.error.payloadInvalid',
  rpc_invalid: 'desktop.tunnel.error.rpcInvalid',
  tunnel_disconnected: 'desktop.tunnel.error.tunnelDisconnected',
  tunnel_handshake: 'desktop.tunnel.error.tunnelHandshake',
  tunnel_internal: 'desktop.tunnel.error.tunnelInternal',
  tunnel_start: 'desktop.tunnel.error.tunnelStart',
  tunnel_state: 'desktop.tunnel.error.tunnelState',
  tunnel_stopped: 'desktop.tunnel.error.tunnelStopped',
  tunnel_stopping: 'desktop.tunnel.error.tunnelStopping',
  tunnel_timeout: 'desktop.tunnel.error.tunnelTimeout',
  tunnel_unavailable: 'desktop.tunnel.error.tunnelUnavailable',
});

export function tunnelProblemCode(error) {
  if (error && typeof error === 'object') return error.code || error.error?.code || '';
  return '';
}

export function tunnelErrorMessage(error) {
  const key = TUNNEL_ERROR_KEYS[tunnelProblemCode(error)];
  if (key) return translate(key);
  if (error && typeof error === 'object') return error.message || error.error?.message || String(error);
  return String(error || translate('desktop.tunnel.noResponse'));
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const count = (value) => Math.max(0, Math.floor(Number(value) || 0));

// Nome sem caracteres de controle, sem espaços nas pontas e com no máximo 48
// caracteres, o limite de `net.start`. Vazio vira null.
export function cleanDesktopName(value) {
  const cleaned = [...String(value ?? '').replace(/\p{Cc}/gu, ' ').trim()].slice(0, DESKTOP_NAME_MAX).join('').trimEnd();
  return cleaned || null;
}

// Preferências de rede que sobraram: a conexão sobe sozinha e não tem servidor,
// usuário ou chave. Campos antigos do Headscale são descartados.
export function normalizeNetworkPreferences(value = {}) {
  const config = isObject(value) ? value : {};
  return {
    desktopName: cleanDesktopName(config.desktopName),
    requireApproval: Boolean(config.requireApproval),
    keepAwakeWhilePaired: Boolean(config.keepAwakeWhilePaired),
  };
}

// Argumentos de `net.start` vindos da interface. O Rust injeta `staticDir`,
// `bridgeUrl` e `proxySecret`; STUN e Tor ficam no padrão do sidecar.
export function netStartArgs(preferences, fallbackName = '') {
  const config = normalizeNetworkPreferences(preferences);
  return {
    desktopName: config.desktopName || cleanDesktopName(fallbackName) || 'Cialai',
    requireApproval: config.requireApproval,
  };
}

// `expiresAt` chega em segundos Unix; datas ISO continuam aceitas.
export function expiryMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return expiryMillis(Number(value));
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function pairClock(startedAt, expiresAt, now = Date.now(), rotationSeconds = PAIR_ROTATION_SECONDS) {
  const expiry = expiryMillis(expiresAt);
  return {
    rotationSeconds: Math.max(0, Math.ceil((Number(startedAt) + rotationSeconds * 1000 - Number(now)) / 1000)),
    expirySeconds: Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - Number(now)) / 1000)) : 0,
  };
}

export function normalizeTorStatus(value) {
  const tor = isObject(value) ? value : {};
  return {
    state: ['disabled', 'starting', 'bootstrapping', 'ready', 'failed'].includes(tor.state) ? tor.state : 'starting',
    progress: Math.min(100, count(tor.progress)),
    onion: typeof tor.onion === 'string' ? tor.onion : '',
    published: tor.published === true,
    error: typeof tor.error === 'string' ? tor.error : '',
  };
}

export function normalizeNetStatus(value) {
  const net = isObject(value) ? value : {};
  const direct = isObject(net.direct) ? net.direct : {};
  return {
    state: ['stopped', 'starting', 'ready', 'degraded', 'failed'].includes(net.state) ? net.state : 'starting',
    desktop: isObject(net.desktop) ? net.desktop : null,
    direct: {
      state: direct.state || 'stopped',
      port: count(direct.port) || null,
      candidates: Array.isArray(direct.candidates) ? direct.candidates.filter((candidate) => isObject(candidate) && candidate.addr) : [],
      mapping: isObject(direct.mapping) ? direct.mapping : { protocol: 'none' },
      stun: isObject(direct.stun) ? direct.stun : { state: 'disabled' },
    },
    tor: normalizeTorStatus(net.tor),
    mdns: isObject(net.mdns) ? net.mdns : { state: 'disabled' },
    edge: isObject(net.edge) ? net.edge : { state: 'stopped' },
    sessions: { direct: count(net.sessions?.direct), tor: count(net.sessions?.tor) },
    error: isObject(net.error) ? net.error : null,
  };
}

// `startup` acompanha a chamada `net.start` da interface; `supervisor` vem dos
// eventos `tunnel.state` do Rust; `net` e `tor` vêm do sidecar.
export function initialTunnelSnapshot() {
  return { startup: 'idle', supervisor: 'idle', net: null, tor: null };
}

export function applyNetStatus(snapshot, status) {
  const net = normalizeNetStatus(status);
  const tor = isObject(status?.tor) ? net.tor : snapshot.tor;
  return { ...snapshot, startup: 'started', net: tor ? { ...net, tor } : net, tor };
}

export function reduceTunnelEvent(snapshot, frame = {}) {
  const data = isObject(frame.data) ? frame.data : {};
  if (frame.event === 'net.state') return applyNetStatus(snapshot, data);
  if (frame.event === 'tor.state') {
    const tor = normalizeTorStatus(data);
    return { ...snapshot, tor, net: snapshot.net ? { ...snapshot.net, tor } : snapshot.net };
  }
  if (frame.event === 'tunnel.state') return { ...snapshot, supervisor: data.state || snapshot.supervisor };
  return snapshot;
}

// Estado da conexão de reserva: pronta quando o onion foi publicado.
export function reserveStatus(value) {
  if (!value) return { state: 'preparing', progress: 0 };
  const tor = normalizeTorStatus(value);
  if (tor.published) return { state: 'ready', progress: 100 };
  if (tor.state === 'failed') return { state: 'failed', progress: tor.progress };
  if (tor.state === 'disabled') return { state: 'disabled', progress: 0 };
  return { state: 'preparing', progress: tor.state === 'ready' ? 100 : tor.progress };
}

export function reserveLabel(value) {
  const reserve = reserveStatus(value);
  if (reserve.state === 'ready') return translate('desktop.access.reserveReady');
  if (reserve.state === 'failed') return translate('desktop.access.reserveFailed');
  if (reserve.state === 'disabled') return translate('desktop.access.reserveDisabled');
  return translate('desktop.access.reservePreparing', { progress: reserve.progress });
}

// Ponto de estado único para barra lateral, toolbar, painel e diálogo.
export function tunnelState(snapshot = initialTunnelSnapshot()) {
  const net = snapshot.net;
  const tor = snapshot.tor || net?.tor || null;
  if (snapshot.supervisor === 'restarting') return 'reconnecting';
  if (snapshot.supervisor === 'failed' || snapshot.startup === 'failed') return 'problem';
  if (net?.state === 'failed' || net?.state === 'degraded') return 'problem';
  if (net?.state === 'ready') {
    if (tor?.published) return 'accessible';
    if (tor?.state === 'bootstrapping') return 'reserve';
    return 'pairable';
  }
  if (snapshot.supervisor === 'stopped' || net?.state === 'stopped' || snapshot.startup === 'idle') return 'off';
  return 'starting';
}

const PRESENTATION = Object.freeze({
  accessible: { tone: 'ok', key: 'desktop.tunnel.accessible' },
  pairable: { tone: 'ok', key: 'desktop.tunnel.pairable' },
  reserve: { tone: 'busy', key: 'desktop.tunnel.reservePreparing' },
  problem: { tone: 'bad', key: 'desktop.tunnel.problem' },
  reconnecting: { tone: 'busy', key: 'desktop.tunnel.reconnecting' },
  starting: { tone: 'busy', key: 'desktop.tunnel.starting' },
  off: { tone: 'idle', key: 'desktop.tunnel.off' },
});

export function tunnelPresentation(snapshot = initialTunnelSnapshot()) {
  const state = tunnelState(snapshot);
  const { tone, key } = PRESENTATION[state];
  const progress = reserveStatus(snapshot.tor || snapshot.net?.tor).progress;
  return { state, tone, label: translate(key, { progress }) };
}

export function directReady(snapshot = initialTunnelSnapshot()) {
  return ['ready', 'degraded'].includes(snapshot.net?.state) && snapshot.net?.direct?.state === 'listening';
}

// Sessões por transporte. `devices.list` informa `transports`; os eventos
// `session.opened` e `session.closed` somam e subtraem daí em diante.
export function normalizeDevice(device = {}) {
  const listed = Array.isArray(device.transports) ? device.transports.filter((transport) => TRANSPORTS.includes(transport)) : [];
  let sessions;
  if (isObject(device.sessions)) sessions = { direct: count(device.sessions.direct), tor: count(device.sessions.tor) };
  else {
    sessions = { direct: listed.includes('direct') ? 1 : 0, tor: listed.includes('tor') ? 1 : 0 };
    if (device.connected === true && !listed.length && TRANSPORTS.includes(device.lastTransport)) sessions[device.lastTransport] = 1;
  }
  return {
    ...device,
    sessions,
    connected: sessions.direct + sessions.tor > 0,
    transports: TRANSPORTS.filter((transport) => sessions[transport] > 0),
  };
}

export function normalizeDevices(devices = []) {
  return (Array.isArray(devices) ? devices : []).filter((device) => isObject(device) && device.id && !device.revoked).map(normalizeDevice);
}

export function applySessionEvent(devices = [], frame = {}, now = Date.now()) {
  const data = isObject(frame.data) ? frame.data : {};
  const opened = frame.event === 'session.opened';
  if (!data.deviceId || !TRANSPORTS.includes(data.transport) || (!opened && frame.event !== 'session.closed')) return devices;
  return devices.map((device) => {
    if (device.id !== data.deviceId) return device;
    const current = normalizeDevice(device).sessions;
    const sessions = { ...current, [data.transport]: Math.max(0, current[data.transport] + (opened ? 1 : -1)) };
    return normalizeDevice({
      ...device,
      sessions,
      lastSeenAt: new Date(now).toISOString(),
      lastTransport: opened ? data.transport : device.lastTransport,
      lastRemoteAddr: opened && data.remoteAddr ? data.remoteAddr : device.lastRemoteAddr,
    });
  });
}

// Badge do celular conectado: direta tem prioridade quando há os dois.
export function deviceTransport(device = {}) {
  const { sessions } = normalizeDevice(device);
  if (sessions.direct > 0) return 'direct';
  if (sessions.tor > 0) return 'tor';
  return null;
}

export function connectedCount(devices = []) {
  return devices.filter((device) => normalizeDevice(device).connected).length;
}

export function updateDevicesFromEvent(devices = [], data = {}) {
  if (!data.deviceId) return devices;
  if (data.revoked) return devices.filter((device) => device.id !== data.deviceId);
  if (!data.name) return devices;
  return devices.map((device) => device.id === data.deviceId ? { ...device, name: data.name } : device);
}

export const DIAGNOSTIC_CHECK_KEYS = Object.freeze({
  identity: 'desktop.access.check.identity',
  direct_listener: 'desktop.access.check.directListener',
  lan_candidates: 'desktop.access.check.lanCandidates',
  ipv6: 'desktop.access.check.ipv6',
  port_mapping: 'desktop.access.check.portMapping',
  stun: 'desktop.access.check.stun',
  tor_process: 'desktop.access.check.torProcess',
  tor_bootstrap: 'desktop.access.check.torBootstrap',
  onion_published: 'desktop.access.check.onionPublished',
  mdns: 'desktop.access.check.mdns',
  edge: 'desktop.access.check.edge',
});

export function normalizeDiagnostics(result) {
  const value = isObject(result) ? result : {};
  const checks = (Array.isArray(value.checks) ? value.checks : [])
    .filter((check) => isObject(check) && check.id)
    .map((check) => ({
      id: String(check.id),
      ok: check.ok === true,
      detail: typeof check.detail === 'string' ? check.detail : '',
      label: DIAGNOSTIC_CHECK_KEYS[check.id] ? translate(DIAGNOSTIC_CHECK_KEYS[check.id]) : String(check.id),
    }));
  return { ok: value.ok === true && checks.every((check) => check.ok), checks };
}

export const CANDIDATE_KIND_KEYS = Object.freeze({
  lan: 'desktop.access.candidate.lan',
  ipv6: 'desktop.access.candidate.ipv6',
  mapped: 'desktop.access.candidate.mapped',
  reflexive: 'desktop.access.candidate.reflexive',
});

export function candidateKindLabel(kind) {
  return CANDIDATE_KIND_KEYS[kind] ? translate(CANDIDATE_KIND_KEYS[kind]) : String(kind || '');
}

const MAPPING_NAMES = Object.freeze({ pcp: 'PCP', natpmp: 'NAT-PMP', upnp: 'UPnP' });

export function mappingLabel(mapping) {
  return MAPPING_NAMES[mapping?.protocol] || translate('desktop.access.mappingNone');
}

// Redes públicas das quais o computador depende, exibidas no diagnóstico
// avançado: rede Tor para a reserva, STUN opcional e DNS-SD só na rede local.
export function publicNetworks(net, torValue) {
  const tor = normalizeTorStatus(torValue || net?.tor);
  const torState = tor.state === 'disabled' ? 'off' : tor.state === 'failed' ? 'failed' : tor.published ? 'active' : 'preparing';
  const stun = net?.direct?.stun?.state;
  const mdns = net?.mdns?.state;
  return [
    { id: 'tor', state: torState },
    { id: 'stun', state: stun === 'ok' ? 'active' : stun === 'failed' ? 'failed' : 'off' },
    { id: 'mdns', state: mdns === 'announcing' ? 'active' : mdns === 'failed' ? 'failed' : 'off' },
  ];
}

export function formatPairTime(seconds) {
  const safe = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(safe / 60);
  const remainder = String(safe % 60).padStart(2, '0');
  return `${minutes}:${remainder}`;
}

export function formatLastSeen(value, now = Date.now()) {
  const when = Date.parse(value);
  if (!Number.isFinite(when)) return translate('desktop.time.noRecord');
  const elapsed = Math.max(0, Number(now) - when);
  if (elapsed < 60_000) return translate('desktop.time.now');
  if (elapsed < 3_600_000) return translate('desktop.time.minutesAgo', { count: Math.floor(elapsed / 60_000) });
  if (elapsed < 86_400_000) return translate('desktop.time.hoursAgo', { count: Math.floor(elapsed / 3_600_000) });
  return new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(new Date(when));
}
