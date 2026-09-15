import type { PathKind, TorProgress, TorState, Transport, TunnelEvent } from 'cialai-tunnel';

export type TunnelSignal =
  | { type: 'path'; desktopId: string; transport: Transport | null; path: PathKind | null; reason: string }
  | { type: 'tor'; tor: TorProgress }
  | { type: 'token-rotated'; desktopId: string; deviceToken: string }
  | { type: 'revoked'; desktopId: string }
  | { type: 'core-offline' }
  | { type: 'native-reopening'; desktopId: string }
  | { type: 'native-reopened'; desktopId: string; url: string }
  | { type: 'native-reopen-failed'; desktopId: string | null; code: string | null }
  | { type: 'legacy-discarded' }
  | { type: 'pair-stage'; state: string }
  | { type: 'status-changed' };

const TOR_STATES: ReadonlySet<string> = new Set(['disabled', 'starting', 'bootstrapping', 'ready', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function transportOf(value: unknown): Transport | null {
  return value === 'direct' || value === 'tor' ? value : null;
}

function pathOf(value: unknown): PathKind | null {
  return value === 'lan' || value === 'direct' || value === 'tor' ? value : null;
}

export function parseTorProgress(value: unknown): TorProgress | null {
  if (!isRecord(value) || typeof value.state !== 'string' || !TOR_STATES.has(value.state)) return null;
  const raw = typeof value.progress === 'number' && Number.isFinite(value.progress) ? value.progress : 0;
  return { state: value.state as TorState, progress: Math.min(100, Math.max(0, Math.round(raw))) };
}

// Percentual exibido só enquanto a reserva ainda prepara.
export function reservePercent(tor: TorProgress | null): number | null {
  if (!tor || tor.state === 'ready' || tor.state === 'disabled' || tor.state === 'failed') return null;
  return tor.progress;
}

// Traduz o evento nativo em sinais do app. A carga é tratada como não confiável:
// campos ausentes ou de outro tipo descartam o sinal em vez de quebrar a interface.
export function interpretTunnelEvent(event: TunnelEvent): TunnelSignal[] {
  const payload = isRecord(event.payload) ? event.payload : {};
  const desktopId = text(payload.desktopId);
  switch (event.kind) {
    case 'path': {
      if (!desktopId) return [];
      const reason = text(payload.reason) ?? '';
      if (reason === 'revoked') return [{ type: 'revoked', desktopId }];
      const transport = transportOf(payload.transport);
      const path = pathOf(payload.path);
      return [{
        type: 'path',
        desktopId,
        transport: transport && path ? transport : null,
        path: transport && path ? path : null,
        reason
      }, { type: 'status-changed' }];
    }
    case 'tor': {
      const tor = parseTorProgress(payload);
      return tor ? [{ type: 'tor', tor }] : [];
    }
    case 'proxy': {
      const state = text(payload.state);
      const deviceToken = text(payload.deviceToken);
      if (state === 'token-rotated' && desktopId && deviceToken) return [{ type: 'token-rotated', desktopId, deviceToken }];
      if (state === 'revoked' && desktopId) return [{ type: 'revoked', desktopId }];
      const url = text(payload.url);
      if (state === 'reopened' && desktopId && url) return [{ type: 'native-reopened', desktopId, url }];
      return [];
    }
    case 'state': {
      const signals: TunnelSignal[] = [];
      if (payload.legacyDiscarded === true) signals.push({ type: 'legacy-discarded' });
      const state = text(payload.state);
      if (state === 'reconnecting' && desktopId) signals.push({ type: 'native-reopening', desktopId });
      else if (state === 'reconnect-failed') signals.push({ type: 'native-reopen-failed', desktopId, code: text(payload.code) });
      else if (state === 'offline') signals.push({ type: 'core-offline' });
      signals.push({ type: 'status-changed' });
      return signals;
    }
    case 'pair': {
      const state = text(payload.state);
      return state ? [{ type: 'pair-stage', state }] : [];
    }
    default:
      return [];
  }
}
