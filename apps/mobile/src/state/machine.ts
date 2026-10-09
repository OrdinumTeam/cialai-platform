import type { PathKind, Transport, TunnelStatus } from 'cialai-tunnel';

export type OfflineReason =
  | 'reconnecting'
  | 'reserve-preparing'
  | 'reserve-unavailable'
  | 'no-path'
  | 'tunnel'
  | 'removed';

export type AppScreen =
  | { kind: 'loading' }
  | { kind: 'pair'; error?: string; notice?: string }
  // Tela inicial: destino do voltar de todas as outras telas da casca.
  | { kind: 'home' }
  | { kind: 'desktops' }
  | { kind: 'settings' }
  // Abas sem dados do computador por enquanto: só o estado vazio.
  | { kind: 'projects' }
  | { kind: 'agents' }
  // `reconnecting` mantém a página montada com a faixa nativa enquanto o caminho volta.
  | { kind: 'shell'; desktopId: string; url: string; transport: Transport | null; path: PathKind | null; reconnecting: boolean }
  | { kind: 'offline'; desktopId: string; reason: OfflineReason };

export type AppAction =
  | { type: 'needs-pairing'; error?: string; notice?: string }
  | { type: 'show-home' }
  | { type: 'show-desktops' }
  | { type: 'show-settings' }
  | { type: 'show-projects' }
  | { type: 'show-agents' }
  | { type: 'desktop-opened'; desktopId: string; url: string; transport: Transport | null; path: PathKind | null }
  | { type: 'desktop-offline'; desktopId: string; reason: OfflineReason }
  | { type: 'path-changed'; desktopId: string; transport: Transport | null; path: PathKind | null }
  | { type: 'shell-reconnecting'; desktopId: string }
  | { type: 'shell-recovered'; desktopId: string };

function isRemoved(screen: AppScreen, desktopId: string): boolean {
  return screen.kind === 'offline' && screen.reason === 'removed' && screen.desktopId === desktopId;
}

function isShellOf(screen: AppScreen, desktopId: string): screen is Extract<AppScreen, { kind: 'shell' }> {
  return screen.kind === 'shell' && screen.desktopId === desktopId;
}

export function transition(screen: AppScreen, action: AppAction): AppScreen {
  switch (action.type) {
    case 'needs-pairing':
      return {
        kind: 'pair',
        ...(action.error ? { error: action.error } : {}),
        ...(action.notice ? { notice: action.notice } : {})
      };
    case 'show-home': return { kind: 'home' };
    case 'show-desktops': return { kind: 'desktops' };
    case 'show-settings': return { kind: 'settings' };
    case 'show-projects': return { kind: 'projects' };
    case 'show-agents': return { kind: 'agents' };
    case 'desktop-opened': {
      // Um celular revogado não volta a abrir o computador por uma tentativa atrasada.
      if (isRemoved(screen, action.desktopId)) return screen;
      const next = { kind: 'shell' as const, desktopId: action.desktopId, url: action.url, transport: action.transport, path: action.path, reconnecting: false };
      // O mesmo proxy reaberto para a mesma página não muda nada: o WebView fica como está.
      if (isShellOf(screen, action.desktopId) && screen.url === next.url && screen.transport === next.transport &&
          screen.path === next.path && !screen.reconnecting) return screen;
      return next;
    }
    case 'desktop-offline':
      if (action.reason !== 'removed' && isRemoved(screen, action.desktopId)) return screen;
      return { kind: 'offline', desktopId: action.desktopId, reason: action.reason };
    case 'path-changed':
      if (!isShellOf(screen, action.desktopId)) return screen;
      if (screen.transport === action.transport && screen.path === action.path) return screen;
      return { ...screen, transport: action.transport, path: action.path };
    case 'shell-reconnecting':
      if (!isShellOf(screen, action.desktopId) || screen.reconnecting) return screen;
      return { ...screen, reconnecting: true };
    case 'shell-recovered':
      if (!isShellOf(screen, action.desktopId) || !screen.reconnecting) return screen;
      return { ...screen, reconnecting: false };
  }
}

// Ações que levam a telas que dependem de um computador vinculado. Sem nenhum
// vínculo, elas viram o início: é a única checagem de acesso da casca, valendo
// para a barra inferior, os atalhos, o voltar e as respostas atrasadas do núcleo.
function requiresDesktop(action: AppAction): boolean {
  switch (action.type) {
    case 'show-desktops':
    case 'show-projects':
    case 'show-agents':
    case 'desktop-opened':
    case 'desktop-offline':
      return true;
    default:
      return false;
  }
}

export function guardAction(action: AppAction, hasDesktops: boolean): AppAction {
  return !hasDesktops && requiresDesktop(action) ? { type: 'show-home' } : action;
}

// Tela que deixou de fazer sentido porque o último vínculo saiu.
export function screenRequiresDesktop(screen: AppScreen): boolean {
  return screen.kind === 'desktops' || screen.kind === 'projects' || screen.kind === 'agents' ||
    screen.kind === 'shell' || screen.kind === 'offline';
}

export type DesktopConnectionState = 'idle' | 'connecting' | 'connected' | 'offline' | 'removed';

export type DesktopStateInput = {
  tunnelStatus: TunnelStatus | null;
  connectingId: string | null;
  // Último motivo de falha por computador nesta sessão, limpo quando ele abre de novo.
  failures: ReadonlyMap<string, OfflineReason>;
};

export type DesktopConnection = { state: DesktopConnectionState; transport: Transport | null };

// Estado mostrado na lista: a revogação vence, depois a tentativa em curso, o caminho
// que o núcleo mantém e por fim a última falha registrada.
export function describeDesktop(desktopId: string, input: DesktopStateInput): DesktopConnection {
  const { tunnelStatus, connectingId, failures } = input;
  const failure = failures.get(desktopId);
  const active = tunnelStatus?.active?.desktopId === desktopId ? tunnelStatus.active : null;
  if (failure === 'removed') return { state: 'removed', transport: null };
  if (connectingId === desktopId) return { state: 'connecting', transport: null };
  if (active && tunnelStatus?.state === 'connected') return { state: 'connected', transport: active.transport };
  if (active && tunnelStatus?.state === 'connecting') return { state: 'connecting', transport: null };
  if (failure) return { state: 'offline', transport: null };
  return { state: 'idle', transport: null };
}
