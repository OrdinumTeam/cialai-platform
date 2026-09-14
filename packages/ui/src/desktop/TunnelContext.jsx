// SPDX-License-Identifier: Apache-2.0
// Single desktop bridge for tunnel commands, events and browser-only previews.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri, listen } from '../lib/native.js';
import {
  EDGE_PORT,
  PAIR_TTL_SECONDS,
  createDesktopId,
  headscaleHostname,
  initialTunnelSnapshot,
  networkIsConfigured,
  normalizeNetworkConfig,
  reduceTunnelEvent,
  tunnelErrorMessage,
  tunnelPresentation,
  tunnelProblemCode,
  updateDevicesFromEvent,
} from './tunnel-model.js';
import { translate, useI18n } from './i18n.js';

const DESKTOP_ID_KEY = 'cialai_desktop_id';
const TunnelContext = createContext(null);

const demoNetwork = () => ({
  controlUrl: 'https://headscale.cialai.local',
  userId: '42',
  userName: 'alice',
  desktopName: translate('desktop.demo.computerName'),
  requireApproval: false,
  keepAwakeWhilePaired: true,
});

const demoKeyExpiry = '2027-09-12T12:00:00Z';

const demoNode = Object.freeze({
  state: 'running',
  ip4: '100.64.0.8',
  ip6: 'fd7a:115c:a1e0::8',
  dnsName: 'mac-do-estudio.cialai.local',
  keyExpiry: '2027-09-12T12:00:00Z',
  health: [],
  derp: { regionId: 1, name: 'São Paulo', latencyMs: 18 },
  peers: [],
});

const demoDeviceList = () => [
  { id: 'dev_iphone', name: translate('desktop.demo.iphoneName'), model: 'iPhone 16 Pro', platform: 'ios', app: '0.1.0', ip4: '100.64.0.21', lastSeenAt: new Date(Date.now() - 24_000).toISOString(), pairedAt: '2026-09-10T15:20:00Z', online: true, revoked: false },
  { id: 'dev_ipad', name: translate('desktop.demo.ipadName'), model: 'iPad Air', platform: 'ios', app: '0.1.0', ip4: '100.64.0.22', lastSeenAt: new Date(Date.now() - 4_200_000).toISOString(), pairedAt: '2026-09-08T11:00:00Z', online: false, revoked: false },
];

function previewMode() {
  try { return new URLSearchParams(window.location.search).get('tunnel') === 'demo'; } catch (_error) { return false; }
}

const problemCode = tunnelProblemCode;
export { tunnelErrorMessage };

function getOrCreateDesktopId() {
  try {
    const stored = localStorage.getItem(DESKTOP_ID_KEY);
    if (/^d_[A-Za-z0-9_-]{22}$/.test(stored || '')) return stored;
    const created = createDesktopId();
    localStorage.setItem(DESKTOP_ID_KEY, created);
    return created;
  } catch (_error) { return createDesktopId(); }
}

function demoResponse(command, args, devices) {
  if (command === 'control.users.list') return { users: [{ id: '42', name: 'alice', displayName: 'Ana' }, { id: '51', name: 'equipe', displayName: translate('desktop.demo.teamName') }] };
  if (command === 'control.users.create') return { user: { id: '73', name: args.name, displayName: args.displayName } };
  if (command === 'node.status' || command === 'node.up') return demoNode;
  if (command === 'node.down') return { state: 'stopped', peers: [] };
  if (command === 'edge.serve') return { port: EDGE_PORT };
  if (command === 'edge.stop' || command === 'pair.cancel' || command === 'pair.approve' || command === 'pair.deny' || command === 'devices.rename' || command === 'devices.revoke') return {};
  if (command === 'pair.begin') {
    const now = Date.now();
    return { pairId: `p_demo_${now}`, payload: `CIALAI1.demo-${now}`, expiresAt: new Date(now + PAIR_TTL_SECONDS * 1000).toISOString(), preAuthKeyId: 7 };
  }
  if (command === 'devices.list') return { devices };
  if (command === 'logs.tail') return { lines: [
    JSON.stringify({ level: 'info', message: translate('desktop.demo.networkReady') }),
    JSON.stringify({ level: 'info', message: translate('desktop.demo.edgeReachable') }),
  ] };
  return {};
}

