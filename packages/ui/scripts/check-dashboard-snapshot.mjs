// SPDX-License-Identifier: Apache-2.0
// Retrato que a pagina manda ao Inicio do aplicativo e o pedido que a casca
// faz ao abrir o terminal. O retrato leva so o que a tela usa, sem e-mail, e
// o pedido vale uma vez por id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const mocks = {
  native: 'export const invoke=async()=>null;',
  'agent-profiles-demo': 'export const demoProfiles=()=>[];export const demoProfilesEnabled=()=>false;',
};

async function load(entry) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(entry, import.meta.url))],
    bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
    plugins: [{ name: 'snapshot-boundaries', setup(api) {
      api.onResolve({ filter: /\.svg\?raw$/ }, ({ path }) => ({ path, namespace: 'glyph' }));
      api.onLoad({ filter: /.*/, namespace: 'glyph' }, () => ({ contents: 'export default "<svg></svg>";', loader: 'js' }));
      api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path }) => {
        const key = path.split('/').at(-1).replace(/\.jsx?$/, '');
        if (mocks[key]) return { path: key, namespace: 'fixture' };
      });
      api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
    } }],
  });
  const window = { __CIALAI_SHELL__: null };
  const context = vm.createContext({ module: { exports: {} }, exports: {}, require, console, window,
    document: { documentElement: { lang: 'pt-BR', dataset: {} } }, localStorage: { getItem: () => null, setItem: () => {} }, navigator: { language: 'pt-BR' } });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return { exports: context.module.exports, window };
}

const { exports: snapshot } = await load('../src/mobile/dashboard-snapshot.js');
const { exports: shell, window } = await load('../src/lib/shell.js');

const profiles = [
  { id: 'codex', agent: 'codex', label: 'Codex', plan: 'plus', active: true, account: 'pessoa@exemplo.com', usage: {
    status: { kind: 'ok' }, fetchedAtMs: 1000, headlineId: 'session', weeklyId: 'weekly',
    windows: [
      { id: 'session', label: 'session', usedFraction: 0.19, resetsAtMs: 5000, durationMs: 18_000_000 },
      { id: 'weekly', label: 'duration', usedFraction: 1.4, resetsAtMs: 9000, durationMs: 604_800_000 },
      { id: 'sem-numero', label: 'x' },
    ] } },
  { id: 'claude-trabalho', agent: 'claude', label: 'Trabalho', needsLogin: true, account: 'outra@exemplo.com' },
  { id: 'outro', agent: 'gemini', label: 'Fora' },
];

test('o retrato leva contas, janelas, projetos e sessoes sem o e-mail', () => {
  const result = JSON.parse(JSON.stringify(snapshot.buildDashboardSnapshot({
    accounts: profiles,
    repos: { roots: [], repos: [{ name: 'psicoapp', path: '/home/pessoa/Projects/psicoapp', root: '~/Projects' }, { name: 'sem caminho' }] },
    sessions: [{ id: 's1', name: 'psicoapp', cwd: '/home/pessoa/Projects/psicoapp', status: 'running', activity: { agent: 'codex' } }, { id: 2 }],
    now: 42,
  })));
  assert.equal(result.type, 'dashboard');
  assert.equal(result.at, 42);
  assert.doesNotMatch(JSON.stringify(result), /exemplo\.com/);
  assert.deepEqual(result.accounts.map((account) => [account.id, account.state]), [['codex', 'ok'], ['claude-trabalho', 'needsLogin']]);
  const [codex] = result.accounts;
  assert.equal(codex.plan, 'plus');
  assert.equal(codex.windows.length, 2, 'janela sem numero fica de fora');
  assert.deepEqual(codex.windows.map((window) => [window.id, window.usedFraction, window.headline, window.weekly]),
    [['session', 0.19, true, false], ['weekly', 1, false, true]]);
  assert.deepEqual(result.projects, [{ name: 'psicoapp', path: '/home/pessoa/Projects/psicoapp', root: '~/Projects' }]);
  const pink = { light: { base: '#E23B84' }, dark: { base: '#FF7AB2' } };
  assert.deepEqual(result.sessions.map(({ tone, ...session }) => session), [{ id: 's1', name: 'psicoapp', cwd: '/home/pessoa/Projects/psicoapp', status: 'running', agent: 'codex',
    color: null, icon: null, attention: null, turn: null, viewed: false }]);
  assert.deepEqual([result.sessions[0].tone.light.base, result.sessions[0].tone.dark.base], [pink.light.base, pink.dark.base], 'sem cor o tom e o rosa');
  assert.equal(codex.weeklyState, 'available');
  assert.equal(result.accounts[1].weeklyState, 'unknown', 'login pendente nao vira 0% nem sem limite');
});

