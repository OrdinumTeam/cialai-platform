// SPDX-License-Identifier: Apache-2.0
// Textos da barra de IA: percentual, reset, tempo decorrido e mensagens de
// estado. Tudo passa pelo tradutor, que chega como parametro para os testes
// cobrirem os tres idiomas; o padrao e o tradutor da interface.
//
// Duas regras vieram do Codenotch e existem por um motivo:
//
// - Entre zero e um por cento o numero ganha uma casa decimal, e abaixo de
//   0,1 vira `<0,1`. Arredondar para zero faria uma sessao que ja consumiu
//   alguma coisa parecer intocada.
// - Sem leitura o anel mostra um traco, que e diferente de zero por cento.
//   Um e "nao sei", o outro e "nao gastou nada".
//
// Estados, rotulos de janela, grupos, erros e o detalhe da sessao chegam do
// Rust como codigo, no molde de tunnel-model.js. O que nao e codigo e nome
// proprio, como o de um modelo, e vai para a tela como veio.

import { getLocale, translate } from '../desktop/i18n.js';

export const DASH = '—';

export const NOTCH_STATE_KEYS = Object.freeze({
  busy: 'desktop.notch.state.busy',
  waiting: 'desktop.notch.state.waiting',
  success: 'desktop.notch.state.success',
  idle: 'desktop.notch.state.idle',
});

export const NOTCH_PROVIDER_KEYS = Object.freeze({
  claude: 'desktop.notch.provider.claude',
  codex: 'desktop.notch.provider.codex',
});

/// Codigos de `windows[].label`. `duration` e formatado a partir de
/// `durationMs`; qualquer outro valor e nome proprio.
export const NOTCH_WINDOW_KEYS = Object.freeze({
  session: 'desktop.notch.window.session',
  weeklyAll: 'desktop.notch.window.weeklyAll',
  perModel: 'desktop.notch.window.perModel',
  longWindow: 'desktop.notch.window.longWindow',
});

/// Codigos de `windows[].group`. `Spark` fica como esta.
export const NOTCH_GROUP_KEYS = Object.freeze({
  codeReview: 'desktop.notch.group.codeReview',
});

/// Codigos de `status.message` para `unsupported` e `error`. `http` e
/// `network` podem trazer `status.detail`.
export const NOTCH_ERROR_KEYS = Object.freeze({
  nothingMetered: 'desktop.notch.status.unsupported',
  timeout: 'desktop.notch.error.timeout',
  http: 'desktop.notch.error.http',
  network: 'desktop.notch.error.network',
  curlMissing: 'desktop.notch.error.curlMissing',
});

/// Codigos de `sessions[].detail`: de onde a sessao roda. A pasta vem em
/// `cwd`.
export const NOTCH_DETAIL_KEYS = Object.freeze({
  terminal: 'desktop.notch.detail.terminal',
  desktop: 'desktop.notch.detail.desktop',
  vscode: 'desktop.notch.detail.vscode',
  agent: 'desktop.notch.detail.agent',
  rollout: 'desktop.notch.detail.rollout',
});

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const keyIn = (map, code) => (typeof code === 'string' && Object.hasOwn(map, code) ? map[code] : null);
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function decimal(value, locale) {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value);
}

/// Percentual do anel. `null` vira traco.
export function percentText(fraction, locale = getLocale()) {
  if (!isNumber(fraction)) return DASH;
  const value = fraction * 100;
  if (value > 0 && value < 1) {
    if (value < 0.1) return `<${decimal(0.1, locale)}`;
    return decimal(value, locale);
  }
  if (value > 99 && value < 100) return decimal(value, locale);
  return String(Math.round(value));
}

/// Sufixo que marca um numero derivado ou manual, nunca publicado assim pelo
/// fornecedor.
export function qualifierFor(fidelity) {
  return fidelity === 'derived' || fidelity === 'manual' ? '~' : '';
}

