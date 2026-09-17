import type { ConnectResult, OpenDesktopResult, PathKind, Transport } from 'cialai-tunnel';

import { tunnelErrorCode } from '../network/tunnel-errors';
import type { OfflineReason } from './machine';

export type ConnectionOutcome =
  // `reused` diz que o proxy devolvido é o mesmo da página aberta: a URL não muda e o WebView não recarrega.
  | { kind: 'opened'; desktopId: string; url: string; transport: Transport; path: PathKind; reused: boolean }
  | { kind: 'offline'; desktopId: string; reason: Exclude<OfflineReason, 'removed' | 'reconnecting'> }
  | { kind: 'revoked'; desktopId: string }
  | { kind: 'unpaired'; desktopId: string };

export type ConnectionPorts = {
  readToken: (desktopId: string) => Promise<string | null>;
  connect: (desktopId: string) => Promise<ConnectResult>;
  openDesktop: (desktopId: string, token: string, preferredPort: number) => Promise<OpenDesktopResult>;
  validateUrl: (url: string) => string;
};

const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'reserve_unavailable', 'reserve_preparing', 'desktop_unknown', 'revoked', 'no_path'
]);

export function connectionErrorCode(caught: unknown): string | null {
  return tunnelErrorCode(caught, CONNECTION_CODES);
}

export function outcomeForCode(desktopId: string, code: string | null): ConnectionOutcome {
  switch (code) {
    case 'revoked': return { kind: 'revoked', desktopId };
    case 'desktop_unknown': return { kind: 'unpaired', desktopId };
    case 'reserve_preparing': return { kind: 'offline', desktopId, reason: 'reserve-preparing' };
    case 'reserve_unavailable': return { kind: 'offline', desktopId, reason: 'reserve-unavailable' };
    case 'no_path': return { kind: 'offline', desktopId, reason: 'no-path' };
    default: return { kind: 'offline', desktopId, reason: 'tunnel' };
  }
}

// Porta do proxy já aberto para a página atual; zero deixa o núcleo escolher.
export function preferredPortOf(currentUrl: string | null): number {
  if (!currentUrl) return 0;
  try {
    const port = Number(new URL(currentUrl).port);
    return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : 0;
  } catch {
    return 0;
  }
}

// Conecta pelo gerenciador de caminho e só então abre o proxy local com o token.
// Sem token guardado o computador precisa ser vinculado de novo, sem chamar o núcleo.
// Com a URL da página aberta, pede a mesma porta: o núcleo devolve o mesmo proxy
// quando ele segue aberto para o mesmo computador, e a página não recarrega.
export async function openConnection(desktopId: string, ports: ConnectionPorts, currentUrl: string | null = null): Promise<ConnectionOutcome> {
  let token: string | null;
  try {
    token = await ports.readToken(desktopId);
  } catch {
    return { kind: 'offline', desktopId, reason: 'tunnel' };
  }
  if (!token) return { kind: 'unpaired', desktopId };
  try {
    const connected = await ports.connect(desktopId);
    const opened = await ports.openDesktop(desktopId, token, preferredPortOf(currentUrl));
    const url = ports.validateUrl(opened.url);
    return {
      kind: 'opened',
      desktopId,
      url,
      transport: connected.transport,
      path: connected.path,
      reused: currentUrl !== null && url === currentUrl
    };
  } catch (caught) {
    return outcomeForCode(desktopId, connectionErrorCode(caught));
  }
}

export const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;

// Uma escada só, para qualquer motivo: 2, 4, 8 e 16 s, repetindo o último
// intervalo. A revogação nunca tenta de novo. A reserva em preparo não tem mais
// intervalo próprio: o núcleo avisa quando ela fica pronta e o app tenta na hora.
export function retryDelay(reason: OfflineReason, attempt: number): number | null {
  if (reason === 'removed') return null;
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), RETRY_DELAYS_MS.length - 1)]!;
}
