// SPDX-License-Identifier: Apache-2.0
// Envia o retrato do Inicio a casca enquanto a pagina esta aberta: ao
// conectar, a cada minuto e pouco depois de as sessoes mudarem. Nada sai sem a
// ponte conectada: `hydrate()` resolve antes de o computador responder e um
// pedido feito nessa janela vira `null`, que apagaria na casca o retrato bom
// com listas vazias. Por isso o envio espera a conexao, repete a leitura das
// contas enquanto ela nao veio e nao posta sem elas. As pastas de projeto mudam
// devagar e sao relidas a cada cinco minutos.
import { invoke, hasBridge, isTauri } from '../lib/native.js';
import * as remote from '../lib/remote.js';
import { isMobileShell, postDashboard } from '../lib/shell.js';
import { getRecent, getState, hydrate, isDemo, subscribe } from '../terminals/runtime.js';
import { buildDashboardSnapshot } from './dashboard-snapshot.js';

const SNAPSHOT_MS = 60_000;
const REPOS_MS = 5 * 60_000;
const SESSIONS_DEBOUNCE_MS = 2000;

export function startDashboardFeed() {
  if (!isMobileShell()) return () => {};
  let stopped = false;
  let repos = null;
  let reposAt = 0;
  let accounts = null;
  let timer = null;
  let soon = null;
  const connected = () => isTauri() || remote.state().status === 'connected';
  const optional = (command) => invoke(command).catch(() => null);
  async function send({ fresh = true } = {}) {
    // Antes da hidratacao a lista de sessoes ainda esta vazia e um retrato
    // apagaria as sessoes abertas que a casca conhece.
    if (stopped || isDemo() || !hasBridge() || !connected() || !getState().hydrated) return;
    if (fresh || accounts === null) {
      const next = await optional('agent_profiles');
      if (Array.isArray(next)) accounts = next;
    }
    if (!repos || Date.now() - reposAt > REPOS_MS) {
      const next = await optional('list_repo_dirs');
      if (next) { repos = next; reposAt = Date.now(); }
    }
    if (stopped || !connected()) return;
    // Sem a lista de contas o retrato nao representa o computador.
    if (accounts === null) return;
    try { postDashboard(buildDashboardSnapshot({ accounts, repos, sessions: getState().sessions, recent: getRecent() })); }
    catch (_error) { /* sem casca para receber */ }
  }
  hydrate().then(() => { if (connected()) void send(); }).catch(() => undefined);
  timer = setInterval(() => { void send(); }, SNAPSHOT_MS);
  const off = subscribe((event) => {
    if (event.type !== 'sessions') return;
    clearTimeout(soon);
    soon = setTimeout(() => { void send({ fresh: false }); }, SESSIONS_DEBOUNCE_MS);
  });
  // A ponte avisa os ouvintes de forma sincrona dentro do `publish`, e a
  // sincronizacao das sessoes so comeca depois; o envio espera o mesmo prazo
  // do evento de sessoes, para o primeiro retrato ja sair com elas.
  const offState = remote.subscribeState((value) => {
    if (value.status !== 'connected') return;
    clearTimeout(soon);
    soon = setTimeout(() => { void send({ fresh: true }); }, SESSIONS_DEBOUNCE_MS);
  });
  return () => { stopped = true; clearInterval(timer); clearTimeout(soon); off(); offState(); };
}
