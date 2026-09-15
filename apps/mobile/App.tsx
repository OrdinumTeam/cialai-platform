import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Platform, StyleSheet, useColorScheme, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import { StatusBar } from 'expo-status-bar';

import {
  addListener as addTunnelListener,
  closeDesktop,
  connect,
  forgetDesktop as forgetTunnelDesktop,
  notifyForeground,
  notifyNetworkChange,
  openDesktop as openTunnelDesktop,
  setLogLevel as setNativeLogLevel,
  status,
  version as coreVersion,
  type LogLevel,
  type PairResult,
  type PathKind,
  type TorProgress,
  type Transport,
  type TunnelStatus
} from 'cialai-tunnel';

import { authenticateWithDevice, BiometricSession } from './src/auth/biometrics';
import { getAppVersion } from './src/config/env';
import { validateControlUrl } from './src/config/url';
import {
  deleteDeviceToken,
  emptyDesktopStore,
  findDesktop,
  loadDesktopStore,
  markDesktopUsed,
  readDeviceToken,
  recordPair,
  recordTransport,
  removeDesktop,
  renameDesktop,
  saveDesktopStore,
  saveDeviceToken,
  type DesktopEntry,
  type DesktopStore
} from './src/desktops/store';
import { hydrateLocale, useI18n } from './src/i18n';
import { checkControlHealth, HEALTH_RECHECK_TIMEOUT_MS } from './src/network/health';
import { RequestGate } from './src/network/request-gate';
import { Desktops } from './src/screens/Desktops';
import { Offline } from './src/screens/Offline';
import { Pair } from './src/screens/Pair';
import { Settings } from './src/screens/Settings';
import { Shell } from './src/screens/Shell';
import { openConnection, outcomeForCode, type ConnectionOutcome, type ConnectionPorts } from './src/state/connection';
import { createNetworkForwarder, handleAppStateTransition, type ForegroundAction } from './src/state/lifecycle';
import { describeDesktop, transition, type AppAction, type AppScreen, type OfflineReason } from './src/state/machine';
import { interpretTunnelEvent, parseTorProgress, reservePercent, type TunnelSignal } from './src/state/tunnel-events';
import { normalizeThemeMode, resolveScheme, THEME_STORAGE_KEY, ThemeModeContext, usePalette, type ThemeMode } from './src/theme';

type Translator = (key: string, values?: Record<string, string | number>) => string;

// Prazo para o nativo Android reabrir o proxy depois da parada em segundo plano,
// coberto o orçamento de 20 s da reserva; passado ele, o app reconecta sozinho.
const NATIVE_REOPEN_WAIT_MS = 30_000;

const connectionPorts: ConnectionPorts = {
  readToken: desktopId => readDeviceToken(desktopId),
  connect,
  openDesktop: (desktopId, token) => openTunnelDesktop(desktopId, token),
  validateUrl: url => validateControlUrl(url)
};

function deviceIdentity(version: string, translate: Translator) {
  const constants = Platform.constants as Record<string, unknown>;
  const model = String(constants.Model ?? constants.model ?? constants.Brand ?? Platform.OS);
  return {
    name: translate(Platform.OS === 'ios' ? 'mobile.device.iosName' : 'mobile.device.androidName'),
    model,
    platform: Platform.OS === 'android' ? 'android' as const : 'ios' as const,
    app: version
  };
}

