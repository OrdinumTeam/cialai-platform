import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Platform, StyleSheet, View } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';

import {
  addListener as addTunnelListener,
  closeDesktop,
  forgetProfile,
  notifyForeground,
  notifyNetworkChange,
  openDesktop as openTunnelDesktop,
  setLogLevel as setNativeLogLevel,
  startProfile,
  status,
  version as coreVersion,
  type PairInspection,
  type PairResult,
  type TunnelStatus
} from 'cialai-tunnel';

import { authenticateWithDevice, BiometricSession } from './src/auth/biometrics';
import { getAppVersion } from './src/config/env';
import { validateControlUrl } from './src/config/url';
import { hydrateLocale, useI18n } from './src/i18n';
import { checkControlHealth } from './src/network/health';
import {
  deleteDeviceToken,
  emptyProfileStore,
  loadProfileStore,
  markDesktopUsed,
  readDeviceToken,
  recordPair,
  removeDesktop,
  removeProfile,
  renameDesktop,
  saveDeviceToken,
  saveProfileStore,
  type DesktopProfile,
  type HeadscaleProfile,
  type ProfileStore
} from './src/profiles/store';
import { Desktops } from './src/screens/Desktops';
import { Offline } from './src/screens/Offline';
import { Pair } from './src/screens/Pair';
import { Settings } from './src/screens/Settings';
import { Shell } from './src/screens/Shell';
import { transition, type AppScreen, type OfflineReason } from './src/state/machine';
import { handleAppStateTransition, notifyNetworkTransition } from './src/state/lifecycle';
import { usePalette } from './src/theme';

type LogLevel = 'error' | 'info' | 'debug';
type Translator = (key: string, values?: Record<string, string | number>) => string;

