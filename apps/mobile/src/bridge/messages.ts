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
export type AgentId = 'codex' | 'claude';
export type ReadingState = 'ok' | 'stale' | 'needsLogin' | 'error' | 'unmetered' | 'unavailable' | 'reading';
export type UsageWindow = {
  id: string; label: string; usedFraction: number; resetsAtMs: number | null; durationMs: number | null; headline: boolean; weekly: boolean;
};
export type AgentAccount = {
  id: string; agent: AgentId; label: string; plan: string | null; active: boolean; state: ReadingState;
  fetchedAtMs: number | null; windows: UsageWindow[];
};
export type DashboardProject = { name: string; path: string; root: string };
export type DashboardSession = { id: string; name: string; cwd: string; status: string; agent: AgentId | null };
// Retrato que a página manda para o Início: o formato sai de
// packages/ui/src/mobile/dashboard-snapshot.js.
// `recent` são as últimas pastas em que o telefone abriu sessão; páginas
// antigas não mandam e o campo fica vazio.
export type DashboardMessage = {
  type: 'dashboard'; at: number; accounts: AgentAccount[]; projects: DashboardProject[]; sessions: DashboardSession[]; recent: string[];
};
// Pasta escolhida no navegador da página para virar atalho em Projetos.
export type ProjectPickedMessage = { type: 'project-picked'; path: string; name: string };
export type PageMessage = AuthRequest | DownloadRequest | OpenExternalRequest | NavigateBackMessage | DashboardMessage | ProjectPickedMessage;
export type ShellMessage = {
  type: 'shell';
  platform: 'ios' | 'android';
  version: string;
  desktopId: string;
  unlocked: boolean;
  // Aparência escolhida nos ajustes; a página segue a mesma.
  theme?: 'system' | 'light' | 'dark';
};
// Pedido do Início ao abrir o terminal; a página o atende uma vez por id.
export type ShellIntent =
  | { id: string; kind: 'session'; sessionId: string }
  | { id: string; kind: 'new-session'; cwd?: string }
  | { id: string; kind: 'profiles' }
  | { id: string; kind: 'pick-project' };
export type AuthResponse = { type: 'auth'; id: number; ok: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const DASHBOARD_LIMITS = { accounts: 20, windows: 8, projects: 400, sessions: 100, recent: 10, text: 512 } as const;
const READING_STATES: readonly ReadingState[] = ['ok', 'stale', 'needsLogin', 'error', 'unmetered', 'unavailable', 'reading'];

const text = (value: unknown, required = false): string | null => {
  if (typeof value !== 'string' || value.length > DASHBOARD_LIMITS.text) return null;
  return required && !value ? null : value;
};
const time = (value: unknown): number | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
};
const agentOf = (value: unknown): AgentId | null => (value === 'codex' || value === 'claude' ? value : null);

function list<T>(value: unknown, max: number, item: (entry: unknown) => T | null): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: T[] = [];
  for (const entry of value) {
    const parsed = item(entry);
    if (parsed === null) return null;
    out.push(parsed);
  }
  return out;
}

function parseWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const label = text(value.label);
  const resetsAtMs = time(value.resetsAtMs);
  const durationMs = time(value.durationMs);
  const used = value.usedFraction;
  if (id === null || label === null || resetsAtMs === undefined || durationMs === undefined ||
      typeof used !== 'number' || !Number.isFinite(used)) return null;
  return { id, label, usedFraction: Math.min(1, Math.max(0, used)), resetsAtMs, durationMs,
    headline: value.headline === true, weekly: value.weekly === true };
}

function parseAccount(value: unknown): AgentAccount | null {
  if (!isRecord(value)) return null;
  const id = text(value.id, true);
  const agent = agentOf(value.agent);
  const label = text(value.label);
  const plan = value.plan === null || value.plan === undefined ? null : text(value.plan);
  const fetchedAtMs = time(value.fetchedAtMs);
  const windows = list(value.windows, DASHBOARD_LIMITS.windows, parseWindow);
  if (id === null || !agent || label === null || (value.plan != null && plan === null) || fetchedAtMs === undefined ||
      !windows || !READING_STATES.includes(value.state as ReadingState)) return null;
  return { id, agent, label, plan, active: value.active === true, state: value.state as ReadingState, fetchedAtMs, windows };
}

function parseProject(value: unknown): DashboardProject | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  const path = text(value.path, true);
  const root = text(value.root);
  return name === null || path === null || root === null ? null : { name, path, root };
}

function parseSession(value: unknown): DashboardSession | null {
  if (!isRecord(value)) return null;
  const id = text(value.id, true);
  const name = text(value.name);
  const cwd = text(value.cwd);
  const status = text(value.status);
  if (id === null || name === null || cwd === null || status === null || (value.agent !== null && !agentOf(value.agent))) return null;
  return { id, name, cwd, status, agent: agentOf(value.agent) };
}

// O retrato inteiro é recusado se qualquer parte vier fora do formato.
export function parseDashboard(value: Record<string, unknown>): DashboardMessage | null {
  const at = time(value.at);
  const accounts = list(value.accounts, DASHBOARD_LIMITS.accounts, parseAccount);
  const projects = list(value.projects, DASHBOARD_LIMITS.projects, parseProject);
  const sessions = list(value.sessions, DASHBOARD_LIMITS.sessions, parseSession);
  const recent = value.recent === undefined ? [] : list(value.recent, DASHBOARD_LIMITS.recent, entry => text(entry, true));
  if (!at || !accounts || !projects || !sessions || !recent) return null;
  return { type: 'dashboard', at, accounts, projects, sessions, recent };
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
  if (value.type === 'dashboard') return parseDashboard(value);
  if (value.type === 'project-picked') {
    const path = text(value.path, true);
    const name = text(value.name);
    return path === null || name === null ? null : { type: 'project-picked', path, name };
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
