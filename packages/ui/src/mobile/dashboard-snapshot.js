// SPDX-License-Identifier: Apache-2.0
// Retrato do computador para o Inicio do aplicativo. A tela inicial e nativa
// e nao alcanca a ponte do computador; enquanto o terminal esta aberto, a
// pagina manda a casca o que ela ja le: contas e uso dos agentes, pastas de
// projeto e sessoes. A casca guarda o ultimo retrato por computador e mostra
// a idade dele. O e-mail das contas nao sai da pagina.
import { headlineWindow, readingState, weeklyWindow } from '../terminals/ui/AgentProfiles.jsx';
import { windowLabel } from '../notch/copy.js';

export const DASHBOARD_LIMITS = Object.freeze({ accounts: 20, windows: 8, projects: 400, sessions: 100, recent: 10, text: 512 });
const AGENTS = new Set(['codex', 'claude']);

const clip = (value) => (typeof value === 'string' ? value.slice(0, DASHBOARD_LIMITS.text) : '');
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function accountView(profile) {
  const usage = profile.usage || null;
  const headline = headlineWindow(usage);
  const weekly = weeklyWindow(usage);
  const windows = (Array.isArray(usage?.windows) ? usage.windows : [])
    .filter((window) => finite(window.usedFraction) !== null)
    .slice(0, DASHBOARD_LIMITS.windows)
    .map((window) => ({
      id: clip(String(window.id || '')),
      label: clip(windowLabel(window)),
      usedFraction: Math.min(1, Math.max(0, window.usedFraction)),
      resetsAtMs: finite(window.resetsAtMs),
      durationMs: finite(window.durationMs),
      headline: window === headline,
      weekly: window === weekly,
    }));
  return {
    id: clip(profile.id),
    agent: profile.agent,
    label: clip(profile.label || ''),
    plan: profile.plan ? clip(profile.plan) : null,
    active: Boolean(profile.active),
    state: readingState(profile),
    fetchedAtMs: finite(usage?.fetchedAtMs),
    windows,
  };
}

// Monta o retrato a partir das respostas da ponte. Tudo o que falta vira
// lista vazia: uma integracao fora do ar nao derruba as outras.
export function buildDashboardSnapshot({ accounts, repos, sessions, recent, now = Date.now() }) {
  return {
    type: 'dashboard',
    at: now,
    accounts: (Array.isArray(accounts) ? accounts : [])
      .filter((profile) => profile && typeof profile.id === 'string' && AGENTS.has(profile.agent))
      .slice(0, DASHBOARD_LIMITS.accounts)
      .map(accountView),
    projects: (Array.isArray(repos?.repos) ? repos.repos : [])
      .filter((repo) => repo && typeof repo.path === 'string' && repo.path)
      .slice(0, DASHBOARD_LIMITS.projects)
      .map((repo) => ({ name: clip(repo.name || repo.path.split('/').at(-1)), path: clip(repo.path), root: clip(repo.root || '') })),
    sessions: (Array.isArray(sessions) ? sessions : [])
      .filter((session) => session && typeof session.id === 'string' && typeof session.cwd === 'string')
      .slice(0, DASHBOARD_LIMITS.sessions)
      .map((session) => ({
        id: clip(session.id),
        name: clip(session.name || ''),
        cwd: clip(session.cwd),
        status: clip(session.status || ''),
        agent: AGENTS.has(session.activity?.agent) ? session.activity.agent : null,
      })),
    // Ultimas pastas em que o telefone abriu sessao, a mais nova primeiro.
    recent: (Array.isArray(recent) ? recent : [])
      .filter((path) => typeof path === 'string' && path && path.length <= DASHBOARD_LIMITS.text)
      .slice(0, DASHBOARD_LIMITS.recent),
  };
}
