// SPDX-License-Identifier: Apache-2.0
// Busca e filtros da lista de terminais do celular. Puro: recebe o estado ja
// descrito por `describe()` e a lista na ordem de `orderedSessions()`, e nunca
// reordena, para as fixadas e a ordem manual ficarem como o usuario deixou.

export const SESSION_FILTERS = ['all', 'active', 'finished'];

// Fase visual da sessao, separada da conexao do terminal: erro, finalizada,
// pausada por Ctrl Z ou ativa. Esperando o usuario e resposta entregue ainda
// sao sessoes ativas, so com outro tom.
export function sessionPhase(status) {
  const code = status?.code;
  if (code === 'error' || code === 'failed') return 'error';
  if (code === 'exited' || code === 'disconnected') return 'finished';
  if (code === 'stopped') return 'paused';
  return 'active';
}

// Ativas reune ativas e pausadas, porque as duas ainda tem processo vivo;
// Finalizadas reune as que terminaram, com ou sem erro.
export function inFilter(phase, filter) {
  if (filter === 'active') return phase === 'active' || phase === 'paused';
  if (filter === 'finished') return phase === 'finished' || phase === 'error';
  return true;
}

// Acento, caixa e a diferenca entre NFC e NFD nao atrapalham a busca, como na
// lista do computador.
export function foldText(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function matchesQuery(session, query) {
  const needle = foldText(query).trim();
  if (!needle) return true;
  return [session.name, session.subtitle, session.cwd].some((value) => foldText(value).includes(needle));
}

// `phaseOf` recebe a sessao e devolve a fase; a tela passa
// `session => sessionPhase(describe(session))`.
export function filterSessions(sessions, { query = '', filter = 'all', phaseOf }) {
  return sessions.filter((session) => matchesQuery(session, query) && inFilter(phaseOf(session), filter));
}

// Contagem por filtro, para o rotulo de Ativas.
export function countSessions(sessions, filter, phaseOf) {
  return sessions.reduce((total, session) => total + (inFilter(phaseOf(session), filter) ? 1 : 0), 0);
}
