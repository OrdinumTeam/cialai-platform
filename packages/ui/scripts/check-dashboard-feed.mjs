// SPDX-License-Identifier: Apache-2.0
// O retrato do Inicio so sai com a ponte conectada. A hidratacao resolve antes
// de o computador responder, e um pedido nessa janela vira nulo; postar esse
// retrato apagaria na casca as contas, os projetos e as sessoes que ela ja
// tinha. Aqui a pagina espera a conexao, repete a leitura das contas enquanto
// ela nao veio e nunca posta sem a lista.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const mocks = {
  native: 'export const isTauri=()=>false, hasBridge=()=>true, invoke=(command)=>fixture.invoke(command);',
  remote: `export const state=()=>fixture.remote;
    export const subscribeState=(listener)=>{ fixture.stateListeners.push(listener); return ()=>{ fixture.stateListeners.splice(fixture.stateListeners.indexOf(listener), 1); }; };`,
  runtime: `export const hydrate=async()=>{}, getState=()=>({ hydrated: true, sessions: fixture.sessions }), getRecent=()=>[], isDemo=()=>false;
    export const isViewed=(session)=>fixture.viewed.has(session.id);
    export const subscribe=(listener)=>{ fixture.runtimeListeners.push(listener); return ()=>{ fixture.runtimeListeners.splice(fixture.runtimeListeners.indexOf(listener), 1); }; };`,
  shell: 'export const isMobileShell=()=>true, postDashboard=(snapshot)=>{ fixture.posted.push(snapshot); };',
  'agent-profiles-demo': 'export const demoProfiles=()=>[];export const demoProfilesEnabled=()=>false;',
};

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/mobile/dashboard-feed.js', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
  plugins: [{ name: 'feed-boundaries', setup(api) {
    api.onResolve({ filter: /\.svg\?raw$/ }, ({ path }) => ({ path, namespace: 'glyph' }));
    api.onLoad({ filter: /.*/, namespace: 'glyph' }, () => ({ contents: 'export default "<svg></svg>";', loader: 'js' }));
    api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path }) => {
      const key = path.split('/').at(-1).replace(/\.jsx?$/, '');
      if (mocks[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
  } }],
});

const PROFILES = [{ id: 'codex', agent: 'codex', label: 'Codex' }, { id: 'claude-casa', agent: 'claude', label: 'Casa' }];
const REPOS = { roots: [], repos: [{ name: 'psicoapp', path: '/home/pessoa/Projects/psicoapp', root: '~/Projects' }] };
// O debounce de 2 s das sessoes encolhe para 20 ms aqui; a ordem entre os
// temporizadores continua a mesma e o intervalo de 60 s nao segura o processo.
const DEBOUNCE_CAP_MS = 20;
const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

