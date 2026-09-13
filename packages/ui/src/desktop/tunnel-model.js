// SPDX-License-Identifier: Apache-2.0
// Pure state and validation helpers for the desktop tunnel interface.
import { getLocale, translate } from './i18n.js';

export const PAIR_ROTATION_SECONDS = 90;
export const PAIR_TTL_SECONDS = 600;
export const EDGE_PORT = 4740;

const text = (value) => String(value ?? '').trim();

export function normalizeNetworkConfig(value = {}) {
  const config = value && typeof value === 'object' ? value : {};
  return {
    controlUrl: text(config.controlUrl).replace(/\/+$/, '') || null,
    userId: text(config.userId) || null,
    userName: text(config.userName) || null,
    desktopName: text(config.desktopName) || null,
    requireApproval: Boolean(config.requireApproval),
    keepAwakeWhilePaired: Boolean(config.keepAwakeWhilePaired),
  };
}

export function networkIsConfigured(value = {}) {
  const config = normalizeNetworkConfig(value);
  return Boolean(config.controlUrl && config.userId && config.userName && config.desktopName);
}

export function validateControlInput(rawUrl, rawApiKey) {
  if (!text(rawApiKey)) return translate('desktop.network.error.apiKey');
  let parsed;
  try { parsed = new URL(text(rawUrl)); } catch (_error) { return translate('desktop.network.error.url'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return translate('desktop.network.error.baseUrl');
  if (parsed.protocol === 'https:') return '';
  const loopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol === 'http:' && loopback) return '';
  return translate('desktop.network.error.https');
}

export function createDesktopId(fill = (buffer) => crypto.getRandomValues(buffer)) {
  const bytes = new Uint8Array(16);
  fill(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(bytes).toString('base64');
  return `d_${encoded.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

export function headscaleHostname(value) {
  const normalized = text(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return normalized || 'cialai-desktop';
}

export function pairClock(startedAt, expiresAt, now = Date.now()) {
  const expiry = Date.parse(expiresAt);
  return {
    rotationSeconds: Math.max(0, Math.ceil((Number(startedAt) + PAIR_ROTATION_SECONDS * 1000 - Number(now)) / 1000)),
    expirySeconds: Number.isFinite(expiry) ? Math.max(0, Math.ceil((expiry - Number(now)) / 1000)) : 0,
  };
}

export function initialTunnelSnapshot(configured = false) {
  return {
    configured: Boolean(configured),
    supervisor: 'idle',
    node: { state: 'stopped', peers: [] },
    edge: { state: 'stopped' },
  };
}

export function reduceTunnelEvent(snapshot, frame = {}) {
  const data = frame.data && typeof frame.data === 'object' ? frame.data : {};
  if (frame.event === 'node.state') return { ...snapshot, configured: true, node: { ...snapshot.node, ...data } };
  if (frame.event === 'edge.state') return { ...snapshot, edge: { ...snapshot.edge, ...data } };
  if (frame.event === 'tunnel.state') return { ...snapshot, supervisor: data.state || snapshot.supervisor };
  return snapshot;
}

export function tunnelPresentation(snapshot = initialTunnelSnapshot()) {
  if (!snapshot.configured) return { tone: 'idle', label: translate('desktop.tunnel.notConfigured') };
  if (snapshot.supervisor === 'failed' || snapshot.node?.state === 'offline' || snapshot.edge?.state === 'failed') return { tone: 'bad', label: translate('desktop.tunnel.unavailable') };
  if (snapshot.supervisor === 'restarting') return { tone: 'busy', label: translate('desktop.tunnel.reconnecting') };
  if (snapshot.node?.state === 'running' && snapshot.edge?.state === 'running') return { tone: 'ok', label: translate('desktop.tunnel.accessible') };
  if (snapshot.node?.state === 'needs-login') return { tone: 'bad', label: translate('desktop.tunnel.loginRequired') };
  return { tone: 'busy', label: translate('desktop.tunnel.preparing') };
}

export function updateDevicesFromEvent(devices = [], data = {}) {
  if (!data.deviceId) return devices;
  if (data.revoked) return devices.filter((device) => device.id !== data.deviceId);
  if (!data.name) return devices;
  return devices.map((device) => device.id === data.deviceId ? { ...device, name: data.name } : device);
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