/// Linha de uso do card: `38% usado · 62% livre`.
export function usedCopy(fraction, qualifier = '', t = translate, locale = getLocale()) {
  if (!isNumber(fraction)) return t('desktop.notch.card.noReading');
  const used = percentText(fraction, locale);
  const left = fraction >= 1 ? '0' : percentText(Math.max(0, 1 - fraction), locale);
  return t('desktop.notch.card.used', { qualifier, used, left });
}

function clock(date, locale) {
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(date);
}

/// Quantos dias de calendario separam duas datas.
function daysApart(from, to) {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / DAY_MS);
}

/// Texto do reset. `format` e `automatic`, com data, ou `remaining`, com
/// contagem regressiva.
export function resetCopy(resetsAtMs, now = Date.now(), format = 'automatic', t = translate, locale = getLocale()) {
  if (!isNumber(resetsAtMs) || resetsAtMs <= 0) return '';
  const seconds = Math.round((resetsAtMs - now) / 1000);
  if (seconds <= 0) return t('desktop.notch.reset.renewing');

  if (format === 'remaining') {
    const minutes = Math.max(1, Math.round(seconds / 60));
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days === 1) return t('desktop.notch.reset.inDay', { hours: hours % 24 });
    if (days > 1) return t('desktop.notch.reset.inDays', { days, hours: hours % 24 });
    if (hours > 0) return t('desktop.notch.reset.inHours', { hours, minutes: minutes % 60 });
    return t('desktop.notch.reset.inMinutes', { minutes });
  }

  const target = new Date(resetsAtMs);
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes < 60) return t('desktop.notch.reset.inMinutes', { minutes });
  const apart = daysApart(new Date(now), target);
  if (apart >= 7) return t('desktop.notch.reset.date', { date: new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short' }).format(target) });
  if (apart === 0) return t('desktop.notch.reset.today', { time: clock(target, locale) });
  if (apart === 1) return t('desktop.notch.reset.tomorrow', { time: clock(target, locale) });
  return t('desktop.notch.reset.weekday', { weekday: new Intl.DateTimeFormat(locale, { weekday: 'short' }).format(target), time: clock(target, locale) });
}

/// Tempo desde um instante, para a linha da sessao.
export function elapsedCopy(sinceMs, now = Date.now(), t = translate) {
  const since = isNumber(sinceMs) ? sinceMs : now;
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 45) return t('desktop.notch.elapsed.now');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t('desktop.notch.elapsed.minutes', { minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (rest === 0) return t('desktop.notch.elapsed.hours', { hours });
  return t('desktop.notch.elapsed.hoursMinutes', { hours, minutes: rest });
}

/// Idade da leitura, para a nota do cabecalho.
export function ageCopy(fetchedAtMs, now = Date.now(), t = translate) {
  if (!isNumber(fetchedAtMs) || fetchedAtMs <= 0) return '';
  if (now - fetchedAtMs < 45_000) return t('desktop.notch.elapsed.now');
  return t('desktop.notch.age', { elapsed: elapsedCopy(fetchedAtMs, now, t) });
}

/// Palavra de estado de uma sessao.
export function stateWord(state, t = translate) {
  return t(keyIn(NOTCH_STATE_KEYS, state) || NOTCH_STATE_KEYS.idle);
}

/// Nome do provedor. Um provedor desconhecido aparece pelo proprio codigo.
export function providerName(provider, t = translate) {
  const key = keyIn(NOTCH_PROVIDER_KEYS, provider);
  return key ? t(key) : String(provider || '');
}

/// Rotulo de uma janela pela duracao: minutos abaixo de uma hora, horas
/// abaixo de um dia, semanal aos 7 dias, mensal aos 30, o resto em dias.
export function durationLabel(durationMs, t = translate) {
  if (!isNumber(durationMs) || durationMs <= 0) return '';
  const minutes = Math.round(durationMs / 60_000);
  if (minutes < 60) return t('desktop.notch.window.minutes', { minutes });
  const hours = Math.round(durationMs / HOUR_MS);
  if (hours < 24) return t('desktop.notch.window.hours', { hours });
  const days = Math.round(durationMs / DAY_MS);
  if (days === 7) return t('desktop.notch.window.weekly');
  if (days === 30) return t('desktop.notch.window.monthly');
  return t('desktop.notch.window.days', { days });
}

/// Rotulo de uma janela. `label` e um codigo do contrato ou um nome proprio,
/// como o de um modelo, mostrado como veio.
export function windowLabel(limit, t = translate) {
  if (!limit) return '';
  const label = text(limit.label);
  const key = keyIn(NOTCH_WINDOW_KEYS, label);
  if (key) return t(key);
  if (label === 'duration') return durationLabel(limit.durationMs, t) || String(limit.id || '');
  if (label) return label;
  return durationLabel(limit.durationMs, t) || String(limit.id || '');
}

/// Titulo de um grupo de janelas: `codeReview` e traduzido, `Spark` fica
/// como esta.
export function groupLabel(group, t = translate) {
  const key = keyIn(NOTCH_GROUP_KEYS, group);
  return key ? t(key) : String(group || '');
}

/// Nome da pasta de configuracao, para a mensagem nomear a conta certa.
export function folderOf(snapshot) {
  const dir = text(snapshot?.configDir);
  return dir.split(/[\\/]/).filter(Boolean).pop() || snapshot?.label || '';
}

/// Codigo de um estado `unsupported` ou `error`, quando `message` e um dos
/// codigos do contrato.
export function statusCode(status) {
  const message = text(status?.message);
  return keyIn(NOTCH_ERROR_KEYS, message) ? message : '';
}

/// Mensagem quando o perfil nao tem leitura, por estado. Erros conhecidos
/// vem por codigo, com `detail` opcional; um texto que nao e codigo aparece
/// como veio.
export function statusMessage(snapshot, t = translate) {
  const status = snapshot?.status;
  const kind = status?.kind;
  if (kind === 'needsAuth') {
    const folder = folderOf(snapshot);
    return t(snapshot?.provider === 'codex' ? 'desktop.notch.status.needsAuthCodex' : 'desktop.notch.status.needsAuthClaude', { folder });
  }
  if (kind === 'signedOutByOwner') return t('desktop.notch.status.signedOut');
  if (kind === 'accessDenied') return t('desktop.notch.status.accessDenied');
  const code = statusCode(status);
  const message = text(status?.message);
  const detail = text(status?.detail);
  if (kind === 'unsupported') return code ? t(NOTCH_ERROR_KEYS[code]) : message || t('desktop.notch.status.unsupported');
  if (kind === 'error') {
    if (code === 'http' && detail) return t('desktop.notch.error.httpStatus', { detail });
    if (code === 'network' && detail) return t('desktop.notch.error.networkDetail', { detail });
    if (code) return t(NOTCH_ERROR_KEYS[code]);
    return message ? t('desktop.notch.status.error', { message }) : t('desktop.notch.status.errorShort');
  }
  return t('desktop.notch.status.waiting');
}

/// Linha de detalhe de uma sessao: o que ela espera, senao de onde roda e em
/// qual pasta. Um `detail` que nao e codigo aparece como veio.
export function sessionDetail(session, t = translate) {
  const waitingFor = text(session?.waitingFor);
  if (waitingFor) return waitingFor;
  const detail = text(session?.detail);
  const key = keyIn(NOTCH_DETAIL_KEYS, detail);
  if (!key) return detail;
  const host = t(key);
  const folder = text(session?.cwd).split(/[\\/]/).filter(Boolean).pop() || '';
  return folder ? t('desktop.notch.detail.withFolder', { host, folder }) : host;
}

/// Linha `e mais N sessoes` abaixo das sessoes mostradas.
export function moreSessionsCopy(count, t = translate) {
  if (!isNumber(count) || count <= 0) return '';
  return count === 1 ? t('desktop.notch.card.moreSession') : t('desktop.notch.card.moreSessions', { count });
}

/// Linha do plano no cabecalho do card.
export function planCopy(plan, t = translate) {
  return plan ? t('desktop.notch.card.plan', { plan }) : '';
}
