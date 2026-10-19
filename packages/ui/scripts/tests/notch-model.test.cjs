// SPDX-License-Identifier: Apache-2.0
// Logica pura da barra de IA: banda, janela do anel, resumo de atividade,
// hover, posicao do popover, ordem dos perfis e preferencias normalizadas.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/notch/model.js');

test('a banda muda nos limiares e none e diferente de zero', async () => {
  const { bandOf } = await load();
  assert.equal(bandOf(null), 'none');
  assert.equal(bandOf(undefined), 'none');
  assert.equal(bandOf(Number.NaN), 'none');
  assert.equal(bandOf(0), 'ample');
  assert.equal(bandOf(0.5999), 'ample');
  assert.equal(bandOf(0.6), 'watch');
  assert.equal(bandOf(0.7999), 'watch');
  assert.equal(bandOf(0.8), 'critical');
  assert.equal(bandOf(0.999), 'critical');
  assert.equal(bandOf(1), 'exhausted');
  assert.equal(bandOf(1.2), 'exhausted');
  assert.equal(bandOf(0.35, 0.3, 0.9), 'watch');
  assert.equal(bandOf(0.35, 0.4, 0.9), 'ample');
});

test('a celula desenha a janela do anel e apaga sem leitura ou envelhecida', async () => {
  const { cellState, headlineWindow } = await load();
  const snapshot = { headlineId: 'session', status: { kind: 'ok' }, windows: [{ id: 'weekly_all', usedFraction: 0.1 }, { id: 'session', usedFraction: 0.81 }] };
  assert.equal(headlineWindow(snapshot).id, 'session');
  assert.deepEqual(cellState(snapshot, { watchLimit: 0.5, criticalLimit: 0.7 }), { fraction: 0.81, hasReading: true, stale: false, band: 'critical' });
  assert.deepEqual(cellState({ ...snapshot, status: { kind: 'stale', sinceMs: 1 } }), { fraction: 0.81, hasReading: true, stale: true, band: 'critical' });
  assert.deepEqual(cellState({ ...snapshot, headlineId: 'missing' }), { fraction: null, hasReading: true, stale: false, band: 'none' });
  assert.deepEqual(cellState({ status: { kind: 'needsAuth' }, windows: [] }), { fraction: null, hasReading: false, stale: true, band: 'none' });
  assert.equal(headlineWindow(null), null);
});

test('o resumo de atividade da precedencia a aguardando, depois trabalhando, depois concluido', async () => {
  const { activitySummary } = await load();
  assert.deepEqual(activitySummary([]), { state: 'idle', count: 0, waiting: 0, busy: 0 });
  assert.deepEqual(activitySummary(null), { state: 'idle', count: 0, waiting: 0, busy: 0 });
  assert.deepEqual(activitySummary([{ state: 'success' }]), { state: 'success', count: 1, waiting: 0, busy: 0 });
  assert.deepEqual(activitySummary([{ state: 'success' }, { state: 'busy' }]), { state: 'busy', count: 2, waiting: 0, busy: 1 });
  assert.deepEqual(activitySummary([{ state: 'busy' }, { state: 'waiting' }, null]), { state: 'waiting', count: 2, waiting: 1, busy: 1 });
});

test('as janelas com grupo ficam depois das soltas, na ordem em que aparecem', async () => {
  const { groupWindows } = await load();
  const { plain, groups } = groupWindows([{ id: 'a' }, { id: 'b', group: 'spark' }, { id: 'c' }, { id: 'd', group: 'code_review' }, { id: 'e', group: 'spark' }]);
  assert.deepEqual(plain.map((limit) => limit.id), ['a', 'c']);
  assert.deepEqual(groups.map(({ group, limits }) => [group, limits.map((limit) => limit.id)]), [['spark', ['b', 'e']], ['code_review', ['d']]]);
  assert.deepEqual(groupWindows(null), { plain: [], groups: [] });
});

