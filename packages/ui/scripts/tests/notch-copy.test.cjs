// SPDX-License-Identifier: Apache-2.0
// Confere os textos da barra de IA sem abrir o app, nos tres idiomas.
//
// Sao regras pequenas, mas cada uma decide como um numero e lido: um zero
// que nao e zero, um reset que muda de forma conforme a distancia, um tempo
// que comeca em "agora". Uma mudanca distraida aqui passaria em silencio.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/notch/copy.js');
const translators = async () => {
  const { createI18n } = await import('@cialai/i18n');
  return { 'pt-BR': createI18n('pt-BR').t, en: createI18n('en').t, es: createI18n('es').t };
};

test('o percentual distingue nao saber de nao ter gasto', async () => {
  const { DASH, percentText } = await load();
  assert.equal(percentText(null, 'pt-BR'), DASH);
  assert.equal(percentText(undefined, 'en'), DASH);
  assert.equal(percentText(Number.NaN, 'es'), DASH);
  assert.equal(percentText(0, 'pt-BR'), '0');
  assert.equal(percentText(0.38, 'pt-BR'), '38');
  assert.equal(percentText(0.0034, 'pt-BR'), '0,3');
  assert.equal(percentText(0.0004, 'pt-BR'), '<0,1');
  assert.equal(percentText(0.997, 'pt-BR'), '99,7');
  assert.equal(percentText(0.0034, 'en'), '0.3');
  assert.equal(percentText(0.0004, 'en'), '<0.1');
  assert.equal(percentText(1.04, 'es'), '104');
});

test('a linha de uso soma cem por cento nos tres idiomas', async () => {
  const { qualifierFor, usedCopy } = await load();
  const t = await translators();
  assert.equal(usedCopy(0.12, '', t['pt-BR'], 'pt-BR'), '12% usado · 88% livre');
  assert.equal(usedCopy(1.04, '', t['pt-BR'], 'pt-BR'), '104% usado · 0% livre');
  assert.equal(usedCopy(0.5, qualifierFor('derived'), t['pt-BR'], 'pt-BR'), '~50% usado · 50% livre');
  assert.equal(qualifierFor('official'), '');
  assert.equal(qualifierFor(undefined), '');
  assert.equal(qualifierFor('manual'), '~');
  assert.equal(usedCopy(null, '', t['pt-BR'], 'pt-BR'), 'Sem leitura');
  assert.equal(usedCopy(0.12, '', t.en, 'en'), '12% used · 88% left');
  assert.equal(usedCopy(0.12, '', t.es, 'es'), '12% usado · 88% libre');
});

test('o reset muda de forma conforme a distancia', async () => {
  const { resetCopy } = await load();
  const t = await translators();
  const now = Date.UTC(2026, 8, 16, 12, 0, 0);
  const pt = (at, format) => resetCopy(at, now, format, t['pt-BR'], 'pt-BR');
  assert.equal(pt(now + 30 * 60_000), 'Renova em 30 min');
  assert.equal(pt(now - 1000), 'Renovando…');
  assert.equal(pt(0), '');
  assert.equal(pt(null), '');
  assert.equal(pt(now + 3 * 3_600_000, 'remaining'), 'Renova em 3 h 0 min');
  assert.equal(pt(now + 75 * 3_600_000, 'remaining'), 'Renova em 3 dias 3 h');
  assert.equal(pt(now + 27 * 3_600_000, 'remaining'), 'Renova em 1 dia 3 h');
  assert.equal(pt(now + 5 * 60_000, 'remaining'), 'Renova em 5 min');
  assert.ok(pt(now + 20 * 86_400_000).startsWith('Renova '), 'longe vira data');
  assert.match(pt(now + 3 * 3_600_000), /^Renova (hoje|amanhã) \d/, 'perto vira hora');
  assert.match(pt(now + 3 * 86_400_000), /^Renova \S+ \d/, 'na semana vira dia da semana');
  assert.equal(resetCopy(now + 30 * 60_000, now, 'automatic', t.en, 'en'), 'Renews in 30 min');
  assert.equal(resetCopy(now + 27 * 3_600_000, now, 'remaining', t.es, 'es'), 'Se renueva en 1 día 3 h');
});

test('o tempo decorrido comeca em agora', async () => {
  const { ageCopy, elapsedCopy } = await load();
  const t = await translators();
  const now = Date.now();
  assert.equal(elapsedCopy(now - 10_000, now, t['pt-BR']), 'agora');
  assert.equal(elapsedCopy(now - 5 * 60_000, now, t['pt-BR']), '5 min');
  assert.equal(elapsedCopy(now - 3_600_000, now, t['pt-BR']), '1 h');
  assert.equal(elapsedCopy(now - 90 * 60_000, now, t['pt-BR']), '1 h 30 min');
  assert.equal(elapsedCopy(undefined, now, t.en), 'now');
  assert.equal(ageCopy(now - 90 * 60_000, now, t['pt-BR']), 'há 1 h 30 min');
  assert.equal(ageCopy(now - 90 * 60_000, now, t.en), '1 h 30 min ago');
  assert.equal(ageCopy(now - 5_000, now, t.es), 'ahora');
  assert.equal(ageCopy(0, now, t.es), '');
});