test('cada sessao leva cor, icone, atencao e a vez do agente; so o que a casca usa', () => {
  const result = JSON.parse(JSON.stringify(snapshot.buildDashboardSnapshot({
    sessions: [
      { id: 'a', name: 'site', cwd: '/p', status: 'running', color: 'verde', icon: 'rocket',
        attention: { kind: 'bell', message: 'Pediu atenção', at: 77 }, agentTurn: { state: 'waiting', waitingFor: 'permission', sinceMs: 5 } },
      { id: 'b', cwd: '/p', status: 'running', color: 'inexistente', icon: '../x', attention: { kind: 'exited', message: 'saiu', at: 9 }, agentTurn: { state: 'pensando' } },
      { id: 'c', cwd: '/p', status: 'running', attention: { kind: 'notify', message: 'x'.repeat(400), at: 10 } },
    ],
    viewed: (session) => session.id === 'b',
  })));
  const [site, other, long] = result.sessions;
  assert.equal(site.color, 'verde');
  assert.equal(site.tone.light.base.toLowerCase(), '#1f9d5b');
  assert.match(site.tone.light.text, /^#[0-9a-f]{6}$/i);
  assert.equal(site.icon, 'rocket');
  assert.deepEqual(site.attention, { kind: 'bell', at: 77, message: 'Pediu atenção' });
  assert.deepEqual(site.turn, { state: 'waiting', waitingFor: 'permission' });
  assert.equal(site.viewed, false);
  assert.deepEqual([other.color, other.icon, other.attention, other.turn, other.viewed], [null, null, null, null, true],
    'cor e icone desconhecidos, saida do processo e estado estranho ficam de fora');
  assert.equal(long.attention.message.length, snapshot.ATTENTION_TEXT_MAX);
});

test('o semanal de cada conta vem nos tres estados da Barra de IA', () => {
  const usage = (windows, weeklyId = 'weekly', status = 'ok') => ({ status: { kind: status }, fetchedAtMs: 1, headlineId: 'session', weeklyId, windows });
  const session = { id: 'session', label: 'session', usedFraction: 0.2, durationMs: 18_000_000 };
  const states = snapshot.buildDashboardSnapshot({ accounts: [
    { id: 'zero', agent: 'claude', usage: usage([session, { id: 'weekly', label: 'weeklyAll', usedFraction: 0 }]) },
    { id: 'mensal', agent: 'codex', usage: usage([session, { id: 'weekly', label: 'duration', usedFraction: 0.4, durationMs: 30 * 86_400_000 }]) },
    { id: 'sem', agent: 'codex', usage: usage([session], null) },
    { id: 'erro', agent: 'codex', usage: { status: { kind: 'error' } } },
    { id: 'lendo', agent: 'claude', usage: { status: { kind: 'ok' } } },
    { id: 'livre', agent: 'claude', usage: { status: { kind: 'unsupported' }, windows: [] } },
  ] }).accounts.map((account) => [account.id, account.weeklyState]);
  assert.deepEqual(states, [['zero', 'available'], ['mensal', 'none'], ['sem', 'none'], ['erro', 'unknown'], ['lendo', 'unknown'], ['livre', 'none']]);
});

test('o agente da sessao chega pelo nome que o computador mostra e o projeto do Windows tem nome', () => {
  const result = snapshot.buildDashboardSnapshot({
    repos: { repos: [{ path: 'C:\\Users\\pessoa\\proj\\' }] },
    sessions: [
      { id: 'a', cwd: '/p', status: 'running', activity: { agent: 'Claude Code' } },
      { id: 'b', cwd: '/p', status: 'running', activity: { agent: null, foreground: { agent: 'Codex' } } },
      { id: 'c', cwd: '/p', status: 'running', activity: { agent: 'Gemini' } },
      { id: 'd', cwd: '/p', status: 'running' },
    ],
  });
  assert.deepEqual(result.sessions.map((session) => session.agent), ['claude', 'codex', null, null]);
  assert.equal(result.projects[0].name, 'proj');
});

test('integracoes ausentes viram listas vazias e os limites valem', () => {
  const empty = snapshot.buildDashboardSnapshot({ accounts: null, repos: null, sessions: undefined, now: 1 });
  assert.deepEqual([empty.accounts, empty.projects, empty.sessions].map((list) => list.length), [0, 0, 0]);
  assert.equal(empty.recent.length, 0);
  const many = snapshot.buildDashboardSnapshot({ repos: { repos: Array.from({ length: 900 }, (_, index) => ({ name: `p${index}`, path: `/p${index}` })) } });
  assert.equal(many.projects.length, snapshot.DASHBOARD_LIMITS.projects);
});

test('o retrato nativo preserva o apelido de padroes e nomeados sem mudar a caixa', () => {
  const result = snapshot.buildDashboardSnapshot({ accounts: [
    { id: 'codex', agent: 'codex', label: 'Minha eQUIPE', alias: 'Minha eQUIPE' },
    { id: 'claude-work', agent: 'claude', label: 'Pessoal e Trabalho', alias: 'Pessoal e Trabalho' },
  ] });
  assert.deepEqual([...result.accounts.map((account) => account.label)], ['Minha eQUIPE', 'Pessoal e Trabalho']);
});

test('as pastas recentes do telefone seguem na ordem, sem vazios e com limite', () => {
  const recent = ['/p/nova', '', 42, '/p/velha', ...Array.from({ length: 20 }, (_, index) => `/r${index}`)];
  const result = snapshot.buildDashboardSnapshot({ recent, now: 1 });
  assert.equal(result.recent.length, snapshot.DASHBOARD_LIMITS.recent);
  assert.deepEqual([...result.recent.slice(0, 3)], ['/p/nova', '/p/velha', '/r0']);
});

test('o pedido da casca vale uma vez por id', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  window.__CIALAI_SHELL__ = { intent: { id: 'i1', kind: 'new-session', cwd: '/p' } };
  assert.deepEqual({ ...shell.takeShellIntent(storage) }, { id: 'i1', kind: 'new-session', cwd: '/p' });
  assert.equal(shell.takeShellIntent(storage), null, 'recarregar nao repete o pedido');
  window.__CIALAI_SHELL__ = { intent: { id: 'i3', kind: 'pick-project' } };
  assert.deepEqual({ ...shell.takeShellIntent(storage) }, { id: 'i3', kind: 'pick-project' });
  window.__CIALAI_SHELL__ = { intent: { id: 'i2', kind: 'apagar-tudo' } };
  assert.equal(shell.takeShellIntent(storage), null);
  window.__CIALAI_SHELL__ = {};
  assert.equal(shell.takeShellIntent(storage), null);
});

