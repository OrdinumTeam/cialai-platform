import { beforeEach, expect, jest, test } from '@jest/globals';
import { act, create } from 'react-test-renderer';
import { Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { setLocale } from '../i18n';
import { Agents } from '../screens/Agents';
import { Projects } from '../screens/Projects';
import { lockedTabs, tabForScreen } from '../state/tabs';
import { dashboardFor, recordSnapshot, resetDashboardForTests, toggleFavorite } from '../dashboard/store';
import {
  AppHeader, BottomNavigation, ChoiceRow, Notice, ComputerCard, EmptyState, PrimaryButton, ProgressIndicator, ProjectCard,
  SearchInput, SecondaryButton, SegmentedControl, SessionCard, StatusBadge
} from './index';

const text = tree => tree.root.findAllByType(Text).map(node => node.props.children).flat(Infinity).join(' ');
const labelled = (tree, label) => tree.root.findAll(node => node.props.accessibilityLabel === label && typeof node.props.onPress === 'function')[0];
const forbiddenPunctuation = /[()–—]| - /;

async function render(element) {
  let tree;
  await act(async () => { tree = create(element); });
  return tree;
}

const metrics = { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 47, left: 0, right: 0, bottom: 34 } };

beforeEach(async () => { await setLocale('pt-BR'); });

test('the active tab follows the screen and native-only screens have none', () => {
  expect(tabForScreen({ kind: 'home' })).toBe('home');
  expect(tabForScreen({ kind: 'desktops' })).toBe('terminals');
  expect(tabForScreen({ kind: 'projects' })).toBe('projects');
  expect(tabForScreen({ kind: 'agents' })).toBe('agents');
  expect(tabForScreen({ kind: 'settings' })).toBe('settings');
  // O carregamento já desenha o início com o esqueleto.
  expect(tabForScreen({ kind: 'loading' })).toBe('home');
  expect(tabForScreen({ kind: 'pair' })).toBeNull();
  expect(tabForScreen({ kind: 'offline', desktopId: 'd', reason: 'no-path' })).toBeNull();
  expect(tabForScreen({ kind: 'shell', desktopId: 'd', url: 'u', transport: null, path: null, reconnecting: false })).toBeNull();
});

test('BottomNavigation lists five tabs, marks the active one and reports the choice', async () => {
  const onSelect = jest.fn();
  const tree = await render(<SafeAreaProvider initialMetrics={metrics}><BottomNavigation active="projects" onSelect={onSelect} /></SafeAreaProvider>);
  const tabs = tree.root.findAll(node => node.props.accessibilityRole === 'tab' && typeof node.props.onPress === 'function');
  expect(tabs.map(node => node.props.accessibilityLabel)).toEqual(['Início', 'Terminais', 'Projetos', 'Agentes', 'Ajustes']);
  expect(tabs.map(node => node.props.accessibilityState.selected)).toEqual([false, false, true, false, false]);
  await act(async () => { labelled(tree, 'Agentes').props.onPress(); });
  expect(onSelect).toHaveBeenCalledWith('agents');
  await act(async () => tree.unmount());
});

// Sem computador vinculado, Terminais, Projetos e Agentes ficam em cinza e sem
// toque; Início e Ajustes seguem livres.
test('BottomNavigation greys out and disables the tabs that need a computer', async () => {
  const onSelect = jest.fn();
  expect(lockedTabs(true)).toEqual([]);
  const tree = await render(<SafeAreaProvider initialMetrics={metrics}>
    <BottomNavigation active="home" disabled={lockedTabs(false)} onSelect={onSelect} />
  </SafeAreaProvider>);
  const tabs = tree.root.findAll(node => node.props.accessibilityRole === 'tab' && typeof node.props.onPress === 'function');
  expect(tabs.map(node => !!node.props.accessibilityState.disabled)).toEqual([false, true, true, true, false]);
  expect(tabs.map(node => !!node.props.disabled)).toEqual([false, true, true, true, false]);
  await act(async () => { labelled(tree, 'Ajustes').props.onPress(); });
  expect(onSelect).toHaveBeenCalledWith('settings');
  await act(async () => tree.unmount());
});

