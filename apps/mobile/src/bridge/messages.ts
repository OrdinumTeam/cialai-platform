import type { AuthLevel } from '../auth/biometrics';
import { isSafeDownloadUrl, isSafeExternalUrl } from '../config/url';

const MAX_AUTH_REASON_LENGTH = 160;
const MAX_BRIDGE_MESSAGE_LENGTH = 11_200_000;

export type AuthRequest = { type: 'auth'; id: number; level: AuthLevel; reason: string };
type DownloadBase = { type: 'download'; name: string };
export type DataDownloadRequest = DownloadBase & { mime: string; dataUrl: string; url?: never };
export type RemoteDownloadRequest = DownloadBase & { mime?: string; url: string; dataUrl?: never };
export type DownloadRequest = DataDownloadRequest | RemoteDownloadRequest;
export type OpenExternalRequest = { type: 'open-external'; url: string };
export type NavigateBackMessage = { type: 'navigate-back' };
export type PageMessage = AuthRequest | DownloadRequest | OpenExternalRequest | NavigateBackMessage;
export type ShellMessage = {
  type: 'shell';
  platform: 'ios' | 'android';
  version: string;
  desktopId: string;
  unlocked: boolean;
  // Aparência escolhida nos ajustes; a página segue a mesma.
  theme?: 'system' | 'light' | 'dark';
};
export type AuthResponse = { type: 'auth'; id: number; ok: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePageMessage(raw: string, allowDevelopmentLoopback = false): PageMessage | null {
  if (!raw || raw.length > MAX_BRIDGE_MESSAGE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.type !== 'string') return null;
  if (value.type === 'auth') {
    const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
    if (!Number.isSafeInteger(value.id) || (value.id as number) < 1 ||
        (value.level !== 'session' && value.level !== 'action') || !reason ||
        reason.length > MAX_AUTH_REASON_LENGTH) return null;
    return { type: 'auth', id: value.id as number, level: value.level, reason };
  }
  if (value.type === 'download') {
    if (typeof value.name !== 'string') return null;
    const hasDataUrl = typeof value.dataUrl === 'string';
    const hasUrl = typeof value.url === 'string';
    if (hasDataUrl === hasUrl) return null;
    if (hasDataUrl) {
      if (typeof value.mime !== 'string') return null;
      return { type: 'download', name: value.name, mime: value.mime, dataUrl: value.dataUrl as string };
    }
    if (!isSafeDownloadUrl(value.url as string, allowDevelopmentLoopback)) return null;
    if (value.mime !== undefined && typeof value.mime !== 'string') return null;
    return { type: 'download', name: value.name,
      ...(typeof value.mime === 'string' ? { mime: value.mime } : {}), url: value.url as string };
  }
  if (value.type === 'open-external') {
    if (typeof value.url !== 'string' || !isSafeExternalUrl(value.url)) return null;
    return { type: 'open-external', url: value.url };
  }
  if (value.type === 'navigate-back' && Object.keys(value).length === 1) {
    return { type: 'navigate-back' };
  }
  return null;
}

export function pageMessageScript(message: ShellMessage | AuthResponse | NavigateBackMessage): string {
  const serialized = JSON.stringify(message).replace(/</g, '\\u003c');
  return `window.__cialaiShellReceive?.(${serialized}); true;`;
}

export function shellMessageScript(message: ShellMessage): string {
  return pageMessageScript(message);
}
