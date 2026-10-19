// SPDX-License-Identifier: Apache-2.0
// Tela de contas dos agentes, com uma ponte falsa. O cliente só manda o id do
// perfil; caminho de credencial e chave de conta nunca aparecem aqui.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const source = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

const mocks = {
  native: `export const invoke = (cmd, args) => fixture.invoke(cmd, args); export const isTauri = () => false;`,
  SessionCard: `export const planTone = (percent) => (percent >= 80 ? 'bad' : percent >= 60 ? 'warn' : 'ok');`,
  files: `export const fmtPlan = (value) => \`\${Math.round(value)}%\`;`,
};

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/terminals/ui/AgentProfiles.jsx', import.meta.url))],
  bundle: true, write: false, format: 'cjs', external: ['react', 'react-dom', 'lucide-react'],
  plugins: [{ name: 'profiles-boundaries', setup(api) {
    api.onResolve({ filter: /\.svg\?raw$/ }, ({ path }) => ({ path, namespace: 'glyph' }));
    api.onLoad({ filter: /.*/, namespace: 'glyph' }, () => ({ contents: 'export default "<svg></svg>";', loader: 'js' }));
    api.onResolve({ filter: /\.(js|jsx)$/ }, ({ path }) => {
      const key = path.split('/').at(-1).replace(/\.jsx?$/, '');
      if (mocks[key]) return { path: key, namespace: 'fixture' };
    });
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks[path], loader: 'js' }));
  } }],
});

// A leitura de uso chega no formato da loja da Barra de IA, igual para os
// dois provedores: janelas com rótulo, janela do anel declarada, estado e
// instante da leitura.
const reading = (over = {}) => ({
  id: 'x', provider: 'claude', label: 'x', configDir: '', fidelity: 'official',
  status: { kind: 'ok' }, windows: [], headlineId: null, weeklyId: null,
  fetchedAtMs: 1_700_000_000_000, source: 'cli', ...over,
});

const LIST = [
  {
    id: 'claude',
    agent: 'claude',
    label: 'claude',
    plan: 'max',
    isDefault: true,
    active: false,
    needsLogin: false,
    usage: reading({
      id: 'claude',
      plan: 'max',
      headlineId: 'session',
      weeklyId: 'weekly_all',
      windows: [
        { id: 'session', label: 'session', usedFraction: 0.41 },
        { id: 'weekly_all', label: 'weeklyAll', usedFraction: 0.12 },
      ],
    }),
  },
  {
    id: 'claude-webrota',
    agent: 'claude',
    label: 'webrota',
    plan: 'max',
    isDefault: false,
    active: true,
    needsLogin: false,
    usage: reading({ id: 'claude-webrota', plan: 'max', headlineId: 'session', windows: [{ id: 'session', label: 'session', usedFraction: 0.92 }] }),
  },
  {
    id: 'codex-nova',
    agent: 'codex',
    label: 'nova',
    plan: null,
    isDefault: false,
    active: false,
    needsLogin: true,
    usage: reading({ id: 'codex-nova', provider: 'codex', status: { kind: 'needsAuth' }, fetchedAtMs: 0 }),
  },
  {
    id: 'codex-erro',
    agent: 'codex',
    label: 'erro',
    plan: 'plus',
    isDefault: false,
    active: false,
    needsLogin: false,
    usage: reading({ id: 'codex-erro', provider: 'codex', status: { kind: 'error', message: 'http', detail: '500' }, windows: [] }),
  },
  {
    id: 'codex-velho',
    agent: 'codex',
    label: 'velho',
    plan: 'pro',
    isDefault: false,
    active: false,
    needsLogin: false,
    usage: reading({ id: 'codex-velho', provider: 'codex', status: { kind: 'stale', sinceMs: 1 }, headlineId: 'primary', windows: [{ id: 'primary', label: 'session', usedFraction: 0.5 }] }),
  },
];

