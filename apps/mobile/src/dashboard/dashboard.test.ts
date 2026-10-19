import { beforeEach, describe, expect, test } from '@jest/globals';

import type { AgentAccount, DashboardMessage, DashboardSession } from '../bridge/messages';
import { formatAge, formatDuration, formatReset, formatResetAt } from '../desktops/format';
import { getLocale, setLocale, t } from '../i18n';
import { accountLevel, accountWindows, agentAccounts, agentSummary, DEFAULT_SESSION_TONE, homeAccountId, orderDesktops, orderedAccounts, orderProjects, projectSections, projectTint,
  sessionShade, sessionsIn, shortPath, usageLevel, weeklyView } from './model';
import { addFavorite, dashboardFor, forgetDashboard, loadDashboard, moveFavorite, parseDashboardFile, recordSnapshot, removeFavorite, resetDashboardForTests, toggleFavorite } from './store';

const window = (id: string, usedFraction: number, flags: { headline?: boolean; weekly?: boolean } = {}) =>
  ({ id, label: id, usedFraction, resetsAtMs: null, durationMs: null, headline: !!flags.headline, weekly: !!flags.weekly });
const account = (overrides: Partial<AgentAccount>): AgentAccount => ({
  id: 'codex', agent: 'codex', label: 'Codex', plan: null, active: false, state: 'ok', fetchedAtMs: 1, windows: [], weeklyState: 'unknown', ...overrides
});
const session = (overrides: Partial<DashboardSession> & Pick<DashboardSession, 'id' | 'cwd'>): DashboardSession => ({
  name: overrides.id, status: 'running', agent: null, color: null, tone: null, icon: null, attention: null, turn: null, viewed: false, ...overrides
});
const snapshot = (accounts: AgentAccount[] = [], extra: Partial<DashboardMessage> = {}): DashboardMessage =>
  ({ type: 'dashboard', at: 10, accounts, projects: [], sessions: [], recent: [], ...extra });

beforeEach(async () => { if (getLocale() !== 'pt-BR') await setLocale('pt-BR'); });

describe('usage levels', () => {
  test('the AI Bar bands: amber from 60%, red from 80%, exhausted at 100% and unavailable without a number', () => {
    expect(usageLevel(0)).toBe('normal');
    expect(usageLevel(0.1)).toBe('normal');
    expect(usageLevel(0.599)).toBe('normal');
    expect(usageLevel(0.6)).toBe('near');
    expect(usageLevel(0.79)).toBe('near');
    expect(usageLevel(0.8)).toBe('critical');
    expect(usageLevel(0.99)).toBe('critical');
    expect(usageLevel(1)).toBe('exhausted');
    expect(usageLevel(null)).toBe('unavailable');
    expect(usageLevel(Number.NaN)).toBe('unavailable');
  });

  test('Codex keeps the five hour and weekly windows apart, headline first', () => {
    const summary = agentSummary(snapshot([account({ active: true, windows: [
      window('weekly', 0.8, { weekly: true }), window('session', 0.2, { headline: true }), window('spark', 0.1)
    ] })]), 'codex');
    expect(summary.rows.map(row => row.id)).toEqual(['session', 'weekly']);
    expect(summary.level).toBe('critical');
    expect(summary.readable).toBe(true);
  });

  test('the worst window sets the level, in the band order', () => {
    const level = (...fractions: number[]) => agentSummary(snapshot([account({ active: true, windows: fractions.map((used, index) =>
      window(`w${index}`, used, { headline: index === 0, weekly: index === 1 })) })]), 'codex').level;
    expect(level(0.2, 0.3)).toBe('normal');
    expect(level(0.2, 0.65)).toBe('near');
    expect(level(0.85, 0.65)).toBe('critical');
    expect(level(0.85, 1)).toBe('exhausted');
  });

  test('the weekly limit has three states and missing data never becomes 0% or unlimited', () => {
    const weekly = window('weekly', 0, { weekly: true });
    const available = weeklyView(account({ weeklyState: 'available', windows: [window('session', 0.2, { headline: true }), weekly] }));
    expect(available).toEqual({ kind: 'available', window: weekly, level: 'normal' });
    expect(weeklyView(account({ weeklyState: 'available', windows: [window('weekly', 0.82, { weekly: true })] }))).toMatchObject({ kind: 'available', level: 'critical' });
    expect(weeklyView(account({ weeklyState: 'none', windows: [window('session', 0.2, { headline: true })] }))).toEqual({ kind: 'none' });
    expect(weeklyView(account({ weeklyState: 'unknown', windows: [window('session', 0.2, { headline: true })] }))).toEqual({ kind: 'unknown' });
    // Disse que tem semanal mas a janela não veio, ou a conta está sem leitura válida: sem leitura.
    expect(weeklyView(account({ weeklyState: 'available', windows: [window('session', 0.2, { headline: true })] }))).toEqual({ kind: 'unknown' });
    expect(weeklyView(account({ weeklyState: 'available', state: 'error', windows: [weekly] }))).toEqual({ kind: 'unknown' });
    expect(weeklyView(account({ weeklyState: 'available', state: 'stale', windows: [weekly] }))).toMatchObject({ kind: 'available' });
    expect(weeklyView(null)).toEqual({ kind: 'unknown' });
  });

  test('the chosen account wins, then the active one; a pending login has no number', () => {
    const accounts = [account({ id: 'a', label: 'A' }), account({ id: 'b', label: 'B', active: true, state: 'needsLogin' })];
    expect(agentSummary(snapshot(accounts), 'codex').account?.id).toBe('b');
    expect(agentSummary(snapshot(accounts), 'codex').readable).toBe(false);
    expect(agentSummary(snapshot(accounts), 'codex').level).toBe('unavailable');
    expect(agentSummary(snapshot(accounts), 'codex', 'a').account?.id).toBe('a');
    expect(agentSummary(snapshot(accounts), 'claude').account).toBeNull();
    expect(agentSummary(null, 'codex').readable).toBe(false);
  });
});

