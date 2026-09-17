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
export type NetworkForwarder = ((state: NetworkState) => NetworkChange) & { cancel: () => void };

// Tempo que uma interface nova precisa ficar estável antes de chegar ao núcleo.
export const NETWORK_TYPE_SETTLE_MS = 2_500;

export function isReachable(state: NetworkState): boolean {
  return state.isConnected === true && state.isInternetReachable !== false;
}

// Mudança de alcance chega ao núcleo na hora: a volta da rede é o que destrava a
// reconexão. Mudança só de interface, como Wi-Fi para rede móvel com o mesmo
// alcance, espera NETWORK_TYPE_SETTLE_MS estável, porque o NetInfo oscila entre
// wifi, cellular e unknown durante a troca; um vaivém que termina na interface
// de antes não gera aviso, e repetições idênticas nunca chegam ao núcleo.
export function createNetworkForwarder(
  notifyNetworkChange: (reachable: boolean) => void,
  settleMs = NETWORK_TYPE_SETTLE_MS
): NetworkForwarder {
  let forwarded: { reachable: boolean; type: string } | null = null;
  let settling: ReturnType<typeof setTimeout> | null = null;
  const cancel = () => {
    if (settling) clearTimeout(settling);
    settling = null;
  };
  const forward = (state: NetworkState): NetworkChange => {
    const reachable = isReachable(state);
    const type = state.type ?? 'unknown';
    cancel();
    if (forwarded && forwarded.reachable === reachable) {
      if (forwarded.type === type) return { reachable, changed: false, regained: false };
      settling = setTimeout(() => {
        settling = null;
        forwarded = { reachable, type };
        notifyNetworkChange(reachable);
      }, settleMs);
      return { reachable, changed: false, regained: false };
    }
    const regained = forwarded !== null && !forwarded.reachable && reachable;
    forwarded = { reachable, type };
    notifyNetworkChange(reachable);
    return { reachable, changed: true, regained };
  };
  return Object.assign(forward, { cancel });
}
