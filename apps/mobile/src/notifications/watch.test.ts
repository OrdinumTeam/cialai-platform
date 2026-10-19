import type { DashboardMessage, DashboardSession } from '../bridge/messages';
import { setLocale, t } from '../i18n';
import { CONTINUOUS_SNAPSHOT_MS, colorDot, noticesFor, parseNotificationPrefs } from './watch';

const quiet = { color: null, tone: null, icon: null, attention: null, turn: null, viewed: false };

const window = (id: string, usedFraction: number) =>
  ({ id, label: id === 'session' ? 'Limite de 5 horas' : 'Limite semanal', usedFraction, resetsAtMs: 10, durationMs: null, headline: id === 'session', weekly: id === 'weekly' });
const snapshot = (sessions: [string, string][], used: number): DashboardMessage => ({
  type: 'dashboard', at: 1, projects: [], recent: [],
  sessions: sessions.map(([id, status]) => ({ id, name: id === 's1' ? 'psicoapp' : '', cwd: '/p/frontend', status, agent: null, ...quiet })),
  accounts: [{ id: 'a', agent: 'codex', label: 'Trabalho', plan: 'Plus', active: true, state: 'ok', fetchedAtMs: 1,
    windows: [window('session', used), window('weekly', 0.1)], weeklyState: 'available' }]
});
const all = { sessions: true, usage: true, attention: true };
const verde = { light: { base: '#1f9d5b', text: '#187a46' }, dark: { base: '#3ccf76', text: '#3ccf76' } };
const session = (fields: Partial<DashboardSession>): DashboardSession =>
  ({ id: 's1', name: 'site-exemplo', cwd: '/p/site', status: 'running', agent: 'claude', ...quiet, ...fields });
const withSessions = (at: number, sessions: DashboardSession[]): DashboardMessage =>
  ({ type: 'dashboard', at, projects: [], recent: [], accounts: [], sessions });

beforeEach(async () => { await setLocale('pt-BR'); });

test('reads stored preferences and falls back to everything off', () => {
  expect(parseNotificationPrefs(null)).toEqual({ sessions: false, usage: false, attention: false });
  expect(parseNotificationPrefs('{broken')).toEqual({ sessions: false, usage: false, attention: false });
  expect(parseNotificationPrefs('{"sessions":true,"usage":"yes"}')).toEqual({ sessions: true, usage: false, attention: false });
  expect(parseNotificationPrefs('{"attention":true}')).toEqual({ sessions: false, usage: false, attention: true });
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
  expect(noticesFor(before, after, 'd', 'Mac', { sessions: false, usage: true, attention: false }, t)).toEqual([]);
  // Uma sessão que já tinha terminado não avisa de novo.
  expect(noticesFor(after, after, 'd', 'Mac', all, t)).toEqual([]);
});

test('usage notifies once when a window crosses the warning or the limit', () => {
  const near = noticesFor(snapshot([], 0.5), snapshot([], 0.8), 'd', 'Mac', all, t);
  expect(near).toEqual([expect.objectContaining({ title: 'Codex perto do limite', body: 'Limite de 5 horas da conta Trabalho em 80%' })]);
  const full = noticesFor(snapshot([], 0.5), snapshot([], 1), 'd', 'Mac', all, t);
  expect(full.map(notice => notice.title)).toEqual(['Codex chegou ao limite']);
  expect(noticesFor(snapshot([], 0.8), snapshot([], 0.9), 'd', 'Mac', all, t)).toEqual([]);
  expect(noticesFor(snapshot([], 0.5), snapshot([], 0.8), 'd', 'Mac', { sessions: true, usage: false, attention: false }, t)).toEqual([]);
  // O âmbar, de 60%, não avisa: o primeiro aviso é o vermelho.
  expect(noticesFor(snapshot([], 0.5), snapshot([], 0.7), 'd', 'Mac', all, t)).toEqual([]);
});