test('a mensagem de estado nomeia a pasta, nao o provedor sozinho', async () => {
  const { folderOf, statusMessage } = await load();
  const t = await translators();
  const codex = { provider: 'codex', label: 'amorim', configDir: '/Users/x/.codex-amorim', status: { kind: 'needsAuth' } };
  assert.ok(statusMessage(codex, t['pt-BR']).includes('.codex-amorim'));
  assert.ok(statusMessage(codex, t['pt-BR']).startsWith('Entre no Codex'));
  const claude = { provider: 'claude', label: 'webrota', configDir: 'C:\\Users\\x\\.claude-webrota', status: { kind: 'needsAuth' } };
  assert.equal(folderOf(claude), '.claude-webrota');
  assert.ok(statusMessage(claude, t.en).includes('.claude-webrota'));
  assert.ok(statusMessage(claude, t.en).startsWith('Sign in to Claude Code'));
  assert.equal(folderOf({ label: 'x' }), 'x');
  assert.equal(statusMessage({ status: { kind: 'signedOutByOwner' } }, t.es), 'La herramienta cerró esta cuenta. Vuelve a iniciar sesión desde ella.');
  assert.equal(statusMessage({ status: { kind: 'accessDenied' } }, t['pt-BR']), 'O acesso à credencial foi recusado. Autorize para ler o uso.');
  assert.equal(statusMessage({ status: { kind: 'ok' } }, t['pt-BR']), 'Esperando a primeira leitura…');
  assert.equal(statusMessage({ status: { kind: 'stale', sinceMs: 1 } }, t['pt-BR']), 'Esperando a primeira leitura…');
  assert.equal(statusMessage(null, t.en), 'Waiting for the first reading…');
});

test('erros seguem os codigos do Rust em message, com detail opcional, e texto livre e reserva', async () => {
  const { NOTCH_ERROR_KEYS, statusCode, statusMessage } = await load();
  const t = await translators();
  assert.deepEqual(Object.keys(NOTCH_ERROR_KEYS), ['nothingMetered', 'timeout', 'http', 'network', 'curlMissing']);
  assert.equal(statusCode({ kind: 'error', message: 'timeout' }), 'timeout');
  assert.equal(statusCode({ kind: 'error', message: 'HTTP 503' }), '');
  assert.equal(statusCode(null), '');
  assert.equal(statusMessage({ status: { kind: 'error', message: 'timeout' } }, t['pt-BR']), 'A leitura não respondeu no prazo.');
  assert.equal(statusMessage({ status: { kind: 'error', message: 'http' } }, t['pt-BR']), 'O provedor respondeu de forma inesperada.');
  assert.equal(statusMessage({ status: { kind: 'error', message: 'http', detail: '503' } }, t['pt-BR']), 'O provedor respondeu com o erro 503.');
  assert.equal(statusMessage({ status: { kind: 'error', message: 'network' } }, t.en), 'No answer from the network.');
  assert.equal(statusMessage({ status: { kind: 'error', message: 'network', detail: 'curl: could not resolve host' } }, t.en), 'No answer from the network: curl: could not resolve host');
  assert.equal(statusMessage({ status: { kind: 'error', message: 'curlMissing' } }, t.es), 'No se encontró curl en esta computadora.');
  assert.equal(statusMessage({ status: { kind: 'error', message: 'HTTP 503' } }, t['pt-BR']), 'Não foi possível ler agora. HTTP 503');
  assert.equal(statusMessage({ status: { kind: 'error' } }, t.en), 'Could not read right now.');
  assert.equal(statusMessage({ status: { kind: 'error', message: 'constructor' } }, t.en), 'Could not read right now. constructor');
  assert.equal(statusMessage({ status: { kind: 'unsupported', message: 'nothingMetered' } }, t.en), 'This account has no metered limit.');
  assert.equal(statusMessage({ status: { kind: 'unsupported', message: 'Plano free' } }, t.en), 'Plano free');
  assert.equal(statusMessage({ status: { kind: 'unsupported' } }, t.es), 'Esta cuenta no tiene un límite medido.');
});

