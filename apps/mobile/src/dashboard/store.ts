import { useSyncExternalStore } from 'react';

import { parseDashboard, type AgentId, type DashboardMessage } from '../bridge/messages';
import { deviceFiles, type StoreFiles } from '../desktops/store';

// O que o Início sabe de cada computador: o último retrato que a página
// mandou, os projetos favoritos e a conta escolhida para cada agente. Fica só
// neste celular; o computador não guarda favoritos.
export type DesktopDashboard = {
  snapshot: DashboardMessage | null;
  favorites: string[];
  accounts: Partial<Record<AgentId, string>>;
};

export type DashboardState = {
  loaded: boolean;
  desktops: Readonly<Record<string, DesktopDashboard>>;
};

export const DASHBOARD_FILE = 'dashboard.json';
const MAX_FAVORITES = 50;
const MAX_PATH = 512;

const empty = (): DesktopDashboard => ({ snapshot: null, favorites: [], accounts: {} });

type Desktops = DashboardState['desktops'];
type Change = (desktops: Desktops) => Desktops;

let files: StoreFiles = deviceFiles;
let state: DashboardState = { loaded: false, desktops: {} };
let loading: Promise<void> | null = null;
// Mudanças feitas antes de o arquivo ser lido, refeitas sobre ele.
let pending: Change[] = [];
// Só grava depois de ler o arquivo: gravar antes, ou depois de uma leitura que
// falhou, apagaria o que só o disco tem, como os favoritos dos outros computadores.
let writable = false;
const listeners = new Set<() => void>();

function emit(next: DashboardState) {
  state = next;
  listeners.forEach(listener => listener());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Cada parte é conferida de novo ao ler do disco: um arquivo velho ou
// estragado vira ausência de dado, nunca um retrato inventado.
export function parseDashboardFile(raw: string | null): Record<string, DesktopDashboard> {
  if (!raw) return {};
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return {}; }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.desktops)) return {};
  const out: Record<string, DesktopDashboard> = {};
  for (const [desktopId, entry] of Object.entries(value.desktops)) {
    if (!isRecord(entry)) continue;
    const snapshot = isRecord(entry.snapshot) && entry.snapshot.type === 'dashboard' ? parseDashboard(entry.snapshot) : null;
    const favorites = Array.isArray(entry.favorites)
      ? entry.favorites.filter((path): path is string => typeof path === 'string' && !!path && path.length <= MAX_PATH).slice(0, MAX_FAVORITES)
      : [];
    const accounts: DesktopDashboard['accounts'] = {};
    if (isRecord(entry.accounts)) {
      for (const agent of ['codex', 'claude'] as const) {
        const id = entry.accounts[agent];
        if (typeof id === 'string' && id.length <= MAX_PATH) accounts[agent] = id;
      }
    }
    out[desktopId] = { snapshot, favorites, accounts };
  }
  return out;
}

function persist() {
  if (!writable) return;
  const contents = JSON.stringify({ version: 1, desktops: state.desktops });
  files.write(DASHBOARD_FILE, contents).catch(() => undefined);
}

function apply(change: Change) {
  emit({ ...state, desktops: change(state.desktops) });
  if (state.loaded) { persist(); return; }
  pending.push(change);
  void loadDashboard();
}

function update(desktopId: string, change: (entry: DesktopDashboard) => DesktopDashboard) {
  apply(desktops => ({ ...desktops, [desktopId]: change(desktops[desktopId] ?? empty()) }));
}

export function loadDashboard(): Promise<void> {
  if (!loading) {
    loading = files.read(DASHBOARD_FILE).then(
      raw => {
        // Um retrato ou favorito que chegou antes da leitura terminar é
        // refeito sobre o disco, sem apagar o resto do que estava lá.
        const changes = pending;
        pending = [];
        writable = true;
        emit({ loaded: true, desktops: changes.reduce((desktops, change) => change(desktops), parseDashboardFile(raw)) });
        if (changes.length) persist();
      },
      () => {
        // Sem ler, o arquivo fica como está; o que mudar nesta abertura vale só na memória.
        pending = [];
        emit({ ...state, loaded: true });
      });
  }
  return loading;
}

export function recordSnapshot(desktopId: string, snapshot: DashboardMessage) {
  update(desktopId, entry => ({ ...entry, snapshot }));
}

export function toggleFavorite(desktopId: string, path: string) {
  update(desktopId, entry => ({
    ...entry,
    favorites: entry.favorites.includes(path)
      ? entry.favorites.filter(item => item !== path)
      : [path, ...entry.favorites].slice(0, MAX_FAVORITES)
  }));
}

// Atalho novo entra no topo; repetir não duplica. Só o arquivo deste celular
// muda: a pasta no computador continua intacta.
export function addFavorite(desktopId: string, path: string) {
  if (!path || path.length > MAX_PATH) return;
  update(desktopId, entry => ({
    ...entry,
    favorites: [path, ...entry.favorites.filter(item => item !== path)].slice(0, MAX_FAVORITES)
  }));
}

// Remove o atalho; o diretório real nunca é tocado.
export function removeFavorite(desktopId: string, path: string) {
  update(desktopId, entry => ({ ...entry, favorites: entry.favorites.filter(item => item !== path) }));
}

// Sobe ou desce um favorito na ordem; nas pontas, nada muda.
export function moveFavorite(desktopId: string, path: string, delta: -1 | 1) {
  const favorites = dashboardFor(desktopId).favorites;
  const from = favorites.indexOf(path);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= favorites.length) return;
  update(desktopId, entry => {
    const next = [...entry.favorites];
    [next[from], next[to]] = [next[to]!, next[from]!];
    return { ...entry, favorites: next };
  });
}

// Só muda a conta exibida no Início; a conta ativa do computador continua a mesma.
export function chooseAccount(desktopId: string, agent: AgentId, accountId: string) {
  update(desktopId, entry => ({ ...entry, accounts: { ...entry.accounts, [agent]: accountId } }));
}

export function forgetDashboard(desktopId: string) {
  if (state.loaded && !(desktopId in state.desktops)) return;
  apply(desktops => {
    if (!(desktopId in desktops)) return desktops;
    const next = { ...desktops };
    delete next[desktopId];
    return next;
  });
}

export function dashboardFor(desktopId: string | null | undefined): DesktopDashboard {
  return (desktopId && state.desktops[desktopId]) || empty();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useDashboard(): DashboardState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

// Só para os testes: troca o armazenamento e zera o estado.
export function resetDashboardForTests(nextFiles: StoreFiles, loaded = false) {
  files = nextFiles;
  loading = null;
  pending = [];
  writable = loaded;
  state = { loaded, desktops: {} };
}