test('o hover segura a folga entre a celula e o popover', async () => {
  const { createHoverScheduler, HOVER_GRACE_MS } = await load();
  const timers = new Map();
  let nextTimer = 1;
  const schedule = (run, delay) => { const id = nextTimer; nextTimer += 1; timers.set(id, { run, delay }); return id; };
  const cancel = (id) => timers.delete(id);
  const fire = () => { for (const [id, timer] of [...timers]) { timers.delete(id); timer.run(); } };
  const seen = [];
  const hover = createHoverScheduler((index) => seen.push(index), { schedule, cancel });

  assert.equal(HOVER_GRACE_MS, 180);
  hover.enter(2);
  hover.enter(2);
  assert.deepEqual(seen, [2], 'entrar duas vezes na mesma celula nao repete');
  hover.leave();
  assert.equal(timers.size, 1);
  assert.equal([...timers.values()][0].delay, 180);
  hover.keep();
  assert.equal(timers.size, 0, 'entrar no popover cancela o fechamento');
  hover.leave();
  hover.enter(3);
  assert.equal(timers.size, 0, 'voltar a uma celula cancela o fechamento');
  assert.deepEqual(seen, [2, 3]);
  hover.leave();
  fire();
  assert.deepEqual(seen, [2, 3, -1]);
  assert.equal(hover.current(), -1);
  hover.leave();
  hover.dispose();
  assert.equal(timers.size, 0, 'desmontar cancela o que estava agendado');
});

test('o popover fica abaixo da toolbar e preso a janela embaixo', async () => {
  const { cardPlacement, CARD_GAP, CARD_WIDTH, TOOLBAR_HEIGHT } = await load();
  const viewport = { viewportWidth: 1380, viewportHeight: 880 };
  assert.deepEqual(cardPlacement({ barLeft: 1296, cellTop: 300, ...viewport }), { top: 300, right: 1380 - 1296 + CARD_GAP, width: CARD_WIDTH, maxHeight: 420 });
  assert.equal(cardPlacement({ barLeft: 1296, cellTop: 10, ...viewport }).top, TOOLBAR_HEIGHT + CARD_GAP);
  assert.equal(cardPlacement({ barLeft: 1296, cellTop: 860, ...viewport }).top, 880 - 420 - CARD_GAP);
  const short = cardPlacement({ barLeft: 1296, cellTop: 200, viewportWidth: 1380, viewportHeight: 400 });
  assert.equal(short.maxHeight, 400 - TOOLBAR_HEIGHT - 2 * CARD_GAP);
  assert.equal(short.top, TOOLBAR_HEIGHT + CARD_GAP);
});

test('a ordem salva vem primeiro, perfis novos ficam no fim e a pasta repetida some sem apelido', async () => {
  const { duplicateHidden, moveProfile, orderedProfiles } = await load();
  const profiles = [{ id: 'codex' }, { id: 'claude-webrota' }, { id: 'claude' }, { id: 'codex-amorim' }];
  assert.deepEqual(orderedProfiles(profiles, ['codex-amorim', 'claude']).map((profile) => profile.id), ['codex-amorim', 'claude', 'codex', 'claude-webrota']);
  assert.deepEqual(orderedProfiles(profiles, []).map((profile) => profile.id), ['codex', 'claude-webrota', 'claude', 'codex-amorim']);
  assert.deepEqual(orderedProfiles(null, null), []);
  const ids = ['a', 'b', 'c'];
  assert.deepEqual(moveProfile(ids, 'b', -1), ['b', 'a', 'c']);
  assert.deepEqual(moveProfile(ids, 'b', 1), ['a', 'c', 'b']);
  assert.equal(moveProfile(ids, 'a', -1), ids);
  assert.equal(moveProfile(ids, 'c', 1), ids);
  assert.equal(moveProfile(ids, 'x', 1), ids);
  assert.equal(duplicateHidden({ id: 'codex', duplicate: true }, { hideDefaultWhenDuplicate: true, profiles: {} }), true);
  assert.equal(duplicateHidden({ id: 'codex', duplicate: true }, { hideDefaultWhenDuplicate: true, profiles: { codex: { alias: 'principal' } } }), false);
  assert.equal(duplicateHidden({ id: 'codex', duplicate: true }, { hideDefaultWhenDuplicate: false }), false);
  assert.equal(duplicateHidden({ id: 'codex-amorim' }, { hideDefaultWhenDuplicate: true }), false);
});

