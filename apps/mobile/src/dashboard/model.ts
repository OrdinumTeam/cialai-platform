import type { AgentAccount, AgentId, DashboardMessage, DashboardProject, DashboardSession, UsageWindow } from '../bridge/messages';
import type { DesktopEntry } from '../desktops/store';
import type { DesktopConnection } from '../state/machine';

export type UsageLevel = 'normal' | 'near' | 'exhausted' | 'unavailable';

// Mesmos limiares do card de sessão da página: aviso a partir de 75%.
export function usageLevel(fraction: number | null | undefined): UsageLevel {
  if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return 'unavailable';
  if (fraction >= 1) return 'exhausted';
  if (fraction >= 0.75) return 'near';
  return 'normal';
}

export const percentOf = (fraction: number) => Math.round(Math.min(1, Math.max(0, fraction)) * 100);

export type AgentSummary = {
  agent: AgentId;
  // Conta exibida; nula quando o computador não tem conta deste agente.
  account: AgentAccount | null;
  accounts: AgentAccount[];
  // Janelas do card: a principal e a semanal, quando existem.
  rows: UsageWindow[];
  level: UsageLevel;
  // Leitura sem número: login pendente, erro, sem medição ou ainda lendo.
  readable: boolean;
};

// A conta escolhida no Início vence; sem escolha, a ativa do computador; sem
// ela, a primeira. No Codex o card mostra as janelas de cinco horas e semanal
// separadas; no Claude Code, as janelas que a leitura trouxe.
export function agentSummary(snapshot: DashboardMessage | null, agent: AgentId, chosenId?: string): AgentSummary {
  const accounts = (snapshot?.accounts ?? []).filter(account => account.agent === agent);
  const account = accounts.find(item => item.id === chosenId) ?? accounts.find(item => item.active) ?? accounts[0] ?? null;
  const readable = !!account && (account.state === 'ok' || account.state === 'stale') && account.windows.length > 0;
  const flagged = account ? account.windows.filter(window => window.headline || window.weekly) : [];
  const rows = readable ? (flagged.length ? flagged : account!.windows.slice(0, 2)) : [];
  const ordered = [...rows].sort((a, b) => Number(b.headline) - Number(a.headline));
  const level = readable ? ordered.reduce<UsageLevel>((worst, window) => worse(worst, usageLevel(window.usedFraction)), 'normal') : 'unavailable';
  return { agent, account, accounts, rows: ordered, level, readable };
}

// Contas de um agente com a ativa no computador primeiro; as outras na ordem
// em que o computador as devolveu.
export function agentAccounts(snapshot: DashboardMessage | null, agent: AgentId): AgentAccount[] {
  const accounts = (snapshot?.accounts ?? []).filter(account => account.agent === agent);
  return [...accounts.filter(account => account.active), ...accounts.filter(account => !account.active)];
}

// Janelas do card de uma conta. No Codex, a de cinco horas e a semanal em
// linhas separadas, cada uma só se veio; sem as duas marcadas, as que vieram.
// No Claude Code, todas as que a leitura trouxe, a principal primeiro.
export function accountWindows(account: AgentAccount): UsageWindow[] {
  if (account.state !== 'ok' && account.state !== 'stale') return [];
  if (account.agent === 'codex') {
    const headline = account.windows.find(window => window.headline);
    const weekly = account.windows.find(window => window.weekly && window !== headline);
    const flagged = [headline, weekly].filter((window): window is UsageWindow => !!window);
    if (flagged.length) return flagged;
  }
  return [...account.windows].sort((a, b) => Number(b.headline) - Number(a.headline));
}

export function accountLevel(account: AgentAccount): UsageLevel {
  const windows = accountWindows(account);
  if (!windows.length) return 'unavailable';
  return windows.reduce<UsageLevel>((worst, window) => worse(worst, usageLevel(window.usedFraction)), 'normal');
}

const LEVEL_ORDER: readonly UsageLevel[] = ['normal', 'near', 'exhausted'];
function worse(a: UsageLevel, b: UsageLevel): UsageLevel {
  return LEVEL_ORDER.indexOf(b) > LEVEL_ORDER.indexOf(a) ? b : a;
}

