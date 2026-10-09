// SPDX-License-Identifier: Apache-2.0
// Envia o retrato do Inicio a casca enquanto a pagina esta aberta: ao
// hidratar, a cada minuto e pouco depois de as sessoes mudarem. As pastas de
// projeto mudam devagar e sao relidas a cada cinco minutos.
import { invoke, hasBridge } from '../lib/native.js';
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
  const optional = (command) => invoke(command).catch(() => null);
  async function send({ fresh = true } = {}) {
    if (stopped || isDemo() || !hasBridge()) return;
    if (fresh) accounts = await optional('agent_profiles');
    if (!repos || Date.now() - reposAt > REPOS_MS) {
      const next = await optional('list_repo_dirs');
      if (next) { repos = next; reposAt = Date.now(); }
    }
    if (stopped) return;
    try { postDashboard(buildDashboardSnapshot({ accounts, repos, sessions: getState().sessions, recent: getRecent() })); }
    catch (_error) { /* sem casca para receber */ }
  }
  hydrate().then(() => send()).catch(() => undefined);
  timer = setInterval(() => { void send(); }, SNAPSHOT_MS);
  const off = subscribe((event) => {
    if (event.type !== 'sessions') return;
    clearTimeout(soon);
    soon = setTimeout(() => { void send({ fresh: false }); }, SESSIONS_DEBOUNCE_MS);
  });
  return () => { stopped = true; clearInterval(timer); clearTimeout(soon); off(); };
}