describe('agent accounts tab', () => {
  test('lists the active account first and keeps the computer order for the rest', () => {
    const list = agentAccounts(snapshot([account({ id: 'a' }), account({ id: 'b', active: true }), account({ id: 'c', agent: 'claude' })]), 'codex');
    expect(list.map(item => item.id)).toEqual(['b', 'a']);
    expect(agentAccounts(null, 'claude')).toEqual([]);
  });

  test('the flat list puts the accounts in use first and keeps the computer order for the rest, across agents', () => {
    const list = orderedAccounts(snapshot([
      account({ id: 'a' }), account({ id: 'b', agent: 'claude', active: true }), account({ id: 'c', active: true }), account({ id: 'd', agent: 'claude' })
    ]));
    expect(list.map(item => item.id)).toEqual(['b', 'c', 'a', 'd']);
    expect(orderedAccounts(null)).toEqual([]);
  });

  test('the Home card shows the account in use, else the chosen one while it exists, else the first', () => {
    const accounts = [account({ id: 'a' }), account({ id: 'b' }), account({ id: 'c', active: true })];
    expect(homeAccountId(snapshot(accounts), 'codex', 'b')).toBe('c');
    expect(homeAccountId(snapshot(accounts.slice(0, 2)), 'codex', 'b')).toBe('b');
    expect(homeAccountId(snapshot(accounts.slice(0, 2)), 'codex', 'gone')).toBe('a');
    expect(homeAccountId(snapshot(accounts.slice(0, 2)), 'codex')).toBe('a');
    expect(homeAccountId(snapshot(accounts), 'claude', 'a')).toBeUndefined();
    expect(homeAccountId(null, 'codex')).toBeUndefined();
  });

  test('Codex shows the five hour and weekly windows apart, Claude Code every window it read', () => {
    const codex = account({ windows: [window('extra', 0.2), window('weekly', 0.4, { weekly: true }), window('session', 0.9, { headline: true })] });
    expect(accountWindows(codex).map(item => item.id)).toEqual(['session', 'weekly']);
    expect(accountLevel(codex)).toBe('critical');
    const onlyWeekly = account({ windows: [window('weekly', 1, { weekly: true })] });
    expect(accountWindows(onlyWeekly).map(item => item.id)).toEqual(['weekly']);
    expect(accountLevel(onlyWeekly)).toBe('exhausted');
    const claude = account({ agent: 'claude', windows: [window('opus', 0.1), window('five', 0.3, { headline: true }), window('week', 0.2)] });
    expect(accountWindows(claude).map(item => item.id)).toEqual(['five', 'opus', 'week']);
  });

  test('an account without a reading has no window and no level', () => {
    for (const state of ['needsLogin', 'error', 'unmetered', 'reading', 'unavailable'] as const) {
      const item = account({ state, windows: [window('session', 0.5, { headline: true })] });
      expect(accountWindows(item)).toEqual([]);
      expect(accountLevel(item)).toBe('unavailable');
    }
    expect(accountWindows(account({ state: 'stale', windows: [window('session', 0.5, { headline: true })] }))).toHaveLength(1);
  });

  test('the reset moment is only shown when it is still ahead', () => {
    const now = Date.UTC(2026, 9, 3, 12);
    expect(formatResetAt(null, now, 'pt-BR')).toBeNull();
    expect(formatResetAt(now - 1, now, 'pt-BR')).toBeNull();
    expect(formatResetAt(now + 3_600_000, now, 'pt-BR')).toMatch(/\d{2}:\d{2}/);
  });
});

