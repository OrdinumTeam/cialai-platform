import type { DashboardMessage } from '../bridge/messages';
import { setLocale, t } from '../i18n';
import { CONTINUOUS_SNAPSHOT_MS, noticesFor, parseNotificationPrefs } from './watch';

const window = (id: string, usedFraction: number) =>
  ({ id, label: id === 'session' ? 'Limite de 5 horas' : 'Limite semanal', usedFraction, resetsAtMs: 10, durationMs: null, headline: id === 'session', weekly: id === 'weekly' });
const snapshot = (sessions: [string, string][], used: number): DashboardMessage => ({
  type: 'dashboard', at: 1, projects: [], recent: [],
  sessions: sessions.map(([id, status]) => ({ id, name: id === 's1' ? 'psicoapp' : '', cwd: '/p/frontend', status, agent: null })),
  accounts: [{ id: 'a', agent: 'codex', label: 'Trabalho', plan: 'Plus', active: true, state: 'ok', fetchedAtMs: 1,
    windows: [window('session', used), window('weekly', 0.1)] }]
});
const all = { sessions: true, usage: true };

beforeEach(async () => { await setLocale('pt-BR'); });

test('reads stored preferences and falls back to everything off', () => {
  expect(parseNotificationPrefs(null)).toEqual({ sessions: false, usage: false });
  expect(parseNotificationPrefs('{broken')).toEqual({ sessions: false, usage: false });
  expect(parseNotificationPrefs('{"sessions":true,"usage":"yes"}')).toEqual({ sessions: true, usage: false });
});

test('the first reading of a computer never notifies', () => {
  expect(noticesFor(null, snapshot([['s1', 'exited']], 1), 'd', 'Mac', all, t)).toEqual([]);
});

test('a snapshot kept from an earlier opening is not a baseline for notices', () => {
  const before = snapshot([['s1', 'running']], 0.5);
  const after = (at: number) => ({ ...snapshot([['s1', 'exited']], 0.8), at });
  expect(noticesFor(before, after(before.at + CONTINUOUS_SNAPSHOT_MS + 1), 'd', 'Mac', all, t)).toEqual([]);
  expect(noticesFor(before, after(before.at - 1), 'd', 'Mac', all, t)).toEqual([]);
  expect(noticesFor(before, after(before.at + 60_000), 'd', 'Mac', all, t)).toHaveLength(2);
});

test('a reopened session that ends again gets a new notice key', () => {
  const ended = (at: number) => noticesFor({ ...snapshot([['s1', 'running']], 0.1), at }, { ...snapshot([['s1', 'exited']], 0.1), at: at + 1 }, 'd', 'Mac', all, t);
  expect(ended(1)[0]!.key).not.toBe(ended(120_000)[0]!.key);
});

test('a running session that ends or fails notifies; one that just disappears does not', () => {
  const before = snapshot([['s1', 'running'], ['s2', 'starting'], ['s3', 'running']], 0.1);
  const after = snapshot([['s1', 'exited'], ['s2', 'error']], 0.1);
  const notices = noticesFor(before, after, 'd', 'Mac de Foco', all, t);
  expect(notices.map(notice => notice.title)).toEqual(['psicoapp terminou', 'frontend parou com erro']);
  expect(notices[0]!.body).toBe('Sessão em Mac de Foco');
  expect(new Set(notices.map(notice => notice.key)).size).toBe(2);
  expect(noticesFor(before, after, 'd', 'Mac', { sessions: false, usage: true }, t)).toEqual([]);
  // Uma sessão que já tinha terminado não avisa de novo.
  expect(noticesFor(after, after, 'd', 'Mac', all, t)).toEqual([]);
});

test('usage notifies once when a window crosses the warning or the limit', () => {
  const near = noticesFor(snapshot([], 0.5), snapshot([], 0.8), 'd', 'Mac', all, t);
  expect(near).toEqual([expect.objectContaining({ title: 'Codex perto do limite', body: 'Limite de 5 horas da conta Trabalho em 80%' })]);
  const full = noticesFor(snapshot([], 0.5), snapshot([], 1), 'd', 'Mac', all, t);
  expect(full.map(notice => notice.title)).toEqual(['Codex chegou ao limite']);
  expect(noticesFor(snapshot([], 0.8), snapshot([], 0.9), 'd', 'Mac', all, t)).toEqual([]);
  expect(noticesFor(snapshot([], 0.5), snapshot([], 0.8), 'd', 'Mac', { sessions: true, usage: false }, t)).toEqual([]);
});
