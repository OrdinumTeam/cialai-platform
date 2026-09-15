// SPDX-License-Identifier: Apache-2.0
// Single desktop bridge for tunnel commands, events and browser-only previews.
// A rede sobe sozinha ao abrir: `net.start` com o nome do computador e a
// aprovação por código, sem servidor, endereço, porta ou chave.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { invoke, isTauri, listen } from '../lib/native.js';
import {
  PAIR_ROTATION_SECONDS,
  PAIR_TTL_SECONDS,
  applyNetStatus,
  applySessionEvent,
  initialTunnelSnapshot,
  netStartArgs,
  normalizeDevices,
  normalizeDiagnostics,
  normalizeNetworkPreferences,
  normalizeTorStatus,
  reduceTunnelEvent,
  tunnelErrorMessage,
  tunnelPresentation,
  tunnelProblemCode,
  updateDevicesFromEvent,
} from './tunnel-model.js';
import { translate, useI18n } from './i18n.js';

const TunnelContext = createContext(null);
const EVENT_CHANNELS = Object.freeze(['tunnel://state', 'tunnel://pair', 'tunnel://devices']);

export { tunnelErrorMessage };

// Modo demo: simula o sidecar v2 inteiro para as capturas e os checks de
// navegador. `reserve` fixa a conexão de reserva em um progresso, em `ready`
// ou em `failed`; sem ele o bootstrap anda sozinho até publicar o onion.
const DEMO_ONION = 'q7c3m2tzl5xv4nfk6r6yh3wjp2ds5bgae4u7okv5x2lm3hn6fw4cyqad.onion';
const DEMO_DESKTOP = Object.freeze({ id: 'd_Q2lhbGFpRGVtb0Rlc2t0b3A', publicKey: 'x0mYp7oHqQ9dL1vS3cN8eR2tU5wZ6aB4fG7hJ9kM0nP', fingerprint: 'C1A7 4E2B 9D30 6F58' });
const DEMO_BOOTSTRAP_DELAY_MS = 2000;
const DEMO_BOOTSTRAP_STEP_MS = 200;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function queryParam(name) {
  try { return new URLSearchParams(window.location.search).get(name); } catch (_error) { return null; }
}

function previewMode() {
  return queryParam('tunnel') === 'demo';
}

function demoReserveMode() {
  const value = queryParam('reserve');
  if (value === 'ready' || value === 'failed') return value;
  if (/^\d{1,3}$/.test(value || '')) return Math.min(99, Number(value));
  return 'auto';
}

function demoTor(mode = demoReserveMode()) {
  if (mode === 'ready') return { state: 'ready', progress: 100, onion: DEMO_ONION, published: true };
  if (mode === 'failed') return { state: 'failed', progress: 45, onion: DEMO_ONION, published: false, error: 'tor_bootstrap_timeout' };
  if (typeof mode === 'number') return { state: 'bootstrapping', progress: mode, onion: DEMO_ONION, published: false };
  return { state: 'starting', progress: 0, onion: DEMO_ONION, published: false };
}

function demoNetStatus(tor, name, devices) {
  const sessions = normalizeDevices(devices).reduce((total, device) => ({ direct: total.direct + device.sessions.direct, tor: total.tor + device.sessions.tor }), { direct: 0, tor: 0 });
  return {
    state: tor.state === 'failed' ? 'degraded' : 'ready',
    desktop: { ...DEMO_DESKTOP, name },
    direct: {
      state: 'listening',
      port: 4740,
      candidates: [
        { kind: 'lan', addr: '192.168.1.24:4740' },
        { kind: 'ipv6', addr: '[2001:db8:4a::24]:4740' },
        { kind: 'mapped', addr: '203.0.113.18:4740' },
      ],
      mapping: { protocol: 'natpmp', external: '203.0.113.18:4740' },
      stun: { state: 'ok', addr: '203.0.113.18:4740' },
    },
    tor,
    mdns: { state: 'announcing' },
    edge: { state: 'running' },
    sessions,
  };
}

