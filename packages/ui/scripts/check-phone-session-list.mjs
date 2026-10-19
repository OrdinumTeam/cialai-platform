// SPDX-License-Identifier: Apache-2.0
// Lista de terminais do celular: fase de cada sessão, filtros, busca sem
// acento e o card compacto. A ordem vem pronta de `orderedSessions()` e
// nada aqui pode mexer nela.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { countSessions, filterSessions, inFilter, matchesQuery, sessionPhase } from '../src/terminals/phone-session-list.js';

test('a fase separa erro, finalizada, pausada e ativa a partir do estado descrito', () => {
  assert.equal(sessionPhase({ code: 'error' }), 'error');
  assert.equal(sessionPhase({ code: 'failed' }), 'error');
  assert.equal(sessionPhase({ code: 'exited' }), 'finished');
  assert.equal(sessionPhase({ code: 'disconnected' }), 'finished');
  assert.equal(sessionPhase({ code: 'stopped' }), 'paused');
  for (const code of ['agent-busy', 'agent-waiting', 'agent-done', 'agent-idle', 'active', 'open', 'idle', 'running', 'starting']) {
    assert.equal(sessionPhase({ code }), 'active', code);
  }
});

test('Ativas reúne ativas e pausadas; Finalizadas reúne finalizadas e com erro', () => {
  assert.ok(inFilter('active', 'active') && inFilter('paused', 'active'));
  assert.ok(!inFilter('finished', 'active') && !inFilter('error', 'active'));
  assert.ok(inFilter('finished', 'finished') && inFilter('error', 'finished'));
  assert.ok(!inFilter('paused', 'finished'));
  for (const phase of ['active', 'paused', 'finished', 'error']) assert.ok(inFilter(phase, 'all'));
});

const sessions = [
  { id: 'a', name: 'Plantão', subtitle: '', cwd: '/home/ana/plantao', phase: 'active', pinned: true },
  { id: 'b', name: 'deploy', subtitle: 'Servidor de produção', cwd: '/srv/deploy', phase: 'paused' },
  { id: 'c', name: 'frontend', subtitle: '', cwd: '/home/ana/código/frontend', phase: 'finished' },
  { id: 'd', name: 'docs', subtitle: '', cwd: '/home/ana/docs', phase: 'error' },
];
const phaseOf = (session) => session.phase;

test('a busca olha nome, subtítulo e pasta, sem diferenciar acento nem caixa', () => {
  assert.ok(matchesQuery(sessions[0], 'plantao'));
  assert.ok(matchesQuery(sessions[1], 'PRODUCAO'));
  assert.ok(matchesQuery(sessions[2], 'codigo'));
  assert.ok(matchesQuery(sessions[3], '   '));
  assert.ok(!matchesQuery(sessions[3], 'xyz'));
});

test('filtrar preserva a ordem recebida, com as fixadas na frente', () => {
  assert.deepEqual(filterSessions(sessions, { phaseOf }).map((s) => s.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterSessions(sessions, { filter: 'active', phaseOf }).map((s) => s.id), ['a', 'b']);
  assert.deepEqual(filterSessions(sessions, { filter: 'finished', phaseOf }).map((s) => s.id), ['c', 'd']);
  assert.deepEqual(filterSessions(sessions, { filter: 'finished', query: 'docs', phaseOf }).map((s) => s.id), ['d']);
  assert.equal(countSessions(sessions, 'active', phaseOf), 2);
});

// O card, renderizado com o runtime trocado por dados fixos.
const boundaries = {
  runtime: `import {profileBadge} from './src/terminals/profile-badge.js'; export const describe=(s)=>fixture.status[s.id], runningLabel=(s)=>fixture.running[s.id]||null, sessionAccent=(s)=>s.color?{light:'#1a4fa0',dark:'#4a8ae6'}:null, sessionProfileLabel=(activity)=>profileBadge(activity,fixture.account);`,
  files: `export const fmtCpu=(v)=>v+'%', fmtMemory=(v)=>Math.round(v/1048576)+' MB', fmtElapsed=()=>'2 min', shortPath=(p)=>p.replace('/home/ana','~');`,
  hooks: `export const useRuntimeEvents=()=>{};`,
};
const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/terminals/ui/PhoneSessionCard.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react', 'lucide-react'],
  plugins: [{ name: 'card-boundaries', setup(api) {
    // O ícone padrão da sessão traz o glifo do agente como texto SVG.
    api.onResolve({ filter: /\.svg\?raw$/ }, ({ path }) => ({ path, namespace: 'glyph' }));
    api.onLoad({ filter: /.*/, namespace: 'glyph' }, () => ({ contents: 'export default "<svg></svg>";', loader: 'js' }));
    api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path }) => {
      const key = path.split('/').at(-1).replace(/\.jsx?$/, '');
      if (boundaries[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: boundaries[path], loader: 'js', resolveDir: fileURLToPath(new URL('..', import.meta.url)) }));
  } }],
});