function findDesktop(store: ProfileStore, desktopId: string) {
  for (const profile of store.profiles) {
    const desktop = profile.desktops.find(candidate => candidate.id === desktopId);
    if (desktop) return { profile, desktop };
  }
  return null;
}

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
  const [screen, dispatch] = useReducer(transition, { kind: 'loading' } as AppScreen);
  const [profiles, setProfiles] = useState<ProfileStore>(emptyProfileStore);
  const [tunnelStatus, setTunnelStatus] = useState<TunnelStatus | null>(null);
  const [lockSignal, setLockSignal] = useState(0);
  const [logLevel, setLogLevel] = useState<LogLevel>('info');
  const backgroundedAt = useRef<number | null>(null);
  const [biometricSession] = useState(() => new BiometricSession(authenticateWithDevice));
  const appVersion = getAppVersion();
  const device = deviceIdentity(appVersion, t);

  const refreshStatus = useCallback(async () => {
    try {
      setTunnelStatus(await status());
    } catch {
      setTunnelStatus(null);
    }
  }, []);

  const persist = useCallback(async (next: ProfileStore) => {
    setProfiles(next);
    await saveProfileStore(next);
  }, []);

  const openDesktop = useCallback(async (
    profile: HeadscaleProfile,
    desktop: DesktopProfile,
    reason: OfflineReason = 'desktop'
  ): Promise<boolean> => {
    try {
      if (profiles.lastProfileId !== profile.id) await startProfile(profile.id);
      const token = await readDeviceToken(desktop.id);
      if (!token) throw new Error('device_token_missing');
      const opened = await openTunnelDesktop(desktop.id, token);
      const localUrl = validateControlUrl(opened.url);
      const next = markDesktopUsed(profiles, profile.id, desktop.id);
      await persist(next);
      await refreshStatus();
      const healthy = await checkControlHealth(localUrl);
      dispatch(healthy
        ? { type: 'desktop-opened', desktopId: desktop.id, url: localUrl }
        : { type: 'desktop-offline', desktopId: desktop.id, reason });
      return healthy;
    } catch {
      dispatch({ type: 'desktop-offline', desktopId: desktop.id, reason });
      return false;
    }
  }, [persist, profiles, refreshStatus]);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        await hydrateLocale();
        const stored = await loadProfileStore();
        if (cancelled) return;
        setProfiles(stored);
        if (!stored.profiles.length) {
          dispatch({ type: 'needs-pairing' });
          return;
        }
        const profile = stored.profiles.find(candidate => candidate.id === stored.lastProfileId) ?? stored.profiles[0]!;
        await startProfile(profile.id);
        if (cancelled) return;
        const desktop = profile.desktops.find(candidate => candidate.id === stored.lastDesktopId) ?? profile.desktops[0];
        if (!desktop) {
          dispatch({ type: 'show-desktops' });
          return;
        }
        const token = await readDeviceToken(desktop.id);
        if (!token) {
          dispatch({ type: 'show-desktops' });
          return;
        }
        const opened = await openTunnelDesktop(desktop.id, token);
        const localUrl = validateControlUrl(opened.url);
        const healthy = await checkControlHealth(localUrl);
        if (!cancelled) {
          await refreshStatus();
          dispatch(healthy
            ? { type: 'desktop-opened', desktopId: desktop.id, url: localUrl }
            : { type: 'desktop-offline', desktopId: desktop.id, reason: 'desktop' });
        }
      } catch {
        if (!cancelled) dispatch({
          type: 'needs-pairing',
          error: t('mobile.error.profileLoad')
        });
      }
    };
    void bootstrap();
    return () => { cancelled = true; };
  }, [refreshStatus, t]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', nextState => {
      if (biometricSession.handleAppState(nextState)) setLockSignal(value => value + 1);
      backgroundedAt.current = handleAppStateTransition({
        nextState,
        backgroundedAt: backgroundedAt.current,
        now: Date.now(),
        platform: Platform.OS === 'android' ? 'android' : 'ios',
        screen,
        notifyForeground,
        checkHealth: checkControlHealth,
        markOffline: (desktopId, reason) => dispatch({ type: 'desktop-offline', desktopId, reason }),
        reconnect: desktopId => dispatch({ type: 'desktop-offline', desktopId, reason: 'reconnecting' })
      });
    });
    return () => subscription.remove();
  }, [biometricSession, screen]);

  useEffect(() => NetInfo.addEventListener(network => {
    notifyNetworkTransition(network, notifyNetworkChange);
  }), []);

  useEffect(() => {
    const subscription = addTunnelListener(event => {
      if (event.kind === 'state' || event.kind === 'peer') void refreshStatus();
      if (typeof event.payload === 'object' && event.payload !== null) {
        const payload = event.payload as { state?: unknown; desktopId?: unknown; deviceToken?: unknown; url?: unknown };
        if (typeof payload.desktopId === 'string' && typeof payload.deviceToken === 'string') {
          void saveDeviceToken(payload.desktopId, payload.deviceToken);
        }
        if (event.kind === 'state' && payload.state === 'reconnecting' && typeof payload.desktopId === 'string') {
          dispatch({ type: 'desktop-offline', desktopId: payload.desktopId, reason: 'reconnecting' });
        }
        if (event.kind === 'proxy' && payload.state === 'reopened' && typeof payload.desktopId === 'string' && typeof payload.url === 'string') {
          void (async () => {
            try {
              const localUrl = validateControlUrl(payload.url as string);
              const healthy = await checkControlHealth(localUrl);
              await refreshStatus();
              dispatch(healthy
                ? { type: 'desktop-opened', desktopId: payload.desktopId as string, url: localUrl }
                : { type: 'desktop-offline', desktopId: payload.desktopId as string, reason: 'reconnecting' });
            } catch {
              dispatch({ type: 'desktop-offline', desktopId: payload.desktopId as string, reason: 'reconnecting' });
            }
          })();
        }
      }
    });
    return () => subscription.remove();
  }, [refreshStatus]);

  const paired = useCallback(async (inspection: PairInspection, result: PairResult) => {
    await saveDeviceToken(result.desktopId, result.token);
    const next = recordPair(profiles, inspection, result);
    await persist(next);
    const opened = await openTunnelDesktop(result.desktopId, result.token);
    const localUrl = validateControlUrl(opened.url);
    await refreshStatus();
    dispatch(await checkControlHealth(localUrl)
      ? { type: 'desktop-opened', desktopId: result.desktopId, url: localUrl }
      : { type: 'desktop-offline', desktopId: result.desktopId, reason: 'desktop' });
  }, [persist, profiles, refreshStatus]);

  const showDesktops = useCallback(async () => {
    biometricSession.lock();
    setLockSignal(value => value + 1);
    if (screen.kind === 'shell') await closeDesktop(screen.desktopId).catch(() => undefined);
    dispatch({ type: 'show-desktops' });
  }, [biometricSession, screen]);

  const retry = useCallback(async () => {
    if (screen.kind !== 'offline') return false;
    const located = findDesktop(profiles, screen.desktopId);
    return located ? openDesktop(located.profile, located.desktop, 'reconnecting') : false;
  }, [openDesktop, profiles, screen]);

  const forgetDesktop = useCallback((profile: HeadscaleProfile, desktop: DesktopProfile) => {
    Alert.alert(t('mobile.alert.forgetDesktop.title'), t('mobile.alert.forgetDesktop.detail', { name: desktop.name }), [
      { text: t('mobile.common.cancel'), style: 'cancel' },
      { text: t('mobile.common.forget'), style: 'destructive', onPress: () => void (async () => {
        await closeDesktop(desktop.id).catch(() => undefined);
        await deleteDeviceToken(desktop.id);
        await persist(removeDesktop(profiles, profile.id, desktop.id));
      })() }
    ]);
  }, [persist, profiles, t]);

  const forgetStoredProfile = useCallback((profileId: string) => {
    const profile = profiles.profiles.find(candidate => candidate.id === profileId);
    if (!profile) return;
    Alert.alert(t('mobile.alert.forgetProfile.title'), t('mobile.alert.forgetProfile.detail', { name: profile.userName }), [
      { text: t('mobile.common.cancel'), style: 'cancel' },
      { text: t('mobile.common.forget'), style: 'destructive', onPress: () => void (async () => {
        for (const desktop of profile.desktops) await deleteDeviceToken(desktop.id);
        await forgetProfile(profile.id);
        const next = removeProfile(profiles, profile.id);
        await persist(next);
        dispatch(next.profiles.length ? { type: 'show-desktops' } : { type: 'needs-pairing' });
      })() }
    ]);
  }, [persist, profiles, t]);

  const selected = screen.kind === 'shell' || screen.kind === 'offline'
    ? findDesktop(profiles, screen.desktopId) : null;

  let content;
  if (screen.kind === 'loading') {
    content = <View style={[styles.loading, { backgroundColor: palette.background }]}><ActivityIndicator color={palette.accent} size="large" /></View>;
  } else if (screen.kind === 'pair') {
    content = <Pair device={device} initialError={screen.error} onPaired={paired} />;
  } else if (screen.kind === 'settings') {
    content = <Settings appVersion={appVersion} coreVersion={coreVersion()} logLevel={logLevel}
      onBack={() => dispatch({ type: 'show-desktops' })} onForgetProfile={forgetStoredProfile}
      onLogLevel={level => { setLogLevel(level); setNativeLogLevel(level); }} store={profiles} />;
  } else if (screen.kind === 'desktops') {
    content = <Desktops store={profiles} tunnelStatus={tunnelStatus}
      onForgetDesktop={forgetDesktop} onOpen={(profile, desktop) => void openDesktop(profile, desktop)}
      onPair={() => dispatch({ type: 'needs-pairing' })}
      onRename={(desktopId, name) => void persist(renameDesktop(profiles, desktopId, name))}
      onSettings={() => dispatch({ type: 'show-settings' })}
      onSwitchProfile={profile => void (async () => {
        await startProfile(profile.id);
        await persist({ ...profiles, lastProfileId: profile.id, lastDesktopId: profile.desktops[0]?.id ?? null });
        await refreshStatus();
      })()} />;
  } else if (screen.kind === 'offline') {
    content = <Offline onDesktops={() => void showDesktops()} onRetry={retry} reason={screen.reason} />;
  } else {
    content = selected ? <Shell biometricSession={biometricSession} desktopId={screen.desktopId}
      desktopName={selected.desktop.name} lockSignal={lockSignal} onDesktops={() => void showDesktops()}
      onOffline={() => dispatch({ type: 'desktop-offline', desktopId: screen.desktopId, reason: 'desktop' })}
      tunnelOnline={tunnelStatus?.state === 'running'} url={screen.url} version={appVersion} />
      : <Desktops store={profiles} tunnelStatus={tunnelStatus} onForgetDesktop={forgetDesktop}
        onOpen={(profile, desktop) => void openDesktop(profile, desktop)} onPair={() => dispatch({ type: 'needs-pairing' })}
        onRename={(desktopId, name) => void persist(renameDesktop(profiles, desktopId, name))}
        onSettings={() => dispatch({ type: 'show-settings' })} onSwitchProfile={() => undefined} />;
  }

  return <><StatusBar style="auto" />{content}</>;
}

export default function App() {
  return <SafeAreaProvider><AppContent /></SafeAreaProvider>;
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' }
});
