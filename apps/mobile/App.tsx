import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Platform, StyleSheet, Text, useColorScheme, View } from 'react-native';
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
  notifyHealthy,
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

import { authenticateWithDevice, BIOMETRIC_STORAGE_KEY, BiometricSession, normalizeBiometricPolicy, type BiometricPolicy } from './src/auth/biometrics';
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
import { Home } from './src/screens/Home';
import { Offline } from './src/screens/Offline';
import { Pair } from './src/screens/Pair';
import { Settings } from './src/screens/Settings';
import { Shell } from './src/screens/Shell';
import { openConnection, outcomeForCode, type ConnectionOutcome, type ConnectionPorts } from './src/state/connection';
import { logApp, logCore } from './src/state/diagnostics';
import { createNetworkForwarder, handleAppStateTransition, type ForegroundAction } from './src/state/lifecycle';
import { describeDesktop, transition, type AppAction, type AppScreen, type OfflineReason } from './src/state/machine';
import { interpretTunnelEvent, parseTorProgress, reservePercent, type TunnelSignal } from './src/state/tunnel-events';
import { normalizeThemeMode, resolveScheme, THEME_STORAGE_KEY, ThemeModeContext, usePalette, type ThemeMode } from './src/theme';

type Translator = (key: string, values?: Record<string, string | number>) => string;

// Prazo para o nativo Android reabrir o proxy depois da parada em segundo plano,
// coberto o orçamento de 20 s da reserva; passado ele, o app reconecta sozinho.
const NATIVE_REOPEN_WAIT_MS = 30_000;

// Tempo que a página fica montada com a faixa de reconexão enquanto o caminho
// volta. Antes disso a tela só vira sem conexão quando o núcleo confirma que não
// há caminho; depois, a próxima falha ou o próprio prazo levam à tela sem conexão.
export const SHELL_RECONNECT_DEADLINE_MS = 45_000;

// Tempo que o proxy fica aberto depois de ir ao início. Voltar ao terminal dentro
// dele reaproveita a mesma URL; sem volta, o proxy fecha sozinho.
export const HOME_PROXY_GRACE_MS = 90_000;

// Marca gravada quando a última conexão falhou: a próxima abertura do app começa
// no início em vez de tentar o último computador de novo.
/// Marca de uma versão anterior, quando a abertura escolhia entre o início e o
/// terminal. O app abre sempre no início, então ela deixou de ter função e é
/// apagada do Secure Store uma vez.
const LEGACY_LAST_CONNECTION_FAILED_KEY = 'cialai.lastConnectionFailed';

