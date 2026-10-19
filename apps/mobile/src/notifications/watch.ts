import type { DashboardMessage, DashboardSession, SessionTone } from '../bridge/messages';
import { baseName, percentOf } from '../dashboard/model';

// Quais avisos locais o usuário ligou nos ajustes. Todos começam desligados:
// o sistema só pede permissão quando o usuário liga o primeiro.
export type NotificationPrefs = { sessions: boolean; usage: boolean; attention: boolean };
export const NOTIFICATION_KINDS: readonly (keyof NotificationPrefs)[] = ['attention', 'sessions', 'usage'];
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = Object.freeze({ sessions: false, usage: false, attention: false });
export const NOTIFICATION_STORAGE_KEY = 'cialai.notifications';

export function parseNotificationPrefs(raw: string | null | undefined): NotificationPrefs {
  if (!raw) return { ...DEFAULT_NOTIFICATION_PREFS };
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return { ...DEFAULT_NOTIFICATION_PREFS };
    const record = value as Record<string, unknown>;
    return { sessions: record.sessions === true, usage: record.usage === true, attention: record.attention === true };
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFS };
  }
}

// `channel` separa o que pede a pessoa agora, a atenção, do resto. `color`
// pinta o aviso no Android; `target` abre a sessão no toque; `identifier`
// faz o aviso novo de uma sessão substituir o anterior em vez de empilhar.
export type NoticeChannel = 'activity' | 'attention';
export type NoticeTarget = { desktopId: string; sessionId: string };
export type LocalNotice = {
  key: string; title: string; body: string;
  subtitle?: string; color?: string; channel?: NoticeChannel; identifier?: string; target?: NoticeTarget;
};
type Translate = (key: string, values?: Record<string, string | number>) => string;

const LIVE = new Set(['running', 'starting']);
const ENDED = new Set(['exited', 'error']);
// O primeiro é o começo do vermelho no Início e na Barra de IA; o segundo é
// o limite esgotado. O âmbar, de 60%, não vira aviso.
const THRESHOLDS = [0.8, 1] as const;
const AGENT_KEYS = { codex: 'mobile.home.agent.codex', claude: 'mobile.home.agent.claude' } as const;
const ATTENTION_KEYS = {
  bell: 'mobile.notify.attention.bell',
  notify: 'mobile.notify.attention.notify',
  finished: 'mobile.notify.attention.finished'
} as const;

// A cor da sessão no título, porque o iOS não pinta o aviso: a bolinha de cor
// mais perto do tom. Sessão sem cor fica sem bolinha, no rosa do app.
const DOTS = [
  { until: 18, dot: '🔴' }, { until: 45, dot: '🟠' }, { until: 70, dot: '🟡' }, { until: 176, dot: '🟢' },
  { until: 245, dot: '🔵' }, { until: 315, dot: '🟣' }, { until: 360, dot: '🔴' }
] as const;

export function colorDot(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return '';
  const [r, g, b] = match.slice(1).map(part => parseInt(part, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  if (saturation < 0.15) return '⚪';
  const hue = max === r ? 60 * (((g - b) / delta) % 6) : max === g ? 60 * ((b - r) / delta + 2) : 60 * ((r - g) / delta + 4);
  const degrees = (hue + 360) % 360;
  return DOTS.find(entry => degrees < entry.until)?.dot ?? '';
}

// Título com a bolinha da cor, quando a sessão tem uma, e o nome dela.
function sessionTitle(session: DashboardSession): string {
  const name = session.name || baseName(session.cwd);
  const dot = session.color && session.tone ? colorDot(session.tone.dark.base) : '';
  return dot ? `${dot} ${name}` : name;
}

// Cor do aviso no Android: a base clara do tom, que é a mais saturada. Sem
// tom, de página antiga, fica a cor do app.
const noticeColor = (tone: SessionTone | null) => tone?.light.base;

// O que muda e pede a pessoa numa sessão, entre dois retratos: o sino, o
// aviso do terminal, o processo que terminou fora da tela, o agente que passou
// a aguardar ou pedir permissão e a resposta que ficou pronta. A sessão que a
// pessoa está olhando no celular não avisa.
function attentionNotices(previous: DashboardMessage, next: DashboardMessage, desktopId: string,
  desktopName: string, t: Translate): LocalNotice[] {
  const before = new Map(previous.sessions.map(session => [session.id, session]));
  const notices: LocalNotice[] = [];
  for (const session of next.sessions) {
    const was = before.get(session.id);
    if (!was || session.viewed) continue;
    const agent = session.agent ? t(AGENT_KEYS[session.agent]) : t('mobile.notify.attention.agent');
    let body: string | null = null;
    let event = '';
    const attention = session.attention;
    if (attention && attention.at !== was.attention?.at) {
      body = attention.message || t(ATTENTION_KEYS[attention.kind]);
      event = `attention:${attention.at}`;
    } else if (session.turn && session.turn.state !== was.turn?.state) {
      if (session.turn.state === 'waiting') {
        body = t(session.turn.waitingFor === 'permission' ? 'mobile.notify.attention.permission' : 'mobile.notify.attention.waiting', { agent });
      } else if (session.turn.state === 'done' && was.turn?.state === 'busy') {
        body = t('mobile.notify.attention.done', { agent });
      }
      event = `turn:${session.turn.state}:${previous.at}`;
    }
    if (!body) continue;
    notices.push({
      key: `${desktopId}:${session.id}:${event}`,
      title: sessionTitle(session),
      body,
      subtitle: desktopName,
      color: noticeColor(session.tone),
      channel: 'attention',
      identifier: `${desktopId}:${session.id}`,
      target: { desktopId, sessionId: session.id }
    });
  }
  return notices;
}
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
  const notices: LocalNotice[] = prefs.attention ? attentionNotices(previous, next, desktopId, desktopName, t) : [];
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
        body: t('mobile.notify.session.detail', { computer: desktopName }),
        color: noticeColor(session.tone),
        target: { desktopId, sessionId: session.id }
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