const fixture = {
  status: {
    busy: { code: 'agent-busy', label: 'Processando', tone: 'busy', animated: true },
    paused: { code: 'stopped', label: 'Pausada', tone: 'warn', animated: false },
    done: { code: 'exited', label: 'Processo finalizado', tone: 'muted', animated: false },
    failed: { code: 'failed', label: 'Encerrado com código 1', tone: 'bad', animated: false },
    lost: { code: 'agent-busy', label: 'Processando', tone: 'busy', animated: true },
  },
  running: { busy: { text: 'Codex', agent: true }, lost: { text: 'Claude Code', agent: true } },
};
function card(session) {
  const context = vm.createContext({
    fixture, module: { exports: {} }, exports: {}, require: createRequire(import.meta.url),
    document: { documentElement: { lang: 'pt-BR', dataset: {} } }, localStorage: { getItem: () => null, setItem: () => {} },
    window: {}, Date,
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const { default: Card } = context.module.exports;
  return renderToStaticMarkup(React.createElement(Card, { session, onSelect() {}, onMenu() {}, onClose() {} }));
}
const base = { status: 'running', cwd: '/home/ana/psicoapp', subtitle: '', pinned: false, color: null };

test('o selo do celular usa o mesmo apelido e deixa o padrao sem apelido sem selo', () => {
  const session = { ...base, id: 'busy', name: 'projeto', activity: { agent: 'Codex', profile: null } };
  fixture.account = { id: 'codex', label: 'Minha eQUIPE', alias: 'Minha eQUIPE' };
  assert.match(card(session), /terminais-card__profile[^>]*>Minha eQUIPE</);
  fixture.account = { id: 'codex', label: 'pessoa' };
  assert.doesNotMatch(card(session), /terminais-card__profile/);
  fixture.account = null;
  session.activity = { agent: 'Codex', profile: 'codex-work', profileName: 'WORK' };
  assert.match(card(session), /terminais-card__profile[^>]*>WORK</);
});

test('a falha no celular oferece encerrar acima do estado', () => {
  fixture.status.openError = { code: 'error', label: 'Falha ao abrir', tone: 'bad' };
  const html = card({ ...base, id: 'openError', name: 'projeto', status: 'error', error: 'Pasta não encontrada' });
  assert.ok(html.indexOf('Encerrar sessão') < html.indexOf('Falha ao abrir'));
  assert.match(html, /title="Pasta não encontrada"/);
});

test('o card ativo mostra agente, pasta, estado, tempo, CPU, memória e o botão redondo', () => {
  const html = card({ ...base, id: 'busy', name: 'psicoapp', jobStartedAt: 1, activity: { available: true, cpu: 21, memory: 1363148800 } });
  assert.match(html, /phone-session session-scope phone-session--active/);
  assert.match(html, /phone-session__agent is-agent">Codex/);
  assert.match(html, /~\/psicoapp/);
  assert.match(html, /Processando/);
  assert.match(html, /2 min/);
  assert.match(html, /<em>CPU<\/em> 21%/);
  assert.match(html, /<em>Mem<\/em> 1300 MB/);
  assert.match(html, /aria-label="Abrir psicoapp"/);
  assert.match(html, /aria-label="Ações de psicoapp"/);
});

test('memória sem medida não vira número inventado', () => {
  const zero = card({ ...base, id: 'busy', name: 'psicoapp', activity: { available: true, cpu: 0, memory: 0 } });
  assert.match(zero, /<em>CPU<\/em> 0%/);
  assert.doesNotMatch(zero, /<em>Mem/);
  const unread = card({ ...base, id: 'busy', name: 'psicoapp', activity: { available: false, cpu: 21, memory: 1363148800 } });
  assert.doesNotMatch(unread, /<em>(CPU|Mem)/);
});

test('cada fase tem sua classe e o terminal sem agente vira Terminal padrão', () => {
  assert.match(card({ ...base, id: 'paused', name: 'frontend', activity: null }), /phone-session--paused/);
  const done = card({ ...base, id: 'done', name: 'docs', status: 'exited', activity: null });
  assert.match(done, /phone-session--finished/);
  assert.match(done, /Terminal padrão/);
  assert.doesNotMatch(done, /<em>CPU/, 'sessão finalizada não mostra medida');
  assert.match(card({ ...base, id: 'failed', name: 'infra', status: 'exited', activity: null }), /phone-session--error/);
});

test('a queda da ponte aparece numa pílula própria, sem trocar o estado do agente', () => {
  const html = card({ ...base, id: 'lost', name: 'deploy', status: 'disconnected', activity: { available: true, cpu: 4, memory: 0 } });
  assert.match(html, /phone-session--active/);
  assert.match(html, /Processando/);
  assert.match(html, /phone-badge--warning">Sessão desconectada/);
});

test('nome longo fica inteiro no texto e o corte é feito pelo estilo', () => {
  const name = 'sessao-com-um-nome-muito-longo-para-caber-numa-linha-do-celular';
  const html = card({ ...base, id: 'busy', name, pinned: true, color: 'azul', activity: null });
  assert.match(html, new RegExp(`phone-session__name">${name}<`));
  assert.match(html, /has-color is-pinned/);
  assert.match(html, /aria-label="Fixada"/);
  assert.match(html, /Medindo/);
});

const css = readFileSync(fileURLToPath(new URL('../src/views/Terminais.css', import.meta.url)), 'utf8');
const phoneRule = (selector) => css.split('\n').find((line) => line.startsWith(`[data-form-factor="phone"] ${selector} {`)) || '';

test('o card leva o tom da sessão como no computador, e sem cor o tom é o rosa', () => {
  const plain = card({ ...base, id: 'busy', name: 'psicoapp', activity: { agent: 'Codex', available: true, cpu: 1, memory: 0 } });
  assert.match(plain, /class="phone-session session-scope phone-session--active"/);
  assert.match(plain, /--session-accent-light:#E23B84/);
  assert.match(plain, /--session-accent-dark:#FF7AB2/);
  assert.match(plain, /--session-accent-text-light:/);
  const blue = card({ ...base, id: 'busy', name: 'psicoapp', color: 'azul', activity: null });
  assert.match(blue, /--session-accent-light:#1A4FA0/);
  assert.match(blue, /phone-session session-scope phone-session--active has-color/);
  // O runtime antigo devolvia nulo sem cor; o card não depende mais dele.
  const source = readFileSync(fileURLToPath(new URL('../src/terminals/ui/PhoneSessionCard.jsx', import.meta.url)), 'utf8');
  assert.doesNotMatch(source, /sessionAccent\b|--terminais-accent-light/);
  assert.match(source, /style=\{sessionAccentStyle\(session\)\}/);
});

test('todo card mostra o ícone da sessão antes do nome, solto e no tom dela', () => {
  const agent = card({ ...base, id: 'busy', name: 'psicoapp', activity: { agent: 'Codex', available: true, cpu: 1, memory: 0 } });
  assert.match(agent, /session-icon session-icon--agent phone-session__icon[^>]*>[\s\S]*?<\/span><span class="phone-session__name">psicoapp</);
  const shell = card({ ...base, id: 'done', name: 'docs', status: 'exited', activity: null });
  assert.match(shell, /session-icon session-icon--default phone-session__icon/);
  const chosen = card({ ...base, id: 'busy', name: 'site', icon: 'globe', activity: null });
  assert.match(chosen, /session-icon session-icon--custom phone-session__icon/);
  assert.match(phoneRule('.phone-session__icon'), /color: var\(--session-accent-text\)/);
  assert.doesNotMatch(phoneRule('.phone-session__icon'), /background/);
});

test('a atenção aparece como no computador, numa linha compacta e no tom semântico', () => {
  const finished = card({ ...base, id: 'busy', name: 'api', activity: null, attention: { kind: 'finished', message: 'pytest concluído' } });
  assert.match(finished, /has-attention has-attention--finished/);
  assert.match(finished, /phone-session__attention phone-session__attention--finished"><svg[\s\S]*?<span>pytest concluído<\/span>/);
  const bell = card({ ...base, id: 'busy', name: 'api', activity: null, attention: { kind: 'bell', message: 'Sinal do terminal' } });
  assert.match(bell, /phone-session__attention--bell/);
  // Encerramento e falha já estão no estado escrito.
  for (const kind of ['exited', 'error']) {
    assert.doesNotMatch(card({ ...base, id: 'done', name: 'x', status: 'exited', activity: null, attention: { kind, message: 'fim' } }), /phone-session__attention/);
  }
  assert.match(phoneRule('.phone-session__attention--finished'), /var\(--phone-success\)/);
  assert.match(css, /\.phone-session__attention--bell,\n\[data-form-factor="phone"\] \.phone-session__attention--notify \{ color: var\(--phone-warning\); \}/);
});

test('a barra lateral aparece em todo card, no tom da sessão, também pausada', () => {
  assert.match(phoneRule('.phone-session.session-scope::before'), /width: 4px;[^}]*background: var\(--session-accent\)/);
  assert.doesNotMatch(css, /\.phone-session\.has-color::before/, 'a barra não depende mais de cor escolhida');
  assert.doesNotMatch(phoneRule('.phone-session'), /--phone-success|--terminais-accent/, 'o tom padrão é o rosa, nunca o verde');
  assert.doesNotMatch(css, /\.phone-session--paused \{ --terminais-accent/, 'pausada só apaga o ponto');
  assert.match(css, /\.phone-session--paused \.terminais-card__dot,\n\[data-form-factor="phone"\] \.phone-session--finished \.terminais-card__dot \{ background: var\(--phone-neutral\); \}/);
});

test('agente, atividade e botão de abrir seguem o tom da sessão; pronto fica no verde', () => {
  assert.match(phoneRule('.phone-session__agent.is-agent'), /color: var\(--session-accent-text\)/);
  assert.match(phoneRule('.phone-session__open'), /background: var\(--session-accent-soft\); color: var\(--session-accent-text\)/);
  assert.doesNotMatch(phoneRule('.phone-session__open'), /--phone-primary/);
  assert.match(css, /:is\(\.phone-session__head,\.phone-terminal__heading\) \.terminais-card__dot--busy,\n\[data-form-factor="phone"\] :is\(\.phone-session,\.phone-terminal__heading\) \.terminais-activity i \{ background: var\(--session-accent\); \}/);
  assert.match(css, /:is\(\.phone-session__head,\.phone-terminal__heading\) \.terminais-card__dot--ok \{ background: var\(--phone-success\); \}/);
});