test('Projects explains the empty tab and leads to the terminal', async () => {
  const onBack = jest.fn();
  const onTerminal = jest.fn();
  const tree = await render(<SafeAreaProvider initialMetrics={metrics}>
    <Projects desktops={[]} onBack={onBack} onIntent={jest.fn()} onTerminal={onTerminal} />
  </SafeAreaProvider>);
  expect(text(tree)).toContain('Seus projetos aparecem aqui');
  expect(text(tree)).not.toMatch(forbiddenPunctuation);
  await act(async () => { labelled(tree, 'Ir para o início').props.onPress(); });
  expect(onBack).toHaveBeenCalledTimes(1);
  await act(async () => { tree.root.findAll(node => typeof node.props.onPress === 'function' &&
    node.findAllByType(Text).some(child => child.props.children === 'Abrir o terminal'))[0].props.onPress(); });
  expect(onTerminal).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

test('Agents without a computer explains the tab and leads to pairing', async () => {
  const onBack = jest.fn();
  const onPair = jest.fn();
  const tree = await render(<SafeAreaProvider initialMetrics={metrics}>
    <Agents describe={() => ({ state: 'idle', transport: null })} onBack={onBack} onIntent={jest.fn()} onPair={onPair}
      store={{ version: 2, lastDesktopId: null, desktops: [] }} />
  </SafeAreaProvider>);
  expect(text(tree)).toContain('Seus agentes aparecem aqui');
  expect(text(tree)).not.toMatch(forbiddenPunctuation);
  await act(async () => { labelled(tree, 'Ir para o início').props.onPress(); });
  expect(onBack).toHaveBeenCalledTimes(1);
  await act(async () => { tree.root.findAll(node => typeof node.props.onPress === 'function' &&
    node.findAllByType(Text).some(child => child.props.children === 'Vincular computador'))[0].props.onPress(); });
  expect(onPair).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

test('Projects lists the computer projects with favorites first and opens a new session in the folder', async () => {
  const desktop = { id: 'd_AAAAAAAAAAAAAAAAAAAAAA', name: 'Mac de Foco' };
  const files = new Map();
  resetDashboardForTests({ read: async name => files.get(name) ?? null, write: async (name, value) => { files.set(name, value); }, remove: async () => {} }, true);
  recordSnapshot(desktop.id, { type: 'dashboard', at: 1, accounts: [], recent: ['/p/gama'], projects: [
    { name: 'alfa', path: '/p/alfa', root: '~/p' }, { name: 'beta', path: '/p/beta', root: '~/p' }, { name: 'gama', path: '/p/gama', root: '~/p' }],
  sessions: [{ id: 's1', name: 'alfa', cwd: '/p/alfa', status: 'running', agent: null }] });
  toggleFavorite(desktop.id, '/p/beta');
  const onIntent = jest.fn();
  const tree = await render(<SafeAreaProvider initialMetrics={metrics}>
    <Projects desktops={[desktop]} onBack={jest.fn()} onIntent={onIntent} onTerminal={jest.fn()} />
  </SafeAreaProvider>);
  const names = tree.root.findAll(node => typeof node.props.accessibilityLabel === 'string' && node.props.accessibilityLabel.startsWith('Abrir ') &&
    typeof node.props.onPress === 'function').map(node => node.props.accessibilityLabel);
  expect(names).toEqual(['Abrir beta', 'Abrir gama', 'Abrir alfa']);
  expect(text(tree)).toContain('Favoritos');
  expect(text(tree)).toContain('Recentes');
  expect(text(tree)).toContain('1 sessão aberta');
  expect(text(tree)).toContain('Mac de Foco');
  expect(text(tree)).not.toMatch(forbiddenPunctuation);
  await act(async () => { labelled(tree, 'Abrir alfa').props.onPress(); });
  expect(text(tree)).toContain('Continuar alfa');
  await act(async () => { tree.root.findAll(node => typeof node.props.onPress === 'function' &&
    node.findAllByType(Text).some(child => child.props.children === 'Nova sessão aqui'))[0].props.onPress(); });
  expect(onIntent).toHaveBeenCalledWith(desktop, { kind: 'new-session', cwd: '/p/alfa' });
  await act(async () => { labelled(tree, 'Adicionar projeto').props.onPress(); });
  expect(onIntent).toHaveBeenLastCalledWith(desktop, { kind: 'pick-project' });
  await act(async () => tree.unmount());
});

test('Projects reorders and removes favorite shortcuts without touching the folders', async () => {
  const desktop = { id: 'd_AAAAAAAAAAAAAAAAAAAAAA', name: 'Mac de Foco' };
  const files = new Map();
  resetDashboardForTests({ read: async name => files.get(name) ?? null, write: async (name, value) => { files.set(name, value); }, remove: async () => {} }, true);
  recordSnapshot(desktop.id, { type: 'dashboard', at: 1, accounts: [], sessions: [], recent: [], projects: [
    { name: 'alfa', path: '/p/alfa', root: '~/p' }, { name: 'beta', path: '/p/beta', root: '~/p' }] });
  toggleFavorite(desktop.id, '/p/alfa');
  toggleFavorite(desktop.id, '/p/beta');
  const tree = await render(<SafeAreaProvider initialMetrics={metrics}>
    <Projects desktops={[desktop]} onBack={jest.fn()} onIntent={jest.fn()} onTerminal={jest.fn()} />
  </SafeAreaProvider>);
  const press = async label => { await act(async () => { tree.root.findAll(node => typeof node.props.onPress === 'function' &&
    node.findAllByType(Text).some(child => child.props.children === label))[0].props.onPress(); }); };
  await act(async () => { labelled(tree, 'Abrir alfa').props.onPress(); });
  expect(text(tree)).toContain('A pasta continua no computador');
  await press('Subir');
  expect(dashboardFor(desktop.id).favorites).toEqual(['/p/alfa', '/p/beta']);
  await press('Remover atalho');
  expect(dashboardFor(desktop.id).favorites).toEqual(['/p/beta']);
  expect(dashboardFor(desktop.id).snapshot.projects.map(project => project.path)).toEqual(['/p/alfa', '/p/beta']);
  await act(async () => tree.unmount());
});

test('Projects filters by computer and asks which one receives a new shortcut', async () => {
  const one = { id: 'd_AAAAAAAAAAAAAAAAAAAAAA', name: 'Mac de Foco' };
  const two = { id: 'd_BBBBBBBBBBBBBBBBBBBBBB', name: 'Mini PC' };
  const files = new Map();
  resetDashboardForTests({ read: async name => files.get(name) ?? null, write: async (name, value) => { files.set(name, value); }, remove: async () => {} }, true);
  recordSnapshot(one.id, { type: 'dashboard', at: 1, accounts: [], sessions: [], recent: [], projects: [{ name: 'alfa', path: '/p/alfa', root: '' }] });
  recordSnapshot(two.id, { type: 'dashboard', at: 1, accounts: [], sessions: [], recent: [], projects: [{ name: 'zeta', path: '/z/zeta', root: '' }] });
  const onIntent = jest.fn();
  const tree = await render(<SafeAreaProvider initialMetrics={metrics}>
    <Projects desktops={[one, two]} onBack={jest.fn()} onIntent={onIntent} onTerminal={jest.fn()} />
  </SafeAreaProvider>);
  expect(text(tree)).toContain('alfa');
  expect(text(tree)).toContain('zeta');
  await act(async () => { labelled(tree, 'Adicionar projeto').props.onPress(); });
  expect(onIntent).not.toHaveBeenCalled();
  expect(text(tree)).toContain('Adicionar projeto em qual computador');
  await act(async () => { labelled(tree, 'Mini PC').props.onPress(); });
  expect(text(tree)).not.toContain('alfa');
  await act(async () => { labelled(tree, 'Adicionar projeto').props.onPress(); });
  expect(onIntent).toHaveBeenLastCalledWith(two, { kind: 'pick-project' });
  await act(async () => tree.unmount());
});

test('AppHeader names the back button and each action', async () => {
  const onBack = jest.fn();
  const onAdd = jest.fn();
  const tree = await render(<AppHeader backLabel="Voltar" onBack={onBack} title="Computadores" subtitle="Um nome bem longo"
    actions={[{ icon: 'plus', accessibilityLabel: 'Adicionar', onPress: onAdd }]} />);
  expect(text(tree)).toContain('Computadores');
  await act(async () => { labelled(tree, 'Voltar').props.onPress(); });
  await act(async () => { labelled(tree, 'Adicionar').props.onPress(); });
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(onAdd).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

test('buttons expose the disabled and busy states', async () => {
  const onPress = jest.fn();
  const tree = await render(<View>
    <PrimaryButton accessibilityLabel="Principal" label="Continuar" loading onPress={onPress} />
    <SecondaryButton accessibilityLabel="Secundário" disabled label="Trocar conta" onPress={onPress} />
  </View>);
  const state = label => tree.root.findAll(node => node.props.accessibilityLabel === label && node.props.accessibilityState)[0].props;
  expect(state('Principal').accessibilityState).toEqual({ disabled: true, busy: true });
  expect(state('Principal').disabled).toBe(true);
  expect(state('Secundário').accessibilityState).toEqual({ disabled: true, busy: false });
  expect(state('Secundário').disabled).toBe(true);
  await act(async () => tree.unmount());
});

test('SegmentedControl selects options and SearchInput clears its text', async () => {
  const onChange = jest.fn();
  const onChangeText = jest.fn();
  const tree = await render(<View>
    <SegmentedControl onChange={onChange} value="all" options={[
      { value: 'all', label: 'Todos' }, { value: 'on', label: 'Conectados', count: 2 }, { value: 'off', label: 'Desconectados', disabled: true }
    ]} />
    <SearchInput onChangeText={onChangeText} placeholder="Buscar computador" value="ideapad" />
  </View>);
  expect(labelled(tree, 'Todos').props.accessibilityState).toEqual({ selected: true, disabled: false });
  await act(async () => { labelled(tree, 'Conectados').props.onPress(); });
  expect(onChange).toHaveBeenCalledWith('on');
  expect(labelled(tree, 'Desconectados').props.disabled).toBe(true);
  await act(async () => { labelled(tree, 'Limpar busca').props.onPress(); });
  expect(onChangeText).toHaveBeenCalledWith('');
  await act(async () => tree.unmount());
});

test('ProgressIndicator reports a bounded value', async () => {
  const tree = await render(<View>
    <ProgressIndicator accessibilityLabel="Uso" value={0.62} />
    <ProgressIndicator accessibilityLabel="Excesso" value={4} />
    <ProgressIndicator accessibilityLabel="Inválido" value={Number.NaN} />
  </View>);
  const now = label => tree.root.findAll(node => node.props.accessibilityLabel === label && node.props.accessibilityValue)[0].props.accessibilityValue.now;
  expect(now('Uso')).toBe(62);
  expect(now('Excesso')).toBe(100);
  expect(now('Inválido')).toBe(0);
  await act(async () => tree.unmount());
});

test('ChoiceRow marks the chosen row and reports the press', async () => {
  const onPress = jest.fn();
  const tree = await render(<View>
    <ChoiceRow accessibilityRole="radio" detail="Ativa no computador" icon="laptop" onPress={onPress} selected title="Trabalho" />
    <ChoiceRow accessibilityRole="checkbox" checked={false} onPress={jest.fn()} title="Pessoal" />
  </View>);
  const rows = tree.root.findAll(node => typeof node.props.onPress === 'function' && node.props.accessibilityState);
  expect(rows[0].props.accessibilityState).toEqual({ selected: true, disabled: false });
  expect(rows.at(-1).props.accessibilityState).toEqual({ selected: false, disabled: false, checked: false });
  expect(text(tree)).toContain('Ativa no computador');
  await act(async () => { rows[0].props.onPress(); });
  expect(onPress).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

test('cards render their content and menus', async () => {
  const onMore = jest.fn();
  const tree = await render(<View>
    <ComputerCard badge={{ label: 'Reserva', tone: 'warning' }} meta={[{ icon: 'memory', label: '16 GB RAM' }]} moreLabel="Opções do notebook"
      name="vinicius-IdeaPad-Slim-3" onMore={onMore} selected status={{ label: 'Conectado', tone: 'success' }} />
    <ProjectCard detail="12 pastas" name="psicoapp" selected />
    <Notice detail="Uma tarefa em execução continua na conta em que começou." icon="refresh" title="A troca vale para novas sessões" />
    <SessionCard agent="Claude Code" elapsed="12 min" name="deploy" state={{ label: 'Shell aberto', tone: 'success' }} />
    <StatusBadge label="Desconectado" />
    <EmptyState icon="folder" title="Nada aqui" />
  </View>);
  for (const expected of ['vinicius-IdeaPad-Slim-3', 'Reserva', '16 GB RAM', 'psicoapp', 'A troca vale para novas sessões', 'deploy', 'Desconectado', 'Nada aqui']) {
    expect(text(tree)).toContain(expected);
  }
  await act(async () => { labelled(tree, 'Opções do notebook').props.onPress(); });
  expect(onMore).toHaveBeenCalledTimes(1);
  await act(async () => tree.unmount());
});

// Na faixa que rola, a opção e o nome não encolhem: antes o nome sumia e o chip virava uma bolha vazia.
test('SegmentedControl scrollable keeps each option as wide as its name', async () => {
  const tree = await render(<SegmentedControl onChange={jest.fn()} scrollable value="a" variant="separate"
    options={[{ value: 'a', label: 'vinicius-IdeaPad-Slim-3' }, { value: 'b', label: 'Desktop-Principal' }]} />);
  const flat = style => [style].flat(Infinity).filter(Boolean).reduce((all, item) => ({ ...all, ...item }), {});
  const items = tree.root.findAll(node => node.props.accessibilityRole === 'tab' && typeof node.props.style === 'function');
  expect(items).toHaveLength(2);
  for (const item of items) expect(flat(item.props.style({ pressed: false }))).toMatchObject({ flexGrow: 0, flexShrink: 0 });
  const label = tree.root.findAll(node => node.type === Text && node.props.children === 'Desktop-Principal')[0];
  expect(flat(label.props.style)).toMatchObject({ flexShrink: 0 });
  expect(text(tree)).toContain('vinicius-IdeaPad-Slim-3');
  await act(async () => tree.unmount());
});
