import type { DashboardMessage } from '../bridge/messages';
import { baseName, percentOf } from '../dashboard/model';

// Quais avisos locais o usuário ligou nos ajustes. Os dois começam desligados:
// o sistema só pede permissão quando o usuário liga o primeiro.
export type NotificationPrefs = { sessions: boolean; usage: boolean };
export const NOTIFICATION_KINDS: readonly (keyof NotificationPrefs)[] = ['sessions', 'usage'];
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = Object.freeze({ sessions: false, usage: false });
export const NOTIFICATION_STORAGE_KEY = 'cialai.notifications';

export function parseNotificationPrefs(raw: string | null | undefined): NotificationPrefs {
  if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return { ...DEFAULT_NOTIFICATION_PREFS };
    const record = value as Record<string, unknown>;
    return { sessions: record.sessions === true, usage: record.usage === true };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

export type LocalNotice = { key: string; title: string; body: string };
type Translate = (key: string, values?: Record<string, string | number>) => string;

const LIVE = new Set(['running', 'starting']);
const ENDED = new Set(['exited', 'error']);
// Mesmo limiar de aviso do Início; o segundo é o limite esgotado.
const THRESHOLDS = [0.75, 1] as const;
const AGENT_KEYS = { codex: 'mobile.home.agent.codex', claude: 'mobile.home.agent.claude' } as const;
// Com a página aberta chega um retrato por minuto. Um intervalo maior quer
// dizer que o app ficou sem ouvir o computador, como o retrato guardado em
// disco desde a última abertura: o que mudou nesse meio não é novidade.
export const CONTINUOUS_SNAPSHOT_MS = 3 * 60_000;

// Compara o retrato anterior com o novo e devolve só as mudanças que valem
// aviso. Sem retrato anterior recente não há aviso: a primeira leitura não é
// mudança. Sessão que sumiu do retrato foi fechada por alguém e não vira aviso.
export function noticesFor(previous: DashboardMessage | null, next: DashboardMessage, desktopId: string,
  desktopName: string, prefs: NotificationPrefs, t: Translate): LocalNotice[] {
  if (!previous || next.at < previous.at || next.at - previous.at > CONTINUOUS_SNAPSHOT_MS) return [];
  const notices: LocalNotice[] = [];
  if (prefs.sessions) {
    const before = new Map(previous.sessions.map(session => [session.id, session.status]));
    for (const session of next.sessions) {
      const was = before.get(session.id);
      if (!was || !LIVE.has(was) || !ENDED.has(session.status)) continue;
      const name = session.name || baseName(session.cwd);
      // A sessão reaberta mantém o id; o instante do retrato separa um
      // encerramento do seguinte.
      notices.push({
        key: `${desktopId}:session:${session.id}:${session.status}:${previous.at}`,
        title: t(session.status === 'error' ? 'mobile.notify.session.failed' : 'mobile.notify.session.ended', { name }),
        body: t('mobile.notify.session.detail', { computer: desktopName })
      });
    }
  }
  if (prefs.usage) {
    const before = new Map(previous.accounts.flatMap(account =>
      account.windows.map(window => [`${account.id}\u0000${window.id}`, window.usedFraction] as const)));
    for (const account of next.accounts) {
      for (const window of account.windows) {
        const was = before.get(`${account.id}\u0000${window.id}`);
        if (typeof was !== 'number') continue;
        const crossed = [...THRESHOLDS].reverse().find(limit => was < limit && window.usedFraction >= limit);
        if (crossed === undefined) continue;
        const agent = t(AGENT_KEYS[account.agent]);
        notices.push({
          key: `${desktopId}:usage:${account.id}:${window.id}:${crossed}:${window.resetsAtMs ?? ''}`,
          title: t(crossed >= 1 ? 'mobile.notify.usage.exhausted' : 'mobile.notify.usage.near', { agent }),
          body: t('mobile.notify.usage.detail', { window: window.label, account: account.label, percent: percentOf(window.usedFraction) })
        });
      }
    }
  }
  return notices;
}
