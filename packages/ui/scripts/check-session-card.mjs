// SPDX-License-Identifier: Apache-2.0
// Renderiza o SessionCard que vai para producao com o runtime real e uma
// amostra de uso publicada pelo hook, sem PTY, rede ou projeto do usuario.
// O dado de esforco continua chegando na amostra; o card nao pode mostra-lo.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mocks = {
  renderer: `const off = () => ({dispose(){}}); export class Terminal {
    constructor(options) { this.options=options; this.cols=options.cols; this.rows=options.rows; this.parser={registerOscHandler:off}; this.buffer={active:{}}; }
    onData=off; onBinary=off; onBell=off; onResize(){return {dispose(){}};}
    open(){} loadAddon(addon){addon.term=this;} attachCustomKeyEventHandler(){} write(_data,done){done?.();}
    resize(){} reset(){} focus(){} dispose(){}
  } export class FitAddon {fit(){} proposeDimensions(){return {cols:80,rows:24};}} export class SearchAddon {} export class WebglAddon {onContextLoss(){} dispose(){}} export class WebLinksAddon {}`,
  native: `export const isTauri = () => fixture.desktop; export const hasBridge = () => true;
    export const NATIVE_ONLY_MESSAGE = 'macOS'; export const invoke = async () => { throw new Error('sem ponte no gate'); };
    export const listen = async () => () => {}; export const createChannel = async (onmessage) => ({onmessage});
    export const chooseDirectory = async () => null;`,
  downloads: 'export const openExternal = async () => {};',
  theme: 'export const buildTheme = () => ({}); export const terminalFont = () => "mono"; export const watchTheme = () => () => {};',
  layout: 'export const getLayout = () => ({fontSize:13}); export const subscribeLayout = () => () => {};',
  remote: 'export const state = () => ({status:"connected",features:[]}); export const subscribeState = () => () => {};',
  shell: 'export const isPhone = () => !fixture.desktop; export const onShellLock = () => () => {};',
  hooks: 'export const useRuntimeEvents = () => {};',
  ui: 'export const useToast = () => () => {}; export const AppModal = () => null;',
  drag: 'export const wasDragged = () => false;',
};

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/terminals/ui/SessionCard.jsx', import.meta.url))], bundle: true, write: false, format: 'cjs',
  external: ['react', 'react-dom', 'lucide-react'],
  plugins: [{ name: 'session-card-boundaries', setup(api) {
    api.onResolve({ filter: /./ }, ({ path }) => {
      if (path.startsWith('@xterm/')) return { path: 'renderer', namespace: 'fixture' };
      const key = path.split('/').at(-1)?.replace(/\.jsx?$/, '');
      if (mocks[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
  } }],
});

// Amostra publicada pelo hook de linha de estado do Claude Code, com o
// esforco presente como o Rust o publica hoje.
const CWD = '/fixture/projeto';
const NOW = Date.now();
function sample({ status = 'running', agentTurn = null, outputAgeMs = null, cpuPercent = 12.5, sampleAt = NOW - 300, evidenceSince = NOW - 60_000 } = {}) {
  return {
    id: 'fixture', name: 'projeto', status, cwd: CWD, pinned: false, color: null, subtitle: null,
    lastOutputAt: 0, jobStartedAt: null, attention: null,
    agentTurn, outputAgeMs, metricsAt: sampleAt, evidenceSince, spawnToken: null,
    activity: {
      available: true, cpu: cpuPercent, memory: 268435456, agent: 'Claude Code',
      profile: 'claude', profileName: 'claude', configDir: '/fixture/.claude',
      shellCwd: CWD, foreground: { pid: 4242, agent: 'Claude Code', command: 'claude', stopped: false, cwd: CWD, profile: 'claude' },
      usage: {
        agent: 'Claude Code', plan: 'Max', profile: 'claude', model: 'Fable 5.1', updatedAtMs: Date.now(),
        windows: [{ id: 'session', label: 'Sessão', usedPercent: 37, resetsAtMs: null }],
        sessions: [{ sessionId: 'demo', cwd: CWD, model: 'Fable 5.1', effort: 'max', contextUsedPercent: 42, costUsd: 1.83 }],
      },
    },
  };
}

function render({ touch = false, session = sample(), menu = true } = {}) {
  const fixture = { desktop: !touch };
  const context = vm.createContext({
    fixture, console, URLSearchParams, Uint8Array, ArrayBuffer,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: { getItem: () => null, setItem: () => {} },
    window: { location: { search: '' }, addEventListener() {}, devicePixelRatio: 1, matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }) },
    document: { hasFocus: () => true, visibilityState: 'visible', addEventListener() {}, body: { appendChild() {} }, createElement: () => ({ isConnected: true, setAttribute() {}, appendChild() {} }) },
    module: { exports: {} }, exports: {}, require: createRequire(import.meta.url),
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const Card = context.module.exports.default;
  return renderToStaticMarkup(React.createElement(Card, {
    session, touch, selected: false, dragging: false, renaming: false,
    onSelect() {}, onMenu: menu ? () => {} : undefined, onRename() {}, onRenameDone() {},
  }));
}

const EFFORT_WORDS = /Esforço|Esfuerzo|effort|reasoning/i;

test('o card mostra modelo, uso do plano e contexto no computador e nao mostra esforco', () => {
  const html = render();
  assert.match(html, /terminais-card__model[^>]*>Fable 5\.1</, 'o modelo continua na linha do agente');
  assert.match(html, /terminais-card__plan[^>]*>\s*37\s*%/u, 'a porcentagem da janela do plano continua no card');
  assert.match(html, /Contexto 42\s*%/u, 'a tag de contexto continua no card');
  assert.match(html, /US\$\s*1,83/u, 'o custo estimado continua no card');
  assert.doesNotMatch(html, EFFORT_WORDS, 'nenhum rotulo de esforco pode sobrar no card');
  assert.doesNotMatch(html, />max</, 'o nivel cru de esforco nao pode vazar como texto');
});

test('o mesmo card no modo touch tambem nao mostra esforco', () => {
  const html = render({ touch: true });
  assert.match(html, /terminais-card__model[^>]*>Fable 5\.1</);
  assert.match(html, /terminais-card__plan[^>]*>\s*37\s*%/u);
  assert.match(html, /Contexto 42\s*%/u);
  assert.doesNotMatch(html, EFFORT_WORDS);
  // No toque o botao de tres pontos existe, com alvo maior, e abre a folha de
  // acoes em vez do menu ancorado, que nao tem onde ancorar num aparelho.
  assert.match(html, /terminais-card__menu/);
  assert.match(html, /width="20" height="20"/, 'o icone do toque e maior que o do computador');
  assert.doesNotMatch(render({ touch: true, menu: false }), /terminais-card__menu/, 'sem manipulador o botao nao aparece');
});

test('sem amostra do hook a linha do agente some sem quebrar o card', () => {
  const bare = sample();
  bare.activity.usage = null;
  const html = render({ session: bare });
  assert.doesNotMatch(html, /terminais-card__agent-row/);
  assert.match(html, /terminais-card__running/);
  assert.doesNotMatch(html, EFFORT_WORDS);
});

/* ── estado de atividade, EST-01.5 ─────────────────────────────────── */

test('com o turno em andamento o card anima as tres barras', () => {
  const html = render({ session: sample({ agentTurn: { state: 'busy', sinceMs: NOW - 5000 } }) });
  assert.match(html, /terminais-activity/, 'as barras aparecem enquanto o agente processa');
  assert.match(html, /Processando/);
  assert.doesNotMatch(html, /Processo em execução|Recebendo saída/, 'os rotulos de processo sairam do card');
});

test('com a resposta entregue o card para de animar', () => {
  const html = render({ session: sample({ agentTurn: { state: 'done', sinceMs: NOW - 5000 } }) });
  assert.doesNotMatch(html, /terminais-activity/, 'nenhuma barra depois que o turno fechou');
  assert.match(html, /terminais-card__dot--ok/);
  assert.match(html, /Resposta entregue/);
});

test('o agente que parou para perguntar nao anima e sobe de tom', () => {
  const html = render({ session: sample({ agentTurn: { state: 'waiting', sinceMs: NOW - 1000, waitingFor: 'permission' } }) });
  assert.doesNotMatch(html, /terminais-activity/);
  assert.match(html, /terminais-card__dot--warn/);
  assert.match(html, /Aguardando você/);
});

test('sem sinal proprio, so saida recente anima, e silencio fica em processo aberto', () => {
  const live = render({ session: sample({ outputAgeMs: 200, cpuPercent: 0 }) });
  assert.match(live, /terminais-activity/);
  assert.match(live, /Em execução/);

  const quiet = render({ session: sample({ outputAgeMs: 300_000, cpuPercent: 0 }) });
  assert.doesNotMatch(quiet, /terminais-activity/);
  assert.match(quiet, /Processo aberto/);
  assert.doesNotMatch(quiet, /Resposta entregue/, 'silencio nunca vira concluido');
});

test('amostra de antes da reconexao nao anima o card', () => {
  const html = render({ session: sample({
    agentTurn: { state: 'busy', sinceMs: NOW - 5000 },
    sampleAt: NOW - 90_000, evidenceSince: NOW - 10_000,
  }) });
  assert.doesNotMatch(html, /terminais-activity/);
});

test('o uso do plano no card vem da leitura das contas, igual para os dois provedores', () => {
  const card = source('../src/terminals/ui/SessionCard.jsx');
  const runtime = source('../src/terminals/runtime.js');
  assert.match(card, /sessionPlan\(activity\)/, 'o card pede o plano normalizado ao runtime');
  assert.match(runtime, /export function sessionPlan/);
  const body = runtime.slice(runtime.indexOf('export function sessionPlan'));
  // A leitura das contas vem primeiro: e a unica que serve Claude Code e
  // Codex do mesmo jeito. O arquivo que o proprio agente publica e reserva,
  // e continua sendo o unico com modelo, contexto e custo.
  assert.ok(body.indexOf('accountFor(activity?.profile)') < body.indexOf('activity?.usage'), 'a conta e consultada antes do arquivo do agente');
  assert.match(body, /windowLabel\(window\)/, 'cada percentual sai com o rotulo da janela dele');
  // Sem fracao publicada nao ha numero, e muito menos zero por cento.
  assert.match(body, /Number\.isFinite\(headline\.usedFraction\)/);
});

test('leitura velha do plano fica a vista e apagada, com o aviso na dica', () => {
  const card = source('../src/terminals/ui/SessionCard.jsx');
  assert.match(card, /plan\.stale \? ' is-stale' : ''/);
  assert.match(card, /terminal\.profiles\.stale/);
  const css = source('../src/views/Terminais.css');
  assert.match(css, /\.terminais-card__plan\.is-stale\{opacity:/);
});
