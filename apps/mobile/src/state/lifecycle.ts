import type { AppScreen, OfflineReason } from './machine';

type AppStateName = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
type NativePlatform = 'ios' | 'android';

type AppStateTransition = {
  nextState: AppStateName;
  backgroundedAt: number | null;
  now: number;
  platform: NativePlatform;
  screen: AppScreen;
  notifyForeground: (active: boolean) => void;
  checkHealth: (url: string) => Promise<boolean>;
  markOffline: (desktopId: string, reason: OfflineReason) => void;
  reconnect: (desktopId: string) => void;
};

export const ANDROID_BACKGROUND_STOP_MS = 120_000;

export function handleAppStateTransition({
  nextState,
  backgroundedAt,
  now,
  platform,
  screen,
  notifyForeground,
  checkHealth,
  markOffline,
  reconnect
}: AppStateTransition): number | null {
  const active = nextState === 'active';
  const backgroundDuration = backgroundedAt === null ? 0 : now - backgroundedAt;
  const nextBackgroundedAt = active ? null : backgroundedAt ?? now;
  notifyForeground(active);

  if (active && platform === 'android' && backgroundDuration >= ANDROID_BACKGROUND_STOP_MS && screen.kind === 'shell') {
    reconnect(screen.desktopId);
    return nextBackgroundedAt;
  }
  if (active && screen.kind === 'shell') {
    void checkHealth(screen.url).then(healthy => {
      if (!healthy) markOffline(screen.desktopId, 'desktop');
    });
  }
  return nextBackgroundedAt;
}

type NetworkState = {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
};

export function notifyNetworkTransition(
  state: NetworkState,
  notifyNetworkChange: (reachable: boolean) => void
): boolean {
  const reachable = state.isConnected === true && state.isInternetReachable !== false;
  notifyNetworkChange(reachable);
  return reachable;
}