// O conectado primeiro, depois o último usado, depois a ordem do vínculo.
export function orderDesktops(desktops: readonly DesktopEntry[], lastDesktopId: string | null,
  describe: (desktopId: string) => DesktopConnection): DesktopEntry[] {
  const rank = (desktop: DesktopEntry) => {
    const state = describe(desktop.id).state;
    if (state === 'connected') return 0;
    if (state === 'connecting') return 1;
    return desktop.id === lastDesktopId ? 2 : 3;
  };
  return desktops.map((desktop, index) => ({ desktop, index }))
    .sort((a, b) => rank(a.desktop) - rank(b.desktop) || a.index - b.index)
    .map(item => item.desktop);
}

// Favoritos primeiro, na ordem em que foram marcados; os demais por nome.
// Um favorito que sumiu do computador continua na lista, para poder ser desmarcado.
export function orderProjects(projects: readonly DashboardProject[], favorites: readonly string[]): (DashboardProject & { favorite: boolean })[] {
  const byPath = new Map(projects.map(project => [project.path, project]));
  const favored = favorites.map(path => ({ ...(byPath.get(path) ?? { name: baseName(path), path, root: '' }), favorite: true }));
  const rest = projects.filter(project => !favorites.includes(project.path))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(project => ({ ...project, favorite: false }));
  return [...favored, ...rest];
}

export type ProjectEntry = DashboardProject & { favorite: boolean };
export type ProjectSections = { favorites: ProjectEntry[]; recent: ProjectEntry[]; all: ProjectEntry[] };

// Seções da tela Projetos: favoritos na ordem do usuário, as pastas recentes
// que não são favoritas e o restante por nome. Recente fora da lista do
// computador vira um item só com o nome da pasta.
export function projectSections(snapshot: DashboardMessage | null, favorites: readonly string[], query = ''): ProjectSections {
  const term = query.trim().toLocaleLowerCase();
  const matches = (project: DashboardProject) => !term || `${project.name} ${project.path}`.toLocaleLowerCase().includes(term);
  const projects = snapshot?.projects ?? [];
  const byPath = new Map(projects.map(project => [project.path, project]));
  const ordered = orderProjects(projects, favorites);
  const favored = ordered.filter(project => project.favorite);
  const recentPaths = (snapshot?.recent ?? []).filter(path => !favorites.includes(path));
  const recent = recentPaths.map(path => ({ ...(byPath.get(path) ?? { name: baseName(path), path, root: '' }), favorite: false }));
  const all = ordered.filter(project => !project.favorite && !recentPaths.includes(project.path));
  return { favorites: favored.filter(matches), recent: recent.filter(matches), all: all.filter(matches) };
}

// Caminho curto para o card: a pasta pessoal vira ~ e o meio some.
export function shortPath(path: string): string {
  const home = path.replace(/^\/(?:home|Users)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');
  const separator = home.includes('\\') && !home.includes('/') ? '\\' : '/';
  const parts = home.split(separator).filter(Boolean);
  if (parts.length <= 3) return home;
  const lead = home.startsWith(separator) ? separator : '';
  return lead + [parts[0], '…', ...parts.slice(-2)].join(separator);
}

export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

const ENDED_STATUSES = new Set(['exited', 'error']);

// Sessões abertas dentro da pasta do projeto, inclusive em subpastas, com a
// barra do Windows também. As que terminaram não contam como abertas.
export function sessionsIn(snapshot: DashboardMessage | null, path: string): DashboardSession[] {
  const root = path.replace(/[\\/]+$/, '');
  return (snapshot?.sessions ?? []).filter(session => !ENDED_STATUSES.has(session.status) &&
    (session.cwd === root || session.cwd.startsWith(`${root}/`) || session.cwd.startsWith(`${root}\\`)));
}

export function liveSessions(snapshot: DashboardMessage | null): DashboardSession[] {
  return (snapshot?.sessions ?? []).filter(session => session.status === 'running' || session.status === 'starting');
}

// Fundo da capa de cada projeto, estável pelo nome.
export const PROJECT_TINTS = ['pink', 'blue', 'green', 'orange', 'violet'] as const;
export type ProjectTint = typeof PROJECT_TINTS[number];
export function projectTint(name: string): ProjectTint {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PROJECT_TINTS[hash % PROJECT_TINTS.length]!;
}
