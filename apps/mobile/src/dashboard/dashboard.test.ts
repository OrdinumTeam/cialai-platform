import { beforeEach, describe, expect, test } from '@jest/globals';

import type { AgentAccount, DashboardMessage } from '../bridge/messages';
import { formatAge, formatDuration, formatReset, formatResetAt } from '../desktops/format';
import { getLocale, setLocale, t } from '../i18n';
import { accountLevel, accountWindows, agentAccounts, agentSummary, orderDesktops, orderProjects, projectSections, projectTint, sessionsIn, shortPath, usageLevel } from './model';
import { addFavorite, dashboardFor, forgetDashboard, loadDashboard, moveFavorite, parseDashboardFile, recordSnapshot, removeFavorite, resetDashboardForTests, toggleFavorite } from './store';

const window = (id: string, usedFraction: number, flags: { headline?: boolean; weekly?: boolean } = {}) =>
  ({ id, label: id, usedFraction, resetsAtMs: null, durationMs: null, headline: !!flags.headline, weekly: !!flags.weekly });
const account = (overrides: Partial<AgentAccount>): AgentAccount => ({
  id: 'codex', agent: 'codex', label: 'Codex', plan: null, active: false, state: 'ok', fetchedAtMs: 1, windows: [], ...overrides
});
const snapshot = (accounts: AgentAccount[] = [], extra: Partial<DashboardMessage> = {}): DashboardMessage =>
  ({ type: 'dashboard', at: 10, accounts, projects: [], sessions: [], recent: [], ...extra });

beforeEach(async () => { if (getLocale() !== 'pt-BR') await setLocale('pt-BR'); });

describe('usage levels', () => {
  test('normal below 75%, near up to the limit, exhausted at 100% and unavailable without a number', () => {
    expect(usageLevel(0.1)).toBe('normal');
    expect(usageLevel(0.75)).toBe('near');
    expect(usageLevel(0.99)).toBe('near');
    expect(usageLevel(1)).toBe('exhausted');
    expect(usageLevel(null)).toBe('unavailable');
    expect(usageLevel(Number.NaN)).toBe('unavailable');
  });

  test('Codex keeps the five hour and weekly windows apart, headline first', () => {
    const summary = agentSummary(snapshot([account({ active: true, windows: [
      window('weekly', 0.8, { weekly: true }), window('session', 0.2, { headline: true }), window('spark', 0.1)
    ] })]), 'codex');
    expect(summary.rows.map(row => row.id)).toEqual(['session', 'weekly']);
    expect(summary.level).toBe('near');
    expect(summary.readable).toBe(true);
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

  test('Codex shows the five hour and weekly windows apart, Claude Code every window it read', () => {
    const codex = account({ windows: [window('extra', 0.2), window('weekly', 0.4, { weekly: true }), window('session', 0.9, { headline: true })] });
    expect(accountWindows(codex).map(item => item.id)).toEqual(['session', 'weekly']);
    expect(accountLevel(codex)).toBe('near');
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
      { id: '1', name: 'a', cwd: '/p/app', status: 'running', agent: null },
      { id: '2', name: 'b', cwd: '/p/app/web', status: 'running', agent: null },
      { id: '3', name: 'c', cwd: '/p/application', status: 'running', agent: null },
      { id: '4', name: 'd', cwd: '/p/app', status: 'exited', agent: null },
      { id: '5', name: 'e', cwd: '/p/app/api', status: 'error', agent: null }
    ];
    expect(sessionsIn(snapshot([], { sessions }), '/p/app/').map(session => session.id)).toEqual(['1', '2']);
    const windows = [
      { id: 'w1', name: 'a', cwd: 'C:\\Users\\a\\proj', status: 'running', agent: null },
      { id: 'w2', name: 'b', cwd: 'C:\\Users\\a\\proj\\api', status: 'starting', agent: null },
      { id: 'w3', name: 'c', cwd: 'C:\\Users\\a\\project', status: 'running', agent: null }
    ];
    expect(sessionsIn(snapshot([], { sessions: windows }), 'C:\\Users\\a\\proj\\').map(session => session.id)).toEqual(['w1', 'w2']);
  });

  test('each project keeps the same tint', () => {
    expect(projectTint('psicoapp')).toBe(projectTint('psicoapp'));
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