function AppContent() {
  const palette = usePalette();
  const { t } = useI18n();
  const [screen, dispatchScreen] = useReducer(transition, { kind: 'loading' } as AppScreen);
  const [store, setStore] = useState<DesktopStore>(emptyDesktopStore);
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | null>(null);
  const [tor, setTor] = useState<TorProgress | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [failures, setFailures] = useState<ReadonlyMap<string, OfflineReason>>(() => new Map());
  const [lockSignal, setLockSignal] = useState(0);
  const [logLevel, setLogLevel] = useState<LogLevel>('info');
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const [biometricSession] = useState(() => new BiometricSession(authenticateWithDevice));
  const [openGate] = useState(() => new RequestGate());
  const screenRef = useRef(screen);
  const storeRef = useRef(store);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const statusRefresh = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });
  const inflight = useRef<{ desktopId: string; promise: Promise<boolean> } | null>(null);
  const nativeReopen = useRef<{ desktopId: string; until: number } | null>(null);
  const backgroundedAt = useRef<number | null>(null);
  const appVersion = getAppVersion();
  const device = deviceIdentity(appVersion, t);
  const nativeCoreVersion = useMemo(() => coreVersion(), []);

  // A referência acompanha cada ação no mesmo instante, para eventos nativos que
  // chegam antes da próxima renderização decidirem com a tela certa.
  const dispatch = useCallback((action: AppAction) => {
    screenRef.current = transition(screenRef.current, action);
    dispatchScreen(action);
  }, []);

  // Toda escrita passa pela referência e por uma fila, para eventos concorrentes
  // não gravarem uma loja antiga por cima de uma mais nova.
  const updateStore = useCallback((update: (current: DesktopStore) => DesktopStore): Promise<void> => {
    const next = update(storeRef.current);
    if (next === storeRef.current) return saveQueue.current;
    storeRef.current = next;
    setStore(next);
    saveQueue.current = saveQueue.current.then(() => saveDesktopStore(next)).catch(() => undefined);
    return saveQueue.current;
  }, []);

  const refreshStatus = useCallback(async () => {
    const refresh = statusRefresh.current;
    if (refresh.running) {
      refresh.again = true;
      return;
    }
    refresh.running = true;
    try {
      do {
        refresh.again = false;
        try {
          const next = await status();
          setTunnelStatus(next);
          const nextTor = parseTorProgress(next.tor);
          if (nextTor) setTor(nextTor);
        } catch {
          setTunnelStatus(null);
        }
      } while (refresh.again);
    } finally {
      refresh.running = false;
    }
  }, []);

  const setFailure = useCallback((desktopId: string, reason: OfflineReason | null) => {
    setFailures(current => {
      if ((current.get(desktopId) ?? null) === reason) return current;
      const next = new Map(current);
      if (reason) next.set(desktopId, reason);
      else next.delete(desktopId);
      return next;
    });
  }, []);

  // Revogação: sem nova tentativa, token apagado e proxy fechado.
  const revoke = useCallback(async (desktopId: string, navigate = true) => {
    setFailure(desktopId, 'removed');
    if (navigate) dispatch({ type: 'desktop-offline', desktopId, reason: 'removed' });
    await closeDesktop(desktopId).catch(() => undefined);
    await deleteDeviceToken(desktopId).catch(() => undefined);
  }, [dispatch, setFailure]);

  const applyOutcome = useCallback(async (outcome: ConnectionOutcome, navigate = true): Promise<boolean> => {
    const { desktopId } = outcome;
    switch (outcome.kind) {
      case 'opened':
        setFailure(desktopId, null);
        void updateStore(current => markDesktopUsed(current, desktopId, outcome.transport));
        if (navigate) {
          dispatch({ type: 'desktop-opened', desktopId, url: outcome.url, transport: outcome.transport, path: outcome.path });
        }
        void refreshStatus();
        return true;
      case 'offline':
        setFailure(desktopId, outcome.reason);
        if (navigate) dispatch({ type: 'desktop-offline', desktopId, reason: outcome.reason });
        return false;
      case 'revoked':
        await revoke(desktopId, navigate);
        return false;
      case 'unpaired': {
        // Sem token ou desconhecido pelo núcleo: o registro local não serve mais.
        const name = findDesktop(storeRef.current, desktopId)?.name ?? t('desktop.fallback');
        await closeDesktop(desktopId).catch(() => undefined);
        await deleteDeviceToken(desktopId).catch(() => undefined);
        await updateStore(current => removeDesktop(current, desktopId));
        setFailure(desktopId, null);
        if (navigate) dispatch({ type: 'needs-pairing', notice: t('mobile.pair.notice.pairAgain', { name }) });
        return false;
      }
    }
  }, [dispatch, refreshStatus, revoke, setFailure, t, updateStore]);

  // Uma tentativa por computador de cada vez; a troca de tela invalida resultados atrasados.
  const openSelected = useCallback((desktopId: string): Promise<boolean> => {
    const running = inflight.current;
    if (running?.desktopId === desktopId) return running.promise;
    const waiting = nativeReopen.current;
    if (waiting?.desktopId === desktopId && waiting.until > Date.now()) return Promise.resolve(false);
    const epoch = openGate.begin();
    const attempt = { desktopId, promise: Promise.resolve(false) };
    setConnectingId(desktopId);
    attempt.promise = (async () => {
      try {
        const outcome = await openConnection(desktopId, connectionPorts);
        // Resultado de uma tentativa abandonada não navega nem apaga token de um novo pareamento.
        if (!openGate.isCurrent(epoch)) return outcome.kind === 'opened';
        return await applyOutcome(outcome);
      } finally {
        if (inflight.current === attempt) inflight.current = null;
        setConnectingId(current => current === desktopId ? null : current);
      }
    })();
    inflight.current = attempt;
    return attempt.promise;
  }, [applyOutcome, openGate]);

  // Antes de reabrir o proxy, que recarrega a página, confere com o núcleo:
  // se o caminho continua ativo e o computador responde a uma sondagem mais
  // longa, a conexão só estava lenta pela reserva e a tela fica como está.
  const reconnectShell = useCallback(async () => {
    const current = screenRef.current;
    if (current.kind !== 'shell') return;
    const { desktopId, url } = current;
    let core: TunnelStatus | null = null;
    try {
      core = await status();
    } catch {
      core = null;
    }
    if (screenRef.current !== current) return;
    if (core?.state === 'connected' && core.active?.desktopId === desktopId) {
      if (await checkControlHealth(url, fetch, HEALTH_RECHECK_TIMEOUT_MS)) return;
      if (screenRef.current !== current) return;
    }
    dispatch({ type: 'desktop-offline', desktopId, reason: 'reconnecting' });
    void openSelected(desktopId);
  }, [dispatch, openSelected]);

  const verifyShell = useCallback(async (desktopId: string, url: string, waitForNative: boolean) => {
    if (await checkControlHealth(url)) return;
    const current = screenRef.current;
    if (current.kind !== 'shell' || current.desktopId !== desktopId) return;
    if (waitForNative) {
      nativeReopen.current = { desktopId, until: Date.now() + NATIVE_REOPEN_WAIT_MS };
      dispatch({ type: 'desktop-offline', desktopId, reason: 'reconnecting' });
      return;
    }
    await reconnectShell();
  }, [dispatch, reconnectShell]);

  const runForegroundAction = useCallback(async (action: ForegroundAction) => {
    if (action.kind === 'verify') await verifyShell(action.desktopId, action.url, false);
    if (action.kind === 'await-native-reopen') await verifyShell(action.desktopId, action.url, true);
    if (action.kind === 'reconnect') await openSelected(action.desktopId);
  }, [openSelected, verifyShell]);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      await hydrateLocale();
      try {
        const storedTheme = await SecureStore.getItemAsync(THEME_STORAGE_KEY);
        if (!cancelled && storedTheme) setThemeMode(normalizeThemeMode(storedTheme));
      } catch {
        // Sem a escolha guardada, a aparência segue o sistema.
      }
      let loaded;
      try {
        loaded = await loadDesktopStore();
      } catch {
        if (!cancelled) dispatch({ type: 'needs-pairing', error: t('mobile.error.storeLoad') });
        return;
      }
      if (cancelled) return;
      storeRef.current = loaded.store;
      setStore(loaded.store);
      void refreshStatus();
      if (!loaded.store.desktops.length) {
        dispatch({ type: 'needs-pairing', ...(loaded.legacyDiscarded ? { notice: t('mobile.pair.notice.legacy') } : {}) });
        return;
      }
      const last = findDesktop(loaded.store, loaded.store.lastDesktopId);
      if (!last) {
        dispatch({ type: 'show-desktops' });
        return;
      }
      dispatch({ type: 'desktop-offline', desktopId: last.id, reason: 'reconnecting' });
      await openSelected(last.id);
    };
    void bootstrap();
    return () => { cancelled = true; };
  }, [dispatch, openSelected, refreshStatus, t]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (biometricSession.handleAppState(nextState)) setLockSignal(value => value + 1);
      const result = handleAppStateTransition({
        nextState,
        backgroundedAt: backgroundedAt.current,
        now: Date.now(),
        platform: Platform.OS === 'android' ? 'android' : 'ios',
        screen: screenRef.current,
        notifyForeground
      });
      backgroundedAt.current = result.backgroundedAt;
      void runForegroundAction(result.action);
    });
    return () => subscription.remove();
  }, [biometricSession, runForegroundAction]);

  useEffect(() => {
    const forward = createNetworkForwarder(notifyNetworkChange);
    return NetInfo.addEventListener(network => {
      const change = forward(network);
      const current = screenRef.current;
      if (change.changed && change.reachable && current.kind === 'offline' && current.reason !== 'removed') {
        void openSelected(current.desktopId);
      }
    });
  }, [openSelected]);

  const handleSignal = useCallback((signal: TunnelSignal) => {
    // Eventos de um computador só trocam a tela quando ele é o que está aberto ou em reconexão.
    const showing = (desktopId: string) => {
      const current = screenRef.current;
      return (current.kind === 'shell' || current.kind === 'offline') && current.desktopId === desktopId;
    };
    switch (signal.type) {
      case 'path': {
        const { desktopId, transport, path } = signal;
        dispatch({ type: 'path-changed', desktopId, transport, path });
        if (transport) void updateStore(current => recordTransport(current, desktopId, transport));
        return;
      }
      case 'status-changed':
        void refreshStatus();
        return;
      case 'tor':
        setTor(signal.tor);
        return;
      case 'token-rotated':
        void saveDeviceToken(signal.desktopId, signal.deviceToken).catch(() => undefined);
        return;
      case 'revoked':
        void revoke(signal.desktopId, showing(signal.desktopId));
        return;
      case 'core-offline':
        void reconnectShell();
        return;
      case 'native-reopening':
        if (!showing(signal.desktopId)) return;
        nativeReopen.current = { desktopId: signal.desktopId, until: Date.now() + NATIVE_REOPEN_WAIT_MS };
        dispatch({ type: 'desktop-offline', desktopId: signal.desktopId, reason: 'reconnecting' });
        return;
      case 'native-reopened': {
        nativeReopen.current = null;
        const { desktopId } = signal;
        if (!showing(desktopId)) return;
        let url: string;
        try {
          url = validateControlUrl(signal.url);
        } catch {
          dispatch({ type: 'desktop-offline', desktopId, reason: 'tunnel' });
          return;
        }
        void (async () => {
          let transport: Transport | null = null;
          let path: PathKind | null = null;
          try {
            const next = await status();
            setTunnelStatus(next);
            if (next.active?.desktopId === desktopId) ({ transport, path } = next.active);
          } catch {
            // O ponto fica neutro até o próximo evento de caminho.
          }
          setFailure(desktopId, null);
          if (showing(desktopId)) dispatch({ type: 'desktop-opened', desktopId, url, transport, path });
        })();
        return;
      }
      case 'native-reopen-failed': {
        const waiting = nativeReopen.current;
        nativeReopen.current = null;
        const current = screenRef.current;
        const desktopId = signal.desktopId ?? waiting?.desktopId ??
          (current.kind === 'offline' || current.kind === 'shell' ? current.desktopId : null);
        if (desktopId) void applyOutcome(outcomeForCode(desktopId, signal.code), showing(desktopId));
        return;
      }
      case 'legacy-discarded':
        if (screenRef.current.kind === 'pair' && !storeRef.current.desktops.length) {
          dispatch({ type: 'needs-pairing', notice: t('mobile.pair.notice.legacy') });
        }
        return;
      case 'pair-stage':
        return;
    }
  }, [applyOutcome, dispatch, reconnectShell, refreshStatus, revoke, setFailure, t, updateStore]);

  useEffect(() => {
    const subscription = addTunnelListener(event => {
      for (const signal of interpretTunnelEvent(event)) handleSignal(signal);
    });
    return () => subscription.remove();
  }, [handleSignal]);

  const paired = useCallback(async (result: PairResult) => {
    // Valida o resultado antes de gravar o token; a gravação usa a loja mais recente.
    recordPair(storeRef.current, result);
    openGate.invalidate();
    inflight.current = null;
    await saveDeviceToken(result.desktopId, result.token);
    await updateStore(current => recordPair(current, result));
    setFailure(result.desktopId, null);
    await openSelected(result.desktopId);
  }, [openGate, openSelected, setFailure, updateStore]);

  const showDesktops = useCallback(async () => {
    biometricSession.lock();
    setLockSignal(value => value + 1);
    openGate.invalidate();
    inflight.current = null;
    const current = screenRef.current;
    if (current.kind === 'shell') await closeDesktop(current.desktopId).catch(() => undefined);
    dispatch({ type: 'show-desktops' });
    void refreshStatus();
  }, [biometricSession, dispatch, openGate, refreshStatus]);

  const retry = useCallback(async () => {
    const current = screenRef.current;
    if (current.kind !== 'offline' || current.reason === 'removed') return false;
    return openSelected(current.desktopId);
  }, [openSelected]);

  const forgetDesktop = useCallback((desktop: DesktopEntry) => {
    Alert.alert(t('mobile.alert.forgetDesktop.title'), t('mobile.alert.forgetDesktop.detail', { name: desktop.name }), [
      { text: t('mobile.common.cancel'), style: 'cancel' },
      { text: t('mobile.common.forget'), style: 'destructive', onPress: () => void (async () => {
        await closeDesktop(desktop.id).catch(() => undefined);
        await forgetTunnelDesktop(desktop.id).catch(() => undefined);
        await deleteDeviceToken(desktop.id).catch(() => undefined);
        await updateStore(current => removeDesktop(current, desktop.id));
        setFailure(desktop.id, null);
        if (!storeRef.current.desktops.length) dispatch({ type: 'needs-pairing' });
      })() }
    ]);
  }, [dispatch, setFailure, t, updateStore]);

  const describe = useCallback((desktopId: string) => describeDesktop(desktopId, { tunnelStatus, connectingId, failures }),
    [connectingId, failures, tunnelStatus]);
  const openFromList = useCallback((desktop: DesktopEntry) => { void openSelected(desktop.id); }, [openSelected]);
  const rename = useCallback((desktopId: string, name: string) => {
    void updateStore(current => renameDesktop(current, desktopId, name));
  }, [updateStore]);
  const changeThemeMode = useCallback((mode: ThemeMode) => {
    const next = normalizeThemeMode(mode);
    setThemeMode(next);
    SecureStore.setItemAsync(THEME_STORAGE_KEY, next).catch(() => undefined);
  }, []);
  const systemScheme = useColorScheme();
  const scheme = resolveScheme(themeMode, systemScheme);
  const connectionLost = useCallback(() => { void reconnectShell(); }, [reconnectShell]);
  const diagnosticsStatus = tunnelStatus && tor ? { ...tunnelStatus, tor } : tunnelStatus;
  const selected = screen.kind === 'shell' || screen.kind === 'offline' ? findDesktop(store, screen.desktopId) : null;
  const desktopList = <Desktops store={store} describe={describe} onForgetDesktop={forgetDesktop} onOpen={openFromList}
    onPair={() => dispatch({ type: 'needs-pairing' })} onRename={rename} onSettings={() => dispatch({ type: 'show-settings' })} />;

  let content;
  if (screen.kind === 'loading') {
    content = <View style={[styles.loading, { backgroundColor: palette.background }]}><ActivityIndicator color={palette.accent} size="large" /></View>;
  } else if (screen.kind === 'pair') {
    content = <Pair device={device} initialError={screen.error} notice={screen.notice} onPaired={paired}
      onCancel={store.desktops.length ? () => dispatch({ type: 'show-desktops' }) : undefined} />;
  } else if (screen.kind === 'settings') {
    content = <Settings appVersion={appVersion} coreVersion={nativeCoreVersion} desktopCount={store.desktops.length}
      logLevel={logLevel} onBack={() => dispatch({ type: 'show-desktops' })}
      onLogLevel={level => { setLogLevel(level); setNativeLogLevel(level); }}
      onRefreshStatus={() => void refreshStatus()} onThemeMode={changeThemeMode} themeMode={themeMode} tunnelStatus={diagnosticsStatus} />;
  } else if (screen.kind === 'desktops') {
    content = desktopList;
  } else if (screen.kind === 'offline') {
    content = <Offline onDesktops={() => void showDesktops()} onPairAgain={() => dispatch({ type: 'needs-pairing' })}
      onRetry={retry} reason={screen.reason} reserveProgress={reservePercent(tor)} />;
  } else {
    content = selected ? <Shell biometricSession={biometricSession} desktopId={screen.desktopId}
      desktopName={selected.name} lockSignal={lockSignal} onConnectionLost={connectionLost}
      onDesktops={() => void showDesktops()} transport={screen.transport} url={screen.url} version={appVersion} />
      : desktopList;
  }

  return <ThemeModeContext.Provider value={themeMode}><StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />{content}</ThemeModeContext.Provider>;
}

export default function App() {
  return <SafeAreaProvider><AppContent /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' }
});
