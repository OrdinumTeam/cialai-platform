// SPDX-License-Identifier: Apache-2.0
// Dados fixos para as capturas, fora do app, pelo mesmo mecanismo do
// `?terminais=demo`: a consulta da URL decide o cenario.
//
// `?notch=demo:basic` reproduz a referencia aprovada: um anel por perfil, com
// o nome do perfil sob o percentual e nenhum anel neutro. Os outros cenarios
// existem para conferir estados e bordas sem depender de uma conta real.
// Rotulos de janela, erros e detalhe de sessao seguem os codigos do
// contrato, entao o texto acompanha o idioma da interface.

import { translate } from '../desktop/i18n.js';
import { activitySummary } from './model.js';

const HOUR = 3_600_000;
const HOME = '/Users/exemplo';

function window_(id, label, used, inMs, durationMs) {
  return { id, label, usedFraction: used, resetsAtMs: Date.now() + inMs, durationMs };
}

/// Estado de leitura, com o `kind` do contrato e os campos que o acompanham.
function statusOf(kind, extra = {}) {
  return { kind, ...extra };
}

function profile(id, provider, label, used, extra = {}) {
  const claude = provider === 'claude';
  return {
    id,
    provider,
    label,
    account: `${label}@exemplo.com`,
    configDir: `${HOME}/.${provider}-${label}`,
    plan: claude ? 'Max 20x' : 'plus',
    fidelity: 'official',
    status: statusOf('ok'),
    headlineId: claude ? 'session' : 'primary',
    weeklyId: claude ? 'weekly_all' : 'secondary',
    fetchedAtMs: Date.now() - 45_000,
    source: claude ? 'statusline' : 'chatgptApi',
    windows: claude
      ? [window_('session', 'session', used, 2.4 * HOUR, 5 * HOUR), window_('weekly_all', 'weeklyAll', used / 3, 70 * HOUR, 7 * 24 * HOUR)]
      : [window_('primary', 'duration', used, 3.1 * HOUR, 5 * HOUR), window_('secondary', 'duration', used / 4, 96 * HOUR, 7 * 24 * HOUR)],
    ...extra,
  };
}

function claudeSession(id, profileId, name, state, agoMs, extra = {}) {
  return { id, profileId, name, detail: 'terminal', cwd: `${HOME}/Projects/${name}`, state, sinceMs: Date.now() - agoMs, pid: 1, ...extra };
}

function codexSession(id, profileId, name, state, agoMs) {
  return { id, profileId, name, detail: 'rollout', cwd: `${HOME}/Projects/${name}`, state, sinceMs: Date.now() - agoMs };
}

/// A referencia: quatro perfis do Claude e quatro do Codex.
function basic() {
  return {
    profiles: [
      profile('claude-ordinum', 'claude', 'ordinum', 0.26),
      profile('claude-webrota', 'claude', 'webrota', 0.81),
      profile('claude-webrotaa', 'claude', 'webrotaa', 0.75),
      profile('claude-webrotaaa', 'claude', 'webrotaaa', 0.9),
      profile('codex-aamorim', 'codex', 'aamorim', 0.62),
      profile('codex-amorim', 'codex', 'amorim', 0.57),
      profile('codex-ordinum', 'codex', 'ordinum', 0, { windows: [], status: statusOf('needsAuth'), fetchedAtMs: 0, account: null, source: null }),
      profile('codex-webrota', 'codex', 'webrota', 0.99),
    ],
    sessions: {
      'claude-ordinum': [claudeSession('claude-ordinum.1', 'claude-ordinum', 'cialai-platform', 'busy', 95_000)],
      'codex-webrota': [codexSession('codex-webrota.1', 'codex-webrota', 'webrota', 'busy', 20_000)],
    },
  };
}

/// Um estado por celula, para conferir tudo de uma vez.
function states(t) {
  const now = Date.now();
  return {
    profiles: [
      profile('claude-ordinum', 'claude', 'ordinum', 0.09),
      profile('claude-webrota', 'claude', 'webrota', 0.62),
      profile('claude-webrotaa', 'claude', 'webrotaa', 0.85),
      profile('claude-webrotaaa', 'claude', 'webrotaaa', 1.0),
      profile('codex-amorim', 'codex', 'amorim', 0.3, { status: statusOf('stale', { sinceMs: now - 40 * 60_000 }), fetchedAtMs: now - 40 * 60_000 }),
      profile('codex-aamorim', 'codex', 'aamorim', 0, { windows: [], status: statusOf('needsAuth'), fetchedAtMs: 0, source: null }),
      profile('codex-ordinum', 'codex', 'ordinum', 0, { windows: [], status: statusOf('error', { message: 'http', detail: '503' }), fetchedAtMs: 0, source: null }),
      profile('codex-webrota', 'codex', 'webrota', 0.44, { fidelity: 'derived', source: 'rollout' }),
    ],
    sessions: {
      'claude-ordinum': [claudeSession('a', 'claude-ordinum', 'cialai-platform', 'busy', 95_000)],
      'claude-webrota': [claudeSession('b', 'claude-webrota', 'site-exemplo', 'waiting', 12_000, { waitingFor: t('desktop.notch.demo.permission'), pid: 2 })],
      'claude-webrotaa': [claudeSession('c', 'claude-webrotaa', 'api-exemplo', 'success', 6_000, { detail: 'desktop', pid: null })],
      'codex-webrota': [
        codexSession('d', 'codex-webrota', 'webrota', 'busy', 3_000),
        codexSession('e', 'codex-webrota', 'outra', 'success', 50_000),
      ],
    },
  };
}