const demoDeviceList = () => [
  { id: 'dev_iphone', name: translate('desktop.demo.iphoneName'), model: 'iPhone 16 Pro', platform: 'ios', app: '0.1.1', fingerprint: '7B2E 91C4', lastSeenAt: new Date(Date.now() - 24_000).toISOString(), pairedAt: '2026-09-10T15:20:00Z', lastTransport: 'direct', lastRemoteAddr: '192.168.1.31:53122', revoked: false, connected: true, transports: ['direct'] },
  { id: 'dev_pixel', name: translate('desktop.demo.androidName'), model: 'Pixel 9', platform: 'android', app: '0.1.1', fingerprint: '3F88 0AD1', lastSeenAt: new Date(Date.now() - 95_000).toISOString(), pairedAt: '2026-09-11T09:05:00Z', lastTransport: 'tor', lastRemoteAddr: '', revoked: false, connected: true, transports: ['tor'] },
  { id: 'dev_ipad', name: translate('desktop.demo.ipadName'), model: 'iPad Air', platform: 'ios', app: '0.1.1', fingerprint: 'D402 6C19', lastSeenAt: new Date(Date.now() - 4_200_000).toISOString(), pairedAt: '2026-09-08T11:00:00Z', lastTransport: 'direct', lastRemoteAddr: '192.168.1.40:50210', revoked: false, connected: false, transports: [] },
];

const DEMO_NAME_KEYS = Object.freeze({ dev_iphone: 'desktop.demo.iphoneName', dev_pixel: 'desktop.demo.androidName', dev_ipad: 'desktop.demo.ipadName', dev_new: 'desktop.demo.newPhoneName' });