test('o pedido que chega com a pagina aberta, como o toque num aviso, vale uma vez e avisa quem espera', () => {
  const store = new Map();
  const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  window.__CIALAI_SHELL__ = { theme: 'dark' };
  let avisos = 0;
  const parar = shell.onShellIntent(() => { avisos += 1; });
  shell.receiveShellMessage({ type: 'intent', intent: { id: 'aviso-1', kind: 'session', sessionId: 's1' } });
  assert.equal(avisos, 1);
  assert.equal(window.__CIALAI_SHELL__.theme, 'dark', 'o resto do bootstrap fica');
  assert.deepEqual({ ...shell.takeShellIntent(storage) }, { id: 'aviso-1', kind: 'session', sessionId: 's1' });
  assert.equal(shell.takeShellIntent(storage), null, 'o mesmo aviso nao abre duas vezes');
  shell.receiveShellMessage({ type: 'intent', intent: { id: 'x', kind: 'apagar-tudo' } });
  shell.receiveShellMessage({ type: 'intent' });
  assert.equal(avisos, 1, 'pedido fora do formato nao avisa');
  parar();
  shell.receiveShellMessage({ type: 'intent', intent: { id: 'aviso-2', kind: 'profiles' } });
  assert.equal(avisos, 1, 'quem parou de ouvir nao recebe');
  window.__CIALAI_SHELL__ = {};
});