describe('ordering', () => {
  const desktop = (id: string) => ({ id, name: id, fingerprint: '0123456789abcdef', deviceId: 'dev', pairedAt: '', lastSeenAt: '', lastTransport: '' as const });

  test('the connected computer comes first, then the last used, then the pairing order', () => {
    const states: Record<string, 'connected' | 'idle'> = { a: 'idle', b: 'idle', c: 'connected' };
    const order = orderDesktops([desktop('a'), desktop('b'), desktop('c')], 'b', id => ({ state: states[id]!, transport: null }));
    expect(order.map(item => item.id)).toEqual(['c', 'b', 'a']);
  });

  test('favorites come first in the order they were marked, the rest by name, a missing favorite stays', () => {
    const projects = [{ name: 'zeta', path: '/z', root: '' }, { name: 'alfa', path: '/a', root: '' }, { name: 'meio', path: '/m', root: '' }];
    expect(orderProjects(projects, ['/m', '/gone']).map(project => [project.name, project.favorite]))
      .toEqual([['meio', true], ['gone', true], ['alfa', false], ['zeta', false]]);
  });

  test('sessions belong to the folder and its subfolders only', () => {
    const sessions = [
      session({ id: '1', cwd: '/p/app' }),
      session({ id: '2', cwd: '/p/app/web' }),
      session({ id: '3', cwd: '/p/application' }),
      session({ id: '4', cwd: '/p/app', status: 'exited' }),
      session({ id: '5', cwd: '/p/app/api', status: 'error' })
    ];
    expect(sessionsIn(snapshot([], { sessions }), '/p/app/').map(session => session.id)).toEqual(['1', '2']);
    const windows = [
      session({ id: 'w1', cwd: 'C:\\Users\\a\\proj' }),
      session({ id: 'w2', cwd: 'C:\\Users\\a\\proj\\api', status: 'starting' }),
      session({ id: 'w3', cwd: 'C:\\Users\\a\\project' })
    ];
    expect(sessionsIn(snapshot([], { sessions: windows }), 'C:\\Users\\a\\proj\\').map(session => session.id)).toEqual(['w1', 'w2']);
  });

  test('each project keeps the same tint', () => {
    expect(projectTint('psicoapp')).toBe(projectTint('psicoapp'));
  });

  test('a session paints with the tone the page resolved, or the Cialai pink without one', () => {
    const tone = { light: { base: '#0EA5E9', text: '#0369A1' }, dark: { base: '#7DD3FC', text: '#7DD3FC' } };
    expect(sessionShade(session({ id: 's', cwd: '/p', color: 'azul', tone }), 'light')).toEqual({ base: '#0EA5E9', text: '#0369A1' });
    expect(sessionShade(session({ id: 's', cwd: '/p', color: 'azul', tone }), 'dark')).toEqual({ base: '#7DD3FC', text: '#7DD3FC' });
    expect(sessionShade(session({ id: 's', cwd: '/p' }), 'light')).toEqual({ base: '#E23B84', text: '#C73474' });
    expect(sessionShade(session({ id: 's', cwd: '/p' }), 'dark')).toEqual(DEFAULT_SESSION_TONE.dark);
  });
});

describe('time copy', () => {
  test('durations are short and never negative', () => {
    expect(formatDuration(2 * 3_600_000 + 10 * 60_000, t)).toBe('2 h 10 min');
    expect(formatDuration(3 * 86_400_000, t)).toBe('3 d');
    expect(formatDuration(30_000, t)).toBe('1 min');
    expect(formatDuration(-1, t)).toBeNull();
    expect(formatReset(null, 0, t)).toBeNull();
    expect(formatAge(1000, 1000 + 5 * 60_000, 'pt-BR', t)).toBe('há 5 min');
    expect(formatAge(1000, 2000, 'pt-BR', t)).toBe('agora');
  });
});