function demoPayload(pairId) {
  const json = JSON.stringify({ v: 2, demo: true, pairId, desktop: DEMO_DESKTOP.id, onion: DEMO_ONION });
  return `CIALAI2.${btoa(json).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}

function demoDiagnostics(tor) {
  const published = tor.published === true;
  const failed = tor.state === 'failed';
  const checks = [
    { id: 'identity', ok: true, detail: DEMO_DESKTOP.fingerprint },
    { id: 'direct_listener', ok: true, detail: 'UDP 4740' },
    { id: 'lan_candidates', ok: true, detail: '192.168.1.24:4740' },
    { id: 'ipv6', ok: true, detail: '[2001:db8:4a::24]:4740' },
    { id: 'port_mapping', ok: true, detail: 'NAT-PMP 203.0.113.18:4740' },
    { id: 'stun', ok: true, detail: 'stun.cloudflare.com:3478' },
    { id: 'tor_process', ok: !failed },
    { id: 'tor_bootstrap', ok: published, detail: `${tor.progress}%` },
    { id: 'onion_published', ok: published },
    { id: 'mdns', ok: true, detail: '_cialai._udp' },
    { id: 'edge', ok: true },
  ];
  return { ok: checks.every((check) => check.ok), checks };
}

export function TunnelProvider({ children }) {
  const { locale } = useI18n();
  const demo = previewMode();
  const native = isTauri();
  const [preferences, setPreferences] = useState(() => normalizeNetworkPreferences(demo ? { desktopName: translate('desktop.demo.computerName'), requireApproval: queryParam('approval') === '1', keepAwakeWhilePaired: true } : {}));
  const preferencesRef = useRef(preferences);
  preferencesRef.current = preferences;
  const [snapshot, setSnapshot] = useState(initialTunnelSnapshot);
  const [devices, setDevices] = useState([]);
  const devicesRef = useRef(devices);
  devicesRef.current = devices;
  const [pairEvent, setPairEvent] = useState(null);
  const [lastError, setLastError] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const startedRef = useRef(false);
  const restartingRef = useRef(false);
  const demoRef = useRef(null);
  if (demo && !demoRef.current) demoRef.current = { tor: demoTor(), devices: demoDeviceList(), renamed: new Set(), pairs: new Map(), timers: [] };
  const acceptEventRef = useRef(() => {});
  const demoCompleteRef = useRef(() => {});
  const listenersRef = useRef(Promise.resolve());

  const status = useMemo(() => tunnelPresentation(snapshot), [snapshot, locale]);

  const demoName = useCallback(() => preferencesRef.current.desktopName || translate('desktop.demo.computerName'), []);

  const demoResponse = useCallback(async (command, args) => {
    const state = demoRef.current;
    if (command === 'net.start') {
      await pause(350);
      return demoNetStatus(state.tor, args.desktopName || demoName(), state.devices);
    }
    if (command === 'net.status' || command === 'net.refresh') return demoNetStatus(state.tor, demoName(), state.devices);
    if (command === 'net.stop') return { state: 'stopped' };
    if (command === 'tor.status') return state.tor;
    if (command === 'diagnostics.run') { await pause(300); return demoDiagnostics(state.tor); }
    if (command === 'devices.list') return { devices: state.devices.map((device) => DEMO_NAME_KEYS[device.id] && !state.renamed.has(device.id) ? { ...device, name: translate(DEMO_NAME_KEYS[device.id]) } : device) };
    if (command === 'pair.begin') {
      const now = Date.now();
      const pairId = `p_demo_${now}`;
      state.pairs.set(pairId, true);
      return { pairId, payload: demoPayload(pairId), expiresAt: Math.floor(now / 1000) + (args.ttlSeconds || PAIR_TTL_SECONDS), rotateAfterSeconds: PAIR_ROTATION_SECONDS, reserve: state.tor };
    }
    if (command === 'pair.cancel' || command === 'pair.deny') { state.pairs.delete(args.pairId); return {}; }
    if (command === 'pair.approve') {
      state.pairs.delete(args.pairId);
      state.timers.push(setTimeout(() => demoCompleteRef.current(args.pairId), 400));
      return {};
    }
    if (command === 'devices.revoke') {
      state.devices = state.devices.filter((device) => device.id !== args.deviceId);
      return { sessions: 1, sockets: 1 };
    }
    if (command === 'devices.rename') {
      state.renamed.add(args.deviceId);
      state.devices = state.devices.map((device) => device.id === args.deviceId ? { ...device, name: args.name } : device);
      return state.devices.find((device) => device.id === args.deviceId) || {};
    }
    if (command === 'logs.tail') return { lines: [JSON.stringify({ level: 'info', message: translate('desktop.demo.networkReady') })] };
    return {};
  }, [demoName]);

  const call = useCallback(async (command, args = {}) => {
    if (demo) return demoResponse(command, args);
    if (!native) throw new Error(translate('desktop.tunnel.desktopOnly'));
    return invoke('tunnel_call', { command, args });
  }, [demo, demoResponse, native]);

  const refreshDevices = useCallback(async () => {
    const result = await call('devices.list', {});
    const next = normalizeDevices(result?.devices);
    setDevices(next);
    return next;
  }, [call]);

  const startNetwork = useCallback(async (value = preferencesRef.current) => {
    setSnapshot((current) => ({ ...current, startup: current.startup === 'started' ? 'started' : 'starting' }));
    setLastError('');
    try {
      const fallback = native ? '' : translate('desktop.demo.computerName');
      const netStatus = await call('net.start', netStartArgs(value, fallback));
      setSnapshot((current) => applyNetStatus(current, netStatus));
      await refreshDevices();
      return netStatus;
    } catch (error) {
      setLastError(tunnelErrorMessage(error));
      setSnapshot((current) => ({ ...current, startup: 'failed' }));
      throw error;
    }
  }, [call, native, refreshDevices]);

  const acceptEvent = useCallback((frame) => {
    if (!frame || typeof frame !== 'object') return;
    setSnapshot((current) => reduceTunnelEvent(current, frame));
    const data = frame.data && typeof frame.data === 'object' ? frame.data : {};
    if (frame.event === 'tunnel.state') {
      // O supervisor reinicia o sidecar sozinho, mas a rede só volta com uma
      // nova `net.start`.
      if (data.state === 'restarting') restartingRef.current = true;
      if (data.state === 'running' && restartingRef.current) {
        restartingRef.current = false;
        startNetwork().catch(() => {});
      }
    }
    if (frame.event === 'pair.completed' || frame.event === 'pair.failed' || frame.event === 'pair.requested') {
      setPairEvent(frame);
      if (frame.event === 'pair.completed' && data.device?.id) {
        setDevices((current) => normalizeDevices([...current.filter((device) => device.id !== data.device.id), data.device]));
      }
    }
    if (frame.event === 'session.opened' || frame.event === 'session.closed') {
      if (data.deviceId && !devicesRef.current.some((device) => device.id === data.deviceId)) refreshDevices().catch(() => {});
      else setDevices((current) => applySessionEvent(current, frame));
    }
    if (frame.event === 'devices.changed') {
      if (data.revoked || data.name) setDevices((current) => updateDevicesFromEvent(current, data));
      else refreshDevices().catch(() => {});
    }
  }, [refreshDevices, startNetwork]);

  acceptEventRef.current = acceptEvent;
  // Conclusão simulada do pareamento no modo demo: o registro nasce sem
  // sessão e a sessão direta chega logo depois, como na borda v2.
  demoCompleteRef.current = (pairId) => {
    const state = demoRef.current;
    if (!state) return;
    const device = { id: 'dev_new', name: translate('desktop.demo.newPhoneName'), model: 'iPhone 15', platform: 'ios', app: '0.1.1', fingerprint: '5C0E 7A93', pairedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), lastTransport: 'direct', lastRemoteAddr: '192.168.1.52:52044', revoked: false, connected: false, transports: [] };
    state.devices = [...state.devices.filter((item) => item.id !== device.id), { ...device, connected: true, transports: ['direct'] }];
    acceptEvent({ event: 'pair.completed', data: { pairId, device, transport: 'direct' } });
    state.timers.push(setTimeout(() => acceptEvent({ event: 'session.opened', data: { deviceId: device.id, transport: 'direct', remoteAddr: device.lastRemoteAddr, deviceKey: 'demo' } }), 150));
  };

  useEffect(() => {
    if (!native) return undefined;
    let disposed = false;
    const releases = [];
    listenersRef.current = Promise.all(EVENT_CHANNELS.map((channel) => listen(channel, (frame) => acceptEventRef.current(frame))))
      .then((items) => { if (disposed) items.forEach((release) => release()); else releases.push(...items); })
      .catch((error) => { if (!disposed) setLastError(tunnelErrorMessage(error)); });
    return () => { disposed = true; releases.forEach((release) => release()); };
  }, [native]);

  // Abertura: lê as preferências e sobe a rede, sem esperar configuração. Os
  // ouvintes de evento entram antes, para não perder o bootstrap do Tor.
  useEffect(() => {
    if ((!native && !demo) || startedRef.current) return;
    startedRef.current = true;
    const load = native
      ? Promise.all([invoke('get_preferences'), listenersRef.current]).then(([prefs]) => normalizeNetworkPreferences(prefs?.network))
      : Promise.resolve(preferencesRef.current);
    load.then((next) => {
      setPreferences(next);
      preferencesRef.current = next;
      return startNetwork(next);
    }).catch((error) => {
      setLastError(tunnelErrorMessage(error));
      setSnapshot((current) => ({ ...current, startup: 'failed' }));
    });
  }, [demo, native, startNetwork]);

  // Bootstrap simulado do Tor no modo demo.
  useEffect(() => {
    if (!demo) return undefined;
    const state = demoRef.current;
    const emitTor = (tor) => {
      state.tor = tor;
      acceptEventRef.current({ event: 'tor.state', data: tor });
    };
    if (demoReserveMode() === 'auto') {
      let progress = 0;
      state.timers.push(setTimeout(function step() {
        progress = Math.min(100, progress + 8);
        if (progress < 100) {
          emitTor({ state: 'bootstrapping', progress, onion: DEMO_ONION, published: false });
          state.timers.push(setTimeout(step, DEMO_BOOTSTRAP_STEP_MS));
          return;
        }
        emitTor({ state: 'ready', progress: 100, onion: DEMO_ONION, published: true });
        acceptEventRef.current({ event: 'net.state', data: demoNetStatus(state.tor, demoName(), state.devices) });
      }, DEMO_BOOTSTRAP_DELAY_MS));
    }
    const scan = () => {
      const pairId = [...state.pairs.keys()].at(-1);
      if (!pairId) return;
      if (preferencesRef.current.requireApproval) acceptEventRef.current({ event: 'pair.requested', data: { pairId, code: '4827', device: { name: translate('desktop.demo.newPhoneName'), model: 'iPhone 15' } } });
      else { state.pairs.delete(pairId); demoCompleteRef.current(pairId); }
    };
    window.addEventListener('cialai:demo-phone-scan', scan);
    return () => {
      window.removeEventListener('cialai:demo-phone-scan', scan);
      state.timers.forEach((timer) => clearTimeout(timer));
      state.timers = [];
    };
  }, [demo, demoName]);

  // Os checks de navegador conferem a sequência de estados do ponto.
  useEffect(() => {
    if (!demo) return;
    try {
      const seen = window.__cialaiTunnelStates || [];
      if (seen.at(-1) !== status.state) window.__cialaiTunnelStates = [...seen, status.state];
    } catch (_error) { /* sem janela */ }
  }, [demo, status.state]);

  useEffect(() => {
    if (!demo) return;
    setPreferences((current) => ({ ...current, desktopName: translate('desktop.demo.computerName') }));
    setSnapshot((current) => current.net?.desktop ? { ...current, net: { ...current.net, desktop: { ...current.net.desktop, name: translate('desktop.demo.computerName') } } } : current);
    setDevices((current) => current.map((device) => DEMO_NAME_KEYS[device.id] && !demoRef.current?.renamed.has(device.id) ? { ...device, name: translate(DEMO_NAME_KEYS[device.id]) } : device));
  }, [demo, locale]);

  // Preferências salvas: `net.start` é idempotente e aplica nome e aprovação.
  const applyNetworkPreferences = useCallback(async (value) => {
    const next = normalizeNetworkPreferences(value);
    setPreferences(next);
    preferencesRef.current = next;
    if (!native && !demo) return null;
    return startNetwork(next);
  }, [demo, native, startNetwork]);

  const refreshNetwork = useCallback(async () => {
    const netStatus = await call('net.refresh', {});
    setSnapshot((current) => applyNetStatus(current, netStatus));
    await refreshDevices();
    return netStatus;
  }, [call, refreshDevices]);

  const beginPair = useCallback(async () => {
    setPairEvent(null);
    const pair = await call('pair.begin', { ttlSeconds: PAIR_TTL_SECONDS });
    if (pair?.reserve) setSnapshot((current) => reduceTunnelEvent(current, { event: 'tor.state', data: normalizeTorStatus(pair.reserve) }));
    if (demo && queryParam('approval') === '1') {
      setTimeout(() => setPairEvent({ event: 'pair.requested', data: { pairId: pair.pairId, code: '4827', device: { name: translate('desktop.demo.newPhoneName'), model: 'iPhone 15' } } }), 500);
    }
    return pair;
  }, [call, demo]);

  const cancelPair = useCallback(async (pairId) => {
    setPairEvent(null);
    if (!pairId) return;
    try { await call('pair.cancel', { pairId }); } catch (error) {
      if (!['pair_unknown', 'pair_consumed'].includes(tunnelProblemCode(error))) throw error;
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

  const revokeDevice = useCallback(async (deviceId) => {
    await call('devices.revoke', { deviceId });
    setDevices((current) => updateDevicesFromEvent(current, { deviceId, revoked: true }));
  }, [call]);

  const runDiagnostics = useCallback(async () => {
    const [result, netStatus] = await Promise.all([call('diagnostics.run', {}), call('net.status', {})]);
    setSnapshot((current) => applyNetStatus(current, netStatus));
    return { ...normalizeDiagnostics(result), checkedAt: Date.now() };
  }, [call]);

  // Limpeza da chave do Headscale guardada por versões anteriores.
  const deleteLegacyApiKey = useCallback(async () => {
    if (demo) { await pause(200); return; }
    if (!native) throw new Error(translate('desktop.tunnel.desktopOnly'));
    await invoke('tunnel_delete_api_key');
  }, [demo, native]);

  const desktop = snapshot.net?.desktop || null;
  const desktopName = desktop?.name || preferences.desktopName || (demo ? translate('desktop.demo.computerName') : '');

  const value = useMemo(() => ({
    demo, native, preferences, desktop, desktopName, snapshot, status, devices,
    pairEvent, lastError, advancedOpen,
    call, startNetwork, applyNetworkPreferences, refreshNetwork, refreshDevices,
    beginPair, cancelPair, decidePair, clearPairEvent, renameDevice, revokeDevice,
    runDiagnostics, deleteLegacyApiKey, setAdvancedOpen,
  }), [demo, native, preferences, desktop, desktopName, snapshot, status, devices, pairEvent, lastError, advancedOpen, call, startNetwork, applyNetworkPreferences, refreshNetwork, refreshDevices, beginPair, cancelPair, decidePair, clearPairEvent, renameDevice, revokeDevice, runDiagnostics, deleteLegacyApiKey]);

  return <TunnelContext.Provider value={value}>{children}</TunnelContext.Provider>;
}

export function useTunnel() {
  const value = useContext(TunnelContext);
  if (!value) throw new Error('tunnel_provider_missing');
  return value;
}