test('rotulos de janela, grupos, estados e provedores chegam por codigo e nomes proprios passam', async () => {
  const { NOTCH_STATE_KEYS, NOTCH_WINDOW_KEYS, durationLabel, groupLabel, providerName, stateWord, windowLabel } = await load();
  const t = await translators();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  assert.deepEqual(Object.keys(NOTCH_WINDOW_KEYS), ['session', 'weeklyAll', 'perModel', 'longWindow']);
  assert.equal(windowLabel({ id: 'session', label: 'session' }, t['pt-BR']), 'Sessão atual');
  assert.equal(windowLabel({ id: 'weekly_all', label: 'weeklyAll' }, t.en), 'All models');
  assert.equal(windowLabel({ id: 'weekly_opus', label: 'perModel' }, t.es), 'Por modelo');
  assert.equal(windowLabel({ id: 'secondary', label: 'longWindow' }, t['pt-BR']), 'Janela longa');
  assert.equal(windowLabel({ id: 'primary', label: 'duration', durationMs: 5 * HOUR }, t['pt-BR']), 'Limite de 5 h');
  assert.equal(windowLabel({ id: 'secondary', label: 'duration', durationMs: 7 * DAY }, t['pt-BR']), 'Limite semanal');
  assert.equal(windowLabel({ id: 'x', label: 'duration', durationMs: 30 * 60_000 }, t.en), '30 min limit');
  assert.equal(windowLabel({ id: 'x', label: 'duration', durationMs: 30 * DAY }, t.es), 'Límite mensual');
  assert.equal(windowLabel({ id: 'x', label: 'duration', durationMs: 3 * DAY }, t.en), '3 day limit');
  assert.equal(windowLabel({ id: 'x', label: 'duration' }, t.en), 'x', 'sem duracao sobra o id');
  assert.equal(windowLabel({ id: 'weekly_opus', label: 'Opus' }, t.en), 'Opus');
  assert.equal(windowLabel({ id: 'weekly_fable', label: 'Fable' }, t.en), 'Fable');
  assert.equal(windowLabel({ id: 'primary', durationMs: 5 * HOUR }, t['pt-BR']), 'Limite de 5 h', 'sem label cai na duracao');
  assert.equal(windowLabel({ id: 'odd' }, t.en), 'odd');
  assert.equal(windowLabel(null, t.en), '');
  assert.equal(durationLabel(23 * HOUR, t['pt-BR']), 'Limite de 23 h');
  assert.equal(durationLabel(0, t['pt-BR']), '');

  assert.equal(groupLabel('codeReview', t['pt-BR']), 'Revisão de código');
  assert.equal(groupLabel('Spark', t.en), 'Spark');
  assert.equal(groupLabel('outro', t.en), 'outro');
  assert.equal(groupLabel(null, t.en), '');
  assert.equal(stateWord('waiting', t.es), 'esperando');
  assert.equal(stateWord('unknown', t.en), 'idle');
  assert.equal(providerName('claude', t.en), 'Claude');
  assert.equal(providerName('codex', t['pt-BR']), 'Codex');
  assert.equal(providerName('gemini', t.en), 'gemini');

  const { setLocale, translate } = await import('../../src/shared/i18n.js');
  const keys = [...Object.values(NOTCH_STATE_KEYS), ...Object.values(NOTCH_WINDOW_KEYS)];
  for (const locale of ['pt-BR', 'en', 'es']) {
    setLocale(locale);
    for (const key of keys) assert.ok(translate(key).length > 0, `${locale} ${key}`);
  }
  setLocale('pt-BR');
});

test('o detalhe da sessao diz de onde ela roda e em qual pasta', async () => {
  const { NOTCH_DETAIL_KEYS, sessionDetail } = await load();
  const t = await translators();
  assert.deepEqual(Object.keys(NOTCH_DETAIL_KEYS), ['terminal', 'desktop', 'vscode', 'agent', 'rollout']);
  assert.equal(sessionDetail({ detail: 'terminal', cwd: '/Users/x/Projects/cialai-platform' }, t['pt-BR']), 'Terminal · cialai-platform');
  assert.equal(sessionDetail({ detail: 'desktop', cwd: 'C:\\Users\\x\\api' }, t.en), 'Claude Desktop · api');
  assert.equal(sessionDetail({ detail: 'vscode' }, t.es), 'VS Code');
  assert.equal(sessionDetail({ detail: 'agent', cwd: '/x/y' }, t['pt-BR']), 'Agente · y');
  assert.equal(sessionDetail({ detail: 'rollout', cwd: '/x/webrota' }, t.en), 'Codex · webrota');
  assert.equal(sessionDetail({ detail: 'terminal', cwd: '/x/y', waitingFor: 'permissão' }, t['pt-BR']), 'permissão', 'a espera vence a origem');
  assert.equal(sessionDetail({ detail: 'Texto livre' }, t.en), 'Texto livre');
  assert.equal(sessionDetail({}, t.en), '');
});

test('a linha de mais sessoes e o plano seguem o idioma', async () => {
  const { moreSessionsCopy, planCopy } = await load();
  const t = await translators();
  assert.equal(moreSessionsCopy(0, t.en), '');
  assert.equal(moreSessionsCopy(1, t['pt-BR']), 'e mais uma sessão');
  assert.equal(moreSessionsCopy(3, t.es), 'y 3 sesiones más');
  assert.equal(planCopy('Max 20x', t.en), 'Plan Max 20x');
  assert.equal(planCopy(null, t.en), '');
});

test('os textos visiveis da barra nao usam parenteses nem travessao como separador', async () => {
  const { dictionaries } = await import('@cialai/i18n');
  for (const [locale, dictionary] of Object.entries(dictionaries)) {
    const keys = Object.keys(dictionary).filter((key) => key.startsWith('desktop.notch.'));
    assert.ok(keys.length >= 100, `${locale} sem as chaves da barra`);
    for (const key of keys) assert.doesNotMatch(dictionary[key], /[()–—]| - /, `${locale} ${key}`);
  }
});
