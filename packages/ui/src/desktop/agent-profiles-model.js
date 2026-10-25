// SPDX-License-Identifier: Apache-2.0
// Regras do modal Perfis de agentes sem React: nome de um perfil novo,
// leitura da cota de cada conta, as linhas do menu do terminal e os dados de
// exemplo do tutorial. As contas vêm de `agent_profiles`, já com a leitura de
// uso da Barra de IA, e o id de cada uma é `codex`, `codex-felipe` e afins.

import { weeklyState } from '../notch/model.js';

export const AGENTS = Object.freeze([
  Object.freeze({ id: 'codex', label: 'Codex', command: 'codex', config: 'config.toml' }),
  Object.freeze({ id: 'claude', label: 'Claude Code', command: 'claude', config: 'settings.json' }),
]);
// O mesmo limite de `agent_profiles::NAME_LIMIT` no Rust.
export const NAME_LIMIT = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

export function agentById(id) {
  return AGENTS.find((agent) => agent.id === id) || AGENTS[0];
}

// O que o Rust aceita: minúsculas, dígitos, hífen e sublinhado, sem hífen nas
// pontas. Digitar já limpa o resto, então só o vazio chega como erro.
export function sanitizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').replace(/^-+/, '').slice(0, NAME_LIMIT);
}

export function finalName(value) {
  return sanitizeName(value).replace(/-+$/, '');
}

export function profileFolder(agent, name) {
  return name ? `.${agent}-${name}` : `.${agent}`;
}

// Nome do perfil a partir do id: vazio no padrão.
export function profileName(profile) {
  const id = String(profile?.id || '');
  const prefix = `${profile?.agent}-`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : '';
}

export function profileExists(profiles, agent, name) {
  return Boolean(name) && (profiles || []).some((profile) => profile.agent === agent && profile.id === `${agent}-${name}`);
}

// Perfis de um agente com o padrão primeiro, como o computador já devolve.
export function profilesOf(profiles, agent) {
  return (profiles || []).filter((profile) => profile.agent === agent);
}

// A cota da conta vale pela janela que mais apertou entre a do anel e a
// semanal, as duas que a Barra de IA mostra. Sem leitura, o estado é
// `unknown`: ausência de número nunca vira cota livre.
export function quotaOf(profile) {
  const usage = profile?.usage;
  const windows = Array.isArray(usage?.windows) ? usage.windows : [];
  const headline = windows.find((window) => window.id === usage?.headlineId) || null;
  const weekly = weeklyState({ windows, headlineId: usage?.headlineId ?? null, weeklyId: usage?.weeklyId ?? null, status: usage?.status });
  const known = [headline, weekly.kind === 'available' ? weekly.window : null]
    .filter((window) => window && Number.isFinite(window.usedFraction));
  if (!known.length) return { state: 'unknown' };
  const tightest = known.reduce((worst, window) => (window.usedFraction > worst.usedFraction ? window : worst));
  const used = Math.max(0, Math.min(100, tightest.usedFraction * 100));
  return {
    state: used >= 100 ? 'out' : 'free',
    free: Math.round(100 - used),
    resetsAtMs: Number.isFinite(tightest.resetsAtMs) ? tightest.resetsAtMs : null,
  };
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

// Hora em que a cota volta: só a hora quando é hoje, amanhã com a hora, e o
// dia da semana com a hora depois disso.
export function resetTime(ms, { now = Date.now(), locale, t }) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
  const days = Math.round((startOfDay(date) - startOfDay(new Date(now))) / DAY_MS);
  if (days <= 0) return time;
  if (days === 1) return t('agentProfiles.tomorrow', { time });
  return `${new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(date)} ${time}`;
}

const NO_LOGIN = new Set(['needsAuth', 'signedOutByOwner']);

// Texto da linha de cota de um perfil: valor e detalhe. O `state` é o que
// o menu do terminal usa para pular a conta esgotada ou sem login.
export function quotaLine(profile, { now, locale, t }) {
  if (profile?.needsLogin || NO_LOGIN.has(profile?.usage?.status?.kind)) return { state: 'none', tone: 'muted', value: t('agentProfiles.noLogin'), detail: '' };
  const quota = quotaOf(profile);
  const when = resetTime(quota.resetsAtMs, { now, locale, t });
  if (quota.state === 'out') return { state: 'out', tone: 'out', value: t('agentProfiles.exhausted'), detail: when ? t('agentProfiles.backAt', { time: when }) : '', free: 0 };
  if (quota.state === 'free') return { state: 'free', tone: 'free', value: `${quota.free}%`, detail: when ? t('agentProfiles.resetsAt', { time: when }) : '', free: quota.free };
  if (profile?.usage?.status?.kind === 'unsupported') return { state: 'unknown', tone: 'muted', value: t('terminal.profiles.unmetered'), detail: '' };
  return { state: 'unknown', tone: 'muted', value: t('agentProfiles.noQuota'), detail: '' };
}

// Contas de um agente para o menu do terminal, na ordem do modal.
export function menuEntries(profiles, agent, { now, locale, t }) {
  return profilesOf(profiles, agent).map((profile) => {
    const line = quotaLine(profile, { now, locale, t });
    return { id: profile.id, label: profile.label || profileName(profile) || agent, state: line.state, value: line.value, detail: line.detail };
  });
}

// Contas fictícias do tutorial: o padrão com cota, uma esgotada e a nova.
// O tutorial explica o comportamento e não mostra as contas reais.
export function tutorialAccounts({ name, t }) {
  return [
    { name: t('agentProfiles.default'), state: 'free', free: 62, detail: t('agentProfiles.resetsAt', { time: '14:00' }) },
    { name: t('agentProfiles.tutorial.work'), state: 'out', detail: t('agentProfiles.backAt', { time: t('agentProfiles.tomorrow', { time: '09:00' }) }) },
    { name, state: 'free', free: 100, detail: t('agentProfiles.tutorial.newAccount'), fresh: true },
  ];
}

// Prompt e nome do shell do tutorial, pelo shell efetivo das sessões.
export function tutorialShell(spec, os) {
  const fallback = os === 'windows' ? 'powershell.exe' : os === 'linux' ? 'bash' : 'zsh';
  const base = String(spec?.path || fallback).replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '');
  const flavor = spec?.flavor || (os === 'windows' ? 'powershell' : 'posix');
  if (flavor === 'powershell') return { title: 'PowerShell', prompt: 'PS ~>' };
  if (flavor === 'cmd') return { title: 'cmd', prompt: 'C:\\>' };
  return { title: base || 'shell', prompt: '~ ❯' };
}

// Separa um texto traduzido nos trechos que vão em negrito: os valores de
// `bold` entram marcados e saem como `{ text, bold: true }`.
const MARK = '\u0001';
export function richText(t, key, values = {}, bold = []) {
  const marked = { ...values };
  bold.forEach((name) => { if (name in marked) marked[name] = `${MARK}${marked[name]}${MARK}`; });
  return t(key, marked).split(MARK).map((text, index) => ({ text, bold: index % 2 === 1 })).filter((part) => part.text);
}