function start({ status = 'disconnected', profiles = () => Promise.resolve(PROFILES) } = {}) {
  const fixture = {
    remote: { status }, posted: [], calls: [], stateListeners: [], runtimeListeners: [], viewed: new Set(),
    sessions: [{ id: 's1', name: 'psicoapp', cwd: '/home/pessoa/Projects/psicoapp', status: 'running', activity: { agent: 'codex' } }],
    profiles,
    invoke(command) {
      fixture.calls.push(command);
      if (command === 'agent_profiles') return fixture.profiles();
      if (command === 'list_repo_dirs') return Promise.resolve(REPOS);
      return Promise.reject(new Error(`comando inesperado: ${command}`));
    },
    connect() { fixture.remote = { status: 'connected' }; fixture.stateListeners.forEach((listener) => listener(fixture.remote)); },
    disconnect() { fixture.remote = { status: 'connecting' }; fixture.stateListeners.forEach((listener) => listener(fixture.remote)); },
    sessionsChanged() { fixture.runtimeListeners.forEach((listener) => listener({ type: 'sessions' })); },
    activity() { fixture.runtimeListeners.forEach((listener) => listener({ type: 'activity', id: 's1' })); },
  };
  const context = vm.createContext({
    fixture, module: { exports: {} }, exports: {}, require, console,
    setTimeout: (callback, ms) => setTimeout(callback, Math.min(ms, DEBOUNCE_CAP_MS)), clearTimeout,
    setInterval: (callback, ms) => { const handle = setInterval(callback, ms); handle.unref(); return handle; }, clearInterval,
    window: { __CIALAI_SHELL__: {} }, document: { documentElement: { lang: 'pt-BR', dataset: {} } },
    localStorage: { getItem: () => null, setItem: () => {} }, navigator: { language: 'pt-BR' },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const stop = context.module.exports.startDashboardFeed();
  return { fixture, stop };
}

const accountIds = (snapshot) => snapshot.accounts.map((account) => account.id);

test('desconectado na hidratacao nada sai, e ao conectar o retrato vai uma vez com as contas', async () => {
  const { fixture, stop } = start();
  try {
    await tick();
    assert.deepEqual(fixture.posted, [], 'sem ponte nao ha retrato');
    assert.deepEqual(fixture.calls, [], 'sem ponte a pagina nem pergunta ao computador');
    fixture.connect();
    await tick();
    assert.equal(fixture.posted.length, 1);
    assert.deepEqual(accountIds(fixture.posted[0]), ['codex', 'claude-casa']);
    assert.deepEqual(fixture.posted[0].projects.map((project) => project.name), ['psicoapp']);
    assert.deepEqual(fixture.posted[0].sessions.map((session) => session.id), ['s1']);
    assert.deepEqual(fixture.calls, ['agent_profiles', 'list_repo_dirs']);
  } finally { stop(); }
  assert.deepEqual(fixture.stateListeners, [], 'parar solta o ouvinte da ponte');
  assert.deepEqual(fixture.runtimeListeners, [], 'parar solta o ouvinte das sessoes');
});

test('sem a lista de contas o retrato nao sai; a lista anterior fica quando a leitura falha', async () => {
  const { fixture, stop } = start({ status: 'connected', profiles: () => Promise.reject(new Error('bridge_disconnected')) });
  try {
    await tick();
    assert.deepEqual(fixture.posted, [], 'contas desconhecidas nao viram lista vazia');
    assert.ok(fixture.calls.includes('agent_profiles'), 'a leitura foi tentada');
    fixture.profiles = () => Promise.resolve(PROFILES);
    fixture.connect();
    await tick();
    assert.equal(fixture.posted.length, 1);
    assert.deepEqual(accountIds(fixture.posted[0]), ['codex', 'claude-casa']);
    fixture.profiles = () => Promise.reject(new Error('bridge_disconnected'));
    fixture.connect();
    await tick();
    assert.equal(fixture.posted.length, 2, 'com lista anterior o retrato sai');
    assert.deepEqual(accountIds(fixture.posted[1]), ['codex', 'claude-casa'], 'a lista anterior fica');
  } finally { stop(); }
});

test('o evento de sessoes refaz a leitura das contas enquanto ela nao veio, e nao repete depois', async () => {
  const { fixture, stop } = start({ status: 'connected', profiles: () => Promise.reject(new Error('bridge_disconnected')) });
  try {
    await tick();
    assert.deepEqual(fixture.posted, []);
    fixture.profiles = () => Promise.resolve(PROFILES);
    fixture.sessionsChanged();
    await tick();
    assert.equal(fixture.posted.length, 1);
    assert.deepEqual(accountIds(fixture.posted[0]), ['codex', 'claude-casa']);
    assert.equal(fixture.calls.filter((command) => command === 'agent_profiles').length, 2, 'a segunda leitura veio do evento de sessoes');
    fixture.sessionsChanged();
    await tick();
    assert.equal(fixture.posted.length, 2);
    assert.equal(fixture.calls.filter((command) => command === 'agent_profiles').length, 2, 'com a lista em maos as sessoes nao releem as contas');
  } finally { stop(); }
});

test('a ponte caindo durante um envio pendente segura o retrato', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { fixture, stop } = start({ status: 'connected', profiles: () => pending });
  try {
    await tick();
    assert.deepEqual(fixture.calls, ['agent_profiles'], 'o envio esta parado na leitura das contas');
    fixture.disconnect();
    release(PROFILES);
    await tick();
    assert.deepEqual(fixture.posted, [], 'o retrato lido antes da queda nao sai');
    fixture.connect();
    await tick();
    assert.equal(fixture.posted.length, 1, 'a volta da ponte manda o retrato');
    assert.deepEqual(accountIds(fixture.posted[0]), ['codex', 'claude-casa']);
  } finally { stop(); }
});

test('atividade so manda retrato quando muda o que vira aviso: sino, vez do agente ou sessao em vista', async () => {
  const { fixture, stop } = start({ status: 'connected' });
  try {
    await tick();
    assert.equal(fixture.posted.length, 1);
    fixture.activity();
    await tick();
    assert.equal(fixture.posted.length, 1, 'CPU e saida do terminal nao mandam retrato');
    fixture.sessions[0].agentTurn = { state: 'waiting', waitingFor: 'permission' };
    fixture.activity();
    await tick();
    assert.equal(fixture.posted.length, 2, 'o agente pedindo permissao sai logo');
    assert.deepEqual({ ...fixture.posted[1].sessions[0].turn }, { state: 'waiting', waitingFor: 'permission' });
    fixture.sessions[0].attention = { kind: 'bell', message: 'Pediu atenção', at: 50 };
    fixture.activity();
    await tick();
    assert.equal(fixture.posted.length, 3);
    assert.equal(fixture.posted[2].sessions[0].attention.kind, 'bell');
    fixture.viewed.add('s1');
    fixture.activity();
    await tick();
    assert.equal(fixture.posted.length, 4, 'abrir a sessao no celular tambem muda o retrato');
    assert.equal(fixture.posted[3].sessions[0].viewed, true);
  } finally { stop(); }
});