describe('dashboard store', () => {
  const memory = () => {
    const files = new Map<string, string>();
    return { files, store: { read: async (name: string) => files.get(name) ?? null, write: async (name: string, value: string) => { files.set(name, value); }, remove: async () => {} } };
  };

  test('keeps the snapshot and favorites per computer and forgets them with the computer', async () => {
    const { files, store } = memory();
    resetDashboardForTests(store);
    await loadDashboard();
    recordSnapshot('d1', snapshot());
    toggleFavorite('d1', '/p');
    expect(dashboardFor('d1').favorites).toEqual(['/p']);
    expect(dashboardFor('d2').snapshot).toBeNull();
    const saved = parseDashboardFile(files.get('dashboard.json') ?? null);
    expect(saved.d1?.snapshot?.at).toBe(10);
    toggleFavorite('d1', '/p');
    expect(dashboardFor('d1').favorites).toEqual([]);
    forgetDashboard('d1');
    expect(dashboardFor('d1').snapshot).toBeNull();
    expect(parseDashboardFile(files.get('dashboard.json') ?? null).d1).toBeUndefined();
  });

  test('a change before the file is read keeps what only the disk had', async () => {
    const { files, store } = memory();
    files.set('dashboard.json', JSON.stringify({ version: 1, desktops: {
      d1: { snapshot: null, favorites: ['/a'], accounts: { codex: 'w' } },
      d2: { snapshot: null, favorites: ['/b'], accounts: {} } } }));
    resetDashboardForTests(store);
    recordSnapshot('d1', snapshot());
    expect(files.get('dashboard.json')).toContain('"/b"');
    await loadDashboard();
    expect(dashboardFor('d1')).toEqual({ snapshot: snapshot(), favorites: ['/a'], accounts: { codex: 'w' } });
    expect(dashboardFor('d2').favorites).toEqual(['/b']);
    expect(parseDashboardFile(files.get('dashboard.json') ?? null).d1?.snapshot?.at).toBe(10);
  });

  test('a file that cannot be read is never overwritten', async () => {
    const written: string[] = [];
    resetDashboardForTests({ read: async () => { throw new Error('io'); }, write: async (_name, value) => { written.push(value); }, remove: async () => {} });
    await loadDashboard();
    toggleFavorite('d1', '/p');
    expect(dashboardFor('d1').favorites).toEqual(['/p']);
    expect(written).toEqual([]);
  });

  test('a broken or foreign file becomes no data instead of a made-up snapshot', () => {
    expect(parseDashboardFile('not json')).toEqual({});
    expect(parseDashboardFile(JSON.stringify({ version: 9, desktops: {} }))).toEqual({});
    const parsed = parseDashboardFile(JSON.stringify({ version: 1, desktops: { d1: {
      snapshot: { type: 'dashboard', at: 5, accounts: [{ id: 'x', agent: 'gemini' }], projects: [], sessions: [] },
      favorites: ['/ok', 7, ''], accounts: { codex: 'a', claude: 3 } } } }));
    expect(parsed.d1).toEqual({ snapshot: null, favorites: ['/ok'], accounts: { codex: 'a' } });
  });
});

describe('project shortcuts', () => {
  const projects = [
    { name: 'alfa', path: '/home/pessoa/p/alfa', root: '~/p' },
    { name: 'beta', path: '/home/pessoa/p/beta', root: '~/p' },
    { name: 'gama', path: '/home/pessoa/p/gama', root: '~/p' }
  ];

  test('sections keep favorites in the user order, then recent folders, then the rest', () => {
    const sections = projectSections(snapshot([], { projects, recent: ['/home/pessoa/p/gama', '/srv/solta', '/home/pessoa/p/beta'] }), ['/home/pessoa/p/beta']);
    expect(sections.favorites.map(project => project.name)).toEqual(['beta']);
    expect(sections.recent.map(project => [project.name, project.root])).toEqual([['gama', '~/p'], ['solta', '']]);
    expect(sections.all.map(project => project.name)).toEqual(['alfa']);
    expect(projectSections(snapshot([], { projects }), [], 'GA').all.map(project => project.name)).toEqual(['gama']);
    expect(projectSections(null, [])).toEqual({ favorites: [], recent: [], all: [] });
  });

  test('short paths hide the home folder and the middle of long paths', () => {
    expect(shortPath('/home/pessoa/p/alfa')).toBe('~/p/alfa');
    expect(shortPath('/Users/pessoa/a/b/c/d')).toBe('~/…/c/d');
    expect(shortPath('/srv/a/b/c')).toBe('/srv/…/b/c');
    expect(shortPath('C:\\Users\\pessoa\\code\\x\\y')).toBe('~\\…\\x\\y');
  });

  test('adding, moving and removing shortcuts only change the stored list', async () => {
    const files = new Map<string, string>();
    resetDashboardForTests({ read: async name => files.get(name) ?? null, write: async (name, value) => { files.set(name, value); }, remove: async () => {} }, true);
    addFavorite('d1', '/a');
    addFavorite('d1', '/b');
    addFavorite('d1', '/a');
    expect(dashboardFor('d1').favorites).toEqual(['/a', '/b']);
    moveFavorite('d1', '/b', -1);
    expect(dashboardFor('d1').favorites).toEqual(['/b', '/a']);
    moveFavorite('d1', '/b', -1);
    expect(dashboardFor('d1').favorites).toEqual(['/b', '/a']);
    removeFavorite('d1', '/b');
    expect(dashboardFor('d1').favorites).toEqual(['/a']);
    addFavorite('d1', 'x'.repeat(600));
    expect(dashboardFor('d1').favorites).toEqual(['/a']);
    await Promise.resolve();
    expect(JSON.parse(files.get('dashboard.json')!).desktops.d1.favorites).toEqual(['/a']);
  });
});