const connectionPorts: ConnectionPorts = {
  readToken: desktopId => readDeviceToken(desktopId),
  connect,
  openDesktop: (desktopId, token, preferredPort) => openTunnelDesktop(desktopId, token, preferredPort),
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

type ShellReconnect = { desktopId: string; since: number; timer: ReturnType<typeof setTimeout> };
type KeptShell = { desktopId: string; timer: ReturnType<typeof setTimeout> };

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
  const [biometricPolicy, setBiometricPolicy] = useState<BiometricPolicy>('always');
  const [biometricSession] = useState(() => new BiometricSession(authenticateWithDevice));
  const [openGate] = useState(() => new RequestGate());
  const screenRef = useRef(screen);
  const storeRef = useRef(store);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const statusRefresh = useRef<{ running: boolean; again: boolean }>({ running: false, again: false });
  const inflight = useRef<{ desktopId: string; promise: Promise<boolean> } | null>(null);
  const nativeReopen = useRef<{ desktopId: string; until: number } | null>(null);
  const shellReconnect = useRef<ShellReconnect | null>(null);
  const keptShell = useRef<KeptShell | null>(null);
  const [keptDesktopId, setKeptDesktopId] = useState<string | null>(null);
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

  const showingShell = useCallback((desktopId: string) => {
    const current = screenRef.current;
    return current.kind === 'shell' && current.desktopId === desktopId;
  }, []);

  const endShellReconnect = useCallback(() => {
    const episode = shellReconnect.current;
    if (!episode) return;
    clearTimeout(episode.timer);
    shellReconnect.current = null;
  }, []);

  // Solta o proxy guardado ao sair do terminal sem fechá-lo e devolve o computador
  // dele, para quem chama decidir se ele continua como página aberta ou fecha.
  const releaseKeptShell = useCallback((): string | null => {
    const kept = keptShell.current;
    if (!kept) return null;
    clearTimeout(kept.timer);
    keptShell.current = null;
    setKeptDesktopId(null);
    return kept.desktopId;
  }, []);

  // Esquece o proxy guardado desse computador quando ele já vai fechar por outro motivo.
  const dropKeptShell = useCallback((desktopId: string) => {
    if (keptShell.current?.desktopId === desktopId) releaseKeptShell();
  }, [releaseKeptShell]);

  // Ir ao início não derruba a conexão: o proxy fica aberto por HOME_PROXY_GRACE_MS
  // para a volta ao terminal reaproveitar a mesma URL. Sem volta, ele fecha sozinho.
  const keepShell = useCallback((desktopId: string) => {
    const previous = releaseKeptShell();
    if (previous && previous !== desktopId) void closeDesktop(previous).catch(() => undefined);
    const timer = setTimeout(() => {
      if (keptShell.current?.desktopId !== desktopId) return;
      keptShell.current = null;
      setKeptDesktopId(null);
      logApp('info', `proxy closed ${HOME_PROXY_GRACE_MS} ms after leaving the terminal`);
      void closeDesktop(desktopId).catch(() => undefined).then(() => refreshStatus());
    }, HOME_PROXY_GRACE_MS);
    keptShell.current = { desktopId, timer };
    setKeptDesktopId(desktopId);
    logApp('info', `proxy kept for ${HOME_PROXY_GRACE_MS} ms while on the home`);
  }, [refreshStatus, releaseKeptShell]);

  // Tela sem conexão com o motivo registrado no anel, para a causa ser lida no aparelho.
  const goOffline = useCallback((desktopId: string, reason: OfflineReason, cause: string) => {
    logApp('info', `offline ${reason}: ${cause}`);
    endShellReconnect();
    dispatch({ type: 'desktop-offline', desktopId, reason });
  }, [dispatch, endShellReconnect]);

  // Marca a faixa de reconexão sem desmontar a página. O prazo garante que a
  // faixa não fica para sempre: vencido, a tela vira sem conexão e a escada de
  // tentativas da tela assume.
  const beginShellReconnect = useCallback((desktopId: string, cause: string) => {
    const current = screenRef.current;
    if (current.kind !== 'shell' || current.desktopId !== desktopId) return;
    if (shellReconnect.current?.desktopId !== desktopId) {
      endShellReconnect();
      const timer = setTimeout(() => {
        shellReconnect.current = null;
        const late = screenRef.current;
        if (late.kind !== 'shell' || late.desktopId !== desktopId || !late.reconnecting) return;
        goOffline(desktopId, 'reconnecting', `reconnect deadline of ${SHELL_RECONNECT_DEADLINE_MS} ms passed`);
      }, SHELL_RECONNECT_DEADLINE_MS);
      shellReconnect.current = { desktopId, since: Date.now(), timer };
    }
    if (!current.reconnecting) logApp('info', `shell reconnecting: ${cause}`);
    dispatch({ type: 'shell-reconnecting', desktopId });
  }, [dispatch, endShellReconnect, goOffline]);

  // Enquanto a faixa está ativa e dentro do prazo, uma falha ao reabrir não troca
  // de tela: a página fica e a próxima sondagem tenta de novo.
  const keepsShell = useCallback((desktopId: string) => {
    const current = screenRef.current;
    return shellReconnect.current?.desktopId === desktopId && current.kind === 'shell' &&
      current.desktopId === desktopId && current.reconnecting;
  }, []);

  // Revogação: sem nova tentativa, token apagado e proxy fechado.
  const revoke = useCallback(async (desktopId: string, navigate = true) => {
    setFailure(desktopId, 'removed');
    dropKeptShell(desktopId);
    if (navigate) goOffline(desktopId, 'removed', 'the computer revoked this phone');
    await closeDesktop(desktopId).catch(() => undefined);
    await deleteDeviceToken(desktopId).catch(() => undefined);
  }, [dropKeptShell, goOffline, setFailure]);

  const applyOutcome = useCallback(async (outcome: ConnectionOutcome, navigate = true): Promise<boolean> => {
    const { desktopId } = outcome;
    switch (outcome.kind) {
      case 'opened': {
        setFailure(desktopId, null);
        endShellReconnect();
        // O mesmo computador retoma o proxy guardado; outro computador o fecha.
        const kept = releaseKeptShell();
        if (kept && kept !== desktopId) void closeDesktop(kept).catch(() => undefined);
        logApp('info', outcome.reused ? `proxy reused over ${outcome.path}; page kept` : `proxy opened over ${outcome.path}`);
        void updateStore(current => markDesktopUsed(current, desktopId, outcome.transport));
        if (navigate) {
          dispatch({ type: 'desktop-opened', desktopId, url: outcome.url, transport: outcome.transport, path: outcome.path });
        }
        void refreshStatus();
        return true;
      }
      case 'offline':
        setFailure(desktopId, outcome.reason);
        if (!navigate) return false;
        if (keepsShell(desktopId)) {
          logApp('info', `open failed with ${outcome.reason}; page kept within the reconnect deadline`);
          return false;
        }
        goOffline(desktopId, outcome.reason, 'connect or open failed');
        return false;
      case 'revoked':
        await revoke(desktopId, navigate);
        return false;
      case 'unpaired': {
        // Sem token ou desconhecido pelo núcleo: o registro local não serve mais.
        const name = findDesktop(storeRef.current, desktopId)?.name ?? t('desktop.fallback');
        dropKeptShell(desktopId);
        await closeDesktop(desktopId).catch(() => undefined);
        await deleteDeviceToken(desktopId).catch(() => undefined);
        await updateStore(current => removeDesktop(current, desktopId));
        setFailure(desktopId, null);
        endShellReconnect();
        if (navigate) dispatch({ type: 'needs-pairing', notice: t('mobile.pair.notice.pairAgain', { name }) });
        return false;
      }
    }
  }, [dispatch, dropKeptShell, endShellReconnect, goOffline, keepsShell, refreshStatus, releaseKeptShell, revoke, setFailure, t, updateStore]);

  // Uma tentativa por computador de cada vez; a troca de tela invalida resultados atrasados.
  // Com a página desse computador aberta, pede o mesmo proxy para ela não recarregar.
  const openSelected = useCallback((desktopId: string): Promise<boolean> => {
    const running = inflight.current;
    if (running?.desktopId === desktopId) return running.promise;
    const waiting = nativeReopen.current;
    if (waiting?.desktopId === desktopId && waiting.until > Date.now()) return Promise.resolve(false);
    const epoch = openGate.begin();
    const current = screenRef.current;
    const currentUrl = current.kind === 'shell' && current.desktopId === desktopId ? current.url : null;
    const attempt = { desktopId, promise: Promise.resolve(false) };
    setConnectingId(desktopId);
    attempt.promise = (async () => {
      try {
        const outcome = await openConnection(desktopId, connectionPorts, currentUrl);
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

  // Perda de saúde com a página aberta: a faixa entra e a página fica. Confere com
  // o núcleo: sem caminho confirmado, tela sem conexão; caminho ativo e o computador
  // respondendo a uma sondagem mais longa, a conexão só estava lenta pela reserva;
  // senão, reabre o proxy, que volta igual quando segue aberto.
  const reconnectShell = useCallback(async (cause: string) => {
    const current = screenRef.current;
    if (current.kind !== 'shell') return;
    const { desktopId, url } = current;
    beginShellReconnect(desktopId, cause);
    let core: TunnelStatus | null = null;
    try {
      core = await status();
    } catch {
      core = null;
    }
    if (!showingShell(desktopId)) return;
    if (core?.state === 'offline') {
      goOffline(desktopId, 'reconnecting', 'the core reports no path');
      void openSelected(desktopId);
      return;
    }
    if (core?.state === 'connected' && core.active?.desktopId === desktopId) {
      if (await checkControlHealth(url, fetch, HEALTH_RECHECK_TIMEOUT_MS)) {
        endShellReconnect();
        logApp('info', 'shell recovered: the longer probe answered');
        dispatch({ type: 'shell-recovered', desktopId });
        return;
      }
      if (!showingShell(desktopId)) return;
    }
    void openSelected(desktopId);
  }, [beginShellReconnect, dispatch, endShellReconnect, goOffline, openSelected, showingShell]);

  const verifyShell = useCallback(async (desktopId: string, url: string, waitForNative: boolean) => {
    if (await checkControlHealth(url)) {
      // O proxy sobreviveu à suspensão: o nativo não precisa recomeçar do zero na próxima conexão.
      notifyHealthy();
      if (showingShell(desktopId)) {
        endShellReconnect();
        dispatch({ type: 'shell-recovered', desktopId });
      }
      return;
    }
    if (!showingShell(desktopId)) return;
    if (waitForNative) {
      nativeReopen.current = { desktopId, until: Date.now() + NATIVE_REOPEN_WAIT_MS };
      beginShellReconnect(desktopId, 'proxy silent after the Android background stop');
      return;
    }
    await reconnectShell('proxy silent after returning to the foreground');
  }, [beginShellReconnect, dispatch, endShellReconnect, reconnectShell, showingShell]);

  const runForegroundAction = useCallback(async (action: ForegroundAction) => {
    if (action.kind === 'verify') await verifyShell(action.desktopId, action.url, false);
    if (action.kind === 'await-native-reopen') await verifyShell(action.desktopId, action.url, true);
    if (action.kind === 'reconnect') await openSelected(action.desktopId);
  }, [openSelected, verifyShell]);

  useEffect(() => () => {
    endShellReconnect();
    if (keptShell.current) clearTimeout(keptShell.current.timer);
  }, [endShellReconnect]);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      await hydrateLocale();
      // Limpeza única da marca que a abertura antiga usava.
      SecureStore.deleteItemAsync(LEGACY_LAST_CONNECTION_FAILED_KEY).catch(() => undefined);
      try {
        const storedTheme = await SecureStore.getItemAsync(THEME_STORAGE_KEY);
        if (!cancelled && storedTheme) setThemeMode(normalizeThemeMode(storedTheme));
      } catch {
        // Sem a escolha guardada, a aparência segue o sistema.
      }
      try {
        const storedPolicy = await SecureStore.getItemAsync(BIOMETRIC_STORAGE_KEY);
        if (!cancelled && storedPolicy) {
          const policy = normalizeBiometricPolicy(storedPolicy);
          biometricSession.setPolicy(policy);
          setBiometricPolicy(policy);
        }
      } catch {
        // Sem a escolha guardada, a biometria é pedida sempre.
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
      // O app abre sempre no início, mesmo com o último computador respondendo.
      // O início é o hub: de lá o card Continuar leva ao terminal num toque, e
      // Computadores, Vincular e Ajustes ficam à mão sem passar pelo terminal.
      dispatch({ type: 'show-home' });
    };
    void bootstrap();
    return () => { cancelled = true; };
  }, [biometricSession, dispatch, openSelected, refreshStatus, t]);

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
    const unsubscribe = NetInfo.addEventListener(network => {
      const change = forward(network);
      const current = screenRef.current;
      if (change.changed && change.reachable && current.kind === 'offline' && current.reason !== 'removed') {
        void openSelected(current.desktopId);
      }
    });
    return () => {
      forward.cancel();
      unsubscribe();
    };
  }, [openSelected]);

  const handleSignal = useCallback((signal: TunnelSignal) => {
    // Eventos de um computador só trocam a tela quando ele é o que está aberto ou em reconexão.
    const showing = (desktopId: string) => {
      const current = screenRef.current;
      return (current.kind === 'shell' || current.kind === 'offline') && current.desktopId === desktopId;
    };
    // Na tela sem conexão, o que o núcleo anuncia vale mais que o próximo intervalo da escada.
    const retryOffline = (desktopId: string | null, when: (reason: OfflineReason) => boolean) => {
      const current = screenRef.current;
      if (current.kind !== 'offline' || current.reason === 'removed') return;
      if (desktopId && current.desktopId !== desktopId) return;
      if (when(current.reason)) void openSelected(current.desktopId);
    };
    switch (signal.type) {
      case 'path': {
        const { desktopId, transport, path } = signal;
        dispatch({ type: 'path-changed', desktopId, transport, path });
        if (transport) void updateStore(current => recordTransport(current, desktopId, transport));
        if (transport) retryOffline(desktopId, () => true);
        return;
      }
      case 'status-changed':
        void refreshStatus();
        return;
      case 'tor':
        setTor(signal.tor);
        if (signal.tor.state === 'ready') retryOffline(null, reason => reason === 'reserve-preparing');
        return;
      case 'token-rotated':
        void saveDeviceToken(signal.desktopId, signal.deviceToken).catch(() => undefined);
        return;
      case 'revoked':
        void revoke(signal.desktopId, showing(signal.desktopId));
        return;
      case 'core-offline':
        void reconnectShell('the core reported offline');
        return;
      case 'native-reopening': {
        const { desktopId } = signal;
        if (!showing(desktopId)) return;
        nativeReopen.current = { desktopId, until: Date.now() + NATIVE_REOPEN_WAIT_MS };
        if (showingShell(desktopId)) beginShellReconnect(desktopId, 'the Android core stopped in the background and is reopening');
        else dispatch({ type: 'desktop-offline', desktopId, reason: 'reconnecting' });
        return;
      }
      case 'native-reopened': {
        nativeReopen.current = null;
        const { desktopId } = signal;
        if (!showing(desktopId)) return;
        let url: string;
        try {
          url = validateControlUrl(signal.url);
        } catch {
          goOffline(desktopId, 'tunnel', 'the Android core reopened on an address outside the loopback policy');
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
          endShellReconnect();
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
        // O nativo desistiu: a tela sem conexão assume sem esperar o prazo da faixa.
        endShellReconnect();
        if (desktopId) void applyOutcome(outcomeForCode(desktopId, signal.code), showing(desktopId));
        return;
      }
      case 'legacy-discarded':
        if (screenRef.current.kind === 'pair' && !storeRef.current.desktops.length) {
          dispatch({ type: 'needs-pairing', notice: t('mobile.pair.notice.legacy') });
        }
        return;
      case 'log':
        logCore(signal.level, signal.message);
        return;
      case 'pair-stage':
        return;
    }
  }, [applyOutcome, beginShellReconnect, dispatch, endShellReconnect, goOffline, openSelected, reconnectShell, refreshStatus, revoke, setFailure, showingShell, t, updateStore]);

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

  // Sai da página do computador para uma tela da casca. A página some, o proxy
  // fica guardado por um prazo e um resultado atrasado de conexão não navega.
  const leaveTo = useCallback((action: AppAction) => {
    biometricSession.lock();
    setLockSignal(value => value + 1);
    openGate.invalidate();
    inflight.current = null;
    endShellReconnect();
    const current = screenRef.current;
    if (current.kind === 'shell') keepShell(current.desktopId);
    dispatch(action);
    void refreshStatus();
  }, [biometricSession, dispatch, endShellReconnect, keepShell, openGate, refreshStatus]);
  const showHome = useCallback(() => leaveTo({ type: 'show-home' }), [leaveTo]);

  // Desconectar de propósito fecha o proxy guardado em vez de esperar o prazo.
  const disconnect = useCallback(() => {
    const kept = releaseKeptShell();
    if (!kept) return;
    logApp('info', 'proxy closed from the home');
    void closeDesktop(kept).catch(() => undefined).then(() => refreshStatus());
  }, [refreshStatus, releaseKeptShell]);

  // O card Terminal volta ao último computador; sem um, a lista escolhe.
  const openTerminal = useCallback(() => {
    const last = findDesktop(storeRef.current, storeRef.current.lastDesktopId);
    if (last) void openSelected(last.id);
    else dispatch({ type: 'show-desktops' });
  }, [dispatch, openSelected]);

  const retry = useCallback(async () => {
    const current = screenRef.current;
    if (current.kind !== 'offline' || current.reason === 'removed') return false;
    return openSelected(current.desktopId);
  }, [openSelected]);

  const forgetDesktop = useCallback((desktop: DesktopEntry) => {
    Alert.alert(t('mobile.alert.forgetDesktop.title'), t('mobile.alert.forgetDesktop.detail', { name: desktop.name }), [
      { text: t('mobile.common.cancel'), style: 'cancel' },
      { text: t('mobile.common.forget'), style: 'destructive', onPress: () => void (async () => {
        dropKeptShell(desktop.id);
        await closeDesktop(desktop.id).catch(() => undefined);
        await forgetTunnelDesktop(desktop.id).catch(() => undefined);
        await deleteDeviceToken(desktop.id).catch(() => undefined);
        await updateStore(current => removeDesktop(current, desktop.id));
        setFailure(desktop.id, null);
        if (!storeRef.current.desktops.length) dispatch({ type: 'needs-pairing' });
      })() }
    ]);
  }, [dispatch, dropKeptShell, setFailure, t, updateStore]);

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
  const changeBiometricPolicy = useCallback((policy: BiometricPolicy) => {
    const next = normalizeBiometricPolicy(policy);
    biometricSession.setPolicy(next);
    setBiometricPolicy(next);
    SecureStore.setItemAsync(BIOMETRIC_STORAGE_KEY, next).catch(() => undefined);
  }, [biometricSession]);
  const systemScheme = useColorScheme();
  const scheme = resolveScheme(themeMode, systemScheme);
  const connectionLost = useCallback(() => { void reconnectShell('two health probes in a row failed'); }, [reconnectShell]);
  // Uma sondagem boa com a faixa ativa devolve a página ao normal sem mexer no WebView.
  const connectionRestored = useCallback(() => {
    const current = screenRef.current;
    if (current.kind !== 'shell' || !current.reconnecting) return;
    endShellReconnect();
    logApp('info', 'shell recovered: the health probe answered');
    dispatch({ type: 'shell-recovered', desktopId: current.desktopId });
  }, [dispatch, endShellReconnect]);
  const diagnosticsStatus = tunnelStatus && tor ? { ...tunnelStatus, tor } : tunnelStatus;
  const selected = screen.kind === 'shell' || screen.kind === 'offline' ? findDesktop(store, screen.desktopId) : null;
  const desktopList = <Desktops store={store} describe={describe} onForgetDesktop={forgetDesktop} onHome={() => dispatch({ type: 'show-home' })}
    onOpen={openFromList} onPair={() => dispatch({ type: 'needs-pairing' })} onRename={rename} onSettings={() => dispatch({ type: 'show-settings' })} />;

  let content;
  if (screen.kind === 'loading') {
    content = (
      <View style={[styles.loading, { backgroundColor: palette.background }]}>
        <Text style={[styles.loadingName, { color: palette.label }]}>Cialai</Text>
        <ActivityIndicator color={palette.accent} size="large" />
        <Text style={[styles.loadingDetail, { color: palette.secondaryLabel }]}>{t('mobile.loading.detail')}</Text>
      </View>
    );
  } else if (screen.kind === 'pair') {
    content = <Pair device={device} initialError={screen.error} notice={screen.notice} onPaired={paired}
      onCancel={store.desktops.length ? () => dispatch({ type: 'show-home' }) : undefined} />;
  } else if (screen.kind === 'home') {
    content = <Home store={store} describe={describe} keptDesktopId={keptDesktopId} onContinue={openFromList}
      onDesktops={() => dispatch({ type: 'show-desktops' })} onDisconnect={disconnect} onPair={() => dispatch({ type: 'needs-pairing' })}
      onSettings={() => dispatch({ type: 'show-settings' })} onTerminal={openTerminal} />;
  } else if (screen.kind === 'settings') {
    content = <Settings appVersion={appVersion} coreVersion={nativeCoreVersion} desktopCount={store.desktops.length}
      biometricPolicy={biometricPolicy} logLevel={logLevel} onBack={() => dispatch({ type: 'show-home' })} onBiometricPolicy={changeBiometricPolicy}
      onLogLevel={level => { setLogLevel(level); setNativeLogLevel(level); }}
      onRefreshStatus={() => void refreshStatus()} onThemeMode={changeThemeMode} themeMode={themeMode} tunnelStatus={diagnosticsStatus} />;
  } else if (screen.kind === 'desktops') {
    content = desktopList;
  } else if (screen.kind === 'offline') {
    content = <Offline desktopId={screen.desktopId} onDesktops={() => leaveTo({ type: 'show-desktops' })} onHome={showHome}
      onPair={() => leaveTo({ type: 'needs-pairing' })} onPairAgain={() => dispatch({ type: 'needs-pairing' })} onRetry={retry}
      onSettings={() => leaveTo({ type: 'show-settings' })} reason={screen.reason} reserveProgress={reservePercent(tor)} />;
  } else {
    content = selected ? <Shell biometricSession={biometricSession} desktopId={screen.desktopId}
      desktopName={selected.name} lockSignal={lockSignal} onConnectionLost={connectionLost} onConnectionRestored={connectionRestored}
      onHome={showHome} reconnecting={screen.reconnecting} transport={screen.transport} url={screen.url} version={appVersion} />
      : desktopList;
  }

  return <ThemeModeContext.Provider value={themeMode}><StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />{content}</ThemeModeContext.Provider>;
}

export default function App() {
  return <SafeAreaProvider><AppContent /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16 },
  loadingName: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: 0.4 },
  loadingDetail: { fontSize: 15, lineHeight: 20 }
});