/// Uma unica celula, para conferir a forma sem a pilha.
function single() {
  return { profiles: [profile('codex-amorim', 'codex', 'amorim', 0.28)], sessions: {} };
}

/// Doze contas, com os extremos que a lista de Preferencias precisa aguentar:
/// conta longa, pasta longa, uma pasta que repete a conta de um perfil com
/// nome, uma sem login e um apelido no limite de 24 caracteres. E o cenario
/// que reproduz a tela cheia sem depender de contas reais na maquina.
function many() {
  const long = 'a.amorim.ordinum.plataforma@exemplo.com.br';
  return {
    profiles: [
      profile('claude-ti', 'claude', 'ti', 0.18, { duplicate: true, configDir: `${HOME}/.claude`, account: long }),
      profile('claude-ordinum', 'claude', 'ordinum', 0.26, { account: long }),
      profile('claude-webrota', 'claude', 'webrota', 0.81),
      profile('claude-webrotaa', 'claude', 'webrotaa', 0.75),
      profile('claude-webrotaaa', 'claude', 'webrotaaa', 0.9),
      profile('claude-plataforma', 'claude', 'plataforma', 0.47, { configDir: `${HOME}/.claude-plataforma-de-engenharia-ordinum` }),
      profile('codex-amorimcompanybr', 'codex', 'amorimcompanybr', 0.12, { duplicate: true, configDir: `${HOME}/.codex` }),
      profile('codex-aamorim', 'codex', 'aamorim', 0.62),
      profile('codex-amorim', 'codex', 'amorim', 0.57, { account: long }),
      profile('codex-ordinum', 'codex', 'ordinum', 0, { windows: [], status: statusOf('needsAuth'), fetchedAtMs: 0, account: null, source: null }),
      profile('codex-webrota', 'codex', 'webrota', 0.99),
      profile('codex-infraestrutura', 'codex', 'infraestrutura', 0.34, { configDir: `${HOME}/.codex-infraestrutura-e-plataforma` }),
    ],
    sessions: {
      'claude-ordinum': [claudeSession('claude-ordinum.1', 'claude-ordinum', 'cialai-platform', 'busy', 95_000)],
      'codex-webrota': [codexSession('codex-webrota.1', 'codex-webrota', 'webrota', 'busy', 20_000)],
    },
    // Apelido no limite do campo, para a linha esticar o maximo que consegue.
    prefs: { profiles: { 'claude-webrotaaa': { enabled: true, alias: 'plataforma de engenharia', muted: true } } },
  };
}

const SCENARIOS = { basic, states, single, many, collapsed: basic };

/// Cenario pedido na URL, ou `null` fora do modo de demonstracao.
export function demoScenario(search = typeof window !== 'undefined' ? window.location.search : '') {
  let value = '';
  try {
    value = new URLSearchParams(search).get('notch') || '';
  } catch (_error) {
    return null;
  }
  if (!value.startsWith('demo:')) return null;
  const [name] = value.slice(5).split(':');
  return SCENARIOS[name] ? name : 'basic';
}

/// Estado completo de um cenario, no formato de `notch_state`.
export function demoState(t = translate, name = 'basic') {
  const build = SCENARIOS[name] || basic;
  const { profiles, sessions, prefs: extra } = build(t);
  const activity = {};
  Object.entries(sessions).forEach(([id, list]) => { activity[id] = activitySummary(list); });
  return {
    demo: name,
    prefs: {
      visibility: name === 'collapsed' ? 'collapsed' : 'open',
      profiles: {},
      order: [],
      hideDefaultWhenDuplicate: true,
      watchLimit: 0.5,
      criticalLimit: 0.7,
      alerts: { threshold: false, limitReached: false, reset: false },
      resetTimeFormat: 'automatic',
      ...(extra || {}),
    },
    profiles,
    sessions,
    activity,
    allProfiles: profiles,
  };
}