test('o atalho da barra e Shift+Cmd+N no macOS e Mod+Shift+A onde Ctrl+Shift+N e novo arquivo no terminal', async () => {
  const { toggleShortcut } = await load();
  const { shortcutLabel, terminalSafe } = await import('../../src/lib/keys.js');
  const { appMenuItems } = await import('../../src/desktop/window-chrome.js');
  assert.equal(toggleShortcut('macos'), 'Mod+Shift+N');
  assert.equal(shortcutLabel(toggleShortcut('macos'), 'macos'), '⇧⌘N');
  for (const os of ['linux', 'windows']) {
    assert.equal(toggleShortcut(os), 'Mod+Shift+A');
    assert.equal(shortcutLabel(toggleShortcut(os), os), 'Ctrl Shift A');
    assert.notEqual(toggleShortcut(os), terminalSafe('Mod+N', os), 'novo arquivo no terminal continua com Ctrl+Shift+N');
    const items = appMenuItems({}, [], { label: (combo) => combo, os });
    assert.equal(items.find((item) => item.id === 'notch-toggle').hint, 'Mod+Shift+A');
    assert.equal(items.find((item) => item.id === 'new-file').hint, 'Mod+N');
  }
});

test('as preferencias da barra sao normalizadas com os nomes e valores do Rust', async () => {
  const { DEFAULT_NOTCH_PREFERENCES, NOTCH_RESET_FORMATS, NOTCH_THRESHOLDS, NOTCH_VISIBILITIES, normalizeNotchPreferences, normalizePreferenceDraft, sanitizePreferences } = await import('../../src/desktop/preferences-model.js');
  assert.deepEqual(NOTCH_VISIBILITIES, ['open', 'collapsed', 'hidden']);
  assert.deepEqual(NOTCH_RESET_FORMATS, ['automatic', 'remaining']);
  assert.deepEqual(NOTCH_THRESHOLDS, [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]);
  assert.deepEqual(normalizeNotchPreferences(null), {
    visibility: 'open', profiles: {}, order: [], hideDefaultWhenDuplicate: true, watchLimit: 0.6, criticalLimit: 0.8,
    alerts: { threshold: false, limitReached: false, reset: false }, resetTimeFormat: 'automatic', limitsRevision: 1,
  });
  assert.deepEqual(Object.keys(normalizeNotchPreferences(null)), Object.keys(DEFAULT_NOTCH_PREFERENCES));
  const normalized = normalizeNotchPreferences({
    visibility: 'sideways',
    profiles: { 'codex-amorim': { enabled: false, alias: '  Ana ', muted: 'yes' }, 'claude-webrota': { muted: true }, bad: 3 },
    order: ['b', ' a ', 'b', ''],
    hideDefaultWhenDuplicate: false,
    watchLimit: '0.4',
    criticalLimit: 7,
    alerts: { threshold: 1, reset: true },
    resetTimeFormat: 'remaining',
    limitsRevision: 1,
  });
  assert.deepEqual(normalized, {
    visibility: 'open',
    profiles: { 'codex-amorim': { enabled: false, alias: 'Ana', muted: false }, 'claude-webrota': { enabled: true, alias: null, muted: true } },
    order: ['b', 'a'],
    hideDefaultWhenDuplicate: false,
    watchLimit: 0.4,
    criticalLimit: 0.8,
    alerts: { threshold: false, limitReached: false, reset: true },
    resetTimeFormat: 'remaining',
    limitsRevision: 1,
  });
  assert.deepEqual(normalizePreferenceDraft({}).notch, normalizeNotchPreferences(null));
  assert.equal(sanitizePreferences({ notch: { visibility: 'hidden' } }).notch.visibility, 'hidden');
  assert.equal(sanitizePreferences({}).network.desktopName, null, 'o bloco notch nao mexe nas outras secoes');
});

const WEEK = 7 * 24 * 3_600_000;
const limit = (id, label, used, durationMs, extra = {}) => ({ id, label, usedFraction: used, resetsAtMs: 1_800_000_000_000, durationMs, ...extra });
const claudeWith = (week) => ({
  provider: 'claude', headlineId: 'session', weeklyId: 'weekly_all', status: { kind: 'ok' },
  windows: [limit('session', 'session', 0.2, 5 * 3_600_000), ...(week === undefined ? [] : [limit('weekly_all', 'weeklyAll', week, WEEK)])],
});
const codexWith = (secondary, extra = {}) => ({
  provider: 'codex', headlineId: 'primary', weeklyId: secondary ? 'secondary' : null, status: { kind: 'ok' },
  windows: [limit('primary', 'duration', 0.3, 5 * 3_600_000), ...(secondary ? [secondary] : [])], ...extra,
});

