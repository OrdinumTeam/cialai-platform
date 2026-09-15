import type { ConnectResult, OpenDesktopResult, PathKind, Transport } from 'cialai-tunnel';

import { tunnelErrorCode } from '../network/tunnel-errors';
import type { OfflineReason } from './machine';

export type ConnectionOutcome =
  | { kind: 'opened'; desktopId: string; url: string; transport: Transport; path: PathKind }
  | { kind: 'offline'; desktopId: string; reason: Exclude<OfflineReason, 'removed' | 'reconnecting'> }
  | { kind: 'revoked'; desktopId: string }
  | { kind: 'unpaired'; desktopId: string };

export type ConnectionPorts = {
  readToken: (desktopId: string) => Promise<string | null>;
  connect: (desktopId: string) => Promise<ConnectResult>;
  openDesktop: (desktopId: string, token: string) => Promise<OpenDesktopResult>;
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

// Conecta pelo gerenciador de caminho e só então abre o proxy local com o token.
// Sem token guardado o computador precisa ser vinculado de novo, sem chamar o núcleo.
export async function openConnection(desktopId: string, ports: ConnectionPorts): Promise<ConnectionOutcome> {
  let token: string | null;
  try {
    token = await ports.readToken(desktopId);
  } catch {
    return { kind: 'offline', desktopId, reason: 'tunnel' };
  }
  if (!token) return { kind: 'unpaired', desktopId };
  try {
    const connected = await ports.connect(desktopId);
    const opened = await ports.openDesktop(desktopId, token);
    return {
      kind: 'opened',
      desktopId,
      url: ports.validateUrl(opened.url),
      transport: connected.transport,
      path: connected.path
    };
  } catch (caught) {
    return outcomeForCode(desktopId, connectionErrorCode(caught));
  }
}

export const RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 16_000] as const;
export const RESERVE_PREPARING_RETRY_MS = 3_000;

// Revogação não tenta de novo. A reserva em preparo volta em intervalo curto e fixo;
// os demais motivos seguem 2, 4, 8 e 16 s, repetindo o último intervalo.
export function retryDelay(reason: OfflineReason, attempt: number): number | null {
  if (reason === 'removed') return null;
  if (reason === 'reserve-preparing') return RESERVE_PREPARING_RETRY_MS;
  return RETRY_DELAYS_MS[Math.min(Math.max(attempt, 0), RETRY_DELAYS_MS.length - 1)]!;
}
