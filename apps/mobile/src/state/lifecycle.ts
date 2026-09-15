import type { AppScreen } from './machine';

type AppStateName = 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
type NativePlatform = 'ios' | 'android';

// O módulo Android para o núcleo depois desse tempo em segundo plano e reabre sozinho.
export const ANDROID_BACKGROUND_STOP_MS = 120_000;

export type ForegroundAction =
  | { kind: 'none' }
  // Confere o proxy aberto e reconecta do zero se ele não responder.
  | { kind: 'verify'; desktopId: string; url: string }
  // Refaz agora a conexão de um computador que estava fora de alcance.
  | { kind: 'reconnect'; desktopId: string }
  // Confere o proxy e, se ele parou, espera o nativo Android reabrir com o último token.
  | { kind: 'await-native-reopen'; desktopId: string; url: string };

type AppStateTransition = {
  nextState: AppStateName;
  backgroundedAt: number | null;
  now: number;
  platform: NativePlatform;
  screen: AppScreen;
  notifyForeground: (active: boolean) => void;
};

export type AppStateResult = { backgroundedAt: number | null; action: ForegroundAction };

const NONE: ForegroundAction = { kind: 'none' };

// Só a ida real ao segundo plano conta. `inactive` acontece no Face ID, na central
// de controle e no seletor de apps, e não deve derrubar nem reavaliar a conexão.
export function handleAppStateTransition({
  nextState,
  backgroundedAt,
  now,
  platform,
  screen,
  notifyForeground
}: AppStateTransition): AppStateResult {
  if (nextState === 'background') {
    if (backgroundedAt === null) notifyForeground(false);
    return { backgroundedAt: backgroundedAt ?? now, action: NONE };
  }
  if (nextState !== 'active' || backgroundedAt === null) return { backgroundedAt, action: NONE };

  notifyForeground(true);
  const backgroundDuration = Math.max(0, now - backgroundedAt);
  return { backgroundedAt: null, action: foregroundAction(platform, screen, backgroundDuration) };
}

function foregroundAction(platform: NativePlatform, screen: AppScreen, backgroundDuration: number): ForegroundAction {
  if (screen.kind === 'offline') {
    return screen.reason === 'removed' ? NONE : { kind: 'reconnect', desktopId: screen.desktopId };
  }
  if (screen.kind !== 'shell') return NONE;
  // No Android o nativo já parou o núcleo e cuida da reabertura com o último token.
  if (platform === 'android' && backgroundDuration >= ANDROID_BACKGROUND_STOP_MS) {
    return { kind: 'await-native-reopen', desktopId: screen.desktopId, url: screen.url };
  }
  // O iOS pode ter suspendido o app a qualquer momento, sem prazo garantido: todo
  // retorno confere o proxy e aceita reconectar do zero, qualquer que seja a duração.
  return { kind: 'verify', desktopId: screen.desktopId, url: screen.url };
}

type NetworkState = {
  isConnected: boolean | null;
  isInternetReachable: boolean | null;
  type?: string;
};

export type NetworkChange = { reachable: boolean; changed: boolean; regained: boolean };

export function isReachable(state: NetworkState): boolean {
  return state.isConnected === true && state.isInternetReachable !== false;
}

// Repassa ao núcleo cada mudança de alcance ou de interface, como Wi-Fi para rede
// móvel com alcance igual, e ignora repetições idênticas do NetInfo.
export function createNetworkForwarder(notifyNetworkChange: (reachable: boolean) => void) {
  let last: { reachable: boolean; type: string } | null = null;
  return (state: NetworkState): NetworkChange => {
    const reachable = isReachable(state);
    const type = state.type ?? 'unknown';
    if (last && last.reachable === reachable && last.type === type) return { reachable, changed: false, regained: false };
    const regained = last !== null && !last.reachable && reachable;
    last = { reachable, type };
    notifyNetworkChange(reachable);
    return { reachable, changed: true, regained };
  };
}