test('the bell, a terminal notice and a finished command notify with the session name, color and target', () => {
  const before = withSessions(1000, [session({ color: 'verde', tone: verde })]);
  const bell = withSessions(2000, [session({ color: 'verde', tone: verde, attention: { kind: 'bell', at: 1500, message: '' } })]);
  const [notice] = noticesFor(before, bell, 'd', 'Mac de Foco', all, t);
  expect(notice).toEqual(expect.objectContaining({
    title: '🟢 site-exemplo', body: 'Pediu atenção', subtitle: 'Mac de Foco', color: '#1f9d5b', channel: 'attention',
    identifier: 'd:s1', target: { desktopId: 'd', sessionId: 's1' }
  }));
  // A mesma atenção no retrato seguinte não avisa de novo.
  expect(noticesFor(bell, { ...bell, at: 3000 }, 'd', 'Mac', all, t)).toEqual([]);
  const custom = withSessions(2000, [session({ attention: { kind: 'notify', at: 1600, message: 'Build pronto' } })]);
  expect(noticesFor(before, custom, 'd', 'Mac', all, t)[0]).toEqual(expect.objectContaining({ title: 'site-exemplo', body: 'Build pronto' }));
  const finished = withSessions(2000, [session({ attention: { kind: 'finished', at: 1700, message: '' } })]);
  expect(noticesFor(before, finished, 'd', 'Mac', all, t)[0]!.body).toBe('O comando terminou');
});

test('the agent waiting, asking for permission or finishing its answer notifies once per change', () => {
  const at = (time: number, fields: Partial<DashboardSession>) => withSessions(time, [session(fields)]);
  const busy = at(1000, { turn: { state: 'busy', waitingFor: null } });
  expect(noticesFor(busy, at(2000, { turn: { state: 'waiting', waitingFor: null } }), 'd', 'Mac', all, t)[0]!.body).toBe('Claude Code aguarda você');
  expect(noticesFor(busy, at(2000, { turn: { state: 'waiting', waitingFor: 'permission' } }), 'd', 'Mac', all, t)[0]!.body).toBe('Claude Code pede permissão');
  expect(noticesFor(busy, at(2000, { agent: 'codex', turn: { state: 'done', waitingFor: null } }), 'd', 'Mac', all, t)[0]!.body).toBe('Codex terminou a resposta');
  expect(noticesFor(busy, at(2000, { agent: null, turn: { state: 'done', waitingFor: null } }), 'd', 'Mac', all, t)[0]!.body).toBe('O agente terminou a resposta');
  // Começar a trabalhar, ou ficar parado, não é aviso; nem uma vez repetida.
  expect(noticesFor(at(1000, { turn: { state: 'idle', waitingFor: null } }), busy, 'd', 'Mac', all, t)).toEqual([]);
  expect(noticesFor(at(1000, { turn: { state: 'idle', waitingFor: null } }), at(2000, { turn: { state: 'done', waitingFor: null } }), 'd', 'Mac', all, t)).toEqual([]);
  expect(noticesFor(busy, { ...busy, at: 2000 }, 'd', 'Mac', all, t)).toEqual([]);
});

test('attention stays quiet when turned off, for the session being viewed and for a session that just appeared', () => {
  const before = withSessions(1000, [session({})]);
  const bell = (fields: Partial<DashboardSession>) => withSessions(2000, [session({ attention: { kind: 'bell', at: 1500, message: '' }, ...fields })]);
  expect(noticesFor(before, bell({}), 'd', 'Mac', { ...all, attention: false }, t)).toEqual([]);
  expect(noticesFor(before, bell({ viewed: true }), 'd', 'Mac', all, t)).toEqual([]);
  expect(noticesFor(withSessions(1000, []), bell({}), 'd', 'Mac', all, t)).toEqual([]);
  // O primeiro retrato, ou um guardado de outra abertura, não é base.
  expect(noticesFor(null, bell({}), 'd', 'Mac', all, t)).toEqual([]);
  expect(noticesFor(before, { ...bell({}), at: 1000 + CONTINUOUS_SNAPSHOT_MS + 1 }, 'd', 'Mac', all, t)).toEqual([]);
});

test('the color dot follows the hue of the session tone', () => {
  expect(['#4a8ae6', '#3ccf76', '#a78bfa', '#fb923c', '#facc15', '#f87171', '#9ca3af', '#2dd4bf', '#22d3ee'].map(colorDot))
    .toEqual(['🔵', '🟢', '🟣', '🟠', '🟡', '🔴', '⚪', '🟢', '🔵']);
  expect(colorDot('rosa')).toBe('');
});