test('o anel semanal mostra 0% como leitura, nao como ausencia', async () => {
  const { weeklyState } = await load();
  const zero = weeklyState(claudeWith(0));
  assert.equal(zero.kind, 'available');
  assert.equal(zero.fraction, 0);
  assert.equal(zero.band, 'ample');
  assert.equal(zero.window.id, 'weekly_all');
  assert.equal(zero.resetsAtMs, 1_800_000_000_000);
  const high = weeklyState(claudeWith(0.92), { watchLimit: 0.5, criticalLimit: 0.7 });
  assert.equal(high.band, 'critical');
  assert.equal(weeklyState({ ...claudeWith(0.4), status: { kind: 'stale', sinceMs: 1 } }).stale, true);
});

test('leitura sem janela semanal e conta sem limite semanal, so o anel da sessao', async () => {
  const { weeklyState } = await load();
  assert.deepEqual(weeklyState(codexWith(null)), { kind: 'none' });
  // Janela longa que nao e de uma semana, como o mes do plano gratis.
  assert.deepEqual(weeklyState(codexWith(limit('secondary', 'duration', 0.4, 30 * 24 * 3_600_000))), { kind: 'none' });
  // O Claude sem `weekly_all` na leitura: a conta nao informou limite semanal.
  assert.deepEqual(weeklyState(claudeWith(undefined)), { kind: 'none' });
});

test('o Codex com janela semanal informada ganha o anel, decidido pela duracao', async () => {
  const { weeklyState } = await load();
  const weekly = weeklyState(codexWith(limit('secondary', 'duration', 0.55, WEEK)));
  assert.equal(weekly.kind, 'available');
  assert.equal(weekly.fraction, 0.55);
  // Uma folga de horas na duracao ainda e uma semana.
  assert.equal(weeklyState(codexWith(limit('secondary', 'duration', 0.1, WEEK - 3_600_000))).kind, 'available');
});

test('sem leitura, com erro ou sem duracao, o semanal fica desconhecido', async () => {
  const { weeklyState } = await load();
  assert.deepEqual(weeklyState({ windows: [], status: { kind: 'ok' } }), { kind: 'unknown', reason: 'loading' });
  assert.deepEqual(weeklyState({ windows: [], status: { kind: 'error', message: 'http' } }), { kind: 'unknown', reason: 'error' });
  assert.deepEqual(weeklyState({ windows: [], status: { kind: 'needsAuth' } }), { kind: 'unknown', reason: 'auth' });
  assert.deepEqual(weeklyState(null), { kind: 'unknown', reason: 'loading' });
  // Janela longa sem duracao informada: nao da para dizer que e semanal.
  assert.deepEqual(weeklyState(codexWith(limit('secondary', 'longWindow', 0.6, null))), { kind: 'unknown', reason: 'unconfirmed' });
  // A janela semanal do Claude nao precisa da duracao: o rotulo diz o que ela e.
  assert.equal(weeklyState({ ...claudeWith(0.3), windows: [limit('session', 'session', 0.2, null), limit('weekly_all', 'weeklyAll', 0.3, null)] }).kind, 'available');
  // Fracao ausente na janela semanal nao vira zero.
  assert.deepEqual(weeklyState(claudeWith(null)), { kind: 'unknown', reason: 'unconfirmed' });
});

test('a janela semanal nunca repete a do anel externo', async () => {
  const { weeklyState, weeklyWindow } = await load();
  const same = { provider: 'codex', headlineId: 'primary', weeklyId: 'primary', status: { kind: 'ok' }, windows: [limit('primary', 'duration', 0.3, WEEK)] };
  assert.equal(weeklyWindow(same), null);
  assert.deepEqual(weeklyState(same), { kind: 'none' });
});

test('as faixas padrao sao as do Rust: ambar a partir de 60 por cento e vermelho a partir de 80', async () => {
  const { DEFAULT_WATCH_LIMIT, DEFAULT_CRITICAL_LIMIT } = await load();
  assert.equal(DEFAULT_WATCH_LIMIT, 0.6);
  assert.equal(DEFAULT_CRITICAL_LIMIT, 0.8);
});
