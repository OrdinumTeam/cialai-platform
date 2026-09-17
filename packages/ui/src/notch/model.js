// SPDX-License-Identifier: Apache-2.0
// Logica pura da barra de IA: banda de uso, janela do anel, resumo de
// atividade, agendador do hover, posicao do popover e ordem dos perfis. Sem
// DOM e sem React, para os testes cobrirem cada decisao sem abrir o app.

export const DEFAULT_WATCH_LIMIT = 0.5;
export const DEFAULT_CRITICAL_LIMIT = 0.7;
/// O ponteiro pode ir da celula ao popover sem ele fechar no caminho.
export const HOVER_GRACE_MS = 180;
/// Altura da toolbar, que o popover nunca cobre.
export const TOOLBAR_HEIGHT = 52;
/// Distancia do popover ate a barra e ate as bordas da janela.
export const CARD_GAP = 10;
export const CARD_WIDTH = 248;
export const CARD_MAX_HEIGHT = 420;
export const BAR_WIDTH = 84;
export const BAR_COLLAPSED_WIDTH = 22;

/// Atalho que alterna a barra: Shift+Cmd+N no macOS, como no plano. Nos
/// outros sistemas Ctrl+Shift+N e a variante segura de novo arquivo dentro
/// do terminal, entao a barra fica com Mod+Shift+A.
export function toggleShortcut(os) {
  return os === 'macos' ? 'Mod+Shift+N' : 'Mod+Shift+A';
}

const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/// Banda de uso. Os limiares sao preferencia; os padroes sao 50 e 70 por
/// cento. Sem leitura a banda e `none`, que nao e o mesmo que zero.
export function bandOf(fraction, watch = DEFAULT_WATCH_LIMIT, critical = DEFAULT_CRITICAL_LIMIT) {
  const used = number(fraction);
  if (used === null) return 'none';
  if (used >= 1) return 'exhausted';
  if (used >= critical) return 'critical';
  if (used >= watch) return 'watch';
  return 'ample';
}

/// A janela do anel, apontada por `headlineId`. Sem ela o anel mostra um
/// traco, que e diferente de zero.
export function headlineWindow(snapshot) {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  return windows.find((limit) => limit && limit.id === snapshot.headlineId) || null;
}

/// O que a celula de um perfil desenha: fracao, banda, se ha leitura e se
/// ela envelheceu.
export function cellState(snapshot, prefs = {}) {
  const headline = headlineWindow(snapshot);
  const fraction = headline ? number(headline.usedFraction) : null;
  const hasReading = Array.isArray(snapshot?.windows) && snapshot.windows.length > 0;
  const stale = !hasReading || snapshot?.status?.kind === 'stale';
  return { fraction, hasReading, stale, band: bandOf(fraction, prefs.watchLimit, prefs.criticalLimit) };
}

/// Resumo da atividade de um perfil a partir das sessoes: aguardando vence
/// trabalhando, que vence concluido. E o mesmo que o Rust publica em
/// `notch://sessions`; aqui serve as fixtures.
export function activitySummary(sessions = []) {
  const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
  const waiting = list.filter((session) => session.state === 'waiting').length;
  const busy = list.filter((session) => session.state === 'busy').length;
  const state = waiting ? 'waiting' : busy ? 'busy' : list.some((session) => session.state === 'success') ? 'success' : 'idle';
  return { state, count: list.length, waiting, busy };
}

/// Janelas sem grupo primeiro, depois cada grupo na ordem em que aparece.
export function groupWindows(windows = []) {
  const plain = [];
  const groups = new Map();
  (Array.isArray(windows) ? windows : []).forEach((limit) => {
    if (!limit) return;
    if (!limit.group) {
      plain.push(limit);
      return;
    }
    if (!groups.has(limit.group)) groups.set(limit.group, []);
    groups.get(limit.group).push(limit);
  });
  return { plain, groups: [...groups.entries()].map(([group, limits]) => ({ group, limits })) };
}

/// Agendador do hover. `onChange` recebe o indice da celula sob o ponteiro,
/// ou -1 quando ele saiu e a folga passou. `keep` segura o popover aberto
/// enquanto o ponteiro esta sobre ele.
export function createHoverScheduler(onChange, { graceMs = HOVER_GRACE_MS, schedule = setTimeout, cancel = clearTimeout } = {}) {
  let timer = null;
  let current = -1;
  const clear = () => {
    if (timer === null) return;
    cancel(timer);
    timer = null;
  };
  const set = (index) => {
    if (current === index) return;
    current = index;
    onChange(index);
  };
  return {
    enter(index) { clear(); set(index); },
    leave() { clear(); timer = schedule(() => { timer = null; set(-1); }, graceMs); },
    keep() { clear(); },
    dispose() { clear(); },
    current: () => current,
  };
}

/// Posicao do popover: a esquerda da barra, alinhado ao topo da celula,
/// abaixo da toolbar e preso a janela embaixo. Posicao fixa porque a barra
/// rola e o popover nao pode rolar junto nem ser recortado por ela.
export function cardPlacement({ barLeft, cellTop, viewportWidth, viewportHeight }) {
  const right = viewportWidth - barLeft + CARD_GAP;
  const maxHeight = Math.min(viewportHeight - TOOLBAR_HEIGHT - 2 * CARD_GAP, CARD_MAX_HEIGHT);
  const low = TOOLBAR_HEIGHT + CARD_GAP;
  const high = Math.max(low, viewportHeight - maxHeight - CARD_GAP);
  const top = Math.min(Math.max(cellTop, low), high);
  return { top, right, width: CARD_WIDTH, maxHeight };
}

/// Ordem em que os aneis aparecem: a salva primeiro, perfis novos no fim.
export function orderedProfiles(profiles = [], order = []) {
  const rank = new Map((Array.isArray(order) ? order : []).map((id, index) => [id, index]));
  const list = (Array.isArray(profiles) ? profiles : []).filter((profile) => profile && profile.id);
  const known = list.filter((profile) => rank.has(profile.id));
  const fresh = list.filter((profile) => !rank.has(profile.id));
  known.sort((a, b) => rank.get(a.id) - rank.get(b.id));
  return [...known, ...fresh];
}

/// Move um perfil uma posicao; devolve a mesma lista quando nao ha para onde.
export function moveProfile(ids, id, direction) {
  const list = Array.isArray(ids) ? [...ids] : [];
  const index = list.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= list.length) return ids;
  list.splice(target, 0, list.splice(index, 1)[0]);
  return list;
}

/// Uma pasta sem sufixo que repete a conta de um perfil nomeado fica oculta,
/// a nao ser que tenha apelido.
export function duplicateHidden(profile, prefs = {}) {
  const row = prefs.profiles?.[profile?.id] || {};
  return Boolean(profile?.duplicate) && prefs.hideDefaultWhenDuplicate !== false && !row.alias;
}