function load() {
  const calls = [];
  const context = vm.createContext({
    fixture: { calls, invoke: (cmd, args) => { calls.push({ cmd, args }); return Promise.resolve(LIST); } },
    console, module: { exports: {} }, exports: {}, require: createRequire(import.meta.url),
    window: {}, document: { documentElement: { lang: 'pt-BR', dataset: {} } },
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vm.runInContext(bundle.outputFiles[0].text, context);
  return { api: context.module.exports, calls };
}

test('as contas são agrupadas por agente, na ordem que o computador devolveu', () => {
  const { api } = load();
  const groups = api.groupProfiles(LIST);
  assert.deepEqual([...groups.map((group) => group.id)], ['claude', 'codex']);
  assert.deepEqual([...groups[0].profiles.map((profile) => profile.id)], ['claude', 'claude-webrota']);
  assert.equal(groups[1].profiles.length, 3);
  // Agente sem conta nenhuma não vira seção vazia.
  assert.equal(api.groupProfiles([]).length, 0);
  assert.deepEqual([...api.AGENTS], ['claude', 'codex']);
});

test('a lista plana segue a ordem do computador, Claude Code e depois Codex, sem subir a conta ativa', () => {
  const { api } = load();
  const rows = api.flattenProfiles(LIST);
  assert.deepEqual([...rows.map((profile) => profile.id)], ['claude', 'claude-webrota', 'codex-nova', 'codex-erro', 'codex-velho']);
  // A conta ativa é a segunda e fica onde está: as linhas não pulam a cada troca.
  assert.equal(rows[1].active, true);
  assert.equal(api.flattenProfiles([]).length, 0);
  assert.equal(api.flattenProfiles(null).length, 0);
});

test('cada linha carrega o símbolo do agente dela, e a tela não agrupa mais por agente', () => {
  const { api } = load();
  const claude = renderToStaticMarkup(React.createElement(api.ProfileRow, { profile: LIST[0], busy: false, onSelect: () => {} }));
  assert.match(claude, /agent-profiles__glyph/);
  assert.match(claude, /role="img"/);
  assert.match(claude, /aria-label="Claude Code"/);
  const codex = renderToStaticMarkup(React.createElement(api.ProfileRow, { profile: LIST[2], busy: false, onSelect: () => {} }));
  assert.match(codex, /aria-label="Codex"/);
  const text = source('../src/terminals/ui/AgentProfiles.jsx');
  assert.match(text, /agent-profiles__list/);
  assert.doesNotMatch(text, /agent-profiles__group|agent-profiles__head/);
  // Um botão de perfil novo por agente no rodapé, com o nome do agente no rótulo.
  assert.match(text, /terminal\.profiles\.createFor/);
  assert.match(text, /onCreate\(id, load\)/);
  assert.match(text, /agent-profiles__actions/);
  // O símbolo não tem cor de marca, no computador nem no celular.
  const css = source('../src/views/Terminais.css');
  assert.doesNotMatch(css, /#D97757/i);
  assert.doesNotMatch(css, /agent-profiles__glyph--claude/);
  assert.match(css, /\.agent-profiles__list\{display:flex;flex-direction:column/);
  assert.match(css, /\.agent-profiles__row\{display:grid;grid-template-columns:auto minmax\(0,1fr\) auto auto/);
});

test('a tela avisa que a troca vale só para sessões novas', () => {
  const { api } = load();
  const html = renderToStaticMarkup(React.createElement(api.default, {}));
  assert.match(html, /A troca vale para sessões novas/);
  assert.match(html, /continua na conta em que começou/);
});

test('nenhum caminho de credencial nem chave de conta aparece na tela', () => {
  // Os comentários explicam o que a tela não faz; a busca é no código.
  const text = source('../src/terminals/ui/AgentProfiles.jsx').replace(/^\s*\/\/.*$/gm, '');
  for (const forbidden of ['accountKey', 'auth.json', 'configDir', 'config_dir', '.credentials']) {
    assert.ok(!text.includes(forbidden), `${forbidden} não pode estar na tela`);
  }
  // O cliente manda o id do perfil e mais nada.
  assert.match(text, /invoke\('agent_profile_select', \{ agent: profile\.agent, id: profile\.id \}\)/);
  assert.doesNotMatch(text, /CLAUDE_CONFIG_DIR|CODEX_HOME/, 'o cliente nunca envia variável de ambiente');
});

test('a conta em uso é marcada e as outras oferecem a troca', () => {
  const { api } = load();
  const groups = api.groupProfiles(LIST);
  const active = groups[0].profiles.filter((profile) => profile.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].id, 'claude-webrota');
  const text = source('../src/terminals/ui/AgentProfiles.jsx');
  assert.match(text, /terminal\.profiles\.needsLogin/, 'conta sem credencial aparece como aguardando login');
  // O rótulo do botão é curto; a explicação do efeito fica uma vez só no topo.
  assert.match(text, /terminal\.profiles\.use'/);
  assert.match(text, /terminal\.profiles\.runningStays/);
});

test('o tom do número segue as mesmas faixas em qualquer provedor', () => {
  const { api } = load();
  // As faixas da Barra de IA: ambar de 60 a 79 por cento, vermelho de 80.
  assert.equal(api.usageTone(0.41), 'ok');
  assert.equal(api.usageTone(0.59), 'ok');
  assert.equal(api.usageTone(0.6), 'warn');
  assert.equal(api.usageTone(0.79), 'warn');
  assert.equal(api.usageTone(0.8), 'bad');
  assert.equal(api.usageTone(0.95), 'bad');
  // Sem leitura não há tom, e muito menos zero por cento.
  assert.equal(api.usageTone(null), 'none');
  assert.equal(api.usageTone(undefined), 'none');
});

test('a janela do anel é a declarada pelo provedor, e a semanal não repete a do anel', () => {
  const { api } = load();
  assert.equal(api.headlineWindow(LIST[0].usage).id, 'session');
  assert.equal(api.weeklyWindow(LIST[0].usage).id, 'weekly_all');
  // Sem janela declarada, nada é promovido ao lugar dela.
  assert.equal(api.headlineWindow({ windows: [{ id: 'session', usedFraction: 0.5 }] }), null);
  assert.equal(api.weeklyWindow({ headlineId: 'session', weeklyId: 'session', windows: [] }), null);
});

test('cada estado de leitura tem nome próprio, e nenhum deles é zero por cento', () => {
  const { api } = load();
  assert.equal(api.readingState(LIST[0]), 'ok');
  assert.equal(api.readingState(LIST[2]), 'needsLogin');
  assert.equal(api.readingState(LIST[3]), 'error');
  assert.equal(api.readingState(LIST[4]), 'stale');
  assert.equal(api.readingState({ usage: { status: { kind: 'unsupported' }, windows: [] } }), 'unmetered');
  assert.equal(api.readingState({ usage: { status: { kind: 'ok' }, windows: [], fetchedAtMs: 0 } }), 'reading');
  assert.equal(api.readingState({}), 'unavailable');
});

test('Claude Code e Codex mostram plano e percentual pelo mesmo caminho', () => {
  const { api } = load();
  const html = renderToStaticMarkup(React.createElement(api.default, {}));
  // Sem dados ainda: a primeira pintura são cartões fantasmas que dizem que
  // estão lendo, não zero.
  assert.match(html, /Lendo as contas/);
  assert.match(html, /agent-profiles__skeleton/);
  assert.match(html, /aria-busy="true"/);
  assert.doesNotMatch(html, /0%/);
  const text = source('../src/terminals/ui/AgentProfiles.jsx');
  // O mesmo componente desenha os dois provedores: nada é condicionado ao
  // nome do agente na hora de mostrar plano ou número.
  assert.doesNotMatch(text.replace(/^\s*\/\/.*$/gm, ''), /agent === 'claude'|agent === 'codex'/);
  assert.match(text, /windowLabel\(headline\)/, 'o percentual vem com o nome da janela');
});

test('a lista relê o uso antes de buscar as contas de novo', () => {
  const text = source('../src/terminals/ui/AgentProfiles.jsx');
  assert.match(text, /invoke\('agent_profiles_refresh'\)/);
});

test('o item de menu que abre o agente numa conta existe nos dois lados e respeita o primeiro plano', () => {
  const bench = source('../src/terminals/ui/Workbench.jsx');
  assert.match(bench, /id: 'launch'/);
  assert.match(bench, /disabled: session\.status !== 'running' \|\| Boolean\(session\.activity\?\.foreground\)/);
  assert.match(bench, /terminal\.profiles\.launchBusy/);
  const menu = source('../src/terminals/ui/PhoneSessionMenu.jsx');
  assert.match(menu, /kind: 'launch'/);
  assert.match(menu, /disabled: !running \|\| Boolean\(session\.activity\?\.foreground\)/);
});

test('cada conta vira um cartão com plano, selo de padrão e uma barra por janela', () => {
  const { api } = load();
  const html = renderToStaticMarkup(React.createElement(api.ProfileRow, { profile: LIST[0], busy: false, onSelect: () => {} }));
  assert.match(html, /agent-profiles__tag--plan">max</);
  assert.match(html, /agent-profiles__tag--default">padrão</);
  assert.equal((html.match(/agent-profiles__bar/g) || []).length, 2, 'cinco horas e semanal, cada uma com a sua barra');
  assert.match(html, /width:41%/);
  assert.match(html, /41%/);
  assert.match(html, /Usar claude nas novas sessões/);
  // A conta em uso perto do limite pinta a barra de alarme e não oferece troca.
  const active = renderToStaticMarkup(React.createElement(api.ProfileRow, { profile: LIST[1], busy: false, onSelect: () => {} }));
  assert.match(active, /is-active/);
  assert.match(active, /agent-profiles__window--bad/);
  assert.match(active, /Em uso/);
  assert.doesNotMatch(active, /agent-profiles__use"/);
  // Sem leitura, nenhuma barra e nenhum número.
  const login = renderToStaticMarkup(React.createElement(api.ProfileRow, { profile: LIST[2], busy: false, onSelect: () => {} }));
  assert.doesNotMatch(login, /agent-profiles__bar|\d+%/);
  assert.match(login, /aguardando login/);
});

test('o erro de leitura aparece como alerta com a opção de tentar de novo', () => {
  const text = source('../src/terminals/ui/AgentProfiles.jsx');
  assert.match(text, /className="agent-profiles__error" role="alert"/);
  assert.match(text, /className="agent-profiles__retry" onClick=\{load\}/);
  assert.match(text, /terminal\.profiles\.retry/);
  const css = source('../src/views/Terminais.css');
  assert.match(css, /prefers-reduced-motion: reduce\)\{\.agent-profiles__shimmer\{animation:none\}/);
});

test('o limite semanal segue a regra do anel interno: barra só para sete dias, linha discreta no resto', () => {
  const { api } = load();
  const HOUR = 3_600_000;
  const row = (usage) => renderToStaticMarkup(React.createElement(api.ProfileRow, { profile: { ...LIST[0], usage: reading(usage) }, busy: false, onSelect: () => {} }));
  const bars = (html) => (html.match(/agent-profiles__bar/g) || []).length;
  // Disponível: a janela semanal do Claude e a de 168 horas do Codex.
  assert.equal(api.profileWeekly(LIST[0]).kind, 'available');
  const codexWeek = { headlineId: 'primary', weeklyId: 'secondary', windows: [{ id: 'primary', label: 'duration', usedFraction: 0.03, durationMs: 5 * HOUR }, { id: 'secondary', label: 'duration', usedFraction: 0.09, durationMs: 168 * HOUR }] };
  const week = row(codexWeek);
  assert.equal(bars(week), 2);
  assert.doesNotMatch(week, /agent-profiles__weekly/);
  // Sem janela semanal na leitura: linha de sem limite, nenhuma barra a mais.
  const none = row({ headlineId: 'session', windows: [{ id: 'session', label: 'session', usedFraction: 0.5 }] });
  assert.equal(bars(none), 1);
  assert.match(none, /agent-profiles__weekly agent-profiles__weekly--none">Sem limite semanal informado</);
  // Janela longa que não é de uma semana, como o mês do plano grátis: também sem limite semanal, e a barra dela some.
  const month = row({ ...codexWeek, windows: [codexWeek.windows[0], { ...codexWeek.windows[1], durationMs: 30 * 24 * HOUR }] });
  assert.equal(bars(month), 1);
  assert.match(month, /agent-profiles__weekly--none/);
  // Janela longa sem duração informada: a leitura não confirma, e nada vira zero.
  const unknown = row({ ...codexWeek, windows: [codexWeek.windows[0], { id: 'secondary', label: 'duration', usedFraction: 0.09 }] });
  assert.equal(bars(unknown), 1);
  assert.match(unknown, /agent-profiles__weekly agent-profiles__weekly--unknown">Janela longa sem duração informada</);
  // A dica continua listando a janela; a tela não a desenha como medida.
  assert.doesNotMatch(unknown, /<strong>9%/);
  // A janela do anel já é a semanal: nenhuma linha de sem limite.
  const same = row({ headlineId: 'weekly_all', weeklyId: 'weekly_all', windows: [{ id: 'weekly_all', label: 'weeklyAll', usedFraction: 0.2 }] });
  assert.equal(bars(same), 1);
  assert.doesNotMatch(same, /agent-profiles__weekly/);
  // Sem leitura, o estado da linha fala sozinho, sem linha semanal.
  const login = renderToStaticMarkup(React.createElement(api.ProfileRow, { profile: LIST[2], busy: false, onSelect: () => {} }));
  assert.doesNotMatch(login, /agent-profiles__weekly/);
  // O estado da linha chega no formato da Barra de IA.
  assert.equal(api.profileSnapshot(LIST[2]).status.kind, 'needsAuth');
  assert.equal(api.profileWeekly(LIST[2]).kind, 'unknown');
  assert.equal(api.profileWeekly(LIST[3]).reason, 'error');
  assert.equal(api.profileSnapshot(LIST[4]).status.kind, 'stale');
});

test('o símbolo do agente fica solto, sem placa, no computador e no celular', () => {
  const css = source('../src/views/Terminais.css');
  const base = css.match(/\n\.agent-profiles__glyph\{[^}]*\}/)?.[0] || '';
  assert.ok(base, 'regra base do símbolo');
  assert.doesNotMatch(base, /background|border-radius/);
  const phone = css.match(/\[data-form-factor="phone"\] \.agent-profiles__glyph\{[^}]*\}/)?.[0] || '';
  assert.ok(phone, 'regra do símbolo no celular');
  assert.doesNotMatch(phone, /background|border-radius/);
  const desktop = readFileSync(fileURLToPath(new URL('../src/desktop/solid.css', import.meta.url)), 'utf8');
  assert.match(desktop, /\.agent-profiles__glyph\)\{width:auto;height:auto;padding:0;border-radius:0;background:none/);
});