export function TunnelProvider({ children }) {
  const { locale } = useI18n();
  const demo = previewMode();
  const native = isTauri();
  const [network, setNetwork] = useState(() => demo ? demoNetwork() : null);
  const [snapshot, setSnapshot] = useState(() => {
    if (!demo) return initialTunnelSnapshot(false);
    return { ...initialTunnelSnapshot(true), supervisor: 'running', node: demoNode, edge: { state: 'running', port: EDGE_PORT } };
  });
  const [devices, setDevices] = useState(() => demo ? demoDeviceList() : []);
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const [pairEvent, setPairEvent] = useState(null);
  const [controlHealth, setControlHealth] = useState(demo ? { ok: true, serverVersion: '0.29.3' } : null);
  const [secretStatus, setSecretStatus] = useState(demo ? { present: true, fallback: false, prefix: 'hskey-api-demo', expiresAt: demoKeyExpiry } : null);
  const [lastError, setLastError] = useState('');
  const restoringRef = useRef(false);

  useEffect(() => {
    if (!demo) return;
    setNetwork((current) => current ? { ...current, desktopName: translate('desktop.demo.computerName') } : current);
    setDevices((current) => current.map((device) => ({
      ...device,
      name: translate(device.id === 'dev_iphone' ? 'desktop.demo.iphoneName' : 'desktop.demo.ipadName'),
    })));
  }, [demo, locale]);

  const call = useCallback(async (command, args = {}) => {
    if (demo) return demoResponse(command, args, devicesRef.current);
    if (!native) throw new Error(translate('desktop.tunnel.desktopOnly'));
    return invoke('tunnel_call', { command, args });
  }, [demo, native]);

  const acceptEvent = useCallback((frame) => {
    if (!frame || typeof frame !== 'object') return;
    setSnapshot((current) => reduceTunnelEvent(current, frame));
    if (frame.event === 'pair.completed' || frame.event === 'pair.failed' || frame.event === 'pair.requested') {
      setPairEvent(frame);
      if (frame.event === 'pair.completed' && frame.data?.device) {
        setDevices((current) => [...current.filter((device) => device.id !== frame.data.device.id), frame.data.device]);
      }
    }
    if (frame.event === 'devices.changed') setDevices((current) => updateDevicesFromEvent(current, frame.data));
  }, []);

  useEffect(() => {
    if (!native) return undefined;
    let disposed = false;
    const releases = [];
    Promise.all(['tunnel://state', 'tunnel://pair', 'tunnel://devices'].map((channel) => listen(channel, acceptEvent)))
      .then((items) => { if (disposed) items.forEach((release) => release()); else releases.push(...items); })
      .catch((error) => { if (!disposed) setLastError(tunnelErrorMessage(error)); });
    return () => { disposed = true; releases.forEach((release) => release()); };
  }, [acceptEvent, native]);

  const configureControl = useCallback(async ({ url, apiKey, caFile = null }) => {
    const result = demo
      ? { health: { ok: true, serverVersion: '0.29.3' }, apiKey: { prefix: 'hskey-api-demo', expiresAt: demoKeyExpiry } }
      : await invoke('tunnel_control_configure', { url, apiKey, caFile });
    setControlHealth(result?.health || null);
    setSecretStatus({ present: true, fallback: false, prefix: result?.apiKey?.prefix || null, expiresAt: result?.apiKey?.expiresAt || null });
    setLastError('');
    return result;
  }, [demo]);

  const configureSavedControl = useCallback(async (url, caFile = null) => {
    const result = demo
      ? { health: { ok: true, serverVersion: '0.29.3' }, apiKey: { prefix: 'hskey-api-demo', expiresAt: demoKeyExpiry } }
      : await invoke('tunnel_control_configure_saved', { url, caFile });
    setControlHealth(result?.health || null);
    if (result?.apiKey) {
      setSecretStatus((current) => ({ ...(current || {}), present: true, prefix: result.apiKey.prefix || current?.prefix || null, expiresAt: result.apiKey.expiresAt || null }));
    }
    return result;
  }, [demo]);

  const refreshDevices = useCallback(async () => {
    const result = await call('devices.list', {});
    const next = Array.isArray(result?.devices) ? result.devices.filter((device) => !device.revoked) : [];
    setDevices(next);
    return next;
  }, [call]);

  const connectNetwork = useCallback(async (value, options = {}) => {
    const config = normalizeNetworkConfig(value);
    if (!networkIsConfigured(config)) throw new Error(translate('desktop.tunnel.completeConfiguration'));
    setNetwork(config);
    setSnapshot((current) => ({ ...current, configured: true, supervisor: 'starting' }));
    setLastError('');
    try {
      let status = await call('node.status', {});
      if (options.restart && status?.state === 'running') {
        try { await call('edge.stop', {}); } catch (_error) { /* edge already stopped */ }
        await call('node.down', {});
        status = { state: 'stopped' };
      }
      if (status?.state !== 'running') {
        status = await call('node.up', {
          controlUrl: config.controlUrl,
          userId: config.userId,
          userName: config.userName,
          hostname: headscaleHostname(config.desktopName),
          forceLogin: false,
        });
      }
      setSnapshot((current) => ({ ...current, configured: true, supervisor: 'running', node: { ...current.node, ...status } }));
      try {
        await call('edge.serve', {
          port: EDGE_PORT,
          requireApproval: config.requireApproval,
          desktop: { id: getOrCreateDesktopId(), name: config.desktopName },
        });
      } catch (error) {
        if (problemCode(error) !== 'edge_running') throw error;
      }
      setSnapshot((current) => ({ ...current, edge: { state: 'running', port: EDGE_PORT } }));
      await refreshDevices();
      return status;
    } catch (error) {
      const message = tunnelErrorMessage(error);
      setLastError(message);
      setSnapshot((current) => ({ ...current, supervisor: 'failed' }));
      throw error;
    }
  }, [call, refreshDevices]);

  useEffect(() => {
    if (!native || restoringRef.current) return;
    restoringRef.current = true;
    invoke('get_preferences').then(async (prefs) => {
      const config = normalizeNetworkConfig(prefs?.network || {});
      setNetwork(config);
      setSnapshot((current) => ({ ...current, configured: networkIsConfigured(config) }));
      try { setSecretStatus(await invoke('tunnel_api_key_status')); } catch (_error) { /* shown when setup opens */ }
      if (!networkIsConfigured(config)) return;
      await configureSavedControl(config.controlUrl);
      await connectNetwork(config);
    }).catch((error) => {
      setLastError(tunnelErrorMessage(error));
      setSnapshot((current) => ({ ...current, supervisor: 'failed' }));
    });
  }, [configureSavedControl, connectNetwork, native]);

  const beginPair = useCallback(async () => {
    setPairEvent(null);
    const pair = await call('pair.begin', { ttlSeconds: PAIR_TTL_SECONDS });
    if (demo && new URLSearchParams(window.location.search).get('approval') === '1') {
      setTimeout(() => setPairEvent({ event: 'pair.requested', data: { pairId: pair.pairId, code: '4827', device: { name: translate('desktop.demo.iphoneName'), model: 'iPhone 16 Pro' } } }), 500);
    }
    return pair;
  }, [call, demo]);

  const cancelPair = useCallback(async (pairId) => {
    setPairEvent(null);
    if (!pairId) return;
    try { await call('pair.cancel', { pairId }); } catch (error) {
      if (!['pair_unknown', 'pair_consumed'].includes(problemCode(error))) throw error;
    }
  }, [call]);

  const decidePair = useCallback(async (pairId, approved) => {
    await call(approved ? 'pair.approve' : 'pair.deny', { pairId });
    setPairEvent(null);
  }, [call]);

  const clearPairEvent = useCallback(() => setPairEvent(null), []);

  const renameDevice = useCallback(async (deviceId, name) => {
    await call('devices.rename', { deviceId, name });
    setDevices((current) => updateDevicesFromEvent(current, { deviceId, name }));
  }, [call]);

  const revokeDevice = useCallback(async (deviceId, networkToo) => {
    await call('devices.revoke', { deviceId, network: Boolean(networkToo) });
    setDevices((current) => updateDevicesFromEvent(current, { deviceId, revoked: true }));
  }, [call]);

  const runDiagnostics = useCallback(async () => {
    const [doctor, node, secret, logs] = await Promise.all([
      demo ? Promise.resolve({ ok: true, checks: { state: { ok: true }, control: { ok: true } } }) : invoke('tunnel_doctor', { controlUrl: network?.controlUrl || null }),
      call('node.status', {}),
      demo ? Promise.resolve(secretStatus) : invoke('tunnel_api_key_status'),
      call('logs.tail', { lines: 50 }),
    ]);
    setSecretStatus(secret);
    setSnapshot((current) => ({ ...current, node: { ...current.node, ...node } }));
    return { doctor, node, secret, lines: logs?.lines || [] };
  }, [call, demo, network?.controlUrl, secretStatus]);

  const value = useMemo(() => ({
    demo, native, network, snapshot, status: tunnelPresentation(snapshot), devices,
    pairEvent, controlHealth, secretStatus, lastError,
    call, configureControl, configureSavedControl, connectNetwork, refreshDevices,
    beginPair, cancelPair, decidePair, renameDevice, revokeDevice, runDiagnostics,
    clearPairEvent,
  }), [demo, native, network, snapshot, devices, pairEvent, controlHealth, secretStatus, lastError, call, configureControl, configureSavedControl, connectNetwork, refreshDevices, beginPair, cancelPair, decidePair, renameDevice, revokeDevice, runDiagnostics, clearPairEvent, locale]);

  return <TunnelContext.Provider value={value}>{children}</TunnelContext.Provider>;
}

export function useTunnel() {
  const value = useContext(TunnelContext);
  if (!value) throw new Error('tunnel_provider_missing');
  return value;
}
